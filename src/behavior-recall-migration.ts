import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

import { atomicWriteJson } from "./concurrency.js";
import { dataPath, relDataPath } from "./context.js";
import { rollbackNodeLifecycleTransaction, writeNodeLifecycleBatch } from "./node-lifecycle-store.js";

export const BEHAVIOR_RECALL_MIGRATION_VERSION = "behavior_recall_evidence_migration_v1";
export const BEHAVIOR_RECALL_MIGRATION_STATUS_RELATIVE_PATH = ".dino/state/behavior_recall_evidence_migration.json";
export const BEHAVIOR_RECALL_MIGRATION_ROOT = ".dino/migrations/behavior-recall";
export const BEHAVIOR_RECALL_MIGRATION_OPERATIONS_DIR = "60_Operations/behavior-recall-migrations";
export const BEHAVIOR_RECALL_LEDGER_PATH = ".dino/state/behavior_recall_audit.jsonl";

type JsonObject = Record<string, unknown>;

export type BehaviorRecallEvidenceRepair = {
  recall_id: string;
  task_id: string;
  old_evidence_path: string;
  new_evidence_path: string;
  source_entry_sha256: string;
  source_trace_sha256: string;
  reason_code: "unique_task_trace_match";
};

export type BehaviorRecallEvidenceMigrationArtifact = {
  version: typeof BEHAVIOR_RECALL_MIGRATION_VERSION;
  status: "applied";
  migration_id: string;
  generated_at: string;
  ledger_path: typeof BEHAVIOR_RECALL_LEDGER_PATH;
  repairs: BehaviorRecallEvidenceRepair[];
};

export type BehaviorRecallMigrationReport = {
  version: typeof BEHAVIOR_RECALL_MIGRATION_VERSION;
  status: "healthy" | "needs_apply" | "blocked" | "rolled_back";
  generated_at: string;
  apply: boolean;
  data_root: string;
  counts: {
    ledger_entries: number;
    missing_evidence: number;
    already_repaired: number;
    planned_repairs: number;
    unresolved: number;
    applied_repairs: number;
  };
  repairs: BehaviorRecallEvidenceRepair[];
  unresolved: Array<{ recall_id: string; task_id: string | null; evidence_path: string; reason_code: string }>;
  migration_id: string | null;
  migration_path: string | null;
  transaction_id: string | null;
  transaction_path: string | null;
  recovery_ref: string | null;
  rollback_transaction_id: string | null;
  warnings: string[];
  visible_status: string;
};

type LedgerEntry = JsonObject & {
  recall_id?: unknown;
  task_id?: unknown;
  evidence_path?: unknown;
};

type BuildOptions = {
  now?: Date;
  apply?: boolean;
  rollbackTransactionId?: string;
  requireGitRecoveryRef?: boolean;
  faultAfterWriteIndexForTest?: number;
};

const execFileAsync = promisify(execFile);

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function firstString(...values: unknown[]): string {
  for (const value of values) if (typeof value === "string" && value.trim()) return value.trim();
  return "";
}

function safeSlug(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 96) || "behavior-recall";
}

function normalizePath(value: string): string {
  const normalized = value.replace(/\\/g, "/").replace(/^\/+/, "").trim();
  if (!normalized || path.isAbsolute(normalized) || normalized.split("/").includes("..")) {
    throw new Error(`Invalid behavior recall path: ${value}`);
  }
  return normalized;
}

async function readJson<T>(filePath: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function fileSha256(filePath: string): Promise<string | null> {
  try {
    return sha256(await fs.readFile(filePath));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function pathExists(dataRoot: string, relativePath: string): Promise<boolean> {
  try {
    return (await fs.stat(dataPath(dataRoot, normalizePath(relativePath)))).isFile();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function readLedger(dataRoot: string): Promise<Array<{ entry: LedgerEntry; sha256: string }>> {
  let text: string;
  try {
    text = await fs.readFile(dataPath(dataRoot, BEHAVIOR_RECALL_LEDGER_PATH), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const entries: Array<{ entry: LedgerEntry; sha256: string }> = [];
  for (const line of text.split(/\r?\n/).map((value) => value.trim()).filter(Boolean)) {
    try {
      const entry = JSON.parse(line) as LedgerEntry;
      entries.push({ entry, sha256: sha256(JSON.stringify(entry)) });
    } catch {
      // Malformed rows remain the responsibility of the behavior recall status gate.
    }
  }
  return entries;
}

async function traceRecords(dataRoot: string): Promise<Array<{ path: string; task_id: string; sha256: string }>> {
  const dir = dataPath(dataRoot, ".dino/traces");
  let files: string[] = [];
  try {
    files = (await fs.readdir(dir)).filter((file) => file.endsWith(".json")).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const records: Array<{ path: string; task_id: string; sha256: string }> = [];
  for (const file of files) {
    const fullPath = path.join(dir, file);
    const bytes = await fs.readFile(fullPath);
    try {
      const record = JSON.parse(bytes.toString("utf8")) as JsonObject;
      const taskId = firstString(record.task_id);
      if (taskId) records.push({ path: relDataPath(dataRoot, fullPath), task_id: taskId, sha256: sha256(bytes) });
    } catch {
      // Parse failures remain visible to the full-memory audit.
    }
  }
  return records;
}

export async function loadAppliedBehaviorRecallRepairs(
  dataRoot: string,
): Promise<Map<string, { repair: BehaviorRecallEvidenceRepair; migration_path: string }>> {
  const dir = dataPath(dataRoot, BEHAVIOR_RECALL_MIGRATION_ROOT);
  let files: string[] = [];
  try {
    files = (await fs.readdir(dir)).filter((file) => file.endsWith(".json")).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return new Map();
    throw error;
  }
  const result = new Map<string, { repair: BehaviorRecallEvidenceRepair; migration_path: string }>();
  for (const file of files) {
    const relativePath = `${BEHAVIOR_RECALL_MIGRATION_ROOT}/${file}`;
    const artifact = await readJson<BehaviorRecallEvidenceMigrationArtifact>(dataPath(dataRoot, relativePath));
    if (!artifact || artifact.version !== BEHAVIOR_RECALL_MIGRATION_VERSION || artifact.status !== "applied") continue;
    for (const repair of artifact.repairs ?? []) result.set(repair.recall_id, { repair, migration_path: relativePath });
  }
  return result;
}

export async function validateBehaviorRecallEvidenceRepair(
  dataRoot: string,
  entry: JsonObject,
  repair: BehaviorRecallEvidenceRepair,
): Promise<{ ok: boolean; issues: string[] }> {
  const issues: string[] = [];
  if (firstString(entry.recall_id) !== repair.recall_id) issues.push("recall_id_mismatch");
  if (firstString(entry.task_id) !== repair.task_id) issues.push("task_id_mismatch");
  if (firstString(entry.evidence_path) !== repair.old_evidence_path) issues.push("old_evidence_path_mismatch");
  if (sha256(JSON.stringify(entry)) !== repair.source_entry_sha256) issues.push("source_entry_hash_mismatch");
  const tracePath = dataPath(dataRoot, normalizePath(repair.new_evidence_path));
  const traceHash = await fileSha256(tracePath);
  if (traceHash !== repair.source_trace_sha256) issues.push(traceHash ? "source_trace_hash_mismatch" : "source_trace_missing");
  const trace = await readJson<JsonObject>(tracePath);
  if (!trace || firstString(trace.task_id) !== repair.task_id) issues.push("source_trace_task_binding_mismatch");
  return { ok: issues.length === 0, issues };
}

async function createRecoveryRef(dataRoot: string, id: string, required: boolean): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", dataRoot, "rev-parse", "HEAD"], { windowsHide: true });
    const head = stdout.trim();
    if (!/^[0-9a-f]{40}$/i.test(head)) throw new Error("invalid_git_head");
    const recoveryRef = `refs/dinobrain-recovery/behavior-recall/${safeSlug(id)}`;
    await execFileAsync("git", ["-C", dataRoot, "update-ref", recoveryRef, head], { windowsHide: true });
    return recoveryRef;
  } catch (error) {
    if (required) throw new Error(`behavior_recall_migration_git_recovery_ref_failed:${(error as Error).message}`);
    return null;
  }
}

export async function applyBehaviorRecallEvidenceMigration(
  dataRoot: string,
  options: BuildOptions = {},
): Promise<{ report: BehaviorRecallMigrationReport; statusPath: string; operationsPath: string }> {
  const now = options.now ?? new Date();
  const generatedAt = now.toISOString();
  const statusPath = dataPath(dataRoot, BEHAVIOR_RECALL_MIGRATION_STATUS_RELATIVE_PATH);
  if (options.rollbackTransactionId) {
    await rollbackNodeLifecycleTransaction(dataRoot, options.rollbackTransactionId);
    const report: BehaviorRecallMigrationReport = {
      version: BEHAVIOR_RECALL_MIGRATION_VERSION,
      status: "rolled_back",
      generated_at: generatedAt,
      apply: false,
      data_root: path.resolve(dataRoot),
      counts: { ledger_entries: 0, missing_evidence: 0, already_repaired: 0, planned_repairs: 0, unresolved: 0, applied_repairs: 0 },
      repairs: [],
      unresolved: [],
      migration_id: null,
      migration_path: null,
      transaction_id: null,
      transaction_path: null,
      recovery_ref: null,
      rollback_transaction_id: options.rollbackTransactionId,
      warnings: [],
      visible_status: "Behavior recall evidence migration rolled back",
    };
    await atomicWriteJson(statusPath, report);
    return { report, statusPath, operationsPath: statusPath };
  }

  const [ledger, traces, applied] = await Promise.all([
    readLedger(dataRoot),
    traceRecords(dataRoot),
    loadAppliedBehaviorRecallRepairs(dataRoot),
  ]);
  const repairs: BehaviorRecallEvidenceRepair[] = [];
  const unresolved: BehaviorRecallMigrationReport["unresolved"] = [];
  let missingEvidence = 0;
  let alreadyRepaired = 0;
  for (const { entry, sha256: sourceEntrySha256 } of ledger) {
    const recallId = firstString(entry.recall_id);
    const evidencePath = firstString(entry.evidence_path);
    if (!recallId || !evidencePath || (await pathExists(dataRoot, evidencePath))) continue;
    missingEvidence += 1;
    const existing = applied.get(recallId);
    if (existing) {
      const validation = await validateBehaviorRecallEvidenceRepair(dataRoot, entry, existing.repair);
      if (validation.ok) {
        alreadyRepaired += 1;
        continue;
      }
    }
    const taskId = firstString(entry.task_id);
    const matches = taskId ? traces.filter((trace) => trace.task_id === taskId) : [];
    if (matches.length !== 1) {
      unresolved.push({
        recall_id: recallId,
        task_id: taskId || null,
        evidence_path: evidencePath,
        reason_code: !taskId ? "task_id_missing" : matches.length === 0 ? "matching_trace_missing" : "matching_trace_ambiguous",
      });
      continue;
    }
    repairs.push({
      recall_id: recallId,
      task_id: taskId,
      old_evidence_path: normalizePath(evidencePath),
      new_evidence_path: matches[0].path,
      source_entry_sha256: sourceEntrySha256,
      source_trace_sha256: matches[0].sha256,
      reason_code: "unique_task_trace_match",
    });
  }

  const apply = options.apply === true;
  const migrationId = repairs.length > 0
    ? `behavior-recall-${generatedAt.replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "-")}-${sha256(JSON.stringify(repairs)).slice(0, 12)}`
    : null;
  const migrationPath = migrationId ? `${BEHAVIOR_RECALL_MIGRATION_ROOT}/${migrationId}.json` : null;
  let transactionId: string | null = null;
  let transactionPath: string | null = null;
  let recoveryRef: string | null = null;
  if (apply && repairs.length > 0 && unresolved.length === 0 && migrationId && migrationPath) {
    recoveryRef = await createRecoveryRef(dataRoot, migrationId, options.requireGitRecoveryRef !== false);
    const artifact: BehaviorRecallEvidenceMigrationArtifact = {
      version: BEHAVIOR_RECALL_MIGRATION_VERSION,
      status: "applied",
      migration_id: migrationId,
      generated_at: generatedAt,
      ledger_path: BEHAVIOR_RECALL_LEDGER_PATH,
      repairs,
    };
    const transaction = await writeNodeLifecycleBatch(
      dataRoot,
      [{ target_path: migrationPath, record: artifact as unknown as JsonObject, expected_before_sha256: null }],
      {
        actor: "behavior-recall-migration",
        reason: `Apply ${repairs.length} traceable behavior recall evidence repairs.`,
        fault_after_write_index_for_test: options.faultAfterWriteIndexForTest,
      },
    );
    transactionId = transaction.transaction_id;
    transactionPath = transaction.transaction_path;
  }
  const status: BehaviorRecallMigrationReport["status"] = unresolved.length > 0
    ? "blocked"
    : repairs.length > 0 && !apply
      ? "needs_apply"
      : "healthy";
  const report: BehaviorRecallMigrationReport = {
    version: BEHAVIOR_RECALL_MIGRATION_VERSION,
    status,
    generated_at: generatedAt,
    apply,
    data_root: path.resolve(dataRoot),
    counts: {
      ledger_entries: ledger.length,
      missing_evidence: missingEvidence,
      already_repaired: alreadyRepaired,
      planned_repairs: repairs.length,
      unresolved: unresolved.length,
      applied_repairs: apply && transactionId ? repairs.length : 0,
    },
    repairs,
    unresolved,
    migration_id: migrationId,
    migration_path: migrationPath,
    transaction_id: transactionId,
    transaction_path: transactionPath,
    recovery_ref: recoveryRef,
    rollback_transaction_id: null,
    warnings: [
      status === "needs_apply" ? "behavior_recall_evidence_repairs_pending" : "",
      status === "blocked" ? "behavior_recall_evidence_repairs_unresolved" : "",
    ].filter(Boolean),
    visible_status: status === "healthy"
      ? "Behavior recall evidence migration healthy"
      : status === "needs_apply"
        ? "Behavior recall evidence migration needs apply"
        : "Behavior recall evidence migration blocked",
  };
  await atomicWriteJson(statusPath, report);
  let operationsPath = statusPath;
  if (apply && transactionId && repairs.length > 0) {
    operationsPath = dataPath(
      dataRoot,
      BEHAVIOR_RECALL_MIGRATION_OPERATIONS_DIR,
      `behavior-recall-migration-${generatedAt.slice(0, 10).replace(/-/g, "")}-${repairs.length}.json`,
    );
    await atomicWriteJson(operationsPath, {
      version: report.version,
      status: report.status,
      generated_at: report.generated_at,
      apply: report.apply,
      counts: report.counts,
      migration_id: report.migration_id,
      transaction_id: report.transaction_id,
      recovery_ref: report.recovery_ref,
      repairs: report.repairs.map((repair) => ({
        recall_id_hash: sha256(repair.recall_id),
        task_id_hash: sha256(repair.task_id),
        old_evidence_path_hash: sha256(repair.old_evidence_path),
        new_evidence_path_hash: sha256(repair.new_evidence_path),
        source_entry_sha256: repair.source_entry_sha256,
        source_trace_sha256: repair.source_trace_sha256,
        reason_code: repair.reason_code,
      })),
      unresolved_count: report.unresolved.length,
      note: "Public migration summary stores hashes only; task ids and trace paths remain local.",
    });
  }
  return { report, statusPath, operationsPath };
}
