import { DatabaseSync } from "node:sqlite";
import { promises as fs } from "node:fs";
import path from "node:path";

import { type RankedRecord } from "./context.js";
import { HYBRID_RETRIEVAL_MODE, contextualText, rankRecordsHybridV2 } from "./hybrid-retrieval.js";
import {
  collectOperationEntries,
  type OperationContextPackEntry,
  type OperationEntries,
  type OperationEventEntry,
  type OperationTaskEntry,
  type OperationTraceEntry,
} from "./operations-index.js";
import { buildWikiIndex, type WikiIndex, type WikiIndexEdge, type WikiIndexNode, type WikiIndexRecord } from "./wiki-index.js";

export const SQLITE_SHARD_VERSION = 2;
export const SQLITE_INDEX_DIR = ".dino/index/sqlite";
export const SQLITE_MANIFEST_RELATIVE_PATH = `${SQLITE_INDEX_DIR}/manifest.json`;

type ShardName = "wiki" | "operations";
type SqlValue = string | number | null;

export type SqliteRetrievalStats = {
  retrieval_mode: typeof HYBRID_RETRIEVAL_MODE;
  candidate_source: "sqlite_shards_v2";
  index_path: string;
  index_record_count: number;
  candidate_record_count: number;
  total_candidate_count: number;
  matching_terms: string[];
  recent_task_count?: number;
};

type QueryOptions = {
  includeExcerpt?: boolean;
  rankLimit?: number;
};

const QUERY_STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "by",
  "for",
  "from",
  "how",
  "in",
  "is",
  "of",
  "on",
  "or",
  "should",
  "the",
  "to",
  "what",
  "when",
  "why",
  "with",
]);

type SqliteManifest = {
  version: typeof SQLITE_SHARD_VERSION;
  generated_at: string;
  data_root: string;
  shards: {
    wiki: {
      path: string;
      records: number;
      terms: number;
      nodes: number;
      edges: number;
      size_bytes: number;
    };
    operations: {
      path: string;
      tasks: number;
      traces: number;
      context_packs: number;
      events: number;
      size_bytes: number;
    };
  };
};

function nowIso(): string {
  return new Date().toISOString();
}

function isInside(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!!relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}

function dataPath(dataRoot: string, ...parts: string[]): string {
  const target = path.resolve(dataRoot, ...parts);
  if (!isInside(target, dataRoot)) {
    throw new Error(`Path escapes data root: ${parts.join("/")}`);
  }
  return target;
}

function sqliteRelativePath(shard: ShardName): string {
  return `${SQLITE_INDEX_DIR}/${shard}.sqlite`;
}

export function getSqliteShardPath(dataRoot: string, shard: ShardName): string {
  return dataPath(dataRoot, ...sqliteRelativePath(shard).split("/"));
}

export function getSqliteManifestPath(dataRoot: string): string {
  return dataPath(dataRoot, ...SQLITE_MANIFEST_RELATIVE_PATH.split("/"));
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function sqliteShardExists(dataRoot: string, shard: ShardName): Promise<boolean> {
  return await exists(getSqliteShardPath(dataRoot, shard));
}

function tokenize(value: string): string[] {
  return Array.from(
    new Set(
      value
        .toLowerCase()
        .split(/[^\p{L}\p{N}_-]+/u)
        .map((term) => term.trim())
        .filter((term) => term.length >= 2 && !QUERY_STOPWORDS.has(term)),
    ),
  );
}

async function removeShardFiles(dataRoot: string, shard: ShardName): Promise<void> {
  const shardPath = getSqliteShardPath(dataRoot, shard);
  await Promise.all(
    [shardPath, `${shardPath}-shm`, `${shardPath}-wal`].map(async (filePath) => {
      try {
        await fs.rm(filePath, { force: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }),
  );
}

function openWritableDatabase(filePath: string): DatabaseSync {
  const db = new DatabaseSync(filePath);
  db.exec(`
    PRAGMA journal_mode = DELETE;
    PRAGMA synchronous = NORMAL;
    PRAGMA foreign_keys = ON;
  `);
  return db;
}

function run(stmt: ReturnType<DatabaseSync["prepare"]>, ...values: SqlValue[]): void {
  stmt.run(...values);
}

function jsonArray(values: string[]): string {
  return JSON.stringify(values);
}

function writeMetadata(db: DatabaseSync, metadata: Record<string, SqlValue>): void {
  db.exec("CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  const insert = db.prepare("INSERT INTO metadata (key, value) VALUES (?, ?)");
  for (const [key, value] of Object.entries(metadata)) {
    run(insert, key, String(value ?? ""));
  }
}

function writeWikiShard(dataRoot: string, wiki: WikiIndex): string {
  const shardPath = getSqliteShardPath(dataRoot, "wiki");
  const db = openWritableDatabase(shardPath);
  db.exec(`
    CREATE TABLE records (
      id TEXT PRIMARY KEY,
      path TEXT NOT NULL UNIQUE,
      kind TEXT NOT NULL,
      title TEXT NOT NULL,
      summary TEXT NOT NULL,
      tags_json TEXT NOT NULL,
      excerpt TEXT NOT NULL,
      context_text TEXT NOT NULL,
      root TEXT NOT NULL,
      mtime_ms REAL NOT NULL,
      size_bytes INTEGER NOT NULL,
      links_json TEXT NOT NULL
    );
    CREATE TABLE terms (
      term TEXT NOT NULL,
      record_id TEXT NOT NULL,
      PRIMARY KEY (term, record_id)
    );
    CREATE INDEX idx_terms_term ON terms(term);
    CREATE INDEX idx_terms_record ON terms(record_id);
    CREATE TABLE nodes (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      label TEXT NOT NULL,
      path TEXT,
      record_id TEXT,
      count INTEGER
    );
    CREATE TABLE edges (
      from_id TEXT NOT NULL,
      to_id TEXT NOT NULL,
      type TEXT NOT NULL,
      PRIMARY KEY (from_id, type, to_id)
    );
    CREATE INDEX idx_edges_from ON edges(from_id);
    CREATE INDEX idx_edges_to ON edges(to_id);
  `);
  writeMetadata(db, {
    version: SQLITE_SHARD_VERSION,
    shard: "wiki",
    generated_at: wiki.generated_at,
    record_count: wiki.record_count,
    term_count: wiki.stats.term_count,
  });

  const insertRecord = db.prepare(`
    INSERT INTO records
      (id, path, kind, title, summary, tags_json, excerpt, context_text, root, mtime_ms, size_bytes, links_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertTerm = db.prepare("INSERT OR IGNORE INTO terms (term, record_id) VALUES (?, ?)");
  const insertNode = db.prepare(`
    INSERT INTO nodes (id, type, label, path, record_id, count) VALUES (?, ?, ?, ?, ?, ?)
  `);
  const insertEdge = db.prepare("INSERT INTO edges (from_id, to_id, type) VALUES (?, ?, ?)");

  db.exec("BEGIN");
  try {
    for (const record of wiki.records) insertWikiRecord(insertRecord, record);
    for (const [term, recordIds] of Object.entries(wiki.inverted_index)) {
      for (const recordId of recordIds) run(insertTerm, term, recordId);
    }
    for (const node of wiki.nodes) insertWikiNode(insertNode, node);
    for (const edge of wiki.edges) insertWikiEdge(insertEdge, edge);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  } finally {
    db.close();
  }

  return shardPath;
}

function insertWikiRecord(stmt: ReturnType<DatabaseSync["prepare"]>, record: WikiIndexRecord): void {
  run(
    stmt,
    record.id,
    record.path,
    record.kind,
    record.title,
    record.summary,
    JSON.stringify(record.tags),
    record.excerpt,
    contextualText(record),
    record.root,
    record.mtime_ms,
    record.size_bytes,
    JSON.stringify(record.links),
  );
}

function insertWikiNode(stmt: ReturnType<DatabaseSync["prepare"]>, node: WikiIndexNode): void {
  run(stmt, node.id, node.type, node.label, node.path ?? null, node.record_id ?? null, node.count ?? null);
}

function insertWikiEdge(stmt: ReturnType<DatabaseSync["prepare"]>, edge: WikiIndexEdge): void {
  run(stmt, edge.from, edge.to, edge.type);
}

function writeOperationsShard(
  dataRoot: string,
  operations: OperationEntries,
): string {
  const shardPath = getSqliteShardPath(dataRoot, "operations");
  const db = openWritableDatabase(shardPath);
  db.exec(`
    CREATE TABLE tasks (
      path TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      status TEXT NOT NULL,
      request TEXT NOT NULL,
      project TEXT,
      sync_policy TEXT,
      trace_path TEXT,
      created_at TEXT,
      updated_at TEXT,
      finished_at TEXT
    );
    CREATE INDEX idx_tasks_updated_at ON tasks(updated_at DESC);
    CREATE INDEX idx_tasks_status ON tasks(status);
    CREATE TABLE traces (
      path TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      outcome TEXT NOT NULL,
      summary TEXT NOT NULL,
      finished_at TEXT,
      used_memory_paths_json TEXT NOT NULL DEFAULT '[]',
      context_pack_paths_json TEXT NOT NULL DEFAULT '[]',
      session_archive_paths_json TEXT NOT NULL DEFAULT '[]',
      candidate_paths_json TEXT NOT NULL DEFAULT '[]'
    );
    CREATE INDEX idx_traces_finished_at ON traces(finished_at DESC);
    CREATE TABLE context_packs (
      path TEXT PRIMARY KEY,
      pack_id TEXT NOT NULL,
      question TEXT NOT NULL,
      created_at TEXT,
      item_count INTEGER NOT NULL,
      retrieval_mode TEXT
    );
    CREATE INDEX idx_packs_created_at ON context_packs(created_at DESC);
    CREATE TABLE context_pack_items (
      pack_path TEXT NOT NULL,
      ordinal INTEGER NOT NULL,
      path TEXT NOT NULL,
      kind TEXT,
      title TEXT,
      summary TEXT,
      score REAL,
      PRIMARY KEY (pack_path, ordinal)
    );
    CREATE TABLE events (
      event_key TEXT PRIMARY KEY,
      event TEXT NOT NULL,
      at TEXT,
      path TEXT NOT NULL,
      payload_json TEXT NOT NULL
    );
    CREATE INDEX idx_events_at ON events(at DESC);
  `);
  writeMetadata(db, {
    version: SQLITE_SHARD_VERSION,
    shard: "operations",
    generated_at: nowIso(),
    tasks: operations.tasks.length,
    traces: operations.traces.length,
    context_packs: operations.context_packs.length,
    events: operations.events.length,
  });

  const insertTask = db.prepare(`
    INSERT OR REPLACE INTO tasks
      (path, task_id, status, request, project, sync_policy, trace_path, created_at, updated_at, finished_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertTrace = db.prepare(`
    INSERT OR REPLACE INTO traces
      (path, task_id, outcome, summary, finished_at, used_memory_paths_json, context_pack_paths_json, session_archive_paths_json, candidate_paths_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertPack = db.prepare(`
    INSERT OR REPLACE INTO context_packs
      (path, pack_id, question, created_at, item_count, retrieval_mode)
      VALUES (?, ?, ?, ?, ?, ?)
  `);
  const insertPackItem = db.prepare(`
    INSERT OR REPLACE INTO context_pack_items
      (pack_path, ordinal, path, kind, title, summary, score)
      VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const insertEvent = db.prepare(`
    INSERT OR IGNORE INTO events (event_key, event, at, path, payload_json) VALUES (?, ?, ?, ?, ?)
  `);

  db.exec("BEGIN");
  try {
    for (const task of operations.tasks) insertOperationTask(insertTask, task);
    for (const trace of operations.traces) insertOperationTrace(insertTrace, trace);
    for (const pack of operations.context_packs) insertOperationPack(insertPack, insertPackItem, pack);
    for (const event of operations.events) insertOperationEvent(insertEvent, event);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  } finally {
    db.close();
  }

  return shardPath;
}

function insertOperationTask(stmt: ReturnType<DatabaseSync["prepare"]>, task: OperationTaskEntry): void {
  run(
    stmt,
    task.path,
    task.task_id,
    task.status,
    task.request,
    task.project,
    task.sync_policy,
    task.trace_path,
    task.created_at,
    task.updated_at,
    task.finished_at,
  );
}

function insertOperationTrace(stmt: ReturnType<DatabaseSync["prepare"]>, trace: OperationTraceEntry): void {
  run(
    stmt,
    trace.path,
    trace.task_id,
    trace.outcome,
    trace.summary,
    trace.finished_at,
    jsonArray(trace.used_memory_paths),
    jsonArray(trace.context_pack_paths),
    jsonArray(trace.session_archive_paths),
    jsonArray(trace.candidate_paths),
  );
}

function ensureTraceMemoryColumns(db: DatabaseSync): void {
  const rows = db.prepare("PRAGMA table_info(traces)").all() as Array<{ name: string }>;
  const existing = new Set(rows.map((row) => String(row.name)));
  for (const column of [
    "used_memory_paths_json",
    "context_pack_paths_json",
    "session_archive_paths_json",
    "candidate_paths_json",
  ]) {
    if (!existing.has(column)) db.exec(`ALTER TABLE traces ADD COLUMN ${column} TEXT NOT NULL DEFAULT '[]'`);
  }
}

function insertOperationPack(
  packStmt: ReturnType<DatabaseSync["prepare"]>,
  itemStmt: ReturnType<DatabaseSync["prepare"]>,
  pack: OperationContextPackEntry,
): void {
  run(packStmt, pack.path, pack.pack_id, pack.question, pack.created_at, pack.item_count, pack.retrieval_mode);
  pack.items.forEach((item, index) => {
    run(
      itemStmt,
      pack.path,
      index,
      item.path,
      item.kind ?? null,
      item.title ?? null,
      item.summary ?? null,
      item.score ?? null,
    );
  });
}

function operationEventKey(event: OperationEventEntry): string {
  return [
    event._path,
    event.event,
    event.at ?? "",
    String(event.task_id ?? ""),
    String(event.pack_id ?? ""),
    String(event.candidate_id ?? ""),
    String(event.quarantine_id ?? ""),
  ].join("\u0000");
}

function insertOperationEvent(stmt: ReturnType<DatabaseSync["prepare"]>, event: OperationEventEntry): void {
  run(stmt, operationEventKey(event), event.event, event.at, event._path, JSON.stringify(event));
}

async function shardSize(filePath: string): Promise<number> {
  try {
    return (await fs.stat(filePath)).size;
  } catch {
    return 0;
  }
}

export async function buildAndWriteSqliteShards(dataRoot: string): Promise<SqliteManifest> {
  await fs.mkdir(dataPath(dataRoot, ...SQLITE_INDEX_DIR.split("/")), { recursive: true });
  await removeShardFiles(dataRoot, "wiki");
  await removeShardFiles(dataRoot, "operations");

  const [wiki, operations] = await Promise.all([buildWikiIndex(dataRoot), collectOperationEntries(dataRoot)]);
  const wikiPath = writeWikiShard(dataRoot, wiki);
  const operationsPath = writeOperationsShard(dataRoot, operations);
  const manifest: SqliteManifest = {
    version: SQLITE_SHARD_VERSION,
    generated_at: nowIso(),
    data_root: path.resolve(dataRoot),
    shards: {
      wiki: {
        path: sqliteRelativePath("wiki"),
        records: wiki.record_count,
        terms: wiki.stats.term_count,
        nodes: wiki.stats.node_count,
        edges: wiki.stats.edge_count,
        size_bytes: await shardSize(wikiPath),
      },
      operations: {
        path: sqliteRelativePath("operations"),
        tasks: operations.tasks.length,
        traces: operations.traces.length,
        context_packs: operations.context_packs.length,
        events: operations.events.length,
        size_bytes: await shardSize(operationsPath),
      },
    },
  };
  await fs.writeFile(getSqliteManifestPath(dataRoot), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return manifest;
}

export async function invalidateSqliteWikiShard(dataRoot: string): Promise<void> {
  await removeShardFiles(dataRoot, "wiki");
  try {
    await fs.rm(getSqliteManifestPath(dataRoot), { force: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function parseStringArray(value: unknown): string[] {
  if (typeof value !== "string") return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function rowToRecord(row: Record<string, unknown>): RankedRecord {
  return {
    path: String(row.path ?? ""),
    kind: "curated_record",
    title: String(row.title ?? ""),
    summary: String(row.summary ?? ""),
    tags: parseStringArray(row.tags_json),
    score: 0,
    reasons: [],
    excerpt: String(row.context_text ?? row.excerpt ?? ""),
  };
}

function matchingSqliteTerms(db: DatabaseSync, queryTerm: string): string[] {
  const exact = db.prepare("SELECT term FROM terms WHERE term = ?").all(queryTerm) as Array<{ term: string }>;
  const related = db
    .prepare("SELECT term FROM terms WHERE term LIKE ? AND term <> ? ORDER BY term LIMIT 200")
    .all(`%${queryTerm}%`, queryTerm) as Array<{ term: string }>;
  return [...exact.map((row) => row.term), ...related.map((row) => row.term)];
}

export async function querySqliteWiki(
  dataRoot: string,
  query: string,
  limit: number,
  options: QueryOptions = {},
): Promise<{ records: RankedRecord[]; ranked: RankedRecord[]; stats: SqliteRetrievalStats }> {
  const shardPath = getSqliteShardPath(dataRoot, "wiki");
  const db = new DatabaseSync(shardPath, { readOnly: true });
  try {
    const queryTerms = tokenize(query);
    const scoreByRecordId = new Map<string, number>();
    const matchedTerms = new Set<string>();
    const recordIdsForTerm = db.prepare("SELECT record_id FROM terms WHERE term = ?");
    for (const queryTerm of queryTerms) {
      for (const term of matchingSqliteTerms(db, queryTerm)) {
        matchedTerms.add(term);
        const weight = term === queryTerm ? 3 : 1;
        for (const row of recordIdsForTerm.all(term) as Array<{ record_id: string }>) {
          scoreByRecordId.set(row.record_id, (scoreByRecordId.get(row.record_id) ?? 0) + weight);
        }
      }
    }

    const candidateLimit = options.rankLimit ?? Math.max(limit * 25, 100);
    const recordById = db.prepare("SELECT * FROM records WHERE id = ?");
    let records = Array.from(scoreByRecordId.entries())
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, candidateLimit)
      .map(([recordId]) => recordById.get(recordId) as Record<string, unknown> | undefined)
      .filter((row): row is Record<string, unknown> => Boolean(row))
      .map(rowToRecord);
    if (records.length === 0) {
      records = (db
        .prepare("SELECT * FROM records ORDER BY mtime_ms DESC, path ASC LIMIT ?")
        .all(candidateLimit) as Array<Record<string, unknown>>).map(rowToRecord);
    }
    const ranked = rankRecordsHybridV2(records, query, { limit });
    const recordCountRow = db.prepare("SELECT COUNT(*) AS count FROM records").get() as { count: number };
    return {
      records,
      ranked,
      stats: {
        retrieval_mode: HYBRID_RETRIEVAL_MODE,
        candidate_source: "sqlite_shards_v2",
        index_path: sqliteRelativePath("wiki"),
        index_record_count: recordCountRow.count,
        candidate_record_count: records.length,
        total_candidate_count: scoreByRecordId.size,
        matching_terms: Array.from(matchedTerms).sort((a, b) => a.localeCompare(b)),
      },
    };
  } finally {
    db.close();
  }
}

export async function collectRecentTaskRecordsFromSqlite(
  dataRoot: string,
  limit = 10,
): Promise<RankedRecord[] | null> {
  if (!(await sqliteShardExists(dataRoot, "operations"))) return null;
  const db = new DatabaseSync(getSqliteShardPath(dataRoot, "operations"), { readOnly: true });
  try {
    const rows = db
      .prepare(
        `
        SELECT t.path, t.status, t.request, t.project, t.trace_path, tr.summary AS trace_summary
        FROM tasks t
        LEFT JOIN traces tr ON tr.path = t.trace_path
        ORDER BY t.updated_at DESC, t.path ASC
        LIMIT ?
      `,
      )
      .all(limit) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      path: String(row.path ?? ""),
      kind: "recent_task",
      title: `Task: ${String(row.request ?? "").slice(0, 96)}`,
      summary: [
        `status=${String(row.status ?? "unknown")}`,
        row.project ? `project=${String(row.project)}` : "",
        row.trace_summary ? String(row.trace_summary) : "",
      ]
        .filter(Boolean)
        .join(" | ")
        .slice(0, 420),
      tags: ["recent-task", String(row.status ?? "unknown")],
      score: 0,
      reasons: [],
      excerpt: String(row.request ?? ""),
    }));
  } finally {
    db.close();
  }
}

export async function upsertSqliteOperationTask(
  dataRoot: string,
  task: OperationTaskEntry,
): Promise<void> {
  if (!(await sqliteShardExists(dataRoot, "operations"))) return;
  const db = new DatabaseSync(getSqliteShardPath(dataRoot, "operations"));
  try {
    insertOperationTask(
      db.prepare(`
        INSERT OR REPLACE INTO tasks
          (path, task_id, status, request, project, sync_policy, trace_path, created_at, updated_at, finished_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `),
      task,
    );
  } finally {
    db.close();
  }
}

export async function upsertSqliteOperationTrace(
  dataRoot: string,
  trace: OperationTraceEntry,
): Promise<void> {
  if (!(await sqliteShardExists(dataRoot, "operations"))) return;
  const db = new DatabaseSync(getSqliteShardPath(dataRoot, "operations"));
  try {
    ensureTraceMemoryColumns(db);
    insertOperationTrace(
      db.prepare(`
        INSERT OR REPLACE INTO traces
          (path, task_id, outcome, summary, finished_at, used_memory_paths_json, context_pack_paths_json, session_archive_paths_json, candidate_paths_json)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `),
      trace,
    );
  } finally {
    db.close();
  }
}

export async function upsertSqliteOperationContextPack(
  dataRoot: string,
  pack: OperationContextPackEntry,
): Promise<void> {
  if (!(await sqliteShardExists(dataRoot, "operations"))) return;
  const db = new DatabaseSync(getSqliteShardPath(dataRoot, "operations"));
  try {
    const insertPack = db.prepare(`
      INSERT OR REPLACE INTO context_packs
        (path, pack_id, question, created_at, item_count, retrieval_mode)
        VALUES (?, ?, ?, ?, ?, ?)
    `);
    const deleteItems = db.prepare("DELETE FROM context_pack_items WHERE pack_path = ?");
    const insertItem = db.prepare(`
      INSERT OR REPLACE INTO context_pack_items
        (pack_path, ordinal, path, kind, title, summary, score)
        VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    db.exec("BEGIN");
    try {
      deleteItems.run(pack.path);
      insertOperationPack(insertPack, insertItem, pack);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  } finally {
    db.close();
  }
}

export async function appendSqliteOperationEvent(
  dataRoot: string,
  event: OperationEventEntry,
): Promise<void> {
  if (!(await sqliteShardExists(dataRoot, "operations"))) return;
  const db = new DatabaseSync(getSqliteShardPath(dataRoot, "operations"));
  try {
    insertOperationEvent(
      db.prepare("INSERT OR IGNORE INTO events (event_key, event, at, path, payload_json) VALUES (?, ?, ?, ?, ?)"),
      event,
    );
  } finally {
    db.close();
  }
}
