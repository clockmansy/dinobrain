import { createHash, randomUUID } from "node:crypto";
import { createReadStream, type Dirent, promises as fs } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { atomicWriteJson, withFileLock } from "./concurrency.js";

export const EVIDENCE_GRAPH_VERSION = "evidence_graph_v1";
export const EVIDENCE_GRAPH_SQLITE_RELATIVE_PATH = ".dino/index/evidence-graph.sqlite";
export const EVIDENCE_GRAPH_STATUS_RELATIVE_PATH = ".dino/state/evidence_graph_status.json";

export const EVIDENCE_GRAPH_REQUIRED_EDGE_TYPES = [
  "source_to_chunk",
  "chunk_to_claim",
  "correction_to_rule",
  "candidate_to_review",
  "predecessor_to_successor",
  "context_provided",
  "memory_declared_used",
  "memory_observed_used",
  "task_to_trace",
  "sync_to_commit",
] as const;

export const EVIDENCE_GRAPH_LANES = [
  "active",
  "stale",
  "blocked",
  "reviewer_pending",
  "verifier_pending",
  "main_pending",
] as const;

type EvidenceLane = (typeof EVIDENCE_GRAPH_LANES)[number] | "normal";
type JsonObject = Record<string, unknown>;

type SourceDescriptor = {
  relativePath: string;
  absolutePath: string;
  format: "json" | "jsonl";
  kind: string;
  sizeBytes: number;
  mtimeMs: number;
};

type NodeContribution = {
  id: string;
  type: string;
  label: string;
  path: string | null;
  status: string | null;
  lifecycleState: string | null;
  provenanceStatus: string | null;
  lane: EvidenceLane;
  evidencePath: string;
  updatedAt: string | null;
  weight: number;
  priority: number;
  details: JsonObject;
};

type EdgeContribution = {
  id: string;
  fromId: string;
  toId: string;
  type: string;
  evidencePath: string;
  status: string | null;
  lane: EvidenceLane;
  updatedAt: string | null;
  priority: number;
  details: JsonObject;
};

type Contributions = {
  nodes: Map<string, NodeContribution>;
  edges: Map<string, EdgeContribution>;
  parseErrors: string[];
};

export type EvidenceGraphStatus = {
  version: typeof EVIDENCE_GRAPH_VERSION;
  status: "healthy" | "needs_attention";
  generated_at: string;
  index_path: string;
  index_sha256: string;
  counts: {
    sources: number;
    nodes: number;
    edges: number;
    typed_edges: number;
    parse_errors: number;
    by_type: Record<string, number>;
    by_lane: Record<string, number>;
    by_edge_type: Record<string, number>;
  };
  incremental: {
    reused_sources: number;
    rebuilt_sources: number;
    removed_sources: number;
    reuse_ratio: number;
    previous_index_available: boolean;
    fingerprint_mode: "metadata_incremental_v1" | "full_sha256_v1";
    metadata_reused_sources: number;
    hash_verified_sources: number;
  };
  relation_contract: {
    supported: string[];
    observed: string[];
    unobserved: string[];
  };
  parity: {
    status: "healthy" | "needs_attention";
    checks: Array<{ id: string; expected: number; actual: number; status: "pass" | "fail" }>;
  };
  memory: {
    rss_before_bytes: number;
    rss_after_bytes: number;
    rss_delta_bytes: number;
  };
  blockers: string[];
  warnings: string[];
};

export type EvidenceGraphWindowOptions = {
  databasePath?: string;
  focusId?: string | null;
  lane?: string | null;
  lifecycleState?: string | null;
  provenanceStatus?: string | null;
  edgeTypes?: string[];
  nodeLimit?: number;
  edgeLimit?: number;
  focusDepth?: number;
};

type GraphNodeRow = {
  id: string;
  type: string;
  label: string;
  path: string | null;
  status: string | null;
  lifecycle_state: string | null;
  provenance_status: string | null;
  lane: string;
  evidence_path: string;
  updated_at: string | null;
  weight: number;
  priority: number;
  details_json: string;
  source_count: number;
};

type GraphEdgeRow = {
  id: string;
  from_id: string;
  to_id: string;
  type: string;
  evidence_path: string;
  status: string | null;
  lane: string;
  updated_at: string | null;
  priority: number;
  details_json: string;
  source_count: number;
};

const STATE_EXCLUSIONS = new Set([
  "current-status-generation.json",
  "current-completion-audit.json",
  "health_status.json",
  "monitoring_status.json",
  "evidence_graph_status.json",
]);

const GENERIC_EDGE_TYPES = new Set(["has_tag", "has_kind", "in_folder", "in_root", "wiki_link"]);

const RELATION_PRIORITY: Record<string, number> = {
  source_to_chunk: 120,
  chunk_to_claim: 120,
  correction_to_rule: 120,
  candidate_to_review: 115,
  predecessor_to_successor: 110,
  context_provided: 120,
  memory_declared_used: 120,
  memory_observed_used: 125,
  task_to_trace: 120,
  sync_to_commit: 125,
  in_lane: 105,
  task_to_audit: 100,
  task_to_sync: 100,
  pack_contains: 95,
  trace_to_context: 95,
  review_approved_memory: 95,
  candidate_promoted_to_memory: 95,
  grounded_by: 90,
  supported_by: 90,
  status_reports_on: 80,
  task_gate: 80,
  sync_included: 75,
  has_tag: 10,
  has_kind: 9,
  in_folder: 8,
  in_root: 7,
  wiki_link: 20,
};

function isObject(value: unknown): value is JsonObject {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0).map((entry) => entry.trim())
    : [];
}

function objectArray(value: unknown): JsonObject[] {
  return Array.isArray(value) ? value.filter(isObject) : [];
}

function compact(value: unknown, max = 96): string {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, Math.max(1, max - 3))}...` : text;
}

function sha256Text(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolve);
  });
  return hash.digest("hex");
}

function normalizeVaultPath(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().replace(/\\/g, "/").replace(/^\.\//, "");
  if (!normalized || normalized.includes("\0") || path.posix.isAbsolute(normalized)) return null;
  if (/^[A-Za-z]:\//.test(normalized)) return null;
  const clean = path.posix.normalize(normalized);
  if (clean === ".." || clean.startsWith("../")) return null;
  return clean;
}

function pathNodeId(relativePath: string): string {
  return `path:${sha256Text(relativePath).slice(0, 24)}`;
}

function uriNodeId(uri: string): string {
  return `uri:${sha256Text(uri).slice(0, 24)}`;
}

function taxonomyNodeId(type: string, value: string): string {
  return `taxonomy:${type}:${sha256Text(value).slice(0, 20)}`;
}

function recordNodeId(type: string, value: string): string {
  return `${type}:${sha256Text(value).slice(0, 24)}`;
}

function edgeId(fromId: string, type: string, toId: string): string {
  return `edge:${sha256Text(`${fromId}\0${type}\0${toId}`).slice(0, 28)}`;
}

function labelFromPath(relativePath: string): string {
  const base = path.posix.basename(relativePath).replace(/\.(jsonl?|md|sqlite)$/i, "").replace(/[_-]+/g, " ");
  return compact(base || relativePath, 72);
}

function statusValue(record: JsonObject): string | null {
  return firstString(record.status, record.verdict, record.generation_status, record.review_status, record.lifecycle_state);
}

function lifecycleValue(record: JsonObject): string | null {
  return firstString(record.lifecycle_state, record.status);
}

function provenanceValue(record: JsonObject): string | null {
  return firstString(record.verification_status, record.review_status, record.source_status, record.source_prompt_binding_status);
}

function statusToken(value: string | null): string {
  return String(value ?? "").trim().toLowerCase().replace(/[\s-]+/g, "_");
}

function laneFor(relativePath: string, record: JsonObject, now = Date.now()): EvidenceLane {
  const status = statusToken(statusValue(record));
  const verification = statusToken(provenanceValue(record));
  const updatedAt = Date.parse(firstString(record.updated_at, record.finished_at, record.created_at, record.generated_at) ?? "");
  if (relativePath.startsWith(".dino/tasks/") && status === "started") {
    return Number.isFinite(updatedAt) && now - updatedAt > 24 * 60 * 60 * 1000 ? "stale" : "active";
  }
  if (["stale", "expired"].includes(status)) return "stale";
  if (
    ["fail", "failed", "blocked", "degraded", "quarantined", "rejected", "not_complete", "parse_error", "invalid"].includes(status)
  ) return "blocked";
  if (
    relativePath.startsWith("50_Instances/candidates/") ||
    relativePath.startsWith("80_Review_Queue/") ||
    ["pending", "pending_review", "needs_review", "needs_apply", "classified_backlog", "needs_settlement"].includes(status)
  ) return "reviewer_pending";
  if (
    ["unverified", "unknown", "needs_recheck", "verifier_pending", "anchor_only_unverified"].includes(verification) ||
    ["needs_recheck", "verifier_pending"].includes(status)
  ) return "verifier_pending";
  if (
    relativePath.endsWith("release_manifest_status.json") ||
    ["main_pending", "retry_required", "not_pushed", "needs_release", "tag_mismatch"].includes(status)
  ) return status === "healthy" || status === "verified" ? "normal" : "main_pending";
  return "normal";
}

function inferNodeType(relativePath: string, record: JsonObject): string {
  const declared = statusToken(firstString(record.type, record.memory_kind));
  if (relativePath.startsWith(".dino/tasks/")) return "task";
  if (relativePath.startsWith(".dino/context-packs/")) return "context_pack";
  if (relativePath.startsWith(".dino/traces/")) return "trace";
  if (relativePath.startsWith(".dino/gates/")) return "gate";
  if (relativePath.startsWith(".dino/audits/")) return declared.includes("memory") ? "memory_audit" : "audit";
  if (relativePath.startsWith("50_Instances/candidates/")) return declared === "feedback_correction" ? "correction" : "candidate";
  if (relativePath.startsWith("50_Instances/accepted/")) return declared === "feedback_correction" ? "behavior_rule" : "memory";
  if (relativePath.startsWith("80_Review_Queue/")) return "review";
  if (relativePath.startsWith("30_Sources/chunks/")) return "source_chunk";
  if (relativePath.startsWith("30_Sources/fetched/")) return "source_snapshot";
  if (relativePath.startsWith(".dino/provenance/")) return declared.includes("generation") ? "lineage_generation" : "provenance";
  if (relativePath.startsWith(".dino/state/")) return "status";
  if (relativePath.startsWith("20_Wiki/")) return "wiki_record";
  if (relativePath.startsWith("40_Projects/")) return "project_record";
  if (relativePath.startsWith("60_Operations/")) return "operations_record";
  if (relativePath.startsWith("70_Error_Book/")) return "error_record";
  return "record";
}

function nodeLabel(relativePath: string, record: JsonObject): string {
  return compact(
    firstString(
      record.title,
      record.label,
      record.claim,
      record.request,
      record.summary,
      record.task_id,
      record.pack_id,
      record.audit_id,
      record.review_id,
      record.candidate_id,
    ) ?? labelFromPath(relativePath),
    84,
  );
}

function nodeDetails(record: JsonObject): JsonObject {
  const details: JsonObject = {};
  for (const [key, max] of [
    ["summary", 180],
    ["claim", 180],
    ["source_uri", 260],
    ["verdict", 60],
    ["action_decision", 60],
  ] as Array<[string, number]>) {
    if (typeof record[key] === "string" && record[key]) details[key] = compact(record[key], max);
  }
  if (typeof record.trust_score === "number") details.trust_score = record.trust_score;
  if (typeof record.score === "number") details.score = record.score;
  return details;
}

function newContributions(): Contributions {
  return { nodes: new Map(), edges: new Map(), parseErrors: [] };
}

function addNode(contributions: Contributions, node: NodeContribution): void {
  const existing = contributions.nodes.get(node.id);
  if (!existing || node.priority > existing.priority) contributions.nodes.set(node.id, node);
}

function addEdge(contributions: Contributions, edge: Omit<EdgeContribution, "id" | "priority"> & { priority?: number }): void {
  const id = edgeId(edge.fromId, edge.type, edge.toId);
  const value: EdgeContribution = {
    ...edge,
    id,
    priority: edge.priority ?? RELATION_PRIORITY[edge.type] ?? 50,
  };
  const existing = contributions.edges.get(id);
  if (!existing || value.priority > existing.priority) contributions.edges.set(id, value);
}

function addLane(contributions: Contributions, node: NodeContribution): void {
  if (node.lane === "normal") return;
  addEdge(contributions, {
    fromId: node.id,
    toId: `lane:${node.lane}`,
    type: "in_lane",
    evidencePath: node.evidencePath,
    status: node.status,
    lane: node.lane,
    updatedAt: node.updatedAt,
    details: { lane: node.lane },
  });
}

function addFileNode(contributions: Contributions, relativePath: string, record: JsonObject, priority = 100): NodeContribution {
  const lane = laneFor(relativePath, record);
  const node: NodeContribution = {
    id: pathNodeId(relativePath),
    type: inferNodeType(relativePath, record),
    label: nodeLabel(relativePath, record),
    path: relativePath,
    status: statusValue(record),
    lifecycleState: lifecycleValue(record),
    provenanceStatus: provenanceValue(record),
    lane,
    evidencePath: relativePath,
    updatedAt: firstString(record.updated_at, record.finished_at, record.created_at, record.generated_at),
    weight: 4,
    priority,
    details: nodeDetails(record),
  };
  addNode(contributions, node);
  addLane(contributions, node);
  return node;
}

function ensureReferenceNode(
  contributions: Contributions,
  reference: unknown,
  evidencePath: string,
  type = "evidence",
): string | null {
  if (typeof reference !== "string" || !reference.trim()) return null;
  const text = reference.trim();
  if (/^https?:\/\//i.test(text)) {
    const id = uriNodeId(text);
    addNode(contributions, {
      id,
      type: "external_source",
      label: compact(text.replace(/^https?:\/\//i, ""), 74),
      path: null,
      status: "linked",
      lifecycleState: null,
      provenanceStatus: "external",
      lane: "normal",
      evidencePath,
      updatedAt: null,
      weight: 3,
      priority: 30,
      details: { source_uri: compact(text, 260) },
    });
    return id;
  }
  const normalized = normalizeVaultPath(text);
  if (!normalized) return null;
  const id = pathNodeId(normalized);
  addNode(contributions, {
    id,
    type,
    label: labelFromPath(normalized),
    path: normalized,
    status: null,
    lifecycleState: null,
    provenanceStatus: null,
    lane: "normal",
    evidencePath,
    updatedAt: null,
    weight: 2,
    priority: 20,
    details: {},
  });
  return id;
}

function addReferenceEdge(
  contributions: Contributions,
  fromId: string,
  reference: unknown,
  type: string,
  evidencePath: string,
  targetType = "evidence",
  details: JsonObject = {},
): string | null {
  const targetId = ensureReferenceNode(contributions, reference, evidencePath, targetType);
  if (!targetId) return null;
  addEdge(contributions, {
    fromId,
    toId: targetId,
    type,
    evidencePath,
    status: null,
    lane: "normal",
    updatedAt: null,
    details,
  });
  return targetId;
}

function addLifecycleEdges(contributions: Contributions, node: NodeContribution, record: JsonObject): void {
  for (const predecessor of stringArray(record.predecessor_paths)) {
    const predecessorId = ensureReferenceNode(contributions, predecessor, node.evidencePath);
    if (!predecessorId) continue;
    addEdge(contributions, {
      fromId: predecessorId,
      toId: node.id,
      type: "predecessor_to_successor",
      evidencePath: node.evidencePath,
      status: node.status,
      lane: node.lane,
      updatedAt: node.updatedAt,
      details: {},
    });
  }
  for (const successor of stringArray(record.successor_paths)) {
    addReferenceEdge(contributions, node.id, successor, "predecessor_to_successor", node.evidencePath);
  }
}

function contributionsFromWikiIndex(relativePath: string, record: JsonObject): Contributions {
  const result = newContributions();
  for (const item of objectArray(record.records)) {
    const itemPath = normalizeVaultPath(item.path);
    if (!itemPath) continue;
    const node = addFileNode(result, itemPath, item, 85);
    node.weight = Math.max(2, Number(item.size_bytes ?? 2));
    const root = firstString(item.root) ?? itemPath.split("/")[0];
    if (root) {
      const rootId = taxonomyNodeId("root", root);
      addNode(result, {
        id: rootId,
        type: "root",
        label: root,
        path: root,
        status: "active",
        lifecycleState: null,
        provenanceStatus: null,
        lane: "normal",
        evidencePath: relativePath,
        updatedAt: null,
        weight: 8,
        priority: 60,
        details: {},
      });
      addEdge(result, { fromId: node.id, toId: rootId, type: "in_root", evidencePath: relativePath, status: null, lane: "normal", updatedAt: null, details: {} });
    }
    const folder = path.posix.dirname(itemPath);
    if (folder && folder !== ".") {
      const folderId = taxonomyNodeId("folder", folder);
      addNode(result, { id: folderId, type: "folder", label: folder, path: folder, status: "active", lifecycleState: null, provenanceStatus: null, lane: "normal", evidencePath: relativePath, updatedAt: null, weight: 6, priority: 55, details: {} });
      addEdge(result, { fromId: node.id, toId: folderId, type: "in_folder", evidencePath: relativePath, status: null, lane: "normal", updatedAt: null, details: {} });
    }
    const kind = firstString(item.kind);
    if (kind) {
      const kindId = taxonomyNodeId("kind", kind);
      addNode(result, { id: kindId, type: "kind", label: kind, path: null, status: "active", lifecycleState: null, provenanceStatus: null, lane: "normal", evidencePath: relativePath, updatedAt: null, weight: 5, priority: 50, details: {} });
      addEdge(result, { fromId: node.id, toId: kindId, type: "has_kind", evidencePath: relativePath, status: null, lane: "normal", updatedAt: null, details: {} });
    }
    for (const tag of stringArray(item.tags).slice(0, 24)) {
      const tagId = taxonomyNodeId("tag", tag);
      addNode(result, { id: tagId, type: "tag", label: tag, path: null, status: "active", lifecycleState: null, provenanceStatus: null, lane: "normal", evidencePath: relativePath, updatedAt: null, weight: 3, priority: 45, details: {} });
      addEdge(result, { fromId: node.id, toId: tagId, type: "has_tag", evidencePath: relativePath, status: null, lane: "normal", updatedAt: null, details: {} });
    }
    for (const link of stringArray(item.links).slice(0, 32)) {
      addReferenceEdge(result, node.id, link, "wiki_link", relativePath, "wiki_record");
    }
  }
  return result;
}

function contributionsFromRecord(relativePath: string, record: JsonObject, sourcePaths: Set<string>): Contributions {
  if (relativePath === ".dino/index/wiki-index.json") return contributionsFromWikiIndex(relativePath, record);
  const result = newContributions();
  const node = addFileNode(result, relativePath, record);
  addLifecycleEdges(result, node, record);

  if (node.type === "source_chunk" || node.type === "provenance" || node.type === "lineage_generation") {
    const chunkPath = node.type === "source_chunk" ? relativePath : normalizeVaultPath(record.source_chunk_path);
    const chunkId = chunkPath ? ensureReferenceNode(result, chunkPath, relativePath, "source_chunk") : node.id;
    const sourceRef = firstString(record.source_snapshot_path, record.source_uri);
    const sourceId = ensureReferenceNode(result, sourceRef, relativePath, "source_snapshot");
    if (sourceId && chunkId) {
      addEdge(result, { fromId: sourceId, toId: chunkId, type: "source_to_chunk", evidencePath: relativePath, status: statusValue(record), lane: "normal", updatedAt: node.updatedAt, details: {} });
    }
    const claimRefs = [
      ...stringArray(record.claim_paths),
      ...objectArray(record.claim_bindings).map((binding) => firstString(binding.path)).filter((value): value is string => !!value),
    ];
    if (chunkId) {
      for (const claimPath of [...new Set(claimRefs)]) addReferenceEdge(result, chunkId, claimPath, "chunk_to_claim", relativePath, "claim");
      for (const evidencePath of stringArray(record.evidence_paths)) addReferenceEdge(result, chunkId, evidencePath, "supported_by", relativePath);
    }
  }

  if (node.type === "candidate" || node.type === "correction") {
    const candidateId = firstString(record.candidate_id, record.feedback_id);
    const reviewRefs = [firstString(record.review_path), candidateId ? `80_Review_Queue/promotion/${candidateId}.json` : null]
      .filter((value): value is string => !!value)
      .map((value) => normalizeVaultPath(value))
      .filter((value): value is string => !!value && sourcePaths.has(value));
    for (const reviewPath of [...new Set(reviewRefs)]) addReferenceEdge(result, node.id, reviewPath, "candidate_to_review", relativePath, "review");
    const evidence = isObject(record.evidence) ? record.evidence : {};
    for (const reference of [evidence.source, ...stringArray(record.provenance_paths)]) {
      const sourceId = ensureReferenceNode(result, reference, relativePath, "provenance");
      if (sourceId) addEdge(result, { fromId: node.id, toId: sourceId, type: "grounded_by", evidencePath: relativePath, status: node.status, lane: node.lane, updatedAt: node.updatedAt, details: {} });
    }
    if (node.type === "correction" && candidateId) {
      const acceptedPath = `50_Instances/accepted/${candidateId}.json`;
      const successors = new Set(stringArray(record.successor_paths).map((entry) => normalizeVaultPath(entry)).filter((entry): entry is string => !!entry));
      if (sourcePaths.has(acceptedPath) || successors.has(acceptedPath)) addReferenceEdge(result, node.id, acceptedPath, "correction_to_rule", relativePath, "behavior_rule");
    }
  }

  if (node.type === "review") {
    const candidatePath = normalizeVaultPath(firstString(record.candidate_path, record.source_candidate_path));
    if (candidatePath) {
      const candidateId = ensureReferenceNode(result, candidatePath, relativePath, "candidate");
      if (candidateId) addEdge(result, { fromId: candidateId, toId: node.id, type: "candidate_to_review", evidencePath: relativePath, status: node.status, lane: node.lane, updatedAt: node.updatedAt, details: {} });
    }
  }

  if (node.type === "memory" || node.type === "behavior_rule") {
    const candidatePath = normalizeVaultPath(record.source_candidate_path);
    const reviewPath = normalizeVaultPath(record.source_review_path);
    if (candidatePath) {
      const relation = node.type === "behavior_rule" || statusToken(firstString(record.type)) === "feedback_correction"
        ? "correction_to_rule"
        : "candidate_promoted_to_memory";
      const candidateId = ensureReferenceNode(result, candidatePath, relativePath, relation === "correction_to_rule" ? "correction" : "candidate");
      if (candidateId) addEdge(result, { fromId: candidateId, toId: node.id, type: relation, evidencePath: relativePath, status: node.status, lane: node.lane, updatedAt: node.updatedAt, details: {} });
    }
    if (reviewPath) {
      const reviewId = ensureReferenceNode(result, reviewPath, relativePath, "review");
      if (reviewId) addEdge(result, { fromId: reviewId, toId: node.id, type: "review_approved_memory", evidencePath: relativePath, status: node.status, lane: node.lane, updatedAt: node.updatedAt, details: {} });
    }
    const evidence = isObject(record.evidence) ? record.evidence : {};
    for (const reference of [evidence.source, ...stringArray(record.evidence_paths), ...stringArray(record.provenance_paths)]) {
      const sourceId = ensureReferenceNode(result, reference, relativePath, "evidence");
      if (sourceId) addEdge(result, { fromId: node.id, toId: sourceId, type: "grounded_by", evidencePath: relativePath, status: node.status, lane: node.lane, updatedAt: node.updatedAt, details: {} });
    }
  }

  if (node.type === "task") {
    addReferenceEdge(result, node.id, record.gate_report_path, "task_gate", relativePath, "gate");
  }

  if (node.type === "context_pack") {
    const taskIdValue = firstString(record.task_id);
    const taskPath = taskIdValue ? `.dino/tasks/${taskIdValue}.json` : null;
    const taskId = ensureReferenceNode(result, taskPath, relativePath, "task");
    if (taskId) addEdge(result, { fromId: taskId, toId: node.id, type: "context_provided", evidencePath: relativePath, status: node.status, lane: node.lane, updatedAt: node.updatedAt, details: {} });
    for (const item of objectArray(record.items)) {
      const memoryPath = normalizeVaultPath(item.path);
      if (!memoryPath) continue;
      const memoryId = ensureReferenceNode(result, memoryPath, relativePath, "memory");
      if (!memoryId) continue;
      addEdge(result, { fromId: node.id, toId: memoryId, type: "pack_contains", evidencePath: relativePath, status: null, lane: "normal", updatedAt: node.updatedAt, details: { score: typeof item.score === "number" ? item.score : null } });
      if (taskId) addEdge(result, { fromId: taskId, toId: memoryId, type: "context_provided", evidencePath: relativePath, status: null, lane: "normal", updatedAt: node.updatedAt, details: { pack_path: relativePath } });
    }
  }

  if (node.type === "trace") {
    const taskIdValue = firstString(record.task_id);
    const taskPath = taskIdValue ? `.dino/tasks/${taskIdValue}.json` : null;
    const taskId = ensureReferenceNode(result, taskPath, relativePath, "task");
    if (taskId) addEdge(result, { fromId: taskId, toId: node.id, type: "task_to_trace", evidencePath: relativePath, status: node.status, lane: node.lane, updatedAt: node.updatedAt, details: {} });
    for (const packPath of stringArray(record.context_pack_paths)) addReferenceEdge(result, node.id, packPath, "trace_to_context", relativePath, "context_pack");
    for (const memoryPath of stringArray(record.used_memory_paths)) addReferenceEdge(result, node.id, memoryPath, "memory_declared_used", relativePath, "memory");
    for (const candidatePath of stringArray(record.candidate_paths)) addReferenceEdge(result, node.id, candidatePath, "trace_produced_candidate", relativePath, "candidate");
  }

  if (node.type === "memory_audit" || (node.type === "audit" && Array.isArray(record.observed_used_memory_paths))) {
    const taskIdValue = firstString(record.task_id);
    const taskPath = taskIdValue ? `.dino/tasks/${taskIdValue}.json` : null;
    const taskId = ensureReferenceNode(result, taskPath, relativePath, "task");
    if (taskId) addEdge(result, { fromId: taskId, toId: node.id, type: "task_to_audit", evidencePath: relativePath, status: node.status, lane: node.lane, updatedAt: node.updatedAt, details: {} });
    for (const memoryPath of stringArray(record.declared_used_memory_paths)) addReferenceEdge(result, node.id, memoryPath, "memory_declared_used", relativePath, "memory");
    for (const memoryPath of stringArray(record.observed_used_memory_paths)) addReferenceEdge(result, node.id, memoryPath, "memory_observed_used", relativePath, "memory");
  }

  if (node.type === "status") {
    for (const finding of objectArray(record.findings).slice(0, 120)) {
      const target = firstString(finding.path, finding.target_path, finding.artifact_path, finding.source_path);
      if (target) addReferenceEdge(result, node.id, target, "status_reports_on", relativePath);
    }
  }

  return result;
}

function contributionsFromEventLog(relativePath: string, text: string): Contributions {
  const result = newContributions();
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line) continue;
    let event: JsonObject;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (!isObject(parsed)) throw new Error("event_not_object");
      event = parsed;
    } catch {
      result.parseErrors.push(`${relativePath}#${index + 1}`);
      continue;
    }
    const autoSync = isObject(event.auto_sync) ? event.auto_sync : event;
    const commit = firstString(autoSync.commit, autoSync.commit_sha);
    if (!commit || autoSync.committed !== true) continue;
    const evidencePath = `${relativePath}#${index + 1}`;
    const taskIdValue = firstString(event.task_id, autoSync.task_id) ?? "unknown-task";
    const syncId = recordNodeId("sync", `${taskIdValue}:${commit}:${evidencePath}`);
    const commitId = `commit:${commit}`;
    const pushed = autoSync.pushed === true;
    const lane: EvidenceLane = pushed ? "normal" : "main_pending";
    addNode(result, { id: syncId, type: "sync", label: `Sync ${commit.slice(0, 8)}`, path: relativePath, status: pushed ? "pushed" : "committed", lifecycleState: null, provenanceStatus: "event_verified", lane, evidencePath, updatedAt: firstString(event.at), weight: 6, priority: 110, details: { commit } });
    addNode(result, { id: commitId, type: "commit", label: commit.slice(0, 12), path: null, status: pushed ? "pushed" : "local", lifecycleState: null, provenanceStatus: "git_commit", lane, evidencePath, updatedAt: firstString(event.at), weight: 7, priority: 115, details: { commit } });
    addLane(result, result.nodes.get(syncId)!);
    addLane(result, result.nodes.get(commitId)!);
    const taskPath = `.dino/tasks/${taskIdValue}.json`;
    const taskId = ensureReferenceNode(result, taskPath, evidencePath, "task");
    if (taskId) addEdge(result, { fromId: taskId, toId: syncId, type: "task_to_sync", evidencePath, status: null, lane, updatedAt: firstString(event.at), details: {} });
    addEdge(result, { fromId: syncId, toId: commitId, type: "sync_to_commit", evidencePath, status: pushed ? "pushed" : "committed", lane, updatedAt: firstString(event.at), details: {} });
    for (const allowedPath of stringArray(autoSync.allowed_paths).slice(0, 120)) addReferenceEdge(result, syncId, allowedPath, "sync_included", evidencePath);
  }
  return result;
}

function mergeContributions(target: Contributions, source: Contributions): void {
  for (const node of source.nodes.values()) addNode(target, node);
  for (const edge of source.edges.values()) {
    const existing = target.edges.get(edge.id);
    if (!existing || edge.priority > existing.priority) target.edges.set(edge.id, edge);
  }
  target.parseErrors.push(...source.parseErrors);
}

async function parseSource(descriptor: SourceDescriptor, sourcePaths: Set<string>): Promise<Contributions> {
  const text = await fs.readFile(descriptor.absolutePath, "utf8");
  if (descriptor.format === "jsonl") return contributionsFromEventLog(descriptor.relativePath, text);
  const parsed = JSON.parse(text) as unknown;
  if (!isObject(parsed)) throw new Error("record_not_object");
  return contributionsFromRecord(descriptor.relativePath, parsed, sourcePaths);
}

async function walkFiles(
  dataRoot: string,
  relativeRoot: string,
  extensions: Set<string>,
  recursive = true,
): Promise<SourceDescriptor[]> {
  const absoluteRoot = path.join(dataRoot, ...relativeRoot.split("/"));
  const result: SourceDescriptor[] = [];
  const stack = [absoluteRoot];
  while (stack.length > 0) {
    const current = stack.pop()!;
    let entries: Dirent[];
    try {
      entries = await fs.readdir(current, { withFileTypes: true, encoding: "utf8" });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    for (const entry of entries) {
      const absolutePath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (recursive) stack.push(absolutePath);
        continue;
      }
      const extension = path.extname(entry.name).toLowerCase();
      if (!extensions.has(extension)) continue;
      if (relativeRoot === ".dino/state" && STATE_EXCLUSIONS.has(entry.name)) continue;
      const stat = await fs.stat(absolutePath);
      const relativePath = path.relative(dataRoot, absolutePath).split(path.sep).join("/");
      result.push({
        relativePath,
        absolutePath,
        format: extension === ".jsonl" ? "jsonl" : "json",
        kind: relativeRoot,
        sizeBytes: stat.size,
        mtimeMs: stat.mtimeMs,
      });
    }
  }
  return result;
}

async function collectSources(dataRoot: string): Promise<SourceDescriptor[]> {
  const groups = await Promise.all([
    walkFiles(dataRoot, ".dino/index", new Set([".json"]), false),
    walkFiles(dataRoot, "30_Sources/chunks", new Set([".json"])),
    walkFiles(dataRoot, "30_Sources/fetched", new Set([".json"])),
    walkFiles(dataRoot, ".dino/provenance", new Set([".json"])),
    walkFiles(dataRoot, "50_Instances/candidates", new Set([".json"])),
    walkFiles(dataRoot, "50_Instances/accepted", new Set([".json"])),
    walkFiles(dataRoot, "80_Review_Queue", new Set([".json"])),
    walkFiles(dataRoot, ".dino/tasks", new Set([".json"]), false),
    walkFiles(dataRoot, ".dino/context-packs", new Set([".json"]), false),
    walkFiles(dataRoot, ".dino/traces", new Set([".json"]), false),
    walkFiles(dataRoot, ".dino/gates", new Set([".json"]), false),
    walkFiles(dataRoot, ".dino/audits", new Set([".json"])),
    walkFiles(dataRoot, ".dino/events", new Set([".jsonl"]), false),
    walkFiles(dataRoot, ".dino/state", new Set([".json", ".jsonl"]), false),
  ]);
  const deduped = new Map<string, SourceDescriptor>();
  for (const descriptor of groups.flat()) deduped.set(descriptor.relativePath, descriptor);
  return [...deduped.values()].sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

function openReadableDatabase(filePath: string): DatabaseSync | null {
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(filePath, { readOnly: true, timeout: 5_000 });
    db.exec("PRAGMA busy_timeout = 5000;");
    const version = db.prepare("SELECT value FROM metadata WHERE key = 'version'").get() as { value?: string } | undefined;
    if (version?.value !== EVIDENCE_GRAPH_VERSION) {
      db.close();
      return null;
    }
    return db;
  } catch {
    try { db?.close(); } catch { /* corrupt handles are best-effort closed */ }
    return null;
  }
}

function createWritableDatabase(filePath: string): DatabaseSync {
  const db = new DatabaseSync(filePath, { timeout: 5_000 });
  db.exec(`
    PRAGMA busy_timeout = 5000;
    PRAGMA journal_mode = DELETE;
    PRAGMA synchronous = FULL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE sources (
      path TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      format TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      mtime_ms REAL NOT NULL,
      sha256 TEXT NOT NULL,
      parse_status TEXT NOT NULL,
      contribution_count INTEGER NOT NULL
    );
    CREATE TABLE node_contributions (
      source_path TEXT NOT NULL,
      node_id TEXT NOT NULL,
      type TEXT NOT NULL,
      label TEXT NOT NULL,
      path TEXT,
      status TEXT,
      lifecycle_state TEXT,
      provenance_status TEXT,
      lane TEXT NOT NULL,
      evidence_path TEXT NOT NULL,
      updated_at TEXT,
      weight REAL NOT NULL,
      priority INTEGER NOT NULL,
      details_json TEXT NOT NULL,
      PRIMARY KEY (source_path, node_id)
    );
    CREATE TABLE edge_contributions (
      source_path TEXT NOT NULL,
      edge_id TEXT NOT NULL,
      from_id TEXT NOT NULL,
      to_id TEXT NOT NULL,
      type TEXT NOT NULL,
      evidence_path TEXT NOT NULL,
      status TEXT,
      lane TEXT NOT NULL,
      updated_at TEXT,
      priority INTEGER NOT NULL,
      details_json TEXT NOT NULL,
      PRIMARY KEY (source_path, edge_id)
    );
    CREATE TABLE nodes (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      label TEXT NOT NULL,
      path TEXT,
      status TEXT,
      lifecycle_state TEXT,
      provenance_status TEXT,
      lane TEXT NOT NULL,
      evidence_path TEXT NOT NULL,
      updated_at TEXT,
      weight REAL NOT NULL,
      priority INTEGER NOT NULL,
      details_json TEXT NOT NULL,
      source_count INTEGER NOT NULL
    );
    CREATE TABLE edges (
      id TEXT PRIMARY KEY,
      from_id TEXT NOT NULL,
      to_id TEXT NOT NULL,
      type TEXT NOT NULL,
      evidence_path TEXT NOT NULL,
      status TEXT,
      lane TEXT NOT NULL,
      updated_at TEXT,
      priority INTEGER NOT NULL,
      details_json TEXT NOT NULL,
      source_count INTEGER NOT NULL,
      FOREIGN KEY (from_id) REFERENCES nodes(id),
      FOREIGN KEY (to_id) REFERENCES nodes(id)
    );
    CREATE INDEX idx_nodes_type_priority ON nodes(type, priority DESC, updated_at DESC, id);
    CREATE INDEX idx_nodes_lane_priority ON nodes(lane, priority DESC, updated_at DESC, id);
    CREATE INDEX idx_nodes_path ON nodes(path);
    CREATE INDEX idx_edges_type_priority ON edges(type, priority DESC, updated_at DESC, id);
    CREATE INDEX idx_edges_from ON edges(from_id, priority DESC);
    CREATE INDEX idx_edges_to ON edges(to_id, priority DESC);
  `);
  return db;
}

function writeMetadata(db: DatabaseSync, values: Record<string, string | number>): void {
  const statement = db.prepare("INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)");
  for (const [key, value] of Object.entries(values)) statement.run(key, String(value));
}

function insertSystemLanes(db: DatabaseSync): void {
  const insertSource = db.prepare("INSERT INTO sources (path, kind, format, size_bytes, mtime_ms, sha256, parse_status, contribution_count) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
  const insertNode = db.prepare(`INSERT INTO node_contributions
    (source_path, node_id, type, label, path, status, lifecycle_state, provenance_status, lane, evidence_path, updated_at, weight, priority, details_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  insertSource.run("@system/lanes", "system", "virtual", 0, 0, sha256Text(EVIDENCE_GRAPH_LANES.join("|")), "ok", EVIDENCE_GRAPH_LANES.length);
  for (const lane of EVIDENCE_GRAPH_LANES) {
    insertNode.run("@system/lanes", `lane:${lane}`, "lane", lane.replaceAll("_", " "), null, "active", null, null, lane, "@system/lanes", null, 10, 140, JSON.stringify({ lane }));
  }
}

function insertContributions(db: DatabaseSync, sourcePath: string, contributions: Contributions): void {
  const insertNode = db.prepare(`INSERT INTO node_contributions
    (source_path, node_id, type, label, path, status, lifecycle_state, provenance_status, lane, evidence_path, updated_at, weight, priority, details_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const insertEdge = db.prepare(`INSERT INTO edge_contributions
    (source_path, edge_id, from_id, to_id, type, evidence_path, status, lane, updated_at, priority, details_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const node of contributions.nodes.values()) {
    insertNode.run(sourcePath, node.id, node.type, node.label, node.path, node.status, node.lifecycleState, node.provenanceStatus, node.lane, node.evidencePath, node.updatedAt, node.weight, node.priority, JSON.stringify(node.details));
  }
  for (const edge of contributions.edges.values()) {
    insertEdge.run(sourcePath, edge.id, edge.fromId, edge.toId, edge.type, edge.evidencePath, edge.status, edge.lane, edge.updatedAt, edge.priority, JSON.stringify(edge.details));
  }
}

function materializeGraph(db: DatabaseSync): void {
  db.exec(`
    INSERT INTO nodes
      (id, type, label, path, status, lifecycle_state, provenance_status, lane, evidence_path, updated_at, weight, priority, details_json, source_count)
    SELECT node_id, type, label, path, status, lifecycle_state, provenance_status, lane, evidence_path, updated_at,
           weight, priority, details_json, source_count
    FROM (
      SELECT *,
        ROW_NUMBER() OVER (PARTITION BY node_id ORDER BY priority DESC, source_path ASC) AS row_number,
        COUNT(*) OVER (PARTITION BY node_id) AS source_count
      FROM node_contributions
    ) ranked
    WHERE row_number = 1;

    INSERT INTO edges
      (id, from_id, to_id, type, evidence_path, status, lane, updated_at, priority, details_json, source_count)
    SELECT edge_id, from_id, to_id, type, evidence_path, status, lane, updated_at,
           priority, details_json, source_count
    FROM (
      SELECT *,
        ROW_NUMBER() OVER (PARTITION BY edge_id ORDER BY priority DESC, source_path ASC) AS row_number,
        COUNT(*) OVER (PARTITION BY edge_id) AS source_count
      FROM edge_contributions
    ) ranked
    WHERE row_number = 1;
  `);
}

function groupedCounts(db: DatabaseSync, table: "nodes" | "edges", column: string): Record<string, number> {
  return Object.fromEntries(
    (db.prepare(`SELECT ${column} AS key, COUNT(*) AS count FROM ${table} GROUP BY ${column} ORDER BY ${column}`).all() as Array<{ key: string; count: number }>)
      .map((row) => [String(row.key), Number(row.count)]),
  );
}

async function expectedWikiRecordCount(dataRoot: string): Promise<number | null> {
  try {
    const index = JSON.parse(await fs.readFile(path.join(dataRoot, ".dino", "index", "wiki-index.json"), "utf8")) as JsonObject;
    return Number(index.record_count ?? objectArray(index.records).length);
  } catch {
    const wikiPath = path.join(dataRoot, ".dino", "index", "sqlite", "wiki.sqlite");
    try {
      const db = new DatabaseSync(wikiPath, { readOnly: true, timeout: 5_000 });
      try {
        const row = db.prepare("SELECT value FROM metadata WHERE key = 'record_count'").get() as { value?: string } | undefined;
        return Number(row?.value ?? db.prepare("SELECT COUNT(*) AS count FROM records").get()?.count ?? 0);
      } finally {
        db.close();
      }
    } catch {
      return null;
    }
  }
}

async function expectedOperationCounts(dataRoot: string): Promise<Record<string, number> | null> {
  try {
    const index = JSON.parse(await fs.readFile(path.join(dataRoot, ".dino", "index", "operations-index.json"), "utf8")) as JsonObject;
    const counts = isObject(index.counts) ? index.counts : {};
    return {
      task: Number(counts.tasks ?? 0),
      trace: Number(counts.traces ?? 0),
      context_pack: Number(counts.context_packs ?? 0),
    };
  } catch {
    return null;
  }
}

async function parityChecks(dataRoot: string, db: DatabaseSync, sources: SourceDescriptor[]): Promise<EvidenceGraphStatus["parity"]["checks"]> {
  const byType = groupedCounts(db, "nodes", "type");
  const checks: EvidenceGraphStatus["parity"]["checks"] = [];
  const add = (id: string, expected: number, actual: number): void => {
    checks.push({ id, expected, actual, status: expected === actual ? "pass" : "fail" });
  };
  const sourceCount = (prefix: string): number => sources.filter((source) => source.relativePath.startsWith(prefix)).length;
  const primaryContributionCount = (prefix: string): number => Number(
    (db.prepare("SELECT COUNT(*) AS count FROM node_contributions WHERE source_path LIKE ? AND path = source_path")
      .get(`${prefix}%`) as { count?: number }).count ?? 0,
  );
  add("candidate_files", sourceCount("50_Instances/candidates/"), primaryContributionCount("50_Instances/candidates/"));
  add("review_files", sourceCount("80_Review_Queue/"), primaryContributionCount("80_Review_Queue/"));
  add("accepted_files", sourceCount("50_Instances/accepted/"), primaryContributionCount("50_Instances/accepted/"));
  add("source_chunk_files", sourceCount("30_Sources/chunks/"), primaryContributionCount("30_Sources/chunks/"));
  const wikiExpected = await expectedWikiRecordCount(dataRoot);
  if (wikiExpected !== null) {
    const wikiActual = Number((db.prepare("SELECT COUNT(DISTINCT node_id) AS count FROM node_contributions WHERE source_path = '.dino/index/wiki-index.json' AND node_id LIKE 'path:%' AND priority >= 80").get() as { count?: number }).count ?? 0);
    add("wiki_index_records", wikiExpected, wikiActual);
  }
  const operationExpected = await expectedOperationCounts(dataRoot);
  if (operationExpected) {
    add("operations_tasks", operationExpected.task, primaryContributionCount(".dino/tasks/"));
    add("operations_traces", operationExpected.trace, primaryContributionCount(".dino/traces/"));
    add("operations_context_packs", operationExpected.context_pack, primaryContributionCount(".dino/context-packs/"));
  }
  return checks;
}

async function removeSqliteSidecars(basePath: string): Promise<void> {
  await Promise.all([basePath, `${basePath}-shm`, `${basePath}-wal`, `${basePath}-journal`].map((target) => fs.rm(target, { force: true }).catch(() => undefined)));
}

async function replaceSqlite(tempPath: string, targetPath: string): Promise<void> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 12; attempt += 1) {
    try {
      await fs.rename(tempPath, targetPath);
      await removeSqliteSidecars(tempPath);
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(`Could not replace ${targetPath}`);
}

function validateGraphDatabase(filePath: string): void {
  const db = new DatabaseSync(filePath, { readOnly: true, timeout: 5_000 });
  try {
    const quick = db.prepare("PRAGMA quick_check").get() as { quick_check?: string } | undefined;
    const integrity = db.prepare("PRAGMA integrity_check").get() as { integrity_check?: string } | undefined;
    const foreign = db.prepare("PRAGMA foreign_key_check").all();
    if (quick?.quick_check !== "ok" || integrity?.integrity_check !== "ok" || foreign.length > 0) {
      throw new Error("evidence_graph_sqlite_integrity_failed");
    }
    for (const table of ["sources", "nodes", "edges", "node_contributions", "edge_contributions"]) {
      const row = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
      if (!row) throw new Error(`evidence_graph_table_missing:${table}`);
    }
  } finally {
    db.close();
  }
}

export async function buildAndWriteEvidenceGraph(dataRoot: string): Promise<{
  status: EvidenceGraphStatus;
  statusPath: string;
  indexPath: string;
}> {
  const resolvedRoot = path.resolve(dataRoot);
  const indexPath = path.join(resolvedRoot, ...EVIDENCE_GRAPH_SQLITE_RELATIVE_PATH.split("/"));
  const statusPath = path.join(resolvedRoot, ...EVIDENCE_GRAPH_STATUS_RELATIVE_PATH.split("/"));
  const lockPath = path.join(resolvedRoot, ".dino", "locks", "evidence-graph.lock");
  return await withFileLock(lockPath, async () => {
    const generatedAt = new Date().toISOString();
    const rssBefore = process.memoryUsage().rss;
    const sources = await collectSources(resolvedRoot);
    const sourcePaths = new Set(sources.map((source) => source.relativePath));
    await fs.mkdir(path.dirname(indexPath), { recursive: true });
    let previous = openReadableDatabase(indexPath);
    let previousSourceRows: Array<{ path: string; sha256: string; size_bytes: number; mtime_ms: number }> = [];
    if (previous) {
      try {
        validateGraphDatabase(indexPath);
        previousSourceRows = previous.prepare("SELECT path, sha256, size_bytes, mtime_ms FROM sources WHERE path <> '@system/lanes'").all() as Array<{ path: string; sha256: string; size_bytes: number; mtime_ms: number }>;
      } catch {
        previous.close();
        previous = null;
        previousSourceRows = [];
      }
    }
    const previousSourceCount = previousSourceRows.length;
    const previousSourcePaths = previousSourceRows.map((row) => row.path);
    const previousSourceByPath = new Map(previousSourceRows.map((row) => [row.path, row]));
    const previousIndexAvailable = Boolean(previous);
    previous?.close();
    const tempPath = `${indexPath}.${process.pid}.${randomUUID()}.tmp`;
    await removeSqliteSidecars(tempPath);
    const db = createWritableDatabase(tempPath);
    let reusedSources = 0;
    let rebuiltSources = 0;
    let metadataReusedSources = 0;
    let hashVerifiedSources = 0;
    let parseErrors = 0;
    const parseErrorPaths: string[] = [];
    try {
      writeMetadata(db, { version: EVIDENCE_GRAPH_VERSION, generated_at: generatedAt, build_status: "building" });
      if (previousIndexAvailable) {
        db.prepare("ATTACH DATABASE ? AS previous_graph").run(indexPath);
        db.exec(`
          BEGIN IMMEDIATE;
          INSERT INTO sources SELECT * FROM previous_graph.sources;
          INSERT INTO node_contributions SELECT * FROM previous_graph.node_contributions;
          INSERT INTO edge_contributions SELECT * FROM previous_graph.edge_contributions;
          COMMIT;
          DETACH DATABASE previous_graph;
        `);
      }
      db.exec("BEGIN IMMEDIATE");
      db.prepare("DELETE FROM node_contributions WHERE source_path = ?").run("@system/lanes");
      db.prepare("DELETE FROM edge_contributions WHERE source_path = ?").run("@system/lanes");
      db.prepare("DELETE FROM sources WHERE path = ?").run("@system/lanes");
      insertSystemLanes(db);
      const insertSource = db.prepare("INSERT INTO sources (path, kind, format, size_bytes, mtime_ms, sha256, parse_status, contribution_count) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
      const deleteNodeContributions = db.prepare("DELETE FROM node_contributions WHERE source_path = ?");
      const deleteEdgeContributions = db.prepare("DELETE FROM edge_contributions WHERE source_path = ?");
      const deleteSource = db.prepare("DELETE FROM sources WHERE path = ?");
      for (const previousPath of previousSourcePaths) {
        if (sourcePaths.has(previousPath)) continue;
        deleteNodeContributions.run(previousPath);
        deleteEdgeContributions.run(previousPath);
        deleteSource.run(previousPath);
      }
      const verifyAllHashes = process.env.DINOBRAIN_EVIDENCE_GRAPH_VERIFY_HASHES === "1";
      for (const source of sources) {
        const previousRow = previousSourceByPath.get(source.relativePath);
        const metadataMatches = previousRow && Number(previousRow.size_bytes) === source.sizeBytes && Number(previousRow.mtime_ms) === source.mtimeMs;
        if (metadataMatches && !verifyAllHashes) {
          reusedSources += 1;
          metadataReusedSources += 1;
          continue;
        }
        const sourceSha = await sha256File(source.absolutePath);
        hashVerifiedSources += 1;
        if (previousRow?.sha256 === sourceSha) {
          db.prepare("UPDATE sources SET size_bytes = ?, mtime_ms = ?, sha256 = ? WHERE path = ?")
            .run(source.sizeBytes, source.mtimeMs, sourceSha, source.relativePath);
          reusedSources += 1;
          continue;
        }
        rebuiltSources += 1;
        deleteNodeContributions.run(source.relativePath);
        deleteEdgeContributions.run(source.relativePath);
        deleteSource.run(source.relativePath);
        let contributions = newContributions();
        let parseStatus = "ok";
        try {
          contributions = await parseSource(source, sourcePaths);
          if (contributions.parseErrors.length > 0) parseStatus = "partial_parse_error";
        } catch {
          parseStatus = "parse_error";
          contributions.parseErrors.push(source.relativePath);
          const errorRecord: JsonObject = { status: "parse_error", title: `Unparseable evidence: ${labelFromPath(source.relativePath)}` };
          addFileNode(contributions, source.relativePath, errorRecord, 130);
        }
        parseErrors += contributions.parseErrors.length;
        parseErrorPaths.push(...contributions.parseErrors.slice(0, 20));
        insertSource.run(source.relativePath, source.kind, source.format, source.sizeBytes, source.mtimeMs, sourceSha, parseStatus, contributions.nodes.size + contributions.edges.size);
        insertContributions(db, source.relativePath, contributions);
      }
      materializeGraph(db);
      db.exec("COMMIT");
      const nodeCount = Number((db.prepare("SELECT COUNT(*) AS count FROM nodes").get() as { count?: number }).count ?? 0);
      const edgeCount = Number((db.prepare("SELECT COUNT(*) AS count FROM edges").get() as { count?: number }).count ?? 0);
      writeMetadata(db, {
        build_status: "complete",
        source_count: sources.length,
        node_count: nodeCount,
        edge_count: edgeCount,
        reused_sources: reusedSources,
        rebuilt_sources: rebuiltSources,
        parse_errors: parseErrors,
      });
      db.exec("PRAGMA optimize;");
    } catch (error) {
      try { db.exec("ROLLBACK"); } catch { /* no active transaction */ }
      throw error;
    } finally {
      db.close();
    }
    validateGraphDatabase(tempPath);
    await replaceSqlite(tempPath, indexPath);
    validateGraphDatabase(indexPath);

    const readDb = openReadableDatabase(indexPath);
    if (!readDb) throw new Error("evidence_graph_reopen_failed");
    let byType: Record<string, number>;
    let byLane: Record<string, number>;
    let byEdgeType: Record<string, number>;
    let nodeCount: number;
    let edgeCount: number;
    let parity: EvidenceGraphStatus["parity"]["checks"];
    try {
      byType = groupedCounts(readDb, "nodes", "type");
      byLane = groupedCounts(readDb, "nodes", "lane");
      byEdgeType = groupedCounts(readDb, "edges", "type");
      nodeCount = Number((readDb.prepare("SELECT COUNT(*) AS count FROM nodes").get() as { count?: number }).count ?? 0);
      edgeCount = Number((readDb.prepare("SELECT COUNT(*) AS count FROM edges").get() as { count?: number }).count ?? 0);
      parity = await parityChecks(resolvedRoot, readDb, sources);
    } finally {
      readDb.close();
    }
    const indexSha256 = await sha256File(indexPath);
    const parityFailures = parity.filter((check) => check.status === "fail");
    const blockers = [
      ...parseErrorPaths.map((entry) => `parse_error:${entry}`),
      ...parityFailures.map((check) => `count_parity_failed:${check.id}:${check.expected}:${check.actual}`),
    ];
    const observed = EVIDENCE_GRAPH_REQUIRED_EDGE_TYPES.filter((type) => Number(byEdgeType[type] ?? 0) > 0);
    const typedEdges = Object.entries(byEdgeType).filter(([type]) => !GENERIC_EDGE_TYPES.has(type)).reduce((sum, [, count]) => sum + count, 0);
    const rssAfter = process.memoryUsage().rss;
    const status: EvidenceGraphStatus = {
      version: EVIDENCE_GRAPH_VERSION,
      status: blockers.length === 0 ? "healthy" : "needs_attention",
      generated_at: generatedAt,
      index_path: EVIDENCE_GRAPH_SQLITE_RELATIVE_PATH,
      index_sha256: indexSha256,
      counts: {
        sources: sources.length,
        nodes: nodeCount,
        edges: edgeCount,
        typed_edges: typedEdges,
        parse_errors: parseErrors,
        by_type: byType,
        by_lane: byLane,
        by_edge_type: byEdgeType,
      },
      incremental: {
        reused_sources: reusedSources,
        rebuilt_sources: rebuiltSources,
        removed_sources: previousSourcePaths.filter((sourcePath) => !sourcePaths.has(sourcePath)).length,
        reuse_ratio: sources.length === 0 ? 1 : Number((reusedSources / sources.length).toFixed(6)),
        previous_index_available: previousSourceCount > 0,
        fingerprint_mode: process.env.DINOBRAIN_EVIDENCE_GRAPH_VERIFY_HASHES === "1" ? "full_sha256_v1" : "metadata_incremental_v1",
        metadata_reused_sources: metadataReusedSources,
        hash_verified_sources: hashVerifiedSources,
      },
      relation_contract: {
        supported: [...EVIDENCE_GRAPH_REQUIRED_EDGE_TYPES],
        observed,
        unobserved: EVIDENCE_GRAPH_REQUIRED_EDGE_TYPES.filter((type) => !observed.includes(type)),
      },
      parity: {
        status: parityFailures.length === 0 ? "healthy" : "needs_attention",
        checks: parity,
      },
      memory: {
        rss_before_bytes: rssBefore,
        rss_after_bytes: rssAfter,
        rss_delta_bytes: Math.max(0, rssAfter - rssBefore),
      },
      blockers,
      warnings: [],
    };
    await atomicWriteJson(statusPath, status);
    return { status, statusPath, indexPath };
  }, { timeoutMs: 120_000, staleMs: 15 * 60_000 });
}

function parseDetails(value: string): JsonObject {
  try {
    const parsed = JSON.parse(value) as unknown;
    return isObject(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function projectNode(row: GraphNodeRow): JsonObject {
  return {
    id: row.id,
    type: row.type,
    label: row.label,
    path: row.path,
    status: row.status,
    lifecycle_state: row.lifecycle_state,
    provenance_status: row.provenance_status,
    lane: row.lane,
    evidence_path: row.evidence_path,
    updated_at: row.updated_at,
    count: Math.max(1, Number(row.weight ?? 1)),
    source_count: Number(row.source_count ?? 1),
    details: parseDetails(row.details_json),
  };
}

function projectEdge(row: GraphEdgeRow): JsonObject {
  return {
    id: row.id,
    source: row.from_id,
    target: row.to_id,
    type: row.type,
    evidence_path: row.evidence_path,
    status: row.status,
    lane: row.lane,
    updated_at: row.updated_at,
    source_count: Number(row.source_count ?? 1),
    details: parseDetails(row.details_json),
  };
}

function filterNode(row: GraphNodeRow, options: EvidenceGraphWindowOptions): boolean {
  if (options.lane && options.lane !== "all" && row.lane !== options.lane && row.id !== `lane:${options.lane}`) return false;
  if (options.lifecycleState && options.lifecycleState !== "all" && row.lifecycle_state !== options.lifecycleState) return false;
  if (options.provenanceStatus && options.provenanceStatus !== "all" && row.provenance_status !== options.provenanceStatus) return false;
  return true;
}

function metadataObject(db: DatabaseSync): Record<string, string> {
  return Object.fromEntries((db.prepare("SELECT key, value FROM metadata").all() as Array<{ key: string; value: string }>).map((row) => [row.key, row.value]));
}

export async function readEvidenceGraphWindow(dataRoot: string, options: EvidenceGraphWindowOptions = {}): Promise<JsonObject> {
  const indexPath = options.databasePath ?? path.join(path.resolve(dataRoot), ...EVIDENCE_GRAPH_SQLITE_RELATIVE_PATH.split("/"));
  const nodeLimit = Math.max(20, Math.min(800, options.nodeLimit ?? 340));
  const edgeLimit = Math.max(20, Math.min(1_200, options.edgeLimit ?? 400));
  const db = openReadableDatabase(indexPath);
  if (!db) {
    return { ok: false, index_mode: "evidence_graph_missing", generated_at: null, stats: { nodes: 0, edges: 0, shown_nodes: 0, shown_edges: 0 }, nodes: [], edges: [], filters: {} };
  }
  try {
    const metadata = metadataObject(db);
    const getNode = db.prepare("SELECT * FROM nodes WHERE id = ?");
    const nodeRows = new Map<string, GraphNodeRow>();
    const edgeRows = new Map<string, GraphEdgeRow>();
    const addNodeById = (id: string): GraphNodeRow | null => {
      const existing = nodeRows.get(id);
      if (existing) return existing;
      const row = getNode.get(id) as GraphNodeRow | undefined;
      if (!row || !filterNode(row, options)) return null;
      if (nodeRows.size >= nodeLimit) return null;
      nodeRows.set(id, row);
      return row;
    };
    for (const lane of EVIDENCE_GRAPH_LANES) addNodeById(`lane:${lane}`);

    if (options.focusId) {
      const focusDepth = Math.max(1, Math.min(5, options.focusDepth ?? 3));
      let frontier = [options.focusId];
      addNodeById(options.focusId);
      const adjacent = db.prepare("SELECT * FROM edges WHERE from_id = ? OR to_id = ? ORDER BY priority DESC, updated_at DESC, id LIMIT 120");
      for (let depth = 0; depth < focusDepth && frontier.length > 0 && edgeRows.size < edgeLimit; depth += 1) {
        const next = new Set<string>();
        for (const id of frontier) {
          for (const row of adjacent.all(id, id) as GraphEdgeRow[]) {
            if (options.edgeTypes?.length && !options.edgeTypes.includes(row.type)) continue;
            const from = addNodeById(row.from_id);
            const to = addNodeById(row.to_id);
            if (!from || !to) continue;
            edgeRows.set(row.id, row);
            if (!nodeRows.has(row.from_id)) next.add(row.from_id);
            if (!nodeRows.has(row.to_id)) next.add(row.to_id);
            if (edgeRows.size >= edgeLimit || nodeRows.size >= nodeLimit) break;
            next.add(row.from_id);
            next.add(row.to_id);
          }
          if (edgeRows.size >= edgeLimit || nodeRows.size >= nodeLimit) break;
        }
        frontier = [...next].filter((id) => id !== options.focusId);
      }
    } else {
      const typeWhere = options.edgeTypes?.length
        ? `WHERE type IN (${options.edgeTypes.map(() => "?").join(",")})`
        : "";
      const candidates = db.prepare(`SELECT * FROM edges ${typeWhere} ORDER BY priority DESC, updated_at DESC, id LIMIT ?`)
        .all(...(options.edgeTypes ?? []), edgeLimit * 12) as GraphEdgeRow[];
      for (const row of candidates) {
        const from = addNodeById(row.from_id);
        const to = addNodeById(row.to_id);
        if (!from || !to) continue;
        edgeRows.set(row.id, row);
        if (edgeRows.size >= edgeLimit || nodeRows.size >= nodeLimit) break;
      }
      const fill = db.prepare("SELECT * FROM nodes ORDER BY priority DESC, updated_at DESC, id LIMIT ?").all(nodeLimit * 6) as GraphNodeRow[];
      for (const row of fill) {
        if (nodeRows.size >= nodeLimit) break;
        if (filterNode(row, options)) nodeRows.set(row.id, row);
      }
    }

    const selectedIds = new Set(nodeRows.keys());
    const edges = [...edgeRows.values()].filter((edge) => selectedIds.has(edge.from_id) && selectedIds.has(edge.to_id));
    const byType = groupedCounts(db, "nodes", "type");
    const byLane = groupedCounts(db, "nodes", "lane");
    const byEdgeType = groupedCounts(db, "edges", "type");
    const lifecycleStates = (db.prepare("SELECT DISTINCT lifecycle_state AS value FROM nodes WHERE lifecycle_state IS NOT NULL ORDER BY lifecycle_state").all() as Array<{ value: string }>).map((row) => row.value);
    const provenanceStatuses = (db.prepare("SELECT DISTINCT provenance_status AS value FROM nodes WHERE provenance_status IS NOT NULL ORDER BY provenance_status").all() as Array<{ value: string }>).map((row) => row.value);
    return {
      ok: true,
      index_mode: EVIDENCE_GRAPH_VERSION,
      generated_at: metadata.generated_at ?? null,
      data_root: path.resolve(dataRoot),
      stats: {
        nodes: Number(metadata.node_count ?? 0),
        edges: Number(metadata.edge_count ?? 0),
        sources: Number(metadata.source_count ?? 0),
        shown_nodes: nodeRows.size,
        shown_edges: edges.length,
        truncated: Number(metadata.node_count ?? 0) > nodeRows.size || Number(metadata.edge_count ?? 0) > edges.length,
        by_type: byType,
        by_lane: byLane,
        by_edge_type: byEdgeType,
      },
      nodes: [...nodeRows.values()].map(projectNode),
      edges: edges.map(projectEdge),
      filters: {
        lanes: [...EVIDENCE_GRAPH_LANES],
        lifecycle_states: lifecycleStates,
        provenance_statuses: provenanceStatuses,
        edge_types: Object.keys(byEdgeType).sort(),
      },
      focus: options.focusId ? { node_id: options.focusId, depth: options.focusDepth ?? 3 } : null,
    };
  } finally {
    db.close();
  }
}
