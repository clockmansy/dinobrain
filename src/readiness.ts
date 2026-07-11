import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { TextDecoder } from "node:util";

import {
  COMPLETION_ARTIFACTS,
  COMPLETION_CONTRACT_VERSION,
  COMPLETION_GATES,
  HARD_GATE_IDS,
  type CompletionArtifactSpec,
  type HardGateId,
} from "./completion-registry.js";
import type { CompletionGateResult, CompletionVerdict } from "./completion-evidence.js";
import {
  loadCurrentStatusGeneration,
  resolveStatusGenerationArtifactPath,
  STATUS_GENERATION_POINTER_RELATIVE_PATH,
  STATUS_GENERATION_ROOT_RELATIVE_PATH,
  type LoadedStatusGeneration,
  type StatusGenerationEntry,
} from "./status-generation.js";

export const READINESS_VERSION = "readiness_v2";
export const CURRENT_COMPLETION_AUDIT_POINTER_VERSION = "completion_audit_pointer_v1";
export const CURRENT_COMPLETION_AUDIT_POINTER_RELATIVE_PATH = ".dino/state/current-completion-audit.json";

const STRICT_UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });
const DAY_MS = 24 * 60 * 60 * 1000;

export type ReadinessStatus = "PASS" | "BLOCKED" | "FAIL" | "STALE";
export type ReadinessFreshness = "fresh" | "stale" | "missing" | "invalid" | "derived";

export type CompletionAuditPointer = {
  version: typeof CURRENT_COMPLETION_AUDIT_POINTER_VERSION;
  status: "published";
  audit_run_id: string;
  generated_at: string;
  status_generation_id: string;
  status_generation_manifest_sha256: string;
  verdict_path: string;
  verdict_sha256: string;
  verdict_status: "COMPLETE" | "NOT_COMPLETE";
  contract_version: string;
};

export type ReadinessArtifactEvidence = {
  artifact_id: string;
  source_path: string;
  proof_path: string | null;
  generation_id: string | null;
  parse_status: "ok" | "missing" | "invalid" | "derived";
  reported_status: string | null;
  status: ReadinessStatus;
  freshness: ReadinessFreshness;
  generated_at: string | null;
  stale_after_ms: number | null;
  warning_count: number;
  reason_codes: string[];
};

export type ReadinessGate = {
  gate_id: HardGateId;
  id: HardGateId;
  title: string;
  label: string;
  status: ReadinessStatus;
  operational_status: ReadinessStatus;
  audit_status: ReadinessStatus;
  ok: boolean;
  reason_codes: string[];
  blocker_reason: string | null;
  proof_paths: string[];
  proof_path: string | null;
  freshness: ReadinessFreshness;
  generation_id: string | null;
  next_safe_action: string;
  command_ids: string[];
  artifact_ids: string[];
  external_evidence_ids: string[];
  evidence: ReadinessArtifactEvidence[];
  warnings: string[];
};

export type ReadinessReport = {
  ok: boolean;
  version: typeof READINESS_VERSION;
  contract_version: typeof COMPLETION_CONTRACT_VERSION;
  generated_at: string;
  data_root: string;
  status: "ready" | "needs_attention";
  operational_status: "healthy" | "needs_attention";
  visible_status: string;
  parity_hash: string;
  status_generation: {
    artifact_path: string;
    status: LoadedStatusGeneration["status"];
    generation_id: string | null;
    generated_at: string | null;
    manifest_path: string | null;
    manifest_sha256: string | null;
    freshness: ReadinessFreshness;
    stale_after_ms: number;
    reason: string | null;
    reason_codes: string[];
    errors: string[];
  };
  completion_audit: {
    artifact_path: string;
    status: "verified" | "missing" | "invalid" | "generation_mismatch";
    audit_run_id: string | null;
    verdict_path: string | null;
    verdict_sha256: string | null;
    verdict_status: "COMPLETE" | "NOT_COMPLETE" | null;
    status_generation_id: string | null;
    reason_codes: string[];
  };
  hard_gates: ReadinessGate[];
  gates: ReadinessGate[];
  artifacts: ReadinessArtifactEvidence[];
  lanes: {
    blockers: ReadinessGate[];
    reviewer_pending: Array<Record<string, unknown>>;
    main_pending: Array<Record<string, unknown>>;
    verifier_pending: Array<Record<string, unknown>>;
  };
  counts: {
    hard_gates: number;
    pass: number;
    blockers: number;
    operational_blockers: number;
    stale: number;
    malformed: number;
    missing: number;
    reviewer_pending: number;
    main_pending: number;
    verifier_pending: number;
  };
  health_status: {
    status: "healthy" | "needs_attention";
    generation_id: string | null;
    checks: Array<{
      id: HardGateId;
      status: "healthy" | "needs_attention";
      reason: string | null;
      proof_paths: string[];
      freshness: ReadinessFreshness;
    }>;
    warnings: string[];
  };
  node_lifecycle_status: Record<string, unknown>;
  client_mcp_direct_status: Record<string, unknown>;
  rag_status: Record<string, unknown>;
  vector_index_migration_status: Record<string, unknown>;
  live_semantic_query_status: Record<string, unknown>;
  answer_quality_status: Record<string, unknown>;
  scale_50k_status: Record<string, unknown>;
  controlled_compounding_status: Record<string, unknown>;
  release_manifest_status: Record<string, unknown>;
  latest_audit: null;
  warnings: string[];
};

export type BuildReadinessOptions = {
  now?: Date;
  generationStaleAfterMs?: number;
  verifySourceCoherence?: boolean;
  loadedGeneration?: LoadedStatusGeneration;
};

type JsonObject = Record<string, unknown>;

type CompletionAuditState = {
  status: ReadinessReport["completion_audit"]["status"];
  pointer: CompletionAuditPointer | null;
  verdict: CompletionVerdict | null;
  gate_results: Map<HardGateId, CompletionGateResult>;
  reason_codes: string[];
};

const NEXT_ACTION_BY_ARTIFACT: Record<string, string> = {
  client_mcp_direct_status: "npm run status:mcp-direct && npm run verify:mcp-direct",
  native_instruction_authority: "npm run status:native-authority && npm run verify:native-authority",
  task_sessions: "npm run task:lifecycle && npm run task:lifecycle:verify",
  task_lifecycle_settlement: "npm run task:lifecycle:settle && npm run task:lifecycle:settle:verify",
  rag_proof: "npm run rag:proof && npm run rag:proof:verify",
  rag_eval: "npm run eval:rag && npm run eval:rag:verify",
  vector_index_migration: "npm run rag:vector:migration && npm run rag:vector:migration:verify",
  live_semantic_query: "npm run status:live-semantic-query && npm run verify:live-semantic-query",
  answer_quality: "npm run status:answer-quality && npm run verify:answer-quality",
  source_lineage: "npm run status:source-lineage && npm run verify:source-lineage",
  node_lifecycle: "npm run memory:lifecycle && npm run memory:lifecycle:verify",
  review_queue: "npm run review:settle && npm run review:settle:verify",
  review_worklist: "npm run review:worklist && npm run review:worklist:verify",
  review_queue_backpressure: "npm run review:backpressure && npm run review:backpressure:verify",
  cold_partitions: "npm run cold:partitions && npm run cold:partitions:verify",
  behavior_recall: "npm run status:behavior-recall && npm run verify:behavior-recall",
  controlled_compounding: "npm run status:compounding && npm run verify:compounding",
  graph_health: "npm run graph:health && npm run graph:health:verify",
  full_memory_audit: "npm run audit:full-memory && npm run audit:full-memory:verify",
  release_manifest: "npm run status:release-manifest && npm run verify:release-manifest",
  encrypted_restore_status: "npm run backup:private:verify",
  monitoring_status: "npm run status:refresh",
};

function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function unique(values: Array<string | null | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => typeof value === "string" && value.length > 0))];
}

function dataPath(dataRoot: string, relativePath: string): string {
  return path.resolve(dataRoot, ...relativePath.split("/"));
}

function isPathWithin(parent: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function decodeStrictUtf8(label: string, raw: Buffer): string {
  for (let index = 0; index < raw.length; index += 1) {
    if (raw[index] === 0x0d && raw[index + 1] !== 0x0a) throw new Error(`bare_cr:${label}`);
  }
  try {
    return STRICT_UTF8_DECODER.decode(raw);
  } catch {
    throw new Error(`invalid_utf8:${label}`);
  }
}

function validIso(value: unknown): string | null {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) return null;
  return value;
}

function objectValue(value: unknown): JsonObject | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function arrayLength(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

function worstStatus(statuses: ReadinessStatus[]): ReadinessStatus {
  if (statuses.includes("FAIL")) return "FAIL";
  if (statuses.includes("STALE")) return "STALE";
  if (statuses.includes("BLOCKED")) return "BLOCKED";
  return "PASS";
}

function worstFreshness(values: ReadinessFreshness[]): ReadinessFreshness {
  if (values.includes("invalid")) return "invalid";
  if (values.includes("stale")) return "stale";
  if (values.includes("missing")) return "missing";
  if (values.length > 0 && values.every((value) => value === "derived")) return "derived";
  return "fresh";
}

function generationProofPath(generation: LoadedStatusGeneration): string | null {
  if (!generation.pointer || !generation.manifest) return null;
  return generation.pointer.manifest_path;
}

function snapshotProofPath(generation: LoadedStatusGeneration, entry: StatusGenerationEntry): string | null {
  if (!generation.pointer) return null;
  return `${STATUS_GENERATION_ROOT_RELATIVE_PATH}/${generation.pointer.generation_id}/${entry.snapshot_path}`;
}

function generationFreshness(
  generation: LoadedStatusGeneration,
  now: Date,
  staleAfterMs: number,
): { freshness: ReadinessFreshness; reason_codes: string[] } {
  if (generation.status === "missing") return { freshness: "missing", reason_codes: [generation.reason ?? "generation_missing"] };
  if (generation.status === "invalid") {
    return { freshness: "invalid", reason_codes: unique([generation.reason, ...generation.errors]) };
  }
  const generatedAt = validIso(generation.pointer?.generated_at);
  if (!generatedAt) return { freshness: "invalid", reason_codes: ["generation_timestamp_invalid"] };
  if (now.getTime() - Date.parse(generatedAt) > staleAfterMs) {
    return { freshness: "stale", reason_codes: ["status_generation_stale"] };
  }
  return { freshness: "fresh", reason_codes: [] };
}

async function readCompletionAuditState(
  dataRoot: string,
  generation: LoadedStatusGeneration,
): Promise<CompletionAuditState> {
  const pointerPath = dataPath(dataRoot, CURRENT_COMPLETION_AUDIT_POINTER_RELATIVE_PATH);
  let raw: Buffer;
  try {
    raw = await fs.readFile(pointerPath);
  } catch (error) {
    return {
      status: (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "invalid",
      pointer: null,
      verdict: null,
      gate_results: new Map(),
      reason_codes: [(error as NodeJS.ErrnoException).code === "ENOENT" ? "completion_audit_pointer_missing" : "completion_audit_pointer_unreadable"],
    };
  }
  let pointer: CompletionAuditPointer;
  try {
    pointer = JSON.parse(decodeStrictUtf8(CURRENT_COMPLETION_AUDIT_POINTER_RELATIVE_PATH, raw)) as CompletionAuditPointer;
  } catch (error) {
    return {
      status: "invalid",
      pointer: null,
      verdict: null,
      gate_results: new Map(),
      reason_codes: [`completion_audit_pointer_invalid:${error instanceof Error ? error.message : String(error)}`],
    };
  }
  const pointerErrors: string[] = [];
  if (
    pointer.version !== CURRENT_COMPLETION_AUDIT_POINTER_VERSION ||
    pointer.status !== "published" ||
    typeof pointer.audit_run_id !== "string" ||
    !/^completion-[A-Za-z0-9._-]+$/.test(pointer.audit_run_id) ||
    !validIso(pointer.generated_at) ||
    typeof pointer.status_generation_id !== "string" ||
    !/^[a-f0-9]{64}$/.test(pointer.status_generation_manifest_sha256 ?? "") ||
    !/^[a-f0-9]{64}$/.test(pointer.verdict_sha256 ?? "") ||
    !["COMPLETE", "NOT_COMPLETE"].includes(pointer.verdict_status) ||
    pointer.contract_version !== COMPLETION_CONTRACT_VERSION
  ) {
    pointerErrors.push("completion_audit_pointer_schema_invalid");
  }
  const expectedVerdictPath = `.dino/audits/completion/${pointer.audit_run_id}/completion-verdict.json`;
  if (pointer.verdict_path !== expectedVerdictPath) pointerErrors.push("completion_audit_verdict_path_invalid");
  const verdictPath = dataPath(dataRoot, expectedVerdictPath);
  if (!isPathWithin(dataRoot, verdictPath)) pointerErrors.push("completion_audit_verdict_path_escape");
  if (pointerErrors.length > 0) {
    return { status: "invalid", pointer, verdict: null, gate_results: new Map(), reason_codes: pointerErrors };
  }
  if (
    generation.status !== "healthy" ||
    pointer.status_generation_id !== generation.pointer?.generation_id ||
    pointer.status_generation_manifest_sha256 !== generation.pointer?.manifest_sha256
  ) {
    return {
      status: "generation_mismatch",
      pointer,
      verdict: null,
      gate_results: new Map(),
      reason_codes: ["completion_audit_generation_mismatch"],
    };
  }
  try {
    const verdictRaw = await fs.readFile(verdictPath);
    if (sha256(verdictRaw) !== pointer.verdict_sha256) throw new Error("completion_audit_verdict_hash_mismatch");
    const verdict = JSON.parse(decodeStrictUtf8(expectedVerdictPath, verdictRaw)) as CompletionVerdict;
    const gateIds = new Set(verdict.gate_results?.map((entry) => entry.gate_id));
    if (
      verdict.audit_run_id !== pointer.audit_run_id ||
      verdict.contract_version !== COMPLETION_CONTRACT_VERSION ||
      verdict.status !== pointer.verdict_status ||
      !Array.isArray(verdict.gate_results) ||
      HARD_GATE_IDS.some((id) => !gateIds.has(id))
    ) {
      throw new Error("completion_audit_verdict_schema_invalid");
    }
    return {
      status: "verified",
      pointer,
      verdict,
      gate_results: new Map(verdict.gate_results.map((entry) => [entry.gate_id, entry])),
      reason_codes: [],
    };
  } catch (error) {
    return {
      status: "invalid",
      pointer,
      verdict: null,
      gate_results: new Map(),
      reason_codes: [error instanceof Error ? error.message : "completion_audit_verdict_invalid"],
    };
  }
}

async function readArtifactEvidence(params: {
  dataRoot: string;
  generation: LoadedStatusGeneration;
  spec: CompletionArtifactSpec;
  now: Date;
  generationFreshness: ReadinessFreshness;
}): Promise<{ evidence: ReadinessArtifactEvidence; value: JsonObject | null }> {
  const { generation, spec, now } = params;
  if (spec.id === "current_status_generation") {
    const status: ReadinessStatus =
      generation.status !== "healthy" ? (generation.status === "missing" ? "BLOCKED" : "FAIL") : params.generationFreshness === "stale" ? "STALE" : "PASS";
    return {
      evidence: {
        artifact_id: spec.id,
        source_path: STATUS_GENERATION_POINTER_RELATIVE_PATH,
        proof_path: generationProofPath(generation) ?? STATUS_GENERATION_POINTER_RELATIVE_PATH,
        generation_id: generation.pointer?.generation_id ?? null,
        parse_status: generation.status === "healthy" ? "ok" : generation.status === "missing" ? "missing" : "invalid",
        reported_status: generation.pointer?.status ?? null,
        status,
        freshness: params.generationFreshness,
        generated_at: generation.pointer?.generated_at ?? null,
        stale_after_ms: null,
        warning_count: 0,
        reason_codes:
          status === "PASS" ? [] : unique([generation.reason, ...generation.errors, params.generationFreshness === "stale" ? "status_generation_stale" : null]),
      },
      value: generation.pointer as unknown as JsonObject | null,
    };
  }
  if (spec.id === "health_status") {
    return {
      evidence: {
        artifact_id: spec.id,
        source_path: spec.relative_path,
        proof_path: spec.relative_path,
        generation_id: generation.pointer?.generation_id ?? null,
        parse_status: "derived",
        reported_status: "derived_from_readiness",
        status: "PASS",
        freshness: "derived",
        generated_at: generation.pointer?.generated_at ?? null,
        stale_after_ms: null,
        warning_count: 0,
        reason_codes: [],
      },
      value: null,
    };
  }
  const entry = generation.manifest?.entries.find((candidate) => candidate.source_path === spec.relative_path) ?? null;
  const resolved = resolveStatusGenerationArtifactPath(generation, spec.relative_path);
  if (!entry || !resolved) {
    return {
      evidence: {
        artifact_id: spec.id,
        source_path: spec.relative_path,
        proof_path: null,
        generation_id: generation.pointer?.generation_id ?? null,
        parse_status: "missing",
        reported_status: null,
        status: "BLOCKED",
        freshness: "missing",
        generated_at: null,
        stale_after_ms: spec.freshness_ms ?? null,
        warning_count: 0,
        reason_codes: [`artifact_missing:${spec.id}`],
      },
      value: null,
    };
  }
  let value: JsonObject | null = null;
  try {
    if (entry.kind === "json") value = objectValue(JSON.parse(await fs.readFile(resolved, "utf8")));
    if (entry.kind === "jsonl") {
      for (const line of (await fs.readFile(resolved, "utf8")).split(/\r?\n/).filter(Boolean)) JSON.parse(line);
    }
    if (entry.kind === "json" && !value) throw new Error("artifact_root_not_object");
  } catch {
    return {
      evidence: {
        artifact_id: spec.id,
        source_path: spec.relative_path,
        proof_path: snapshotProofPath(generation, entry),
        generation_id: generation.pointer?.generation_id ?? null,
        parse_status: "invalid",
        reported_status: null,
        status: "FAIL",
        freshness: "invalid",
        generated_at: entry.generated_at,
        stale_after_ms: spec.freshness_ms ?? null,
        warning_count: 0,
        reason_codes: [`artifact_malformed:${spec.id}`],
      },
      value: null,
    };
  }
  const reportedStatus = stringValue(value?.status) ?? entry.reported_status;
  const generatedAt = validIso(value?.generated_at) ?? validIso(value?.latest_verified_at) ?? entry.generated_at;
  const warningCount = arrayLength(value?.warnings) + arrayLength(value?.blockers);
  const reasons: string[] = [];
  let status: ReadinessStatus = "PASS";
  let freshness: ReadinessFreshness = params.generationFreshness;
  if (spec.accepted_statuses && (!reportedStatus || !spec.accepted_statuses.includes(reportedStatus))) {
    status = "BLOCKED";
    reasons.push(`artifact_status_not_accepted:${spec.id}:${reportedStatus ?? "missing"}`);
  }
  if (warningCount > 0) {
    status = worstStatus([status, "BLOCKED"]);
    reasons.push(`artifact_warning_present:${spec.id}`);
  }
  if (spec.freshness_ms !== undefined) {
    if (!generatedAt) {
      status = worstStatus([status, "STALE"]);
      freshness = "stale";
      reasons.push(`artifact_freshness_timestamp_missing:${spec.id}`);
    } else if (now.getTime() - Date.parse(generatedAt) > spec.freshness_ms) {
      status = worstStatus([status, "STALE"]);
      freshness = "stale";
      reasons.push(`artifact_stale:${spec.id}`);
    }
  }
  if (params.generationFreshness === "stale") {
    status = worstStatus([status, "STALE"]);
    freshness = "stale";
    reasons.push("status_generation_stale");
  }
  return {
    evidence: {
      artifact_id: spec.id,
      source_path: spec.relative_path,
      proof_path: snapshotProofPath(generation, entry),
      generation_id: generation.pointer?.generation_id ?? null,
      parse_status: "ok",
      reported_status: reportedStatus,
      status,
      freshness,
      generated_at: generatedAt,
      stale_after_ms: spec.freshness_ms ?? null,
      warning_count: warningCount,
      reason_codes: unique(reasons),
    },
    value,
  };
}

function nextSafeAction(params: {
  gateId: HardGateId;
  finalStatus: ReadinessStatus;
  reasons: string[];
  evidence: ReadinessArtifactEvidence[];
  completionAudit: CompletionAuditState;
}): string {
  if (params.finalStatus === "PASS") return "No action required";
  if (
    params.reasons.some(
      (reason) =>
        reason.startsWith("status_generation") ||
        reason.startsWith("source_generation") ||
        reason.startsWith("snapshot_") ||
        reason.startsWith("generation_"),
    )
  ) {
    return "npm run status:refresh";
  }
  const failingArtifact = params.evidence.find((entry) => entry.status !== "PASS" && entry.artifact_id !== "health_status");
  if (failingArtifact && NEXT_ACTION_BY_ARTIFACT[failingArtifact.artifact_id]) {
    return NEXT_ACTION_BY_ARTIFACT[failingArtifact.artifact_id];
  }
  if (params.completionAudit.status !== "verified" || params.reasons.some((reason) => reason.startsWith("completion_audit"))) {
    return "npm run completion:audit -- --allow-not-complete";
  }
  return `Resolve ${params.gateId} evidence, refresh status, then rerun the completion audit`;
}

function compactArtifactValue(values: Map<string, JsonObject | null>, id: string): JsonObject {
  return values.get(id) ?? {};
}

function canonicalProjection(report: Omit<ReadinessReport, "parity_hash">): unknown {
  return {
    version: report.version,
    contract_version: report.contract_version,
    status: report.status,
    operational_status: report.operational_status,
    status_generation: {
      status: report.status_generation.status,
      generation_id: report.status_generation.generation_id,
      manifest_sha256: report.status_generation.manifest_sha256,
      freshness: report.status_generation.freshness,
      reason_codes: report.status_generation.reason_codes,
    },
    completion_audit: {
      status: report.completion_audit.status,
      audit_run_id: report.completion_audit.audit_run_id,
      verdict_sha256: report.completion_audit.verdict_sha256,
      status_generation_id: report.completion_audit.status_generation_id,
      reason_codes: report.completion_audit.reason_codes,
    },
    gates: report.gates.map((gate) => ({
      gate_id: gate.gate_id,
      status: gate.status,
      operational_status: gate.operational_status,
      audit_status: gate.audit_status,
      reason_codes: gate.reason_codes,
      proof_paths: gate.proof_paths,
      freshness: gate.freshness,
      generation_id: gate.generation_id,
      next_safe_action: gate.next_safe_action,
      evidence: gate.evidence.map((entry) => ({
        artifact_id: entry.artifact_id,
        source_path: entry.source_path,
        proof_path: entry.proof_path,
        parse_status: entry.parse_status,
        reported_status: entry.reported_status,
        status: entry.status,
        freshness: entry.freshness,
        generated_at: entry.generated_at,
        warning_count: entry.warning_count,
        reason_codes: entry.reason_codes,
      })),
    })),
  };
}

export async function buildReadiness(dataRoot: string, options: BuildReadinessOptions = {}): Promise<ReadinessReport> {
  const resolvedRoot = path.resolve(dataRoot);
  const now = options.now ?? new Date();
  const generationStaleAfterMs = options.generationStaleAfterMs ?? DAY_MS;
  const generation =
    options.loadedGeneration ??
    (await loadCurrentStatusGeneration(resolvedRoot, {
      verifyEntries: true,
      verifySourceCoherence: options.verifySourceCoherence ?? true,
    }));
  const generationState = generationFreshness(generation, now, generationStaleAfterMs);
  const completionAudit = await readCompletionAuditState(resolvedRoot, generation);
  const evidenceResults = await Promise.all(
    COMPLETION_ARTIFACTS.map((spec) =>
      readArtifactEvidence({
        dataRoot: resolvedRoot,
        generation,
        spec,
        now,
        generationFreshness: generationState.freshness,
      }),
    ),
  );
  const artifacts = evidenceResults.map((entry) => entry.evidence);
  const artifactValues = new Map(COMPLETION_ARTIFACTS.map((spec, index) => [spec.id, evidenceResults[index]?.value ?? null]));
  const globalGenerationStatus: ReadinessStatus =
    generation.status === "missing"
      ? "BLOCKED"
      : generation.status === "invalid"
        ? "FAIL"
        : generationState.freshness === "stale"
          ? "STALE"
          : "PASS";

  const gates: ReadinessGate[] = COMPLETION_GATES.map((gate) => {
    const evidence = artifacts.filter((entry) => gate.artifact_ids.includes(entry.artifact_id));
    const operationalStatus = worstStatus([globalGenerationStatus, ...evidence.map((entry) => entry.status)]);
    const auditGate = completionAudit.gate_results.get(gate.id);
    const auditStatus: ReadinessStatus =
      completionAudit.status !== "verified"
        ? completionAudit.status === "invalid" ? "FAIL" : "BLOCKED"
        : auditGate?.status === "PASS"
          ? "PASS"
          : auditGate?.status === "FAIL"
            ? "FAIL"
            : "BLOCKED";
    const status = worstStatus([operationalStatus, auditStatus]);
    const operationalReasons = evidence.flatMap((entry) => entry.reason_codes);
    if (globalGenerationStatus !== "PASS") operationalReasons.unshift(...generationState.reason_codes);
    const auditReasons =
      completionAudit.status === "verified"
        ? auditGate?.status === "PASS"
          ? []
          : auditGate?.reasons ?? ["completion_audit_gate_result_missing"]
        : completionAudit.reason_codes;
    const reasons = unique([...operationalReasons, ...auditReasons]);
    const proofPaths = unique([
      ...evidence.map((entry) => entry.proof_path),
      generationProofPath(generation),
      completionAudit.pointer?.verdict_path,
      completionAudit.pointer ? CURRENT_COMPLETION_AUDIT_POINTER_RELATIVE_PATH : null,
    ]);
    const freshness = worstFreshness([
      generationState.freshness,
      ...evidence.map((entry) => entry.freshness),
      completionAudit.status === "invalid" ? "invalid" : completionAudit.status === "missing" ? "missing" : "fresh",
    ]);
    return {
      gate_id: gate.id,
      id: gate.id,
      title: gate.title,
      label: gate.title,
      status,
      operational_status: operationalStatus,
      audit_status: auditStatus,
      ok: status === "PASS",
      reason_codes: reasons,
      blocker_reason: reasons[0] ?? null,
      proof_paths: proofPaths,
      proof_path: proofPaths[0] ?? null,
      freshness,
      generation_id: generation.pointer?.generation_id ?? null,
      next_safe_action: nextSafeAction({ gateId: gate.id, finalStatus: status, reasons, evidence, completionAudit }),
      command_ids: gate.command_ids,
      artifact_ids: gate.artifact_ids,
      external_evidence_ids: gate.external_evidence_ids,
      evidence,
      warnings: reasons,
    };
  });
  const blockers = gates.filter((gate) => gate.status !== "PASS");
  const operationalBlockers = gates.filter((gate) => gate.operational_status !== "PASS");
  const verifierPending = blockers
    .filter((gate) => gate.operational_status === "PASS" && gate.audit_status !== "PASS")
    .map((gate) => ({
      id: gate.gate_id,
      status: gate.audit_status,
      reason: gate.blocker_reason,
      path: gate.proof_path,
      next_safe_action: gate.next_safe_action,
    }));
  const healthChecks = gates.map((gate) => ({
    id: gate.gate_id,
    status: (gate.operational_status === "PASS" ? "healthy" : "needs_attention") as "healthy" | "needs_attention",
    reason: gate.operational_status === "PASS" ? null : gate.reason_codes[0] ?? "gate_not_healthy",
    proof_paths: gate.proof_paths,
    freshness: gate.freshness,
  }));
  const operationalHealthy = operationalBlockers.length === 0;
  const ragProof = compactArtifactValue(artifactValues, "rag_proof");
  const vectorMigration = compactArtifactValue(artifactValues, "vector_index_migration");
  const liveSemantic = compactArtifactValue(artifactValues, "live_semantic_query");
  const answerQuality = compactArtifactValue(artifactValues, "answer_quality");
  const scale = compactArtifactValue(artifactValues, "scale_50k");
  const lifecycle = compactArtifactValue(artifactValues, "node_lifecycle");
  const clientMcp = compactArtifactValue(artifactValues, "client_mcp_direct_status");
  const compounding = compactArtifactValue(artifactValues, "controlled_compounding");
  const release = compactArtifactValue(artifactValues, "release_manifest");
  const artifactEvidence = (id: string) => artifacts.find((entry) => entry.artifact_id === id);
  const reportWithoutHash: Omit<ReadinessReport, "parity_hash"> = {
    ok: blockers.length === 0,
    version: READINESS_VERSION,
    contract_version: COMPLETION_CONTRACT_VERSION,
    generated_at: now.toISOString(),
    data_root: resolvedRoot,
    status: blockers.length === 0 ? "ready" : "needs_attention",
    operational_status: operationalHealthy ? "healthy" : "needs_attention",
    visible_status: blockers.length === 0 ? "Completion readiness green" : "Completion blockers visible",
    status_generation: {
      artifact_path: STATUS_GENERATION_POINTER_RELATIVE_PATH,
      status: generation.status,
      generation_id: generation.pointer?.generation_id ?? null,
      generated_at: generation.pointer?.generated_at ?? null,
      manifest_path: generation.pointer?.manifest_path ?? null,
      manifest_sha256: generation.pointer?.manifest_sha256 ?? null,
      freshness: generationState.freshness,
      stale_after_ms: generationStaleAfterMs,
      reason: generation.reason ?? generationState.reason_codes[0] ?? null,
      reason_codes: generationState.reason_codes,
      errors: generation.errors,
    },
    completion_audit: {
      artifact_path: CURRENT_COMPLETION_AUDIT_POINTER_RELATIVE_PATH,
      status: completionAudit.status,
      audit_run_id: completionAudit.pointer?.audit_run_id ?? null,
      verdict_path: completionAudit.pointer?.verdict_path ?? null,
      verdict_sha256: completionAudit.pointer?.verdict_sha256 ?? null,
      verdict_status: completionAudit.pointer?.verdict_status ?? null,
      status_generation_id: completionAudit.pointer?.status_generation_id ?? null,
      reason_codes: completionAudit.reason_codes,
    },
    hard_gates: gates,
    gates,
    artifacts,
    lanes: {
      blockers,
      reviewer_pending: [],
      main_pending: [],
      verifier_pending: verifierPending,
    },
    counts: {
      hard_gates: gates.length,
      pass: gates.length - blockers.length,
      blockers: blockers.length,
      operational_blockers: operationalBlockers.length,
      stale: artifacts.filter((entry) => entry.status === "STALE").length,
      malformed: artifacts.filter((entry) => entry.parse_status === "invalid").length,
      missing: artifacts.filter((entry) => entry.parse_status === "missing").length,
      reviewer_pending: 0,
      main_pending: 0,
      verifier_pending: verifierPending.length,
    },
    health_status: {
      status: operationalHealthy ? "healthy" : "needs_attention",
      generation_id: generation.pointer?.generation_id ?? null,
      checks: healthChecks,
      warnings: operationalBlockers.flatMap((gate) => gate.reason_codes),
    },
    node_lifecycle_status: {
      artifact_path: artifactEvidence("node_lifecycle")?.proof_path ?? null,
      artifact_parse_status: artifactEvidence("node_lifecycle")?.parse_status ?? "missing",
      status: lifecycle.status ?? "missing",
      counts: lifecycle.counts ?? {},
      transaction: lifecycle.transaction ?? lifecycle.last_applied_transaction ?? null,
      recovery_ref: (objectValue(lifecycle.git)?.recovery_ref ?? lifecycle.last_recovery_ref) as unknown,
    },
    client_mcp_direct_status: {
      artifact_path: artifactEvidence("client_mcp_direct_status")?.proof_path ?? null,
      artifact_parse_status: artifactEvidence("client_mcp_direct_status")?.parse_status ?? "missing",
      status: clientMcp.status ?? "missing",
      release_parity_verified: clientMcp.release_parity_verified === true,
      agents: Array.isArray(clientMcp.agents) ? clientMcp.agents : [],
      warnings: Array.isArray(clientMcp.warnings) ? clientMcp.warnings : [],
    },
    rag_status: {
      artifact_path: artifactEvidence("rag_proof")?.proof_path ?? null,
      status: ragProof.status ?? "missing",
      provider: objectValue(ragProof.dense_vector)?.provider ?? null,
      semantic_embedding_provider: objectValue(ragProof.dense_vector)?.semantic_embedding_provider === true,
      blocker: gates.find((gate) => gate.gate_id === "HG-04")?.blocker_reason ?? null,
    },
    vector_index_migration_status: {
      artifact_path: artifactEvidence("vector_index_migration")?.proof_path ?? null,
      artifact_parse_status: artifactEvidence("vector_index_migration")?.parse_status ?? "missing",
      status: vectorMigration.status ?? "missing",
      migration_required: vectorMigration.migration_required === true,
      migration_id: vectorMigration.migration_id ?? objectValue(vectorMigration.latest_migration)?.migration_id ?? null,
      manifest_path: vectorMigration.manifest_path ?? objectValue(vectorMigration.latest_migration)?.manifest_path ?? null,
    },
    live_semantic_query_status: {
      artifact_path: artifactEvidence("live_semantic_query")?.proof_path ?? null,
      artifact_parse_status: artifactEvidence("live_semantic_query")?.parse_status ?? "missing",
      status: liveSemantic.status ?? "missing",
      blocker: artifactEvidence("live_semantic_query")?.reason_codes[0] ?? null,
      proof: liveSemantic.proof ?? null,
      retrieval: liveSemantic.retrieval ?? null,
    },
    answer_quality_status: {
      artifact_path: artifactEvidence("answer_quality")?.proof_path ?? null,
      artifact_parse_status: artifactEvidence("answer_quality")?.parse_status ?? "missing",
      status: answerQuality.status ?? "missing",
      blocker: artifactEvidence("answer_quality")?.reason_codes[0] ?? null,
      evaluator: answerQuality.evaluator ?? null,
      evaluator_class: answerQuality.evaluator_class ?? null,
      counts: answerQuality.counts ?? null,
      metrics: answerQuality.metrics ?? null,
    },
    scale_50k_status: {
      artifact_path: artifactEvidence("scale_50k")?.proof_path ?? null,
      artifact_parse_status: artifactEvidence("scale_50k")?.parse_status ?? "missing",
      status: scale.status ?? "missing",
      qualifying: scale.qualifying === true,
      corpus: scale.corpus ?? null,
      measurements: scale.measurements ?? null,
      bounded_work: scale.bounded_work ?? null,
    },
    controlled_compounding_status: {
      artifact_path: artifactEvidence("controlled_compounding")?.proof_path ?? null,
      artifact_parse_status: artifactEvidence("controlled_compounding")?.parse_status ?? "missing",
      status: compounding.status ?? "missing",
      counts: compounding.counts ?? {},
      policy: compounding.policy ?? null,
      blockers: Array.isArray(compounding.blockers) ? compounding.blockers : [],
    },
    release_manifest_status: {
      artifact_path: artifactEvidence("release_manifest")?.proof_path ?? null,
      artifact_parse_status: artifactEvidence("release_manifest")?.parse_status ?? "missing",
      status: release.status ?? "missing",
      package_version: release.package_version ?? null,
      expected_tag: release.expected_tag ?? null,
      blockers: Array.isArray(release.blockers) ? release.blockers : [],
      assets: release.assets ?? null,
      tag: release.tag ?? null,
    },
    latest_audit: null,
    warnings: unique(gates.flatMap((gate) => gate.reason_codes)),
  };
  return {
    ...reportWithoutHash,
    parity_hash: sha256(JSON.stringify(canonicalProjection(reportWithoutHash))),
  };
}

export function readinessParityProjection(report: ReadinessReport): unknown {
  const { parity_hash: _ignored, ...withoutHash } = report;
  return canonicalProjection(withoutHash);
}
