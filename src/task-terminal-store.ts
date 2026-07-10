import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import { atomicWriteBytes, atomicWriteJson } from "./concurrency.js";
import { dataPath, relDataPath } from "./context.js";
import { withTaskLifecycleMutationLock } from "./task-lifecycle-lock.js";

const TERMINAL_TRANSACTION_VERSION = "task_terminal_transaction_v1";
const TERMINAL_TRANSACTION_ROOT = ".dino/tmp/task-terminal-transactions";

type JsonObject = Record<string, unknown>;

type ArtifactState = {
  path: string;
  existed_before: boolean;
  before_sha256: string | null;
  after_sha256: string;
  backup_path: string | null;
};

type TerminalTransaction = {
  version: typeof TERMINAL_TRANSACTION_VERSION;
  transaction_id: string;
  task_id: string;
  status: "prepared" | "committed" | "rolled_back" | "recovery_blocked";
  created_at: string;
  updated_at: string;
  artifacts: {
    task: ArtifactState;
    trace: ArtifactState;
  };
  recovery_reason: string | null;
};

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function serializeJson(value: unknown): Buffer {
  const serialized = `${JSON.stringify(value, null, 2)}\n`;
  JSON.parse(serialized);
  return Buffer.from(serialized, "utf8");
}

async function readIfPresent(filePath: string): Promise<Buffer | null> {
  try {
    return await fs.readFile(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function hashIfPresent(filePath: string): Promise<string | null> {
  const value = await readIfPresent(filePath);
  return value === null ? null : sha256(value);
}

async function writeExclusive(filePath: string, value: Uint8Array): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const handle = await fs.open(filePath, "wx");
  try {
    await handle.writeFile(value);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function transactionPaths(dataRoot: string, transactionId: string): {
  journalPath: string;
  backupRoot: string;
} {
  const root = dataPath(dataRoot, ...TERMINAL_TRANSACTION_ROOT.split("/"));
  return {
    journalPath: path.join(root, `${transactionId}.json`),
    backupRoot: path.join(root, `${transactionId}.backup`),
  };
}

async function restoreArtifact(dataRoot: string, artifact: ArtifactState): Promise<void> {
  const targetPath = dataPath(dataRoot, ...artifact.path.split("/"));
  if (!artifact.existed_before) {
    await fs.rm(targetPath, { force: true });
    return;
  }
  if (!artifact.backup_path) throw new Error(`Terminal transaction backup missing: ${artifact.path}`);
  const backup = await fs.readFile(dataPath(dataRoot, ...artifact.backup_path.split("/")));
  if (sha256(backup) !== artifact.before_sha256) throw new Error(`Terminal transaction backup hash mismatch: ${artifact.path}`);
  await atomicWriteBytes(targetPath, backup, async (candidatePath) => {
    if ((await hashIfPresent(candidatePath)) !== artifact.before_sha256) {
      throw new Error(`Terminal transaction restore hash mismatch: ${artifact.path}`);
    }
  });
}

async function recoverTransaction(dataRoot: string, journalPath: string): Promise<void> {
  const transaction = JSON.parse(await fs.readFile(journalPath, "utf8")) as TerminalTransaction;
  if (transaction.version !== TERMINAL_TRANSACTION_VERSION || transaction.status !== "prepared") return;
  const artifacts = [transaction.artifacts.task, transaction.artifacts.trace];
  const states = await Promise.all(
    artifacts.map(async (artifact) => ({
      artifact,
      current: await hashIfPresent(dataPath(dataRoot, ...artifact.path.split("/"))),
    })),
  );
  if (states.every(({ artifact, current }) => current === artifact.after_sha256)) {
    transaction.status = "committed";
    transaction.updated_at = new Date().toISOString();
    transaction.recovery_reason = "both_terminal_artifacts_already_committed";
    await atomicWriteJson(journalPath, transaction);
    await fs.rm(journalPath.replace(/\.json$/, ".backup"), { recursive: true, force: true });
    return;
  }
  const conflicts = states.filter(
    ({ artifact, current }) => current !== artifact.before_sha256 && current !== artifact.after_sha256,
  );
  if (conflicts.length > 0) {
    transaction.status = "recovery_blocked";
    transaction.updated_at = new Date().toISOString();
    transaction.recovery_reason = `external_change_detected:${conflicts.map(({ artifact }) => artifact.path).join(",")}`;
    await atomicWriteJson(journalPath, transaction);
    throw new Error(`Terminal transaction recovery blocked by external changes: ${transaction.transaction_id}`);
  }
  for (const { artifact, current } of states) {
    if (current !== artifact.before_sha256) await restoreArtifact(dataRoot, artifact);
  }
  transaction.status = "rolled_back";
  transaction.updated_at = new Date().toISOString();
  transaction.recovery_reason = "prepared_transaction_restored_to_before_hashes";
  await atomicWriteJson(journalPath, transaction);
  await fs.rm(journalPath.replace(/\.json$/, ".backup"), { recursive: true, force: true });
}

export async function recoverPreparedTerminalTransactionsUnlocked(dataRoot: string): Promise<number> {
  const root = dataPath(dataRoot, ...TERMINAL_TRANSACTION_ROOT.split("/"));
  let entries: Array<import("node:fs").Dirent>;
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
  let recovered = 0;
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const journalPath = path.join(root, entry.name);
    const before = JSON.parse(await fs.readFile(journalPath, "utf8")) as TerminalTransaction;
    if (before.status === "recovery_blocked") {
      throw new Error(`Terminal transaction requires manual recovery: ${before.transaction_id}`);
    }
    if (before.status !== "prepared") continue;
    await recoverTransaction(dataRoot, journalPath);
    recovered += 1;
  }
  return recovered;
}

async function pruneTerminalTransactionReceipts(dataRoot: string, keep = 256): Promise<void> {
  const root = dataPath(dataRoot, ...TERMINAL_TRANSACTION_ROOT.split("/"));
  const entries = await fs.readdir(root, { withFileTypes: true });
  const receipts: Array<{ path: string; mtimeMs: number }> = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const receiptPath = path.join(root, entry.name);
    const record = JSON.parse(await fs.readFile(receiptPath, "utf8")) as TerminalTransaction;
    if (record.status === "prepared" || record.status === "recovery_blocked") continue;
    receipts.push({ path: receiptPath, mtimeMs: (await fs.stat(receiptPath)).mtimeMs });
  }
  receipts.sort((a, b) => b.mtimeMs - a.mtimeMs);
  await Promise.all(receipts.slice(keep).map((entry) => fs.rm(entry.path, { force: true })));
}

export async function writeTerminalTaskAndTraceUnlocked(params: {
  dataRoot: string;
  taskPath: string;
  taskRecord: JsonObject;
  tracePath: string;
  traceRecord: JsonObject;
  faultAfterTraceForTest?: boolean;
}): Promise<{ transaction_id: string; journal_path: string }> {
  await recoverPreparedTerminalTransactionsUnlocked(params.dataRoot);
  const taskPath = dataPath(params.dataRoot, relDataPath(params.dataRoot, params.taskPath));
  const tracePath = dataPath(params.dataRoot, relDataPath(params.dataRoot, params.tracePath));
  const taskBefore = await readIfPresent(taskPath);
  const traceBefore = await readIfPresent(tracePath);
  const taskAfter = serializeJson(params.taskRecord);
  const traceAfter = serializeJson(params.traceRecord);
  const taskId = String(params.taskRecord.task_id ?? params.traceRecord.task_id ?? "unknown-task");
  const transactionId = `terminal-${Date.now()}-${randomUUID()}`;
  const paths = transactionPaths(params.dataRoot, transactionId);
  await fs.mkdir(path.dirname(paths.backupRoot), { recursive: true });
  await fs.mkdir(paths.backupRoot, { recursive: false });
  const taskBackup = taskBefore === null ? null : path.join(paths.backupRoot, "task.bin");
  const traceBackup = traceBefore === null ? null : path.join(paths.backupRoot, "trace.bin");
  if (taskBefore !== null) await writeExclusive(taskBackup!, taskBefore);
  if (traceBefore !== null) await writeExclusive(traceBackup!, traceBefore);
  const transaction: TerminalTransaction = {
    version: TERMINAL_TRANSACTION_VERSION,
    transaction_id: transactionId,
    task_id: taskId,
    status: "prepared",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    artifacts: {
      task: {
        path: relDataPath(params.dataRoot, taskPath),
        existed_before: taskBefore !== null,
        before_sha256: taskBefore === null ? null : sha256(taskBefore),
        after_sha256: sha256(taskAfter),
        backup_path: taskBackup ? relDataPath(params.dataRoot, taskBackup) : null,
      },
      trace: {
        path: relDataPath(params.dataRoot, tracePath),
        existed_before: traceBefore !== null,
        before_sha256: traceBefore === null ? null : sha256(traceBefore),
        after_sha256: sha256(traceAfter),
        backup_path: traceBackup ? relDataPath(params.dataRoot, traceBackup) : null,
      },
    },
    recovery_reason: null,
  };
  await atomicWriteJson(paths.journalPath, transaction);
  try {
    await atomicWriteBytes(tracePath, traceAfter, async (candidatePath) => {
      if ((await hashIfPresent(candidatePath)) !== transaction.artifacts.trace.after_sha256) {
        throw new Error(`Terminal trace verification failed: ${taskId}`);
      }
    });
    if (params.faultAfterTraceForTest || process.env.DINOBRAIN_TEST_TERMINAL_FAULT_AFTER_TRACE === "1") {
      throw new Error(`Injected terminal transaction fault after trace write: ${taskId}`);
    }
    await atomicWriteBytes(taskPath, taskAfter, async (candidatePath) => {
      if ((await hashIfPresent(candidatePath)) !== transaction.artifacts.task.after_sha256) {
        throw new Error(`Terminal task verification failed: ${taskId}`);
      }
    });
    transaction.status = "committed";
    transaction.updated_at = new Date().toISOString();
    await atomicWriteJson(paths.journalPath, transaction);
    await fs.rm(paths.backupRoot, { recursive: true, force: true });
    await pruneTerminalTransactionReceipts(params.dataRoot);
    return { transaction_id: transactionId, journal_path: relDataPath(params.dataRoot, paths.journalPath) };
  } catch (error) {
    await recoverTransaction(params.dataRoot, paths.journalPath);
    throw error;
  }
}

export async function writeTerminalTaskAndTrace(params: {
  dataRoot: string;
  taskPath: string;
  taskRecord: JsonObject;
  tracePath: string;
  traceRecord: JsonObject;
  faultAfterTraceForTest?: boolean;
}): Promise<{ transaction_id: string; journal_path: string }> {
  return withTaskLifecycleMutationLock(params.dataRoot, () => writeTerminalTaskAndTraceUnlocked(params));
}
