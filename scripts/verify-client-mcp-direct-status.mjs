import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const proofModule = await import(pathToFileURL(path.join(root, "dist", "client-mcp-proof.js")).href);
const statusModule = await import(pathToFileURL(path.join(root, "dist", "client-mcp-direct-status.js")).href);

const {
  CLIENT_MCP_REQUIRED_TOOLS,
  ClientMcpProofRuntime,
  createClientMcpProofChallenge,
  observeClientProcessIdentity,
} = proofModule;
const {
  buildClientMcpDirectStatus,
  buildAndWriteClientMcpDirectStatus,
  CLIENT_MCP_DIRECT_STATUS_RELATIVE_PATH,
} = statusModule;

const fixedNow = new Date("2026-07-10T12:00:00.000Z");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const standaloneIdentity = await observeClientProcessIdentity();
assert(
  standaloneIdentity.observed_agent === null,
  "a standalone verifier launched below a shell must not impersonate the deeper Codex/Claude ancestor",
);

function jsonResult(value) {
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
}

function processIdentity(agent) {
  const executable = agent === "codex" ? "codex.exe" : "claude.exe";
  return {
    platform: "win32",
    collected_at: fixedNow.toISOString(),
    server_pid: 4000,
    server_parent_pid: 3000,
    observed_agent: agent,
    chain: [
      {
        depth: 0,
        pid: 4000,
        parent_pid: 3000,
        executable_name: "node.exe",
        executable_version: "24.18.0",
        executable_path_sha256: "1".repeat(64),
      },
      {
        depth: 1,
        pid: 3000,
        parent_pid: 2000,
        executable_name: executable,
        executable_version: "1.2.3",
        executable_path_sha256: "2".repeat(64),
      },
    ],
  };
}

function legacyProof(agent, overrides = {}) {
  return {
    agent,
    status: "verified",
    client_surface: `${agent} direct MCP`,
    tool_discovery_mode: "exact_single_name",
    required_tools: CLIENT_MCP_REQUIRED_TOOLS,
    verified_tools: CLIENT_MCP_REQUIRED_TOOLS,
    missing_tools: [],
    proof_source: agent === "codex" ? "codex_desktop_direct_mcp" : "claude_code_direct_mcp",
    generated_at: fixedNow.toISOString(),
    ...overrides,
  };
}

function writeRootProof(dataRoot, name, value) {
  const filePath = path.join(dataRoot, ".dino", "proofs", "client-mcp", `${name}.json`);
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  return filePath;
}

async function inTemp(fn) {
  const rootPath = mkdtempSync(path.join(tmpdir(), "dinobrain-client-mcp-v2-"));
  const dataRoot = path.join(rootPath, "data");
  const localStateRoot = path.join(rootPath, "local-identity");
  mkdirSync(dataRoot, { recursive: true });
  try {
    return await fn({ rootPath, dataRoot, localStateRoot });
  } finally {
    rmSync(rootPath, { recursive: true, force: true });
  }
}

async function capture(runtime, tool, input, value) {
  return runtime.captureToolCall(tool, input, async () => jsonResult(value));
}

async function createVerifiedProof(dataRoot, localStateRoot, agent, options = {}) {
  const challengeTime = options.challengeTime ?? new Date(fixedNow.getTime() - 60_000);
  const runtimeTime = options.runtimeTime ?? fixedNow;
  const issued = await createClientMcpProofChallenge(dataRoot, agent, {
    localStateRoot,
    now: challengeTime,
    ttlMs: 60 * 60 * 1000,
  });
  const runtime = new ClientMcpProofRuntime(dataRoot, {
    localStateRoot,
    now: runtimeTime,
    getClientInfo: () => ({ name: `${agent}-mcp-client`, version: "1.2.3" }),
    observeProcessIdentity: async () => options.processIdentity ?? processIdentity(agent),
  });
  await runtime.begin(issued.challenge.challenge_id);
  const taskId = `task-${agent}-proof`;
  const sequence = options.sequence ?? CLIENT_MCP_REQUIRED_TOOLS;
  for (const tool of sequence) {
    if (tool === "os_begin_task") await capture(runtime, tool, { request: issued.challenge.challenge_id }, { ok: true, task_id: taskId });
    else if (tool === "get_context_pack") await capture(runtime, tool, { task_id: taskId, question: "proof" }, { ok: true, task_id: taskId, item_count: 1 });
    else if (tool === "wiki_search") await capture(runtime, tool, { query: "proof" }, { ok: true, result_count: 1 });
    else if (tool === "search_memory") await capture(runtime, tool, { query: "proof" }, { ok: true, result_count: 1 });
    else if (tool === "finish_task") await capture(runtime, tool, { task_id: taskId, summary: "proof" }, { ok: true, task_id: taskId });
    else await capture(runtime, tool, {}, { ok: true });
  }
  const finalized = await runtime.finalize(issued.challenge.challenge_id);
  return { issued, runtime, finalized };
}

async function status(dataRoot, localStateRoot, now = fixedNow) {
  return buildClientMcpDirectStatus(dataRoot, {
    localStateRoot,
    now,
    staleAfterMs: 60 * 60 * 1000,
  });
}

await inTemp(async ({ dataRoot, localStateRoot }) => {
  const challenges = await Promise.all(
    Array.from({ length: 24 }, () =>
      createClientMcpProofChallenge(dataRoot, "codex", {
        localStateRoot,
        now: fixedNow,
        ttlMs: 60 * 60 * 1000,
      }),
    ),
  );
  assert(new Set(challenges.map((item) => item.challenge.challenge_id)).size === 24, "parallel challenge ids collided");
  assert(
    new Set(challenges.map((item) => item.challenge.local_identity_fingerprint)).size === 1,
    "parallel challenge issuers did not share one fully written identity key",
  );
  const challengeDir = path.join(dataRoot, ".dino", "proofs", "client-mcp", "challenges");
  assert(readdirSync(challengeDir).filter((name) => name.endsWith(".json")).length === 24, "parallel challenge files were lost");
});

await inTemp(async ({ dataRoot, localStateRoot }) => {
  await createVerifiedProof(dataRoot, localStateRoot, "codex");
  await createVerifiedProof(dataRoot, localStateRoot, "claude");
  writeRootProof(dataRoot, "codex-legacy-history", legacyProof("codex", { generated_at: "2026-07-07T00:00:00.000Z" }));
  const report = await status(dataRoot, localStateRoot);
  assert(report.status === "verified", "both challenge-bound real clients should verify");
  assert(report.release_parity_verified === true, "release parity flag should be true");
  assert(report.counts.verified === 2, "both agents should be verified");
  assert(report.required_tools.includes("get_context_pack"), "get_context_pack must be required");
  assert(report.agents.every((agent) => agent.proof_version === "client_mcp_direct_proof_v2"), "v2 proof version missing");
  assert(report.agents.every((agent) => agent.client_process_chain.length === 2), "process evidence missing");
  assert(report.counts.invalid_proofs === 1, "legacy proof should remain classified without replacing fresh v2 evidence");
  assert(report.warnings.length === 0, "superseded legacy proof must not block fresh two-client parity");
});

await inTemp(async ({ dataRoot, localStateRoot }) => {
  await createVerifiedProof(dataRoot, localStateRoot, "codex");
  writeRootProof(dataRoot, "claude-not-configured", {
    agent: "claude",
    status: "not_configured",
    client_surface: "Claude Code installation probe",
    not_configured_reason: "claude_executable_not_found",
    generated_at: fixedNow.toISOString(),
  });
  const report = await status(dataRoot, localStateRoot);
  assert(report.status === "needs_recheck", "not_configured must not satisfy release parity");
  assert(report.agents.find((agent) => agent.agent === "claude")?.status === "not_configured", "diagnostic should remain visible");
  assert(report.warnings.includes("claude_not_configured_is_not_release_parity"), "release warning missing");
});

await inTemp(async ({ dataRoot, localStateRoot }) => {
  writeRootProof(dataRoot, "codex-hand-authored", legacyProof("codex"));
  writeRootProof(dataRoot, "claude-hand-authored", legacyProof("claude"));
  const report = await status(dataRoot, localStateRoot);
  assert(report.status === "needs_recheck", "hand-authored legacy JSON must be rejected");
  assert(report.counts.invalid_proofs === 2, "legacy proofs should be classified invalid");
});

await inTemp(async ({ dataRoot, localStateRoot }) => {
  const issued = await createClientMcpProofChallenge(dataRoot, "codex", {
    localStateRoot,
    now: fixedNow,
    ttlMs: 60 * 60 * 1000,
  });
  const runtime = new ClientMcpProofRuntime(dataRoot, {
    localStateRoot,
    now: fixedNow,
    getClientInfo: () => ({ name: "codex", version: "1.0.0" }),
    observeProcessIdentity: async () => ({ ...processIdentity("claude"), observed_agent: "claude" }),
  });
  let rejected = false;
  try {
    await runtime.begin(issued.challenge.challenge_id);
  } catch (error) {
    rejected = String(error).includes("real client process mismatch");
  }
  assert(rejected, "spoofed clientInfo without matching real process ancestry must fail");
});

await inTemp(async ({ dataRoot, localStateRoot }) => {
  const issued = await createClientMcpProofChallenge(dataRoot, "codex", {
    localStateRoot,
    now: fixedNow,
    ttlMs: 60 * 60 * 1000,
  });
  const runtime = new ClientMcpProofRuntime(dataRoot, {
    localStateRoot,
    now: fixedNow,
    getClientInfo: () => ({ name: "generic-mcp-client", version: "1.0.0" }),
    observeProcessIdentity: async () => processIdentity("codex"),
  });
  let rejected = false;
  try {
    await runtime.begin(issued.challenge.challenge_id);
  } catch (error) {
    rejected = String(error).includes("clientInfo does not identify codex");
  }
  assert(rejected, "matching process name without matching MCP initialize clientInfo must fail");
});

await inTemp(async ({ dataRoot, localStateRoot }) => {
  let rejected = false;
  try {
    await createVerifiedProof(dataRoot, localStateRoot, "codex", {
      sequence: CLIENT_MCP_REQUIRED_TOOLS.filter((tool) => tool !== "get_context_pack"),
    });
  } catch (error) {
    rejected = String(error).includes("get_context_pack");
  }
  assert(rejected, "missing get_context_pack invocation must fail finalize");
});

await inTemp(async ({ dataRoot, localStateRoot }) => {
  const completed = await createVerifiedProof(dataRoot, localStateRoot, "codex");
  const replayRuntime = new ClientMcpProofRuntime(dataRoot, {
    localStateRoot,
    now: fixedNow,
    getClientInfo: () => ({ name: "codex", version: "1.0.0" }),
    observeProcessIdentity: async () => processIdentity("codex"),
  });
  let rejected = false;
  try {
    await replayRuntime.begin(completed.issued.challenge.challenge_id);
  } catch (error) {
    rejected = String(error).includes("not reusable");
  }
  assert(rejected, "finalized challenge replay must fail");
});

await inTemp(async ({ dataRoot, localStateRoot }) => {
  const codex = await createVerifiedProof(dataRoot, localStateRoot, "codex");
  await createVerifiedProof(dataRoot, localStateRoot, "claude");
  const proof = JSON.parse(readFileSync(path.join(dataRoot, codex.finalized.proof_path), "utf8"));
  const receiptFile = path.join(dataRoot, proof.receipt_path);
  const ledger = JSON.parse(readFileSync(receiptFile, "utf8"));
  ledger.receipts[0].result_sha256 = "0".repeat(64);
  writeFileSync(receiptFile, `${JSON.stringify(ledger, null, 2)}\n`, "utf8");
  const report = await status(dataRoot, localStateRoot);
  assert(report.status === "needs_recheck", "receipt tampering must invalidate parity");
  assert(report.agents.find((agent) => agent.agent === "codex")?.reason.includes("receipt"), "receipt tamper reason missing");
});

await inTemp(async ({ dataRoot, localStateRoot }) => {
  const codex = await createVerifiedProof(dataRoot, localStateRoot, "codex");
  await createVerifiedProof(dataRoot, localStateRoot, "claude");
  const proofFile = path.join(dataRoot, codex.finalized.proof_path);
  const proof = JSON.parse(readFileSync(proofFile, "utf8"));
  proof.client_info.version = "forged";
  writeFileSync(proofFile, `${JSON.stringify(proof, null, 2)}\n`, "utf8");
  const report = await status(dataRoot, localStateRoot);
  assert(report.status === "needs_recheck", "proof payload tampering must invalidate parity");
  assert(report.agents.find((agent) => agent.agent === "codex")?.reason === "proof_sha256_mismatch", "proof tamper reason missing");
});

await inTemp(async ({ dataRoot, localStateRoot, rootPath }) => {
  await createVerifiedProof(dataRoot, localStateRoot, "codex");
  await createVerifiedProof(dataRoot, localStateRoot, "claude");
  const foreignLocalRoot = path.join(rootPath, "foreign-identity");
  await createClientMcpProofChallenge(path.join(rootPath, "foreign-data"), "codex", {
    localStateRoot: foreignLocalRoot,
    now: fixedNow,
  });
  const report = await status(dataRoot, foreignLocalRoot);
  assert(report.status === "needs_recheck", "proof from another local identity must fail");
  assert(report.agents.every((agent) => agent.reason.includes("foreign_or_replaced")), "foreign identity reason missing");
});

await inTemp(async ({ dataRoot, localStateRoot }) => {
  const old = new Date(fixedNow.getTime() - 2 * 60 * 60 * 1000);
  await createVerifiedProof(dataRoot, localStateRoot, "codex", { challengeTime: old, runtimeTime: old });
  await createVerifiedProof(dataRoot, localStateRoot, "claude", { challengeTime: old, runtimeTime: old });
  const report = await status(dataRoot, localStateRoot, fixedNow);
  assert(report.status === "needs_recheck", "stale proofs must fail");
});

await inTemp(async ({ dataRoot, localStateRoot }) => {
  await createVerifiedProof(dataRoot, localStateRoot, "codex");
  await createVerifiedProof(dataRoot, localStateRoot, "claude");
  const written = await buildAndWriteClientMcpDirectStatus(dataRoot, { now: fixedNow, localStateRoot });
  assert(written.report.status === "verified", "written report should be verified");
  assert(written.path.replace(/\\/g, "/").endsWith(CLIENT_MCP_DIRECT_STATUS_RELATIVE_PATH), "status path mismatch");
});

console.log("client MCP direct v2 challenge verification ok");
