import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import { atomicWriteJson, withFileLock } from "./concurrency.js";
import { dataPath, relDataPath } from "./context.js";
import { redactMachineLocalValue } from "./data-classification.js";
import {
  getNodeLifecycleState,
  type NodeLifecycleState,
} from "./node-lifecycle.js";
import {
  initializeLifecycleWrite,
  writeNodeLifecycleBatch,
  type LifecycleBatchWrite,
  type NodeLifecycleBatchResult,
} from "./node-lifecycle-store.js";
import {
  buildReviewWorklist,
  type ReviewWorklistCluster,
  type ReviewWorklistReport,
} from "./review-worklist.js";

export const REVIEW_QUEUE_POLICY_VERSION = "review_queue_policy_v1";
export const REVIEW_QUEUE_BACKPRESSURE_VERSION = "review_queue_backpressure_v1";
export const REVIEW_QUEUE_ADMISSION_VERSION = "review_queue_admission_v1";
export const REVIEW_QUEUE_BACKPRESSURE_RELATIVE_PATH = ".dino/state/review_queue_backpressure.json";
export const REVIEW_QUEUE_ADMISSION_RELATIVE_PATH = ".dino/state/review_queue_admission.json";
export const REVIEW_QUEUE_ADMISSION_RECEIPT_ROOT = ".dino/review-admissions";

export type ReviewQueueLane =
  | "correction"
  | "merge_review"
  | "manual_semantic"
  | "evidence_repair"
  | "mapping_repair"
  | "deterministic_hold";

export type ReviewQueueLaneCounts = Record<ReviewQueueLane, number>;

export type ReviewQueuePolicy = {
  version: typeof REVIEW_QUEUE_POLICY_VERSION;
  max_hot_review_units: number;
  lanes: Record<ReviewQueueLane, { hot_budget: number; sla_hours: number; overflow: "cold_hold" }>;
};

export const DEFAULT_REVIEW_QUEUE_POLICY: ReviewQueuePolicy = {
  version: REVIEW_QUEUE_POLICY_VERSION,
  max_hot_review_units: 500,
  lanes: {
    correction: { hot_budget: 40, sla_hours: 24, overflow: "cold_hold" },
    merge_review: { hot_budget: 160, sla_hours: 168, overflow: "cold_hold" },
    manual_semantic: { hot_budget: 300, sla_hours: 336, overflow: "cold_hold" },
    evidence_repair: { hot_budget: 80, sla_hours: 168, overflow: "cold_hold" },
    mapping_repair: { hot_budget: 40, sla_hours: 72, overflow: "cold_hold" },
    deterministic_hold: { hot_budget: 0, sla_hours: 0, overflow: "cold_hold" },
  },
};

type JsonObject = Record<string, unknown>;

export type ReviewQueueBackpressureReport = {
  version: typeof REVIEW_QUEUE_BACKPRESSURE_VERSION;
  status: "healthy" | "needs_settlement" | "over_budget" | "needs_reconciliation";
  generated_at: string;
  data_root: string;
  policy: ReviewQueuePolicy;
  source_worklist_path: string;
  counts: {
    hot_review_units: number;
    cold_candidates: number;
    deterministic_hold_pending: number;
    unclassified_review_debt: number;
    pending_merge_reviews: number;
    duplicate_clusters_pending_merge: number;
    admission_state_consistent: boolean;
  };
  lanes: Record<ReviewQueueLane, {
    hot_units: number;
    hot_budget: number;
    remaining: number;
    over_budget: boolean;
    sla_hours: number;
    overflow: "cold_hold";
  }>;
  growth_mode: "normal" | "cold_only";
  warnings: string[];
  visible_status: string;
};

export type ReviewQueueAdmissionDecision = {
  idempotency_key: string;
  lane: ReviewQueueLane;
  destination: "hot_review" | "cold_hold";
  reason_code: string;
  sequence: number;
  at: string;
};

export type ReviewQueueAdmissionState = {
  version: typeof REVIEW_QUEUE_ADMISSION_VERSION;
  policy_version: typeof REVIEW_QUEUE_POLICY_VERSION;
  reconciled_at: string | null;
  source_backpressure_generated_at: string | null;
  sequence: number;
  hot_lane_counts: ReviewQueueLaneCounts;
  cold_lane_counts: ReviewQueueLaneCounts;
  hot_total: number;
  cold_total: number;
  last_decision_hash: string | null;
  recent_decisions: ReviewQueueAdmissionDecision[];
};

export type ReviewGatedWriteItem = {
  idempotency_key: string;
  lane: ReviewQueueLane;
  candidate_path: string;
  candidate_record: JsonObject;
  review_path: string;
  review_record: JsonObject;
  candidate_evidence_paths?: string[];
  review_evidence_paths?: string[];
  predecessor_paths?: string[];
  candidate_transition_id?: string;
  review_transition_id?: string;
  at?: string;
};

export type ReviewGatedBatchResult = {
  decisions: ReviewQueueAdmissionDecision[];
  lifecycle_transaction: NodeLifecycleBatchResult;
  admission_state_path: string;
  receipt_paths: string[];
};

const lanes: ReviewQueueLane[] = [
  "correction",
  "merge_review",
  "manual_semantic",
  "evidence_repair",
  "mapping_repair",
  "deterministic_hold",
];

function emptyLaneCounts(): ReviewQueueLaneCounts {
  return {
    correction: 0,
    merge_review: 0,
    manual_semantic: 0,
    evidence_repair: 0,
    mapping_repair: 0,
    deterministic_hold: 0,
  };
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function firstString(...values: unknown[]): string {
  for (const value of values) if (typeof value === "string" && value.trim()) return value.trim();
  return "";
}

function stringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String).map((item) => item.trim()).filter(Boolean);
  if (typeof value === "string") return value.split(",").map((item) => item.trim()).filter(Boolean);
  return [];
}

function sumCounts(counts: ReviewQueueLaneCounts): number {
  return lanes.reduce((sum, lane) => sum + counts[lane], 0);
}

function normalizeLaneCounts(value: unknown): ReviewQueueLaneCounts {
  const record = typeof value === "object" && value !== null && !Array.isArray(value) ? (value as JsonObject) : {};
  const counts = emptyLaneCounts();
  for (const lane of lanes) {
    const count = Number(record[lane] ?? 0);
    counts[lane] = Number.isFinite(count) && count >= 0 ? Math.floor(count) : 0;
  }
  return counts;
}

async function readJson<T>(filePath: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function readJsonWithHash<T>(filePath: string): Promise<{ value: T; hash: string } | null> {
  try {
    const bytes = await fs.readFile(filePath);
    return { value: JSON.parse(bytes.toString("utf8")) as T, hash: sha256(bytes) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function readJsonFiles(dataRoot: string, relativeDir: string): Promise<Array<{ path: string; record: JsonObject }>> {
  const dir = dataPath(dataRoot, ...relativeDir.split("/"));
  let entries: Array<import("node:fs").Dirent>;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const records: Array<{ path: string; record: JsonObject }> = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const relativePath = `${relativeDir}/${entry.name}`;
    const record = await readJson<JsonObject>(dataPath(dataRoot, ...relativePath.split("/")));
    if (record) records.push({ path: relativePath, record });
  }
  return records;
}

function laneForCluster(cluster: ReviewWorklistCluster): ReviewQueueLane {
  if (cluster.source === "merge_queue" || cluster.item_count > 1) return "merge_review";
  const decisionClasses = new Set(cluster.members.map((member) => member.decision_class));
  if (cluster.members.some((member) => member.candidate_type === "feedback_correction")) return "correction";
  if (decisionClasses.has("evidence_repair_required")) return "evidence_repair";
  if (decisionClasses.has("candidate_review_missing") || decisionClasses.has("review_candidate_missing")) return "mapping_repair";
  return "manual_semantic";
}

async function countColdCandidates(dataRoot: string): Promise<number> {
  const candidates = await readJsonFiles(dataRoot, "50_Instances/candidates");
  return candidates.filter(({ record }) => {
    const status = firstString(record.status).toLowerCase();
    const temperature = firstString(record.temperature).toLowerCase();
    const lifecycle = firstString(record.lifecycle_state).toLowerCase();
    return status === "held" || temperature === "cold" || lifecycle === "held" || record.quarantine === true;
  }).length;
}

function admissionStateUsable(state: ReviewQueueAdmissionState | null): state is ReviewQueueAdmissionState {
  return Boolean(
    state &&
      state.version === REVIEW_QUEUE_ADMISSION_VERSION &&
      state.policy_version === REVIEW_QUEUE_POLICY_VERSION &&
      typeof state.reconciled_at === "string" &&
      state.reconciled_at.length > 0 &&
      Number.isInteger(state.sequence) &&
      state.sequence >= 0,
  );
}

function reportLaneCounts(worklist: ReviewWorklistReport): ReviewQueueLaneCounts {
  const counts = emptyLaneCounts();
  for (const cluster of worklist.clusters) counts[laneForCluster(cluster)] += 1;
  counts.deterministic_hold = 0;
  return counts;
}

function reportStatus(
  deterministicHoldPending: number,
  unclassified: number,
  overBudget: boolean,
  admissionConsistent: boolean,
): ReviewQueueBackpressureReport["status"] {
  if (unclassified > 0 || deterministicHoldPending > 0) return "needs_settlement";
  if (overBudget) return "over_budget";
  if (!admissionConsistent) return "needs_reconciliation";
  return "healthy";
}

export function getReviewQueueBackpressurePath(dataRoot: string): string {
  return dataPath(dataRoot, ...REVIEW_QUEUE_BACKPRESSURE_RELATIVE_PATH.split("/"));
}

export function getReviewQueueAdmissionPath(dataRoot: string): string {
  return dataPath(dataRoot, ...REVIEW_QUEUE_ADMISSION_RELATIVE_PATH.split("/"));
}

export function getReviewAdmissionLockPath(dataRoot: string): string {
  return dataPath(dataRoot, ".dino", "locks", "review-admission.lock");
}

export async function buildReviewQueueBackpressure(
  dataRoot: string,
  options: { now?: Date; reconcileAdmission?: boolean } = {},
): Promise<{ report: ReviewQueueBackpressureReport; worklist: ReviewWorklistReport; statePath: string }> {
  const now = options.now ?? new Date();
  const generatedAt = now.toISOString();
  const worklistResult = await buildReviewWorklist(dataRoot, { now });
  const laneCounts = reportLaneCounts(worklistResult.report);
  const hotTotal = sumCounts(laneCounts);
  const deterministicHoldPending = worklistResult.report.counts.excluded_deterministic_hold_items;
  const unclassified = Number(worklistResult.report.by_decision_class.unclassified ?? 0);
  const coldCandidates = await countColdCandidates(dataRoot);
  const admissionPath = getReviewQueueAdmissionPath(dataRoot);
  let admission = await readJson<ReviewQueueAdmissionState>(admissionPath);
  if (options.reconcileAdmission === true) {
    admission = await reconcileReviewQueueAdmissionState(dataRoot, {
      laneCounts,
      coldCandidates,
      generatedAt,
      now,
    });
  }
  const admissionConsistent =
    admissionStateUsable(admission) &&
    admission.hot_total === hotTotal &&
    lanes.every((lane) => admission.hot_lane_counts[lane] === laneCounts[lane]);
  const laneReports = Object.fromEntries(
    lanes.map((lane) => {
      const config = DEFAULT_REVIEW_QUEUE_POLICY.lanes[lane];
      const hotUnits = laneCounts[lane];
      return [
        lane,
        {
          hot_units: hotUnits,
          hot_budget: config.hot_budget,
          remaining: Math.max(0, config.hot_budget - hotUnits),
          over_budget: hotUnits > config.hot_budget,
          sla_hours: config.sla_hours,
          overflow: config.overflow,
        },
      ];
    }),
  ) as ReviewQueueBackpressureReport["lanes"];
  const overBudget = hotTotal > DEFAULT_REVIEW_QUEUE_POLICY.max_hot_review_units || lanes.some((lane) => laneReports[lane].over_budget);
  const status = reportStatus(deterministicHoldPending, unclassified, overBudget, admissionConsistent);
  const warnings = [
    deterministicHoldPending > 0 ? "deterministic_review_holds_pending" : null,
    unclassified > 0 ? "unclassified_review_debt_present" : null,
    overBudget ? "review_queue_budget_exceeded" : null,
    !admissionConsistent ? "review_queue_admission_state_needs_reconciliation" : null,
  ].filter((value): value is string => Boolean(value));
  const report: ReviewQueueBackpressureReport = {
    version: REVIEW_QUEUE_BACKPRESSURE_VERSION,
    status,
    generated_at: generatedAt,
    data_root: ".",
    policy: DEFAULT_REVIEW_QUEUE_POLICY,
    source_worklist_path: relDataPath(dataRoot, worklistResult.statePath),
    counts: {
      hot_review_units: hotTotal,
      cold_candidates: coldCandidates,
      deterministic_hold_pending: deterministicHoldPending,
      unclassified_review_debt: unclassified,
      pending_merge_reviews: worklistResult.report.counts.pending_merge_reviews,
      duplicate_clusters_pending_merge: worklistResult.report.counts.duplicate_clusters,
      admission_state_consistent: admissionConsistent,
    },
    lanes: laneReports,
    growth_mode: overBudget || deterministicHoldPending > 0 || !admissionConsistent ? "cold_only" : "normal",
    warnings,
    visible_status:
      status === "healthy"
        ? "Review queue bounded; hot admission enabled"
        : "Review queue constrained; new overflow routes to cold hold",
  };
  const statePath = getReviewQueueBackpressurePath(dataRoot);
  await atomicWriteJson(statePath, report);
  return { report, worklist: worklistResult.report, statePath };
}

async function reconcileReviewQueueAdmissionState(
  dataRoot: string,
  input: { laneCounts: ReviewQueueLaneCounts; coldCandidates: number; generatedAt: string; now: Date },
): Promise<ReviewQueueAdmissionState> {
  return await withFileLock(getReviewAdmissionLockPath(dataRoot), async () => {
    const statePath = getReviewQueueAdmissionPath(dataRoot);
    const existingValue = await readJsonWithHash<ReviewQueueAdmissionState>(statePath);
    const existing = admissionStateUsable(existingValue?.value ?? null) ? existingValue!.value : null;
    const coldLaneCounts = existing ? normalizeLaneCounts(existing.cold_lane_counts) : emptyLaneCounts();
    coldLaneCounts.deterministic_hold = Math.max(coldLaneCounts.deterministic_hold, input.coldCandidates);
    const next: ReviewQueueAdmissionState = {
      version: REVIEW_QUEUE_ADMISSION_VERSION,
      policy_version: REVIEW_QUEUE_POLICY_VERSION,
      reconciled_at: input.generatedAt,
      source_backpressure_generated_at: input.generatedAt,
      sequence: existing?.sequence ?? 0,
      hot_lane_counts: { ...input.laneCounts },
      cold_lane_counts: coldLaneCounts,
      hot_total: sumCounts(input.laneCounts),
      cold_total: Math.max(input.coldCandidates, sumCounts(coldLaneCounts)),
      last_decision_hash: existing?.last_decision_hash ?? null,
      recent_decisions: Array.isArray(existing?.recent_decisions) ? existing!.recent_decisions.slice(-100) : [],
    };
    await writeNodeLifecycleBatch(
      dataRoot,
      [{ target_path: REVIEW_QUEUE_ADMISSION_RELATIVE_PATH, record: next, expected_before_sha256: existingValue?.hash ?? null }],
      { actor: "review-backpressure", reason: "Reconcile review admission counters with the full-vault worklist." },
    );
    return next;
  });
}

function decideAdmission(
  state: ReviewQueueAdmissionState,
  lane: ReviewQueueLane,
  idempotencyKey: string,
  at: string,
  usable: boolean,
): ReviewQueueAdmissionDecision {
  const sequence = state.sequence + 1;
  const config = DEFAULT_REVIEW_QUEUE_POLICY.lanes[lane];
  let destination: ReviewQueueAdmissionDecision["destination"] = "hot_review";
  let reasonCode = "review_queue_budget_available";
  if (!usable) {
    destination = "cold_hold";
    reasonCode = "review_admission_state_missing_or_invalid_fail_closed";
  } else if (lane === "deterministic_hold") {
    destination = "cold_hold";
    reasonCode = "deterministic_generated_memory_requires_hold";
  } else if (state.hot_total >= DEFAULT_REVIEW_QUEUE_POLICY.max_hot_review_units) {
    destination = "cold_hold";
    reasonCode = "review_queue_total_budget_exhausted";
  } else if (state.hot_lane_counts[lane] >= config.hot_budget) {
    destination = "cold_hold";
    reasonCode = `review_queue_${lane}_budget_exhausted`;
  }
  return { idempotency_key: idempotencyKey, lane, destination, reason_code: reasonCode, sequence, at };
}

function applyDecisionToState(state: ReviewQueueAdmissionState, decision: ReviewQueueAdmissionDecision): ReviewQueueAdmissionState {
  const hot = { ...state.hot_lane_counts };
  const cold = { ...state.cold_lane_counts };
  if (decision.destination === "hot_review") hot[decision.lane] += 1;
  else cold[decision.lane] += 1;
  const previousHash = state.last_decision_hash ?? "";
  const decisionHash = sha256(`${previousHash}\n${JSON.stringify(decision)}`);
  return {
    ...state,
    sequence: decision.sequence,
    hot_lane_counts: hot,
    cold_lane_counts: cold,
    hot_total: sumCounts(hot),
    cold_total: sumCounts(cold),
    last_decision_hash: decisionHash,
    recent_decisions: [...state.recent_decisions, decision].slice(-100),
  };
}

function receiptRelativePath(decision: Pick<ReviewQueueAdmissionDecision, "idempotency_key" | "at">): string {
  const month = decision.at.slice(0, 7);
  return `${REVIEW_QUEUE_ADMISSION_RECEIPT_ROOT}/${month}/${sha256(decision.idempotency_key).slice(0, 32)}.json`;
}

function stateForDecision(record: JsonObject, targetPath: string, destination: ReviewQueueAdmissionDecision["destination"]): NodeLifecycleState {
  const current = getNodeLifecycleState(record, targetPath);
  if (destination === "cold_hold") return "held";
  return current === "candidate" || current === "review" ? current : current;
}

function applyAdmissionRecord(
  record: JsonObject,
  decision: ReviewQueueAdmissionDecision,
  kind: "candidate" | "review",
): JsonObject {
  const common = {
    ...record,
    queue_lane: decision.lane,
    queue_destination: decision.destination,
    queue_reason_code: decision.reason_code,
    queue_admitted_at: decision.at,
    queue_admission_sequence: decision.sequence,
    updated_at: decision.at,
  };
  if (decision.destination === "hot_review") return common;
  return {
    ...common,
    status: kind === "candidate" ? "held" : "settled_hold",
    decision: kind === "review" ? "hold" : record.decision,
    temperature: "cold",
    quarantine: true,
    hold_reason: decision.reason_code,
    settled_at: kind === "review" ? decision.at : record.settled_at,
  };
}

function initialFailClosedAdmissionState(): ReviewQueueAdmissionState {
  return {
    version: REVIEW_QUEUE_ADMISSION_VERSION,
    policy_version: REVIEW_QUEUE_POLICY_VERSION,
    reconciled_at: null,
    source_backpressure_generated_at: null,
    sequence: 0,
    hot_lane_counts: emptyLaneCounts(),
    cold_lane_counts: emptyLaneCounts(),
    hot_total: 0,
    cold_total: 0,
    last_decision_hash: null,
    recent_decisions: [],
  };
}

export async function writeReviewGatedBatch(
  dataRoot: string,
  input: {
    items: ReviewGatedWriteItem[];
    extra_writes?: LifecycleBatchWrite[];
    actor: string;
    reason: string;
    fault_after_write_index_for_test?: number;
  },
): Promise<ReviewGatedBatchResult> {
  return await withFileLock(getReviewAdmissionLockPath(dataRoot), async () => {
    const admissionPath = getReviewQueueAdmissionPath(dataRoot);
    const admissionValue = await readJsonWithHash<ReviewQueueAdmissionState>(admissionPath);
    const usable = admissionStateUsable(admissionValue?.value ?? null);
    let state = usable ? admissionValue!.value : initialFailClosedAdmissionState();
    const decisions: ReviewQueueAdmissionDecision[] = [];
    const writes: LifecycleBatchWrite[] = [...(input.extra_writes ?? [])];
    const receiptPaths: string[] = [];
    let stateChanged = false;

    for (const item of input.items) {
      const at = item.at ?? new Date().toISOString();
      const candidateExisting = await readJson<JsonObject>(dataPath(dataRoot, ...item.candidate_path.split("/")));
      const reviewExisting = await readJson<JsonObject>(dataPath(dataRoot, ...item.review_path.split("/")));
      const provisional = decideAdmission(state, item.lane, item.idempotency_key, at, usable);
      const receiptPath = receiptRelativePath(provisional);
      const existingReceipt = await readJson<ReviewQueueAdmissionDecision>(dataPath(dataRoot, ...receiptPath.split("/")));
      const decision = existingReceipt ?? provisional;
      if (!existingReceipt) {
        state = applyDecisionToState(state, decision);
        stateChanged = true;
        writes.push({
          target_path: receiptPath,
          record: {
            version: REVIEW_QUEUE_ADMISSION_VERSION,
            ...decision,
            previous_decision_hash: state.recent_decisions.length > 1
              ? sha256(JSON.stringify(state.recent_decisions[state.recent_decisions.length - 2]))
              : null,
          },
          expected_before_sha256: null,
        });
      }
      decisions.push(decision);
      receiptPaths.push(receiptPath);

      const candidateRecord = applyAdmissionRecord(redactMachineLocalValue(item.candidate_record), decision, "candidate");
      const reviewRecord = applyAdmissionRecord(redactMachineLocalValue(item.review_record), decision, "review");
      const candidateTarget = stateForDecision(candidateExisting ?? candidateRecord, item.candidate_path, decision.destination);
      const reviewTarget = stateForDecision(reviewExisting ?? reviewRecord, item.review_path, decision.destination);
      writes.push(
        initializeLifecycleWrite(item.candidate_path, candidateRecord, {
          to_state: candidateTarget,
          reason_code: decision.reason_code,
          reason: decision.destination === "hot_review" ? "Candidate admitted to bounded review." : "Candidate routed to cold hold by queue policy.",
          actor: input.actor,
          evidence_paths: item.candidate_evidence_paths ?? [],
          predecessor_paths: item.predecessor_paths ?? [],
          at,
          transition_id: item.candidate_transition_id,
          idempotency_key: `queue-candidate|${item.idempotency_key}|${decision.destination}`,
        }).write,
        initializeLifecycleWrite(item.review_path, reviewRecord, {
          to_state: reviewTarget,
          reason_code: decision.reason_code,
          reason: decision.destination === "hot_review" ? "Promotion review admitted to bounded review." : "Promotion review settled into cold hold by queue policy.",
          actor: input.actor,
          evidence_paths: item.review_evidence_paths ?? [item.candidate_path],
          predecessor_paths: [item.candidate_path],
          at,
          transition_id: item.review_transition_id,
          idempotency_key: `queue-review|${item.idempotency_key}|${decision.destination}`,
          sync_status: false,
        }).write,
      );
    }

    if (stateChanged || !usable) {
      writes.push({
        target_path: REVIEW_QUEUE_ADMISSION_RELATIVE_PATH,
        record: state,
        expected_before_sha256: admissionValue?.hash ?? null,
      });
    }
    const sanitizedWrites = writes.map((write) => ({
      ...write,
      record: redactMachineLocalValue(write.record),
    }));
    const lifecycleTransaction = await writeNodeLifecycleBatch(dataRoot, sanitizedWrites, {
      actor: input.actor,
      reason: input.reason,
      fault_after_write_index_for_test: input.fault_after_write_index_for_test,
    });
    return {
      decisions,
      lifecycle_transaction: lifecycleTransaction,
      admission_state_path: REVIEW_QUEUE_ADMISSION_RELATIVE_PATH,
      receipt_paths: receiptPaths,
    };
  });
}

export function simulateReviewQueueAdmissions(
  initialHotCounts: Partial<ReviewQueueLaneCounts>,
  requestedLanes: ReviewQueueLane[],
): {
  final_hot_counts: ReviewQueueLaneCounts;
  hot_total: number;
  hot_admitted: number;
  cold_held: number;
  decisions: ReviewQueueAdmissionDecision[];
} {
  let state: ReviewQueueAdmissionState = {
    ...initialFailClosedAdmissionState(),
    reconciled_at: new Date(0).toISOString(),
    source_backpressure_generated_at: new Date(0).toISOString(),
    hot_lane_counts: { ...emptyLaneCounts(), ...initialHotCounts },
    hot_total: sumCounts({ ...emptyLaneCounts(), ...initialHotCounts }),
  };
  const decisions: ReviewQueueAdmissionDecision[] = [];
  requestedLanes.forEach((lane, index) => {
    const decision = decideAdmission(state, lane, `simulation-${index}`, new Date(index * 1000).toISOString(), true);
    decisions.push(decision);
    state = applyDecisionToState(state, decision);
  });
  return {
    final_hot_counts: state.hot_lane_counts,
    hot_total: state.hot_total,
    hot_admitted: decisions.filter((decision) => decision.destination === "hot_review").length,
    cold_held: decisions.filter((decision) => decision.destination === "cold_hold").length,
    decisions,
  };
}
