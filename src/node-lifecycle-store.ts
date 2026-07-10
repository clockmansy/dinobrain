import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import { atomicWriteBytes, atomicWriteJson, withFileLock } from "./concurrency.js";
import { dataPath, relDataPath } from "./context.js";
import {
  NODE_LIFECYCLE_VERSION,
  evaluateAcceptedEligibility,
  getNodeLifecycleState,
  initializeNodeLifecycle,
  normalizeLifecyclePath,
  transitionNodeLifecycle,
  type LifecycleMutationInput,
  type LifecycleMutationResult,
  type NodeLifecycleHistoryEntry,
  type NodeLifecycleRecord,
  type NodeLifecycleState,
} from "./node-lifecycle.js";

const NODE_LIFECYCLE_TRANSACTION_VERSION = "node_lifecycle_transaction_v1";
const NODE_LIFECYCLE_TRANSITION_ARTIFACT_VERSION = "node_lifecycle_transition_artifact_v1";
const LOCAL_BACKUP_ROOT = ".dino/local-backups/node-lifecycle";
const TRANSITION_ROOT = ".dino/lifecycle/transitions";

type JsonObject = Record<string, unknown>;

export type LifecycleBatchWrite = {
  target_path: string;
  record: JsonObject;
  transitions?: NodeLifecycleHistoryEntry[];
  expected_before_sha256?: string | null;
};

type TransactionArtifact = {
  path: string;
  existed_before: boolean;
  before_sha256: string | null;
  after_sha256: string;
  before_backup_path: string | null;
  after_backup_path: string;
};

type NodeLifecycleTransaction = {
  version: typeof NODE_LIFECYCLE_TRANSACTION_VERSION;
  transaction_id: string;
  status: "prepared" | "committed" | "rolled_back" | "recovery_blocked";
  actor: string;
  reason: string;
  created_at: string;
  updated_at: string;
  artifacts: TransactionArtifact[];
  transition_paths: string[];
  recovery_reason: string | null;
};

export type NodeLifecycleBatchResult = {
  transaction_id: string | null;
  transaction_path: string | null;
  changed_paths: string[];
  transition_paths: string[];
  idempotent: boolean;
};

export type NodeLifecycleFileTransitionResult = NodeLifecycleBatchResult & {
  target_path: string;
  state: NodeLifecycleState;
  transition_id: string;
  changed: boolean;
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

function lockPath(dataRoot: string): string {
  return dataPath(dataRoot, ".dino", "locks", "node-lifecycle.lock");
}

function localTransactionRoot(dataRoot: string): string {
  return dataPath(dataRoot, ...LOCAL_BACKUP_ROOT.split("/"));
}

function transactionRoot(dataRoot: string, transactionId: string): string {
  if (!/^node-lifecycle-[a-f0-9-]+$/i.test(transactionId)) throw new Error("Invalid node lifecycle transaction id");
  return path.join(localTransactionRoot(dataRoot), transactionId);
}

function transactionPath(dataRoot: string, transactionId: string): string {
  return path.join(transactionRoot(dataRoot, transactionId), "transaction.json");
}

function transitionPath(dataRoot: string, transitionId: string): string {
  if (!/^node-transition-[A-Za-z0-9._-]+$/.test(transitionId)) throw new Error("Invalid node lifecycle transition id");
  return dataPath(dataRoot, ...TRANSITION_ROOT.split("/"), `${transitionId}.json`);
}

function safeBackupName(index: number, targetPath: string, suffix: string): string {
  const leaf = path.basename(targetPath).replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 80) || "record";
  return `${String(index + 1).padStart(4, "0")}-${leaf}.${suffix}.bin`;
}

async function restoreArtifact(dataRoot: string, artifact: TransactionArtifact): Promise<void> {
  const target = dataPath(dataRoot, ...artifact.path.split("/"));
  if (!artifact.existed_before) {
    await fs.rm(target, { force: true });
    return;
  }
  if (!artifact.before_backup_path || !artifact.before_sha256) throw new Error(`Lifecycle backup missing: ${artifact.path}`);
  const bytes = await fs.readFile(dataPath(dataRoot, ...artifact.before_backup_path.split("/")));
  if (sha256(bytes) !== artifact.before_sha256) throw new Error(`Lifecycle backup hash mismatch: ${artifact.path}`);
  await atomicWriteBytes(target, bytes, async (candidatePath) => {
    if ((await hashIfPresent(candidatePath)) !== artifact.before_sha256) {
      throw new Error(`Lifecycle restore verification failed: ${artifact.path}`);
    }
  });
}

async function recoverTransactionUnlocked(dataRoot: string, filePath: string): Promise<void> {
  const transaction = JSON.parse(await fs.readFile(filePath, "utf8")) as NodeLifecycleTransaction;
  if (transaction.status === "recovery_blocked") {
    throw new Error(`Node lifecycle recovery requires manual repair: ${transaction.transaction_id}`);
  }
  if (transaction.status !== "prepared") return;
  const states = await Promise.all(
    transaction.artifacts.map(async (artifact) => ({
      artifact,
      current_sha256: await hashIfPresent(dataPath(dataRoot, ...artifact.path.split("/"))),
    })),
  );
  const conflicts = states.filter(
    ({ artifact, current_sha256 }) => current_sha256 !== artifact.before_sha256 && current_sha256 !== artifact.after_sha256,
  );
  if (conflicts.length > 0) {
    transaction.status = "recovery_blocked";
    transaction.updated_at = new Date().toISOString();
    transaction.recovery_reason = `external_change_detected:${conflicts.map(({ artifact }) => artifact.path).join(",")}`;
    await atomicWriteJson(filePath, transaction);
    throw new Error(`Node lifecycle recovery blocked by external changes: ${transaction.transaction_id}`);
  }
  for (const { artifact, current_sha256 } of [...states].reverse()) {
    if (current_sha256 === artifact.after_sha256) await restoreArtifact(dataRoot, artifact);
  }
  transaction.status = "rolled_back";
  transaction.updated_at = new Date().toISOString();
  transaction.recovery_reason = "prepared_transaction_restored_to_exact_before_bytes";
  await atomicWriteJson(filePath, transaction);
}

export async function recoverNodeLifecycleTransactionsUnlocked(dataRoot: string): Promise<number> {
  let directories: Array<import("node:fs").Dirent>;
  try {
    directories = await fs.readdir(localTransactionRoot(dataRoot), { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
  let recovered = 0;
  for (const entry of directories.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isDirectory()) continue;
    const filePath = path.join(localTransactionRoot(dataRoot), entry.name, "transaction.json");
    let transaction: NodeLifecycleTransaction;
    try {
      transaction = JSON.parse(await fs.readFile(filePath, "utf8")) as NodeLifecycleTransaction;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    if (transaction.status === "recovery_blocked") {
      throw new Error(`Node lifecycle transaction is blocked: ${transaction.transaction_id}`);
    }
    if (transaction.status !== "prepared") continue;
    await recoverTransactionUnlocked(dataRoot, filePath);
    recovered += 1;
  }
  return recovered;
}

export async function recoverNodeLifecycleTransactions(dataRoot: string): Promise<number> {
  return withFileLock(lockPath(dataRoot), () => recoverNodeLifecycleTransactionsUnlocked(dataRoot));
}

function transitionArtifact(
  transactionId: string,
  targetPath: string,
  beforeSha256: string | null,
  afterSha256: string,
  transition: NodeLifecycleHistoryEntry,
): JsonObject {
  return {
    version: NODE_LIFECYCLE_TRANSITION_ARTIFACT_VERSION,
    transition_id: transition.transition_id,
    transaction_id: transactionId,
    target_path: targetPath,
    from_state: transition.from_state,
    to_state: transition.to_state,
    reason_code: transition.reason_code,
    reason: transition.reason,
    actor: transition.actor,
    evidence_paths: transition.evidence_paths,
    predecessor_paths: transition.predecessor_paths,
    successor_paths: transition.successor_paths,
    at: transition.at,
    before_sha256: beforeSha256,
    after_sha256: afterSha256,
  };
}

async function writeBatchUnlocked(
  dataRoot: string,
  writes: LifecycleBatchWrite[],
  options: { actor: string; reason: string; fault_after_write_index_for_test?: number },
): Promise<NodeLifecycleBatchResult> {
  await recoverNodeLifecycleTransactionsUnlocked(dataRoot);
  const normalizedWrites = writes.map((write) => ({ ...write, target_path: normalizeLifecyclePath(write.target_path) }));
  if (new Set(normalizedWrites.map((write) => write.target_path)).size !== normalizedWrites.length) {
    throw new Error("Node lifecycle batch contains duplicate target paths");
  }
  const sourceStates = await Promise.all(
    normalizedWrites.map(async (write) => {
      const target = dataPath(dataRoot, ...write.target_path.split("/"));
      const before = await readIfPresent(target);
      const beforeSha256 = before === null ? null : sha256(before);
      if (write.expected_before_sha256 !== undefined && write.expected_before_sha256 !== beforeSha256) {
        throw new Error(`Node lifecycle source hash mismatch: ${write.target_path}`);
      }
      const after = serializeJson(write.record);
      return { write, target, before, beforeSha256, after, afterSha256: sha256(after) };
    }),
  );
  const changedSources = sourceStates.filter((state) => state.beforeSha256 !== state.afterSha256);
  if (changedSources.length === 0) {
    return { transaction_id: null, transaction_path: null, changed_paths: [], transition_paths: [], idempotent: true };
  }

  const transactionId = `node-lifecycle-${Date.now()}-${randomUUID()}`;
  const transitionWrites: Array<{
    target_path: string;
    target: string;
    before: Buffer | null;
    beforeSha256: string | null;
    after: Buffer;
    afterSha256: string;
  }> = [];
  for (const source of changedSources) {
    for (const transition of source.write.transitions ?? []) {
      const artifactPath = transitionPath(dataRoot, transition.transition_id);
      const artifactRelativePath = relDataPath(dataRoot, artifactPath);
      const before = await readIfPresent(artifactPath);
      if (before !== null) {
        const existing = JSON.parse(before.toString("utf8")) as JsonObject;
        if (existing.target_path === source.write.target_path && existing.after_sha256 === source.afterSha256) continue;
        throw new Error(`Lifecycle transition artifact already exists: ${artifactRelativePath}`);
      }
      const after = serializeJson(
        transitionArtifact(
          transactionId,
          source.write.target_path,
          source.beforeSha256,
          source.afterSha256,
          transition,
        ),
      );
      transitionWrites.push({
        target_path: artifactRelativePath,
        target: artifactPath,
        before,
        beforeSha256: null,
        after,
        afterSha256: sha256(after),
      });
    }
  }
  const allWrites = [
    ...transitionWrites,
    ...changedSources.map((source) => ({
      target_path: source.write.target_path,
      target: source.target,
      before: source.before,
      beforeSha256: source.beforeSha256,
      after: source.after,
      afterSha256: source.afterSha256,
    })),
  ];
  const localRoot = transactionRoot(dataRoot, transactionId);
  await fs.mkdir(localTransactionRoot(dataRoot), { recursive: true });
  await fs.mkdir(localRoot, { recursive: false });
  const artifacts: TransactionArtifact[] = [];
  const journalPath = transactionPath(dataRoot, transactionId);
  let transaction: NodeLifecycleTransaction;
  try {
    for (let index = 0; index < allWrites.length; index += 1) {
      const write = allWrites[index];
      const beforeBackup = write.before === null ? null : path.join(localRoot, safeBackupName(index, write.target_path, "before"));
      const afterBackup = path.join(localRoot, safeBackupName(index, write.target_path, "after"));
      if (write.before !== null) await writeExclusive(beforeBackup!, write.before);
      await writeExclusive(afterBackup, write.after);
      artifacts.push({
        path: write.target_path,
        existed_before: write.before !== null,
        before_sha256: write.beforeSha256,
        after_sha256: write.afterSha256,
        before_backup_path: beforeBackup ? relDataPath(dataRoot, beforeBackup) : null,
        after_backup_path: relDataPath(dataRoot, afterBackup),
      });
    }
    transaction = {
      version: NODE_LIFECYCLE_TRANSACTION_VERSION,
      transaction_id: transactionId,
      status: "prepared",
      actor: options.actor,
      reason: options.reason,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      artifacts,
      transition_paths: transitionWrites.map((write) => write.target_path),
      recovery_reason: null,
    };
    await atomicWriteJson(journalPath, transaction);
  } catch (error) {
    await fs.rm(localRoot, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
  try {
    for (let index = 0; index < allWrites.length; index += 1) {
      const write = allWrites[index];
      await atomicWriteBytes(write.target, write.after, async (candidatePath) => {
        if ((await hashIfPresent(candidatePath)) !== write.afterSha256) {
          throw new Error(`Node lifecycle write verification failed: ${write.target_path}`);
        }
      });
      if (options.fault_after_write_index_for_test === index) {
        throw new Error(`Injected node lifecycle batch fault after write ${index}`);
      }
    }
    transaction.status = "committed";
    transaction.updated_at = new Date().toISOString();
    await atomicWriteJson(journalPath, transaction);
    return {
      transaction_id: transactionId,
      transaction_path: relDataPath(dataRoot, journalPath),
      changed_paths: changedSources.map((state) => state.write.target_path),
      transition_paths: transaction.transition_paths,
      idempotent: false,
    };
  } catch (error) {
    await recoverTransactionUnlocked(dataRoot, journalPath);
    throw error;
  }
}

export async function writeNodeLifecycleBatch(
  dataRoot: string,
  writes: LifecycleBatchWrite[],
  options: { actor: string; reason: string; fault_after_write_index_for_test?: number },
): Promise<NodeLifecycleBatchResult> {
  return withFileLock(lockPath(dataRoot), () => writeBatchUnlocked(dataRoot, writes, options));
}

function requiredTransitionEvidence(toState: NodeLifecycleState, evidencePaths: string[]): void {
  if (["accepted", "demoted", "deletion-proposed", "deleted-tombstone"].includes(toState) && evidencePaths.length === 0) {
    throw new Error(`Lifecycle transition to ${toState} requires at least one evidence path`);
  }
}

function tombstoneRecord(
  original: JsonObject,
  mutation: LifecycleMutationResult,
  targetPath: string,
  deletedContentSha256: string,
): NodeLifecycleRecord {
  const lifecycle = mutation.record;
  return {
    node_id: lifecycle.node_id,
    type: "memory_tombstone",
    status: "deleted_tombstone",
    lifecycle_version: NODE_LIFECYCLE_VERSION,
    lifecycle_state: "deleted-tombstone",
    lifecycle_state_entered_at: lifecycle.lifecycle_state_entered_at,
    lifecycle_last_transition_id: lifecycle.lifecycle_last_transition_id,
    lifecycle_history: lifecycle.lifecycle_history,
    predecessor_paths: lifecycle.predecessor_paths,
    successor_paths: lifecycle.successor_paths,
    tombstone_for_path: targetPath,
    deleted_record_sha256: deletedContentSha256,
    deleted_record_type: String(original.type ?? "unknown"),
    deleted_at: lifecycle.lifecycle_state_entered_at,
    updated_at: lifecycle.lifecycle_state_entered_at,
  };
}

export async function transitionNodeLifecycleFile(
  dataRoot: string,
  input: LifecycleMutationInput & { expected_before_sha256?: string },
): Promise<NodeLifecycleFileTransitionResult> {
  const targetPath = normalizeLifecyclePath(input.target_path);
  const absolutePath = dataPath(dataRoot, ...targetPath.split("/"));
  const before = await fs.readFile(absolutePath);
  const beforeSha256 = sha256(before);
  if (input.expected_before_sha256 && input.expected_before_sha256 !== beforeSha256) {
    throw new Error(`Node lifecycle source hash mismatch: ${targetPath}`);
  }
  const record = JSON.parse(before.toString("utf8")) as JsonObject;
  const evidencePaths = (input.evidence_paths ?? []).map((value) => normalizeLifecyclePath(value));
  requiredTransitionEvidence(input.to_state, evidencePaths);
  const mutation = transitionNodeLifecycle(record, { ...input, target_path: targetPath, evidence_paths: evidencePaths });
  if (!mutation.changed) {
    return {
      transaction_id: null,
      transaction_path: null,
      changed_paths: [],
      transition_paths: [],
      idempotent: true,
      target_path: targetPath,
      state: mutation.record.lifecycle_state,
      transition_id: mutation.transition.transition_id,
      changed: false,
    };
  }
  if (mutation.record.lifecycle_state === "accepted") {
    const eligibility = await evaluateAcceptedEligibility(dataRoot, targetPath, mutation.record);
    if (!eligibility.eligible) throw new Error(`Accepted lifecycle gate blocked: ${eligibility.issues.join(",")}`);
  }
  const afterRecord = input.to_state === "deleted-tombstone"
    ? tombstoneRecord(record, mutation, targetPath, beforeSha256)
    : mutation.record;
  const previousHistoryLength = Array.isArray(record.lifecycle_history) ? record.lifecycle_history.length : 0;
  const batch = await writeNodeLifecycleBatch(
    dataRoot,
    [{
      target_path: targetPath,
      record: afterRecord,
      transitions: mutation.record.lifecycle_history.slice(previousHistoryLength),
      expected_before_sha256: beforeSha256,
    }],
    { actor: input.actor, reason: input.reason },
  );
  return {
    ...batch,
    target_path: targetPath,
    state: input.to_state,
    transition_id: mutation.transition.transition_id,
    changed: true,
  };
}

export async function rollbackNodeLifecycleTransaction(
  dataRoot: string,
  transactionId: string,
): Promise<{ transaction_id: string; restored_paths: string[] }> {
  return withFileLock(lockPath(dataRoot), async () => {
    await recoverNodeLifecycleTransactionsUnlocked(dataRoot);
    const filePath = transactionPath(dataRoot, transactionId);
    const transaction = JSON.parse(await fs.readFile(filePath, "utf8")) as NodeLifecycleTransaction;
    if (transaction.status === "rolled_back") return { transaction_id: transactionId, restored_paths: [] };
    if (transaction.status !== "committed") throw new Error(`Node lifecycle transaction is not committed: ${transaction.status}`);
    const states = await Promise.all(
      transaction.artifacts.map(async (artifact) => ({
        artifact,
        current: await hashIfPresent(dataPath(dataRoot, ...artifact.path.split("/"))),
      })),
    );
    const conflicts = states.filter(({ artifact, current }) => current !== artifact.after_sha256);
    if (conflicts.length > 0) {
      throw new Error(`Node lifecycle rollback blocked by external changes: ${conflicts.map(({ artifact }) => artifact.path).join(",")}`);
    }
    for (const { artifact } of [...states].reverse()) await restoreArtifact(dataRoot, artifact);
    transaction.status = "rolled_back";
    transaction.updated_at = new Date().toISOString();
    transaction.recovery_reason = "explicit_exact_rollback";
    await atomicWriteJson(filePath, transaction);
    return { transaction_id: transactionId, restored_paths: states.map(({ artifact }) => artifact.path) };
  });
}

export async function restoreDeletedNode(
  dataRoot: string,
  input: {
    target_path: string;
    deletion_transition_id: string;
    actor: string;
    reason: string;
    evidence_paths: string[];
  },
): Promise<NodeLifecycleFileTransitionResult> {
  const targetPath = normalizeLifecyclePath(input.target_path);
  const deletionArtifactPath = transitionPath(dataRoot, input.deletion_transition_id);
  const deletionArtifact = JSON.parse(await fs.readFile(deletionArtifactPath, "utf8")) as JsonObject;
  if (deletionArtifact.target_path !== targetPath || deletionArtifact.to_state !== "deleted-tombstone") {
    throw new Error("Deletion transition does not match tombstone target");
  }
  const transactionId = String(deletionArtifact.transaction_id ?? "");
  const transaction = JSON.parse(await fs.readFile(transactionPath(dataRoot, transactionId), "utf8")) as NodeLifecycleTransaction;
  const targetArtifact = transaction.artifacts.find((artifact) => artifact.path === targetPath);
  if (!targetArtifact?.before_backup_path || !targetArtifact.before_sha256) throw new Error("Deleted node exact backup is unavailable");
  const beforeBytes = await fs.readFile(dataPath(dataRoot, ...targetArtifact.before_backup_path.split("/")));
  if (sha256(beforeBytes) !== targetArtifact.before_sha256) throw new Error("Deleted node backup hash mismatch");
  const original = JSON.parse(beforeBytes.toString("utf8")) as JsonObject;
  const tombstoneBytes = await fs.readFile(dataPath(dataRoot, ...targetPath.split("/")));
  if (sha256(tombstoneBytes) !== targetArtifact.after_sha256) throw new Error("Tombstone changed after deletion");
  const tombstone = JSON.parse(tombstoneBytes.toString("utf8")) as JsonObject;
  const mutation = transitionNodeLifecycle(tombstone, {
    target_path: targetPath,
    to_state: "deletion-proposed",
    actor: input.actor,
    reason_code: "tombstone_restored",
    reason: input.reason,
    evidence_paths: [...input.evidence_paths, relDataPath(dataRoot, deletionArtifactPath)],
    allow_deleted_restore: true,
  });
  const restored: NodeLifecycleRecord = {
    ...original,
    lifecycle_version: mutation.record.lifecycle_version,
    lifecycle_state: mutation.record.lifecycle_state,
    lifecycle_state_entered_at: mutation.record.lifecycle_state_entered_at,
    lifecycle_last_transition_id: mutation.record.lifecycle_last_transition_id,
    lifecycle_history: mutation.record.lifecycle_history,
    predecessor_paths: mutation.record.predecessor_paths,
    successor_paths: mutation.record.successor_paths,
    status: "deletion_proposed",
    restored_from_transition_id: input.deletion_transition_id,
    restored_at: mutation.record.lifecycle_state_entered_at,
    updated_at: mutation.record.lifecycle_state_entered_at,
  };
  const batch = await writeNodeLifecycleBatch(
    dataRoot,
    [{
      target_path: targetPath,
      record: restored,
      transitions: [mutation.transition],
      expected_before_sha256: targetArtifact.after_sha256,
    }],
    { actor: input.actor, reason: input.reason },
  );
  return {
    ...batch,
    target_path: targetPath,
    state: "deletion-proposed",
    transition_id: mutation.transition.transition_id,
    changed: true,
  };
}

export function initializeLifecycleWrite(
  targetPath: string,
  record: JsonObject,
  input: Omit<LifecycleMutationInput, "target_path">,
): { write: LifecycleBatchWrite; mutation: LifecycleMutationResult } {
  const normalized = normalizeLifecyclePath(targetPath);
  const mutation = initializeNodeLifecycle(record, { ...input, target_path: normalized });
  const previousHistoryLength = Array.isArray(record.lifecycle_history) ? record.lifecycle_history.length : 0;
  return {
    write: {
      target_path: normalized,
      record: mutation.record,
      transitions: mutation.changed ? mutation.record.lifecycle_history.slice(previousHistoryLength) : [],
    },
    mutation,
  };
}

export function transitionLifecycleWrite(
  targetPath: string,
  record: JsonObject,
  input: Omit<LifecycleMutationInput, "target_path">,
): { write: LifecycleBatchWrite; mutation: LifecycleMutationResult } {
  const normalized = normalizeLifecyclePath(targetPath);
  const mutation = transitionNodeLifecycle(record, { ...input, target_path: normalized });
  const previousHistoryLength = Array.isArray(record.lifecycle_history) ? record.lifecycle_history.length : 0;
  return {
    write: {
      target_path: normalized,
      record: mutation.record,
      transitions: mutation.changed ? mutation.record.lifecycle_history.slice(previousHistoryLength) : [],
    },
    mutation,
  };
}

export async function currentNodeRecord(
  dataRoot: string,
  targetPath: string,
): Promise<{ record: JsonObject; sha256: string; state: NodeLifecycleState }> {
  const normalized = normalizeLifecyclePath(targetPath);
  const bytes = await fs.readFile(dataPath(dataRoot, ...normalized.split("/")));
  const record = JSON.parse(bytes.toString("utf8")) as JsonObject;
  return { record, sha256: sha256(bytes), state: getNodeLifecycleState(record, normalized) };
}
