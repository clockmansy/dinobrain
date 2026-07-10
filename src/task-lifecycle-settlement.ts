import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { promisify } from "node:util";

import { atomicWriteBytes, atomicWriteJson } from "./concurrency.js";
import { dataPath } from "./context.js";
import { withTaskLifecycleMutationLock } from "./task-lifecycle-lock.js";
import {
  buildAndWriteTaskLifecycleReport,
  buildTaskLifecycleReport,
  type TaskLifecycleReport,
  type TaskLifecycleSession,
} from "./task-lifecycle.js";

export const TASK_LIFECYCLE_SETTLEMENT_VERSION = "task_lifecycle_settlement_v2";
export const TASK_LIFECYCLE_SETTLEMENT_RELATIVE_PATH = ".dino/state/task_lifecycle_settlement.json";
export const TASK_LIFECYCLE_MIGRATION_VERSION = "task_lifecycle_migration_v1";
export const TASK_LIFECYCLE_MIGRATION_ROOT = ".dino/migrations/task-lifecycle";
export const TASK_LIFECYCLE_LOCAL_BACKUP_ROOT = ".dino/tmp/task-lifecycle-migrations";

const execFileAsync = promisify(execFile);

type JsonObject = Record<string, unknown>;

export type TaskLifecycleSettlementAction = {
  task_id: string;
  task_path: string | null;
  trace_path: string | null;
  decision_class: string;
  action:
    | "auto_close_stale_non_user_service"
    | "repair_started_from_grounded_trace"
    | "bind_terminal_task_to_existing_trace"
    | "reconstruct_blocked_missing_trace"
    | "block_stale_without_trace"
    | "skip_manual_repair"
    | "skip_recent_active";
  applied: boolean;
  reason_code: string;
  previous_status: string;
  previous_updated_at: string | null;
  prompt_classification: string | null;
  task_sha256_before: string | null;
  trace_sha256_before: string | null;
  task_sha256_after: string | null;
  trace_sha256_after: string | null;
  migration_id: string | null;
};

export type TaskLifecycleMigrationArtifact = {
  path: string;
  kind: "task" | "trace";
  role: "mutation_target" | "grounding_source";
  mutates: boolean;
  existed_before: boolean;
  before_sha256: string | null;
  before_size_bytes: number | null;
  backup_path: string | null;
  after_sha256: string | null;
};

export type TaskLifecycleMigrationAction = {
  index: number;
  task_id: string;
  action: TaskLifecycleSettlementAction["action"];
  decision_class: string;
  reason_code: string;
  artifacts: TaskLifecycleMigrationArtifact[];
  applied: boolean;
};

export type TaskLifecycleMigrationManifest = {
  version: typeof TASK_LIFECYCLE_MIGRATION_VERSION;
  migration_id: string;
  status:
    | "planned"
    | "backed_up"
    | "applying"
    | "verified"
    | "failed"
    | "rollback_blocked"
    | "rolling_back"
    | "rolled_back";
  created_at: string;
  updated_at: string;
  data_root: string;
  manifest_path: string;
  ledger_root: string;
  local_backup_root: string;
  backup_policy: "local_only_exact_bytes";
  stale_after_ms: number;
  lifecycle_before: {
    generated_at: string;
    status: TaskLifecycleReport["status"];
    counts: TaskLifecycleReport["counts"];
    by_decision_class: TaskLifecycleReport["by_decision_class"];
    by_prompt_classification: TaskLifecycleReport["by_prompt_classification"];
  };
  source_control: {
    data_head: string | null;
    data_status_sha256: string | null;
    staged_count: number;
    unstaged_count: number;
    untracked_count: number;
    recovery_ref: string | null;
    recovery_ref_created: boolean;
    app_head: string | null;
  };
  full_memory_manifest: {
    path: string;
    sha256: string | null;
  };
  actions: TaskLifecycleMigrationAction[];
  ledger_entry_count: number;
  ledger_head_sha256: string | null;
  post_audit: {
    generated_at: string;
    status: TaskLifecycleReport["status"];
    counts: TaskLifecycleReport["counts"];
  } | null;
  rollback: {
    requested_at: string | null;
    completed_at: string | null;
    restored_paths: number;
    removed_paths: number;
    conflicts: string[];
  };
  failure: {
    at: string;
    message: string;
  } | null;
};

export type TaskLifecycleSettlementReport = {
  version: typeof TASK_LIFECYCLE_SETTLEMENT_VERSION;
  status: "healthy" | "needs_attention";
  generated_at: string;
  data_root: string;
  apply: boolean;
  lifecycle_before: {
    generated_at: string;
    status: TaskLifecycleReport["status"];
    counts: TaskLifecycleReport["counts"];
    by_decision_class: TaskLifecycleReport["by_decision_class"];
    by_prompt_classification: TaskLifecycleReport["by_prompt_classification"];
  };
  lifecycle_after: {
    generated_at: string;
    status: TaskLifecycleReport["status"];
    counts: TaskLifecycleReport["counts"];
    by_decision_class: TaskLifecycleReport["by_decision_class"];
    by_prompt_classification: TaskLifecycleReport["by_prompt_classification"];
  } | null;
  counts: {
    auto_close_candidates_before: number;
    auto_close_applied: number;
    auto_close_candidates_after: number | null;
    finish_gate_repairs_before: number;
    finish_gate_repairs_applied: number;
    finish_gate_repairs_after: number | null;
    manual_repair_required_before: number;
    manual_repair_required_after: number | null;
    skipped_manual_repair: number;
  };
  actions: TaskLifecycleSettlementAction[];
  warnings: string[];
  visible_status: string;
  migration: {
    migration_id: string;
    manifest_path: string;
    local_backup_root: string;
    ledger_entry_count: number;
    ledger_head_sha256: string | null;
    recovery_ref: string | null;
    status: TaskLifecycleMigrationManifest["status"];
  } | null;
  latest_migration: {
    migration_id: string;
    manifest_path: string;
    local_backup_root: string;
    ledger_entry_count: number;
    ledger_head_sha256: string | null;
    recovery_ref: string | null;
    status: TaskLifecycleMigrationManifest["status"];
  } | null;
};

export type SettlementOptions = {
  apply?: boolean;
  now?: Date;
  staleAfterMs?: number;
  migrationId?: string;
  createRecoveryRef?: boolean;
  autoRollbackOnFailure?: boolean;
  faultAfterAppliedActions?: number;
  beforeApply?: () => Promise<void>;
};

export type RollbackTaskLifecycleMigrationOptions = {
  now?: Date;
};

function nowIso(date: Date): string {
  return date.toISOString();
}

async function readJson<T>(filePath: string): Promise<T> {
  return JSON.parse(await fs.readFile(filePath, "utf8")) as T;
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await atomicWriteJson(filePath, value);
}

async function fileSha256(filePath: string): Promise<string | null> {
  try {
    return createHash("sha256").update(await fs.readFile(filePath)).digest("hex");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function sha256Bytes(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function compactTimestamp(date: Date): string {
  return date.toISOString().replace(/[-:.TZ]/g, "").slice(0, 17);
}

function makeMigrationId(date: Date): string {
  return `task-lifecycle-${compactTimestamp(date)}-${randomUUID()}`;
}

function migrationPaths(dataRoot: string, migrationId: string): {
  manifestPath: string;
  manifestRelativePath: string;
  ledgerRoot: string;
  ledgerRelativeRoot: string;
  backupRoot: string;
  backupRelativeRoot: string;
} {
  if (!/^task-lifecycle-[A-Za-z0-9-]+$/.test(migrationId)) {
    throw new Error(`Invalid task lifecycle migration id: ${migrationId}`);
  }
  const manifestRelativePath = `${TASK_LIFECYCLE_MIGRATION_ROOT}/${migrationId}/manifest.json`;
  const ledgerRelativeRoot = `${TASK_LIFECYCLE_MIGRATION_ROOT}/${migrationId}/ledger`;
  const backupRelativeRoot = `${TASK_LIFECYCLE_LOCAL_BACKUP_ROOT}/${migrationId}`;
  return {
    manifestPath: dataPath(dataRoot, ...manifestRelativePath.split("/")),
    manifestRelativePath,
    ledgerRoot: dataPath(dataRoot, ...ledgerRelativeRoot.split("/")),
    ledgerRelativeRoot,
    backupRoot: dataPath(dataRoot, ...backupRelativeRoot.split("/")),
    backupRelativeRoot,
  };
}

async function readFileIfPresent(filePath: string): Promise<Buffer | null> {
  try {
    return await fs.readFile(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function writeExclusiveBytes(filePath: string, value: Uint8Array): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const handle = await fs.open(filePath, "wx");
  try {
    await handle.writeFile(value);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function gitOutput(cwd: string, args: string[]): Promise<string | null> {
  try {
    const result = await execFileAsync("git", args, {
      cwd,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      windowsHide: true,
    });
    return String(result.stdout).trim();
  } catch {
    return null;
  }
}

function countGitStatus(status: string): { staged: number; unstaged: number; untracked: number } {
  let staged = 0;
  let unstaged = 0;
  let untracked = 0;
  for (const entry of status.split("\0").filter(Boolean)) {
    if (!/^[ MADRCU?!]{2} /.test(entry)) continue;
    const code = entry.slice(0, 2);
    if (code === "??") {
      untracked += 1;
      continue;
    }
    if (code[0] !== " ") staged += 1;
    if (code[1] !== " ") unstaged += 1;
  }
  return { staged, unstaged, untracked };
}

async function captureSourceControl(
  dataRoot: string,
  migrationId: string,
  createRecoveryRef: boolean,
): Promise<TaskLifecycleMigrationManifest["source_control"]> {
  const dataHead = await gitOutput(dataRoot, ["rev-parse", "HEAD"]);
  const status = dataHead === null ? null : await gitOutput(dataRoot, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  const counts = countGitStatus(status ?? "");
  const recoveryRef = dataHead ? `refs/dinobrain-recovery/task-lifecycle/${migrationId}` : null;
  let recoveryRefCreated = false;
  if (createRecoveryRef && dataHead && recoveryRef) {
    const created = await gitOutput(dataRoot, ["update-ref", recoveryRef, dataHead]);
    recoveryRefCreated = created !== null;
    if (!recoveryRefCreated) throw new Error(`Could not create Git recovery ref: ${recoveryRef}`);
  }
  const appHead = await gitOutput(process.cwd(), ["rev-parse", "HEAD"]);
  return {
    data_head: dataHead,
    data_status_sha256: status === null ? null : sha256Bytes(Buffer.from(status, "utf8")),
    staged_count: counts.staged,
    unstaged_count: counts.unstaged,
    untracked_count: counts.untracked,
    recovery_ref: recoveryRefCreated ? recoveryRef : null,
    recovery_ref_created: recoveryRefCreated,
    app_head: appHead,
  };
}

type MigrationLedgerEntry = {
  version: "task_lifecycle_migration_ledger_v1";
  migration_id: string;
  sequence: number;
  event: string;
  at: string;
  previous_entry_sha256: string | null;
  payload: Record<string, unknown>;
  entry_sha256: string;
};

function ledgerDigest(entry: Omit<MigrationLedgerEntry, "entry_sha256">): string {
  return sha256Bytes(Buffer.from(JSON.stringify(entry), "utf8"));
}

async function appendMigrationLedger(
  dataRoot: string,
  manifest: TaskLifecycleMigrationManifest,
  event: string,
  at: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const paths = migrationPaths(dataRoot, manifest.migration_id);
  await fs.mkdir(paths.ledgerRoot, { recursive: true });
  const sequence = manifest.ledger_entry_count + 1;
  const base: Omit<MigrationLedgerEntry, "entry_sha256"> = {
    version: "task_lifecycle_migration_ledger_v1",
    migration_id: manifest.migration_id,
    sequence,
    event,
    at,
    previous_entry_sha256: manifest.ledger_head_sha256,
    payload,
  };
  const entry: MigrationLedgerEntry = { ...base, entry_sha256: ledgerDigest(base) };
  const safeEvent = event.replace(/[^A-Za-z0-9_-]+/g, "-").slice(0, 48) || "event";
  const ledgerPath = path.join(paths.ledgerRoot, `${String(sequence).padStart(6, "0")}-${safeEvent}.json`);
  await writeExclusiveBytes(ledgerPath, Buffer.from(`${JSON.stringify(entry, null, 2)}\n`, "utf8"));
  manifest.ledger_entry_count = sequence;
  manifest.ledger_head_sha256 = entry.entry_sha256;
}

async function verifyMigrationLedger(dataRoot: string, manifest: TaskLifecycleMigrationManifest): Promise<void> {
  const paths = migrationPaths(dataRoot, manifest.migration_id);
  const entries = (await fs.readdir(paths.ledgerRoot, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => entry.name)
    .sort();
  let previous: string | null = null;
  const digests: string[] = [];
  for (let index = 0; index < entries.length; index += 1) {
    const record = await readJson<MigrationLedgerEntry>(path.join(paths.ledgerRoot, entries[index]));
    const { entry_sha256: digest, ...base } = record;
    if (record.sequence !== index + 1) throw new Error(`Migration ledger sequence mismatch: ${entries[index]}`);
    if (record.migration_id !== manifest.migration_id) throw new Error(`Migration ledger id mismatch: ${entries[index]}`);
    if (record.previous_entry_sha256 !== previous) throw new Error(`Migration ledger chain mismatch: ${entries[index]}`);
    if (ledgerDigest(base) !== digest) throw new Error(`Migration ledger hash mismatch: ${entries[index]}`);
    previous = digest;
    digests.push(digest);
  }
  if (entries.length < manifest.ledger_entry_count) {
    throw new Error(`Migration ledger head mismatch: ${manifest.migration_id}`);
  }
  const persistedHead = manifest.ledger_entry_count === 0 ? null : digests[manifest.ledger_entry_count - 1] ?? null;
  if (persistedHead !== manifest.ledger_head_sha256) throw new Error(`Migration ledger persisted head mismatch: ${manifest.migration_id}`);
  if (entries.length > manifest.ledger_entry_count) {
    manifest.ledger_entry_count = entries.length;
    manifest.ledger_head_sha256 = previous;
  }
}

function migrationSummary(
  manifest: TaskLifecycleMigrationManifest,
): NonNullable<TaskLifecycleSettlementReport["latest_migration"]> {
  return {
    migration_id: manifest.migration_id,
    manifest_path: manifest.manifest_path,
    local_backup_root: manifest.local_backup_root,
    ledger_entry_count: manifest.ledger_entry_count,
    ledger_head_sha256: manifest.ledger_head_sha256,
    recovery_ref: manifest.source_control.recovery_ref,
    status: manifest.status,
  };
}

async function readLatestMigration(dataRoot: string): Promise<TaskLifecycleMigrationManifest | null> {
  const root = dataPath(dataRoot, ...TASK_LIFECYCLE_MIGRATION_ROOT.split("/"));
  let entries: Array<import("node:fs").Dirent>;
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const manifests: TaskLifecycleMigrationManifest[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const manifestPath = path.join(root, entry.name, "manifest.json");
    const manifest = await readJson<TaskLifecycleMigrationManifest>(manifestPath);
    if (manifest.version !== TASK_LIFECYCLE_MIGRATION_VERSION || manifest.migration_id !== entry.name) {
      throw new Error(`Invalid task lifecycle migration manifest: ${entry.name}`);
    }
    manifests.push(manifest);
  }
  const latest = manifests.sort((a, b) => b.created_at.localeCompare(a.created_at))[0] ?? null;
  if (latest) await verifyMigrationLedger(dataRoot, latest);
  return latest;
}

async function writeMigrationManifest(dataRoot: string, manifest: TaskLifecycleMigrationManifest): Promise<void> {
  manifest.updated_at = new Date().toISOString();
  await atomicWriteJson(dataPath(dataRoot, ...manifest.manifest_path.split("/")), manifest);
}

function artifactsForAction(action: TaskLifecycleSettlementAction): TaskLifecycleMigrationArtifact[] {
  const artifacts: TaskLifecycleMigrationArtifact[] = [];
  if (action.task_path) {
    artifacts.push({
      path: action.task_path,
      kind: "task",
      role: "mutation_target",
      mutates: true,
      existed_before: action.task_sha256_before !== null,
      before_sha256: action.task_sha256_before,
      before_size_bytes: null,
      backup_path: null,
      after_sha256: null,
    });
  }
  if (action.trace_path) {
    const mutates = !["repair_started_from_grounded_trace", "bind_terminal_task_to_existing_trace"].includes(action.action);
    artifacts.push({
      path: action.trace_path,
      kind: "trace",
      role: mutates ? "mutation_target" : "grounding_source",
      mutates,
      existed_before: action.trace_sha256_before !== null,
      before_sha256: action.trace_sha256_before,
      before_size_bytes: null,
      backup_path: null,
      after_sha256: null,
    });
  }
  return artifacts;
}

async function backUpMigrationArtifacts(dataRoot: string, manifest: TaskLifecycleMigrationManifest): Promise<void> {
  const paths = migrationPaths(dataRoot, manifest.migration_id);
  await fs.mkdir(path.join(paths.backupRoot, "originals"), { recursive: true });
  const seen = new Map<string, TaskLifecycleMigrationArtifact>();
  for (const action of manifest.actions) {
    for (const artifact of action.artifacts) {
      const previous = seen.get(artifact.path);
      if (previous) {
        artifact.before_size_bytes = previous.before_size_bytes;
        artifact.backup_path = previous.backup_path;
        continue;
      }
      const fullPath = dataPath(dataRoot, ...artifact.path.split("/"));
      const raw = await readFileIfPresent(fullPath);
      const actualHash = raw === null ? null : sha256Bytes(raw);
      if (actualHash !== artifact.before_sha256) {
        throw new Error(`Migration source hash mismatch before backup: ${artifact.path}`);
      }
      artifact.existed_before = raw !== null;
      artifact.before_size_bytes = raw?.byteLength ?? null;
      if (raw !== null) {
        const backupRelativePath = `${paths.backupRelativeRoot}/originals/${sha256Bytes(Buffer.from(artifact.path, "utf8"))}.bin`;
        const backupPath = dataPath(dataRoot, ...backupRelativePath.split("/"));
        await writeExclusiveBytes(backupPath, raw);
        if ((await fileSha256(backupPath)) !== actualHash) throw new Error(`Migration backup hash mismatch: ${artifact.path}`);
        artifact.backup_path = backupRelativePath;
      }
      seen.set(artifact.path, artifact);
    }
  }
}

async function fullMemoryManifestEvidence(dataRoot: string): Promise<TaskLifecycleMigrationManifest["full_memory_manifest"]> {
  const relativePath = ".dino/state/full_memory_manifest.json";
  return { path: relativePath, sha256: await fileSha256(dataPath(dataRoot, ...relativePath.split("/"))) };
}

function lifecycleSnapshot(report: TaskLifecycleReport): TaskLifecycleMigrationManifest["lifecycle_before"] {
  return {
    generated_at: report.generated_at,
    status: report.status,
    counts: report.counts,
    by_decision_class: report.by_decision_class,
    by_prompt_classification: report.by_prompt_classification,
  };
}

function migrationInvariantFailures(report: TaskLifecycleReport): string[] {
  const failures: string[] = [];
  if (report.counts.blockers !== 0) failures.push(`blockers=${report.counts.blockers}`);
  if (report.counts.stale_active !== 0) failures.push(`stale_active=${report.counts.stale_active}`);
  if (report.counts.terminal_missing_trace !== 0) failures.push(`terminal_missing_trace=${report.counts.terminal_missing_trace}`);
  if (report.counts.trace_binding_missing !== 0) failures.push(`trace_binding_missing=${report.counts.trace_binding_missing}`);
  if (report.counts.trace_without_task !== 0) failures.push(`trace_without_task=${report.counts.trace_without_task}`);
  if (report.counts.wrong_task_mismatch !== 0) failures.push(`wrong_task_mismatch=${report.counts.wrong_task_mismatch}`);
  if (report.counts.ungrounded_finish !== 0) failures.push(`ungrounded_finish=${report.counts.ungrounded_finish}`);
  return failures;
}

async function assertActionSourceHashes(dataRoot: string, action: TaskLifecycleSettlementAction): Promise<void> {
  if (action.task_path) {
    const actual = await fileSha256(dataPath(dataRoot, action.task_path));
    if (actual !== action.task_sha256_before) {
      throw new Error(`Task changed after dry-run classification: ${action.task_path}`);
    }
  }
  if (action.trace_sha256_before && action.trace_path) {
    const actual = await fileSha256(dataPath(dataRoot, action.trace_path));
    if (actual !== action.trace_sha256_before) {
      throw new Error(`Trace changed after dry-run classification: ${action.trace_path}`);
    }
  }
}

async function withAfterHashes(
  dataRoot: string,
  action: TaskLifecycleSettlementAction,
): Promise<TaskLifecycleSettlementAction> {
  return {
    ...action,
    task_sha256_after: action.task_path ? await fileSha256(dataPath(dataRoot, action.task_path)) : null,
    trace_sha256_after: action.trace_path ? await fileSha256(dataPath(dataRoot, action.trace_path)) : null,
  };
}

function tracePathFor(session: TaskLifecycleSession): string {
  return session.trace_path ?? `.dino/traces/${session.task_id}.json`;
}

function outcomeToTaskStatus(outcome: string): string {
  if (["completed", "partial", "blocked"].includes(outcome)) return outcome;
  return "completed";
}

function hasGroundedTrace(trace: JsonObject): boolean {
  const summary = typeof trace.summary === "string" && trace.summary.trim().length > 0;
  const hasEvidence = ["changed_files", "decisions", "next_steps", "used_memory_paths", "context_pack_paths", "candidate_paths"].some(
    (key) => Array.isArray(trace[key]) && (trace[key] as unknown[]).length > 0,
  );
  const outcome = typeof trace.outcome === "string" && trace.outcome.trim().length > 0;
  return outcome && summary && hasEvidence;
}

function isRepairableManualSession(session: TaskLifecycleSession): boolean {
  if (session.auto_close_safe) return false;
  if (session.decision_class === "manual_stale_review_required") return true;
  if (
    session.decision_class === "manual_trace_binding_repair_required" &&
    session.trace_path &&
    ["completed", "partial", "blocked"].includes(session.status)
  ) {
    return true;
  }
  if (session.decision_class === "manual_trace_reconstruction_required" && session.status === "blocked") return true;
  return false;
}

function actionFor(session: TaskLifecycleSession): TaskLifecycleSettlementAction {
  const evidence = {
    prompt_classification: session.prompt_classification,
    task_sha256_before: session.task_sha256,
    trace_sha256_before: session.trace_sha256,
    task_sha256_after: null,
    trace_sha256_after: null,
    migration_id: null,
  };
  if (session.auto_close_safe) {
    return {
      ...evidence,
      task_id: session.task_id,
      task_path: session.task_path,
      trace_path: tracePathFor(session),
      decision_class: session.decision_class,
      action: "auto_close_stale_non_user_service",
      applied: false,
      reason_code: "stale_non_user_service_auto_close_candidate",
      previous_status: session.status,
      previous_updated_at: session.updated_at,
    };
  }
  if (session.decision_class === "manual_stale_review_required" && session.trace_path) {
    return {
      ...evidence,
      task_id: session.task_id,
      task_path: session.task_path,
      trace_path: session.trace_path,
      decision_class: session.decision_class,
      action: "repair_started_from_grounded_trace",
      applied: false,
      reason_code: "stale_started_task_has_grounded_trace",
      previous_status: session.status,
      previous_updated_at: session.updated_at,
    };
  }
  if (session.decision_class === "manual_trace_binding_repair_required" && session.trace_path) {
    return {
      ...evidence,
      task_id: session.task_id,
      task_path: session.task_path,
      trace_path: session.trace_path,
      decision_class: session.decision_class,
      action: "bind_terminal_task_to_existing_trace",
      applied: false,
      reason_code: "terminal_task_has_unbound_existing_trace",
      previous_status: session.status,
      previous_updated_at: session.updated_at,
    };
  }
  if (session.decision_class === "manual_trace_reconstruction_required" && session.status === "blocked") {
    return {
      ...evidence,
      task_id: session.task_id,
      task_path: session.task_path,
      trace_path: tracePathFor(session),
      decision_class: session.decision_class,
      action: "reconstruct_blocked_missing_trace",
      applied: false,
      reason_code: "blocked_task_missing_trace_reconstructable_from_task_error",
      previous_status: session.status,
      previous_updated_at: session.updated_at,
    };
  }
  if (session.decision_class === "manual_stale_review_required" && !session.trace_path) {
    return {
      ...evidence,
      task_id: session.task_id,
      task_path: session.task_path,
      trace_path: tracePathFor(session),
      decision_class: session.decision_class,
      action: "block_stale_without_trace",
      applied: false,
      reason_code: "stale_task_without_terminal_evidence",
      previous_status: session.status,
      previous_updated_at: session.updated_at,
    };
  }
  if (session.issue_codes.length > 0) {
    return {
      ...evidence,
      task_id: session.task_id,
      task_path: session.task_path,
      trace_path: session.trace_path,
      decision_class: session.decision_class,
      action: "skip_manual_repair",
      applied: false,
      reason_code: "manual_repair_required",
      previous_status: session.status,
      previous_updated_at: session.updated_at,
    };
  }
  return {
    ...evidence,
    task_id: session.task_id,
    task_path: session.task_path,
    trace_path: session.trace_path,
    decision_class: session.decision_class,
    action: "skip_recent_active",
    applied: false,
    reason_code: "not_a_settlement_target",
    previous_status: session.status,
    previous_updated_at: session.updated_at,
  };
}

async function applyStartedFromGroundedTrace(
  dataRoot: string,
  session: TaskLifecycleSession,
  repairedAt: string,
  migrationId: string,
): Promise<TaskLifecycleSettlementAction> {
  const action = actionFor(session);
  if (!session.task_path || !session.trace_path) return action;
  await assertActionSourceHashes(dataRoot, action);
  const taskFile = dataPath(dataRoot, session.task_path);
  const traceFile = dataPath(dataRoot, session.trace_path);
  const task = await readJson<JsonObject>(taskFile);
  const trace = await readJson<JsonObject>(traceFile);
  if (String(task.status ?? "") !== "started") {
    return { ...action, reason_code: "task_status_changed_before_repair" };
  }
  if (!hasGroundedTrace(trace)) {
    return { ...action, reason_code: "trace_not_grounded_enough_for_started_task_repair" };
  }
  const outcome = String(trace.outcome ?? "completed");
  await writeJson(taskFile, {
    ...task,
    status: outcomeToTaskStatus(outcome),
    updated_at: repairedAt,
    finished_at: String(trace.finished_at ?? repairedAt),
    trace_path: session.trace_path,
    lifecycle_settlement: {
      version: TASK_LIFECYCLE_SETTLEMENT_VERSION,
      migration_id: migrationId,
      reason_code: "started_task_repaired_from_grounded_trace",
      settled_at: repairedAt,
      trace_path: session.trace_path,
    },
  });
  return await withAfterHashes(dataRoot, {
    ...action,
    applied: true,
    reason_code: "started_task_repaired_from_grounded_trace",
    migration_id: migrationId,
  });
}

async function applyTerminalTraceBinding(
  dataRoot: string,
  session: TaskLifecycleSession,
  repairedAt: string,
  migrationId: string,
): Promise<TaskLifecycleSettlementAction> {
  const action = actionFor(session);
  if (!session.task_path || !session.trace_path) return action;
  await assertActionSourceHashes(dataRoot, action);
  const taskFile = dataPath(dataRoot, session.task_path);
  const traceFile = dataPath(dataRoot, session.trace_path);
  const task = await readJson<JsonObject>(taskFile);
  const trace = await readJson<JsonObject>(traceFile);
  if (!["completed", "partial", "blocked"].includes(String(task.status ?? ""))) {
    return { ...action, reason_code: "task_status_changed_before_trace_binding" };
  }
  if (String(trace.task_id ?? "") !== session.task_id) {
    return { ...action, reason_code: "existing_trace_task_id_mismatch" };
  }
  if (!hasGroundedTrace(trace)) {
    return { ...action, reason_code: "existing_trace_not_grounded_enough_for_binding" };
  }
  await writeJson(taskFile, {
    ...task,
    updated_at: repairedAt,
    finished_at: String(task.finished_at ?? trace.finished_at ?? repairedAt),
    trace_path: session.trace_path,
    lifecycle_settlement: {
      version: TASK_LIFECYCLE_SETTLEMENT_VERSION,
      migration_id: migrationId,
      reason_code: "terminal_task_bound_to_existing_grounded_trace",
      settled_at: repairedAt,
      trace_path: session.trace_path,
      trace_sha256: session.trace_sha256,
    },
  });
  return await withAfterHashes(dataRoot, {
    ...action,
    applied: true,
    reason_code: "terminal_task_bound_to_existing_grounded_trace",
    migration_id: migrationId,
  });
}

async function applyBlockedMissingTrace(
  dataRoot: string,
  session: TaskLifecycleSession,
  repairedAt: string,
  migrationId: string,
): Promise<TaskLifecycleSettlementAction> {
  const action = actionFor(session);
  if (!session.task_path) return action;
  await assertActionSourceHashes(dataRoot, action);
  const taskFile = dataPath(dataRoot, session.task_path);
  const task = await readJson<JsonObject>(taskFile);
  if (String(task.status ?? "") !== "blocked") {
    return { ...action, reason_code: "task_status_changed_before_repair" };
  }
  const tracePath = tracePathFor(session);
  const traceFile = dataPath(dataRoot, tracePath);
  const error = String(task.error ?? task.block_reason ?? "unknown_error").slice(0, 1000);
  await writeJson(traceFile, {
    task_id: session.task_id,
    outcome: "blocked",
    summary: "Reconstructed blocked trace for a task that failed before finish_task could write terminal evidence.",
    changed_files: [],
    decisions: ["The task record was already blocked before lifecycle repair.", `Blocked reason: ${String(task.block_reason ?? "unknown")}`],
    next_steps: ["Inspect the original task error before using this task as successful completion evidence."],
    used_memory_paths: [],
    context_pack_paths: [],
    search_queries: [],
    finished_at: repairedAt,
    reconstruction: {
      version: TASK_LIFECYCLE_SETTLEMENT_VERSION,
      migration_id: migrationId,
      reason_code: "blocked_task_missing_trace_reconstructed",
      previous_status: session.status,
      previous_updated_at: session.updated_at,
      error,
    },
  });
  await writeJson(taskFile, {
    ...task,
    updated_at: repairedAt,
    finished_at: repairedAt,
    trace_path: tracePath,
    lifecycle_settlement: {
      version: TASK_LIFECYCLE_SETTLEMENT_VERSION,
      migration_id: migrationId,
      reason_code: "blocked_task_missing_trace_reconstructed",
      settled_at: repairedAt,
      trace_path: tracePath,
    },
  });
  return await withAfterHashes(dataRoot, {
    ...action,
    applied: true,
    reason_code: "blocked_task_missing_trace_reconstructed",
    migration_id: migrationId,
  });
}

async function applyBlockStaleWithoutTrace(
  dataRoot: string,
  session: TaskLifecycleSession,
  repairedAt: string,
  migrationId: string,
): Promise<TaskLifecycleSettlementAction> {
  const action = actionFor(session);
  if (!session.task_path) return action;
  await assertActionSourceHashes(dataRoot, action);
  const taskFile = dataPath(dataRoot, session.task_path);
  const task = await readJson<JsonObject>(taskFile);
  if (String(task.status ?? "") !== "started") {
    return { ...action, reason_code: "task_status_changed_before_repair" };
  }
  const tracePath = tracePathFor(session);
  const traceFile = dataPath(dataRoot, tracePath);
  await writeJson(traceFile, {
    task_id: session.task_id,
    outcome: "blocked",
    summary:
      "Closed stale started task as abandoned because no terminal trace or grounded completion evidence was found.",
    changed_files: [],
    decisions: [
      "No existing trace was found for this stale task.",
      "Lifecycle settlement records this as blocked/abandoned, not as successful completion evidence.",
    ],
    next_steps: ["Re-run or reconstruct the original work if this task's result is still needed."],
    used_memory_paths: [],
    context_pack_paths: [],
    search_queries: [],
    finished_at: repairedAt,
    settlement: {
      version: TASK_LIFECYCLE_SETTLEMENT_VERSION,
      migration_id: migrationId,
      reason_code: "stale_task_without_trace_blocked",
      previous_status: session.status,
      previous_updated_at: session.updated_at,
    },
  });
  await writeJson(taskFile, {
    ...task,
    status: "blocked",
    updated_at: repairedAt,
    finished_at: repairedAt,
    trace_path: tracePath,
    lifecycle_settlement: {
      version: TASK_LIFECYCLE_SETTLEMENT_VERSION,
      migration_id: migrationId,
      reason_code: "stale_task_without_trace_blocked",
      settled_at: repairedAt,
      trace_path: tracePath,
    },
  });
  return await withAfterHashes(dataRoot, {
    ...action,
    applied: true,
    reason_code: "stale_task_without_trace_blocked",
    migration_id: migrationId,
  });
}

async function applyAutoClose(
  dataRoot: string,
  session: TaskLifecycleSession,
  lifecycleBefore: TaskLifecycleReport,
  finishedAt: string,
  migrationId: string,
): Promise<TaskLifecycleSettlementAction> {
  const action = actionFor(session);
  if (!session.task_path || !session.auto_close_safe) return action;
  await assertActionSourceHashes(dataRoot, action);
  const taskFile = dataPath(dataRoot, session.task_path);
  const task = await readJson<JsonObject>(taskFile);
  if (String(task.status ?? "") !== "started") {
    return {
      ...action,
      reason_code: "task_status_changed_before_settlement",
    };
  }
  const tracePath = tracePathFor(session);
  const traceFile = dataPath(dataRoot, tracePath);
  const trace = {
    task_id: session.task_id,
    outcome: "blocked",
    summary:
      "Auto-closed stale non-user DinoBrain service task after lifecycle settlement. The task had no terminal trace or current active owner.",
    changed_files: [],
    decisions: [
      "Classified as auto_close_candidate by task lifecycle report.",
      `Closed only because prompt eligibility classified it as ${session.prompt_classification ?? "non-user service work"}.`,
    ],
    next_steps: ["Manual repair is still required for non-diagnostic stale tasks."],
    used_memory_paths: [],
    context_pack_paths: [],
    search_queries: [],
    finished_at: finishedAt,
    settlement: {
      version: TASK_LIFECYCLE_SETTLEMENT_VERSION,
      migration_id: migrationId,
      reason_code: "stale_non_user_service_auto_closed",
      previous_status: session.status,
      previous_updated_at: session.updated_at,
      source_task_lifecycle_generated_at: lifecycleBefore.generated_at,
    },
  };
  await writeJson(traceFile, trace);
  await writeJson(taskFile, {
    ...task,
    status: "blocked",
    updated_at: finishedAt,
    finished_at: finishedAt,
    trace_path: tracePath,
    lifecycle_settlement: {
      version: TASK_LIFECYCLE_SETTLEMENT_VERSION,
      migration_id: migrationId,
      reason_code: "stale_non_user_service_auto_closed",
      settled_at: finishedAt,
      trace_path: tracePath,
    },
  });
  return await withAfterHashes(dataRoot, {
    ...action,
    applied: true,
    reason_code: "stale_non_user_service_auto_closed",
    migration_id: migrationId,
  });
}

async function createMigrationManifest(
  dataRoot: string,
  migrationId: string,
  generatedAt: string,
  staleAfterMs: number,
  lifecycleBefore: TaskLifecycleReport,
  actions: TaskLifecycleSettlementAction[],
  createRecoveryRef: boolean,
): Promise<TaskLifecycleMigrationManifest> {
  const paths = migrationPaths(dataRoot, migrationId);
  const migrationDir = path.dirname(paths.manifestPath);
  await fs.mkdir(path.dirname(migrationDir), { recursive: true });
  await fs.mkdir(migrationDir, { recursive: false });
  const manifest: TaskLifecycleMigrationManifest = {
    version: TASK_LIFECYCLE_MIGRATION_VERSION,
    migration_id: migrationId,
    status: "planned",
    created_at: generatedAt,
    updated_at: generatedAt,
    data_root: path.resolve(dataRoot),
    manifest_path: paths.manifestRelativePath,
    ledger_root: paths.ledgerRelativeRoot,
    local_backup_root: paths.backupRelativeRoot,
    backup_policy: "local_only_exact_bytes",
    stale_after_ms: staleAfterMs,
    lifecycle_before: lifecycleSnapshot(lifecycleBefore),
    source_control: await captureSourceControl(dataRoot, migrationId, createRecoveryRef),
    full_memory_manifest: await fullMemoryManifestEvidence(dataRoot),
    actions: actions.map((action, index) => ({
      index,
      task_id: action.task_id,
      action: action.action,
      decision_class: action.decision_class,
      reason_code: action.reason_code,
      artifacts: artifactsForAction(action),
      applied: false,
    })),
    ledger_entry_count: 0,
    ledger_head_sha256: null,
    post_audit: null,
    rollback: {
      requested_at: null,
      completed_at: null,
      restored_paths: 0,
      removed_paths: 0,
      conflicts: [],
    },
    failure: null,
  };
  await writeMigrationManifest(dataRoot, manifest);
  await appendMigrationLedger(dataRoot, manifest, "migration_planned", generatedAt, {
    action_count: manifest.actions.length,
    lifecycle_counts: lifecycleBefore.counts,
    data_head: manifest.source_control.data_head,
    data_status_sha256: manifest.source_control.data_status_sha256,
    full_memory_manifest_sha256: manifest.full_memory_manifest.sha256,
  });
  await writeMigrationManifest(dataRoot, manifest);
  await backUpMigrationArtifacts(dataRoot, manifest);
  manifest.status = "backed_up";
  await appendMigrationLedger(dataRoot, manifest, "backup_verified", generatedAt, {
    artifact_count: manifest.actions.reduce((count, action) => count + action.artifacts.length, 0),
    backed_up_count: manifest.actions.flatMap((action) => action.artifacts).filter((artifact) => artifact.backup_path).length,
    backup_policy: manifest.backup_policy,
    recovery_ref: manifest.source_control.recovery_ref,
  });
  await writeMigrationManifest(dataRoot, manifest);
  return manifest;
}

function recordAppliedAction(
  manifest: TaskLifecycleMigrationManifest,
  action: TaskLifecycleSettlementAction,
): TaskLifecycleMigrationAction {
  const migrationAction = manifest.actions.find(
    (candidate) => candidate.task_id === action.task_id && candidate.action === action.action,
  );
  if (!migrationAction) throw new Error(`Migration action not found in manifest: ${action.task_id}`);
  migrationAction.reason_code = action.reason_code;
  migrationAction.applied = action.applied;
  for (const artifact of migrationAction.artifacts) {
    if (artifact.kind === "task") artifact.after_sha256 = action.task_sha256_after;
    if (artifact.kind === "trace") artifact.after_sha256 = action.trace_sha256_after;
  }
  return migrationAction;
}

function uniqueMutatingArtifacts(manifest: TaskLifecycleMigrationManifest): TaskLifecycleMigrationArtifact[] {
  const artifacts = new Map<string, TaskLifecycleMigrationArtifact>();
  for (const action of manifest.actions) {
    for (const artifact of action.artifacts) {
      if (!artifact.mutates) continue;
      const current = artifacts.get(artifact.path);
      if (!current) artifacts.set(artifact.path, artifact);
      else if (artifact.after_sha256) current.after_sha256 = artifact.after_sha256;
    }
  }
  return Array.from(artifacts.values());
}

async function hasMigrationMarker(filePath: string, migrationId: string): Promise<boolean> {
  try {
    const value = await readJson<JsonObject>(filePath);
    for (const key of ["lifecycle_settlement", "settlement", "reconstruction"]) {
      const marker = value[key];
      if (marker && typeof marker === "object" && !Array.isArray(marker)) {
        if (String((marker as JsonObject).migration_id ?? "") === migrationId) return true;
      }
    }
    return false;
  } catch {
    return false;
  }
}

async function rollbackMigrationUnlocked(
  dataRoot: string,
  manifest: TaskLifecycleMigrationManifest,
  now: Date,
): Promise<TaskLifecycleMigrationManifest> {
  if (manifest.status === "rolled_back") return manifest;
  await verifyMigrationLedger(dataRoot, manifest);
  const requestedAt = nowIso(now);
  const artifacts = uniqueMutatingArtifacts(manifest);
  const conflicts: string[] = [];
  for (const artifact of artifacts) {
    if (artifact.existed_before) {
      if (!artifact.backup_path) {
        conflicts.push(`${artifact.path}:backup_missing_from_manifest`);
        continue;
      }
      const backupHash = await fileSha256(dataPath(dataRoot, ...artifact.backup_path.split("/")));
      if (backupHash !== artifact.before_sha256) {
        conflicts.push(`${artifact.path}:backup_hash_mismatch`);
        continue;
      }
    }
    const fullPath = dataPath(dataRoot, ...artifact.path.split("/"));
    const currentHash = await fileSha256(fullPath);
    if (currentHash === artifact.before_sha256) continue;
    if (currentHash === artifact.after_sha256) continue;
    if (currentHash !== null && (await hasMigrationMarker(fullPath, manifest.migration_id))) continue;
    conflicts.push(`${artifact.path}:external_change_detected`);
  }
  manifest.rollback.requested_at = requestedAt;
  manifest.rollback.conflicts = conflicts;
  if (conflicts.length > 0) {
    manifest.status = "rollback_blocked";
    await appendMigrationLedger(dataRoot, manifest, "rollback_blocked", requestedAt, { conflicts });
    await writeMigrationManifest(dataRoot, manifest);
    throw new Error(`Task lifecycle rollback blocked by ${conflicts.length} conflicting path(s): ${manifest.migration_id}`);
  }

  manifest.status = "rolling_back";
  await appendMigrationLedger(dataRoot, manifest, "rollback_started", requestedAt, {
    mutating_artifact_count: artifacts.length,
  });
  await writeMigrationManifest(dataRoot, manifest);
  let restoredPaths = 0;
  let removedPaths = 0;
  const orderedArtifacts = [...artifacts].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "task" ? -1 : 1;
    return a.path.localeCompare(b.path);
  });
  for (const artifact of orderedArtifacts) {
    const fullPath = dataPath(dataRoot, ...artifact.path.split("/"));
    const currentHash = await fileSha256(fullPath);
    if (currentHash === artifact.before_sha256) continue;
    if (artifact.existed_before) {
      const backup = await fs.readFile(dataPath(dataRoot, ...artifact.backup_path!.split("/")));
      await atomicWriteBytes(fullPath, backup, async (candidatePath) => {
        if ((await fileSha256(candidatePath)) !== artifact.before_sha256) {
          throw new Error(`Restored artifact hash mismatch: ${artifact.path}`);
        }
      });
      restoredPaths += 1;
    } else {
      await fs.rm(fullPath, { force: true });
      removedPaths += 1;
    }
  }
  for (const artifact of artifacts) {
    const restoredHash = await fileSha256(dataPath(dataRoot, ...artifact.path.split("/")));
    if (restoredHash !== artifact.before_sha256) throw new Error(`Rollback verification failed: ${artifact.path}`);
  }
  manifest.rollback.restored_paths = restoredPaths;
  manifest.rollback.removed_paths = removedPaths;
  manifest.rollback.completed_at = nowIso(now);
  manifest.rollback.conflicts = [];
  manifest.status = "rolled_back";
  await appendMigrationLedger(dataRoot, manifest, "rollback_verified", nowIso(now), {
    restored_paths: restoredPaths,
    removed_paths: removedPaths,
  });
  await writeMigrationManifest(dataRoot, manifest);
  await buildAndWriteTaskLifecycleReport(dataRoot, { now, staleAfterMs: manifest.stale_after_ms });
  return manifest;
}

function visibleStatus(status: TaskLifecycleSettlementReport["status"], apply: boolean): string {
  if (status === "healthy") return apply ? "작업 세션 자동정리 적용 완료" : "작업 세션 자동정리 대상 없음";
  return apply ? "작업 세션 자동정리 후 수동 확인 필요" : "작업 세션 자동정리 적용 필요";
}

export function getTaskLifecycleSettlementPath(dataRoot: string): string {
  return dataPath(dataRoot, ...TASK_LIFECYCLE_SETTLEMENT_RELATIVE_PATH.split("/"));
}

export function getTaskLifecycleMigrationManifestPath(dataRoot: string, migrationId: string): string {
  return migrationPaths(dataRoot, migrationId).manifestPath;
}

async function settleTaskLifecycleUnlocked(
  dataRoot: string,
  options: SettlementOptions = {},
): Promise<{ report: TaskLifecycleSettlementReport; statusPath: string }> {
  const now = options.now ?? new Date();
  const generatedAt = nowIso(now);
  const apply = options.apply === true;
  const lifecycleBefore = await buildTaskLifecycleReport(dataRoot, {
    now,
    staleAfterMs: options.staleAfterMs,
  });
  const targetSessions = lifecycleBefore.sessions.filter((session) => session.auto_close_safe);
  const repairableManualSessions = lifecycleBefore.sessions.filter(isRepairableManualSession);
  const manualSessions = lifecycleBefore.sessions.filter(
    (session) => session.issue_codes.length > 0 && !session.auto_close_safe && !isRepairableManualSession(session),
  );
  const mutationSessions = [...targetSessions, ...repairableManualSessions];
  const plannedActions = mutationSessions.map(actionFor);
  const actions: TaskLifecycleSettlementAction[] = [];
  let manifest: TaskLifecycleMigrationManifest | null = null;
  let lifecycleAfter: TaskLifecycleReport | null = null;

  if (!apply) {
    actions.push(...plannedActions, ...manualSessions.map(actionFor));
  } else if (mutationSessions.length === 0) {
    actions.push(...manualSessions.map(actionFor));
    lifecycleAfter = (
      await buildAndWriteTaskLifecycleReport(dataRoot, {
        now,
        staleAfterMs: options.staleAfterMs,
      })
    ).report;
  } else {
    const migrationId = options.migrationId ?? makeMigrationId(now);
    manifest = await createMigrationManifest(
      dataRoot,
      migrationId,
      generatedAt,
      lifecycleBefore.stale_after_ms,
      lifecycleBefore,
      plannedActions,
      options.createRecoveryRef !== false,
    );
    try {
      manifest.status = "applying";
      await appendMigrationLedger(dataRoot, manifest, "migration_apply_started", generatedAt, {
        action_count: plannedActions.length,
      });
      await writeMigrationManifest(dataRoot, manifest);
      if (options.beforeApply) await options.beforeApply();
      let appliedCount = 0;
      for (const session of mutationSessions) {
        const planned = actionFor(session);
        await appendMigrationLedger(dataRoot, manifest, "action_started", generatedAt, {
          index: manifest.actions.find((candidate) => candidate.task_id === session.task_id)?.index ?? null,
          task_id: session.task_id,
          action: planned.action,
          task_sha256_before: planned.task_sha256_before,
          trace_sha256_before: planned.trace_sha256_before,
        });
        await writeMigrationManifest(dataRoot, manifest);
        let action: TaskLifecycleSettlementAction;
        if (session.auto_close_safe) {
          action = await applyAutoClose(dataRoot, session, lifecycleBefore, generatedAt, migrationId);
        } else if (session.decision_class === "manual_stale_review_required" && session.trace_path) {
          action = await applyStartedFromGroundedTrace(dataRoot, session, generatedAt, migrationId);
        } else if (session.decision_class === "manual_trace_binding_repair_required" && session.trace_path) {
          action = await applyTerminalTraceBinding(dataRoot, session, generatedAt, migrationId);
        } else if (session.decision_class === "manual_trace_reconstruction_required" && session.status === "blocked") {
          action = await applyBlockedMissingTrace(dataRoot, session, generatedAt, migrationId);
        } else if (session.decision_class === "manual_stale_review_required" && !session.trace_path) {
          action = await applyBlockStaleWithoutTrace(dataRoot, session, generatedAt, migrationId);
        } else {
          action = actionFor(session);
        }
        actions.push(action);
        const migrationAction = recordAppliedAction(manifest, action);
        await appendMigrationLedger(dataRoot, manifest, action.applied ? "action_applied" : "action_skipped", generatedAt, {
          index: migrationAction.index,
          task_id: action.task_id,
          action: action.action,
          applied: action.applied,
          reason_code: action.reason_code,
          task_sha256_after: action.task_sha256_after,
          trace_sha256_after: action.trace_sha256_after,
        });
        await writeMigrationManifest(dataRoot, manifest);
        if (action.applied) appliedCount += 1;
        if (options.faultAfterAppliedActions && appliedCount >= options.faultAfterAppliedActions) {
          throw new Error(`Injected task lifecycle migration fault after ${appliedCount} applied action(s)`);
        }
      }
      actions.push(...manualSessions.map(actionFor));
      lifecycleAfter = (
        await buildAndWriteTaskLifecycleReport(dataRoot, {
          now,
          staleAfterMs: options.staleAfterMs,
        })
      ).report;
      const invariantFailures = migrationInvariantFailures(lifecycleAfter);
      if (invariantFailures.length > 0) {
        throw new Error(`Task lifecycle post-migration audit failed: ${invariantFailures.join(", ")}`);
      }
      manifest.post_audit = {
        generated_at: lifecycleAfter.generated_at,
        status: lifecycleAfter.status,
        counts: lifecycleAfter.counts,
      };
      manifest.status = "verified";
      await appendMigrationLedger(dataRoot, manifest, "migration_verified", generatedAt, {
        lifecycle_counts: lifecycleAfter.counts,
        applied_action_count: actions.filter((action) => action.applied).length,
      });
      await writeMigrationManifest(dataRoot, manifest);
      await verifyMigrationLedger(dataRoot, manifest);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      manifest.failure = { at: nowIso(new Date()), message };
      manifest.status = "failed";
      await appendMigrationLedger(dataRoot, manifest, "migration_failed", nowIso(new Date()), { message });
      await writeMigrationManifest(dataRoot, manifest);
      if (options.autoRollbackOnFailure !== false) {
        try {
          manifest = await rollbackMigrationUnlocked(dataRoot, manifest, new Date());
        } catch (rollbackError) {
          const rollbackMessage = rollbackError instanceof Error ? rollbackError.message : String(rollbackError);
          throw new Error(`${message}; automatic rollback failed: ${rollbackMessage}`);
        }
      }
      throw new Error(`${message}; migration_id=${migrationId}; rollback_status=${manifest.status}`);
    }
  }

  const autoCloseCandidatesAfter = lifecycleAfter?.counts.auto_close_candidates ?? null;
  const manualRepairAfter = lifecycleAfter?.counts.manual_repair_required ?? null;
  const finishGateRepairsAfter = lifecycleAfter
    ? lifecycleAfter.sessions.filter(isRepairableManualSession).length
    : null;
  const latestMigration = manifest ?? (await readLatestMigration(dataRoot));
  const latestMigrationHealthy =
    latestMigration === null || ["verified", "rolled_back"].includes(latestMigration.status);
  const status: TaskLifecycleSettlementReport["status"] =
    migrationInvariantFailures(lifecycleAfter ?? lifecycleBefore).length === 0 && latestMigrationHealthy
      ? "healthy"
      : "needs_attention";
  const report: TaskLifecycleSettlementReport = {
    version: TASK_LIFECYCLE_SETTLEMENT_VERSION,
    status,
    generated_at: generatedAt,
    data_root: path.resolve(dataRoot),
    apply,
    lifecycle_before: {
      generated_at: lifecycleBefore.generated_at,
      status: lifecycleBefore.status,
      counts: lifecycleBefore.counts,
      by_decision_class: lifecycleBefore.by_decision_class,
      by_prompt_classification: lifecycleBefore.by_prompt_classification,
    },
    lifecycle_after: lifecycleAfter
      ? {
          generated_at: lifecycleAfter.generated_at,
          status: lifecycleAfter.status,
          counts: lifecycleAfter.counts,
          by_decision_class: lifecycleAfter.by_decision_class,
          by_prompt_classification: lifecycleAfter.by_prompt_classification,
        }
      : null,
    counts: {
      auto_close_candidates_before: targetSessions.length,
      auto_close_applied: actions.filter(
        (action) => action.applied && action.action === "auto_close_stale_non_user_service",
      ).length,
      auto_close_candidates_after: autoCloseCandidatesAfter,
      finish_gate_repairs_before: repairableManualSessions.length,
      finish_gate_repairs_applied: actions.filter(
        (action) =>
          action.applied &&
          [
            "repair_started_from_grounded_trace",
            "bind_terminal_task_to_existing_trace",
            "reconstruct_blocked_missing_trace",
            "block_stale_without_trace",
          ].includes(action.action),
      ).length,
      finish_gate_repairs_after: finishGateRepairsAfter,
      manual_repair_required_before: manualSessions.length,
      manual_repair_required_after: manualRepairAfter,
      skipped_manual_repair: actions.filter((action) => action.action === "skip_manual_repair").length,
    },
    actions,
    warnings:
      status === "healthy"
        ? []
        : [
            ...(migrationInvariantFailures(lifecycleAfter ?? lifecycleBefore).length > 0
              ? ["task_lifecycle_settlement_actions_remain"]
              : []),
            ...(!latestMigrationHealthy ? ["task_lifecycle_latest_migration_not_terminal_safe"] : []),
          ],
    visible_status: visibleStatus(status, apply),
    migration: manifest ? migrationSummary(manifest) : null,
    latest_migration: latestMigration ? migrationSummary(latestMigration) : null,
  };
  const statusPath = getTaskLifecycleSettlementPath(dataRoot);
  await writeJson(statusPath, report);
  return { report, statusPath };
}

export async function settleTaskLifecycle(
  dataRoot: string,
  options: SettlementOptions = {},
): Promise<{ report: TaskLifecycleSettlementReport; statusPath: string }> {
  if (!options.apply) return settleTaskLifecycleUnlocked(dataRoot, options);
  return withTaskLifecycleMutationLock(dataRoot, () => settleTaskLifecycleUnlocked(dataRoot, options));
}

export async function rollbackTaskLifecycleMigration(
  dataRoot: string,
  migrationId: string,
  options: RollbackTaskLifecycleMigrationOptions = {},
): Promise<{
  manifest: TaskLifecycleMigrationManifest;
  manifestPath: string;
  settlementPath: string;
}> {
  const manifestPath = getTaskLifecycleMigrationManifestPath(dataRoot, migrationId);
  const manifest = await withTaskLifecycleMutationLock(
    dataRoot,
    async () => {
      const current = await readJson<TaskLifecycleMigrationManifest>(manifestPath);
      if (current.version !== TASK_LIFECYCLE_MIGRATION_VERSION || current.migration_id !== migrationId) {
        throw new Error(`Invalid task lifecycle migration manifest: ${migrationId}`);
      }
      return rollbackMigrationUnlocked(dataRoot, current, options.now ?? new Date());
    },
  );
  const settlement = await settleTaskLifecycleUnlocked(dataRoot, {
    now: options.now,
    staleAfterMs: manifest.stale_after_ms,
  });
  return { manifest, manifestPath, settlementPath: settlement.statusPath };
}
