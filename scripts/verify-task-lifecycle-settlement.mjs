import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const [{ buildAndWriteTaskLifecycleReport }, { settleTaskLifecycle, TASK_LIFECYCLE_SETTLEMENT_RELATIVE_PATH }] =
  await Promise.all([
    import(pathToFileURL(path.join(root, "dist", "task-lifecycle.js")).href),
    import(pathToFileURL(path.join(root, "dist", "task-lifecycle-settlement.js")).href),
  ]);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function json(filePath, value) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

async function main() {
  const dataRoot = mkdtempSync(path.join(tmpdir(), "dinobrain-task-lifecycle-settlement-"));
  try {
    json(path.join(dataRoot, ".dino", "tasks", "task-diagnostic.json"), {
      task_id: "task-diagnostic",
      status: "started",
      request: "DinoBrain live Codex hook diagnostic probe.",
      project: "dinobrain-hook-diagnose",
      created_at: "2026-07-01T00:00:00.000Z",
      updated_at: "2026-07-01T00:00:00.000Z",
    });
    json(path.join(dataRoot, ".dino", "tasks", "task-manual.json"), {
      task_id: "task-manual",
      status: "started",
      request: "Implement important user-facing work.",
      project: "dinobrain",
      created_at: "2026-07-01T00:00:00.000Z",
      updated_at: "2026-07-01T00:00:00.000Z",
    });

    let lifecycle = await buildAndWriteTaskLifecycleReport(dataRoot, {
      now: new Date("2026-07-07T00:00:00.000Z"),
      staleAfterMs: 60 * 60 * 1000,
    });
    assert(lifecycle.report.counts.auto_close_candidates === 1, "fixture diagnostic task was not auto-close candidate");
    assert(lifecycle.report.counts.manual_repair_required === 1, "fixture manual task was not manual repair");

    let settlement = await settleTaskLifecycle(dataRoot, {
      now: new Date("2026-07-07T00:00:00.000Z"),
      staleAfterMs: 60 * 60 * 1000,
    });
    assert(settlement.report.status === "needs_attention", "dry-run should require apply when candidates exist");
    assert(settlement.report.counts.auto_close_candidates_before === 1, "dry-run candidate count mismatch");
    assert(settlement.report.counts.auto_close_applied === 0, "dry-run unexpectedly applied changes");
    assert(existsSync(path.join(dataRoot, TASK_LIFECYCLE_SETTLEMENT_RELATIVE_PATH)), "settlement report missing");
    assert(!existsSync(path.join(dataRoot, ".dino", "traces", "task-diagnostic.json")), "dry-run wrote trace");

    settlement = await settleTaskLifecycle(dataRoot, {
      apply: true,
      now: new Date("2026-07-07T00:01:00.000Z"),
      staleAfterMs: 60 * 60 * 1000,
    });
    assert(settlement.report.status === "healthy", "apply should clear auto-close candidates");
    assert(settlement.report.counts.auto_close_applied === 1, "apply did not close diagnostic task");
    assert(settlement.report.counts.auto_close_candidates_after === 0, "auto-close candidates remained after apply");
    assert(settlement.report.counts.manual_repair_required_after === 1, "manual repair task should remain visible");

    const diagnosticTask = readJson(path.join(dataRoot, ".dino", "tasks", "task-diagnostic.json"));
    const manualTask = readJson(path.join(dataRoot, ".dino", "tasks", "task-manual.json"));
    const diagnosticTrace = readJson(path.join(dataRoot, ".dino", "traces", "task-diagnostic.json"));
    assert(diagnosticTask.status === "blocked", "diagnostic task was not closed as blocked");
    assert(diagnosticTask.trace_path === ".dino/traces/task-diagnostic.json", "diagnostic trace path not recorded");
    assert(diagnosticTrace.outcome === "blocked", "diagnostic trace outcome mismatch");
    assert(diagnosticTrace.summary, "diagnostic trace missing summary");
    assert(manualTask.status === "started", "manual stale task was mutated");

    lifecycle = await buildAndWriteTaskLifecycleReport(dataRoot, {
      now: new Date("2026-07-07T00:02:00.000Z"),
      staleAfterMs: 60 * 60 * 1000,
    });
    assert(lifecycle.report.counts.auto_close_candidates === 0, "lifecycle still has auto-close candidates");
    assert(lifecycle.report.counts.manual_repair_required === 1, "manual repair blocker disappeared");

    console.log("task lifecycle settlement verification ok");
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  console.error(`cwd=${root}`);
  process.exit(1);
});
