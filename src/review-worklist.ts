import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import { atomicWriteJson } from "./concurrency.js";
import { dataPath } from "./context.js";
import {
  buildAndWriteReviewSettlements,
  type ReviewDecisionClass,
  type ReviewSettlementItem,
} from "./review-settlement.js";

export const REVIEW_WORKLIST_VERSION = "review_worklist_v2";
export const REVIEW_WORKLIST_STATE_RELATIVE_PATH = ".dino/state/review_worklist.json";
export const REVIEW_WORKLIST_OPERATIONS_DIR = "60_Operations/review-worklists";
export const REVIEW_WORKLIST_MERGE_QUEUE_DIR = "80_Review_Queue/merge";

type JsonObject = Record<string, unknown>;

export type ReviewWorklistClusterKind =
  | "user_preference"
  | "project_decision"
  | "project_state"
  | "error_fix"
  | "how_to"
  | "idea"
  | "general"
  | "merge_review";

export type ReviewWorklistRecommendation =
  | "merge_review_for_possible_feedback_memory"
  | "merge_or_project_memory_review"
  | "merge_duplicate_or_hold_if_generic"
  | "hold_if_ephemeral"
  | "single_manual_review"
  | "reject_or_hold_low_signal"
  | "manual_merge_review";

export type ReviewWorklistIdentityKind = "exact" | "near" | "singleton" | "pending_merge";

export type ReviewWorklistMember = {
  item_id: string;
  decision_class: ReviewDecisionClass | "merge_review";
  candidate_type: string;
  tags: string[];
  candidate_path: string;
  review_path: string;
  candidate_sha256: string;
  review_sha256: string;
  evidence_paths: string[];
  source_session_refs: string[];
  contradiction_refs: string[];
  behavior_scope: string;
  semantic_identity_hash: string;
};

export type ReviewWorklistCluster = {
  cluster_id: string;
  source: "promotion_queue" | "merge_queue";
  identity_kind: ReviewWorklistIdentityKind;
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
  source_session_refs: string[];
  contradiction_set_ids: string[];
  behavior_scopes: string[];
  evidence_count: number;
  members: ReviewWorklistMember[];
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
    open_promotion_items: number;
    pending_merge_reviews: number;
    review_units: number;
    clusters: number;
    duplicate_clusters: number;
    duplicate_items: number;
    exact_duplicate_clusters: number;
    near_duplicate_clusters: number;
    singleton_clusters: number;
    high_priority_clusters: number;
    excluded_deterministic_hold_items: number;
  };
  by_kind: Record<ReviewWorklistClusterKind, number>;
  by_decision_class: Partial<Record<ReviewDecisionClass, number>>;
  clusters: ReviewWorklistCluster[];
  visible_status: string;
};

type BuildOptions = {
  now?: Date;
  operationClusterLimit?: number;
  nearDuplicateThreshold?: number;
};

type CandidateSummary = {
  item: ReviewSettlementItem;
  claim: string;
  normalizedClaim: string;
  tokens: Set<string>;
  tags: string[];
  evidenceCount: number;
  kind: Exclude<ReviewWorklistClusterKind, "merge_review">;
  behaviorScope: string;
  sourceSessionRefs: string[];
  contradictionRefs: string[];
  member: ReviewWorklistMember;
};

const clusterKinds: ReviewWorklistClusterKind[] = [
  "user_preference",
  "project_decision",
  "project_state",
  "error_fix",
  "how_to",
  "idea",
  "general",
  "merge_review",
];

const deterministicHoldClasses = new Set<ReviewDecisionClass>([
  "auto_compounded_behavior_hold",
  "legacy_unreviewed_hold",
]);

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

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function sha256Short(value: string): string {
  return sha256(value).slice(0, 16);
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

async function readJsonDir(dataRoot: string, relativeDir: string): Promise<Array<{ path: string; record: JsonObject }>> {
  const dir = dataPath(dataRoot, ...relativeDir.split("/"));
  let entries: Array<import("node:fs").Dirent>;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const records: Array<{ path: string; record: JsonObject }> = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const relativePath = `${relativeDir}/${entry.name}`;
    const record = await readJson<JsonObject>(dataPath(dataRoot, ...relativePath.split("/")));
    if (record) records.push({ path: relativePath, record });
  }
  return records;
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
    .replace(/[\u201c\u201d]/g, "\"")
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/\s+/g, " ")
    .replace(/[^\p{L}\p{N}\s._:'"-]+/gu, "")
    .trim();
}

function semanticTokens(value: string): Set<string> {
  return new Set(
    normalizeClaim(value)
      .split(/[^\p{L}\p{N}_-]+/u)
      .map((token) => token.trim())
      .filter((token) => token.length >= 2),
  );
}

function jaccard(left: Set<string>, right: Set<string>): number {
  if (left.size === 0 || right.size === 0) return 0;
  let intersection = 0;
  for (const token of left) if (right.has(token)) intersection += 1;
  return intersection / (left.size + right.size - intersection);
}

function relativeDataPath(dataRoot: string, filePath: string): string {
  return path.relative(path.resolve(dataRoot), path.resolve(filePath)).replace(/\\/g, "/");
}

function clusterKind(claim: string, tags: string[]): Exclude<ReviewWorklistClusterKind, "merge_review"> {
  const lower = claim.toLowerCase();
  if (lower.startsWith("user preference:") || tags.includes("user_preference")) return "user_preference";
  if (lower.startsWith("project decision:") || tags.includes("project_decision")) return "project_decision";
  if (lower.startsWith("project state:") || tags.includes("project_state")) return "project_state";
  if (lower.startsWith("error or fix note:") || tags.includes("error_fix")) return "error_fix";
  if (lower.startsWith("how-to note:") || tags.includes("how_to")) return "how_to";
  if (lower.startsWith("idea:") || tags.includes("idea")) return "idea";
  return "general";
}

function behaviorScope(candidate: JsonObject, tags: string[], kind: ReviewWorklistClusterKind): string {
  const projectTag = tags.find((tag) => tag.startsWith("project:"));
  return firstString(candidate.applies_to, candidate.scope, projectTag, candidate.project, `kind:${kind}`)
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function sourceSessionRefs(candidate: JsonObject, review: JsonObject | null): string[] {
  const evidence = candidate.evidence && typeof candidate.evidence === "object" ? (candidate.evidence as JsonObject) : {};
  const source = candidate.source && typeof candidate.source === "object" ? (candidate.source as JsonObject) : {};
  return unique([
    firstString(candidate.session_id),
    firstString(evidence.source_session_id),
    firstString(candidate.task_id),
    firstString(source.trace_path),
    firstString(review?.source_session_path),
    firstString(review?.source_operation_path),
  ]);
}

function contradictionRefs(candidate: JsonObject, review: JsonObject | null): string[] {
  return unique([
    ...stringArray(candidate.contradicts),
    ...stringArray(candidate.contradiction_paths),
    ...stringArray(candidate.supersedes),
    ...stringArray(candidate.correction_of),
    ...stringArray(review?.contradiction_paths),
  ]);
}

function recommendation(kind: ReviewWorklistClusterKind, itemCount: number): ReviewWorklistRecommendation {
  if (kind === "merge_review") return "manual_merge_review";
  if (itemCount > 1 && kind === "user_preference") return "merge_review_for_possible_feedback_memory";
  if (itemCount > 1 && kind === "project_decision") return "merge_or_project_memory_review";
  if (itemCount > 1) return "merge_duplicate_or_hold_if_generic";
  if (kind === "project_state") return "hold_if_ephemeral";
  if (kind === "idea" || kind === "general") return "reject_or_hold_low_signal";
  return "single_manual_review";
}

function rationaleFor(
  kind: ReviewWorklistClusterKind,
  itemCount: number,
  action: ReviewWorklistRecommendation,
  identityKind: ReviewWorklistIdentityKind,
): string {
  if (identityKind === "pending_merge") return "Merged candidates are represented by one provenance-complete manual review unit.";
  if (itemCount > 1) return `${identityKind === "exact" ? "Exact" : "Near"} duplicate cluster with ${itemCount} candidates; merge before promotion.`;
  if (action === "hold_if_ephemeral") return "Project-state candidates are time-sensitive; hold unless still durable.";
  if (action === "reject_or_hold_low_signal") return "Low-signal singleton; reject or hold unless the user confirms durability.";
  if (kind === "user_preference") return "Potential durable user preference; review carefully before accepting.";
  return "Manual semantic judgment is required before this candidate can enter accepted memory.";
}

async function candidateSummary(dataRoot: string, item: ReviewSettlementItem): Promise<CandidateSummary | null> {
  if (!item.candidate_path || !item.review_path) return null;
  const candidateValue = await readJsonWithHash(dataPath(dataRoot, ...item.candidate_path.split("/")));
  const reviewValue = await readJsonWithHash(dataPath(dataRoot, ...item.review_path.split("/")));
  if (!candidateValue || !reviewValue) return null;
  const candidate = candidateValue.record;
  const review = reviewValue.record;
  const evidence = candidate.evidence && typeof candidate.evidence === "object" ? (candidate.evidence as JsonObject) : {};
  const claim = firstString(candidate.claim, candidate.title, item.id);
  const tags = unique([...stringArray(candidate.tags), ...stringArray(candidate.category)]);
  const kind = clusterKind(claim, tags);
  const normalizedClaim = normalizeClaim(claim);
  const scope = behaviorScope(candidate, tags, kind);
  const sessions = sourceSessionRefs(candidate, review);
  const contradictions = contradictionRefs(candidate, review);
  const member: ReviewWorklistMember = {
    item_id: item.id,
    decision_class: item.decision_class,
    candidate_type: firstString(candidate.type),
    tags,
    candidate_path: item.candidate_path,
    review_path: item.review_path,
    candidate_sha256: candidateValue.sha256,
    review_sha256: reviewValue.sha256,
    evidence_paths: unique(item.evidence_paths),
    source_session_refs: sessions,
    contradiction_refs: contradictions,
    behavior_scope: scope,
    semantic_identity_hash: sha256Short(normalizedClaim || item.id),
  };
  return {
    item,
    claim,
    normalizedClaim,
    tokens: semanticTokens(claim),
    tags,
    evidenceCount: firstString(evidence.snippet, evidence.source) ? 1 : 0,
    kind,
    behaviorScope: scope,
    sourceSessionRefs: sessions,
    contradictionRefs: contradictions,
    member,
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

function priorityFor(action: ReviewWorklistRecommendation): number {
  if (action === "manual_merge_review") return 1;
  if (action === "merge_review_for_possible_feedback_memory") return 1;
  if (action === "merge_or_project_memory_review") return 2;
  if (action === "merge_duplicate_or_hold_if_generic") return 3;
  if (action === "hold_if_ephemeral") return 4;
  return 5;
}

function buildPromotionClusters(summaries: CandidateSummary[], nearDuplicateThreshold: number): ReviewWorklistCluster[] {
  const parents = summaries.map((_, index) => index);
  const find = (value: number): number => {
    let current = value;
    while (parents[current] !== current) {
      parents[current] = parents[parents[current]];
      current = parents[current];
    }
    return current;
  };
  const union = (left: number, right: number): void => {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot !== rightRoot) parents[Math.max(leftRoot, rightRoot)] = Math.min(leftRoot, rightRoot);
  };

  for (let left = 0; left < summaries.length; left += 1) {
    for (let right = left + 1; right < summaries.length; right += 1) {
      const a = summaries[left];
      const b = summaries[right];
      if (a.kind !== b.kind || a.behaviorScope !== b.behaviorScope) continue;
      if (a.normalizedClaim === b.normalizedClaim) {
        union(left, right);
        continue;
      }
      if (Math.min(a.tokens.size, b.tokens.size) < 5) continue;
      if (jaccard(a.tokens, b.tokens) >= nearDuplicateThreshold) union(left, right);
    }
  }

  const grouped = new Map<number, CandidateSummary[]>();
  for (let index = 0; index < summaries.length; index += 1) {
    const root = find(index);
    const values = grouped.get(root) ?? [];
    values.push(summaries[index]);
    grouped.set(root, values);
  }

  return Array.from(grouped.values()).map((members): ReviewWorklistCluster => {
    members.sort((left, right) => left.member.candidate_path.localeCompare(right.member.candidate_path));
    const exact = new Set(members.map((member) => member.normalizedClaim)).size === 1;
    const identityKind: ReviewWorklistIdentityKind = members.length === 1 ? "singleton" : exact ? "exact" : "near";
    const candidatePaths = unique(members.map((member) => member.member.candidate_path));
    const reviewPaths = unique(members.map((member) => member.member.review_path));
    const kind = members[0].kind;
    const action = recommendation(kind, members.length);
    const identity = `${kind}|${members[0].behaviorScope}|${candidatePaths.join("|")}`;
    return {
      cluster_id: `review-cluster-${sha256Short(identity)}`,
      source: "promotion_queue",
      identity_kind: identityKind,
      kind,
      priority: priorityFor(action),
      item_count: members.length,
      representative_claim: members[0].claim.slice(0, 360),
      normalized_claim_hash: sha256Short(members[0].normalizedClaim || members[0].item.id),
      recommended_action: action,
      rationale: rationaleFor(kind, members.length, action, identityKind),
      candidate_paths: candidatePaths,
      review_paths: reviewPaths,
      project_tags: unique(members.flatMap((member) => member.tags.filter((tag) => tag.startsWith("project:")))),
      source_session_refs: unique(members.flatMap((member) => member.sourceSessionRefs)),
      contradiction_set_ids: unique(members.flatMap((member) => member.contradictionRefs)).map((value) => `contradiction-${sha256Short(value)}`),
      behavior_scopes: unique(members.map((member) => member.behaviorScope)),
      evidence_count: members.reduce((sum, member) => sum + member.evidenceCount, 0),
      members: members.map((member) => member.member),
    };
  });
}

function mergeQueueCluster(entry: { path: string; record: JsonObject }): ReviewWorklistCluster | null {
  const status = firstString(entry.record.status).toLowerCase();
  if (["approved", "accepted", "rejected", "held", "closed", "settled", "archived"].includes(status)) return null;
  const members = Array.isArray(entry.record.members)
    ? entry.record.members.filter(
        (value): value is ReviewWorklistMember => typeof value === "object" && value !== null && !Array.isArray(value),
      )
    : [];
  const candidatePaths = unique([
    ...stringArray(entry.record.candidate_paths),
    ...members.map((member) => String(member.candidate_path ?? "")),
  ]);
  const reviewPaths = unique([
    entry.path,
    ...stringArray(entry.record.review_paths),
    ...members.map((member) => String(member.review_path ?? "")),
  ]);
  const representative = firstString(entry.record.representative_claim, entry.record.review_id, path.basename(entry.path, ".json"));
  const clusterId = firstString(entry.record.review_id, path.basename(entry.path, ".json"));
  return {
    cluster_id: clusterId,
    source: "merge_queue",
    identity_kind: "pending_merge",
    kind: "merge_review",
    priority: 1,
    item_count: candidatePaths.length || members.length || 1,
    representative_claim: representative.slice(0, 360),
    normalized_claim_hash: firstString(entry.record.normalized_claim_hash, sha256Short(normalizeClaim(representative))),
    recommended_action: "manual_merge_review",
    rationale: rationaleFor("merge_review", candidatePaths.length, "manual_merge_review", "pending_merge"),
    candidate_paths: candidatePaths,
    review_paths: reviewPaths,
    project_tags: unique(stringArray(entry.record.project_tags)),
    source_session_refs: unique([
      ...stringArray(entry.record.source_session_refs),
      ...members.flatMap((member) => stringArray(member.source_session_refs)),
    ]),
    contradiction_set_ids: unique(stringArray(entry.record.contradiction_set_ids)),
    behavior_scopes: unique(stringArray(entry.record.behavior_scopes)),
    evidence_count: members.reduce((sum, member) => sum + stringArray(member.evidence_paths).length, 0),
    members,
  };
}

export async function buildReviewWorklist(
  dataRoot: string,
  options: BuildOptions = {},
): Promise<{ report: ReviewWorklistReport; statePath: string; operationsPath: string }> {
  const now = options.now ?? new Date();
  const generatedAt = nowIso(now);
  const operationClusterLimit = options.operationClusterLimit ?? 80;
  const nearDuplicateThreshold = options.nearDuplicateThreshold ?? 0.9;
  const settlement = await buildAndWriteReviewSettlements(dataRoot, { now });
  const openItems = settlement.review.items.filter((item) => item.status === "open");
  const deterministicHolds = openItems.filter((item) => deterministicHoldClasses.has(item.decision_class));
  const reviewableItems = openItems.filter((item) => !deterministicHoldClasses.has(item.decision_class));
  const summaries = (await Promise.all(reviewableItems.map((item) => candidateSummary(dataRoot, item)))).filter(
    (value): value is CandidateSummary => value !== null,
  );
  const promotionClusters = buildPromotionClusters(summaries, nearDuplicateThreshold);
  const mergeEntries = await readJsonDir(dataRoot, REVIEW_WORKLIST_MERGE_QUEUE_DIR);
  const mergeClusters = mergeEntries.map(mergeQueueCluster).filter((value): value is ReviewWorklistCluster => value !== null);
  const clusters = [...promotionClusters, ...mergeClusters].sort(sortClusters);
  const byKind = Object.fromEntries(clusterKinds.map((kind) => [kind, clusters.filter((cluster) => cluster.kind === kind).length])) as Record<
    ReviewWorklistClusterKind,
    number
  >;
  const byDecisionClass = Object.fromEntries(
    Array.from(new Set(reviewableItems.map((item) => item.decision_class))).map((decisionClass) => [
      decisionClass,
      reviewableItems.filter((item) => item.decision_class === decisionClass).length,
    ]),
  );
  const duplicateClusters = promotionClusters.filter((cluster) => cluster.item_count > 1);
  const openItemCount = reviewableItems.length + mergeClusters.length;
  const status = openItemCount === 0 ? "empty" : "needs_review";
  const report: ReviewWorklistReport = {
    version: REVIEW_WORKLIST_VERSION,
    status,
    generated_at: generatedAt,
    data_root: path.resolve(dataRoot),
    source_review_status_path: settlement.reviewPath,
    source_semantic_jobs_path: settlement.semanticPath,
    counts: {
      open_items: openItemCount,
      open_promotion_items: reviewableItems.length,
      pending_merge_reviews: mergeClusters.length,
      review_units: clusters.length,
      clusters: clusters.length,
      duplicate_clusters: duplicateClusters.length,
      duplicate_items: duplicateClusters.reduce((sum, cluster) => sum + cluster.item_count, 0),
      exact_duplicate_clusters: duplicateClusters.filter((cluster) => cluster.identity_kind === "exact").length,
      near_duplicate_clusters: duplicateClusters.filter((cluster) => cluster.identity_kind === "near").length,
      singleton_clusters: promotionClusters.filter((cluster) => cluster.item_count === 1).length,
      high_priority_clusters: clusters.filter((cluster) => cluster.priority <= 2).length,
      excluded_deterministic_hold_items: deterministicHolds.length,
    },
    by_kind: byKind,
    by_decision_class: byDecisionClass,
    clusters,
    visible_status: status === "empty" ? "Review worklist empty" : "Review worklist needs bounded semantic review",
  };

  const statePath = dataPath(dataRoot, ...REVIEW_WORKLIST_STATE_RELATIVE_PATH.split("/"));
  const operationsPath = dataPath(
    dataRoot,
    REVIEW_WORKLIST_OPERATIONS_DIR,
    `review-worklist-${dateStamp(now)}-${safeSlug(String(report.counts.open_items))}.json`,
  );
  await writeJson(statePath, report);
  await writeJson(operationsPath, {
    ...report,
    data_root: undefined,
    source_review_status_path: relativeDataPath(dataRoot, settlement.reviewPath),
    source_semantic_jobs_path: relativeDataPath(dataRoot, settlement.semanticPath),
    clusters: report.clusters.slice(0, operationClusterLimit).map((cluster) => ({
      cluster_id: cluster.cluster_id,
      source: cluster.source,
      identity_kind: cluster.identity_kind,
      kind: cluster.kind,
      priority: cluster.priority,
      item_count: cluster.item_count,
      representative_claim_hash: sha256(cluster.representative_claim),
      normalized_claim_hash: cluster.normalized_claim_hash,
      recommended_action: cluster.recommended_action,
      project_tag_hashes: cluster.project_tags.map(sha256),
      source_session_count: cluster.source_session_refs.length,
      contradiction_set_count: cluster.contradiction_set_ids.length,
      behavior_scope_hashes: cluster.behavior_scopes.map(sha256),
      evidence_count: cluster.evidence_count,
      provenance_member_count: cluster.members.length,
      member_provenance_hash: sha256(
        JSON.stringify(
          cluster.members.map((member) => ({
            candidate_sha256: member.candidate_sha256,
            review_sha256: member.review_sha256,
            semantic_identity_hash: member.semantic_identity_hash,
          })),
        ),
      ),
    })),
    omitted_cluster_count: Math.max(0, report.clusters.length - operationClusterLimit),
    note: "Public operational summary contains aggregate counts and hashes only; claims, tags, session ids, and source paths are excluded.",
  });
  return { report, statePath, operationsPath };
}
