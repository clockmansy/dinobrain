import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DINOBRAIN_VERSION } from "./lib/version-manifest.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { publishStatusGeneration, STATUS_GENERATION_ARTIFACT_PATHS } = await import(
  pathToFileURL(path.join(root, "dist", "status-generation.js")).href
);
const dataRoot = mkdtempSync(path.join(tmpdir(), "dinobrain-observatory-graph-"));
const port = 3900 + Math.floor(Math.random() * 400);
const cacheTtlMs = 100;
const statePayloadBudgetBytes = 256 * 1024;

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
  mkdirSync(path.join(dataRoot, ".dino", "context-packs"), { recursive: true });
  mkdirSync(path.join(dataRoot, ".dino", "traces"), { recursive: true });
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
        diagnostic_blob: "x".repeat(320 * 1024),
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
  writeJson(".dino/context-packs/pack-observatory-memory.json", {
    pack_id: "pack-observatory-memory",
    task_id: "task-active-observatory",
    question: "Verify live graph memory relationships",
    created_at: "2026-07-01T00:00:01.000Z",
    item_count: 1,
    items: [
      {
        path: "50_Instances/accepted/observatory-memory-rule.json",
        kind: "curated_record",
        title: "Observatory Memory Rule",
        summary: "The live graph should expose context-pack and trace relationships to used memory.",
        score: 9.2,
      },
    ],
  });
  writeJson(".dino/traces/task-active-observatory.json", {
    task_id: "task-active-observatory",
    outcome: "completed",
    summary: "Finished the Observatory graph verification task.",
    growth_policy: "trace_only",
    changed_files: ["scripts/dinobrain-observatory.mjs"],
    decisions: ["Graph edges should reveal context-pack and trace memory use."],
    next_steps: [],
    used_memory_paths: ["50_Instances/accepted/observatory-memory-rule.json"],
    context_pack_paths: [".dino/context-packs/pack-observatory-memory.json"],
    session_archive_paths: [],
    candidate_paths: [],
    finished_at: "2026-07-01T00:00:02.000Z",
  });
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
  writeJson(".dino/state/node_lifecycle.json", {
    version: "node_lifecycle_report_v3",
    status: "healthy",
    generated_at: "2026-07-01T00:00:00.000Z",
    counts: {
      accepted: 1,
      retrievable_accepted: 1,
      held_or_excluded: 0,
      lifecycle_blockers: 0,
      deferred_candidate_backlog: 0,
      promotion_reviews: 0,
    },
    post_audit: { invalid: [] },
  });
  writeJson(".dino/state/review_queue_backpressure.json", {
    version: "review_queue_backpressure_v1",
    status: "healthy",
    generated_at: "2026-07-01T00:00:00.000Z",
    growth_mode: "bounded_hot_queue",
    counts: {
      hot_review_units: 2,
      cold_candidates: 3,
      deterministic_hold_pending: 1,
      pending_merge_reviews: 1,
    },
    warnings: [],
  });
  writeJson(".dino/state/cold_partitions.json", {
    version: "cold_partition_index_v1",
    status: "healthy",
    generated_at: "2026-07-01T00:00:00.000Z",
    counts: { partitions: 1 },
    warnings: [],
  });
  writeJson(".dino/state/rag_proof_status.json", {
    status: "healthy",
    generated_at: "2026-07-01T00:00:00.000Z",
    dense_vector: { provider: "local_text_hashing_v1", dimensions: 128, semantic_embedding_provider: false },
    warnings: ["local_text_hashing_vectors_are_not_external_embedding_provider"],
  });
  writeJson(".dino/state/vector_index_migration.json", {
    status: "same_identity_updated",
    generated_at: "2026-07-01T00:00:00.000Z",
    migration_required: false,
    migration_id: null,
    manifest_path: null,
    warnings: [],
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
  writeJson(".dino/state/answer_quality_status.json", {
    status: "needs_attention",
    generated_at: "2026-07-01T00:00:00.000Z",
    evaluator: "local_paired_answer_quality_judge_v1",
    evaluator_class: "ragas_like_local",
    counts: { cases: 1, passed: 0, failed: 1 },
    metrics: {
      faithfulness: 0.5,
      answer_relevance: 0.5,
      correctness: 0.5,
      grounding: 0.25,
      source_support: 0.25,
      forbidden_memory_avoidance: 1,
      noise_budget: 1,
      average_memory_lift: 10,
      p95_latency_ms: 4,
    },
    warnings: ["answer_quality_cases_failed"],
  });
  writeJson(".dino/state/release_manifest_status.json", {
    status: "healthy",
    generated_at: "2026-07-01T00:00:00.000Z",
    package_version: DINOBRAIN_VERSION,
    authoritative_version: DINOBRAIN_VERSION,
    version_aligned: true,
    expected_tag: `v${DINOBRAIN_VERSION}`,
    tag: { exists: true, target: "abc", matches_app_head: true },
    assets: { zip_exists: true, sha_exists: true, sha256_matches: true },
    blockers: [],
    warnings: ["github_release_asset_not_checked_without_token"],
  });
  writeJson(".dino/state/health_status.json", {
    status: "healthy",
    generated_at: "2026-07-01T00:00:00.000Z",
    latest_verified_at: "2026-07-01T00:00:00.000Z",
    checks: [
      { id: "client_mcp_direct_status", artifact_path: ".dino/state/client_mcp_direct_status.json", status: "needs_attention" },
      { id: "rag_proof", artifact_path: ".dino/state/rag_proof_status.json", status: "healthy" },
      { id: "live_semantic_query", artifact_path: ".dino/state/live_semantic_query_status.json", status: "needs_attention" },
      { id: "answer_quality", artifact_path: ".dino/state/answer_quality_status.json", status: "needs_attention" },
      { id: "release_manifest", artifact_path: ".dino/state/release_manifest_status.json", status: "healthy" },
      { id: "node_lifecycle", artifact_path: ".dino/state/node_lifecycle.json", status: "healthy" },
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
  await publishStatusGeneration(dataRoot, {
    artifactPaths: STATUS_GENERATION_ARTIFACT_PATHS.filter((relativePath) =>
      existsSync(path.join(dataRoot, ...relativePath.split("/"))),
    ),
  });
  const server = spawn(process.execPath, [path.join(root, "scripts", "dinobrain-observatory.mjs"), `--port=${port}`], {
    cwd: root,
    env: {
      ...process.env,
      DINOBRAIN_DATA_DIR: dataRoot,
      DINOBRAIN_OBSERVATORY_CACHE_TTL_MS: String(cacheTtlMs),
      DINOBRAIN_OBSERVATORY_SOURCE_STAT_TTL_MS: "100",
    },
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
    assert(graph.nodes.some((node) => node.type === "context_pack"), "Graph did not include context pack node");
    assert(graph.nodes.some((node) => node.type === "trace"), "Graph did not include finish trace node");
    assert(
      graph.nodes.some((node) => node.type === "memory_ref" && node.path === "50_Instances/accepted/observatory-memory-rule.json"),
      "Graph did not include referenced memory node",
    );
    assert(graph.edges.some((edge) => edge.type === "uses_context"), "Graph did not connect task to context pack");
    assert(graph.edges.some((edge) => edge.type === "finish_trace"), "Graph did not connect task to trace");
    assert(graph.edges.some((edge) => edge.type === "retrieves_memory"), "Graph did not connect context pack to memory");
    assert(graph.edges.some((edge) => edge.type === "used_memory"), "Graph did not connect trace to used memory");
    assert(graph.stats.memory_edges >= 2, "Graph did not count memory edges");
    const stateResponse = await fetch(`http://127.0.0.1:${port}/api/state`);
    const stateText = await stateResponse.text();
    const stateBytes = Buffer.byteLength(stateText, "utf8");
    const state = JSON.parse(stateText);
    assert(state.ok === true, "State endpoint did not return ok=true");
    assert(stateBytes < statePayloadBudgetBytes, `State payload exceeded 256KB: ${stateBytes} bytes`);
    assert(state.payload?.within_budget === true, "State payload did not report itself within budget");
    assert(!stateText.includes("diagnostic_blob"), "State projection leaked an unbounded task field");
    assert(state.summary.active_task_count === 1, "State endpoint did not report active task count");
    assert(state.graph_health && typeof state.graph_health.score === "number", "State endpoint did not include graph health");
    assert(state.lifecycle && state.lifecycle.counts, "State endpoint did not include node lifecycle");
    assert(state.lifecycle.node_status === "healthy", "State endpoint did not expose healthy node lifecycle status");
    assert(state.lifecycle.counts.retrievable_accepted === 1, "State endpoint did not expose retrievable accepted count");
    assert(
      state.lifecycle.retry_candidates.some((item) => item._path === ".dino/state/review_queue_backpressure.json"),
      "Lifecycle retry summaries were not derived from state artifacts",
    );
    assert(state.read_trace && state.read_trace.status, "State endpoint did not include read trace");
    assert(state.sync_risk && state.sync_risk.status, "State endpoint did not include sync risk");
    const health = await fetch(`http://127.0.0.1:${port}/api/health`).then((response) => response.json());
    assert(health.ok === true && health.observatory_version, "Health endpoint did not report Observatory version");
    assert(health.graph_health && typeof health.graph_health.score === "number", "Health endpoint did not include graph health");
    assert(health.endpoints.includes("/api/readiness"), "Health endpoint did not list readiness endpoint");
    assert(health.endpoints.includes("/api/snapshot"), "Health endpoint did not list snapshot endpoint");
    assert(health.cache?.resources?.state && health.cache?.resources?.snapshot, "Health endpoint did not expose cache counters");
    assert(typeof health.resources?.json_files_read === "number", "Health endpoint did not expose resource counters");
    const readiness = await fetch(`http://127.0.0.1:${port}/api/readiness`).then((response) => response.json());
    assert(readiness.ok === false, "Readiness should fail while direct MCP and semantic RAG blockers exist");
    assert(readiness.version === "readiness_v2" && readiness.gates.length === 12, "Canonical 12-gate readiness model missing");
    assert(health.readiness?.parity_hash === readiness.parity_hash, "Health/readiness parity hash mismatch");
    assert(readiness.health_status && Array.isArray(readiness.health_status.checks), "Readiness did not expose health checks");
    assert(readiness.node_lifecycle_status?.status === "healthy", "Readiness did not expose node lifecycle status");
    assert(readiness.client_mcp_direct_status?.agents?.length === 1, "Readiness did not expose direct MCP agents");
    assert(
      readiness.lanes.blockers.some(
        (gate) => gate.id === "HG-02" && gate.reason_codes.some((reason) => reason.includes("client_mcp_direct_status")),
      ),
      "Readiness did not expose direct MCP blocker",
    );
    assert(
      readiness.lanes.blockers.some(
        (gate) => gate.id === "HG-04" && gate.reason_codes.some((reason) => reason.includes("rag_proof")),
      ),
      "Readiness did not expose semantic RAG blocker",
    );
    assert(
      readiness.lanes.blockers.some(
        (gate) => gate.id === "HG-04" && gate.reason_codes.some((reason) => reason.includes("live_semantic_query")),
      ),
      "Readiness did not expose live semantic query blocker",
    );
    assert(
      readiness.lanes.blockers.some(
        (gate) => gate.id === "HG-04" && gate.reason_codes.some((reason) => reason.includes("answer_quality")),
      ),
      "Readiness did not expose answer-quality blocker",
    );
    assert(readiness.live_semantic_query_status?.blocker?.includes("live_semantic_query"), "Live semantic query readiness status missing");
    assert(readiness.answer_quality_status?.status === "needs_attention", "Answer-quality readiness status missing");
    assert(readiness.vector_index_migration_status?.status === "same_identity_updated", "Vector migration readiness status missing");
    assert(readiness.release_manifest_status?.status === "healthy", "Release manifest readiness status missing");
    assert(readiness.latest_audit?.trust_score === 72, "Readiness did not expose latest audit trust score");
    assert(readiness.latest_audit?.provided_memory_paths?.includes("20_Wiki/Graph-Speed.md"), "Audit provided paths missing");
    const snapshot = await fetch(`http://127.0.0.1:${port}/api/snapshot`).then((response) => response.json());
    assert(snapshot.ok === true, "Snapshot endpoint did not return ok=true");
    assert(snapshot.state?.summary?.active_task_count === 1, "Snapshot did not include state");
    assert(snapshot.graph?.nodes?.some((node) => node.type === "active_task"), "Snapshot did not include graph activity");
    assert(snapshot.readiness?.lanes?.blockers, "Snapshot did not include readiness");
    assert(
      snapshot.payload?.within_budget === true && snapshot.payload.serialized_bytes < 256 * 1024,
      "Snapshot exceeded the bounded 256 KiB payload budget",
    );
    const html = await fetch(`http://127.0.0.1:${port}/`).then((response) => response.text());
    assert(html.includes("Completion Readiness"), "UI does not include readiness block");
    assert(html.includes("graph-cluster-label"), "UI does not include graph cluster labels");
    assert(html.includes("Live loop"), "UI does not include live graph cluster label");
    assert(html.includes("memory links"), "UI does not include memory link statistics");
    assert(html.includes("readiness-blockers"), "UI does not include blocker lane container");
    assert(html.includes("readiness-audit-paths"), "UI does not include audit path container");
    assert(html.includes('fetch("/api/snapshot"'), "UI does not use the combined snapshot endpoint");
    assert(!html.includes("setInterval("), "UI still uses overlapping interval polling");
    assert(html.includes("if (pollInFlight) return;"), "UI does not guard against overlapping polls");
    const pollIntervalMatch = html.match(/const pollIntervalMs = (\d+);/);
    assert(Number(pollIntervalMatch?.[1] ?? 0) >= 3000, "UI polling interval is below 3000ms");
    assert(html.includes("window.setTimeout(tick, pollIntervalMs)"), "UI does not schedule recursive polling after completion");

    const stateCacheBefore = await fetch(`http://127.0.0.1:${port}/api/health`).then((response) => response.json());
    await new Promise((resolve) => setTimeout(resolve, cacheTtlMs + 50));
    await Promise.all(
      Array.from({ length: 10 }, () => fetch(`http://127.0.0.1:${port}/api/state`).then((response) => response.json())),
    );
    const stateCacheAfter = await fetch(`http://127.0.0.1:${port}/api/health`).then((response) => response.json());
    assert(
      stateCacheAfter.cache.resources.state.loads === stateCacheBefore.cache.resources.state.loads + 1,
      "Concurrent state requests performed duplicate state builds",
    );
    assert(
      stateCacheAfter.cache.resources.state.coalesced > stateCacheBefore.cache.resources.state.coalesced,
      "Concurrent state requests did not coalesce in flight",
    );

    const snapshotCacheBefore = stateCacheAfter;
    await new Promise((resolve) => setTimeout(resolve, cacheTtlMs + 50));
    const snapshots = await Promise.all(
      Array.from({ length: 10 }, () => fetch(`http://127.0.0.1:${port}/api/snapshot`).then((response) => response.json())),
    );
    assert(snapshots.every((entry) => entry.state?.ok === true && entry.graph && entry.readiness), "Coalesced snapshot response was incomplete");
    const snapshotCacheAfter = await fetch(`http://127.0.0.1:${port}/api/health`).then((response) => response.json());
    assert(
      snapshotCacheAfter.cache.resources.snapshot.loads === snapshotCacheBefore.cache.resources.snapshot.loads + 1,
      "Concurrent snapshot requests performed duplicate snapshot builds",
    );
    assert(
      (snapshotCacheAfter.cache.resources.snapshot.coalesced - snapshotCacheBefore.cache.resources.snapshot.coalesced) +
        (snapshotCacheAfter.cache.resources.snapshot.hits - snapshotCacheBefore.cache.resources.snapshot.hits) >= 9,
      "Concurrent snapshot requests neither coalesced nor reused the completed snapshot",
    );
    const graphHealth = await fetch(`http://127.0.0.1:${port}/api/graph-health`).then((response) => response.json());
    assert(graphHealth.ok === true && typeof graphHealth.score === "number", "Graph health endpoint did not return health");
    assert(graphHealth.readiness?.parity_hash === readiness.parity_hash, "Graph health/readiness parity hash mismatch");
    writeFileSync(path.join(dataRoot, ".dino", "state", "native_instruction_authority.json"), "{ bad json\n", "utf8");
    await new Promise((resolve) => setTimeout(resolve, 300));
    const invalidReadiness = await fetch(`http://127.0.0.1:${port}/api/readiness`).then((response) => response.json());
    assert(
      invalidReadiness.status_generation.reason_codes.includes(
        "source_generation_mismatch:.dino/state/native_instruction_authority.json",
      ) && invalidReadiness.gates.every((gate) => gate.status !== "PASS"),
      "Canonical status drift did not invalidate the published generation",
    );
    console.log("observatory live graph verification ok");
  } finally {
    if (server.exitCode === null) {
      server.kill();
      await new Promise((resolve) => server.once("exit", resolve));
    }
  }
} finally {
  rmSync(dataRoot, { recursive: true, force: true });
}
