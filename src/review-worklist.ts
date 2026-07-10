import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import { atomicWriteJson } from "./concurrency.js";
import { dataPath } from "./context.js";
import {
  buildAndWriteReviewSettlements,
  type ReviewQueueSettlementReport,
  type ReviewSettlementItem,
} from "./review-settlement.js";

export const REVIEW_WORKLIST_VERSION = "review_worklist_v1";
export const REVIEW_WORKLIST_STATE_RELATIVE_PATH = ".dino/state/review_worklist.json";
export const REVIEW_WORKLIST_OPERATIONS_DIR = "60_Operations/review-worklists";

type JsonObject = Record<string, unknown>;

export type ReviewWorklistClusterKind =
  | "user_preference"
  | "project_decision"
  | "project_state"
  | "error_fix"
  | "how_to"
  | "idea"
  | "general";

export type ReviewWorklistRecommendation =
  | "merge_review_for_possible_feedback_memory"
  | "merge_or_project_memory_review"
  | "merge_duplicate_or_hold_if_generic"
  | "hold_if_ephemeral"
  | "single_manual_review"
  | "reject_or_hold_low_signal";

export type ReviewWorklistCluster = {
  cluster_id: string;
  kind: ReviewWorklistClusterKind;
  priority: number;
  item_count: number;
  representative_claim: string;
  normalized_claim_hash: string;
  recommended_action: ReviewWorklistRecommendation;
  rationale: string;
  candidate_paths: string[];
  review_paths: string[];
  project_tags: string[];
  evidence_count: number;
};

export type ReviewWorklistReport = {
  version: typeof REVIEW_WORKLIST_VERSION;
  status: "ready" | "empty" | "needs_review";
  generated_at: string;
  data_root: string;
  source_review_status_path: string;
  source_semantic_jobs_path: string;
  counts: {
    open_items: number;
    clusters: number;
    duplicate_clusters: number;
    duplicate_items: number;
    singleton_clusters: number;
    high_priority_clusters: number;
  };
  by_kind: Record<ReviewWorklistClusterKind, number>;
  clusters: ReviewWorklistCluster[];
  visible_status: string;
};

type BuildOptions = {
  now?: Date;
  operationClusterLimit?: number;
};

type CandidateSummary = {
  claim: string;
  tags: string[];
  evidenceCount: number;
};

const clusterKinds: ReviewWorklistClusterKind[] = [
  "user_preference",
  "project_decision",
  "project_state",
  "error_fix",
  "how_to",
  "idea",
  "general",
];

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
      .slice(0, 72) || "review-worklist"
  );
}

function sha256Short(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
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

function firstString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function stringArray(value: unknown): string[] {
  if (!value) return [];
  if (Array.isArray(value)) return value.map(String).map((item) => item.trim()).filter(Boolean);
  if (typeof value === "string") return value.split(",").map((item) => item.trim()).filter(Boolean);
  return [String(value)].filter(Boolean);
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean))).sort((a, b) => a.localeCompare(b));
}

function normalizeClaim(value: string): string {
  return value
    .toLowerCase()
    .replace(/^(user preference|project decision|project state|error or fix note|how-to note|idea)\s*:\s*/i, "")
    .replace(/[“”]/g, "\"")
    .replace(/[‘’]/g, "'")
    .replace(/\s+/g, " ")
    .replace(/[^\p{L}\p{N}\s._:'"-]+/gu, "")
    .trim();
}

function normalizeClaimForCluster(value: string): string {
  return value
    .toLowerCase()
    .replace(/^(user preference|project decision|project state|error or fix note|how-to note|idea)\s*:\s*/i, "")
    .replace(/[\u201c\u201d]/g, "\"")
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/\s+/g, " ")
    .replace(/[^\p{L}\p{N}\s._:'"-]+/gu, "")
    .trim();
}

function relativeDataPath(dataRoot: string, filePath: string): string {
  return path.relative(path.resolve(dataRoot), path.resolve(filePath)).replace(/\\/g, "/");
}

function scrubPublicText(value: string): string {
  return value.replace(/[A-Za-z]:\\Users\\[^\\/\s"')]+/g, "%USERPROFILE%");
}

function clusterKind(claim: string, tags: string[]): ReviewWorklistClusterKind {
  const lower = claim.toLowerCase();
  if (lower.startsWith("user preference:") || tags.includes("user_preference")) return "user_preference";
  if (lower.startsWith("project decision:") || tags.includes("project_decision")) return "project_decision";
  if (lower.startsWith("project state:") || tags.includes("project_state")) return "project_state";
  if (lower.startsWith("error or fix note:") || tags.includes("error_fix")) return "error_fix";
  if (lower.startsWith("how-to note:") || tags.includes("how_to")) return "how_to";
  if (lower.startsWith("idea:") || tags.includes("idea")) return "idea";
  return "general";
}

function recommendation(kind: ReviewWorklistClusterKind, itemCount: number): ReviewWorklistRecommendation {
  if (kind === "user_preference" && itemCount > 1) return "merge_review_for_possible_feedback_memory";
  if (kind === "project_decision") return "merge_or_project_memory_review";
  if (kind === "error_fix" && itemCount > 1) return "merge_duplicate_or_hold_if_generic";
  if (kind === "project_state") return "hold_if_ephemeral";
  if (kind === "idea" || kind === "general") return "reject_or_hold_low_signal";
  return "single_manual_review";
}

function rationaleFor(kind: ReviewWorklistClusterKind, itemCount: number, action: ReviewWorklistRecommendation): string {
  if (itemCount > 1) return `Duplicate cluster with ${itemCount} matching candidates; merge before any promotion.`;
  if (action === "hold_if_ephemeral") return "Project-state candidates are often time-sensitive; hold unless still durable.";
  if (action === "reject_or_hold_low_signal") return "Low-signal singleton; reject or hold unless the user confirms it is durable.";
  if (kind === "user_preference") return "Potential durable user preference; review carefully before accepting.";
  return "Manual semantic judgment is required before this candidate can enter accepted memory.";
}

async function candidateSummary(dataRoot: string, item: ReviewSettlementItem): Promise<CandidateSummary> {
  const candidate = item.candidate_path ? await readJson<JsonObject>(dataPath(dataRoot, item.candidate_path)) : null;
  const evidence = candidate?.evidence && typeof candidate.evidence === "object" ? (candidate.evidence as JsonObject) : {};
  const claim = firstString(candidate?.claim, candidate?.title, item.id);
  return {
    claim,
    tags: unique([...stringArray(candidate?.tags), ...stringArray(candidate?.category)]),
    evidenceCount: firstString(evidence.snippet, evidence.source) ? 1 : 0,
  };
}

function sortClusters(a: ReviewWorklistCluster, b: ReviewWorklistCluster): number {
  return (
    a.priority - b.priority ||
    b.item_count - a.item_count ||
    a.kind.localeCompare(b.kind) ||
    a.representative_claim.localeCompare(b.representative_claim)
  );
}

export async function buildReviewWorklist(
  dataRoot: string,
  options: BuildOptions = {},
): Promise<{ report: ReviewWorklistReport; statePath: string; operationsPath: string }> {
  const now = options.now ?? new Date();
  const generatedAt = nowIso(now);
  const operationClusterLimit = options.operationClusterLimit ?? 80;
  const settlement = await buildAndWriteReviewSettlements(dataRoot, { now });
  const openItems = settlement.review.items.filter((item) => item.status === "open");
  const clusterMap = new Map<
    string,
    {
      kind: ReviewWorklistClusterKind;
      claim: string;
      tags: string[];
      evidenceCount: number;
      items: ReviewSettlementItem[];
    }
  >();

  for (const item of openItems) {
    const summary = await candidateSummary(dataRoot, item);
    const normalized = normalizeClaimForCluster(summary.claim);
    const hash = sha256Short(normalized || item.id);
    const kind = clusterKind(summary.claim, summary.tags);
    const existing = clusterMap.get(hash);
    if (existing) {
      existing.items.push(item);
      existing.tags = unique([...existing.tags, ...summary.tags]);
      existing.evidenceCount += summary.evidenceCount;
      continue;
    }
    clusterMap.set(hash, {
      kind,
      claim: summary.claim,
      tags: summary.tags,
      evidenceCount: summary.evidenceCount,
      items: [item],
    });
  }

  const clusters = Array.from(clusterMap.entries())
    .map(([hash, cluster]): ReviewWorklistCluster => {
      const candidatePaths = unique(cluster.items.map((item) => item.candidate_path ?? ""));
      const reviewPaths = unique(cluster.items.map((item) => item.review_path ?? ""));
      const action = recommendation(cluster.kind, cluster.items.length);
      const priority =
        action === "merge_review_for_possible_feedback_memory"
          ? 1
          : action === "merge_or_project_memory_review"
            ? 2
            : action === "merge_duplicate_or_hold_if_generic"
              ? 3
              : action === "hold_if_ephemeral"
                ? 4
                : 5;
      return {
        cluster_id: `review-cluster-${hash}`,
        kind: cluster.kind,
        priority,
        item_count: cluster.items.length,
        representative_claim: cluster.claim.slice(0, 360),
        normalized_claim_hash: hash,
        recommended_action: action,
        rationale: rationaleFor(cluster.kind, cluster.items.length, action),
        candidate_paths: candidatePaths,
        review_paths: reviewPaths,
        project_tags: unique(cluster.tags.filter((tag) => tag.startsWith("project:"))),
        evidence_count: cluster.evidenceCount,
      };
    })
    .sort(sortClusters);

  const byKind = Object.fromEntries(clusterKinds.map((kind) => [kind, clusters.filter((cluster) => cluster.kind === kind).length])) as Record<
    ReviewWorklistClusterKind,
    number
  >;
  const duplicateClusters = clusters.filter((cluster) => cluster.item_count > 1);
  const status = openItems.length === 0 ? "empty" : "needs_review";
  const report: ReviewWorklistReport = {
    version: REVIEW_WORKLIST_VERSION,
    status,
    generated_at: generatedAt,
    data_root: path.resolve(dataRoot),
    source_review_status_path: settlement.reviewPath,
    source_semantic_jobs_path: settlement.semanticPath,
    counts: {
      open_items: openItems.length,
      clusters: clusters.length,
      duplicate_clusters: duplicateClusters.length,
      duplicate_items: duplicateClusters.reduce((sum, cluster) => sum + cluster.item_count, 0),
      singleton_clusters: clusters.filter((cluster) => cluster.item_count === 1).length,
      high_priority_clusters: clusters.filter((cluster) => cluster.priority <= 2).length,
    },
    by_kind: byKind,
    clusters,
    visible_status: status === "empty" ? "Review worklist empty" : "Review worklist needs semantic review",
  };

  const statePath = dataPath(dataRoot, ...REVIEW_WORKLIST_STATE_RELATIVE_PATH.split("/"));
  const operationsPath = dataPath(
    dataRoot,
    REVIEW_WORKLIST_OPERATIONS_DIR,
    `review-worklist-${dateStamp(now)}-${safeSlug(String(openItems.length))}.json`,
  );
  await writeJson(statePath, report);
  await writeJson(operationsPath, {
    ...report,
    data_root: undefined,
    source_review_status_path: relativeDataPath(dataRoot, settlement.reviewPath),
    source_semantic_jobs_path: relativeDataPath(dataRoot, settlement.semanticPath),
    clusters: report.clusters.slice(0, operationClusterLimit).map((cluster) => ({
      ...cluster,
      representative_claim: scrubPublicText(cluster.representative_claim),
    })),
    omitted_cluster_count: Math.max(0, report.clusters.length - operationClusterLimit),
    note: "Public operational summary; raw conversation archives and local home paths are not included.",
  });
  return { report, statePath, operationsPath };
}
