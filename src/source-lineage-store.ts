import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import { atomicWriteBytes, atomicWriteJson, withFileLock } from "./concurrency.js";
import { dataPath, relDataPath } from "./context.js";

const SOURCE_LINEAGE_TRANSACTION_VERSION = "source_lineage_transaction_v1";
const SOURCE_LINEAGE_GENERATION_VERSION = "source_lineage_generation_v1";
const LOCAL_TRANSACTION_ROOT = ".dino/local-backups/source-lineage";
const GENERATION_ROOT = ".dino/provenance/generations";

type JsonObject = Record<string, unknown>;

export type SourceLineageClaimBinding = {
  path: string;
  sha256: string;
};

export type SourceLineageBatchWrite = {
  target_path: string;
  record: JsonObject;
  expected_before_sha256?: string | null;
};

export type SourceLineageGenerationDescriptor = {
  generation_id: string;
  source_snapshot_path: string;
  source_chunk_path: string;
  provenance_path: string;
  source_content_sha256: string;
  chunk_sha256: string;
  verification_status: string;
  verified_at: string | null;
  claim_bindings: SourceLineageClaimBinding[];
  evidence_bindings?: SourceLineageClaimBinding[];
};

type TransactionArtifact = {
  path: string;
  existed_before: boolean;
  before_sha256: string | null;
  after_sha256: string;
  before_backup_path: string | null;
  after_backup_path: string;
};

type SourceLineageTransaction = {
  version: typeof SOURCE_LINEAGE_TRANSACTION_VERSION;
  transaction_id: string;
  generation_id: string;
  status: "prepared" | "committed" | "rolled_back" | "recovery_blocked";
  actor: string;
  reason: string;
  created_at: string;
  updated_at: string;
  artifacts: TransactionArtifact[];
  claim_bindings: SourceLineageClaimBinding[];
  generation_receipt_path: string;
  recovery_reason: string | null;
  reapply_count: number;
};

export type SourceLineageTransactionResult = {
  transaction_id: string;
  transaction_path: string;
  generation_id: string;
  generation_receipt_path: string;
  changed_paths: string[];
  idempotent: boolean;
  status: "committed" | "rolled_back";
};

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function serializeJson(value: unknown): Buffer {
  const serialized = `${JSON.stringify(value, null, 2)}\n`;
  JSON.parse(serialized);
  return Buffer.from(serialized, "utf8");
}

function normalizePath(value: string): string {
  const normalized = value.replace(/\\/g, "/").replace(/^\/+/, "");
  if (!normalized || normalized.split("/").some((part) => part === "..")) {
    throw new Error(`Invalid source lineage path: ${value}`);
  }
  return normalized;
}

function validateId(value: string, label: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(value)) throw new Error(`Invalid ${label}: ${value}`);
  return value;
}

function lockPath(dataRoot: string): string {
  return dataPath(dataRoot, ".dino", "locks", "source-lineage.lock");
}

function transactionRoot(dataRoot: string, transactionId: string): string {
  validateId(transactionId, "source lineage transaction id");
  return dataPath(dataRoot, ...LOCAL_TRANSACTION_ROOT.split("/"), transactionId);
}

function transactionPath(dataRoot: string, transactionId: string): string {
  return path.join(transactionRoot(dataRoot, transactionId), "transaction.json");
}

export function sourceLineageGenerationPath(generationId: string): string {
  validateId(generationId, "source lineage generation id");
  return `${GENERATION_ROOT}/${generationId}.json`;
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
  const bytes = await readIfPresent(filePath);
  return bytes === null ? null : sha256(bytes);
}

async function writeExclusive(filePath: string, bytes: Uint8Array): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const handle = await fs.open(filePath, "wx");
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function backupName(index: number, targetPath: string, suffix: string): string {
  const leaf = path.basename(targetPath).replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 80) || "record";
  return `${String(index + 1).padStart(4, "0")}-${leaf}.${suffix}.bin`;
}

async function verifyClaimBindings(dataRoot: string, bindings: SourceLineageClaimBinding[]): Promise<void> {
  for (const binding of bindings) {
    const current = await hashIfPresent(dataPath(dataRoot, ...normalizePath(binding.path).split("/")));
    if (current !== binding.sha256) {
      throw new Error(`Source lineage claim hash mismatch: ${binding.path}`);
    }
  }
}

async function restoreArtifact(dataRoot: string, artifact: TransactionArtifact): Promise<void> {
  const target = dataPath(dataRoot, ...artifact.path.split("/"));
  if (!artifact.existed_before) {
    await fs.rm(target, { force: true });
    return;
  }
  if (!artifact.before_backup_path || !artifact.before_sha256) {
    throw new Error(`Source lineage backup missing: ${artifact.path}`);
  }
  const backup = await fs.readFile(dataPath(dataRoot, ...artifact.before_backup_path.split("/")));
  if (sha256(backup) !== artifact.before_sha256) {
    throw new Error(`Source lineage backup hash mismatch: ${artifact.path}`);
  }
  await atomicWriteBytes(target, backup, async (candidatePath) => {
    if ((await hashIfPresent(candidatePath)) !== artifact.before_sha256) {
      throw new Error(`Source lineage restore verification failed: ${artifact.path}`);
    }
  });
}

async function applyArtifact(dataRoot: string, artifact: TransactionArtifact): Promise<void> {
  const backup = await fs.readFile(dataPath(dataRoot, ...artifact.after_backup_path.split("/")));
  if (sha256(backup) !== artifact.after_sha256) {
    throw new Error(`Source lineage after-backup hash mismatch: ${artifact.path}`);
  }
  const target = dataPath(dataRoot, ...artifact.path.split("/"));
  await atomicWriteBytes(target, backup, async (candidatePath) => {
    if ((await hashIfPresent(candidatePath)) !== artifact.after_sha256) {
      throw new Error(`Source lineage reapply verification failed: ${artifact.path}`);
    }
  });
}

async function readTransaction(dataRoot: string, transactionId: string): Promise<SourceLineageTransaction> {
  const parsed = JSON.parse(await fs.readFile(transactionPath(dataRoot, transactionId), "utf8")) as SourceLineageTransaction;
  if (parsed.version !== SOURCE_LINEAGE_TRANSACTION_VERSION || parsed.transaction_id !== transactionId) {
    throw new Error(`Invalid source lineage transaction: ${transactionId}`);
  }
  return parsed;
}

async function recoverPreparedUnlocked(dataRoot: string, journalPath: string): Promise<void> {
  const transaction = JSON.parse(await fs.readFile(journalPath, "utf8")) as SourceLineageTransaction;
  if (transaction.status === "recovery_blocked") {
    throw new Error(`Source lineage recovery requires manual repair: ${transaction.transaction_id}`);
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
    await atomicWriteJson(journalPath, transaction);
    throw new Error(`Source lineage recovery blocked by external changes: ${transaction.transaction_id}`);
  }
  for (const { artifact, current_sha256 } of [...states].reverse()) {
    if (current_sha256 === artifact.after_sha256) await restoreArtifact(dataRoot, artifact);
  }
  transaction.status = "rolled_back";
  transaction.updated_at = new Date().toISOString();
  transaction.recovery_reason = "prepared_transaction_restored_to_exact_before_bytes";
  await atomicWriteJson(journalPath, transaction);
}

async function recoverPreparedTransactionsUnlocked(dataRoot: string): Promise<number> {
  const root = dataPath(dataRoot, ...LOCAL_TRANSACTION_ROOT.split("/"));
  let entries: Array<import("node:fs").Dirent>;
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
  let recovered = 0;
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isDirectory()) continue;
    const journalPath = path.join(root, entry.name, "transaction.json");
    let status: string | null = null;
    try {
      status = String((JSON.parse(await fs.readFile(journalPath, "utf8")) as { status?: unknown }).status ?? "");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    if (status === "recovery_blocked") throw new Error(`Source lineage transaction is blocked: ${entry.name}`);
    if (status !== "prepared") continue;
    await recoverPreparedUnlocked(dataRoot, journalPath);
    recovered += 1;
  }
  return recovered;
}

export async function recoverSourceLineageTransactions(dataRoot: string): Promise<number> {
  return withFileLock(lockPath(dataRoot), () => recoverPreparedTransactionsUnlocked(dataRoot));
}

function generationReceipt(
  transactionId: string,
  descriptor: SourceLineageGenerationDescriptor,
  artifacts: Array<{ path: string; after_sha256: string }>,
  createdAt: string,
): JsonObject {
  return {
    version: SOURCE_LINEAGE_GENERATION_VERSION,
    type: "lineage_generation",
    generation_id: descriptor.generation_id,
    generation_status: "published",
    transaction_id: transactionId,
    source_snapshot_path: descriptor.source_snapshot_path,
    source_chunk_path: descriptor.source_chunk_path,
    provenance_path: descriptor.provenance_path,
    source_content_sha256: descriptor.source_content_sha256,
    chunk_sha256: descriptor.chunk_sha256,
    verification_status: descriptor.verification_status,
    verified_at: descriptor.verified_at,
    claim_bindings: descriptor.claim_bindings,
    evidence_bindings: descriptor.evidence_bindings ?? [],
    artifact_bindings: artifacts,
    created_at: createdAt,
    updated_at: createdAt,
  };
}

export async function writeSourceLineageGeneration(
  dataRoot: string,
  writes: SourceLineageBatchWrite[],
  descriptor: SourceLineageGenerationDescriptor,
  options: {
    actor: string;
    reason: string;
    fault_after_write_index_for_test?: number;
  },
): Promise<SourceLineageTransactionResult> {
  return withFileLock(lockPath(dataRoot), async () => {
    await recoverPreparedTransactionsUnlocked(dataRoot);
    const generationId = validateId(descriptor.generation_id, "source lineage generation id");
    const receiptPath = sourceLineageGenerationPath(generationId);
    const existingReceiptBytes = await readIfPresent(dataPath(dataRoot, ...receiptPath.split("/")));
    if (existingReceiptBytes) {
      const receipt = JSON.parse(existingReceiptBytes.toString("utf8")) as {
        transaction_id?: unknown;
        artifact_bindings?: Array<{ path?: unknown; after_sha256?: unknown }>;
      };
      const bindings = Array.isArray(receipt.artifact_bindings) ? receipt.artifact_bindings : [];
      const allMatch = await Promise.all(
        bindings.map(async (binding) => {
          if (typeof binding.path !== "string" || typeof binding.after_sha256 !== "string") return false;
          return (await hashIfPresent(dataPath(dataRoot, ...normalizePath(binding.path).split("/")))) === binding.after_sha256;
        }),
      );
      if (bindings.length === writes.length && allMatch.every(Boolean) && typeof receipt.transaction_id === "string") {
        return {
          transaction_id: receipt.transaction_id,
          transaction_path: relDataPath(dataRoot, transactionPath(dataRoot, receipt.transaction_id)),
          generation_id: generationId,
          generation_receipt_path: receiptPath,
          changed_paths: [],
          idempotent: true,
          status: "committed",
        };
      }
      throw new Error(`Source lineage generation receipt conflicts with current artifacts: ${generationId}`);
    }

    if (new Set(writes.map((write) => normalizePath(write.target_path))).size !== writes.length) {
      throw new Error("Source lineage batch contains duplicate target paths");
    }
    const allBindings = [...descriptor.claim_bindings, ...(descriptor.evidence_bindings ?? [])];
    await verifyClaimBindings(dataRoot, allBindings);
    const transactionId = `source-lineage-${Date.now()}-${randomUUID()}`;
    const createdAt = new Date().toISOString();
    const sourceStates = await Promise.all(
      writes.map(async (write) => {
        const targetPath = normalizePath(write.target_path);
        const target = dataPath(dataRoot, ...targetPath.split("/"));
        const before = await readIfPresent(target);
        const beforeSha256 = before === null ? null : sha256(before);
        if (write.expected_before_sha256 !== undefined && write.expected_before_sha256 !== beforeSha256) {
          throw new Error(`Source lineage source hash mismatch: ${targetPath}`);
        }
        const after = serializeJson(write.record);
        return { target_path: targetPath, target, before, beforeSha256, after, afterSha256: sha256(after) };
      }),
    );
    const changedSources = sourceStates.filter((state) => state.beforeSha256 !== state.afterSha256);
    const receiptRecord = generationReceipt(
      transactionId,
      descriptor,
      sourceStates.map((state) => ({ path: state.target_path, after_sha256: state.afterSha256 })),
      createdAt,
    );
    const receiptTarget = dataPath(dataRoot, ...receiptPath.split("/"));
    const receiptAfter = serializeJson(receiptRecord);
    const allStates = [
      ...changedSources,
      {
        target_path: receiptPath,
        target: receiptTarget,
        before: null,
        beforeSha256: null,
        after: receiptAfter,
        afterSha256: sha256(receiptAfter),
      },
    ];

    const localRoot = transactionRoot(dataRoot, transactionId);
    await fs.mkdir(path.dirname(localRoot), { recursive: true });
    await fs.mkdir(localRoot, { recursive: false });
    const artifacts: TransactionArtifact[] = [];
    const journalPath = transactionPath(dataRoot, transactionId);
    let transaction: SourceLineageTransaction;
    try {
      for (let index = 0; index < allStates.length; index += 1) {
        const state = allStates[index];
        const beforeBackup = state.before === null ? null : path.join(localRoot, backupName(index, state.target_path, "before"));
        const afterBackup = path.join(localRoot, backupName(index, state.target_path, "after"));
        if (state.before !== null) await writeExclusive(beforeBackup!, state.before);
        await writeExclusive(afterBackup, state.after);
        artifacts.push({
          path: state.target_path,
          existed_before: state.before !== null,
          before_sha256: state.beforeSha256,
          after_sha256: state.afterSha256,
          before_backup_path: beforeBackup ? relDataPath(dataRoot, beforeBackup) : null,
          after_backup_path: relDataPath(dataRoot, afterBackup),
        });
      }
      transaction = {
        version: SOURCE_LINEAGE_TRANSACTION_VERSION,
        transaction_id: transactionId,
        generation_id: generationId,
        status: "prepared",
        actor: options.actor,
        reason: options.reason,
        created_at: createdAt,
        updated_at: createdAt,
        artifacts,
        claim_bindings: allBindings,
        generation_receipt_path: receiptPath,
        recovery_reason: null,
        reapply_count: 0,
      };
      await atomicWriteJson(journalPath, transaction);
    } catch (error) {
      await fs.rm(localRoot, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }

    try {
      for (let index = 0; index < allStates.length; index += 1) {
        const state = allStates[index];
        await atomicWriteBytes(state.target, state.after, async (candidatePath) => {
          if ((await hashIfPresent(candidatePath)) !== state.afterSha256) {
            throw new Error(`Source lineage write verification failed: ${state.target_path}`);
          }
        });
        if (options.fault_after_write_index_for_test === index) {
          throw new Error(`Injected source lineage transaction fault after write ${index}`);
        }
      }
      await verifyClaimBindings(dataRoot, allBindings);
      transaction.status = "committed";
      transaction.updated_at = new Date().toISOString();
      await atomicWriteJson(journalPath, transaction);
      return {
        transaction_id: transactionId,
        transaction_path: relDataPath(dataRoot, journalPath),
        generation_id: generationId,
        generation_receipt_path: receiptPath,
        changed_paths: allStates.map((state) => state.target_path),
        idempotent: false,
        status: "committed",
      };
    } catch (error) {
      await recoverPreparedUnlocked(dataRoot, journalPath);
      throw error;
    }
  });
}

export async function rollbackSourceLineageTransaction(
  dataRoot: string,
  transactionId: string,
): Promise<SourceLineageTransactionResult> {
  return withFileLock(lockPath(dataRoot), async () => {
    await recoverPreparedTransactionsUnlocked(dataRoot);
    const transaction = await readTransaction(dataRoot, transactionId);
    if (transaction.status === "rolled_back") {
      return {
        transaction_id: transactionId,
        transaction_path: relDataPath(dataRoot, transactionPath(dataRoot, transactionId)),
        generation_id: transaction.generation_id,
        generation_receipt_path: transaction.generation_receipt_path,
        changed_paths: [],
        idempotent: true,
        status: "rolled_back",
      };
    }
    if (transaction.status !== "committed") throw new Error(`Source lineage transaction is not committed: ${transactionId}`);
    const conflicts = [];
    for (const artifact of transaction.artifacts) {
      const current = await hashIfPresent(dataPath(dataRoot, ...artifact.path.split("/")));
      if (current !== artifact.after_sha256) conflicts.push(artifact.path);
    }
    if (conflicts.length > 0) throw new Error(`Source lineage rollback blocked by external changes: ${conflicts.join(",")}`);
    for (const artifact of [...transaction.artifacts].reverse()) await restoreArtifact(dataRoot, artifact);
    transaction.status = "rolled_back";
    transaction.updated_at = new Date().toISOString();
    transaction.recovery_reason = "explicit_exact_rollback";
    await atomicWriteJson(transactionPath(dataRoot, transactionId), transaction);
    return {
      transaction_id: transactionId,
      transaction_path: relDataPath(dataRoot, transactionPath(dataRoot, transactionId)),
      generation_id: transaction.generation_id,
      generation_receipt_path: transaction.generation_receipt_path,
      changed_paths: transaction.artifacts.map((artifact) => artifact.path),
      idempotent: false,
      status: "rolled_back",
    };
  });
}

export async function reapplySourceLineageTransaction(
  dataRoot: string,
  transactionId: string,
): Promise<SourceLineageTransactionResult> {
  return withFileLock(lockPath(dataRoot), async () => {
    await recoverPreparedTransactionsUnlocked(dataRoot);
    const transaction = await readTransaction(dataRoot, transactionId);
    if (transaction.status === "committed") {
      return {
        transaction_id: transactionId,
        transaction_path: relDataPath(dataRoot, transactionPath(dataRoot, transactionId)),
        generation_id: transaction.generation_id,
        generation_receipt_path: transaction.generation_receipt_path,
        changed_paths: [],
        idempotent: true,
        status: "committed",
      };
    }
    if (transaction.status !== "rolled_back") throw new Error(`Source lineage transaction is not rolled back: ${transactionId}`);
    for (const artifact of transaction.artifacts) {
      const current = await hashIfPresent(dataPath(dataRoot, ...artifact.path.split("/")));
      if (current !== artifact.before_sha256) {
        throw new Error(`Source lineage reapply blocked by external changes: ${artifact.path}`);
      }
    }
    await verifyClaimBindings(dataRoot, transaction.claim_bindings);
    for (const artifact of transaction.artifacts) await applyArtifact(dataRoot, artifact);
    transaction.status = "committed";
    transaction.updated_at = new Date().toISOString();
    transaction.recovery_reason = "explicit_exact_reapply";
    transaction.reapply_count += 1;
    await atomicWriteJson(transactionPath(dataRoot, transactionId), transaction);
    return {
      transaction_id: transactionId,
      transaction_path: relDataPath(dataRoot, transactionPath(dataRoot, transactionId)),
      generation_id: transaction.generation_id,
      generation_receipt_path: transaction.generation_receipt_path,
      changed_paths: transaction.artifacts.map((artifact) => artifact.path),
      idempotent: false,
      status: "committed",
    };
  });
}
