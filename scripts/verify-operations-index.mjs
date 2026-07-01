import { existsSync, mkdtempSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataRoot = mkdtempSync(path.join(tmpdir(), "dinobrain-operations-index-"));
const modulePath = pathToFileURL(path.join(root, "dist", "operations-index.js")).href;

const {
  appendOperationEvent,
  buildAndWriteOperationsIndex,
  collectRecentTaskRecordsFromIndex,
  getOperationsIndexPath,
  readOperationsIndex,
  upsertOperationContextPack,
  upsertOperationTask,
  upsertOperationTrace,
} = await import(modulePath);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function iso(index) {
  return new Date(Date.UTC(2026, 6, 1, 0, 0, index)).toISOString();
}

function seedVault(count) {
  for (const dir of [".dino/tasks", ".dino/traces", ".dino/context-packs", ".dino/events"]) {
    mkdirSync(path.join(dataRoot, dir), { recursive: true });
  }

  const eventLines = [];
  for (let index = 0; index < count; index += 1) {
    const taskId = `task-${String(index).padStart(5, "0")}`;
    const task = {
      task_id: taskId,
      status: "completed",
      request: `Synthetic operational task ${index}`,
      project: "dinobrain",
      created_at: iso(index),
      updated_at: iso(index),
      finished_at: iso(index),
      trace_path: `.dino/traces/${taskId}.json`,
    };
    const trace = {
      task_id: taskId,
      outcome: "completed",
      summary: `Synthetic trace ${index}`,
      finished_at: iso(index),
    };
    const pack = {
      pack_id: `pack-${String(index).padStart(5, "0")}`,
      question: `Synthetic question ${index}`,
      created_at: iso(index),
      retrieval_mode: "wiki_index_v0",
      included_item_count: 1,
      items: [{ path: "20_Wiki/README.md", summary: "Synthetic item" }],
    };
    writeFileSync(path.join(dataRoot, ".dino/tasks", `${taskId}.json`), `${JSON.stringify(task, null, 2)}\n`, "utf8");
    writeFileSync(path.join(dataRoot, ".dino/traces", `${taskId}.json`), `${JSON.stringify(trace, null, 2)}\n`, "utf8");
    writeFileSync(
      path.join(dataRoot, ".dino/context-packs", `pack-${String(index).padStart(5, "0")}.json`),
      `${JSON.stringify(pack, null, 2)}\n`,
      "utf8",
    );
    eventLines.push(JSON.stringify({ event: "task_finished", task_id: taskId, at: iso(index) }));
  }
  writeFileSync(path.join(dataRoot, ".dino/events", "2026-07-01.jsonl"), `${eventLines.join("\n")}\n`, "utf8");
}

seedVault(2500);

const buildStarted = Date.now();
let index = await buildAndWriteOperationsIndex(dataRoot);
const buildElapsedMs = Date.now() - buildStarted;
const indexPath = getOperationsIndexPath(dataRoot);
assert(existsSync(indexPath), "operations index file was not written");
assert(index.counts.tasks === 2500, `unexpected task count: ${index.counts.tasks}`);
assert(index.counts.traces === 2500, `unexpected trace count: ${index.counts.traces}`);
assert(index.counts.context_packs === 2500, `unexpected context pack count: ${index.counts.context_packs}`);
assert(index.counts.events === 2500, `unexpected event count: ${index.counts.events}`);
assert(index.recent_tasks[0].task_id === "task-02499", "latest task was not first in operations index");
assert(index.recent_tasks.length === 200, "recent task list should be capped");
assert(index.recent_events.length === 500, "recent event list should be capped");

const readStarted = Date.now();
const recent = await collectRecentTaskRecordsFromIndex(dataRoot, 10);
const readElapsedMs = Date.now() - readStarted;
assert(recent?.length === 10, "indexed recent task reader did not return 10 records");
assert(recent[0].path.endsWith("task-02499.json"), "indexed recent task reader missed latest task");

const newTask = {
  task_id: "task-2500",
  status: "started",
  request: "Incremental operation index task",
  project: "dinobrain",
  sync_policy: "conditional",
  created_at: iso(2500),
  updated_at: iso(2500),
};
const newTrace = {
  task_id: "task-2500",
  outcome: "completed",
  summary: "Incremental operation index trace",
  finished_at: iso(2501),
};
const newPack = {
  pack_id: "pack-2500",
  question: "Incremental operation index pack",
  created_at: iso(2502),
  retrieval_mode: "wiki_index_v0",
  included_item_count: 1,
  items: [{ path: "20_Wiki/README.md", summary: "Incremental item" }],
};
writeFileSync(path.join(dataRoot, ".dino/tasks", "task-2500.json"), `${JSON.stringify(newTask, null, 2)}\n`, "utf8");
writeFileSync(path.join(dataRoot, ".dino/traces", "task-2500.json"), `${JSON.stringify(newTrace, null, 2)}\n`, "utf8");
writeFileSync(path.join(dataRoot, ".dino/context-packs", "pack-2500.json"), `${JSON.stringify(newPack, null, 2)}\n`, "utf8");

await upsertOperationTask(dataRoot, ".dino/tasks/task-2500.json", newTask);
await upsertOperationTrace(dataRoot, ".dino/traces/task-2500.json", newTrace);
await upsertOperationContextPack(dataRoot, ".dino/context-packs/pack-2500.json", newPack);
await appendOperationEvent(dataRoot, ".dino/events/2026-07-01.jsonl", {
  event: "task_started",
  task_id: "task-2500",
  at: iso(2500),
});

index = await readOperationsIndex(dataRoot);
assert(index, "operations index disappeared after incremental updates");
assert(index.counts.tasks === 2501, `incremental task count failed: ${index.counts.tasks}`);
assert(index.counts.traces === 2501, `incremental trace count failed: ${index.counts.traces}`);
assert(index.counts.context_packs === 2501, `incremental pack count failed: ${index.counts.context_packs}`);
assert(index.counts.events === 2501, `incremental event count failed: ${index.counts.events}`);
assert(index.active_tasks.some((task) => task.task_id === "task-2500"), "active task was not tracked");

console.log(
  JSON.stringify(
    {
      ok: true,
      data_root: dataRoot,
      index_path: indexPath,
      counts: index.counts,
      active_tasks: index.active_tasks.length,
      recent_tasks: index.recent_tasks.length,
      recent_traces: index.recent_traces.length,
      recent_context_packs: index.recent_context_packs.length,
      recent_events: index.recent_events.length,
      index_size_bytes: statSync(indexPath).size,
      build_elapsed_ms: buildElapsedMs,
      indexed_recent_read_ms: readElapsedMs,
      latest_task: index.recent_tasks[0].task_id,
    },
    null,
    2,
  ),
);
