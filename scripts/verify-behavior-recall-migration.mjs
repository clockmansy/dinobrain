import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const migrationModule = await import(pathToFileURL(path.join(root, "dist", "behavior-recall-migration.js")).href);
const behaviorModule = await import(pathToFileURL(path.join(root, "dist", "behavior-recall.js")).href);

const { applyBehaviorRecallEvidenceMigration, BEHAVIOR_RECALL_MIGRATION_ROOT } = migrationModule;
const { buildBehaviorRecallReport, BEHAVIOR_RECALL_LEDGER_RELATIVE_PATH } = behaviorModule;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function write(filePath, value) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

const dataRoot = mkdtempSync(path.join(tmpdir(), "dinobrain-behavior-recall-migration-"));
try {
  const taskId = "task-with-truncated-evidence-path";
  const stalePath = `.dino/traces/${taskId.slice(0, -8)}.json`;
  const tracePath = `.dino/traces/${taskId}.json`;
  const trace = { task_id: taskId, outcome: "completed", summary: "Grounded finish trace." };
  const ledgerEntry = {
    version: "behavior_recall_v1",
    recall_id: "behavior-recall-truncated-path",
    trigger_type: "completion",
    task_id: taskId,
    recalled_memory_paths: [],
    decision_status: "not_applicable",
    reason: "No behavior memory or Context Pack path was declared for this finish.",
    evidence_path: stalePath,
    conflicting_memory_paths: [],
    followup_action: "review_finish_trace_if_behavior_memory_was_expected",
    created_at: "2026-07-11T00:00:00.000Z",
  };
  write(path.join(dataRoot, BEHAVIOR_RECALL_LEDGER_RELATIVE_PATH), `${JSON.stringify(ledgerEntry)}\n`);
  write(path.join(dataRoot, tracePath), trace);

  const dryRun = await applyBehaviorRecallEvidenceMigration(dataRoot, {
    now: new Date("2026-07-11T00:01:00.000Z"),
    requireGitRecoveryRef: false,
  });
  assert(dryRun.report.status === "needs_apply", `dry-run status mismatch: ${dryRun.report.status}`);
  assert(dryRun.report.counts.planned_repairs === 1, "dry-run did not plan exactly one unique repair");
  assert(dryRun.report.transaction_id === null, "dry-run unexpectedly mutated lifecycle state");

  const applied = await applyBehaviorRecallEvidenceMigration(dataRoot, {
    now: new Date("2026-07-11T00:02:00.000Z"),
    apply: true,
    requireGitRecoveryRef: false,
  });
  assert(applied.report.status === "healthy", `apply status mismatch: ${applied.report.status}`);
  assert(applied.report.counts.applied_repairs === 1, "apply did not persist one repair");
  assert(applied.report.transaction_id, "apply did not create a rollback transaction");

  const publicSummary = readFileSync(applied.operationsPath, "utf8");
  assert(!publicSummary.includes(taskId), "public summary leaked task id");
  assert(!publicSummary.includes(stalePath), "public summary leaked stale path");
  assert(!publicSummary.includes(tracePath), "public summary leaked trace path");

  let behavior = await buildBehaviorRecallReport(dataRoot, { now: new Date("2026-07-11T00:03:00.000Z") });
  assert(behavior.status === "healthy", `valid migration was not accepted: ${behavior.status}`);
  assert(behavior.counts.evidence_migrations_applied === 1, "valid migration count mismatch");

  write(path.join(dataRoot, tracePath), { ...trace, summary: "Tampered trace." });
  behavior = await buildBehaviorRecallReport(dataRoot, { now: new Date("2026-07-11T00:04:00.000Z") });
  assert(behavior.status === "needs_attention", "tampered trace did not invalidate migration");
  assert(
    behavior.findings.some((finding) => finding.signal === "evidence_migration_invalid"),
    "tampered trace finding missing",
  );

  write(path.join(dataRoot, tracePath), trace);
  const rolledBack = await applyBehaviorRecallEvidenceMigration(dataRoot, {
    now: new Date("2026-07-11T00:05:00.000Z"),
    rollbackTransactionId: applied.report.transaction_id,
    requireGitRecoveryRef: false,
  });
  assert(rolledBack.report.status === "rolled_back", "rollback status mismatch");
  behavior = await buildBehaviorRecallReport(dataRoot, { now: new Date("2026-07-11T00:06:00.000Z") });
  assert(behavior.status === "needs_attention", "rollback did not restore the original missing-evidence failure");

  const reapplied = await applyBehaviorRecallEvidenceMigration(dataRoot, {
    now: new Date("2026-07-11T00:07:00.000Z"),
    apply: true,
    requireGitRecoveryRef: false,
  });
  assert(reapplied.report.status === "healthy", "reapply failed");
  behavior = await buildBehaviorRecallReport(dataRoot, { now: new Date("2026-07-11T00:08:00.000Z") });
  assert(behavior.status === "healthy", "reapplied migration did not restore healthy behavior status");

  const migrationDir = path.join(dataRoot, BEHAVIOR_RECALL_MIGRATION_ROOT);
  assert(readFileSync(path.join(migrationDir, path.basename(reapplied.report.migration_path)), "utf8"), "migration missing");
} finally {
  rmSync(dataRoot, { recursive: true, force: true });
}

console.log("behavior recall evidence migration verification ok");
