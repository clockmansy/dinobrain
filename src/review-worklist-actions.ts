import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

import { atomicWriteJson } from "./concurrency.js";
import { dataPath, relDataPath } from "./context.js";
import {
  initializeLifecycleWrite,
  rollbackNodeLifecycleTransaction,
  transitionLifecycleWrite,
  writeNodeLifecycleBatch,
  type LifecycleBatchWrite,
} from "./node-lifecycle-store.js";
import { buildReviewQueueBackpressure } from "./review-backpressure.js";
import { buildReviewQueueSettlement, type ReviewSettlementItem } from "./review-settlement.js";
import {
  buildReviewWorklist,
  type ReviewWorklistCluster,
  type ReviewWorklistMember,
  type ReviewWorklistReport,
} from "./review-worklist.js";

export const REVIEW_WORKLIST_ACTIONS_VERSION = "review_worklist_actions_v2";
export const REVIEW_WORKLIST_ACTIONS_STATE_RELATIVE_PATH = ".dino/state/review_worklist_actions.json";
export const REVIEW_WORKLIST_ACTIONS_OPERATIONS_DIR = "60_Operations/review-worklist-actions";
export const REVIEW_WORKLIST_MERGE_QUEUE_DIR = "80_Review_Queue/merge";

type JsonObject = Record<string, unknown>;

export type ReviewWorklistActionKind = "deterministic_hold" | "create_merge_review" | "manual_review_only";
export type ReviewWorklistActionApplyStatus = "planned" | "applied" | "skipped" | "not_applicable";

export type ReviewWorklistAction = {
  action_id: string;
  cluster_id: string;
  kind: ReviewWorklistActionKind;
  apply_status: ReviewWorklistActionApplyStatus;
  reason_code: string;
  cluster_kind: string;
  identity_kind: string;
  item_count: number;
  representative_claim: string;
  candidate_paths: string[];
  review_paths: string[];
  provenance_member_count: number;
  applied_paths: string[];
  skipped_reason: string | null;
};

export type ReviewWorklistActionReport = {
  version: typeof REVIEW_WORKLIST_ACTIONS_VERSION;
  status: "ready" | "needs_apply" | "empty" | "rolled_back";
  generated_at: string;
  apply: {
    deterministic_holds: boolean;
    merge_reviews: boolean;
  };
  data_root: string;
  source_worklist_status: ReviewWorklistReport["status"];
  before_counts: ReviewWorklistReport["counts"];
  after_counts: ReviewWorklistReport["counts"] | null;
  counts: {
    clusters: number;
    actions: number;
    deterministic_hold_actions: number;
    merge_review_actions: number;
    manual_only_actions: number;
    applied: number;
    skipped: number;
    changed_paths: number;
  };
  transaction_id: string | null;
  transaction_path: string | null;
  recovery_ref: string | null;
  last_applied_transaction_id: string | null;
  last_applied_transaction_path: string | null;
  last_recovery_ref: string | null;
  last_applied_at: string | null;
  last_rollback_transaction_id: string | null;
  rollback_transaction_id: string | null;
  actions: ReviewWorklistAction[];
  warnings: string[];
  visible_status: string;
};

type BuildOptions = {
  now?: Date;
  applyHolds?: boolean;
  applyMergeReviews?: boolean;
  reviewer?: string;
  operationActionLimit?: number;
  rollbackTransactionId?: string;
  requireGitRecoveryRef?: boolean;
  faultAfterWriteIndexForTest?: number;
};

const execFileAsync = promisify(execFile);

function nowIso(date: Date): string {
  return date.toISOString();
}

function dateStamp(date: Date): string {
  return date.toISOString().slice(0, 10).replace(/-/g, "");
}

function safeSlug(value: string): string {
  return (
    value
      .trim()
      .replace(/[^A-Za-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 96) || "review-worklist-action"
  );
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

async function readJson<T>(filePath: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function readJsonWithHash(filePath: string): Promise<{ record: JsonObject; sha256: string } | null> {
  try {
    const bytes = await fs.readFile(filePath);
    return { record: JSON.parse(bytes.toString("utf8")) as JsonObject, sha256: sha256(bytes) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await atomicWriteJson(filePath, value);
}

type LastApplyEvidence = {
  transaction_id: string;
  transaction_path: string | null;
  recovery_ref: string | null;
  applied_at: string;
};

function applyEvidenceFromReport(report: Partial<ReviewWorklistActionReport> | null): LastApplyEvidence | null {
  if (!report) return null;
  const transactionId = report.last_applied_transaction_id ?? report.transaction_id;
  const appliedAt = report.last_applied_at ?? report.generated_at;
  if (typeof transactionId !== "string" || !transactionId || typeof appliedAt !== "string" || !appliedAt) return null;
  return {
    transaction_id: transactionId,
    transaction_path: report.last_applied_transaction_path ?? report.transaction_path ?? null,
    recovery_ref: report.last_recovery_ref ?? report.recovery_ref ?? null,
    applied_at: appliedAt,
  };
}

async function findLastApplyEvidence(dataRoot: string, statePath: string): Promise<LastApplyEvidence | null> {
  const candidates: LastApplyEvidence[] = [];
  const stateEvidence = applyEvidenceFromReport(await readJson<ReviewWorklistActionReport>(statePath));
  if (stateEvidence) candidates.push(stateEvidence);

  const operationsDir = dataPath(dataRoot, REVIEW_WORKLIST_ACTIONS_OPERATIONS_DIR);
  let entries: Array<import("node:fs").Dirent> = [];
  try {
    entries = await fs.readdir(operationsDir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const report = await readJson<ReviewWorklistActionReport>(path.join(operationsDir, entry.name));
    const evidence = applyEvidenceFromReport(report);
    if (evidence) candidates.push(evidence);
  }
  return candidates.sort((left, right) => right.applied_at.localeCompare(left.applied_at))[0] ?? null;
}

function scrubPublicText(value: string): string {
  return value.replace(/[A-Za-z]:\\Users\\[^\\/\s"')]+/g, "%USERPROFILE%");
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean))).sort((left, right) => left.localeCompare(right));
}

function deterministicHoldAction(item: ReviewSettlementItem): ReviewWorklistAction | null {
  if (
    !["auto_compounded_behavior_hold", "legacy_unreviewed_hold"].includes(item.decision_class) ||
    !item.candidate_path ||
    !item.review_path
  ) {
    return null;
  }
  return {
    action_id: `settlement-hold-${safeSlug(item.id)}`,
    cluster_id: `settlement-${safeSlug(item.id)}`,
    kind: "deterministic_hold",
    apply_status: "planned",
    reason_code: item.reason_code,
    cluster_kind: item.decision_class,
    identity_kind: "deterministic",
    item_count: 1,
    representative_claim: item.id,
    candidate_paths: [item.candidate_path],
    review_paths: [item.review_path],
    provenance_member_count: 1,
    applied_paths: [],
    skipped_reason: null,
  };
}

function plannedClusterAction(cluster: ReviewWorklistCluster): ReviewWorklistAction {
  const mergeable = cluster.source === "promotion_queue" && cluster.item_count > 1;
  const kind: ReviewWorklistActionKind = mergeable ? "create_merge_review" : "manual_review_only";
  return {
    action_id: `worklist-action-${safeSlug(cluster.cluster_id)}`,
    cluster_id: cluster.cluster_id,
    kind,
    apply_status: kind === "manual_review_only" ? "not_applicable" : "planned",
    reason_code: mergeable
      ? `${cluster.identity_kind}_duplicate_cluster_requires_single_provenance_review`
      : "manual_semantic_judgment_required",
    cluster_kind: cluster.kind,
    identity_kind: cluster.identity_kind,
    item_count: cluster.item_count,
    representative_claim: cluster.representative_claim,
    candidate_paths: cluster.candidate_paths,
    review_paths: cluster.review_paths,
    provenance_member_count: cluster.members.length,
    applied_paths: [],
    skipped_reason: null,
  };
}

async function createRecoveryRef(dataRoot: string, migrationId: string, required: boolean): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", dataRoot, "rev-parse", "HEAD"], { windowsHide: true });
    const head = stdout.trim();
    if (!/^[0-9a-f]{40}$/i.test(head)) throw new Error("invalid_git_head");
    const recoveryRef = `refs/dinobrain-recovery/review-backpressure/${safeSlug(migrationId)}`;
    await execFileAsync("git", ["-C", dataRoot, "update-ref", recoveryRef, head], { windowsHide: true });
    return recoveryRef;
  } catch (error) {
    if (required) throw new Error(`review_backpressure_git_recovery_ref_failed:${(error as Error).message}`);
    return null;
  }
}

function heldCandidateRecord(record: JsonObject, action: ReviewWorklistAction, reviewer: string, at: string): JsonObject {
  return {
    ...record,
    status: "held",
    temperature: "cold",
    quarantine: true,
    hold_reason: action.reason_code,
    review_notes: "Held by deterministic review-queue settlement; manual review is required before any promotion.",
    reviewed_by: reviewer,
    reviewed_at: at,
    queue_lane: "deterministic_hold",
    queue_destination: "cold_hold",
    updated_at: at,
  };
}

function heldReviewRecord(record: JsonObject, action: ReviewWorklistAction, reviewer: string, at: string): JsonObject {
  return {
    ...record,
    status: "settled_hold",
    decision: "hold",
    reviewer,
    notes: "Held by deterministic review-queue settlement; manual review is required before any promotion.",
    settled_at: at,
    reviewed_at: at,
    queue_lane: "deterministic_hold",
    queue_destination: "cold_hold",
    updated_at: at,
  };
}

async function deterministicHoldWrites(
  dataRoot: string,
  action: ReviewWorklistAction,
  reviewer: string,
  at: string,
): Promise<{ writes: LifecycleBatchWrite[]; action: ReviewWorklistAction }> {
  const candidatePath = action.candidate_paths[0];
  const reviewPath = action.review_paths[0];
  const candidate = await readJsonWithHash(dataPath(dataRoot, ...candidatePath.split("/")));
  const review = await readJsonWithHash(dataPath(dataRoot, ...reviewPath.split("/")));
  if (!candidate || !review) {
    return {
      writes: [],
      action: { ...action, apply_status: "skipped", skipped_reason: !candidate ? "candidate_missing" : "review_missing" },
    };
  }
  const candidateStage = transitionLifecycleWrite(candidatePath, heldCandidateRecord(candidate.record, action, reviewer, at), {
    to_state: "held",
    reason_code: action.reason_code,
    reason: "Deterministic generated memory was removed from the hot review lane.",
    actor: reviewer,
    evidence_paths: unique([candidatePath, reviewPath]),
    successor_paths: [reviewPath],
    at,
    idempotency_key: `review-settlement-hold|${action.action_id}`,
  });
  const reviewStage = transitionLifecycleWrite(reviewPath, heldReviewRecord(review.record, action, reviewer, at), {
    to_state: "held",
    reason_code: action.reason_code,
    reason: "Deterministic promotion review was settled as a cold hold.",
    actor: reviewer,
    evidence_paths: [candidatePath],
    predecessor_paths: [candidatePath],
    at,
    idempotency_key: `review-settlement-review-hold|${action.action_id}`,
    sync_status: false,
  });
  candidateStage.write.expected_before_sha256 = candidate.sha256;
  reviewStage.write.expected_before_sha256 = review.sha256;
  return {
    writes: [candidateStage.write, reviewStage.write],
    action: { ...action, apply_status: "applied", applied_paths: [candidatePath, reviewPath] },
  };
}

function mergeReviewRecord(cluster: ReviewWorklistCluster, reviewer: string, at: string): JsonObject {
  return {
    review_id: cluster.cluster_id,
    type: "merge_review",
    status: "pending",
    source: "review_worklist_actions_v2",
    cluster_kind: cluster.kind,
    identity_kind: cluster.identity_kind,
    normalized_claim_hash: cluster.normalized_claim_hash,
    representative_claim: cluster.representative_claim,
    candidate_paths: cluster.candidate_paths,
    review_paths: cluster.review_paths,
    project_tags: cluster.project_tags,
    source_session_refs: cluster.source_session_refs,
    contradiction_set_ids: cluster.contradiction_set_ids,
    behavior_scopes: cluster.behavior_scopes,
    members: cluster.members,
    provenance_complete: cluster.members.length === cluster.item_count,
    required_action: "Create one reviewed accepted memory for the cluster, or explicitly hold/reject the complete cluster.",
    reviewer,
    created_at: at,
    updated_at: at,
  };
}

async function mergeClusterWrites(
  dataRoot: string,
  cluster: ReviewWorklistCluster,
  action: ReviewWorklistAction,
  reviewer: string,
  at: string,
): Promise<{ writes: LifecycleBatchWrite[]; action: ReviewWorklistAction }> {
  const mergePath = `${REVIEW_WORKLIST_MERGE_QUEUE_DIR}/${safeSlug(cluster.cluster_id)}.json`;
  const writes: LifecycleBatchWrite[] = [];
  const appliedPaths: string[] = [];
  const memberByCandidate = new Map(cluster.members.map((member) => [member.candidate_path, member]));

  for (const candidatePath of cluster.candidate_paths) {
    const member = memberByCandidate.get(candidatePath);
    const candidate = await readJsonWithHash(dataPath(dataRoot, ...candidatePath.split("/")));
    if (!candidate || !member || candidate.sha256 !== member.candidate_sha256) {
      return { writes: [], action: { ...action, apply_status: "skipped", skipped_reason: `candidate_hash_mismatch:${candidatePath}` } };
    }
    const next = {
      ...candidate.record,
      status: "held",
      temperature: "cold",
      quarantine: true,
      hold_reason: "merged_into_single_provenance_review",
      merged_into_review: mergePath,
      queue_lane: "merge_review",
      queue_destination: "cold_hold",
      successor_paths: unique([...(Array.isArray(candidate.record.successor_paths) ? candidate.record.successor_paths.map(String) : []), mergePath]),
      updated_at: at,
    };
    const stage = transitionLifecycleWrite(candidatePath, next, {
      to_state: "held",
      reason_code: "merged_into_single_provenance_review",
      reason: "Duplicate candidate was held behind one provenance-complete merge review.",
      actor: reviewer,
      evidence_paths: unique(member.evidence_paths),
      successor_paths: [mergePath],
      at,
      idempotency_key: `merge-candidate|${cluster.cluster_id}|${candidatePath}`,
    });
    stage.write.expected_before_sha256 = candidate.sha256;
    writes.push(stage.write);
    appliedPaths.push(candidatePath);
  }

  for (const reviewPath of cluster.review_paths) {
    const member = cluster.members.find((value) => value.review_path === reviewPath);
    const review = await readJsonWithHash(dataPath(dataRoot, ...reviewPath.split("/")));
    if (!review || !member || review.sha256 !== member.review_sha256) {
      return { writes: [], action: { ...action, apply_status: "skipped", skipped_reason: `review_hash_mismatch:${reviewPath}` } };
    }
    const next = {
      ...review.record,
      status: "merged",
      decision: "merge",
      merged_into_review: mergePath,
      reviewer,
      reviewed_at: at,
      settled_at: at,
      queue_lane: "merge_review",
      queue_destination: "cold_hold",
      successor_paths: unique([...(Array.isArray(review.record.successor_paths) ? review.record.successor_paths.map(String) : []), mergePath]),
      updated_at: at,
    };
    const stage = transitionLifecycleWrite(reviewPath, next, {
      to_state: "held",
      reason_code: "promotion_review_merged",
      reason: "Duplicate promotion review was replaced by one provenance-complete merge review.",
      actor: reviewer,
      evidence_paths: [member.candidate_path, ...member.evidence_paths],
      predecessor_paths: [member.candidate_path],
      successor_paths: [mergePath],
      at,
      idempotency_key: `merge-review-member|${cluster.cluster_id}|${reviewPath}`,
      sync_status: false,
    });
    stage.write.expected_before_sha256 = review.sha256;
    writes.push(stage.write);
    appliedPaths.push(reviewPath);
  }

  const mergeRecord = mergeReviewRecord(cluster, reviewer, at);
  const mergeStage = initializeLifecycleWrite(mergePath, mergeRecord, {
    to_state: "review",
    reason_code: "duplicate_cluster_merge_review_opened",
    reason: "Exact or high-confidence near duplicates were collapsed into one manual review unit.",
    actor: reviewer,
    evidence_paths: unique(cluster.members.flatMap((member) => [member.candidate_path, member.review_path, ...member.evidence_paths])),
    predecessor_paths: unique([...cluster.candidate_paths, ...cluster.review_paths]),
    at,
    idempotency_key: `merge-review-opened|${cluster.cluster_id}`,
    sync_status: false,
  });
  mergeStage.write.expected_before_sha256 = null;
  writes.push(mergeStage.write);
  appliedPaths.push(mergePath);
  return { writes, action: { ...action, apply_status: "applied", applied_paths: appliedPaths } };
}

function visibleStatus(status: ReviewWorklistActionReport["status"], applyHolds: boolean, applyMergeReviews: boolean): string {
  if (status === "empty") return "Review worklist actions empty";
  if (status === "ready") return "Deterministic holds and duplicate merges settled";
  if (status === "rolled_back") return "Review worklist migration rolled back";
  if (!applyHolds && !applyMergeReviews) return "Review worklist migration planned; review dry-run before apply";
  return "Review worklist migration still needs attention";
}

export async function buildReviewWorklistActions(
  dataRoot: string,
  options: BuildOptions = {},
): Promise<{ report: ReviewWorklistActionReport; statePath: string; operationsPath: string }> {
  const now = options.now ?? new Date();
  const generatedAt = nowIso(now);
  const reviewer = options.reviewer ?? "review-worklist-actions";
  const operationActionLimit = options.operationActionLimit ?? 120;
  const applyHolds = options.applyHolds === true;
  const applyMergeReviews = options.applyMergeReviews === true;
  const statePath = dataPath(dataRoot, ...REVIEW_WORKLIST_ACTIONS_STATE_RELATIVE_PATH.split("/"));
  const previousState = await readJson<ReviewWorklistActionReport>(statePath);
  const previousApply = await findLastApplyEvidence(dataRoot, statePath);

  if (options.rollbackTransactionId) {
    await rollbackNodeLifecycleTransaction(dataRoot, options.rollbackTransactionId);
    const before = await buildReviewWorklist(dataRoot, { now });
    const report: ReviewWorklistActionReport = {
      version: REVIEW_WORKLIST_ACTIONS_VERSION,
      status: "rolled_back",
      generated_at: generatedAt,
      apply: { deterministic_holds: false, merge_reviews: false },
      data_root: path.resolve(dataRoot),
      source_worklist_status: before.report.status,
      before_counts: before.report.counts,
      after_counts: before.report.counts,
      counts: {
        clusters: before.report.clusters.length,
        actions: 0,
        deterministic_hold_actions: 0,
        merge_review_actions: 0,
        manual_only_actions: 0,
        applied: 0,
        skipped: 0,
        changed_paths: 0,
      },
      transaction_id: null,
      transaction_path: null,
      recovery_ref: null,
      last_applied_transaction_id: previousApply?.transaction_id ?? null,
      last_applied_transaction_path: previousApply?.transaction_path ?? null,
      last_recovery_ref: previousApply?.recovery_ref ?? null,
      last_applied_at: previousApply?.applied_at ?? null,
      last_rollback_transaction_id: options.rollbackTransactionId,
      rollback_transaction_id: options.rollbackTransactionId,
      actions: [],
      warnings: [],
      visible_status: "Review worklist migration rolled back",
    };
    await writeJson(statePath, report);
    return { report, statePath, operationsPath: statePath };
  }

  const before = await buildReviewWorklist(dataRoot, { now });
  const settlement = await buildReviewQueueSettlement(dataRoot, { now });
  const holdActions = settlement.items
    .map(deterministicHoldAction)
    .filter((value): value is ReviewWorklistAction => value !== null);
  const clusterActions = before.report.clusters.map(plannedClusterAction);
  const plannedActions = [...holdActions, ...clusterActions];
  const migrationId = `review-backpressure-${Date.now()}-${sha256(plannedActions.map((action) => action.action_id).join("|")).slice(0, 12)}`;
  let recoveryRef: string | null = null;
  let transactionId: string | null = null;
  let transactionPath: string | null = null;
  let changedPaths: string[] = [];
  const actions: ReviewWorklistAction[] = [];
  const writes: LifecycleBatchWrite[] = [];

  if (applyHolds || applyMergeReviews) {
    recoveryRef = await createRecoveryRef(dataRoot, migrationId, options.requireGitRecoveryRef !== false);
  }

  for (const action of plannedActions) {
    if (action.kind === "deterministic_hold" && applyHolds) {
      const planned = await deterministicHoldWrites(dataRoot, action, reviewer, generatedAt);
      actions.push(planned.action);
      writes.push(...planned.writes);
      continue;
    }
    if (action.kind === "create_merge_review" && applyMergeReviews) {
      const cluster = before.report.clusters.find((value) => value.cluster_id === action.cluster_id);
      if (!cluster) {
        actions.push({ ...action, apply_status: "skipped", skipped_reason: "cluster_missing" });
        continue;
      }
      const planned = await mergeClusterWrites(dataRoot, cluster, action, reviewer, generatedAt);
      actions.push(planned.action);
      writes.push(...planned.writes);
      continue;
    }
    actions.push(action);
  }

  const preconditionFailed = actions.some((action) => action.apply_status === "skipped");
  if (preconditionFailed) {
    writes.splice(0, writes.length);
    for (let index = 0; index < actions.length; index += 1) {
      if (actions[index].apply_status !== "applied") continue;
      actions[index] = {
        ...actions[index],
        apply_status: "skipped",
        applied_paths: [],
        skipped_reason: "batch_aborted_due_to_precondition_failure",
      };
    }
  }

  if (writes.length > 0 && !preconditionFailed) {
    const transaction = await writeNodeLifecycleBatch(dataRoot, writes, {
      actor: reviewer,
      reason: `Apply bounded review queue migration ${migrationId}.`,
      fault_after_write_index_for_test: options.faultAfterWriteIndexForTest,
    });
    transactionId = transaction.transaction_id;
    transactionPath = transaction.transaction_path;
    changedPaths = transaction.changed_paths;
  }

  const after = applyHolds || applyMergeReviews ? await buildReviewWorklist(dataRoot, { now }) : null;
  if (applyHolds || applyMergeReviews) await buildReviewQueueBackpressure(dataRoot, { now, reconcileAdmission: true });
  const skipped = actions.filter((action) => action.apply_status === "skipped");
  const deterministicRemaining = after?.report.counts.excluded_deterministic_hold_items ?? before.report.counts.excluded_deterministic_hold_items;
  const duplicatesRemaining = after?.report.counts.duplicate_clusters ?? before.report.counts.duplicate_clusters;
  const status =
    actions.length === 0
      ? "empty"
      : deterministicRemaining === 0 && duplicatesRemaining === 0 && skipped.length === 0
        ? "ready"
        : "needs_apply";
  const successfulApply = status === "ready" && transactionId !== null && skipped.length === 0;
  const lastApply = successfulApply
    ? {
        transaction_id: transactionId,
        transaction_path: transactionPath,
        recovery_ref: recoveryRef,
        applied_at: generatedAt,
      }
    : previousApply;
  const report: ReviewWorklistActionReport = {
    version: REVIEW_WORKLIST_ACTIONS_VERSION,
    status,
    generated_at: generatedAt,
    apply: { deterministic_holds: applyHolds, merge_reviews: applyMergeReviews },
    data_root: path.resolve(dataRoot),
    source_worklist_status: before.report.status,
    before_counts: before.report.counts,
    after_counts: after?.report.counts ?? null,
    counts: {
      clusters: before.report.clusters.length,
      actions: actions.length,
      deterministic_hold_actions: actions.filter((action) => action.kind === "deterministic_hold").length,
      merge_review_actions: actions.filter((action) => action.kind === "create_merge_review").length,
      manual_only_actions: actions.filter((action) => action.kind === "manual_review_only").length,
      applied: actions.filter((action) => action.apply_status === "applied").length,
      skipped: skipped.length,
      changed_paths: changedPaths.length,
    },
    transaction_id: transactionId,
    transaction_path: transactionPath,
    recovery_ref: recoveryRef,
    last_applied_transaction_id: lastApply?.transaction_id ?? null,
    last_applied_transaction_path: lastApply?.transaction_path ?? null,
    last_recovery_ref: lastApply?.recovery_ref ?? null,
    last_applied_at: lastApply?.applied_at ?? null,
    last_rollback_transaction_id: previousState?.last_rollback_transaction_id ?? null,
    rollback_transaction_id: null,
    actions,
    warnings: [
      deterministicRemaining > 0 ? "deterministic_review_holds_pending" : null,
      duplicatesRemaining > 0 ? "duplicate_clusters_pending_merge" : null,
      skipped.length > 0 ? "review_migration_actions_skipped" : null,
    ].filter((value): value is string => Boolean(value)),
    visible_status: visibleStatus(status, applyHolds, applyMergeReviews),
  };

  const operationsPath = dataPath(
    dataRoot,
    REVIEW_WORKLIST_ACTIONS_OPERATIONS_DIR,
    `review-worklist-actions-${dateStamp(now)}-${safeSlug(String(actions.length))}.json`,
  );
  await writeJson(statePath, report);
  await writeJson(operationsPath, {
    version: report.version,
    status: report.status,
    generated_at: report.generated_at,
    apply: report.apply,
    before_counts: report.before_counts,
    after_counts: report.after_counts,
    counts: report.counts,
    transaction_id: report.transaction_id,
    transaction_path: report.transaction_path,
    recovery_ref: report.recovery_ref,
    last_applied_transaction_id: report.last_applied_transaction_id,
    last_applied_transaction_path: report.last_applied_transaction_path,
    last_recovery_ref: report.last_recovery_ref,
    last_applied_at: report.last_applied_at,
    last_rollback_transaction_id: report.last_rollback_transaction_id,
    warnings: report.warnings,
    actions: report.actions.slice(0, operationActionLimit).map((action) => ({
      action_id: action.action_id,
      cluster_id: action.cluster_id,
      kind: action.kind,
      apply_status: action.apply_status,
      reason_code: action.reason_code,
      identity_kind: action.identity_kind,
      item_count: action.item_count,
      representative_claim_hash: sha256(scrubPublicText(action.representative_claim)),
      provenance_member_count: action.provenance_member_count,
      applied_path_count: action.applied_paths.length,
      skipped_reason: action.skipped_reason,
    })),
    omitted_action_count: Math.max(0, report.actions.length - operationActionLimit),
    note: "Public operational summary contains counts and hashes only; candidate claims and local source paths are excluded.",
  });
  return { report, statePath, operationsPath };
}
