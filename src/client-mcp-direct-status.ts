import { promises as fs } from "node:fs";
import path from "node:path";

import {
  CLIENT_MCP_PROOF_DIR,
  CLIENT_MCP_PROOF_VERSION,
  CLIENT_MCP_REQUIRED_TOOLS,
  readLocalProofIdentityFingerprint,
  validateClientMcpProofFile,
  type ClientMcpAgent,
  type ClientMcpDirectProofV2,
  type ClientMcpRequiredTool,
  type ClientProcessEntry,
} from "./client-mcp-proof.js";
import { atomicWriteJson } from "./concurrency.js";
import { dataPath } from "./context.js";
import { FULL_MEMORY_STATE_DIR } from "./full-memory-audit.js";

export const CLIENT_MCP_DIRECT_STATUS_VERSION = "client_mcp_direct_status_v2";
export const CLIENT_MCP_DIRECT_STATUS_RELATIVE_PATH = `${FULL_MEMORY_STATE_DIR}/client_mcp_direct_status.json`;
export const CLIENT_MCP_DIRECT_PROOF_DIR = CLIENT_MCP_PROOF_DIR;

export type ClientMcpAgentStatus = "verified" | "needs_recheck" | "not_configured";
export type RequiredDirectTool = ClientMcpRequiredTool;

export type ClientMcpAgentReport = {
  agent: ClientMcpAgent;
  status: ClientMcpAgentStatus;
  required_tools: RequiredDirectTool[];
  verified_tools: RequiredDirectTool[];
  missing_tools: RequiredDirectTool[];
  exact_single_name_discovery: boolean;
  latest_verified_at: string | null;
  proof_path: string | null;
  proof_sha256: string | null;
  proof_version: string | null;
  challenge_id: string | null;
  server_instance_id: string | null;
  local_identity_fingerprint: string | null;
  client_name: string | null;
  client_version: string | null;
  client_process_chain: ClientProcessEntry[];
  stale_after_ms: number;
  last_computed_at: string;
  authority_rank: number;
  reason: string;
  proof_source: string | null;
  client_surface: string | null;
  not_configured_reason: string | null;
  invalid_proof_paths: string[];
};

export type ClientMcpDirectStatusReport = {
  version: typeof CLIENT_MCP_DIRECT_STATUS_VERSION;
  status: "verified" | "needs_recheck";
  release_parity_verified: boolean;
  generated_at: string;
  latest_verified_at: string | null;
  data_root: string;
  local_identity_fingerprint: string | null;
  required_tools: RequiredDirectTool[];
  agents: ClientMcpAgentReport[];
  counts: {
    agents: number;
    verified: number;
    not_configured: number;
    needs_recheck: number;
    missing_tools: number;
    invalid_proofs: number;
  };
  warnings: string[];
  visible_status: string;
};

type BuildOptions = {
  now?: Date;
  staleAfterMs?: number;
  localStateRoot?: string;
};

type ParsedCandidate = {
  path: string;
  relativePath: string;
  parsed: Record<string, unknown>;
};

type InvalidProof = {
  path: string;
  reason: string;
  agent: ClientMcpAgent | null;
};

const REQUIRED_TOOLS = [...CLIENT_MCP_REQUIRED_TOOLS];
const REQUIRED_AGENTS: ClientMcpAgent[] = ["codex", "claude"];
const VALID_NOT_CONFIGURED_REASONS = new Set([
  "claude_code_not_installed",
  "claude_executable_not_found",
  "claude_mcp_unavailable",
  "client_not_installed",
]);

function statusPath(dataRoot: string): string {
  return dataPath(dataRoot, ...CLIENT_MCP_DIRECT_STATUS_RELATIVE_PATH.split("/"));
}

function proofDir(dataRoot: string): string {
  return dataPath(dataRoot, ...CLIENT_MCP_DIRECT_PROOF_DIR.split("/"));
}

function relativeProofPath(dataRoot: string, proofPath: string): string {
  return path.relative(dataRoot, proofPath).split(path.sep).join("/");
}

function milliseconds(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function agentFrom(value: unknown): ClientMcpAgent | null {
  return value === "codex" || value === "claude" ? value : null;
}

async function readCandidates(dataRoot: string): Promise<{ candidates: ParsedCandidate[]; invalid: InvalidProof[] }> {
  let entries: Array<import("node:fs").Dirent>;
  try {
    entries = await fs.readdir(proofDir(dataRoot), { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { candidates: [], invalid: [] };
    throw error;
  }
  const candidates: ParsedCandidate[] = [];
  const invalid: InvalidProof[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const fullPath = path.join(proofDir(dataRoot), entry.name);
    const relativePath = relativeProofPath(dataRoot, fullPath);
    try {
      const parsed = JSON.parse(await fs.readFile(fullPath, "utf8")) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        invalid.push({ path: relativePath, reason: "invalid_json_object", agent: null });
        continue;
      }
      candidates.push({ path: fullPath, relativePath, parsed: parsed as Record<string, unknown> });
    } catch {
      invalid.push({ path: relativePath, reason: "invalid_json", agent: null });
    }
  }
  return { candidates, invalid };
}

function newestFirst(left: ParsedCandidate, right: ParsedCandidate): number {
  return String(right.parsed.generated_at ?? "").localeCompare(String(left.parsed.generated_at ?? "")) ||
    left.relativePath.localeCompare(right.relativePath);
}

function invalidPathsForAgent(agent: ClientMcpAgent, invalid: InvalidProof[]): string[] {
  return invalid
    .filter((item) => item.agent === null || item.agent === agent)
    .map((item) => item.path)
    .filter((value, index, values) => values.indexOf(value) === index);
}

function fallbackAgentReport(
  agent: ClientMcpAgent,
  generatedAt: string,
  staleAfterMs: number,
  invalid: InvalidProof[],
): ClientMcpAgentReport {
  const relevant = invalid.filter((item) => item.agent === null || item.agent === agent);
  return {
    agent,
    status: "needs_recheck",
    required_tools: REQUIRED_TOOLS,
    verified_tools: [],
    missing_tools: REQUIRED_TOOLS,
    exact_single_name_discovery: false,
    latest_verified_at: null,
    proof_path: null,
    proof_sha256: null,
    proof_version: null,
    challenge_id: null,
    server_instance_id: null,
    local_identity_fingerprint: null,
    client_name: null,
    client_version: null,
    client_process_chain: [],
    stale_after_ms: staleAfterMs,
    last_computed_at: generatedAt,
    authority_rank: 100,
    reason: relevant[0]?.reason ?? "direct_mcp_v2_proof_missing",
    proof_source: null,
    client_surface: null,
    not_configured_reason: null,
    invalid_proof_paths: invalidPathsForAgent(agent, invalid),
  };
}

function verifiedAgentReport(
  proof: ClientMcpDirectProofV2,
  generatedAt: string,
  invalid: InvalidProof[],
): ClientMcpAgentReport {
  return {
    agent: proof.agent,
    status: "verified",
    required_tools: REQUIRED_TOOLS,
    verified_tools: REQUIRED_TOOLS,
    missing_tools: [],
    exact_single_name_discovery: true,
    latest_verified_at: proof.generated_at,
    proof_path: proof.proof_path,
    proof_sha256: proof.proof_sha256,
    proof_version: proof.version,
    challenge_id: proof.challenge_id,
    server_instance_id: proof.server_instance_id,
    local_identity_fingerprint: proof.local_identity_fingerprint,
    client_name: proof.client_info.name,
    client_version: proof.client_info.version,
    client_process_chain: proof.process_identity.chain,
    stale_after_ms: proof.stale_after_ms,
    last_computed_at: generatedAt,
    authority_rank: 100,
    reason: "server_observed_challenge_response_verified",
    proof_source: proof.proof_source,
    client_surface: proof.client_surface,
    not_configured_reason: null,
    invalid_proof_paths: invalidPathsForAgent(proof.agent, invalid),
  };
}

function notConfiguredAgentReport(
  candidate: ParsedCandidate,
  generatedAt: string,
  staleAfterMs: number,
  reason: string,
  invalid: InvalidProof[],
): ClientMcpAgentReport {
  return {
    agent: "claude",
    status: "not_configured",
    required_tools: REQUIRED_TOOLS,
    verified_tools: [],
    missing_tools: REQUIRED_TOOLS,
    exact_single_name_discovery: false,
    latest_verified_at: typeof candidate.parsed.generated_at === "string" ? candidate.parsed.generated_at : null,
    proof_path: candidate.relativePath,
    proof_sha256: null,
    proof_version: typeof candidate.parsed.version === "string" ? candidate.parsed.version : null,
    challenge_id: null,
    server_instance_id: null,
    local_identity_fingerprint: null,
    client_name: null,
    client_version: null,
    client_process_chain: [],
    stale_after_ms: staleAfterMs,
    last_computed_at: generatedAt,
    authority_rank: 20,
    reason: "local_diagnostic_only_not_release_evidence",
    proof_source: null,
    client_surface: typeof candidate.parsed.client_surface === "string" ? candidate.parsed.client_surface : null,
    not_configured_reason: reason,
    invalid_proof_paths: invalidPathsForAgent("claude", invalid),
  };
}

function validNotConfiguredDiagnostic(
  candidate: ParsedCandidate,
  now: Date,
  staleAfterMs: number,
): string | null {
  if (candidate.parsed.agent !== "claude" || candidate.parsed.status !== "not_configured") return null;
  const reason = typeof candidate.parsed.not_configured_reason === "string" ? candidate.parsed.not_configured_reason : "";
  if (!VALID_NOT_CONFIGURED_REASONS.has(reason)) return null;
  const generated = milliseconds(candidate.parsed.generated_at);
  if (generated === null || generated + staleAfterMs < now.getTime()) return null;
  return reason;
}

async function reportForAgent(
  agent: ClientMcpAgent,
  candidates: ParsedCandidate[],
  inheritedInvalid: InvalidProof[],
  dataRoot: string,
  generatedAt: string,
  now: Date,
  staleAfterMs: number,
  options: BuildOptions,
): Promise<{ report: ClientMcpAgentReport; invalid: InvalidProof[] }> {
  const agentCandidates = candidates.filter((candidate) => agentFrom(candidate.parsed.agent) === agent).sort(newestFirst);
  const invalid = [...inheritedInvalid];
  let newestValid: ClientMcpDirectProofV2 | null = null;
  for (const candidate of agentCandidates) {
    const validation = await validateClientMcpProofFile(dataRoot, candidate.path, {
      now,
      staleAfterMs,
      localStateRoot: options.localStateRoot,
    });
    if (validation.ok && validation.proof.agent === agent) {
      newestValid ??= validation.proof;
      continue;
    }
    if (!validation.ok) invalid.push({ path: candidate.relativePath, reason: validation.reason, agent });
  }
  if (newestValid) return { report: verifiedAgentReport(newestValid, generatedAt, invalid), invalid };

  if (agent === "claude") {
    for (const candidate of agentCandidates) {
      const reason = validNotConfiguredDiagnostic(candidate, now, staleAfterMs);
      if (reason) return { report: notConfiguredAgentReport(candidate, generatedAt, staleAfterMs, reason, invalid), invalid };
    }
  }
  return { report: fallbackAgentReport(agent, generatedAt, staleAfterMs, invalid), invalid };
}

function maxIso(values: Array<string | null>): string | null {
  return values.filter((value): value is string => Boolean(value)).sort((left, right) => right.localeCompare(left))[0] ?? null;
}

export async function buildClientMcpDirectStatus(
  dataRoot: string,
  options: BuildOptions = {},
): Promise<ClientMcpDirectStatusReport> {
  const now = options.now ?? new Date();
  const generatedAt = now.toISOString();
  const staleAfterMs = Math.min(options.staleAfterMs ?? 24 * 60 * 60 * 1000, 24 * 60 * 60 * 1000);
  const { candidates, invalid: parseInvalid } = await readCandidates(dataRoot);
  const results = [] as Array<{ report: ClientMcpAgentReport; invalid: InvalidProof[] }>;
  for (const agent of REQUIRED_AGENTS) {
    results.push(await reportForAgent(agent, candidates, parseInvalid, dataRoot, generatedAt, now, staleAfterMs, options));
  }
  const agents = results.map((result) => result.report);
  const invalidPaths = new Set(results.flatMap((result) => result.invalid.map((item) => item.path)));
  const releaseParityVerified = REQUIRED_AGENTS.every(
    (agent) => agents.some((report) => report.agent === agent && report.status === "verified"),
  );
  const status = releaseParityVerified ? "verified" : "needs_recheck";
  const warnings = [
    releaseParityVerified ? "" : "both_real_clients_direct_mcp_v2_proof_required",
    !releaseParityVerified && invalidPaths.size > 0 ? "invalid_or_legacy_direct_mcp_proof_present" : "",
    agents.some((agent) => agent.status === "not_configured") ? "claude_not_configured_is_not_release_parity" : "",
  ].filter(Boolean);
  return {
    version: CLIENT_MCP_DIRECT_STATUS_VERSION,
    status,
    release_parity_verified: releaseParityVerified,
    generated_at: generatedAt,
    latest_verified_at: maxIso(agents.map((agent) => agent.latest_verified_at)),
    data_root: path.resolve(dataRoot),
    local_identity_fingerprint: await readLocalProofIdentityFingerprint({ localStateRoot: options.localStateRoot }),
    required_tools: REQUIRED_TOOLS,
    agents,
    counts: {
      agents: agents.length,
      verified: agents.filter((agent) => agent.status === "verified").length,
      not_configured: agents.filter((agent) => agent.status === "not_configured").length,
      needs_recheck: agents.filter((agent) => agent.status === "needs_recheck").length,
      missing_tools: agents.reduce((sum, agent) => sum + agent.missing_tools.length, 0),
      invalid_proofs: invalidPaths.size,
    },
    warnings,
    visible_status: releaseParityVerified
      ? "Direct MCP parity verified by both real clients"
      : "Direct MCP parity requires fresh Codex and Claude challenge proofs",
  };
}

export async function buildAndWriteClientMcpDirectStatus(
  dataRoot: string,
  options: BuildOptions = {},
): Promise<{ report: ClientMcpDirectStatusReport; path: string }> {
  const report = await buildClientMcpDirectStatus(dataRoot, options);
  const filePath = statusPath(dataRoot);
  await atomicWriteJson(filePath, report);
  return { report, path: filePath };
}
