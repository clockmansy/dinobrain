import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const { buildClientMcpDirectStatus, buildAndWriteClientMcpDirectStatus, CLIENT_MCP_DIRECT_STATUS_RELATIVE_PATH } =
  await import(pathToFileURL(path.join(root, "dist", "client-mcp-direct-status.js")).href);

const REQUIRED_TOOLS = ["os_begin_task", "search_memory", "wiki_search", "finish_task"];
const fixedNow = new Date("2026-07-07T12:00:00.000Z");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function writeProof(dataRoot, name, proof) {
  const filePath = path.join(dataRoot, ".dino", "proofs", "client-mcp", `${name}.json`);
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(proof, null, 2)}\n`, "utf8");
  return filePath;
}

function calls() {
  return REQUIRED_TOOLS.map((tool) => ({
    tool,
    ok: true,
    evidence_path: `.dino/proofs/client-mcp/evidence/${tool}.json`,
    result_hash: `sha256-${tool}`,
    at: "2026-07-07T11:55:00.000Z",
  }));
}

function verifiedProof(agent, overrides = {}) {
  return {
    agent,
    status: "verified",
    client_surface: agent === "codex" ? "Codex Desktop MCP tools panel" : "Claude Code MCP tools panel",
    tool_discovery_mode: "exact_single_name",
    required_tools: REQUIRED_TOOLS,
    verified_tools: REQUIRED_TOOLS,
    missing_tools: [],
    tool_calls: calls(),
    proof_source: agent === "codex" ? "codex_desktop_direct_mcp" : "claude_code_direct_mcp",
    generated_at: "2026-07-07T11:55:00.000Z",
    stale_after_ms: 60 * 60 * 1000,
    ...overrides,
  };
}

function claudeNotConfigured(overrides = {}) {
  return {
    agent: "claude",
    status: "not_configured",
    client_surface: "Claude Code installation probe",
    not_configured_reason: "claude_executable_not_found",
    generated_at: "2026-07-07T11:55:00.000Z",
    stale_after_ms: 60 * 60 * 1000,
    ...overrides,
  };
}

async function inTemp(fn) {
  const dataRoot = mkdtempSync(path.join(tmpdir(), "dinobrain-client-mcp-direct-"));
  try {
    return await fn(dataRoot);
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
}

async function expectStatus(name, seed, expectedStatus, inspect = () => {}) {
  await inTemp(async (dataRoot) => {
    seed(dataRoot);
    const report = await buildClientMcpDirectStatus(dataRoot, { now: fixedNow, staleAfterMs: 60 * 60 * 1000 });
    assert(report.status === expectedStatus, `${name}: expected ${expectedStatus}, got ${report.status}`);
    inspect(report);
  });
}

await expectStatus(
  "both direct clients verified",
  (dataRoot) => {
    writeProof(dataRoot, "codex-good", verifiedProof("codex"));
    writeProof(dataRoot, "claude-good", verifiedProof("claude"));
  },
  "verified",
  (report) => {
    assert(report.counts.verified === 2, "both agents should be verified");
    assert(report.counts.missing_tools === 0, "verified report should not miss tools");
    assert(report.agents.every((agent) => agent.proof_path), "verified agents should link proof paths");
  },
);

await expectStatus(
  "claude not configured with evidence",
  (dataRoot) => {
    writeProof(dataRoot, "codex-good", verifiedProof("codex"));
    writeProof(dataRoot, "claude-not-configured", claudeNotConfigured());
  },
  "verified",
  (report) => {
    const claude = report.agents.find((agent) => agent.agent === "claude");
    assert(claude?.status === "not_configured", "Claude should be explicitly not_configured");
    assert(report.warnings.includes("claude_direct_mcp_not_configured"), "not configured warning missing");
  },
);

await expectStatus(
  "missing proof fails",
  () => {},
  "needs_recheck",
  (report) => assert(report.counts.needs_recheck === 2, "missing proof should require both agents to recheck"),
);

await expectStatus(
  "config proof rejected",
  (dataRoot) => {
    writeProof(dataRoot, "codex-config", verifiedProof("codex", { proof_source: "config" }));
    writeProof(dataRoot, "claude-good", verifiedProof("claude"));
  },
  "needs_recheck",
  (report) => assert(report.agents.find((agent) => agent.agent === "codex")?.reason.includes("proof_source_config"), "config proof reason missing"),
);

await expectStatus(
  "hook proof rejected",
  (dataRoot) => {
    writeProof(dataRoot, "codex-hook", verifiedProof("codex", { proof_source: "hook" }));
    writeProof(dataRoot, "claude-good", verifiedProof("claude"));
  },
  "needs_recheck",
);

await expectStatus(
  "alias discovery rejected",
  (dataRoot) => {
    writeProof(dataRoot, "codex-alias", verifiedProof("codex", { tool_discovery_mode: "alias_or_normalized" }));
    writeProof(dataRoot, "claude-good", verifiedProof("claude"));
  },
  "needs_recheck",
);

await expectStatus(
  "stale proof rejected",
  (dataRoot) => {
    writeProof(dataRoot, "codex-stale", verifiedProof("codex", { generated_at: "2026-07-06T00:00:00.000Z" }));
    writeProof(dataRoot, "claude-good", verifiedProof("claude"));
  },
  "needs_recheck",
);

await expectStatus(
  "missing verified tool rejected",
  (dataRoot) => {
    writeProof(
      dataRoot,
      "codex-missing-tool",
      verifiedProof("codex", {
        verified_tools: REQUIRED_TOOLS.filter((tool) => tool !== "finish_task"),
        tool_calls: calls().filter((call) => call.tool !== "finish_task"),
      }),
    );
    writeProof(dataRoot, "claude-good", verifiedProof("claude"));
  },
  "needs_recheck",
  (report) => assert(report.agents.find((agent) => agent.agent === "codex")?.missing_tools.includes("finish_task"), "missing tool should be visible"),
);

await expectStatus(
  "codex only rejected when claude is not explicitly not_configured",
  (dataRoot) => writeProof(dataRoot, "codex-good", verifiedProof("codex")),
  "needs_recheck",
);

await expectStatus(
  "claude only rejected",
  (dataRoot) => writeProof(dataRoot, "claude-good", verifiedProof("claude")),
  "needs_recheck",
);

await inTemp(async (dataRoot) => {
  writeProof(dataRoot, "codex-good", verifiedProof("codex"));
  writeProof(dataRoot, "claude-good", verifiedProof("claude"));
  const written = await buildAndWriteClientMcpDirectStatus(dataRoot, { now: fixedNow });
  assert(written.report.status === "verified", "written report should be verified");
  assert(
    written.path.replace(/\\/g, "/").endsWith(CLIENT_MCP_DIRECT_STATUS_RELATIVE_PATH),
    "status path mismatch",
  );
});

console.log("client mcp direct status verification ok");
