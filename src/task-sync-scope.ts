import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

import { atomicWriteJson, withFileLock } from "./concurrency.js";
import {
  DATA_CLASSIFICATION_POLICY_VERSION,
  classifyDataFileAtPath,
  type DataFileClassification,
} from "./data-classification.js";

export const TASK_SYNC_SCOPE_VERSION = "task_sync_scope_20260711_v2";

const execFileAsync = promisify(execFile);

export type TaskSyncApproval = "pending_review" | "system_verified" | "reviewed";

export type TaskSyncScopeEntry = {
  path: string;
  sha256: string;
  git_blob_oid: string | null;
  size_bytes: number;
  source: string;
  approval: TaskSyncApproval;
  registered_at: string;
};

export type TaskSyncScopeRecord = {
  version: string;
  task_id: string;
  task_path: string;
  status: "open" | "terminal";
  revision: number;
  created_at: string;
  updated_at: string;
  entries: TaskSyncScopeEntry[];
};

export type TaskSyncScopeResolution = {
  ok: boolean;
  state: "verified" | "blocked";
  task_id: string;
  scope_path: string;
  scope_version: string | null;
  scope_revision: number | null;
  scope_sha256: string | null;
  task_path: string | null;
  requested_path_count: number;
  selected_path_count: number;
  entries: TaskSyncScopeEntry[];
  reason_codes: string[];
  rejected_paths: Array<{ path: string; reason: string }>;
};

export type TaskSyncQueueCandidate = TaskSyncScopeEntry & {
  classification: "syncable" | "conditional";
  classifier_policy_version: string;
  policy: string;
};

export type TaskSyncQueueCandidateResolution = {
  ok: boolean;
  task_id: string;
  scope: TaskSyncScopeResolution;
  candidates: TaskSyncQueueCandidate[];
  rejected_paths: Array<{
    path: string;
    reason: string;
    classification: DataFileClassification["classification"] | "scope_blocked";
    policy: string;
  }>;
  reason_codes: string[];
};

function sha256Text(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function safeTaskSlug(value: string): string {
  const slug = value
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 160);
  return slug || "task";
}

function normalizeRelativePath(value: string): string {
  const normalized = value.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "");
  if (!normalized || /^[A-Za-z]:\//.test(normalized) || path.posix.isAbsolute(normalized)) {
    throw new Error(`Task sync path must be repository-relative: ${value}`);
  }
  const segments = normalized.split("/");
  if (segments.some((segment) => segment === ".." || segment === "")) {
    throw new Error(`Task sync path escapes the data root: ${value}`);
  }
  return normalized;
}

function scopeIdentity(taskId: string): string {
  return sha256Text(taskId).slice(0, 32);
}

export function taskSyncScopeRelativePath(taskId: string): string {
  return `.dino/sync-scopes/task-sync-${TASK_SYNC_SCOPE_VERSION}-${scopeIdentity(taskId)}.json`;
}

function taskRelativePath(taskId: string): string {
  return `.dino/tasks/${safeTaskSlug(taskId)}.json`;
}

function absoluteFromRelative(dataRoot: string, relativePath: string): string {
  const root = path.resolve(dataRoot);
  const target = path.resolve(root, normalizeRelativePath(relativePath));
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) {
    throw new Error(`Task sync path escapes the data root: ${relativePath}`);
  }
  return target;
}

async function fileHash(filePath: string): Promise<{ sha256: string; size: number }> {
  const handle = await fs.open(filePath, "r");
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  let size = 0;
  try {
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
      size += bytesRead;
    }
  } finally {
    await handle.close();
  }
  return { sha256: hash.digest("hex"), size };
}

async function gitBlobOid(dataRoot: string, relativePath: string, filePath: string): Promise<string | null> {
  try {
    const result = await execFileAsync(
      "git",
      [
        "-c",
        `safe.directory=${path.resolve(dataRoot)}`,
        "-C",
        dataRoot,
        "hash-object",
        `--path=${relativePath}`,
        filePath,
      ],
      { encoding: "utf8", windowsHide: true, maxBuffer: 1024 * 1024 },
    );
    const oid = result.stdout.trim();
    return /^[a-f0-9]{40,64}$/i.test(oid) ? oid.toLowerCase() : null;
  } catch {
    return null;
  }
}

async function stableFileIdentity(
  dataRoot: string,
  relativePath: string,
  filePath: string,
): Promise<{ sha256: string; git_blob_oid: string | null; size: number }> {
  const before = await fileHash(filePath);
  const oid = await gitBlobOid(dataRoot, relativePath, filePath);
  const after = await fileHash(filePath);
  if (before.sha256 !== after.sha256 || before.size !== after.size) {
    throw new Error(`Task sync artifact changed while its identity was captured: ${relativePath}`);
  }
  return { ...after, git_blob_oid: oid };
}

async function verifyTaskRecord(dataRoot: string, taskId: string): Promise<string> {
  const relativePath = taskRelativePath(taskId);
  const raw = await fs.readFile(absoluteFromRelative(dataRoot, relativePath), "utf8");
  const record = JSON.parse(raw) as { task_id?: string };
  if (record.task_id !== taskId) throw new Error(`Task sync scope task binding mismatch: ${taskId}`);
  return relativePath;
}

function approvalRank(value: TaskSyncApproval): number {
  if (value === "reviewed") return 2;
  if (value === "system_verified") return 1;
  return 0;
}

export async function registerTaskSyncPaths(input: {
  dataRoot: string;
  taskId: string;
  paths: string[];
  source: string;
  approval: TaskSyncApproval;
  terminal?: boolean;
  ignoreMissing?: boolean;
}): Promise<{ scope_path: string; registered_paths: string[]; revision: number }> {
  const uniquePaths = Array.from(new Set(input.paths.map(normalizeRelativePath)));
  if (uniquePaths.length === 0) {
    return { scope_path: taskSyncScopeRelativePath(input.taskId), registered_paths: [], revision: 0 };
  }
  const taskPath = await verifyTaskRecord(input.dataRoot, input.taskId);
  const scopeRelative = taskSyncScopeRelativePath(input.taskId);
  const scopePath = absoluteFromRelative(input.dataRoot, scopeRelative);
  const lockPath = path.join(input.dataRoot, ".dino", "locks", `task-sync-${scopeIdentity(input.taskId)}.lock`);

  return withFileLock(lockPath, async () => {
    let existing: TaskSyncScopeRecord | null = null;
    try {
      existing = JSON.parse(await fs.readFile(scopePath, "utf8")) as TaskSyncScopeRecord;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (existing && (existing.version !== TASK_SYNC_SCOPE_VERSION || existing.task_id !== input.taskId)) {
      throw new Error(`Task sync scope binding is invalid: ${scopeRelative}`);
    }

    const now = new Date().toISOString();
    const byPath = new Map((existing?.entries ?? []).map((entry) => [entry.path, entry]));
    const registeredPaths: string[] = [];
    for (const relativePath of uniquePaths) {
      const fullPath = absoluteFromRelative(input.dataRoot, relativePath);
      let stat;
      try {
        stat = await fs.lstat(fullPath);
      } catch (error) {
        if (input.ignoreMissing && (error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Task sync scope accepts regular files only: ${relativePath}`);
      const digest = await stableFileIdentity(input.dataRoot, relativePath, fullPath);
      const prior = byPath.get(relativePath);
      const sameIdentity =
        prior?.sha256 === digest.sha256 &&
        prior.size_bytes === digest.size &&
        (prior.git_blob_oid ?? null) === digest.git_blob_oid;
      byPath.set(relativePath, {
        path: relativePath,
        sha256: digest.sha256,
        git_blob_oid: digest.git_blob_oid,
        size_bytes: digest.size,
        source: input.source,
        approval:
          prior && sameIdentity && approvalRank(prior.approval) > approvalRank(input.approval)
            ? prior.approval
            : input.approval,
        registered_at: now,
      });
      registeredPaths.push(relativePath);
    }

    const record: TaskSyncScopeRecord = {
      version: TASK_SYNC_SCOPE_VERSION,
      task_id: input.taskId,
      task_path: taskPath,
      status: input.terminal ? "terminal" : existing?.status ?? "open",
      revision: (existing?.revision ?? 0) + 1,
      created_at: existing?.created_at ?? now,
      updated_at: now,
      entries: Array.from(byPath.values()).sort((a, b) => a.path.localeCompare(b.path)),
    };
    await atomicWriteJson(scopePath, record);
    return { scope_path: scopeRelative, registered_paths: registeredPaths, revision: record.revision };
  });
}

export async function resolveTaskSyncScope(input: {
  dataRoot: string;
  taskId: string;
  requestedPaths: string[];
}): Promise<TaskSyncScopeResolution> {
  const scopeRelative = taskSyncScopeRelativePath(input.taskId);
  const rejected: Array<{ path: string; reason: string }> = [];
  const reasonCodes: string[] = [];
  let requested: string[] = [];
  try {
    requested = Array.from(new Set(input.requestedPaths.map(normalizeRelativePath)));
  } catch (error) {
    reasonCodes.push("invalid_requested_path");
    rejected.push({ path: "(invalid)", reason: String((error as Error).message) });
  }
  if (requested.length === 0) reasonCodes.push("nonempty_allowlist_required");

  let scope: TaskSyncScopeRecord | null = null;
  let scopeSha256: string | null = null;
  try {
    await verifyTaskRecord(input.dataRoot, input.taskId);
    const scopeRaw = await fs.readFile(absoluteFromRelative(input.dataRoot, scopeRelative), "utf8");
    scopeSha256 = createHash("sha256").update(scopeRaw).digest("hex");
    scope = JSON.parse(scopeRaw) as TaskSyncScopeRecord;
  } catch (error) {
    reasonCodes.push("task_sync_scope_unavailable");
    rejected.push({ path: scopeRelative, reason: String((error as Error).message).slice(0, 240) });
  }
  if (scope && (scope.version !== TASK_SYNC_SCOPE_VERSION || scope.task_id !== input.taskId)) {
    reasonCodes.push("task_sync_scope_binding_mismatch");
  }

  const entriesByPath = new Map((scope?.entries ?? []).map((entry) => [entry.path, entry]));
  const selected: TaskSyncScopeEntry[] = [];
  for (const relativePath of requested) {
    const entry = entriesByPath.get(relativePath);
    if (!entry) {
      reasonCodes.push("requested_path_outside_task_scope");
      rejected.push({ path: relativePath, reason: "path is not registered by this task" });
      continue;
    }
    if (entry.approval === "pending_review") {
      reasonCodes.push("requested_path_review_pending");
      rejected.push({ path: relativePath, reason: "task artifact has not passed review or system verification" });
      continue;
    }
    try {
      const fullPath = absoluteFromRelative(input.dataRoot, relativePath);
      const stat = await fs.lstat(fullPath);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("not a regular file");
      const digest = await stableFileIdentity(input.dataRoot, relativePath, fullPath);
      if (digest.sha256 !== entry.sha256 || digest.size !== entry.size_bytes) {
        reasonCodes.push("task_scope_hash_mismatch");
        rejected.push({ path: relativePath, reason: "artifact changed after task-scope registration" });
        continue;
      }
      if (!entry.git_blob_oid || !digest.git_blob_oid) {
        reasonCodes.push("task_scope_git_identity_missing");
        rejected.push({ path: relativePath, reason: "artifact is not bound to a Git-filtered blob identity" });
        continue;
      }
      if (digest.git_blob_oid !== entry.git_blob_oid) {
        reasonCodes.push("task_scope_git_blob_mismatch");
        rejected.push({ path: relativePath, reason: "Git-filtered artifact identity changed after registration" });
        continue;
      }
      selected.push(entry);
    } catch (error) {
      reasonCodes.push("task_scope_artifact_unavailable");
      rejected.push({ path: relativePath, reason: String((error as Error).message).slice(0, 240) });
    }
  }

  const uniqueReasons = Array.from(new Set(reasonCodes));
  return {
    ok: uniqueReasons.length === 0 && selected.length > 0,
    state: uniqueReasons.length === 0 && selected.length > 0 ? "verified" : "blocked",
    task_id: input.taskId,
    scope_path: scopeRelative,
    scope_version: scope?.version ?? null,
    scope_revision: scope?.revision ?? null,
    scope_sha256: scopeSha256,
    task_path: scope?.task_path ?? null,
    requested_path_count: requested.length,
    selected_path_count: selected.length,
    entries: selected,
    reason_codes: uniqueReasons,
    rejected_paths: rejected.slice(0, 100),
  };
}

function sameScopeEntry(left: TaskSyncScopeEntry | undefined, right: TaskSyncScopeEntry | undefined): boolean {
  return Boolean(
    left &&
      right &&
      left.path === right.path &&
      left.sha256 === right.sha256 &&
      left.git_blob_oid === right.git_blob_oid &&
      left.size_bytes === right.size_bytes &&
      left.approval === right.approval,
  );
}

/**
 * Resolves a task scope and independently re-runs the unified path/content
 * classifier. A second scope resolution closes the race between classification
 * and queue admission, so queue candidates remain bound to the reviewed bytes.
 */
export async function resolveTaskSyncQueueCandidates(input: {
  dataRoot: string;
  taskId: string;
  requestedPaths: string[];
  allowConditional?: boolean;
}): Promise<TaskSyncQueueCandidateResolution> {
  const first = await resolveTaskSyncScope(input);
  if (!first.ok) {
    return {
      ok: false,
      task_id: input.taskId,
      scope: first,
      candidates: [],
      rejected_paths: first.rejected_paths.map((entry) => ({
        path: entry.path,
        reason: entry.reason,
        classification: "scope_blocked",
        policy: "task_sync_scope",
      })),
      reason_codes: first.reason_codes,
    };
  }

  const classified = await Promise.all(
    first.entries.map(async (entry) => ({
      entry,
      decision: await classifyDataFileAtPath({
        root: input.dataRoot,
        relativePath: entry.path,
        scanContent: true,
      }),
    })),
  );
  const second = await resolveTaskSyncScope(input);
  const secondByPath = new Map(second.entries.map((entry) => [entry.path, entry]));
  const candidates: TaskSyncQueueCandidate[] = [];
  const rejected: TaskSyncQueueCandidateResolution["rejected_paths"] = [];
  const reasonCodes = new Set<string>(second.reason_codes);

  for (const { entry, decision } of classified) {
    if (!second.ok || !sameScopeEntry(entry, secondByPath.get(entry.path))) {
      reasonCodes.add("task_scope_changed_during_classification");
      rejected.push({
        path: entry.path,
        reason: "task scope or artifact identity changed during classifier evaluation",
        classification: "scope_blocked",
        policy: "task_scope_race",
      });
      continue;
    }
    if (
      decision.policy_version !== DATA_CLASSIFICATION_POLICY_VERSION ||
      !decision.scan.complete ||
      decision.classification === "blocked" ||
      decision.findings.some((finding) => finding.severity === "blocker")
    ) {
      reasonCodes.add("task_sync_candidate_classifier_blocked");
      rejected.push({
        path: entry.path,
        reason: decision.reasons.join(", ") || "unified classifier blocked the artifact",
        classification: decision.classification,
        policy: decision.policy,
      });
      continue;
    }
    if (decision.classification === "conditional" && input.allowConditional !== true) {
      reasonCodes.add("task_sync_candidate_conditional_requires_opt_in");
      rejected.push({
        path: entry.path,
        reason: "conditional artifacts require the existing explicit policy opt-in",
        classification: decision.classification,
        policy: decision.policy,
      });
      continue;
    }
    candidates.push({
      ...entry,
      classification: decision.classification,
      classifier_policy_version: decision.policy_version,
      policy: decision.policy,
    });
  }

  candidates.sort((left, right) => left.path.localeCompare(right.path));
  return {
    ok: candidates.length > 0 && rejected.length === 0 && reasonCodes.size === 0,
    task_id: input.taskId,
    scope: second,
    candidates,
    rejected_paths: rejected,
    reason_codes: Array.from(reasonCodes),
  };
}
