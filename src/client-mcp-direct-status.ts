import { promises as fs } from "node:fs";
import path from "node:path";

import { dataPath } from "./context.js";
import { FULL_MEMORY_STATE_DIR } from "./full-memory-audit.js";

export const CLIENT_MCP_DIRECT_STATUS_VERSION = "client_mcp_direct_status_v1";
export const CLIENT_MCP_DIRECT_STATUS_RELATIVE_PATH = `${FULL_MEMORY_STATE_DIR}/client_mcp_direct_status.json`;
export const CLIENT_MCP_DIRECT_PROOF_DIR = ".dino/proofs/client-mcp";

export type ClientMcpAgentStatus = "verified" | "needs_recheck" | "not_configured";
export type RequiredDirectTool = "os_begin_task" | "search_memory" | "wiki_search" | "finish_task";
export type ClientMcpAgent = "codex" | "claude";
export type ProofSource =
  | "codex_desktop_direct_mcp"
  | "claude_code_direct_mcp"
  | "codex_app_direct_mcp"
  | "claude_app_direct_mcp"
  | "hook"
  | "bootstrap"
  | "cli_fallback"
  | "config"
  | "synthetic_stdio_only"
  | string;

export type ClientMcpToolCallEvidence = {
  tool: string;
  ok: boolean;
  evidence_path?: string;
  result_hash?: string;
  at?: string;
};

export type ClientMcpDirectProof = {
  agent: ClientMcpAgent;
  status?: ClientMcpAgentStatus;
  client_surface?: string;
  tool_discovery_mode?: string;
  required_tools?: string[];
  verified_tools?: string[];
  missing_tools?: string[];
  tool_calls?: ClientMcpToolCallEvidence[];
  successful_calls?: ClientMcpToolCallEvidence[];
  proof_source?: ProofSource;
  generated_at?: string;
  stale_after_ms?: number;
  not_configured_reason?: string;
  evidence_path?: string;
};

export type ClientMcpAgentReport = {
  agent: ClientMcpAgent;
  status: ClientMcpAgentStatus;
  required_tools: RequiredDirectTool[];
  verified_tools: RequiredDirectTool[];
  missing_tools: RequiredDirectTool[];
  exact_single_name_discovery: boolean;
  latest_verified_at: string | null;
  proof_path: string | null;
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
  generated_at: string;
  latest_verified_at: string | null;
  data_root: string;
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
};

type ProofCandidate = {
  path: string;
  proof: ClientMcpDirectProof;
};

type InvalidProof = {
  path: string;
  reason: string;
};

const REQUIRED_TOOLS: RequiredDirectTool[] = ["os_begin_task", "search_memory", "wiki_search", "finish_task"];
const REQUIRED_AGENTS: ClientMcpAgent[] = ["codex", "claude"];
const BANNED_PROOF_SOURCES = new Set(["hook", "bootstrap", "cli_fallback", "config", "synthetic_stdio_only"]);
const VALID_NOT_CONFIGURED_REASONS = new Set([
  "claude_code_not_installed",
  "claude_executable_not_found",
  "claude_mcp_unavailable",
  "client_not_installed",
]);

function nowIso(date: Date): string {
  return date.toISOString();
}

function getStatusPath(dataRoot: string): string {
  return dataPath(dataRoot, ...CLIENT_MCP_DIRECT_STATUS_RELATIVE_PATH.split("/"));
}

function proofDir(dataRoot: string): string {
  return dataPath(dataRoot, ...CLIENT_MCP_DIRECT_PROOF_DIR.split("/"));
}

function asRequiredToolArray(value: unknown): RequiredDirectTool[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<RequiredDirectTool>();
  for (const item of value) {
    if (REQUIRED_TOOLS.includes(item as RequiredDirectTool)) seen.add(item as RequiredDirectTool);
  }
  return [...seen];
}

function missingRequiredTools(verifiedTools: RequiredDirectTool[]): RequiredDirectTool[] {
  const verified = new Set(verifiedTools);
  return REQUIRED_TOOLS.filter((tool) => !verified.has(tool));
}

function millisecondsSinceEpoch(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function isNotStale(proof: ClientMcpDirectProof, now: Date, defaultStaleAfterMs: number): boolean {
  const generatedMs = millisecondsSinceEpoch(proof.generated_at);
  if (generatedMs === null) return false;
  const staleAfterMs =
    typeof proof.stale_after_ms === "number" && Number.isFinite(proof.stale_after_ms) && proof.stale_after_ms > 0
      ? proof.stale_after_ms
      : defaultStaleAfterMs;
  return generatedMs + staleAfterMs >= now.getTime();
}

function relativeProofPath(dataRoot: string, proofPath: string): string {
  return path.relative(dataRoot, proofPath).split(path.sep).join("/");
}

function successfulToolCalls(proof: ClientMcpDirectProof): Set<string> {
  const calls = Array.isArray(proof.tool_calls)
    ? proof.tool_calls
    : Array.isArray(proof.successful_calls)
      ? proof.successful_calls
      : [];
  return new Set(calls.filter((call) => call && call.ok === true && typeof call.tool === "string").map((call) => call.tool));
}

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function validateVerifiedProof(
  candidate: ProofCandidate,
  now: Date,
  defaultStaleAfterMs: number,
): { ok: true; reason: "verified" } | { ok: false; reason: string } {
  const proof = candidate.proof;
  if (!REQUIRED_AGENTS.includes(proof.agent)) return { ok: false, reason: "invalid_agent" };
  if (proof.status && proof.status !== "verified") return { ok: false, reason: `proof_status_${proof.status}` };
  if (!proof.client_surface || !proof.client_surface.trim()) return { ok: false, reason: "client_surface_missing" };
  if (proof.tool_discovery_mode !== "exact_single_name") return { ok: false, reason: "tool_discovery_not_exact_single_name" };
  if (!proof.proof_source || BANNED_PROOF_SOURCES.has(String(proof.proof_source))) {
    return { ok: false, reason: `proof_source_${proof.proof_source ?? "missing"}_not_allowed` };
  }
  if (!isNotStale(proof, now, defaultStaleAfterMs)) return { ok: false, reason: "proof_stale_or_unparseable_time" };

  const declaredRequired = asRequiredToolArray(proof.required_tools);
  const requiredMissing = missingRequiredTools(declaredRequired);
  if (requiredMissing.length > 0) return { ok: false, reason: `required_tools_missing:${requiredMissing.join(",")}` };

  const verifiedTools = asRequiredToolArray(proof.verified_tools);
  const missingTools = missingRequiredTools(verifiedTools);
  if (missingTools.length > 0) return { ok: false, reason: `verified_tools_missing:${missingTools.join(",")}` };
  const declaredMissing = asRequiredToolArray(proof.missing_tools);
  if (declaredMissing.length > 0) return { ok: false, reason: `proof_declares_missing_tools:${declaredMissing.join(",")}` };

  const successfulCalls = successfulToolCalls(proof);
  const missingCallEvidence = REQUIRED_TOOLS.filter((tool) => !successfulCalls.has(tool));
  if (missingCallEvidence.length > 0) return { ok: false, reason: `call_evidence_missing:${missingCallEvidence.join(",")}` };

  return { ok: true, reason: "verified" };
}

function validateNotConfiguredProof(
  candidate: ProofCandidate,
  now: Date,
  defaultStaleAfterMs: number,
): { ok: true; reason: string } | { ok: false; reason: string } {
  const proof = candidate.proof;
  if (proof.agent !== "claude") return { ok: false, reason: "not_configured_allowed_for_claude_only" };
  if (proof.status !== "not_configured") return { ok: false, reason: "not_configured_status_missing" };
  if (!proof.not_configured_reason || !VALID_NOT_CONFIGURED_REASONS.has(proof.not_configured_reason)) {
    return { ok: false, reason: `invalid_not_configured_reason:${proof.not_configured_reason ?? "missing"}` };
  }
  if (!proof.client_surface || !proof.client_surface.trim()) return { ok: false, reason: "client_surface_missing" };
  if (!isNotStale(proof, now, defaultStaleAfterMs)) return { ok: false, reason: "not_configured_proof_stale" };
  return { ok: true, reason: proof.not_configured_reason };
}

function fallbackAgentReport(
  agent: ClientMcpAgent,
  generatedAt: string,
  staleAfterMs: number,
  invalidProofs: InvalidProof[],
): ClientMcpAgentReport {
  return {
    agent,
    status: "needs_recheck",
    required_tools: REQUIRED_TOOLS,
    verified_tools: [],
    missing_tools: REQUIRED_TOOLS,
    exact_single_name_discovery: false,
    latest_verified_at: null,
    proof_path: null,
    stale_after_ms: staleAfterMs,
    last_computed_at: generatedAt,
    authority_rank: 90,
    reason: invalidProofs.length > 0 ? invalidProofs[0]?.reason ?? "invalid_direct_mcp_proof" : "direct_mcp_proof_missing",
    proof_source: null,
    client_surface: null,
    not_configured_reason: null,
    invalid_proof_paths: invalidProofs.map((item) => item.path),
  };
}

function verifiedAgentReport(
  candidate: ProofCandidate,
  generatedAt: string,
  defaultStaleAfterMs: number,
  status: ClientMcpAgentStatus,
  reason: string,
  dataRoot: string,
): ClientMcpAgentReport {
  const proof = candidate.proof;
  const verifiedTools = status === "verified" ? asRequiredToolArray(proof.verified_tools) : [];
  const missingTools = status === "verified" ? [] : REQUIRED_TOOLS;
  const staleAfterMs =
    typeof proof.stale_after_ms === "number" && Number.isFinite(proof.stale_after_ms) && proof.stale_after_ms > 0
      ? proof.stale_after_ms
      : defaultStaleAfterMs;
  return {
    agent: proof.agent,
    status,
    required_tools: REQUIRED_TOOLS,
    verified_tools: verifiedTools,
    missing_tools: missingTools,
    exact_single_name_discovery: status === "verified",
    latest_verified_at: proof.generated_at ?? null,
    proof_path: relativeProofPath(dataRoot, candidate.path),
    stale_after_ms: staleAfterMs,
    last_computed_at: generatedAt,
    authority_rank: 90,
    reason,
    proof_source: proof.proof_source ? String(proof.proof_source) : null,
    client_surface: proof.client_surface ?? null,
    not_configured_reason: proof.not_configured_reason ?? null,
    invalid_proof_paths: [],
  };
}

async function readProofCandidates(dataRoot: string): Promise<{ candidates: ProofCandidate[]; invalid: InvalidProof[] }> {
  let entries: Array<import("node:fs").Dirent>;
  try {
    entries = await fs.readdir(proofDir(dataRoot), { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { candidates: [], invalid: [] };
    throw error;
  }
  const candidates: ProofCandidate[] = [];
  const invalid: InvalidProof[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const fullPath = path.join(proofDir(dataRoot), entry.name);
    const relPath = relativeProofPath(dataRoot, fullPath);
    try {
      const parsed = JSON.parse(stripBom(await fs.readFile(fullPath, "utf8"))) as ClientMcpDirectProof;
      if (!REQUIRED_AGENTS.includes(parsed.agent)) {
        invalid.push({ path: relPath, reason: "invalid_agent" });
        continue;
      }
      candidates.push({ path: fullPath, proof: parsed });
    } catch {
      invalid.push({ path: relPath, reason: "invalid_json" });
    }
  }
  return { candidates, invalid };
}

function newestFirst(a: ProofCandidate, b: ProofCandidate): number {
  return String(b.proof.generated_at ?? "").localeCompare(String(a.proof.generated_at ?? "")) || a.path.localeCompare(b.path);
}

function reportForAgent(
  agent: ClientMcpAgent,
  candidates: ProofCandidate[],
  invalidProofs: InvalidProof[],
  dataRoot: string,
  generatedAt: string,
  now: Date,
  staleAfterMs: number,
): ClientMcpAgentReport {
  const agentCandidates = candidates.filter((candidate) => candidate.proof.agent === agent).sort(newestFirst);
  const agentInvalidProofs = invalidProofs.filter((proof) => proof.path.includes(`/${agent}-`) || proof.path.includes(`\\${agent}-`));
  const invalidReasons: InvalidProof[] = [...agentInvalidProofs];

  for (const candidate of agentCandidates) {
    const notConfigured = validateNotConfiguredProof(candidate, now, staleAfterMs);
    if (notConfigured.ok) {
      return verifiedAgentReport(candidate, generatedAt, staleAfterMs, "not_configured", notConfigured.reason, dataRoot);
    }
    const verified = validateVerifiedProof(candidate, now, staleAfterMs);
    if (verified.ok) {
      return verifiedAgentReport(candidate, generatedAt, staleAfterMs, "verified", verified.reason, dataRoot);
    }
    invalidReasons.push({ path: relativeProofPath(dataRoot, candidate.path), reason: verified.reason });
  }

  return fallbackAgentReport(agent, generatedAt, staleAfterMs, invalidReasons);
}

function maxIso(values: Array<string | null>): string | null {
  const dates = values.filter((value): value is string => Boolean(value));
  return dates.sort((a, b) => b.localeCompare(a))[0] ?? null;
}

export async function buildClientMcpDirectStatus(
  dataRoot: string,
  options: BuildOptions = {},
): Promise<ClientMcpDirectStatusReport> {
  const now = options.now ?? new Date();
  const generatedAt = nowIso(now);
  const staleAfterMs = options.staleAfterMs ?? 24 * 60 * 60 * 1000;
  const { candidates, invalid } = await readProofCandidates(dataRoot);
  const agents = REQUIRED_AGENTS.map((agent) =>
    reportForAgent(agent, candidates, invalid, dataRoot, generatedAt, now, staleAfterMs),
  );
  const missingTools = agents.reduce((sum, agent) => sum + agent.missing_tools.length, 0);
  const invalidProofPaths = new Set([
    ...invalid.map((proof) => proof.path),
    ...agents.flatMap((agent) => agent.invalid_proof_paths),
  ]);
  const invalidProofCount = invalidProofPaths.size;
  const codexOk = agents.some((agent) => agent.agent === "codex" && agent.status === "verified");
  const claudeOk = agents.some(
    (agent) => agent.agent === "claude" && (agent.status === "verified" || agent.status === "not_configured"),
  );
  const status = codexOk && claudeOk ? "verified" : "needs_recheck";
  const warnings = [
    status === "verified" ? "" : "direct_mcp_exact_single_name_canary_missing",
    invalidProofCount > 0 ? "invalid_direct_mcp_proof_present" : "",
    agents.some((agent) => agent.status === "not_configured") ? "claude_direct_mcp_not_configured" : "",
  ].filter(Boolean);
  return {
    version: CLIENT_MCP_DIRECT_STATUS_VERSION,
    status,
    generated_at: generatedAt,
    latest_verified_at: maxIso(agents.map((agent) => agent.latest_verified_at)),
    data_root: path.resolve(dataRoot),
    required_tools: REQUIRED_TOOLS,
    agents,
    counts: {
      agents: agents.length,
      verified: agents.filter((agent) => agent.status === "verified").length,
      not_configured: agents.filter((agent) => agent.status === "not_configured").length,
      needs_recheck: agents.filter((agent) => agent.status === "needs_recheck").length,
      missing_tools: missingTools,
      invalid_proofs: invalidProofCount,
    },
    warnings,
    visible_status: status === "verified" ? "Direct MCP parity verified" : "Direct MCP parity needs proof",
  };
}

export async function buildAndWriteClientMcpDirectStatus(
  dataRoot: string,
  options: BuildOptions = {},
): Promise<{ report: ClientMcpDirectStatusReport; path: string }> {
  const report = await buildClientMcpDirectStatus(dataRoot, options);
  const statusPath = getStatusPath(dataRoot);
  await fs.mkdir(path.dirname(statusPath), { recursive: true });
  await fs.writeFile(statusPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return { report, path: statusPath };
}
