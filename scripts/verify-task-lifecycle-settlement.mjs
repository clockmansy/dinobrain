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
      request: "Implement important user-facing work with an existing trace.",
      project: "dinobrain",
      created_at: "2026-07-01T00:00:00.000Z",
      updated_at: "2026-07-01T00:00:00.000Z",
    });
    json(path.join(dataRoot, ".dino", "traces", "task-manual.json"), {
      task_id: "task-manual",
      outcome: "completed",
      summary: "Completed the traced work.",
      decisions: ["The existing trace is grounded enough to repair the task record."],
      next_steps: ["No action."],
      finished_at: "2026-07-01T00:10:00.000Z",
    });
    json(path.join(dataRoot, ".dino", "tasks", "task-no-trace.json"), {
      task_id: "task-no-trace",
      status: "started",
      request: "Investigate an old task whose terminal trace is missing.",
      project: "dinobrain",
      created_at: "2026-07-01T00:00:00.000Z",
      updated_at: "2026-07-01T00:00:00.000Z",
    });
    json(path.join(dataRoot, ".dino", "tasks", "task-blocked-missing-trace.json"), {
      task_id: "task-blocked-missing-trace",
      status: "blocked",
      request: "Fail before finish_task writes trace.",
      block_reason: "context_pack_failed",
      error: "simulated parse failure",
      project: "dinobrain",
      created_at: "2026-07-01T00:00:00.000Z",
      updated_at: "2026-07-01T00:05:00.000Z",
    });
    json(path.join(dataRoot, ".dino", "tasks", "task-recent.json"), {
      task_id: "task-recent",
      status: "started",
      request: "Recent active work.",
      project: "dinobrain",
      created_at: "2026-07-07T00:00:00.000Z",
      updated_at: "2026-07-07T00:00:00.000Z",
    });

    let lifecycle = await buildAndWriteTaskLifecycleReport(dataRoot, {
      now: new Date("2026-07-07T00:00:00.000Z"),
      staleAfterMs: 60 * 60 * 1000,
    });
    assert(lifecycle.report.counts.auto_close_candidates === 1, "fixture diagnostic task was not auto-close candidate");
    assert(lifecycle.report.counts.manual_repair_required === 3, "fixture manual repairs were not detected");

    let settlement = await settleTaskLifecycle(dataRoot, {
      now: new Date("2026-07-07T00:00:00.000Z"),
      staleAfterMs: 60 * 60 * 1000,
    });
    assert(settlement.report.status === "needs_attention", "dry-run should require apply when candidates exist");
    assert(settlement.report.counts.auto_close_candidates_before === 1, "dry-run candidate count mismatch");
    assert(settlement.report.counts.finish_gate_repairs_before === 3, "dry-run repair count mismatch");
    assert(settlement.report.counts.auto_close_applied === 0, "dry-run unexpectedly applied changes");
    assert(settlement.report.counts.finish_gate_repairs_applied === 0, "dry-run unexpectedly repaired tasks");
    const dryRunDiagnostic = settlement.report.actions.find((action) => action.task_id === "task-diagnostic");
    assert(dryRunDiagnostic?.prompt_classification === "diagnostic_probe", "dry-run omitted prompt classification");
    assert(/^[a-f0-9]{64}$/.test(dryRunDiagnostic?.task_sha256_before ?? ""), "dry-run omitted task SHA-256");
    assert(dryRunDiagnostic?.task_sha256_after === null, "dry-run should not record an after hash");
    assert(existsSync(path.join(dataRoot, TASK_LIFECYCLE_SETTLEMENT_RELATIVE_PATH)), "settlement report missing");
    assert(!existsSync(path.join(dataRoot, ".dino", "traces", "task-diagnostic.json")), "dry-run wrote trace");

    settlement = await settleTaskLifecycle(dataRoot, {
      apply: true,
      now: new Date("2026-07-07T00:01:00.000Z"),
      staleAfterMs: 60 * 60 * 1000,
    });
    assert(settlement.report.status === "healthy", "apply should clear auto-close candidates");
    assert(settlement.report.counts.auto_close_applied === 1, "apply did not close diagnostic task");
    assert(settlement.report.counts.finish_gate_repairs_applied === 3, "apply did not repair finish-gate tasks");
    assert(settlement.report.counts.auto_close_candidates_after === 0, "auto-close candidates remained after apply");
    assert(settlement.report.counts.finish_gate_repairs_after === 0, "repairable finish-gate tasks remained after apply");
    assert(settlement.report.counts.manual_repair_required_after === 0, "manual repair task should be resolved");
    const appliedDiagnostic = settlement.report.actions.find((action) => action.task_id === "task-diagnostic");
    assert(/^[a-f0-9]{64}$/.test(appliedDiagnostic?.task_sha256_after ?? ""), "apply omitted task after SHA-256");
    assert(/^[a-f0-9]{64}$/.test(appliedDiagnostic?.trace_sha256_after ?? ""), "apply omitted trace after SHA-256");

    const diagnosticTask = readJson(path.join(dataRoot, ".dino", "tasks", "task-diagnostic.json"));
    const manualTask = readJson(path.join(dataRoot, ".dino", "tasks", "task-manual.json"));
    const noTraceTask = readJson(path.join(dataRoot, ".dino", "tasks", "task-no-trace.json"));
    const blockedTask = readJson(path.join(dataRoot, ".dino", "tasks", "task-blocked-missing-trace.json"));
    const recentTask = readJson(path.join(dataRoot, ".dino", "tasks", "task-recent.json"));
    const diagnosticTrace = readJson(path.join(dataRoot, ".dino", "traces", "task-diagnostic.json"));
    const noTraceTrace = readJson(path.join(dataRoot, ".dino", "traces", "task-no-trace.json"));
    const blockedTrace = readJson(path.join(dataRoot, ".dino", "traces", "task-blocked-missing-trace.json"));
    assert(diagnosticTask.status === "blocked", "diagnostic task was not closed as blocked");
    assert(diagnosticTask.trace_path === ".dino/traces/task-diagnostic.json", "diagnostic trace path not recorded");
    assert(diagnosticTrace.outcome === "blocked", "diagnostic trace outcome mismatch");
    assert(diagnosticTrace.summary, "diagnostic trace missing summary");
    assert(manualTask.status === "completed", "grounded trace task was not repaired to completed");
    assert(manualTask.trace_path === ".dino/traces/task-manual.json", "grounded trace path not recorded");
    assert(noTraceTask.status === "blocked", "stale task without trace was not blocked");
    assert(noTraceTrace.outcome === "blocked", "stale no-trace repair did not write blocked trace");
    assert(blockedTask.status === "blocked", "blocked task status changed unexpectedly");
    assert(blockedTask.trace_path === ".dino/traces/task-blocked-missing-trace.json", "blocked trace path missing");
    assert(blockedTrace.outcome === "blocked", "blocked missing trace was not reconstructed");
    assert(recentTask.status === "started", "recent active task was mutated");

    lifecycle = await buildAndWriteTaskLifecycleReport(dataRoot, {
      now: new Date("2026-07-07T00:02:00.000Z"),
      staleAfterMs: 60 * 60 * 1000,
    });
    assert(lifecycle.report.counts.auto_close_candidates === 0, "lifecycle still has auto-close candidates");
    assert(lifecycle.report.counts.manual_repair_required === 0, "finish-gate repair blocker remained");
    assert(lifecycle.report.counts.active === 1, "recent active task should remain visible");

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
