import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const coldModule = await import(pathToFileURL(path.join(root, "dist", "cold-partitions.js")).href);
const contextModule = await import(pathToFileURL(path.join(root, "dist", "context.js")).href);
const operationsModule = await import(pathToFileURL(path.join(root, "dist", "operations-index.js")).href);
const {
  applyColdPartitions,
  collectColdPartitionPaths,
  getColdPartitionIndexPath,
  searchColdPartitions,
} = coldModule;
const { collectCuratedRecords } = contextModule;
const { buildOperationsIndex } = operationsModule;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function json(filePath, value) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function main() {
  const roots = [];
  try {
    const dataRoot = mkdtempSync(path.join(tmpdir(), "dinobrain-cold-partitions-"));
    roots.push(dataRoot);
    const oldAt = "2025-01-01T00:00:00.000Z";
    const newAt = "2026-07-10T00:00:00.000Z";
    json(path.join(dataRoot, ".dino", "tasks", "task-old.json"), {
      task_id: "task-old",
      status: "completed",
      request: "Old completed task",
      created_at: oldAt,
      updated_at: oldAt,
      finished_at: oldAt,
    });
    json(path.join(dataRoot, ".dino", "tasks", "task-new.json"), {
      task_id: "task-new",
      status: "completed",
      request: "New completed task",
      created_at: newAt,
      updated_at: newAt,
      finished_at: newAt,
    });
    json(path.join(dataRoot, ".dino", "traces", "task-old.json"), {
      task_id: "task-old",
      outcome: "completed",
      summary: "Old trace",
      finished_at: oldAt,
    });
    json(path.join(dataRoot, ".dino", "context-packs", "pack-old.json"), {
      pack_id: "pack-old",
      question: "Old pack",
      created_at: oldAt,
      items: [],
    });
    json(path.join(dataRoot, "60_Operations", "reports", "old-report.json"), {
      status: "historical",
      title: "Old operational report",
      summary: "Should be explicit cold-search only.",
      generated_at: oldAt,
    });
    json(path.join(dataRoot, "50_Instances", "accepted", "obsolete-rule.json"), {
      status: "archived",
      lifecycle_state: "archived",
      title: "Obsolete rule",
      summary: "Historical behavior rule",
      updated_at: newAt,
    });

    const dry = await applyColdPartitions(dataRoot, {
      now: new Date("2026-07-11T00:00:00.000Z"),
      requireGitRecoveryRef: false,
    });
    assert(dry.report.status === "needs_apply", "dry run should expose cold candidates");
    assert(dry.report.counts.planned === 5, `unexpected cold plan count: ${dry.report.counts.planned}`);
    assert(existsSync(getColdPartitionIndexPath(dataRoot)), "empty cold index should be initialized");
    assert(JSON.parse(readFileSync(getColdPartitionIndexPath(dataRoot), "utf8")).entries.length === 0, "dry run mutated cold index");

    const applied = await applyColdPartitions(dataRoot, {
      now: new Date("2026-07-11T00:00:00.000Z"),
      apply: true,
      requireGitRecoveryRef: false,
    });
    assert(applied.report.status === "healthy", "cold partition apply did not become healthy");
    assert(applied.report.counts.applied === 5, "cold partition apply count mismatch");
    assert(typeof applied.report.transaction_id === "string", "cold partition transaction missing");
    const paths = await collectColdPartitionPaths(dataRoot);
    assert(paths.has(".dino/tasks/task-old.json"), "old task not in cold index");
    assert(!paths.has(".dino/tasks/task-new.json"), "new task incorrectly cold-indexed");
    const search = await searchColdPartitions(dataRoot, "old report", 10);
    assert(search.some((entry) => entry.path === "60_Operations/reports/old-report.json"), "explicit cold search failed");

    const curated = await collectCuratedRecords(dataRoot);
    assert(!curated.some((entry) => entry.path === "60_Operations/reports/old-report.json"), "cold report leaked into hot retrieval");
    const operations = await buildOperationsIndex(dataRoot);
    assert(operations.counts.tasks === 2, "operations index lost cold task history");
    assert(operations.counts.cold_records === 5, "operations index cold count mismatch");
    assert(!operations.recent_tasks.some((task) => task.task_id === "task-old"), "cold task leaked into recent tasks");
    assert(operations.recent_tasks.some((task) => task.task_id === "task-new"), "hot task disappeared from recent tasks");

    const rolledBack = await applyColdPartitions(dataRoot, {
      now: new Date("2026-07-11T00:01:00.000Z"),
      rollbackTransactionId: applied.report.transaction_id,
      requireGitRecoveryRef: false,
    });
    assert(rolledBack.report.status === "rolled_back", "cold rollback status missing");
    assert(JSON.parse(readFileSync(getColdPartitionIndexPath(dataRoot), "utf8")).entries.length === 0, "cold rollback did not restore index");
    assert(existsSync(path.join(dataRoot, ".dino", "tasks", "task-old.json")), "cold indexing moved source truth");

    const faultRoot = mkdtempSync(path.join(tmpdir(), "dinobrain-cold-partitions-fault-"));
    roots.push(faultRoot);
    json(path.join(faultRoot, ".dino", "tasks", "task-old.json"), {
      task_id: "task-old",
      status: "completed",
      request: "Old task",
      created_at: oldAt,
      updated_at: oldAt,
      finished_at: oldAt,
    });
    await applyColdPartitions(faultRoot, {
      now: new Date("2026-07-11T00:00:00.000Z"),
      requireGitRecoveryRef: false,
    });
    const indexBefore = readFileSync(getColdPartitionIndexPath(faultRoot));
    let faulted = false;
    try {
      await applyColdPartitions(faultRoot, {
        now: new Date("2026-07-11T00:00:00.000Z"),
        apply: true,
        requireGitRecoveryRef: false,
        faultAfterWriteIndexForTest: 0,
      });
    } catch {
      faulted = true;
    }
    assert(faulted, "cold partition fault injection did not fail");
    assert(readFileSync(getColdPartitionIndexPath(faultRoot)).equals(indexBefore), "cold partition fault did not restore index");

    console.log(JSON.stringify({ ok: true, planned: 5, source_truth_moved: false, hot_retrieval_excluded: true, rollback: true }));
  } finally {
    for (const dataRoot of roots) rmSync(dataRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
