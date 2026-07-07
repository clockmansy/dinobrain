import { promises as fs } from "node:fs";
import path from "node:path";

import { ANSWER_QUALITY_STATUS_RELATIVE_PATH } from "./answer-quality.js";
import { BEHAVIOR_RECALL_STATUS_RELATIVE_PATH } from "./behavior-recall.js";
import { CLIENT_MCP_DIRECT_STATUS_RELATIVE_PATH } from "./client-mcp-direct-status.js";
import { dataPath } from "./context.js";
import { FULL_MEMORY_AUDIT_STATUS_RELATIVE_PATH, FULL_MEMORY_STATE_DIR } from "./full-memory-audit.js";
import { GRAPH_HEALTH_RELATIVE_PATH } from "./graph-health.js";
import { LIVE_SEMANTIC_QUERY_STATUS_RELATIVE_PATH } from "./live-semantic-query.js";
import { NATIVE_INSTRUCTION_AUTHORITY_RELATIVE_PATH } from "./native-instruction-authority.js";
import { RAG_EVAL_STATUS_RELATIVE_PATH } from "./rag-eval.js";
import { RAG_PROOF_STATUS_RELATIVE_PATH } from "./rag-proof.js";
import { RELEASE_MANIFEST_STATUS_RELATIVE_PATH } from "./release-manifest.js";
import { REVIEW_QUEUE_STATUS_RELATIVE_PATH, SEMANTIC_JOBS_RELATIVE_PATH } from "./review-settlement.js";
import { SOURCE_LINEAGE_STATUS_RELATIVE_PATH } from "./source-lineage.js";
import { TASK_LIFECYCLE_STATUS_RELATIVE_PATH } from "./task-lifecycle.js";
import { TASK_LIFECYCLE_SETTLEMENT_RELATIVE_PATH } from "./task-lifecycle-settlement.js";

export const HEALTH_STATUS_VERSION = "health_status_v1";
export const HEALTH_STATUS_RELATIVE_PATH = `${FULL_MEMORY_STATE_DIR}/health_status.json`;

export type HealthCheckStatus = "healthy" | "needs_attention" | "missing";

export type HealthCheck = {
  id: string;
  artifact_path: string;
  status: HealthCheckStatus;
  artifact_report_status: string | null;
  generated_at: string | null;
  latest_verified_at: string | null;
  last_computed_at: string;
  authority_rank: number;
  stale_after_ms: number;
  reason: string | null;
};

export type HealthStatusReport = {
  version: typeof HEALTH_STATUS_VERSION;
  status: "healthy" | "needs_attention";
  generated_at: string;
  latest_verified_at: string | null;
  data_root: string;
  checks: HealthCheck[];
  counts: {
    checks: number;
    healthy: number;
    needs_attention: number;
    missing: number;
  };
  warnings: string[];
  visible_status: string;
};

type BuildOptions = {
  now?: Date;
  staleAfterMs?: number;
};

type JsonObject = Record<string, unknown>;

type HealthArtifactSpec = {
  id: string;
  artifactPath: string;
  authorityRank: number;
  healthyStatuses: string[];
};

const HEALTH_ARTIFACTS: HealthArtifactSpec[] = [
  {
    id: "full_memory_audit",
    artifactPath: FULL_MEMORY_AUDIT_STATUS_RELATIVE_PATH,
    authorityRank: 100,
    healthyStatuses: ["healthy", "baseline_created", "drift_classified"],
  },
  {
    id: "client_mcp_direct_status",
    artifactPath: CLIENT_MCP_DIRECT_STATUS_RELATIVE_PATH,
    authorityRank: 95,
    healthyStatuses: ["verified"],
  },
  {
    id: "native_instruction_authority",
    artifactPath: NATIVE_INSTRUCTION_AUTHORITY_RELATIVE_PATH,
    authorityRank: 94,
    healthyStatuses: ["healthy"],
  },
  {
    id: "source_lineage",
    artifactPath: SOURCE_LINEAGE_STATUS_RELATIVE_PATH,
    authorityRank: 93,
    healthyStatuses: ["healthy"],
  },
  {
    id: "behavior_recall",
    artifactPath: BEHAVIOR_RECALL_STATUS_RELATIVE_PATH,
    authorityRank: 92,
    healthyStatuses: ["healthy"],
  },
  {
    id: "review_queue_settlement",
    artifactPath: REVIEW_QUEUE_STATUS_RELATIVE_PATH,
    authorityRank: 80,
    healthyStatuses: ["ready", "classified_backlog"],
  },
  {
    id: "semantic_jobs",
    artifactPath: SEMANTIC_JOBS_RELATIVE_PATH,
    authorityRank: 80,
    healthyStatuses: ["ready", "classified_backlog"],
  },
  {
    id: "task_lifecycle",
    artifactPath: TASK_LIFECYCLE_STATUS_RELATIVE_PATH,
    authorityRank: 85,
    healthyStatuses: ["healthy"],
  },
  {
    id: "task_lifecycle_settlement",
    artifactPath: TASK_LIFECYCLE_SETTLEMENT_RELATIVE_PATH,
    authorityRank: 85,
    healthyStatuses: ["healthy"],
  },
  {
    id: "rag_proof",
    artifactPath: RAG_PROOF_STATUS_RELATIVE_PATH,
    authorityRank: 75,
    healthyStatuses: ["healthy"],
  },
  {
    id: "rag_eval",
    artifactPath: RAG_EVAL_STATUS_RELATIVE_PATH,
    authorityRank: 75,
    healthyStatuses: ["healthy"],
  },
  {
    id: "live_semantic_query",
    artifactPath: LIVE_SEMANTIC_QUERY_STATUS_RELATIVE_PATH,
    authorityRank: 75,
    healthyStatuses: ["healthy"],
  },
  {
    id: "answer_quality",
    artifactPath: ANSWER_QUALITY_STATUS_RELATIVE_PATH,
    authorityRank: 75,
    healthyStatuses: ["healthy"],
  },
  {
    id: "release_manifest",
    artifactPath: RELEASE_MANIFEST_STATUS_RELATIVE_PATH,
    authorityRank: 72,
    healthyStatuses: ["healthy"],
  },
  {
    id: "graph_health",
    artifactPath: GRAPH_HEALTH_RELATIVE_PATH,
    authorityRank: 70,
    healthyStatuses: ["healthy"],
  },
];

function nowIso(date: Date): string {
  return date.toISOString();
}

async function readJson<T>(filePath: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function maxIso(values: Array<string | null>): string | null {
  const dates = values.filter((value): value is string => Boolean(value));
  if (dates.length === 0) return null;
  return dates.sort((a, b) => b.localeCompare(a))[0] ?? null;
}

function healthStatusFor(spec: HealthArtifactSpec, artifact: JsonObject | null): HealthCheckStatus {
  if (!artifact) return "missing";
  const status = firstString(artifact.status);
  return status && spec.healthyStatuses.includes(status) ? "healthy" : "needs_attention";
}

function reasonFor(spec: HealthArtifactSpec, artifact: JsonObject | null, status: HealthCheckStatus): string | null {
  if (status === "missing") return "artifact_missing";
  if (status === "healthy") return null;
  const artifactStatus = firstString(artifact?.status) ?? "unknown";
  return `${spec.id}_reported_${artifactStatus}`;
}

export async function buildHealthStatus(
  dataRoot: string,
  options: BuildOptions = {},
): Promise<HealthStatusReport> {
  const generatedAt = nowIso(options.now ?? new Date());
  const staleAfterMs = options.staleAfterMs ?? 24 * 60 * 60 * 1000;
  const checks: HealthCheck[] = [];

  for (const spec of HEALTH_ARTIFACTS) {
    const artifact = await readJson<JsonObject>(dataPath(dataRoot, ...spec.artifactPath.split("/")));
    const status = healthStatusFor(spec, artifact);
    checks.push({
      id: spec.id,
      artifact_path: spec.artifactPath,
      status,
      artifact_report_status: firstString(artifact?.status),
      generated_at: firstString(artifact?.generated_at),
      latest_verified_at: firstString(artifact?.latest_verified_at, artifact?.generated_at),
      last_computed_at: generatedAt,
      authority_rank: spec.authorityRank,
      stale_after_ms: staleAfterMs,
      reason: reasonFor(spec, artifact, status),
    });
  }

  const needsAttention = checks.filter((check) => check.status === "needs_attention").length;
  const missing = checks.filter((check) => check.status === "missing").length;
  const status = needsAttention > 0 || missing > 0 ? "needs_attention" : "healthy";
  return {
    version: HEALTH_STATUS_VERSION,
    status,
    generated_at: generatedAt,
    latest_verified_at: maxIso(checks.map((check) => check.latest_verified_at)),
    data_root: path.resolve(dataRoot),
    checks,
    counts: {
      checks: checks.length,
      healthy: checks.filter((check) => check.status === "healthy").length,
      needs_attention: needsAttention,
      missing,
    },
    warnings: checks.filter((check) => check.status !== "healthy").map((check) => `${check.id}:${check.reason}`),
    visible_status: status === "healthy" ? "OS health normal" : "OS health needs attention",
  };
}

export async function buildAndWriteHealthStatus(
  dataRoot: string,
  options: BuildOptions = {},
): Promise<{ report: HealthStatusReport; path: string }> {
  const report = await buildHealthStatus(dataRoot, options);
  const statusPath = dataPath(dataRoot, ...HEALTH_STATUS_RELATIVE_PATH.split("/"));
  await fs.mkdir(path.dirname(statusPath), { recursive: true });
  await fs.writeFile(statusPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return { report, path: statusPath };
}
