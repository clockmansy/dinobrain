import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

import { atomicWriteJson } from "./concurrency.js";
import {
  rollbackNodeLifecycleTransaction,
  writeNodeLifecycleBatch,
} from "./node-lifecycle-store.js";

export const COLD_PARTITION_VERSION = "cold_partition_index_v1";
export const COLD_PARTITION_STATUS_RELATIVE_PATH = ".dino/state/cold_partitions.json";
export const COLD_PARTITION_INDEX_RELATIVE_PATH = ".dino/index/cold-partitions.json";
export const COLD_PARTITION_OPERATIONS_DIR = "60_Operations/cold-partitions";

export type ColdPartitionKind = "task" | "trace" | "context_pack" | "report" | "obsolete_rule";

type JsonObject = Record<string, unknown>;

export type ColdPartitionEntry = {
  path: string;
  kind: ColdPartitionKind;
  partition: string;
  source_time: string;
  source_sha256: string;
  size_bytes: number;
  reason_code: string;
  indexed_at: string;
};

export type ColdPartitionIndex = {
  version: typeof COLD_PARTITION_VERSION;
  generated_at: string;
  entries: ColdPartitionEntry[];
  partitions: Record<string, { entries: number; bytes: number; by_kind: Partial<Record<ColdPartitionKind, number>> }>;
};

export type ColdPartitionReport = {
  version: typeof COLD_PARTITION_VERSION;
  status: "healthy" | "needs_apply" | "rolled_back";
  generated_at: string;
  apply: boolean;
  data_root: string;
  retention_days: Record<Exclude<ColdPartitionKind, "obsolete_rule">, number>;
  counts: {
    indexed_before: number;
    planned: number;
    applied: number;
    indexed_after: number;
    partitions: number;
  };
  planned_entries: ColdPartitionEntry[];
  transaction_id: string | null;
  transaction_path: string | null;
  recovery_ref: string | null;
  rollback_transaction_id: string | null;
  warnings: string[];
  visible_status: string;
};

type ColdPartitionOptions = {
  now?: Date;
  apply?: boolean;
  rollbackTransactionId?: string;
  requireGitRecoveryRef?: boolean;
  taskRetentionDays?: number;
  traceRetentionDays?: number;
  contextPackRetentionDays?: number;
  reportRetentionDays?: number;
  faultAfterWriteIndexForTest?: number;
};

const execFileAsync = promisify(execFile);

function isInside(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!!relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}

function dataPath(dataRoot: string, ...parts: string[]): string {
  const root = path.resolve(dataRoot);
  const target = path.resolve(root, ...parts);
  if (!isInside(target, root)) throw new Error(`Path escapes data root: ${parts.join("/")}`);
  return target;
}

function relDataPath(dataRoot: string, filePath: string): string {
  return path.relative(path.resolve(dataRoot), path.resolve(filePath)).replace(/\\/g, "/");
}

function sha256(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function firstString(...values: unknown[]): string {
  for (const value of values) if (typeof value === "string" && value.trim()) return value.trim();
  return "";
}

function safeSlug(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 96) || "cold-partition";
}

function parseTime(value: string): number | null {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function partitionFor(value: string): string {
  return value.slice(0, 7);
}

function isOlderThan(sourceTime: string, now: Date, days: number): boolean {
  const parsed = parseTime(sourceTime);
  return parsed !== null && now.getTime() - parsed >= days * 24 * 60 * 60 * 1000;
}

async function readJson<T>(filePath: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function walkFiles(dir: string, extensions: Set<string>, output: string[] = []): Promise<string[]> {
  let entries: Array<import("node:fs").Dirent>;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return output;
    throw error;
  }
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) await walkFiles(fullPath, extensions, output);
    else if (entry.isFile() && extensions.has(path.extname(entry.name).toLowerCase())) output.push(fullPath);
  }
  return output;
}

async function candidateEntry(
  dataRoot: string,
  filePath: string,
  kind: ColdPartitionKind,
  now: Date,
  retentionDays: number,
): Promise<ColdPartitionEntry | null> {
  const bytes = await fs.readFile(filePath);
  const relativePath = relDataPath(dataRoot, filePath);
  const stat = await fs.stat(filePath);
  let record: JsonObject = {};
  if (path.extname(filePath).toLowerCase() === ".json") {
    try {
      record = JSON.parse(bytes.toString("utf8")) as JsonObject;
    } catch {
      return null;
    }
  }
  if (firstString(record.temperature).toLowerCase() === "cold" || firstString(record.cold_partition)) return null;
  const sourceTime = firstString(
    record.finished_at,
    record.updated_at,
    record.created_at,
    record.generated_at,
    record.at,
    stat.mtime.toISOString(),
  );
  if (kind === "obsolete_rule") {
    const state = firstString(record.lifecycle_state, record.status).toLowerCase();
    if (!["archived", "demoted", "deletion-proposed", "deleted-tombstone"].includes(state)) return null;
  } else if (!isOlderThan(sourceTime, now, retentionDays)) {
    return null;
  }
  if (kind === "task") {
    const status = firstString(record.status).toLowerCase();
    if (!["completed", "blocked", "failed", "cancelled", "abandoned"].includes(status)) return null;
  }
  return {
    path: relativePath,
    kind,
    partition: partitionFor(sourceTime),
    source_time: sourceTime,
    source_sha256: sha256(bytes),
    size_bytes: bytes.length,
    reason_code: kind === "obsolete_rule" ? "obsolete_rule_cold_partition" : `${kind}_retention_elapsed`,
    indexed_at: now.toISOString(),
  };
}

function summarizePartitions(entries: ColdPartitionEntry[]): ColdPartitionIndex["partitions"] {
  const partitions: ColdPartitionIndex["partitions"] = {};
  for (const entry of entries) {
    const current = partitions[entry.partition] ?? { entries: 0, bytes: 0, by_kind: {} };
    current.entries += 1;
    current.bytes += entry.size_bytes;
    current.by_kind[entry.kind] = Number(current.by_kind[entry.kind] ?? 0) + 1;
    partitions[entry.partition] = current;
  }
  return Object.fromEntries(Object.entries(partitions).sort(([left], [right]) => left.localeCompare(right)));
}

async function createRecoveryRef(dataRoot: string, id: string, required: boolean): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", dataRoot, "rev-parse", "HEAD"], { windowsHide: true });
    const head = stdout.trim();
    if (!/^[0-9a-f]{40}$/i.test(head)) throw new Error("invalid_git_head");
    const recoveryRef = `refs/dinobrain-recovery/cold-partition/${safeSlug(id)}`;
    await execFileAsync("git", ["-C", dataRoot, "update-ref", recoveryRef, head], { windowsHide: true });
    return recoveryRef;
  } catch (error) {
    if (required) throw new Error(`cold_partition_git_recovery_ref_failed:${(error as Error).message}`);
    return null;
  }
}

export function getColdPartitionIndexPath(dataRoot: string): string {
  return dataPath(dataRoot, ...COLD_PARTITION_INDEX_RELATIVE_PATH.split("/"));
}

export function getColdPartitionStatusPath(dataRoot: string): string {
  return dataPath(dataRoot, ...COLD_PARTITION_STATUS_RELATIVE_PATH.split("/"));
}

export async function readColdPartitionIndex(dataRoot: string): Promise<ColdPartitionIndex | null> {
  const value = await readJson<ColdPartitionIndex>(getColdPartitionIndexPath(dataRoot));
  return value?.version === COLD_PARTITION_VERSION ? value : null;
}

export async function collectColdPartitionPaths(dataRoot: string): Promise<Set<string>> {
  const index = await readColdPartitionIndex(dataRoot);
  return new Set((index?.entries ?? []).map((entry) => entry.path));
}

export async function buildColdPartitionPlan(
  dataRoot: string,
  options: ColdPartitionOptions = {},
): Promise<{ existing: ColdPartitionIndex; planned: ColdPartitionEntry[]; retention: ColdPartitionReport["retention_days"] }> {
  const now = options.now ?? new Date();
  const retention = {
    task: options.taskRetentionDays ?? 90,
    trace: options.traceRetentionDays ?? 90,
    context_pack: options.contextPackRetentionDays ?? 30,
    report: options.reportRetentionDays ?? 180,
  };
  const existing =
    (await readColdPartitionIndex(dataRoot)) ??
    ({ version: COLD_PARTITION_VERSION, generated_at: now.toISOString(), entries: [], partitions: {} } satisfies ColdPartitionIndex);
  const indexedPaths = new Set(existing.entries.map((entry) => entry.path));
  const sourceSets: Array<{ root: string; kind: ColdPartitionKind; retentionDays: number; extensions: Set<string> }> = [
    { root: ".dino/tasks", kind: "task", retentionDays: retention.task, extensions: new Set([".json"]) },
    { root: ".dino/traces", kind: "trace", retentionDays: retention.trace, extensions: new Set([".json"]) },
    { root: ".dino/context-packs", kind: "context_pack", retentionDays: retention.context_pack, extensions: new Set([".json"]) },
    { root: "60_Operations", kind: "report", retentionDays: retention.report, extensions: new Set([".json", ".md"]) },
    { root: "50_Instances/accepted", kind: "obsolete_rule", retentionDays: 0, extensions: new Set([".json"]) },
  ];
  const planned: ColdPartitionEntry[] = [];
  for (const source of sourceSets) {
    const files = await walkFiles(dataPath(dataRoot, ...source.root.split("/")), source.extensions);
    for (const file of files) {
      const relativePath = relDataPath(dataRoot, file);
      if (indexedPaths.has(relativePath)) continue;
      const entry = await candidateEntry(dataRoot, file, source.kind, now, source.retentionDays);
      if (entry) planned.push(entry);
    }
  }
  planned.sort((left, right) => left.partition.localeCompare(right.partition) || left.path.localeCompare(right.path));
  return { existing, planned, retention };
}

export async function applyColdPartitions(
  dataRoot: string,
  options: ColdPartitionOptions = {},
): Promise<{ report: ColdPartitionReport; statusPath: string; operationsPath: string }> {
  const now = options.now ?? new Date();
  const generatedAt = now.toISOString();
  const statusPath = getColdPartitionStatusPath(dataRoot);
  if (options.rollbackTransactionId) {
    await rollbackNodeLifecycleTransaction(dataRoot, options.rollbackTransactionId);
    const report: ColdPartitionReport = {
      version: COLD_PARTITION_VERSION,
      status: "rolled_back",
      generated_at: generatedAt,
      apply: false,
      data_root: path.resolve(dataRoot),
      retention_days: { task: 90, trace: 90, context_pack: 30, report: 180 },
      counts: { indexed_before: 0, planned: 0, applied: 0, indexed_after: 0, partitions: 0 },
      planned_entries: [],
      transaction_id: null,
      transaction_path: null,
      recovery_ref: null,
      rollback_transaction_id: options.rollbackTransactionId,
      warnings: [],
      visible_status: "Cold partition index rolled back",
    };
    await atomicWriteJson(statusPath, report);
    return { report, statusPath, operationsPath: statusPath };
  }
  const plan = await buildColdPartitionPlan(dataRoot, { ...options, now });
  const apply = options.apply === true;
  const migrationId = `cold-partition-${Date.now()}-${sha256(plan.planned.map((entry) => entry.path).join("|")).slice(0, 12)}`;
  let recoveryRef: string | null = null;
  let transactionId: string | null = null;
  let transactionPath: string | null = null;
  let index = plan.existing;
  try {
    await fs.access(getColdPartitionIndexPath(dataRoot));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await atomicWriteJson(getColdPartitionIndexPath(dataRoot), index);
  }
  if (apply && plan.planned.length > 0) {
    recoveryRef = await createRecoveryRef(dataRoot, migrationId, options.requireGitRecoveryRef !== false);
    const nextEntries = [...plan.existing.entries, ...plan.planned].sort(
      (left, right) => left.partition.localeCompare(right.partition) || left.path.localeCompare(right.path),
    );
    index = {
      version: COLD_PARTITION_VERSION,
      generated_at: generatedAt,
      entries: nextEntries,
      partitions: summarizePartitions(nextEntries),
    };
    const existingBytes = await fs.readFile(getColdPartitionIndexPath(dataRoot)).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    const transaction = await writeNodeLifecycleBatch(
      dataRoot,
      [
        {
          target_path: COLD_PARTITION_INDEX_RELATIVE_PATH,
          record: index as unknown as JsonObject,
          expected_before_sha256: existingBytes ? sha256(existingBytes) : null,
        },
      ],
      {
        actor: "cold-partition",
        reason: `Index ${plan.planned.length} records into logical cold time partitions.`,
        fault_after_write_index_for_test: options.faultAfterWriteIndexForTest,
      },
    );
    transactionId = transaction.transaction_id;
    transactionPath = transaction.transaction_path;
  }
  const status = plan.planned.length > 0 && !apply ? "needs_apply" : "healthy";
  const report: ColdPartitionReport = {
    version: COLD_PARTITION_VERSION,
    status,
    generated_at: generatedAt,
    apply,
    data_root: path.resolve(dataRoot),
    retention_days: plan.retention,
    counts: {
      indexed_before: plan.existing.entries.length,
      planned: plan.planned.length,
      applied: apply ? plan.planned.length : 0,
      indexed_after: index.entries.length,
      partitions: Object.keys(index.partitions).length,
    },
    planned_entries: plan.planned,
    transaction_id: transactionId,
    transaction_path: transactionPath,
    recovery_ref: recoveryRef,
    rollback_transaction_id: null,
    warnings: status === "needs_apply" ? ["cold_partition_candidates_pending"] : [],
    visible_status: status === "healthy" ? "Cold partitions indexed and excluded from hot retrieval" : "Cold partition plan requires apply",
  };
  const operationsPath = dataPath(
    dataRoot,
    COLD_PARTITION_OPERATIONS_DIR,
    `cold-partitions-${generatedAt.slice(0, 10).replace(/-/g, "")}-${plan.planned.length}.json`,
  );
  await atomicWriteJson(statusPath, report);
  await atomicWriteJson(operationsPath, {
    version: report.version,
    status: report.status,
    generated_at: report.generated_at,
    apply: report.apply,
    retention_days: report.retention_days,
    counts: report.counts,
    transaction_id: report.transaction_id,
    transaction_path: report.transaction_path,
    recovery_ref: report.recovery_ref,
    planned_entries: report.planned_entries.map((entry) => ({
      path_hash: sha256(entry.path),
      kind: entry.kind,
      partition: entry.partition,
      source_time: entry.source_time,
      source_sha256: entry.source_sha256,
      size_bytes: entry.size_bytes,
      reason_code: entry.reason_code,
    })),
    note: "Public operational summary stores source path hashes, not private task or report content.",
  });
  return { report, statusPath, operationsPath };
}

export async function searchColdPartitions(
  dataRoot: string,
  query: string,
  limit = 20,
): Promise<ColdPartitionEntry[]> {
  const index = await readColdPartitionIndex(dataRoot);
  if (!index) return [];
  const terms = query.toLowerCase().split(/[^\p{L}\p{N}_-]+/u).filter((term) => term.length >= 2);
  return index.entries
    .map((entry) => {
      const haystack = `${entry.path} ${entry.kind} ${entry.partition} ${entry.reason_code}`.toLowerCase();
      const score = terms.reduce((sum, term) => sum + (haystack.includes(term) ? 1 : 0), 0);
      return { entry, score };
    })
    .filter(({ score }) => terms.length === 0 || score > 0)
    .sort((left, right) => right.score - left.score || right.entry.source_time.localeCompare(left.entry.source_time))
    .slice(0, Math.max(1, Math.min(limit, 100)))
    .map(({ entry }) => entry);
}
