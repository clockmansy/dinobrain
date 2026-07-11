import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const [{
  buildAndWriteStatusFreshness,
  buildStatusFreshness,
  MONITORING_STATUS_RELATIVE_PATH,
}, { refreshStatusArtifacts }] = await Promise.all([
  import(pathToFileURL(path.join(root, "dist", "status-freshness.js")).href),
  import(pathToFileURL(path.join(root, "dist", "refresh-status-artifacts.js")).href),
]);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function json(filePath, value) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function text(filePath, value) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, value, "utf8");
}

async function seedVault(dataRoot) {
  text(
    path.join(dataRoot, "20_Wiki", "Freshness.md"),
    `---
title: Freshness
summary: Status artifacts must not be older than their source data.
tags: [freshness]
---

# Freshness
`,
  );
  json(path.join(dataRoot, "50_Instances", "accepted", "freshness.json"), {
    candidate_id: "freshness",
    claim: "Status freshness reports stale proof artifacts.",
    source_paths: ["20_Wiki/Freshness.md"],
    evidence: { snippet: "Freshness source exists." },
    confidence: "high",
    last_verified: "2026-07-07",
  });
  json(path.join(dataRoot, ".dino", "tasks", "task-freshness.json"), {
    task_id: "task-freshness",
    status: "completed",
    request: "Verify status freshness.",
    created_at: "2026-07-07T00:00:00.000Z",
    updated_at: "2026-07-07T00:00:00.000Z",
  });
  json(path.join(dataRoot, ".dino", "traces", "task-freshness.json"), {
    task_id: "task-freshness",
    outcome: "completed",
    summary: "Trace fixture.",
    finished_at: "2026-07-07T00:01:00.000Z",
  });
  text(path.join(dataRoot, ".dino", "events", "2026-07-07.jsonl"), `${JSON.stringify({ event: "task_finished" })}\n`);
  json(path.join(dataRoot, ".dino", "evaluations", "behavior-golden.json"), {
    version: 1,
    description: "Freshness fixture behavior golden.",
    target_memory_lift: 0,
    minimum_cases: 1,
    cases: [
      {
        id: "freshness-rag",
        request: "How should status freshness reports be evaluated?",
        expected_memory_paths: ["50_Instances/accepted/freshness.json"],
        required_context_terms: ["Status freshness reports stale proof artifacts"],
      },
    ],
  });
  json(path.join(dataRoot, ".dino", "index", "dense-vectors.json"), {
    version: 1,
    dimensions: 2,
    records: {
      "50_Instances/accepted/freshness.json": [1, 0],
    },
    queries: {
      "How should status freshness reports be evaluated?": [1, 0],
    },
  });
}

async function refreshAllRequiredArtifacts(dataRoot) {
  const result = await refreshStatusArtifacts(dataRoot);
  assert(result.ok, `refresh pipeline did not produce healthy freshness: ${result.status}`);
}

async function main() {
  const dataRoot = mkdtempSync(path.join(tmpdir(), "dinobrain-status-freshness-"));
  const missingRoot = mkdtempSync(path.join(tmpdir(), "dinobrain-status-freshness-missing-"));
  try {
    await seedVault(dataRoot);
    await refreshAllRequiredArtifacts(dataRoot);
    let status = await buildStatusFreshness(dataRoot, { staleAfterMs: 0 });
    assert(
      status.status === "healthy",
      `expected healthy freshness, got ${status.status}: ${JSON.stringify(status.checks.filter((check) => check.status !== "fresh"))}`,
    );
    assert(status.counts.missing === 0, "fresh vault should not have missing required artifacts");
    assert(status.checks.every((check) => check.visible_status), "visible status labels missing");
    assert(
      !status.checks.some((check) => check.id === "health_status"),
      "derived health status must not be a freshness input cycle",
    );
    assert(
      status.checks.some((check) => check.id === "client_mcp_direct_status"),
      "client MCP direct status freshness check missing",
    );
    assert(
      status.checks.every((check) => Number.isInteger(check.authority_rank) && check.last_computed_at !== undefined),
      "freshness authority metadata missing",
    );

    const written = await buildAndWriteStatusFreshness(dataRoot, { staleAfterMs: 0 });
    assert(written.report.status === "healthy", `monitoring write should stay self-reference safe, got ${written.report.status}`);
    assert(
      written.path.replace(/\\/g, "/").endsWith(MONITORING_STATUS_RELATIVE_PATH),
      "monitoring status path mismatch",
    );
    status = await buildStatusFreshness(dataRoot, { staleAfterMs: 0 });
    assert(status.status === "healthy", `monitoring self-write made freshness stale: ${status.status}`);

    const future = new Date(Date.now() + 60_000);
    text(path.join(dataRoot, "20_Wiki", "Freshness-Update.md"), "# Freshness Update\n");
    await import("node:fs").then(({ utimesSync }) => {
      utimesSync(path.join(dataRoot, "20_Wiki", "Freshness-Update.md"), future, future);
    });
    status = await buildStatusFreshness(dataRoot, { staleAfterMs: 0 });
    assert(status.status === "needs_refresh", `expected needs_refresh after source change, got ${status.status}`);
    assert(status.checks.some((check) => check.status === "stale"), "stale check missing after source change");

    await seedVault(missingRoot);
    status = await buildStatusFreshness(missingRoot, { staleAfterMs: 0 });
    assert(status.status === "degraded", `expected degraded with missing artifacts, got ${status.status}`);
    assert(status.counts.required_missing > 0, "missing required artifact count not reported");

    console.log("status freshness verification ok");
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
    rmSync(missingRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  console.error(`cwd=${root}`);
  process.exit(1);
});
