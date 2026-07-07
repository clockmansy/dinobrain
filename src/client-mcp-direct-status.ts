import { promises as fs } from "node:fs";
import path from "node:path";

import { dataPath } from "./context.js";
import { FULL_MEMORY_STATE_DIR } from "./full-memory-audit.js";

export const CLIENT_MCP_DIRECT_STATUS_VERSION = "client_mcp_direct_status_v1";
export const CLIENT_MCP_DIRECT_STATUS_RELATIVE_PATH = `${FULL_MEMORY_STATE_DIR}/client_mcp_direct_status.json`;

export type ClientMcpAgentStatus = "verified" | "needs_recheck" | "not_configured";
export type RequiredDirectTool = "os_begin_task" | "search_memory" | "wiki_search" | "finish_task";

export type ClientMcpAgentReport = {
  agent: "codex" | "claude";
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
    needs_recheck: number;
    missing_tools: number;
  };
  warnings: string[];
  visible_status: string;
};

type BuildOptions = {
  now?: Date;
  staleAfterMs?: number;
};

const REQUIRED_TOOLS: RequiredDirectTool[] = ["os_begin_task", "search_memory", "wiki_search", "finish_task"];

function nowIso(date: Date): string {
  return date.toISOString();
}

function getStatusPath(dataRoot: string): string {
  return dataPath(dataRoot, ...CLIENT_MCP_DIRECT_STATUS_RELATIVE_PATH.split("/"));
}

function agentReport(agent: "codex" | "claude", generatedAt: string, staleAfterMs: number): ClientMcpAgentReport {
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
    reason: "exact_single_name_direct_mcp_canary_not_recorded",
  };
}

export function buildClientMcpDirectStatus(
  dataRoot: string,
  options: BuildOptions = {},
): ClientMcpDirectStatusReport {
  const generatedAt = nowIso(options.now ?? new Date());
  const staleAfterMs = options.staleAfterMs ?? 24 * 60 * 60 * 1000;
  const agents = [agentReport("codex", generatedAt, staleAfterMs), agentReport("claude", generatedAt, staleAfterMs)];
  const missingTools = agents.reduce((sum, agent) => sum + agent.missing_tools.length, 0);
  return {
    version: CLIENT_MCP_DIRECT_STATUS_VERSION,
    status: "needs_recheck",
    generated_at: generatedAt,
    latest_verified_at: null,
    data_root: path.resolve(dataRoot),
    required_tools: REQUIRED_TOOLS,
    agents,
    counts: {
      agents: agents.length,
      verified: agents.filter((agent) => agent.status === "verified").length,
      needs_recheck: agents.filter((agent) => agent.status === "needs_recheck").length,
      missing_tools: missingTools,
    },
    warnings: ["direct_mcp_exact_single_name_canary_missing"],
    visible_status: "Direct MCP parity needs proof",
  };
}

export async function buildAndWriteClientMcpDirectStatus(
  dataRoot: string,
  options: BuildOptions = {},
): Promise<{ report: ClientMcpDirectStatusReport; path: string }> {
  const report = buildClientMcpDirectStatus(dataRoot, options);
  const statusPath = getStatusPath(dataRoot);
  await fs.mkdir(path.dirname(statusPath), { recursive: true });
  await fs.writeFile(statusPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return { report, path: statusPath };
}
