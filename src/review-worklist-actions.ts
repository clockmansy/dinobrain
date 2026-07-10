import { promises as fs } from "node:fs";
import path from "node:path";

import { atomicWriteJson } from "./concurrency.js";
import { dataPath } from "./context.js";
import {
  buildReviewWorklist,
  type ReviewWorklistCluster,
  type ReviewWorklistReport,
  type ReviewWorklistRecommendation,
} from "./review-worklist.js";

export const REVIEW_WORKLIST_ACTIONS_VERSION = "review_worklist_actions_v1";
export const REVIEW_WORKLIST_ACTIONS_STATE_RELATIVE_PATH = ".dino/state/review_worklist_actions.json";
export const REVIEW_WORKLIST_ACTIONS_OPERATIONS_DIR = "60_Operations/review-worklist-actions";
export const REVIEW_WORKLIST_MERGE_QUEUE_DIR = "80_Review_Queue/merge";

type JsonObject = Record<string, unknown>;

export type ReviewWorklistActionKind = "create_merge_review" | "hold_candidate_and_review" | "manual_review_only";
export type ReviewWorklistActionApplyStatus = "planned" | "applied" | "skipped";

export type ReviewWorklistAction = {
  action_id: string;
  cluster_id: string;
  kind: ReviewWorklistActionKind;
  apply_status: ReviewWorklistActionApplyStatus;
  reason_code: string;
  cluster_kind: string;
  item_count: number;
  representative_claim: string;
  candidate_paths: string[];
  review_paths: string[];
  applied_paths: string[];
  skipped_reason: string | null;
};

export type ReviewWorklistActionReport = {
  version: typeof REVIEW_WORKLIST_ACTIONS_VERSION;
  status: "ready" | "needs_apply" | "empty";
  generated_at: string;
  apply: {
    holds: boolean;
    merge_reviews: boolean;
  };
  data_root: string;
  source_worklist_status: ReviewWorklistReport["status"];
  before_counts: ReviewWorklistReport["counts"];
  after_counts: ReviewWorklistReport["counts"] | null;
  counts: {
    clusters: number;
    actions: number;
    merge_review_actions: number;
    hold_actions: number;
    manual_only_actions: number;
    applied: number;
    skipped: number;
  };
  actions: ReviewWorklistAction[];
  visible_status: string;
};

type BuildOptions = {
  now?: Date;
  applyHolds?: boolean;
  applyMergeReviews?: boolean;
  reviewer?: string;
  operationActionLimit?: number;
};

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

async function readJson<T>(filePath: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await atomicWriteJson(filePath, value);
}

function relativeDataPath(dataRoot: string, filePath: string): string {
  return path.relative(path.resolve(dataRoot), path.resolve(filePath)).replace(/\\/g, "/");
}

function scrubPublicText(value: string): string {
  return value.replace(/[A-Za-z]:\\Users\\[^\\/\s"')]+/g, "%USERPROFILE%");
}

function isMergeRecommendation(recommendation: ReviewWorklistRecommendation): boolean {
  return (
    recommendation === "merge_review_for_possible_feedback_memory" ||
    recommendation === "merge_or_project_memory_review" ||
    recommendation === "merge_duplicate_or_hold_if_generic"
  );
}

function isSafeHoldRecommendation(recommendation: ReviewWorklistRecommendation): boolean {
  return recommendation === "hold_if_ephemeral" || recommendation === "reject_or_hold_low_signal";
}

function plannedActionFor(cluster: ReviewWorklistCluster): ReviewWorklistAction {
  const mergeable = cluster.item_count > 1 && isMergeRecommendation(cluster.recommended_action);
  const holdable = isSafeHoldRecommendation(cluster.recommended_action);
  const kind: ReviewWorklistActionKind = mergeable ? "create_merge_review" : holdable ? "hold_candidate_and_review" : "manual_review_only";
  const reasonCode =
    kind === "create_merge_review"
      ? "duplicate_cluster_requires_single_semantic_review"
      : kind === "hold_candidate_and_review"
        ? "low_signal_or_ephemeral_cluster_should_not_enter_hot_memory"
        : "manual_semantic_judgment_required";
  return {
    action_id: `worklist-action-${safeSlug(cluster.cluster_id)}`,
    cluster_id: cluster.cluster_id,
    kind,
    apply_status: "planned",
    reason_code: reasonCode,
    cluster_kind: cluster.kind,
    item_count: cluster.item_count,
    representative_claim: cluster.representative_claim,
    candidate_paths: cluster.candidate_paths,
    review_paths: cluster.review_paths,
    applied_paths: [],
    skipped_reason: null,
  };
}

async function applyMergeReviewAction(
  dataRoot: string,
  action: ReviewWorklistAction,
  reviewer: string,
  appliedAt: string,
): Promise<ReviewWorklistAction> {
  const mergePath = dataPath(dataRoot, REVIEW_WORKLIST_MERGE_QUEUE_DIR, `${safeSlug(action.cluster_id)}.json`);
  await writeJson(mergePath, {
    review_id: action.cluster_id,
    type: "merge_review",
    status: "pending",
    source: "review_worklist_actions",
    source_action_id: action.action_id,
    cluster_kind: action.cluster_kind,
    representative_claim: action.representative_claim,
    candidate_paths: action.candidate_paths,
    review_paths: action.review_paths,
    required_action: "Create one reviewed accepted memory for the cluster, or explicitly hold/reject the cluster.",
    reviewer,
    created_at: appliedAt,
    updated_at: appliedAt,
  });
  return {
    ...action,
    apply_status: "applied",
    applied_paths: [relativeDataPath(dataRoot, mergePath)],
  };
}

async function applyHoldAction(
  dataRoot: string,
  action: ReviewWorklistAction,
  reviewer: string,
  appliedAt: string,
): Promise<ReviewWorklistAction> {
  const appliedPaths: string[] = [];
  const missingPaths: string[] = [];
  const note = "Held by review worklist action; candidate is low-signal or ephemeral and must not enter hot memory without manual confirmation.";

  for (const candidatePath of action.candidate_paths) {
    const fullPath = dataPath(dataRoot, candidatePath);
    const candidate = await readJson<JsonObject>(fullPath);
    if (!candidate) {
      missingPaths.push(candidatePath);
      continue;
    }
    await writeJson(fullPath, {
      ...candidate,
      status: "held",
      quarantine: true,
      hold_reason: action.reason_code,
      worklist_cluster_id: action.cluster_id,
      review_notes: note,
      reviewed_by: reviewer,
      reviewed_at: appliedAt,
      updated_at: appliedAt,
    });
    appliedPaths.push(candidatePath);
  }

  for (const reviewPath of action.review_paths) {
    const fullPath = dataPath(dataRoot, reviewPath);
    const review = await readJson<JsonObject>(fullPath);
    if (!review) {
      missingPaths.push(reviewPath);
      continue;
    }
    await writeJson(fullPath, {
      ...review,
      status: "settled_hold",
      decision: "hold",
      source: "review_worklist_actions",
      worklist_cluster_id: action.cluster_id,
      reviewer,
      notes: note,
      settled_at: appliedAt,
      reviewed_at: appliedAt,
      updated_at: appliedAt,
    });
    appliedPaths.push(reviewPath);
  }

  if (missingPaths.length > 0) {
    return {
      ...action,
      apply_status: appliedPaths.length > 0 ? "applied" : "skipped",
      applied_paths: appliedPaths,
      skipped_reason: `missing_paths:${missingPaths.join(",")}`,
    };
  }
  return {
    ...action,
    apply_status: "applied",
    applied_paths: appliedPaths,
  };
}

function visibleStatus(status: ReviewWorklistActionReport["status"], applyHolds: boolean, applyMergeReviews: boolean): string {
  if (status === "empty") return "Review worklist actions empty";
  if (status === "ready") return "Review worklist actions ready";
  if (!applyHolds && !applyMergeReviews) return "Review worklist actions planned; rerun with apply flags to mutate review records";
  return "Review worklist actions still need attention";
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
  const before = await buildReviewWorklist(dataRoot, { now });
  const plannedActions = before.report.clusters.map(plannedActionFor);
  const actions: ReviewWorklistAction[] = [];

  for (const action of plannedActions) {
    if (action.kind === "create_merge_review" && applyMergeReviews) {
      actions.push(await applyMergeReviewAction(dataRoot, action, reviewer, generatedAt));
    } else if (action.kind === "hold_candidate_and_review" && applyHolds) {
      actions.push(await applyHoldAction(dataRoot, action, reviewer, generatedAt));
    } else {
      actions.push(action);
    }
  }

  const after = applyHolds ? await buildReviewWorklist(dataRoot, { now }) : null;
  const applied = actions.filter((action) => action.apply_status === "applied");
  const skipped = actions.filter((action) => action.apply_status === "skipped");
  const mutatingPlanned = actions.filter(
    (action) =>
      action.apply_status === "planned" &&
      ((action.kind === "hold_candidate_and_review" && !applyHolds) ||
        (action.kind === "create_merge_review" && !applyMergeReviews)),
  );
  const status =
    actions.length === 0
      ? "empty"
      : mutatingPlanned.length === 0 && skipped.length === 0
        ? "ready"
        : "needs_apply";
  const report: ReviewWorklistActionReport = {
    version: REVIEW_WORKLIST_ACTIONS_VERSION,
    status,
    generated_at: generatedAt,
    apply: {
      holds: applyHolds,
      merge_reviews: applyMergeReviews,
    },
    data_root: path.resolve(dataRoot),
    source_worklist_status: before.report.status,
    before_counts: before.report.counts,
    after_counts: after?.report.counts ?? null,
    counts: {
      clusters: before.report.clusters.length,
      actions: actions.length,
      merge_review_actions: actions.filter((action) => action.kind === "create_merge_review").length,
      hold_actions: actions.filter((action) => action.kind === "hold_candidate_and_review").length,
      manual_only_actions: actions.filter((action) => action.kind === "manual_review_only").length,
      applied: applied.length,
      skipped: skipped.length,
    },
    actions,
    visible_status: visibleStatus(status, applyHolds, applyMergeReviews),
  };

  const statePath = dataPath(dataRoot, ...REVIEW_WORKLIST_ACTIONS_STATE_RELATIVE_PATH.split("/"));
  const operationsPath = dataPath(
    dataRoot,
    REVIEW_WORKLIST_ACTIONS_OPERATIONS_DIR,
    `review-worklist-actions-${dateStamp(now)}-${safeSlug(String(actions.length))}.json`,
  );
  await writeJson(statePath, report);
  await writeJson(operationsPath, {
    ...report,
    data_root: undefined,
    actions: report.actions.slice(0, operationActionLimit).map((action) => ({
      ...action,
      representative_claim: scrubPublicText(action.representative_claim),
    })),
    omitted_action_count: Math.max(0, report.actions.length - operationActionLimit),
    note: "Public operational summary; raw conversation archives and local home paths are not included.",
  });
  return { report, statePath, operationsPath };
}
