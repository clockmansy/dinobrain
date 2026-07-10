import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const [
  { buildAndWriteTaskLifecycleReport },
  {
    getTaskLifecycleMigrationManifestPath,
    rollbackTaskLifecycleMigration,
    settleTaskLifecycle,
    TASK_LIFECYCLE_MIGRATION_ROOT,
    TASK_LIFECYCLE_SETTLEMENT_RELATIVE_PATH,
  },
  { writeTerminalTaskAndTrace },
] = await Promise.all([
  import(pathToFileURL(path.join(root, "dist", "task-lifecycle.js")).href),
  import(pathToFileURL(path.join(root, "dist", "task-lifecycle-settlement.js")).href),
  import(pathToFileURL(path.join(root, "dist", "task-terminal-store.js")).href),
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

function taskPath(dataRoot, taskId) {
  return path.join(dataRoot, ".dino", "tasks", `${taskId}.json`);
}

function tracePath(dataRoot, taskId) {
  return path.join(dataRoot, ".dino", "traces", `${taskId}.json`);
}

function migrationIds(dataRoot) {
  const migrationRoot = path.join(dataRoot, ...TASK_LIFECYCLE_MIGRATION_ROOT.split("/"));
  return existsSync(migrationRoot)
    ? readdirSync(migrationRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort()
    : [];
}

function seedFullFixture(dataRoot) {
  json(taskPath(dataRoot, "task-diagnostic"), {
    task_id: "task-diagnostic",
    status: "started",
    request: "DinoBrain live Codex hook diagnostic probe.",
    project: "dinobrain-hook-diagnose",
    created_at: "2026-07-01T00:00:00.000Z",
    updated_at: "2026-07-01T00:00:00.000Z",
  });
  json(taskPath(dataRoot, "task-manual"), {
    task_id: "task-manual",
    status: "started",
    request: "Implement important user-facing work with an existing trace.",
    project: "dinobrain",
    created_at: "2026-07-01T00:00:00.000Z",
    updated_at: "2026-07-01T00:00:00.000Z",
  });
  json(tracePath(dataRoot, "task-manual"), {
    task_id: "task-manual",
    outcome: "completed",
    summary: "Completed the traced work.",
    decisions: ["The existing trace is grounded enough to repair the task record."],
    next_steps: ["No action."],
    finished_at: "2026-07-01T00:10:00.000Z",
  });
  json(taskPath(dataRoot, "task-no-trace"), {
    task_id: "task-no-trace",
    status: "started",
    request: "Investigate an old task whose terminal trace is missing.",
    project: "dinobrain",
    created_at: "2026-07-01T00:00:00.000Z",
    updated_at: "2026-07-01T00:00:00.000Z",
  });
  json(taskPath(dataRoot, "task-blocked-missing-trace"), {
    task_id: "task-blocked-missing-trace",
    status: "blocked",
    request: "Fail before finish_task writes trace.",
    block_reason: "context_pack_failed",
    error: "simulated parse failure",
    project: "dinobrain",
    created_at: "2026-07-01T00:00:00.000Z",
    updated_at: "2026-07-01T00:05:00.000Z",
  });
  json(taskPath(dataRoot, "task-terminal-unbound"), {
    task_id: "task-terminal-unbound",
    status: "completed",
    request: "Completed task whose grounded trace exists but is not bound on the task record.",
    project: "dinobrain",
    created_at: "2026-07-01T00:00:00.000Z",
    updated_at: "2026-07-01T00:10:00.000Z",
    finished_at: "2026-07-01T00:10:00.000Z",
    trace_path: ".dino/traces/missing-terminal-trace.json",
  });
  json(tracePath(dataRoot, "task-terminal-unbound"), {
    task_id: "task-terminal-unbound",
    outcome: "completed",
    summary: "Existing grounded terminal trace that must never be overwritten during binding repair.",
    decisions: ["Bind the task record to this trace without changing trace bytes."],
    finished_at: "2026-07-01T00:10:00.000Z",
  });
  json(taskPath(dataRoot, "task-recent"), {
    task_id: "task-recent",
    status: "started",
    request: "Recent active work.",
    project: "dinobrain",
    created_at: "2026-07-07T00:00:00.000Z",
    updated_at: "2026-07-07T00:00:00.000Z",
  });
}

function seedDiagnosticFixture(dataRoot, taskIds = ["task-diagnostic"]) {
  for (const taskId of taskIds) {
    json(taskPath(dataRoot, taskId), {
      task_id: taskId,
      status: "started",
      request: `DinoBrain live Codex hook diagnostic probe ${taskId}.`,
      project: "dinobrain-hook-diagnose",
      created_at: "2026-07-01T00:00:00.000Z",
      updated_at: "2026-07-01T00:00:00.000Z",
    });
  }
}

async function verifySuccessAndExactRollback(dataRoot) {
  seedFullFixture(dataRoot);
  const originalPaths = [
    taskPath(dataRoot, "task-diagnostic"),
    taskPath(dataRoot, "task-manual"),
    tracePath(dataRoot, "task-manual"),
    taskPath(dataRoot, "task-no-trace"),
    taskPath(dataRoot, "task-blocked-missing-trace"),
    taskPath(dataRoot, "task-terminal-unbound"),
    tracePath(dataRoot, "task-terminal-unbound"),
    taskPath(dataRoot, "task-recent"),
  ];
  const originals = new Map(originalPaths.map((filePath) => [filePath, readFileSync(filePath)]));
  let lifecycle = await buildAndWriteTaskLifecycleReport(dataRoot, {
    now: new Date("2026-07-07T00:00:00.000Z"),
    staleAfterMs: 60 * 60 * 1000,
  });
  assert(lifecycle.report.counts.auto_close_candidates === 1, "fixture diagnostic task was not auto-close candidate");
  assert(lifecycle.report.counts.manual_repair_required === 4, "fixture manual repairs were not detected");
  assert(lifecycle.report.counts.trace_binding_missing === 1, "unbound terminal trace was not classified separately");

  let settlement = await settleTaskLifecycle(dataRoot, {
    now: new Date("2026-07-07T00:00:00.000Z"),
    staleAfterMs: 60 * 60 * 1000,
  });
  assert(settlement.report.status === "needs_attention", "dry-run should require apply when candidates exist");
  assert(settlement.report.counts.auto_close_candidates_before === 1, "dry-run candidate count mismatch");
  assert(settlement.report.counts.finish_gate_repairs_before === 4, "dry-run repair count mismatch");
  assert(settlement.report.counts.auto_close_applied === 0, "dry-run unexpectedly applied changes");
  const dryRunDiagnostic = settlement.report.actions.find((action) => action.task_id === "task-diagnostic");
  assert(dryRunDiagnostic?.prompt_classification === "diagnostic_probe", "dry-run omitted prompt classification");
  assert(/^[a-f0-9]{64}$/.test(dryRunDiagnostic?.task_sha256_before ?? ""), "dry-run omitted task SHA-256");
  assert(dryRunDiagnostic?.task_sha256_after === null, "dry-run should not record an after hash");
  assert(existsSync(path.join(dataRoot, TASK_LIFECYCLE_SETTLEMENT_RELATIVE_PATH)), "settlement report missing");
  assert(!existsSync(tracePath(dataRoot, "task-diagnostic")), "dry-run wrote trace");

  settlement = await settleTaskLifecycle(dataRoot, {
    apply: true,
    createRecoveryRef: false,
    now: new Date("2026-07-07T00:01:00.000Z"),
    staleAfterMs: 60 * 60 * 1000,
  });
  assert(settlement.report.status === "healthy", "apply should clear lifecycle blockers");
  assert(settlement.report.counts.auto_close_applied === 1, "apply did not close diagnostic task");
  assert(settlement.report.counts.finish_gate_repairs_applied === 4, "apply did not repair finish-gate tasks");
  assert(settlement.report.counts.auto_close_candidates_after === 0, "auto-close candidates remained after apply");
  assert(settlement.report.counts.finish_gate_repairs_after === 0, "repairable finish-gate tasks remained after apply");
  assert(settlement.report.counts.manual_repair_required_after === 0, "manual repair task should be resolved");
  assert(settlement.report.migration?.status === "verified", "verified migration metadata missing");
  const migrationId = settlement.report.migration.migration_id;
  const manifestPath = getTaskLifecycleMigrationManifestPath(dataRoot, migrationId);
  const manifest = readJson(manifestPath);
  assert(manifest.backup_policy === "local_only_exact_bytes", "migration backup policy mismatch");
  assert(manifest.ledger_entry_count > manifest.actions.length, "immutable migration ledger is incomplete");
  assert(/^[a-f0-9]{64}$/.test(manifest.ledger_head_sha256), "migration ledger head hash missing");
  assert(
    manifest.actions.flatMap((action) => action.artifacts).filter((artifact) => artifact.existed_before).every((artifact) => artifact.backup_path),
    "an existing migration source was not backed up",
  );

  const appliedDiagnostic = settlement.report.actions.find((action) => action.task_id === "task-diagnostic");
  assert(/^[a-f0-9]{64}$/.test(appliedDiagnostic?.task_sha256_after ?? ""), "apply omitted task after SHA-256");
  assert(/^[a-f0-9]{64}$/.test(appliedDiagnostic?.trace_sha256_after ?? ""), "apply omitted trace after SHA-256");
  assert(readJson(taskPath(dataRoot, "task-diagnostic")).status === "blocked", "diagnostic task was not blocked");
  assert(readJson(tracePath(dataRoot, "task-diagnostic")).outcome === "blocked", "diagnostic trace outcome mismatch");
  assert(readJson(taskPath(dataRoot, "task-manual")).status === "completed", "grounded trace task was not repaired");
  assert(readJson(taskPath(dataRoot, "task-no-trace")).status === "blocked", "stale no-trace task was not blocked");
  assert(readJson(taskPath(dataRoot, "task-blocked-missing-trace")).status === "blocked", "blocked task status changed");
  assert(
    readJson(taskPath(dataRoot, "task-terminal-unbound")).trace_path === ".dino/traces/task-terminal-unbound.json",
    "terminal task was not bound to its existing trace",
  );
  assert(
    readFileSync(tracePath(dataRoot, "task-terminal-unbound")).equals(originals.get(tracePath(dataRoot, "task-terminal-unbound"))),
    "terminal trace bytes were overwritten during binding repair",
  );
  assert(readJson(taskPath(dataRoot, "task-recent")).status === "started", "recent active task was mutated");

  lifecycle = await buildAndWriteTaskLifecycleReport(dataRoot, {
    now: new Date("2026-07-07T00:02:00.000Z"),
    staleAfterMs: 60 * 60 * 1000,
  });
  assert(lifecycle.report.counts.blockers === 0, "lifecycle blockers remained after verified migration");
  assert(lifecycle.report.counts.active === 1, "recent active task should remain visible");

  const rollback = await rollbackTaskLifecycleMigration(dataRoot, migrationId, {
    now: new Date("2026-07-07T00:03:00.000Z"),
  });
  assert(rollback.manifest.status === "rolled_back", "explicit rollback was not verified");
  for (const [filePath, original] of originals) {
    assert(readFileSync(filePath).equals(original), `rollback was not byte-exact: ${filePath}`);
  }
  assert(!existsSync(tracePath(dataRoot, "task-diagnostic")), "rollback left generated diagnostic trace");
  assert(!existsSync(tracePath(dataRoot, "task-no-trace")), "rollback left generated no-trace trace");
  assert(!existsSync(tracePath(dataRoot, "task-blocked-missing-trace")), "rollback left reconstructed trace");

  const reapplied = await settleTaskLifecycle(dataRoot, {
    apply: true,
    createRecoveryRef: false,
    now: new Date("2026-07-07T00:04:00.000Z"),
    staleAfterMs: 60 * 60 * 1000,
  });
  assert(reapplied.report.status === "healthy" && reapplied.report.migration?.status === "verified", "reapply failed after rollback");
  const migrationCount = migrationIds(dataRoot).length;
  const idempotent = await settleTaskLifecycle(dataRoot, {
    apply: true,
    createRecoveryRef: false,
    now: new Date("2026-07-07T00:05:00.000Z"),
    staleAfterMs: 60 * 60 * 1000,
  });
  assert(idempotent.report.status === "healthy", "idempotent apply was not healthy");
  assert(idempotent.report.migration === null, "idempotent apply created an unnecessary migration");
  assert(migrationIds(dataRoot).length === migrationCount, "idempotent apply created a migration directory");
}

async function verifyInterruptedRecovery(dataRoot) {
  seedDiagnosticFixture(dataRoot);
  const original = readFileSync(taskPath(dataRoot, "task-diagnostic"));
  let failed = false;
  try {
    await settleTaskLifecycle(dataRoot, {
      apply: true,
      createRecoveryRef: false,
      autoRollbackOnFailure: false,
      faultAfterAppliedActions: 1,
      now: new Date("2026-07-07T01:00:00.000Z"),
      staleAfterMs: 60 * 60 * 1000,
    });
  } catch (error) {
    failed = /Injected task lifecycle migration fault/.test(String(error));
  }
  assert(failed, "fault injection did not interrupt migration");
  const [migrationId] = migrationIds(dataRoot);
  assert(migrationId, "interrupted migration manifest missing");
  const manifestPath = getTaskLifecycleMigrationManifestPath(dataRoot, migrationId);
  const interruptedManifest = readJson(manifestPath);
  assert(interruptedManifest.status === "failed", "interrupted migration was not marked failed");
  const ledgerRoot = path.join(path.dirname(manifestPath), "ledger");
  const ledgerFiles = readdirSync(ledgerRoot).filter((name) => name.endsWith(".json")).sort();
  const laggedCount = interruptedManifest.ledger_entry_count - 1;
  const laggedHead = readJson(path.join(ledgerRoot, ledgerFiles[laggedCount - 1])).entry_sha256;
  json(manifestPath, {
    ...interruptedManifest,
    ledger_entry_count: laggedCount,
    ledger_head_sha256: laggedHead,
  });
  const rollback = await rollbackTaskLifecycleMigration(dataRoot, migrationId, {
    now: new Date("2026-07-07T01:01:00.000Z"),
  });
  assert(rollback.manifest.status === "rolled_back", "interrupted migration did not roll back");
  assert(readFileSync(taskPath(dataRoot, "task-diagnostic")).equals(original), "interrupted rollback was not byte-exact");
  assert(!existsSync(tracePath(dataRoot, "task-diagnostic")), "interrupted rollback left generated trace");
}

async function verifyExternalTamperProtection(dataRoot) {
  seedDiagnosticFixture(dataRoot);
  let blocked = false;
  try {
    await settleTaskLifecycle(dataRoot, {
      apply: true,
      createRecoveryRef: false,
      now: new Date("2026-07-07T02:00:00.000Z"),
      staleAfterMs: 60 * 60 * 1000,
      beforeApply: async () => {
        const task = readJson(taskPath(dataRoot, "task-diagnostic"));
        json(taskPath(dataRoot, "task-diagnostic"), { ...task, external_writer_note: "must survive" });
      },
    });
  } catch (error) {
    blocked = /automatic rollback failed/.test(String(error));
  }
  assert(blocked, "external tamper did not block unsafe rollback");
  const [migrationId] = migrationIds(dataRoot);
  const manifest = readJson(getTaskLifecycleMigrationManifestPath(dataRoot, migrationId));
  assert(manifest.status === "rollback_blocked", "tampered migration was not marked rollback_blocked");
  assert(readJson(taskPath(dataRoot, "task-diagnostic")).external_writer_note === "must survive", "rollback overwrote external writer data");
}

async function verifyConcurrentApplySerialization(dataRoot) {
  seedDiagnosticFixture(dataRoot, ["task-diagnostic-a", "task-diagnostic-b"]);
  const options = {
    apply: true,
    createRecoveryRef: false,
    now: new Date("2026-07-07T03:00:00.000Z"),
    staleAfterMs: 60 * 60 * 1000,
  };
  const results = await Promise.all([settleTaskLifecycle(dataRoot, options), settleTaskLifecycle(dataRoot, options)]);
  assert(results.every((result) => result.report.status === "healthy"), "concurrent apply returned an unhealthy result");
  assert(results.filter((result) => result.report.migration !== null).length === 1, "concurrent apply created multiple migrations");
  assert(migrationIds(dataRoot).length === 1, "concurrent apply wrote multiple migration directories");
  const lifecycle = await buildAndWriteTaskLifecycleReport(dataRoot, {
    now: new Date("2026-07-07T03:01:00.000Z"),
    staleAfterMs: 60 * 60 * 1000,
  });
  assert(lifecycle.report.counts.blockers === 0, "concurrent apply left lifecycle blockers");
}

async function verifyTerminalTransactionRecovery(dataRoot) {
  json(taskPath(dataRoot, "task-terminal-write"), {
    task_id: "task-terminal-write",
    status: "started",
    request: "Verify atomic terminal task and trace transaction.",
    created_at: "2026-07-07T00:00:00.000Z",
    updated_at: "2026-07-07T00:00:00.000Z",
  });
  const originalTask = readFileSync(taskPath(dataRoot, "task-terminal-write"));
  const updated = {
    ...readJson(taskPath(dataRoot, "task-terminal-write")),
    status: "completed",
    finished_at: "2026-07-07T04:00:00.000Z",
    updated_at: "2026-07-07T04:00:00.000Z",
    trace_path: ".dino/traces/task-terminal-write.json",
  };
  const trace = {
    task_id: "task-terminal-write",
    outcome: "completed",
    summary: "Terminal transaction fixture completed.",
    decisions: ["Write trace before terminal task under one serialized transaction."],
    finished_at: "2026-07-07T04:00:00.000Z",
  };
  let interrupted = false;
  try {
    await writeTerminalTaskAndTrace({
      dataRoot,
      taskPath: taskPath(dataRoot, "task-terminal-write"),
      taskRecord: updated,
      tracePath: tracePath(dataRoot, "task-terminal-write"),
      traceRecord: trace,
      faultAfterTraceForTest: true,
    });
  } catch (error) {
    interrupted = /Injected terminal transaction fault/.test(String(error));
  }
  assert(interrupted, "terminal transaction fault injection did not fire");
  assert(readFileSync(taskPath(dataRoot, "task-terminal-write")).equals(originalTask), "terminal transaction did not restore task bytes");
  assert(!existsSync(tracePath(dataRoot, "task-terminal-write")), "terminal transaction left an orphan trace after interruption");

  const committed = await writeTerminalTaskAndTrace({
    dataRoot,
    taskPath: taskPath(dataRoot, "task-terminal-write"),
    taskRecord: updated,
    tracePath: tracePath(dataRoot, "task-terminal-write"),
    traceRecord: trace,
  });
  assert(committed.transaction_id && committed.journal_path, "terminal transaction receipt missing");
  assert(readJson(taskPath(dataRoot, "task-terminal-write")).status === "completed", "terminal task did not commit");
  assert(readJson(tracePath(dataRoot, "task-terminal-write")).outcome === "completed", "terminal trace did not commit");
  assert(readJson(path.join(dataRoot, ...committed.journal_path.split("/"))).status === "committed", "terminal journal not committed");
}

async function main() {
  const roots = [
    mkdtempSync(path.join(tmpdir(), "dinobrain-task-lifecycle-success-")),
    mkdtempSync(path.join(tmpdir(), "dinobrain-task-lifecycle-interrupted-")),
    mkdtempSync(path.join(tmpdir(), "dinobrain-task-lifecycle-tamper-")),
    mkdtempSync(path.join(tmpdir(), "dinobrain-task-lifecycle-concurrent-")),
    mkdtempSync(path.join(tmpdir(), "dinobrain-task-terminal-transaction-")),
  ];
  try {
    await verifySuccessAndExactRollback(roots[0]);
    await verifyInterruptedRecovery(roots[1]);
    await verifyExternalTamperProtection(roots[2]);
    await verifyConcurrentApplySerialization(roots[3]);
    await verifyTerminalTransactionRecovery(roots[4]);
    console.log("task lifecycle settlement verification ok");
  } finally {
    for (const dataRoot of roots) rmSync(dataRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  console.error(`cwd=${root}`);
  process.exit(1);
});
