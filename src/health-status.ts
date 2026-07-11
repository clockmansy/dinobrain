import path from "node:path";

import { atomicWriteJson } from "./concurrency.js";
import { dataPath } from "./context.js";
import { FULL_MEMORY_STATE_DIR } from "./full-memory-audit.js";
import { buildReadiness, type BuildReadinessOptions, type ReadinessFreshness } from "./readiness.js";

export const HEALTH_STATUS_VERSION = "health_status_v2";
export const HEALTH_STATUS_RELATIVE_PATH = `${FULL_MEMORY_STATE_DIR}/health_status.json`;

export type HealthCheckStatus = "healthy" | "needs_attention" | "missing";

export type HealthCheck = {
  id: string;
  artifact_path: string;
  proof_paths: string[];
  status: HealthCheckStatus;
  artifact_report_status: string | null;
  generated_at: string | null;
  latest_verified_at: string | null;
  last_computed_at: string;
  authority_rank: number;
  stale_after_ms: number;
  freshness: ReadinessFreshness;
  reason: string | null;
  next_safe_action: string;
};

export type HealthStatusReport = {
  version: typeof HEALTH_STATUS_VERSION;
  readiness_version: string;
  readiness_parity_hash: string;
  generation_id: string | null;
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

type BuildOptions = BuildReadinessOptions & {
  staleAfterMs?: number;
};

export async function buildHealthStatus(
  dataRoot: string,
  options: BuildOptions = {},
): Promise<HealthStatusReport> {
  const now = options.now ?? new Date();
  const staleAfterMs = options.staleAfterMs ?? options.generationStaleAfterMs ?? 24 * 60 * 60 * 1000;
  const readiness = await buildReadiness(dataRoot, {
    ...options,
    now,
    generationStaleAfterMs: staleAfterMs,
  });
  const checks: HealthCheck[] = readiness.gates.map((gate, index) => ({
    id: gate.gate_id,
    artifact_path: gate.proof_paths[0] ?? readiness.status_generation.artifact_path,
    proof_paths: gate.proof_paths,
    status: gate.operational_status === "PASS" ? "healthy" : "needs_attention",
    artifact_report_status: gate.operational_status,
    generated_at: readiness.status_generation.generated_at,
    latest_verified_at: readiness.status_generation.generated_at,
    last_computed_at: now.toISOString(),
    authority_rank: 100 - index,
    stale_after_ms: staleAfterMs,
    freshness: gate.freshness,
    reason: gate.operational_status === "PASS" ? null : gate.reason_codes[0] ?? "gate_not_healthy",
    next_safe_action: gate.next_safe_action,
  }));
  const needsAttention = checks.filter((check) => check.status === "needs_attention").length;
  const missing = checks.filter((check) => check.status === "missing").length;
  const status = needsAttention > 0 || missing > 0 ? "needs_attention" : "healthy";
  return {
    version: HEALTH_STATUS_VERSION,
    readiness_version: readiness.version,
    readiness_parity_hash: readiness.parity_hash,
    generation_id: readiness.status_generation.generation_id,
    status,
    generated_at: now.toISOString(),
    latest_verified_at: readiness.status_generation.generated_at,
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
  await atomicWriteJson(statusPath, report);
  return { report, path: statusPath };
}
