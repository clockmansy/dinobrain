import { promises as fs } from "node:fs";
import path from "node:path";

import { atomicWriteJson } from "./concurrency.js";
import { dataPath, relDataPath } from "./context.js";
import {
  currentNodeRecord,
  transitionLifecycleWrite,
  writeNodeLifecycleBatch,
  type LifecycleBatchWrite,
} from "./node-lifecycle-store.js";

export const REVIEW_SETTLEMENT_VERSION = "review_settlement_v1";
export const REVIEW_QUEUE_STATUS_RELATIVE_PATH = ".dino/state/wiki-review-queue.json";
export const SEMANTIC_JOBS_RELATIVE_PATH = ".dino/state/semantic_jobs.json";
export const REVIEW_SETTLEMENT_ACTIONS_RELATIVE_PATH = ".dino/state/review_queue_settlement_actions.json";

type JsonObject = Record<string, unknown>;

export type ReviewDecisionClass =
  | "closed"
  | "manual_semantic_review_required"
  | "auto_compounded_behavior_hold"
  | "legacy_unreviewed_hold"
  | "evidence_repair_required"
  | "candidate_review_missing"
  | "review_candidate_missing"
  | "unclassified";

export type ReviewSettlementItem = {
  id: string;
  status: "open" | "closed";
  decision_class: ReviewDecisionClass;
  reason_code: string;
  candidate_path: string | null;
  review_path: string | null;
  evidence_paths: string[];
  owner: string;
  next_action: string;
  recheck_at: string | null;
  candidate_status: string | null;
  review_status: string | null;
  promotion_blockers: string[];
};

export type ReviewQueueSettlementReport = {
  version: typeof REVIEW_SETTLEMENT_VERSION;
  status: "ready" | "classified_backlog" | "needs_classification";
  generated_at: string;
  data_root: string;
  counts: {
    candidates: number;
    promotion_reviews: number;
    accepted: number;
    open: number;
    closed: number;
    residual_classified: number;
    unclassified_open: number;
    candidate_without_review: number;
    review_without_candidate: number;
  };
  by_decision_class: Record<ReviewDecisionClass, number>;
  items: ReviewSettlementItem[];
  warnings: string[];
  visible_status: string;
};

export type SemanticJobStatus = "open" | "settled" | "classified_hold";
export type SemanticJobExecutionClass = "manual_review" | "session_assisted" | "not_required";

export type SemanticJob = {
  job_id: string;
  source_review_path: string | null;
  source_candidate_path: string | null;
  status: SemanticJobStatus;
  execution_class: SemanticJobExecutionClass;
  decision_class: ReviewDecisionClass;
  reason_code: string;
  attempts: number;
  max_attempts: number;
  next_attempt_at: string | null;
  stale_after_ms: number;
  blocked_reason: string | null;
  owner: string;
  evidence_paths: string[];
  next_action: string;
};

export type SemanticJobSettlementReport = {
  version: typeof REVIEW_SETTLEMENT_VERSION;
  status: "ready" | "classified_backlog" | "needs_classification";
  generated_at: string;
  data_root: string;
  counts: {
    jobs: number;
    open: number;
    settled: number;
    classified_hold: number;
    unclassified_open: number;
    manual_review: number;
    session_assisted: number;
  };
  jobs: SemanticJob[];
  warnings: string[];
  visible_status: string;
};

export type ReviewSettlementAction = {
  id: string;
  action: "hold_candidate_and_review";
  decision_class: "auto_compounded_behavior_hold" | "legacy_unreviewed_hold";
  reason_code: string;
  candidate_path: string;
  review_path: string;
  previous_accepted_path: string | null;
  applied: boolean;
  applied_paths: string[];
  skipped_reason: string | null;
};

export type ReviewSettlementActionReport = {
  version: typeof REVIEW_SETTLEMENT_VERSION;
  status: "healthy" | "needs_attention";
  apply: boolean;
  generated_at: string;
  data_root: string;
  counts: {
    auto_hold_candidates_before: number;
    auto_hold_applied: number;
    auto_hold_candidates_after: number | null;
    manual_review_required_before: number;
    manual_review_required_after: number | null;
    open_before: number;
    open_after: number | null;
    closed_before: number;
    closed_after: number | null;
  };
  actions: ReviewSettlementAction[];
  transaction_id: string | null;
  transaction_path: string | null;
  warnings: string[];
  visible_status: string;
};

type BuildOptions = {
  now?: Date;
  staleAfterMs?: number;
};

function nowIso(date: Date): string {
  return date.toISOString();
}

function safeId(value: string): string {
  return (
    value
      .trim()
      .replace(/[^A-Za-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 96) || "review-item"
  );
}

function firstString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function stringArray(value: unknown): string[] {
  if (!value) return [];
  if (Array.isArray(value)) return value.flatMap(stringArray);
  if (typeof value === "string") return value.split(",").map((item) => item.trim()).filter(Boolean);
  return [String(value)].filter(Boolean);
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean))).sort((a, b) => a.localeCompare(b));
}

async function readJson<T>(filePath: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function readJsonDir(dataRoot: string, relativeDir: string): Promise<Array<{ path: string; record: JsonObject }>> {
  const dir = dataPath(dataRoot, relativeDir);
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
    const fullPath = path.join(dir, entry.name);
    const record = await readJson<JsonObject>(fullPath);
    if (record) records.push({ path: relDataPath(dataRoot, fullPath), record });
  }
  return records.sort((a, b) => a.path.localeCompare(b.path));
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await atomicWriteJson(filePath, value);
}

function pathId(vaultPath: string): string {
  return path.basename(vaultPath.replace(/\\/g, "/"), ".json");
}

function isClosedStatus(status: string): boolean {
  return ["approved", "accepted", "promoted", "rejected", "closed", "settled", "settled_hold", "held", "done", "archived"].includes(
    status.toLowerCase(),
  );
}

function isAutoHoldDecisionClass(
  decisionClass: ReviewDecisionClass,
): decisionClass is "auto_compounded_behavior_hold" | "legacy_unreviewed_hold" {
  return decisionClass === "auto_compounded_behavior_hold" || decisionClass === "legacy_unreviewed_hold";
}

function recordEvidencePaths(candidate: JsonObject | null, review: JsonObject | null): string[] {
  const evidence = candidate?.evidence && typeof candidate.evidence === "object" ? (candidate.evidence as JsonObject) : {};
  const source = candidate?.source && typeof candidate.source === "object" ? (candidate.source as JsonObject) : {};
  return unique([
    firstString(review?.candidate_path),
    firstString(review?.previous_accepted_path),
    firstString(review?.accepted_path),
    firstString(candidate?.source_candidate_path),
    firstString(candidate?.legacy_accepted_path),
    firstString(candidate?.source_path),
    firstString(candidate?.evidence_source),
    ...stringArray(candidate?.source_paths),
    firstString(evidence.source),
    firstString(source.trace_path),
    firstString(source.task_path),
    firstString(candidate?.source_operation_path),
  ]);
}

function hasEvidence(candidate: JsonObject | null): boolean {
  if (!candidate) return false;
  const evidence = candidate.evidence && typeof candidate.evidence === "object" ? (candidate.evidence as JsonObject) : {};
  const snippet = firstString(evidence.snippet);
  const source = firstString(evidence.source, candidate.source_path, candidate.evidence_source);
  return Boolean(snippet && source);
}

function isBehaviorRule(candidate: JsonObject | null): boolean {
  if (!candidate) return false;
  const tags = stringArray(candidate.tags);
  return candidate.type === "behavior_rule" || typeof candidate.behavior_rule === "string" || tags.includes("behavior-rule");
}

function classifyItem(params: {
  id: string;
  candidatePath: string | null;
  candidate: JsonObject | null;
  reviewPath: string | null;
  review: JsonObject | null;
}): Omit<ReviewSettlementItem, "id" | "candidate_path" | "review_path" | "candidate_status" | "review_status" | "promotion_blockers" | "evidence_paths"> {
  const reviewStatus = firstString(params.review?.status);
  const candidateStatus = firstString(params.candidate?.status);
  const blockers = unique([...stringArray(params.review?.promotion_blockers), ...stringArray(params.candidate?.promotion_blockers)]);

  if (!params.review) {
    return {
      status: "open",
      decision_class: "candidate_review_missing",
      reason_code: "candidate_has_no_review_record",
      owner: "review-settlement",
      next_action: "Create a promotion review record before this candidate can be considered for accepted memory.",
      recheck_at: null,
    };
  }
  if (!params.candidate) {
    return {
      status: "open",
      decision_class: "review_candidate_missing",
      reason_code: "review_points_to_missing_candidate",
      owner: "review-settlement",
      next_action: "Repair the review record or archive it with a missing-candidate reason.",
      recheck_at: null,
    };
  }
  if (isClosedStatus(reviewStatus) || isClosedStatus(candidateStatus)) {
    return {
      status: "closed",
      decision_class: "closed",
      reason_code: "review_or_candidate_is_terminal",
      owner: "review-settlement",
      next_action: "No action required unless the terminal decision is later disputed.",
      recheck_at: null,
    };
  }
  if (blockers.includes("legacy_unreviewed_accepted")) {
    return {
      status: "open",
      decision_class: "legacy_unreviewed_hold",
      reason_code: "legacy_accepted_memory_needs_review_lineage",
      owner: "memory-reviewer",
      next_action: "Confirm source lineage and either approve into accepted memory or keep held as historical task memory.",
      recheck_at: null,
    };
  }
  if (!hasEvidence(params.candidate) || !firstString(params.candidate.confidence) || !firstString(params.candidate.last_verified)) {
    return {
      status: "open",
      decision_class: "evidence_repair_required",
      reason_code: "candidate_missing_required_evidence_fields",
      owner: "memory-reviewer",
      next_action: "Add source, snippet, confidence, and last_verified before semantic review.",
      recheck_at: null,
    };
  }
  if (blockers.includes("auto_compounded_behavior_rule") || isBehaviorRule(params.candidate)) {
    return {
      status: "open",
      decision_class: "auto_compounded_behavior_hold",
      reason_code: "auto_compounded_behavior_rule_requires_semantic_review",
      owner: "memory-reviewer",
      next_action: "Check whether the behavior rule is durable, non-duplicative, scoped, and grounded before promotion.",
      recheck_at: null,
    };
  }
  if (blockers.includes("manual_review_required") || reviewStatus.toLowerCase() === "pending") {
    return {
      status: "open",
      decision_class: "manual_semantic_review_required",
      reason_code: "candidate_ready_for_human_semantic_review",
      owner: "memory-reviewer",
      next_action: "Review claim scope and evidence, then approve, reject, merge, or hold.",
      recheck_at: null,
    };
  }
  return {
    status: "open",
    decision_class: "unclassified",
    reason_code: "no_settlement_rule_matched",
    owner: "review-settlement",
    next_action: "Add a deterministic settlement rule for this review shape.",
    recheck_at: null,
  };
}

function countClasses(items: ReviewSettlementItem[]): Record<ReviewDecisionClass, number> {
  const classes: ReviewDecisionClass[] = [
    "closed",
    "manual_semantic_review_required",
    "auto_compounded_behavior_hold",
    "legacy_unreviewed_hold",
    "evidence_repair_required",
    "candidate_review_missing",
    "review_candidate_missing",
    "unclassified",
  ];
  return Object.fromEntries(classes.map((decisionClass) => [decisionClass, items.filter((item) => item.decision_class === decisionClass).length])) as Record<
    ReviewDecisionClass,
    number
  >;
}

function reviewVisibleStatus(status: ReviewQueueSettlementReport["status"]): string {
  if (status === "ready") return "리뷰 큐 정리 완료";
  if (status === "classified_backlog") return "리뷰 큐 잔여 항목 분류 완료";
  return "리뷰 큐 미분류 항목 있음";
}

function semanticVisibleStatus(status: SemanticJobSettlementReport["status"]): string {
  if (status === "ready") return "시맨틱 작업 정리 완료";
  if (status === "classified_backlog") return "시맨틱 작업 잔여 항목 분류 완료";
  return "시맨틱 작업 미분류 항목 있음";
}

export function getReviewQueueStatusPath(dataRoot: string): string {
  return dataPath(dataRoot, ...REVIEW_QUEUE_STATUS_RELATIVE_PATH.split("/"));
}

export function getSemanticJobsPath(dataRoot: string): string {
  return dataPath(dataRoot, ...SEMANTIC_JOBS_RELATIVE_PATH.split("/"));
}

export function getReviewSettlementActionsPath(dataRoot: string): string {
  return dataPath(dataRoot, ...REVIEW_SETTLEMENT_ACTIONS_RELATIVE_PATH.split("/"));
}

export async function buildReviewQueueSettlement(
  dataRoot: string,
  options: BuildOptions = {},
): Promise<ReviewQueueSettlementReport> {
  const generatedAt = nowIso(options.now ?? new Date());
  const [accepted, candidates, reviews] = await Promise.all([
    readJsonDir(dataRoot, "50_Instances/accepted"),
    readJsonDir(dataRoot, "50_Instances/candidates"),
    readJsonDir(dataRoot, "80_Review_Queue/promotion"),
  ]);
  const candidatesById = new Map(candidates.map((entry) => [pathId(entry.path), entry]));
  const reviewsById = new Map(reviews.map((entry) => [pathId(entry.path), entry]));
  const ids = unique([...candidatesById.keys(), ...reviewsById.keys()]);
  const items = ids.map((id) => {
    const candidate = candidatesById.get(id) ?? null;
    const review = reviewsById.get(id) ?? null;
    const candidatePath = candidate?.path ?? (typeof review?.record.candidate_path === "string" ? review.record.candidate_path : null);
    const reviewPath = review?.path ?? null;
    const candidateRecord = candidate?.record ?? null;
    const reviewRecord = review?.record ?? null;
    const settlement = classifyItem({ id, candidatePath, candidate: candidateRecord, reviewPath, review: reviewRecord });
    return {
      id,
      ...settlement,
      candidate_path: candidatePath,
      review_path: reviewPath,
      evidence_paths: recordEvidencePaths(candidateRecord, reviewRecord),
      candidate_status: candidateRecord ? firstString(candidateRecord.status, "unknown") : null,
      review_status: reviewRecord ? firstString(reviewRecord.status, "unknown") : null,
      promotion_blockers: unique([...stringArray(reviewRecord?.promotion_blockers), ...stringArray(candidateRecord?.promotion_blockers)]),
    };
  });
  const open = items.filter((item) => item.status === "open");
  const unclassifiedOpen = open.filter((item) => item.decision_class === "unclassified");
  const status = unclassifiedOpen.length > 0 ? "needs_classification" : open.length > 0 ? "classified_backlog" : "ready";
  return {
    version: REVIEW_SETTLEMENT_VERSION,
    status,
    generated_at: generatedAt,
    data_root: path.resolve(dataRoot),
    counts: {
      candidates: candidates.length,
      promotion_reviews: reviews.length,
      accepted: accepted.length,
      open: open.length,
      closed: items.length - open.length,
      residual_classified: open.length - unclassifiedOpen.length,
      unclassified_open: unclassifiedOpen.length,
      candidate_without_review: items.filter((item) => item.decision_class === "candidate_review_missing").length,
      review_without_candidate: items.filter((item) => item.decision_class === "review_candidate_missing").length,
    },
    by_decision_class: countClasses(items),
    items,
    warnings: unclassifiedOpen.length > 0 ? ["unclassified_review_items_present"] : [],
    visible_status: reviewVisibleStatus(status),
  };
}

function semanticJobFor(item: ReviewSettlementItem, staleAfterMs: number): SemanticJob | null {
  if (item.status === "closed") {
    return {
      job_id: `semantic-job-${safeId(item.id)}`,
      source_review_path: item.review_path,
      source_candidate_path: item.candidate_path,
      status: "settled",
      execution_class: "not_required",
      decision_class: item.decision_class,
      reason_code: item.reason_code,
      attempts: 0,
      max_attempts: 0,
      next_attempt_at: null,
      stale_after_ms: staleAfterMs,
      blocked_reason: null,
      owner: item.owner,
      evidence_paths: item.evidence_paths,
      next_action: item.next_action,
    };
  }
  const needsSemantic = [
    "manual_semantic_review_required",
    "auto_compounded_behavior_hold",
    "legacy_unreviewed_hold",
  ].includes(item.decision_class);
  if (!needsSemantic && item.decision_class !== "unclassified") return null;
  return {
    job_id: `semantic-job-${safeId(item.id)}`,
    source_review_path: item.review_path,
    source_candidate_path: item.candidate_path,
    status: item.decision_class === "unclassified" ? "open" : "classified_hold",
    execution_class: item.decision_class === "unclassified" ? "session_assisted" : "manual_review",
    decision_class: item.decision_class,
    reason_code: item.reason_code,
    attempts: 0,
    max_attempts: item.decision_class === "unclassified" ? 1 : 0,
    next_attempt_at: null,
    stale_after_ms: staleAfterMs,
    blocked_reason: item.decision_class === "unclassified" ? "missing_settlement_rule" : "manual_semantic_judgment_required",
    owner: item.owner,
    evidence_paths: item.evidence_paths,
    next_action: item.next_action,
  };
}

export async function buildSemanticJobSettlement(
  dataRoot: string,
  reviewReport?: ReviewQueueSettlementReport,
  options: BuildOptions = {},
): Promise<SemanticJobSettlementReport> {
  const generatedAt = nowIso(options.now ?? new Date());
  const staleAfterMs = options.staleAfterMs ?? 7 * 24 * 60 * 60 * 1000;
  const reviews = reviewReport ?? (await buildReviewQueueSettlement(dataRoot, options));
  const jobs = reviews.items
    .map((item) => semanticJobFor(item, staleAfterMs))
    .filter((job): job is SemanticJob => Boolean(job))
    .sort((a, b) => a.job_id.localeCompare(b.job_id));
  const open = jobs.filter((job) => job.status === "open");
  const unclassifiedOpen = open.filter((job) => job.decision_class === "unclassified");
  const classifiedHold = jobs.filter((job) => job.status === "classified_hold");
  const status = unclassifiedOpen.length > 0 ? "needs_classification" : classifiedHold.length > 0 ? "classified_backlog" : "ready";
  return {
    version: REVIEW_SETTLEMENT_VERSION,
    status,
    generated_at: generatedAt,
    data_root: path.resolve(dataRoot),
    counts: {
      jobs: jobs.length,
      open: open.length,
      settled: jobs.filter((job) => job.status === "settled").length,
      classified_hold: classifiedHold.length,
      unclassified_open: unclassifiedOpen.length,
      manual_review: jobs.filter((job) => job.execution_class === "manual_review").length,
      session_assisted: jobs.filter((job) => job.execution_class === "session_assisted").length,
    },
    jobs,
    warnings: unclassifiedOpen.length > 0 ? ["unclassified_semantic_jobs_present"] : [],
    visible_status: semanticVisibleStatus(status),
  };
}

async function readVaultJson(dataRoot: string, relativePath: string | null): Promise<JsonObject | null> {
  if (!relativePath) return null;
  return readJson<JsonObject>(dataPath(dataRoot, relativePath));
}

async function writeVaultJson(dataRoot: string, relativePath: string, record: JsonObject): Promise<void> {
  await writeJson(dataPath(dataRoot, relativePath), record);
}

function previousAcceptedPath(candidate: JsonObject | null, review: JsonObject | null): string | null {
  return firstString(review?.previous_accepted_path, review?.accepted_path, candidate?.legacy_accepted_path) || null;
}

function holdNote(decisionClass: ReviewSettlementAction["decision_class"]): string {
  if (decisionClass === "legacy_unreviewed_hold") {
    return "Auto-held legacy unreviewed generated memory so it stays out of hot retrieval until lineage is manually confirmed.";
  }
  return "Auto-held generated behavior memory instead of promoting it; manual semantic review is required before acceptance.";
}

function actionFor(item: ReviewSettlementItem): ReviewSettlementAction | null {
  if (!isAutoHoldDecisionClass(item.decision_class) || !item.candidate_path || !item.review_path) return null;
  return {
    id: item.id,
    action: "hold_candidate_and_review",
    decision_class: item.decision_class,
    reason_code: item.reason_code,
    candidate_path: item.candidate_path,
    review_path: item.review_path,
    previous_accepted_path: null,
    applied: false,
    applied_paths: [],
    skipped_reason: null,
  };
}

async function planHoldAction(
  dataRoot: string,
  action: ReviewSettlementAction,
  reviewer: string,
  appliedAt: string,
): Promise<{ action: ReviewSettlementAction; writes: LifecycleBatchWrite[] }> {
  const candidate = await readVaultJson(dataRoot, action.candidate_path);
  const review = await readVaultJson(dataRoot, action.review_path);
  if (!candidate || !review) {
    return {
      action: { ...action, skipped_reason: !candidate ? "candidate_missing" : "review_missing" },
      writes: [],
    };
  }

  const previousAccepted = previousAcceptedPath(candidate, review);
  const note = holdNote(action.decision_class);
  const candidateState = await currentNodeRecord(dataRoot, action.candidate_path);
  const reviewState = await currentNodeRecord(dataRoot, action.review_path);
  const candidateStage = transitionLifecycleWrite(action.candidate_path, {
    ...candidate,
    status: "held",
    quarantine: true,
    hold_reason: action.reason_code,
    review_notes: note,
    reviewed_by: reviewer,
    reviewed_at: appliedAt,
    updated_at: appliedAt,
  }, {
    to_state: "held",
    reason_code: action.reason_code,
    reason: note,
    actor: reviewer,
    evidence_paths: [action.review_path],
    successor_paths: [action.review_path],
    at: appliedAt,
    idempotency_key: `review-settlement-candidate|${action.id}`,
  });
  candidateStage.write.expected_before_sha256 = candidateState.sha256;
  const reviewStage = transitionLifecycleWrite(action.review_path, {
    ...review,
    status: "settled_hold",
    decision: "hold",
    reviewer,
    notes: note,
    settled_at: appliedAt,
    reviewed_at: appliedAt,
    updated_at: appliedAt,
  }, {
    to_state: "held",
    reason_code: action.reason_code,
    reason: note,
    actor: reviewer,
    evidence_paths: [action.candidate_path],
    predecessor_paths: [action.candidate_path],
    at: appliedAt,
    idempotency_key: `review-settlement-review|${action.id}`,
    sync_status: false,
  });
  reviewStage.write.expected_before_sha256 = reviewState.sha256;
  const writes: LifecycleBatchWrite[] = [candidateStage.write, reviewStage.write];
  const appliedPaths = [action.candidate_path, action.review_path];

  const accepted = await readVaultJson(dataRoot, previousAccepted);
  if (previousAccepted && accepted) {
    const acceptedState = await currentNodeRecord(dataRoot, previousAccepted);
    const acceptedStage = transitionLifecycleWrite(previousAccepted, {
      ...accepted,
      status: "held",
      quarantine: true,
      hold_reason: "legacy_unreviewed_accepted_requires_lineage_review",
      held_by: reviewer,
      held_at: appliedAt,
      updated_at: appliedAt,
    }, {
      to_state: "held",
      reason_code: "legacy_unreviewed_accepted_requires_lineage_review",
      reason: "Legacy accepted memory was held until lineage review.",
      actor: reviewer,
      evidence_paths: [action.candidate_path, action.review_path],
      predecessor_paths: [action.candidate_path, action.review_path],
      at: appliedAt,
      idempotency_key: `review-settlement-accepted|${action.id}`,
    });
    acceptedStage.write.expected_before_sha256 = acceptedState.sha256;
    writes.push(acceptedStage.write);
    appliedPaths.push(previousAccepted);
  }

  return {
    action: {
      ...action,
      previous_accepted_path: previousAccepted,
      applied: true,
      applied_paths: appliedPaths,
      skipped_reason: null,
    },
    writes,
  };
}

function countManualReviewRequired(review: ReviewQueueSettlementReport): number {
  return (
    review.by_decision_class.manual_semantic_review_required +
    review.by_decision_class.evidence_repair_required +
    review.by_decision_class.candidate_review_missing +
    review.by_decision_class.review_candidate_missing
  );
}

function actionVisibleStatus(status: ReviewSettlementActionReport["status"], apply: boolean): string {
  if (status === "healthy") return "리뷰 큐 자동 보류 정리 완료";
  return apply ? "리뷰 큐 자동 보류 정리 확인 필요" : "리뷰 큐 자동 보류 정리 적용 필요";
}

export async function settleReviewQueueActions(
  dataRoot: string,
  options: BuildOptions & { apply?: boolean; reviewer?: string } = {},
): Promise<{
  review: ReviewQueueSettlementReport;
  semantic: SemanticJobSettlementReport;
  actions: ReviewSettlementActionReport;
  reviewPath: string;
  semanticPath: string;
  actionsPath: string;
}> {
  const apply = options.apply === true;
  const reviewer = options.reviewer ?? "review-settlement:auto-hold";
  const generatedAt = nowIso(options.now ?? new Date());
  const reviewBefore = await buildReviewQueueSettlement(dataRoot, options);
  const targetActions = reviewBefore.items
    .map((item) => actionFor(item))
    .filter((action): action is ReviewSettlementAction => Boolean(action));
  const appliedActions: ReviewSettlementAction[] = [];
  const writes: LifecycleBatchWrite[] = [];
  let transactionId: string | null = null;
  let transactionPath: string | null = null;

  for (const action of targetActions) {
    if (!apply) {
      appliedActions.push(action);
      continue;
    }
    const planned = await planHoldAction(dataRoot, action, reviewer, generatedAt);
    appliedActions.push(planned.action);
    writes.push(...planned.writes);
  }
  const preconditionFailed = appliedActions.some((action) => action.skipped_reason !== null);
  if (preconditionFailed) {
    writes.splice(0, writes.length);
    for (let index = 0; index < appliedActions.length; index += 1) {
      if (!appliedActions[index].applied) continue;
      appliedActions[index] = {
        ...appliedActions[index],
        applied: false,
        applied_paths: [],
        skipped_reason: "batch_aborted_due_to_precondition_failure",
      };
    }
  }
  if (apply && writes.length > 0 && appliedActions.every((action) => action.skipped_reason === null)) {
    const transaction = await writeNodeLifecycleBatch(dataRoot, writes, {
      actor: reviewer,
      reason: `Settle ${targetActions.length} deterministic review holds atomically.`,
    });
    transactionId = transaction.transaction_id;
    transactionPath = transaction.transaction_path;
  }

  const review = apply ? await buildReviewQueueSettlement(dataRoot, options) : reviewBefore;
  const semantic = await buildSemanticJobSettlement(dataRoot, review, options);
  const autoHoldAfter = review.items.filter((item) => isAutoHoldDecisionClass(item.decision_class) && item.status === "open").length;
  const status = review.counts.unclassified_open === 0 && autoHoldAfter === 0 ? "healthy" : "needs_attention";
  const actionsReport: ReviewSettlementActionReport = {
    version: REVIEW_SETTLEMENT_VERSION,
    status,
    apply,
    generated_at: generatedAt,
    data_root: path.resolve(dataRoot),
    counts: {
      auto_hold_candidates_before: targetActions.length,
      auto_hold_applied: appliedActions.filter((action) => action.applied).length,
      auto_hold_candidates_after: apply ? autoHoldAfter : null,
      manual_review_required_before: countManualReviewRequired(reviewBefore),
      manual_review_required_after: apply ? countManualReviewRequired(review) : null,
      open_before: reviewBefore.counts.open,
      open_after: apply ? review.counts.open : null,
      closed_before: reviewBefore.counts.closed,
      closed_after: apply ? review.counts.closed : null,
    },
    actions: appliedActions,
    transaction_id: transactionId,
    transaction_path: transactionPath,
    warnings: status === "healthy" ? [] : ["review_queue_auto_hold_candidates_remain"],
    visible_status: actionVisibleStatus(status, apply),
  };
  const reviewPath = getReviewQueueStatusPath(dataRoot);
  const semanticPath = getSemanticJobsPath(dataRoot);
  const actionsPath = getReviewSettlementActionsPath(dataRoot);
  await writeJson(reviewPath, review);
  await writeJson(semanticPath, semantic);
  await writeJson(actionsPath, actionsReport);
  return { review, semantic, actions: actionsReport, reviewPath, semanticPath, actionsPath };
}

export async function buildAndWriteReviewSettlements(
  dataRoot: string,
  options: BuildOptions = {},
): Promise<{
  review: ReviewQueueSettlementReport;
  semantic: SemanticJobSettlementReport;
  reviewPath: string;
  semanticPath: string;
}> {
  const review = await buildReviewQueueSettlement(dataRoot, options);
  const semantic = await buildSemanticJobSettlement(dataRoot, review, options);
  const reviewPath = getReviewQueueStatusPath(dataRoot);
  const semanticPath = getSemanticJobsPath(dataRoot);
  await writeJson(reviewPath, review);
  await writeJson(semanticPath, semantic);
  return { review, semantic, reviewPath, semanticPath };
}
