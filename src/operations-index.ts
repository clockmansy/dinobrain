import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import { collectColdPartitionPaths } from "./cold-partitions.js";
import { atomicWriteJson, withFileLock } from "./concurrency.js";
import type { RankedRecord } from "./context.js";
import { withOperationsWriteLock } from "./operation-lock.js";

export const OPERATIONS_INDEX_VERSION = 2;
export const OPERATIONS_INDEX_RELATIVE_PATH = ".dino/index/operations-index.json";
const RECENT_TASK_LIMIT = 200;
const RECENT_TRACE_LIMIT = 200;
const RECENT_PACK_LIMIT = 200;
const RECENT_EVENT_LIMIT = 500;

type JsonObject = Record<string, unknown>;

export type OperationTaskEntry = {
  path: string;
  task_id: string;
  status: string;
  request: string;
  project: string | null;
  sync_policy: string | null;
  trace_path: string | null;
  created_at: string;
  updated_at: string;
  finished_at: string | null;
};

export type OperationTraceEntry = {
  path: string;
  task_id: string;
  outcome: string;
  summary: string;
  finished_at: string;
  used_memory_paths: string[];
  context_pack_paths: string[];
  session_archive_paths: string[];
  candidate_paths: string[];
};

export type OperationContextPackEntry = {
  path: string;
  pack_id: string;
  question: string;
  created_at: string;
  item_count: number;
  retrieval_mode: string | null;
  items: Array<{
    path: string;
    kind?: string;
    title?: string;
    summary?: string;
    score?: number;
  }>;
};

export type OperationEventEntry = JsonObject & {
  event: string;
  at: string | null;
  _path: string;
};

export type OperationsIndex = {
  version: typeof OPERATIONS_INDEX_VERSION;
  generated_at: string;
  data_root: string;
  index_path: string;
  counts: {
    tasks: number;
    traces: number;
    context_packs: number;
    events: number;
    cold_records: number;
  };
  active_tasks: OperationTaskEntry[];
  recent_tasks: OperationTaskEntry[];
  recent_traces: OperationTraceEntry[];
  recent_context_packs: OperationContextPackEntry[];
  recent_events: OperationEventEntry[];
};

export type OperationEntries = {
  tasks: OperationTaskEntry[];
  traces: OperationTraceEntry[];
  context_packs: OperationContextPackEntry[];
  events: OperationEventEntry[];
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

function relDataPath(dataRoot: string, filePath: string): string {
  return path.relative(dataRoot, filePath).split(path.sep).join("/");
}

function firstString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return "";
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function numericCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String).filter((item) => item.trim().length > 0) : [];
}

async function readJson<T>(filePath: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function readDirFiles(dir: string, extension: string): Promise<string[]> {
  let entries: Array<import("node:fs").Dirent>;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(extension))
    .map((entry) => path.join(dir, entry.name));
}

function normalizeTaskEntry(dataRoot: string, filePath: string, task: JsonObject): OperationTaskEntry {
  const taskId = firstString(task.task_id, path.basename(filePath, ".json"));
  return {
    path: relDataPath(dataRoot, filePath),
    task_id: taskId,
    status: firstString(task.status, "unknown"),
    request: firstString(task.request, taskId),
    project: stringOrNull(task.project),
    sync_policy: stringOrNull(task.sync_policy),
    trace_path: stringOrNull(task.trace_path),
    created_at: firstString(task.created_at),
    updated_at: firstString(task.updated_at, task.finished_at, task.created_at),
    finished_at: stringOrNull(task.finished_at),
  };
}

function normalizeTraceEntry(dataRoot: string, filePath: string, trace: JsonObject): OperationTraceEntry {
  return {
    path: relDataPath(dataRoot, filePath),
    task_id: firstString(trace.task_id, path.basename(filePath, ".json")),
    outcome: firstString(trace.outcome, "unknown"),
    summary: firstString(trace.summary),
    finished_at: firstString(trace.finished_at),
    used_memory_paths: stringArray(trace.used_memory_paths),
    context_pack_paths: stringArray(trace.context_pack_paths),
    session_archive_paths: stringArray(trace.session_archive_paths),
    candidate_paths: stringArray(trace.candidate_paths),
  };
}

function normalizePackEntry(dataRoot: string, filePath: string, pack: JsonObject): OperationContextPackEntry {
  const items = Array.isArray(pack.items) ? pack.items : [];
  return {
    path: relDataPath(dataRoot, filePath),
    pack_id: firstString(pack.pack_id, path.basename(filePath, ".json")),
    question: firstString(pack.question),
    created_at: firstString(pack.created_at),
    item_count: numericCount(pack.included_item_count) || items.length,
    retrieval_mode: stringOrNull(pack.retrieval_mode),
    items: items
      .filter((item): item is JsonObject => typeof item === "object" && item !== null && !Array.isArray(item))
      .slice(0, 12)
      .map((item) => ({
        path: firstString(item.path),
        kind: firstString(item.kind) || undefined,
        title: firstString(item.title) || undefined,
        summary: firstString(item.summary) || undefined,
        score: typeof item.score === "number" ? item.score : undefined,
      })),
  };
}

function normalizeEventEntry(relativePath: string, event: JsonObject): OperationEventEntry {
  return {
    ...event,
    event: firstString(event.event, "event"),
    at: stringOrNull(event.at),
    _path: relativePath,
  };
}

function byTaskTime(a: OperationTaskEntry, b: OperationTaskEntry): number {
  return b.updated_at.localeCompare(a.updated_at) || a.path.localeCompare(b.path);
}

function byTraceTime(a: OperationTraceEntry, b: OperationTraceEntry): number {
  return b.finished_at.localeCompare(a.finished_at) || a.path.localeCompare(b.path);
}

function byPackTime(a: OperationContextPackEntry, b: OperationContextPackEntry): number {
  return b.created_at.localeCompare(a.created_at) || a.path.localeCompare(b.path);
}

function byEventTime(a: OperationEventEntry, b: OperationEventEntry): number {
  return String(b.at ?? "").localeCompare(String(a.at ?? "")) || a._path.localeCompare(b._path);
}

function dedupeByPath<T extends { path: string }>(records: T[]): T[] {
  const seen = new Set<string>();
  const deduped: T[] = [];
  for (const record of records) {
    if (seen.has(record.path)) continue;
    seen.add(record.path);
    deduped.push(record);
  }
  return deduped;
}

function eventKey(event: OperationEventEntry): string {
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

function dedupeEvents(events: OperationEventEntry[]): OperationEventEntry[] {
  const seen = new Set<string>();
  const deduped: OperationEventEntry[] = [];
  for (const event of events) {
    const key = eventKey(event);
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(event);
  }
  return deduped;
}

async function collectTasks(dataRoot: string): Promise<OperationTaskEntry[]> {
  const files = await readDirFiles(dataPath(dataRoot, ".dino", "tasks"), ".json");
  const records: OperationTaskEntry[] = [];
  for (const file of files) {
    const task = await readJson<JsonObject>(file);
    if (task) records.push(normalizeTaskEntry(dataRoot, file, task));
  }
  return records.sort(byTaskTime);
}

async function collectTraces(dataRoot: string): Promise<OperationTraceEntry[]> {
  const files = await readDirFiles(dataPath(dataRoot, ".dino", "traces"), ".json");
  const records: OperationTraceEntry[] = [];
  for (const file of files) {
    const trace = await readJson<JsonObject>(file);
    if (trace) records.push(normalizeTraceEntry(dataRoot, file, trace));
  }
  return records.sort(byTraceTime);
}

async function collectContextPacks(dataRoot: string): Promise<OperationContextPackEntry[]> {
  const files = await readDirFiles(dataPath(dataRoot, ".dino", "context-packs"), ".json");
  const records: OperationContextPackEntry[] = [];
  for (const file of files) {
    const pack = await readJson<JsonObject>(file);
    if (pack) records.push(normalizePackEntry(dataRoot, file, pack));
  }
  return records.sort(byPackTime);
}

async function collectEvents(dataRoot: string): Promise<OperationEventEntry[]> {
  const files = (await readDirFiles(dataPath(dataRoot, ".dino", "events"), ".jsonl")).sort();
  const records: OperationEventEntry[] = [];
  for (const file of files) {
    const relativePath = relDataPath(dataRoot, file);
    const text = await withFileLock(`${file}.append.lock`, async () => await fs.readFile(file, "utf8"));
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line) as JsonObject;
        records.push(normalizeEventEntry(relativePath, event));
      } catch {
        records.push({
          event: "unparseable_event",
          at: null,
          _path: relativePath,
          raw: line.slice(0, 240),
        });
      }
    }
  }
  return records.sort(byEventTime);
}

export function getOperationsIndexPath(dataRoot: string): string {
  return dataPath(dataRoot, ...OPERATIONS_INDEX_RELATIVE_PATH.split("/"));
}

export async function readOperationsIndex(dataRoot: string): Promise<OperationsIndex | null> {
  try {
    const parsed = JSON.parse(await fs.readFile(getOperationsIndexPath(dataRoot), "utf8")) as OperationsIndex;
    if (parsed.version !== OPERATIONS_INDEX_VERSION) return null;
    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    if (error instanceof SyntaxError) return null;
    throw error;
  }
}

export async function collectOperationEntries(dataRoot: string): Promise<OperationEntries> {
  const [tasks, traces, packs, events] = await Promise.all([
    collectTasks(dataRoot),
    collectTraces(dataRoot),
    collectContextPacks(dataRoot),
    collectEvents(dataRoot),
  ]);
  return { tasks, traces, context_packs: packs, events };
}

export async function buildOperationsIndex(dataRoot: string): Promise<OperationsIndex> {
  const { tasks, traces, context_packs: packs, events } = await collectOperationEntries(dataRoot);
  const coldPaths = await collectColdPartitionPaths(dataRoot);
  const hotTasks = tasks.filter((task) => !coldPaths.has(task.path));
  const hotTraces = traces.filter((trace) => !coldPaths.has(trace.path));
  const hotPacks = packs.filter((pack) => !coldPaths.has(pack.path));
  const hotEvents = events.filter((event) => !coldPaths.has(event._path));
  return {
    version: OPERATIONS_INDEX_VERSION,
    generated_at: nowIso(),
    data_root: path.resolve(dataRoot),
    index_path: OPERATIONS_INDEX_RELATIVE_PATH,
    counts: {
      tasks: tasks.length,
      traces: traces.length,
      context_packs: packs.length,
      events: events.length,
      cold_records: coldPaths.size,
    },
    active_tasks: hotTasks.filter((task) => task.status === "started"),
    recent_tasks: hotTasks.slice(0, RECENT_TASK_LIMIT),
    recent_traces: hotTraces.slice(0, RECENT_TRACE_LIMIT),
    recent_context_packs: hotPacks.slice(0, RECENT_PACK_LIMIT),
    recent_events: hotEvents.slice(0, RECENT_EVENT_LIMIT),
  };
}

async function writeOperationsIndexUnlocked(dataRoot: string, index: OperationsIndex): Promise<string> {
  const indexPath = getOperationsIndexPath(dataRoot);
  await atomicWriteJson(indexPath, index);
  return indexPath;
}

export async function writeOperationsIndex(dataRoot: string, index: OperationsIndex): Promise<string> {
  return await withOperationsWriteLock(dataRoot, async () => await writeOperationsIndexUnlocked(dataRoot, index));
}

export async function buildAndWriteOperationsIndex(dataRoot: string): Promise<OperationsIndex> {
  return await withOperationsWriteLock(dataRoot, async () => {
    const index = await buildOperationsIndex(dataRoot);
    await writeOperationsIndexUnlocked(dataRoot, index);
    return index;
  });
}

async function readOrBuildOperationsIndexUnlocked(dataRoot: string): Promise<OperationsIndex> {
  const existing = await readOperationsIndex(dataRoot);
  if (existing) return existing;
  const index = await buildOperationsIndex(dataRoot);
  await writeOperationsIndexUnlocked(dataRoot, index);
  return index;
}

export async function upsertOperationTask(
  dataRoot: string,
  taskPath: string,
  task: JsonObject,
): Promise<OperationsIndex> {
  return await withOperationsWriteLock(dataRoot, async () => {
    const index = await readOrBuildOperationsIndexUnlocked(dataRoot);
    const absolutePath = dataPath(dataRoot, taskPath);
    const entry = normalizeTaskEntry(dataRoot, absolutePath, task);
    const existed = index.recent_tasks.some((taskEntry) => taskEntry.path === entry.path);
    index.recent_tasks = dedupeByPath([entry, ...index.recent_tasks]).sort(byTaskTime).slice(0, RECENT_TASK_LIMIT);
    index.active_tasks =
      entry.status === "started"
        ? dedupeByPath([entry, ...index.active_tasks]).sort(byTaskTime)
        : index.active_tasks.filter((taskEntry) => taskEntry.path !== entry.path);
    if (!existed && entry.status === "started") index.counts.tasks += 1;
    index.generated_at = nowIso();
    await writeOperationsIndexUnlocked(dataRoot, index);
    return index;
  });
}

export async function upsertOperationTrace(
  dataRoot: string,
  tracePath: string,
  trace: JsonObject,
): Promise<OperationsIndex> {
  return await withOperationsWriteLock(dataRoot, async () => {
    const index = await readOrBuildOperationsIndexUnlocked(dataRoot);
    const absolutePath = dataPath(dataRoot, tracePath);
    const entry = normalizeTraceEntry(dataRoot, absolutePath, trace);
    const existed = index.recent_traces.some((traceEntry) => traceEntry.path === entry.path);
    index.recent_traces = dedupeByPath([entry, ...index.recent_traces]).sort(byTraceTime).slice(0, RECENT_TRACE_LIMIT);
    if (!existed) index.counts.traces += 1;
    index.generated_at = nowIso();
    await writeOperationsIndexUnlocked(dataRoot, index);
    return index;
  });
}

export async function upsertOperationContextPack(
  dataRoot: string,
  packPath: string,
  pack: JsonObject,
): Promise<OperationsIndex> {
  return await withOperationsWriteLock(dataRoot, async () => {
    const index = await readOrBuildOperationsIndexUnlocked(dataRoot);
    const absolutePath = dataPath(dataRoot, packPath);
    const entry = normalizePackEntry(dataRoot, absolutePath, pack);
    const existed = index.recent_context_packs.some((packEntry) => packEntry.path === entry.path);
    index.recent_context_packs = dedupeByPath([entry, ...index.recent_context_packs])
      .sort(byPackTime)
      .slice(0, RECENT_PACK_LIMIT);
    if (!existed) index.counts.context_packs += 1;
    index.generated_at = nowIso();
    await writeOperationsIndexUnlocked(dataRoot, index);
    return index;
  });
}

export async function appendOperationEvent(
  dataRoot: string,
  eventPath: string,
  event: JsonObject,
): Promise<OperationsIndex> {
  return await withOperationsWriteLock(dataRoot, async () => {
    const index = await readOrBuildOperationsIndexUnlocked(dataRoot);
    const entry = normalizeEventEntry(eventPath, event);
    const existed = index.recent_events.some((existing) => eventKey(existing) === eventKey(entry));
    index.recent_events = dedupeEvents([entry, ...index.recent_events]).sort(byEventTime).slice(0, RECENT_EVENT_LIMIT);
    if (!existed) index.counts.events += 1;
    index.generated_at = nowIso();
    await writeOperationsIndexUnlocked(dataRoot, index);
    return index;
  });
}

export async function collectRecentTaskRecordsFromIndex(
  dataRoot: string,
  limit = 10,
): Promise<RankedRecord[] | null> {
  const index = await readOperationsIndex(dataRoot);
  if (!index) return null;
  const coldPaths = await collectColdPartitionPaths(dataRoot);
  const records: RankedRecord[] = [];
  for (const task of index.recent_tasks.filter((entry) => !coldPaths.has(entry.path)).slice(0, limit)) {
    const trace = task.trace_path ? await readJson<JsonObject>(dataPath(dataRoot, task.trace_path)) : null;
    const traceSummary = trace && typeof trace.summary === "string" ? trace.summary : "";
    const title = `Task: ${task.request.slice(0, 96)}`;
    const summary = [`status=${task.status}`, task.project ? `project=${task.project}` : "", traceSummary]
      .filter(Boolean)
      .join(" | ")
      .slice(0, 420);
    const hasKorean = /[\uac00-\ud7a3]/.test(task.request);
    const hasLatin = /[A-Za-z]/.test(task.request);
    records.push({
      path: task.path,
      kind: "recent_task",
      title,
      summary,
      tags: ["recent-task", task.status],
      score: 0,
      reasons: [],
      excerpt: task.request,
      contextual_chunk: [`title: ${title}`, `summary: ${summary}`, `content: ${task.request}`].join("\n").slice(0, 1_600),
      source_sha256: createHash("sha256").update(JSON.stringify(task), "utf8").digest("hex"),
      parent_record_path: task.trace_path,
      language: hasKorean && hasLatin ? "mixed" : hasKorean ? "ko" : hasLatin ? "en" : "unknown",
      lifecycle_state: task.status,
      verification_status: trace ? "trace_recorded" : "unverified",
      retrieval_lane: "recent_task",
      aliases: [],
      modified_at_ms: Number.isFinite(Date.parse(task.updated_at)) ? Date.parse(task.updated_at) : 0,
    });
  }
  return records;
}
