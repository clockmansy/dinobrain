import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataRoot = mkdtempSync(path.join(tmpdir(), "dinobrain-observatory-graph-"));
const port = 3900 + Math.floor(Math.random() * 400);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      env: { ...process.env, DINOBRAIN_DATA_DIR: dataRoot },
      stdio: ["ignore", "pipe", "pipe"],
      ...options,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${command} ${args.join(" ")} failed with ${code}\n${stdout}\n${stderr}`));
    });
  });
}

function waitForServer(child) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Observatory did not start in time")), 10000);
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk;
      if (output.includes(`http://127.0.0.1:${port}/`)) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.stderr.on("data", (chunk) => {
      output += chunk;
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`Observatory exited early with ${code}\n${output}`));
    });
  });
}

try {
  mkdirSync(path.join(dataRoot, "20_Wiki"), { recursive: true });
  mkdirSync(path.join(dataRoot, ".dino", "state"), { recursive: true });
  mkdirSync(path.join(dataRoot, ".dino", "index"), { recursive: true });
  mkdirSync(path.join(dataRoot, ".dino", "audits"), { recursive: true });
  mkdirSync(path.join(dataRoot, ".dino", "tasks"), { recursive: true });
  mkdirSync(path.join(dataRoot, ".dino", "events"), { recursive: true });
  const writeJson = (relativePath, value) => {
    writeFileSync(path.join(dataRoot, ...relativePath.split("/")), `${JSON.stringify(value, null, 2)}\n`, "utf8");
  };
  writeFileSync(
    path.join(dataRoot, "20_Wiki", "Graph-Speed.md"),
    `---
title: Graph Speed
summary: The live graph should expose Obsidian-style nodes and links.
tags: [graph, obsidian]
---

# Graph Speed

This note links to [[Context Pack]].
`,
  );
  writeFileSync(
    path.join(dataRoot, "20_Wiki", "Context Pack.md"),
    `---
title: Context Pack
summary: Context packs should be visible in the graph.
tags: [context-pack]
---

# Context Pack
`,
  );
  writeFileSync(
    path.join(dataRoot, ".dino", "tasks", "task-active-observatory.json"),
    `${JSON.stringify(
      {
        task_id: "task-active-observatory",
        status: "started",
        request: "Verify active tasks appear in the DinoBrain Fossil Graph.",
        project: "observatory-verify",
        mode: "standard",
        sensitivity: "unknown",
        created_at: "2026-07-01T00:00:00.000Z",
        updated_at: "2026-07-01T00:00:00.000Z",
        data_root: dataRoot,
        sync_policy: "blocked_until_review",
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  writeFileSync(
    path.join(dataRoot, ".dino", "events", "2026-07-01.jsonl"),
    `${JSON.stringify({
      event: "task_started",
      task_id: "task-active-observatory",
      at: "2026-07-01T00:00:00.000Z",
      path: ".dino/tasks/task-active-observatory.json",
    })}\n`,
    "utf8",
  );
  writeJson(".dino/index/graph-health.json", {
    version: "graph_health_v1",
    status: "healthy",
    score: 100,
    generated_at: "2026-07-01T00:00:00.000Z",
    indexed_record_count: 2,
    node_count: 4,
    edge_count: 2,
    warnings: [],
  });
  writeJson(".dino/state/client_mcp_direct_status.json", {
    status: "needs_attention",
    generated_at: "2026-07-01T00:00:00.000Z",
    agents: [
      {
        agent: "codex",
        status: "needs_recheck",
        required_tools: ["os_begin_task", "search_memory", "wiki_search", "finish_task"],
        verified_tools: ["os_begin_task"],
        missing_tools: ["search_memory", "wiki_search", "finish_task"],
        proof_path: null,
        stale_after_ms: 86400000,
        latest_verified_at: null,
      },
    ],
    warnings: ["codex_direct_mcp_not_verified"],
  });
  writeJson(".dino/state/native_instruction_authority.json", {
    status: "healthy",
    generated_at: "2026-07-01T00:00:00.000Z",
    latest_verified_at: "2026-07-01T00:00:00.000Z",
    warnings: [],
  });
  writeJson(".dino/state/source_lineage_status.json", {
    status: "healthy",
    generated_at: "2026-07-01T00:00:00.000Z",
    latest_verified_at: "2026-07-01T00:00:00.000Z",
    counts: { verified_source_chunks: 1, blockers: 0 },
    warnings: [],
  });
  writeJson(".dino/state/behavior_recall_status.json", {
    status: "healthy",
    generated_at: "2026-07-01T00:00:00.000Z",
    latest_verified_at: "2026-07-01T00:00:00.000Z",
    counts: { entries: 1, completion: 1, handoff: 0, error: 0, direction_change: 0, correction: 0, blockers: 0 },
    warnings: [],
  });
  writeJson(".dino/state/task_sessions.json", {
    status: "healthy",
    generated_at: "2026-07-01T00:00:00.000Z",
    latest_verified_at: "2026-07-01T00:00:00.000Z",
    counts: { blockers: 0 },
    warnings: [],
  });
  writeJson(".dino/state/task_lifecycle_settlement.json", {
    status: "healthy",
    generated_at: "2026-07-01T00:00:00.000Z",
    latest_verified_at: "2026-07-01T00:00:00.000Z",
    counts: { finish_gate_repairs_before: 0 },
    warnings: [],
  });
  writeJson(".dino/state/rag_proof_status.json", {
    status: "healthy",
    generated_at: "2026-07-01T00:00:00.000Z",
    dense_vector: { provider: "local_text_hashing_v1", dimensions: 128, semantic_embedding_provider: false },
    warnings: ["local_text_hashing_vectors_are_not_external_embedding_provider"],
  });
  writeJson(".dino/state/rag_eval_status.json", {
    status: "healthy",
    generated_at: "2026-07-01T00:00:00.000Z",
    caveats: ["This is a deterministic RAG canary, not a full Ragas/LLM-judge answer-quality evaluation yet."],
    warnings: [],
  });
  writeJson(".dino/state/live_semantic_query_status.json", {
    status: "needs_attention",
    generated_at: "2026-07-01T00:00:00.000Z",
    proof: {
      status: "existing_query_vector",
      query_vector_preexisting: true,
      on_the_fly_query_embedding: false,
    },
    retrieval: {
      mode: "hybrid_contextual_v2",
      dense_reason_count: 1,
    },
    warnings: ["query_vector_was_precomputed_not_live"],
  });
  writeJson(".dino/state/health_status.json", {
    status: "healthy",
    generated_at: "2026-07-01T00:00:00.000Z",
    latest_verified_at: "2026-07-01T00:00:00.000Z",
    checks: [
      { id: "client_mcp_direct_status", artifact_path: ".dino/state/client_mcp_direct_status.json", status: "needs_attention" },
      { id: "rag_proof", artifact_path: ".dino/state/rag_proof_status.json", status: "healthy" },
      { id: "live_semantic_query", artifact_path: ".dino/state/live_semantic_query_status.json", status: "needs_attention" },
    ],
    warnings: [],
  });
  writeJson(".dino/audits/audit-observatory-readiness.json", {
    audit_id: "audit-observatory-readiness",
    task_id: "task-active-observatory",
    audited_at: "2026-07-01T00:00:00.000Z",
    trust_score: 72,
    verdict: "medium",
    provided_memory_paths: ["20_Wiki/Graph-Speed.md"],
    declared_used_memory_paths: ["20_Wiki/Graph-Speed.md"],
    observed_used_memory_paths: ["20_Wiki/Graph-Speed.md"],
    missing_expected_memory: [],
    hallucinated_memory_reference: [],
  });

  await run(process.execPath, [path.join(root, "dist", "build-sqlite-shards.js")]);
  const server = spawn(process.execPath, [path.join(root, "scripts", "dinobrain-observatory.mjs"), `--port=${port}`], {
    cwd: root,
    env: { ...process.env, DINOBRAIN_DATA_DIR: dataRoot },
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    await waitForServer(server);
    const graph = await fetch(`http://127.0.0.1:${port}/api/graph`).then((response) => response.json());
    assert(graph.ok === true, "Graph endpoint did not return ok=true");
    assert(graph.stats.records >= 2, "Graph did not include seeded records");
    assert(graph.nodes.some((node) => node.label === "Graph Speed"), "Graph Speed node missing");
    assert(graph.edges.some((edge) => edge.type === "wiki_link"), "wiki_link edge missing");
    assert(graph.stats.active_tasks === 1, "Graph did not report active task count");
    assert(graph.nodes.some((node) => node.type === "active_task"), "Graph did not include active task node");
    assert(graph.edges.some((edge) => edge.type === "active_task"), "Graph did not include active task edge");
    const state = await fetch(`http://127.0.0.1:${port}/api/state`).then((response) => response.json());
    assert(state.ok === true, "State endpoint did not return ok=true");
    assert(state.summary.active_task_count === 1, "State endpoint did not report active task count");
    assert(state.graph_health && typeof state.graph_health.score === "number", "State endpoint did not include graph health");
    assert(state.lifecycle && state.lifecycle.counts, "State endpoint did not include node lifecycle");
    assert(state.read_trace && state.read_trace.status, "State endpoint did not include read trace");
    assert(state.sync_risk && state.sync_risk.status, "State endpoint did not include sync risk");
    const health = await fetch(`http://127.0.0.1:${port}/api/health`).then((response) => response.json());
    assert(health.ok === true && health.observatory_version, "Health endpoint did not report Observatory version");
    assert(health.graph_health && typeof health.graph_health.score === "number", "Health endpoint did not include graph health");
    assert(health.endpoints.includes("/api/readiness"), "Health endpoint did not list readiness endpoint");
    const readiness = await fetch(`http://127.0.0.1:${port}/api/readiness`).then((response) => response.json());
    assert(readiness.ok === false, "Readiness should fail while direct MCP and semantic RAG blockers exist");
    assert(readiness.health_status && Array.isArray(readiness.health_status.checks), "Readiness did not expose health checks");
    assert(readiness.client_mcp_direct_status?.agents?.length === 1, "Readiness did not expose direct MCP agents");
    assert(
      readiness.lanes.blockers.some((gate) => gate.id === "client_mcp_direct_status"),
      "Readiness did not expose direct MCP blocker",
    );
    assert(
      readiness.lanes.blockers.some((gate) => gate.id === "rag_completion_grade" && gate.blocker_reason === "rag_semantic_provider_not_configured"),
      "Readiness did not expose semantic RAG blocker",
    );
    assert(
      readiness.lanes.blockers.some((gate) => gate.id === "live_semantic_query" && gate.blocker_reason === "live_semantic_query_not_healthy"),
      "Readiness did not expose live semantic query blocker",
    );
    assert(readiness.live_semantic_query_status?.blocker === "live_semantic_query_not_healthy", "Live semantic query readiness status missing");
    assert(readiness.lanes.verifier_pending.some((item) => item.id === "answer_quality_eval"), "Answer-quality pending lane missing");
    assert(readiness.lanes.verifier_pending.some((item) => item.id === "live_semantic_query"), "Live semantic query pending lane missing");
    assert(readiness.latest_audit?.trust_score === 72, "Readiness did not expose latest audit trust score");
    assert(readiness.latest_audit?.provided_memory_paths?.includes("20_Wiki/Graph-Speed.md"), "Audit provided paths missing");
    const html = await fetch(`http://127.0.0.1:${port}/`).then((response) => response.text());
    assert(html.includes("Completion Readiness"), "UI does not include readiness block");
    assert(html.includes("readiness-blockers"), "UI does not include blocker lane container");
    assert(html.includes("readiness-audit-paths"), "UI does not include audit path container");
    writeFileSync(path.join(dataRoot, ".dino", "state", "native_instruction_authority.json"), "{ bad json\n", "utf8");
    const invalidReadiness = await fetch(`http://127.0.0.1:${port}/api/readiness`).then((response) => response.json());
    assert(
      invalidReadiness.lanes.blockers.some(
        (gate) => gate.id === "native_instruction_authority" && gate.artifact_parse_status === "invalid_json",
      ),
      "Invalid status JSON did not surface as readiness blocker",
    );
    const graphHealth = await fetch(`http://127.0.0.1:${port}/api/graph-health`).then((response) => response.json());
    assert(graphHealth.ok === true && typeof graphHealth.score === "number", "Graph health endpoint did not return health");
    console.log("observatory live graph verification ok");
  } finally {
    server.kill();
  }
} finally {
  rmSync(dataRoot, { recursive: true, force: true });
}
