import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DINOBRAIN_VERSION } from "./lib/version-manifest.mjs";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const serverPath = path.join(root, "dist", "index.js");
const operationsModulePath = pathToFileURL(path.join(root, "dist", "operations-index.js")).href;
const sqliteModulePath = pathToFileURL(path.join(root, "dist", "sqlite-shards.js")).href;
const dataRoot = mkdtempSync(path.join(tmpdir(), "dinobrain-operations-concurrency-"));
const parallelClients = Math.max(2, Math.min(32, Number(process.env.DINOBRAIN_CONCURRENCY_CLIENTS ?? 12)));

const { buildAndWriteOperationsIndex, getOperationsIndexPath } = await import(operationsModulePath);
const { buildAndWriteSqliteShards, getSqliteShardPath } = await import(sqliteModulePath);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function parseTool(result) {
  const text = result.content?.find((part) => part.type === "text")?.text;
  assert(text, "MCP tool returned no text content");
  if (result.isError) throw new Error(`MCP tool failed: ${text}`);
  return JSON.parse(text);
}

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
  path.join(dataRoot, "20_Wiki", "Concurrency-Safety.md"),
  `---
title: Concurrency Safety
summary: DinoBrain operation state must remain valid under parallel MCP task starts and finishes.
tags: [concurrency, operations, reliability]
source_status: internal
confidence: high
last_verified: 2026-07-10
---

# Concurrency Safety

Parallel writers must preserve every task, trace, Context Pack, event, JSON index, and SQLite operation row.
`,
  "utf8",
);

await buildAndWriteOperationsIndex(dataRoot);
await buildAndWriteSqliteShards(dataRoot);

async function connectClient(index) {
  const client = new Client({ name: `dinobrain-concurrency-${index}`, version: DINOBRAIN_VERSION });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath],
    cwd: root,
    env: {
      ...process.env,
      DINOBRAIN_DATA_DIR: dataRoot,
      DINOBRAIN_AUTO_COMPOUND: "0",
      DINOBRAIN_AUTO_GROWTH: "0",
      DINOBRAIN_AUTO_SYNC: "0",
      DINOBRAIN_SEMANTIC_EMBEDDINGS: "0",
    },
    stderr: "pipe",
  });
  await client.connect(transport);
  return { client, index };
}

const sessions = await Promise.all(Array.from({ length: parallelClients }, (_, index) => connectClient(index)));
let begins = [];
try {
  begins = await Promise.all(
    sessions.map(async ({ client }) =>
      parseTool(
        await client.callTool({
          name: "os_begin_task",
          arguments: {
            request: "Identical parallel concurrency proof request",
            project: "dinobrain-concurrency",
            mode: "standard",
            sensitivity: "normal",
            limit: 3,
          },
        }),
      ),
    ),
  );

  const taskIds = begins.map((begin) => begin.task_id);
  assert(new Set(taskIds).size === parallelClients, `task ID collision detected: ${JSON.stringify(taskIds)}`);
  assert(
    taskIds.every((taskId) => /^task-\d{8}-\d{9}-.+-[0-9a-f-]{36}$/i.test(taskId)),
    `task IDs do not contain millisecond and UUID entropy: ${JSON.stringify(taskIds)}`,
  );
  assert(begins.every((begin) => begin.fail_closed === false), "a parallel os_begin_task call failed closed");

  await Promise.all([
    ...sessions.map(async ({ client }, index) =>
      parseTool(
        await client.callTool({
          name: "finish_task",
          arguments: {
            task_id: begins[index].task_id,
            summary: `Parallel concurrency proof ${index} completed.`,
            outcome: "completed",
            growth_policy: "trace_only",
            changed_files: [],
            decisions: ["Preserve all operation records under concurrent writers."],
            next_steps: [],
            used_memory_paths: begins[index].context_pack.items.map((item) => item.path),
            context_pack_paths: [begins[index].context_pack.trace_path],
          },
        }),
      ),
    ),
    buildAndWriteOperationsIndex(dataRoot),
    buildAndWriteSqliteShards(dataRoot),
  ]);
} finally {
  await Promise.allSettled(sessions.map(({ client }) => client.close()));
}

const indexPath = getOperationsIndexPath(dataRoot);
const index = JSON.parse(readFileSync(indexPath, "utf8"));
const taskFiles = readdirSync(path.join(dataRoot, ".dino", "tasks")).filter((name) => name.endsWith(".json"));
const traceFiles = readdirSync(path.join(dataRoot, ".dino", "traces")).filter((name) => name.endsWith(".json"));
const packFiles = readdirSync(path.join(dataRoot, ".dino", "context-packs")).filter((name) => name.endsWith(".json"));

assert(index.counts.tasks === parallelClients, `operations index lost tasks: ${index.counts.tasks}`);
assert(index.counts.traces === parallelClients, `operations index lost traces: ${index.counts.traces}`);
assert(index.counts.context_packs === parallelClients, `operations index lost packs: ${index.counts.context_packs}`);
assert(index.active_tasks.length === 0, `completed tasks remained active: ${index.active_tasks.length}`);
assert(taskFiles.length === parallelClients, `task files collided or disappeared: ${taskFiles.length}`);
assert(traceFiles.length === parallelClients, `trace files collided or disappeared: ${traceFiles.length}`);
assert(packFiles.length === parallelClients, `Context Pack files collided or disappeared: ${packFiles.length}`);

const operationsDbPath = getSqliteShardPath(dataRoot, "operations");
const db = new DatabaseSync(operationsDbPath, { readOnly: true, timeout: 5_000 });
let sqliteCounts;
try {
  sqliteCounts = {
    tasks: db.prepare("SELECT COUNT(*) AS count FROM tasks").get().count,
    traces: db.prepare("SELECT COUNT(*) AS count FROM traces").get().count,
    context_packs: db.prepare("SELECT COUNT(*) AS count FROM context_packs").get().count,
    events: db.prepare("SELECT COUNT(*) AS count FROM events").get().count,
  };
} finally {
  db.close();
}

assert(sqliteCounts.tasks === parallelClients, `SQLite lost tasks: ${sqliteCounts.tasks}`);
assert(sqliteCounts.traces === parallelClients, `SQLite lost traces: ${sqliteCounts.traces}`);
assert(sqliteCounts.context_packs === parallelClients, `SQLite lost packs: ${sqliteCounts.context_packs}`);
assert(sqliteCounts.events >= parallelClients * 4, `SQLite lost operation events: ${sqliteCounts.events}`);
assert(!existsSync(path.join(dataRoot, ".dino", "index", "operations-write.lock")), "operation lock leaked");

const result = {
  ok: true,
  parallel_clients: parallelClients,
  unique_task_ids: new Set(begins.map((begin) => begin.task_id)).size,
  operations_index_counts: index.counts,
  sqlite_counts: sqliteCounts,
  active_tasks: index.active_tasks.length,
};
console.log(JSON.stringify(result, null, 2));
rmSync(dataRoot, { recursive: true, force: true });
