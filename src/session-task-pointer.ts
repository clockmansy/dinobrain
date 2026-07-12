import { promises as fs } from "node:fs";
import path from "node:path";

import { atomicWriteJson } from "./concurrency.js";
import { withTaskLifecycleMutationLock } from "./task-lifecycle-lock.js";
import { writeTerminalTaskAndTraceUnlocked } from "./task-terminal-store.js";

const ACTIVE_SESSION_POINTER_VERSION = "active_session_task_pointer_v1";
const ACTIVE_SESSION_POINTER_ROOT = ".dino/tmp/active-session-tasks";

type JsonObject = Record<string, unknown>;

type ActiveSessionTaskPointer = {
  version: typeof ACTIVE_SESSION_POINTER_VERSION;
  client_session_hash: string;
  task_id: string;
  task_path: string;
  lease_id: string | null;
  owner_id: string | null;
  updated_at: string;
};

export type SessionTaskSupersession = {
  task_id: string;
  task_path: string;
  trace_path: string;
  task_record: JsonObject;
  trace_record: JsonObject;
  finished_at: string;
  lease_id: string | null;
  terminal_owner_id: string;
  superseded_by_task_id: string;
  terminal_transaction: { transaction_id: string; journal_path: string };
};

function firstString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function sessionHash(record: JsonObject): string | null {
  const value = firstString(record.client_session_hash).toLowerCase();
  return /^[a-f0-9]{64}$/.test(value) ? value : null;
}

function relativeDataPath(dataRoot: string, targetPath: string): string {
  return path.relative(dataRoot, targetPath).split(path.sep).join("/");
}

function safeDataPath(dataRoot: string, relativePath: string): string | null {
  if (!relativePath || path.isAbsolute(relativePath)) return null;
  const normalized = relativePath.replace(/\\/g, "/");
  if (normalized.split("/").includes("..")) return null;
  const root = path.resolve(dataRoot);
  const target = path.resolve(root, ...normalized.split("/"));
  return target === root || target.startsWith(`${root}${path.sep}`) ? target : null;
}

async function readJson(filePath: string): Promise<JsonObject | null> {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8")) as JsonObject;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function pointerPath(dataRoot: string, hash: string): string {
  return path.join(dataRoot, ...ACTIVE_SESSION_POINTER_ROOT.split("/"), `${hash}.json`);
}

function pointerFor(dataRoot: string, taskPath: string, taskRecord: JsonObject, hash: string): ActiveSessionTaskPointer {
  const lease = taskRecord.lease as JsonObject | undefined;
  return {
    version: ACTIVE_SESSION_POINTER_VERSION,
    client_session_hash: hash,
    task_id: firstString(taskRecord.task_id),
    task_path: relativeDataPath(dataRoot, taskPath),
    lease_id: firstString(lease?.lease_id) || null,
    owner_id: firstString(lease?.owner_id) || null,
    updated_at: firstString(taskRecord.updated_at, taskRecord.created_at, new Date().toISOString()),
  };
}

function validatePointer(value: JsonObject, expectedHash: string): ActiveSessionTaskPointer {
  if (
    value.version !== ACTIVE_SESSION_POINTER_VERSION ||
    firstString(value.client_session_hash) !== expectedHash ||
    !firstString(value.task_id) ||
    !firstString(value.task_path)
  ) {
    throw new Error(`Active session task pointer is malformed for ${expectedHash}`);
  }
  return value as ActiveSessionTaskPointer;
}

async function supersedePointedTask(params: {
  dataRoot: string;
  pointer: ActiveSessionTaskPointer;
  newTaskId: string;
  finishedAt: string;
}): Promise<SessionTaskSupersession | null> {
  if (params.pointer.task_id === params.newTaskId) return null;
  const previousTaskPath = safeDataPath(params.dataRoot, params.pointer.task_path);
  if (!previousTaskPath) throw new Error("Active session task pointer escaped the data root");
  const previous = await readJson(previousTaskPath);
  if (!previous || firstString(previous.status).toLowerCase() !== "started") return null;
  if (sessionHash(previous) !== params.pointer.client_session_hash) {
    throw new Error("Active session task pointer does not match the pointed task session");
  }
  const lease = previous.lease as JsonObject | undefined;
  const leaseId = firstString(lease?.lease_id) || null;
  if (params.pointer.lease_id && leaseId !== params.pointer.lease_id) {
    throw new Error("Active session task pointer lease does not match the pointed task");
  }
  const taskId = firstString(previous.task_id);
  if (!taskId || taskId !== params.pointer.task_id) {
    throw new Error("Active session task pointer task id does not match the pointed task");
  }
  const traceRelativePath = `.dino/traces/${taskId}.json`;
  const tracePath = path.join(params.dataRoot, ...traceRelativePath.split("/"));
  const terminalOwnerId = firstString(previous.terminal_owner_id, lease?.owner_id, params.pointer.owner_id, "session-supersession");
  const terminalLease = lease
    ? {
        ...lease,
        heartbeat_at: params.finishedAt,
        state: "terminal",
        terminal_at: params.finishedAt,
      }
    : null;
  const trace: JsonObject = {
    task_id: taskId,
    outcome: "blocked",
    summary: "A newer user prompt superseded this unfinished task in the same client session.",
    growth_policy: "trace_only",
    changed_files: [],
    decisions: ["superseded_by_new_prompt"],
    next_steps: [`Continue under task ${params.newTaskId}.`],
    used_memory_paths: [],
    context_pack_paths: [],
    session_archive_paths: [],
    candidate_paths: [],
    search_queries: [],
    lease_id: leaseId,
    terminal_owner_id: terminalOwnerId,
    superseded_by_task_id: params.newTaskId,
    terminal_action_source: "same_session_new_prompt",
    memory_use: {
      used_memory_count: 0,
      context_pack_count: 0,
      session_archive_count: 0,
      candidate_count: 0,
      search_query_count: 0,
    },
    finished_at: params.finishedAt,
  };
  const updated: JsonObject = {
    ...previous,
    status: "blocked",
    block_reason: "superseded_by_new_prompt",
    superseded_by_task_id: params.newTaskId,
    terminal_action_source: "same_session_new_prompt",
    updated_at: params.finishedAt,
    finished_at: params.finishedAt,
    trace_path: traceRelativePath,
    lease: terminalLease,
    terminal_owner_id: terminalOwnerId,
  };
  const terminalTransaction = await writeTerminalTaskAndTraceUnlocked({
    dataRoot: params.dataRoot,
    taskPath: previousTaskPath,
    taskRecord: updated,
    tracePath,
    traceRecord: trace,
  });
  return {
    task_id: taskId,
    task_path: relativeDataPath(params.dataRoot, previousTaskPath),
    trace_path: traceRelativePath,
    task_record: updated,
    trace_record: trace,
    finished_at: params.finishedAt,
    lease_id: leaseId,
    terminal_owner_id: terminalOwnerId,
    superseded_by_task_id: params.newTaskId,
    terminal_transaction: terminalTransaction,
  };
}

export async function writeStartedTaskWithSessionPointer(params: {
  dataRoot: string;
  taskPath: string;
  taskRecord: JsonObject;
}): Promise<{ superseded: SessionTaskSupersession | null }> {
  const hash = sessionHash(params.taskRecord);
  if (!hash) {
    await atomicWriteJson(params.taskPath, params.taskRecord);
    return { superseded: null };
  }
  return withTaskLifecycleMutationLock(params.dataRoot, async () => {
    const activePointerPath = pointerPath(params.dataRoot, hash);
    const rawPointer = await readJson(activePointerPath);
    const activePointer = rawPointer ? validatePointer(rawPointer, hash) : null;
    const taskId = firstString(params.taskRecord.task_id);
    if (!taskId) throw new Error("Started task record is missing task_id");
    const finishedAt = firstString(params.taskRecord.created_at, new Date().toISOString());
    const superseded = activePointer
      ? await supersedePointedTask({
          dataRoot: params.dataRoot,
          pointer: activePointer,
          newTaskId: taskId,
          finishedAt,
        })
      : null;
    await atomicWriteJson(params.taskPath, params.taskRecord);
    await atomicWriteJson(activePointerPath, pointerFor(params.dataRoot, params.taskPath, params.taskRecord, hash));
    return { superseded };
  });
}

export async function clearActiveSessionTaskPointerUnlocked(params: {
  dataRoot: string;
  taskId: string;
  taskRecord: JsonObject;
}): Promise<boolean> {
  const hash = sessionHash(params.taskRecord);
  if (!hash) return false;
  const activePointerPath = pointerPath(params.dataRoot, hash);
  const rawPointer = await readJson(activePointerPath);
  if (!rawPointer) return false;
  const pointer = validatePointer(rawPointer, hash);
  if (pointer.task_id !== params.taskId) return false;
  await fs.rm(activePointerPath, { force: true });
  return true;
}

export async function clearActiveSessionTaskPointer(params: {
  dataRoot: string;
  taskId: string;
  taskRecord: JsonObject;
}): Promise<boolean> {
  return withTaskLifecycleMutationLock(params.dataRoot, () => clearActiveSessionTaskPointerUnlocked(params));
}
