import { existsSync, mkdtempSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataRoot = mkdtempSync(path.join(tmpdir(), "dinobrain-sqlite-shards-"));
const sqliteModulePath = pathToFileURL(path.join(root, "dist", "sqlite-shards.js")).href;
const retrievalModulePath = pathToFileURL(path.join(root, "dist", "retrieval.js")).href;

const {
  appendSqliteOperationEvent,
  buildAndWriteSqliteShards,
  collectRecentTaskRecordsFromSqlite,
  getSqliteManifestPath,
  getSqliteShardPath,
  querySqliteWiki,
  upsertSqliteOperationTask,
} = await import(sqliteModulePath);
const { getContextPackItems, searchWiki } = await import(retrievalModulePath);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function iso(index) {
  return new Date(Date.UTC(2026, 6, 1, 0, 0, index)).toISOString();
}

function seedVault(count) {
  for (const dir of [
    "20_Wiki",
    "30_Sources",
    "40_Projects",
    "50_Instances/accepted",
    "60_Operations",
    "70_Error_Book",
    ".dino/tasks",
    ".dino/traces",
    ".dino/context-packs",
    ".dino/events",
  ]) {
    mkdirSync(path.join(dataRoot, dir), { recursive: true });
  }

  writeFileSync(
    path.join(dataRoot, "20_Wiki", "SQLite-Shard-Target.md"),
    `---
title: SQLite Shard Target
summary: DinoBrain uses SQLite shards so large index files do not need to be parsed on every query.
tags: [sqlite, shard, llm-wiki, retrieval]
---

# SQLite Shard Target

The narrow phrase sqlite-shard-target proves SQLite-backed retrieval can find a specific Wiki record.
`,
    "utf8",
  );

  for (let index = 0; index < count; index += 1) {
    writeFileSync(
      path.join(dataRoot, index % 2 === 0 ? "30_Sources" : "40_Projects", `Synthetic-${String(index).padStart(5, "0")}.md`),
      `---
title: Synthetic Shard Record ${index}
summary: Synthetic SQLite shard filler record ${index}.
tags: [synthetic, sqlite]
---

# Synthetic Shard Record ${index}
`,
      "utf8",
    );

    const taskId = `task-${String(index).padStart(5, "0")}`;
    const task = {
      task_id: taskId,
      status: "completed",
      request: `Synthetic SQLite task ${index}`,
      project: "dinobrain",
      created_at: iso(index),
      updated_at: iso(index),
      finished_at: iso(index),
      trace_path: `.dino/traces/${taskId}.json`,
    };
    const trace = {
      task_id: taskId,
      outcome: "completed",
      summary: `Synthetic SQLite trace ${index}`,
      finished_at: iso(index),
    };
    writeFileSync(path.join(dataRoot, ".dino/tasks", `${taskId}.json`), `${JSON.stringify(task, null, 2)}\n`, "utf8");
    writeFileSync(path.join(dataRoot, ".dino/traces", `${taskId}.json`), `${JSON.stringify(trace, null, 2)}\n`, "utf8");
  }
  writeFileSync(
    path.join(dataRoot, ".dino/events", "2026-07-01.jsonl"),
    `${Array.from({ length: count }, (_, index) =>
      JSON.stringify({ event: "task_finished", task_id: `task-${String(index).padStart(5, "0")}`, at: iso(index) }),
    ).join("\n")}\n`,
    "utf8",
  );
}

seedVault(1200);

const buildStarted = Date.now();
const manifest = await buildAndWriteSqliteShards(dataRoot);
const buildElapsedMs = Date.now() - buildStarted;
const wikiShardPath = getSqliteShardPath(dataRoot, "wiki");
const operationsShardPath = getSqliteShardPath(dataRoot, "operations");
const manifestPath = getSqliteManifestPath(dataRoot);
assert(existsSync(wikiShardPath), "wiki sqlite shard was not written");
assert(existsSync(operationsShardPath), "operations sqlite shard was not written");
assert(existsSync(manifestPath), "sqlite manifest was not written");
assert(manifest.shards.wiki.records === 1201, `unexpected wiki record count: ${manifest.shards.wiki.records}`);
assert(manifest.shards.operations.tasks === 1200, `unexpected task count: ${manifest.shards.operations.tasks}`);
const operationDb = new DatabaseSync(operationsShardPath, { readOnly: true });
try {
  const taskRows = operationDb.prepare("SELECT COUNT(*) AS count FROM tasks").get().count;
  const eventRows = operationDb.prepare("SELECT COUNT(*) AS count FROM events").get().count;
  assert(taskRows === 1200, `sqlite task rows were capped unexpectedly: ${taskRows}`);
  assert(eventRows === 1200, `sqlite event rows were capped unexpectedly: ${eventRows}`);
} finally {
  operationDb.close();
}

const directSearch = await querySqliteWiki(dataRoot, "sqlite-shard-target", 5);
assert(directSearch.stats.retrieval_mode === "sqlite_shards_v0", "direct sqlite query did not report sqlite mode");
assert(directSearch.ranked.some((record) => record.path === "20_Wiki/SQLite-Shard-Target.md"), "direct sqlite query missed target");

const routedSearch = await searchWiki(dataRoot, "sqlite-shard-target", 5);
assert(routedSearch.stats.retrieval_mode === "sqlite_shards_v0", "searchWiki did not route through sqlite shard");
assert(routedSearch.ranked.some((record) => record.path === "20_Wiki/SQLite-Shard-Target.md"), "searchWiki missed target");

const pack = await getContextPackItems(dataRoot, "Why use sqlite shard target retrieval?", 5);
assert(pack.stats.retrieval_mode === "sqlite_shards_v0", "Context Pack did not route through sqlite shard");
assert(pack.ranked.some((record) => record.path === "20_Wiki/SQLite-Shard-Target.md"), "Context Pack missed target");

const recent = await collectRecentTaskRecordsFromSqlite(dataRoot, 5);
assert(recent?.length === 5, "SQLite recent task reader did not return five records");
assert(recent[0].path.endsWith("task-01199.json"), "SQLite recent task reader missed latest task");

await upsertSqliteOperationTask(dataRoot, {
  path: ".dino/tasks/task-1200.json",
  task_id: "task-1200",
  status: "started",
  request: "Incremental SQLite operation task",
  project: "dinobrain",
  sync_policy: "conditional",
  trace_path: null,
  created_at: iso(1200),
  updated_at: iso(1200),
  finished_at: null,
});
await appendSqliteOperationEvent(dataRoot, {
  event: "task_started",
  task_id: "task-1200",
  at: iso(1200),
  _path: ".dino/events/2026-07-01.jsonl",
});
const updatedRecent = await collectRecentTaskRecordsFromSqlite(dataRoot, 1);
assert(updatedRecent?.[0]?.path === ".dino/tasks/task-1200.json", "SQLite incremental task update was not visible");

console.log(
  JSON.stringify(
    {
      ok: true,
      data_root: dataRoot,
      manifest_path: manifestPath,
      wiki_shard_path: wikiShardPath,
      operations_shard_path: operationsShardPath,
      wiki_records: manifest.shards.wiki.records,
      operation_tasks: manifest.shards.operations.tasks,
      wiki_shard_size_bytes: statSync(wikiShardPath).size,
      operations_shard_size_bytes: statSync(operationsShardPath).size,
      build_elapsed_ms: buildElapsedMs,
      direct_search_candidates: directSearch.stats.candidate_record_count,
      routed_retrieval_mode: routedSearch.stats.retrieval_mode,
      pack_retrieval_mode: pack.stats.retrieval_mode,
      latest_sqlite_task: updatedRecent[0].path,
    },
    null,
    2,
  ),
);
