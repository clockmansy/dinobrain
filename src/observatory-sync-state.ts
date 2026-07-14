import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

import { atomicWriteJson, withFileLock } from "./concurrency.js";
import { isLocalOnlyMode } from "./local-only.js";
import {
  PUBLIC_SYNC_RECEIPT_PATH_PATTERN,
  publicSyncArtifactBindingSha256,
  validatePublicSyncReceipt,
  type PublicSyncReceipt,
} from "./public-sync-receipt.js";
import {
  resolveTaskSyncQueueCandidates,
  type TaskSyncQueueCandidate,
  type TaskSyncQueueCandidateResolution,
} from "./task-sync-scope.js";

export const SYNC_SCHEDULER_VERSION = "bounded_task_sync_scheduler_20260713_v1";
export const SYNC_SCHEDULER_STATE_PATH = ".dino/sync-scheduler/state.json";
export const SYNC_SCHEDULER_LOCK_PATH = ".dino/locks/sync-scheduler.lock";

export const SYNC_SCHEDULER_POLICY = {
  idle_ms: 10 * 60 * 1_000,
  coalesce_ms: 6 * 60 * 60 * 1_000,
  rolling_window_ms: 24 * 60 * 60 * 1_000,
  max_automatic_pushes: 4,
  retry_backoff_ms: [15 * 60 * 1_000, 60 * 60 * 1_000, 6 * 60 * 60 * 1_000] as const,
} as const;

const execFileAsync = promisify(execFile);
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const GIT_OID_PATTERN = /^[a-f0-9]{40,64}$/;
const MAX_REJECTED_ITEMS = 100;
const MAX_PUSH_HISTORY = 100;

export type SyncSchedulerMode = "automatic" | "manual_safe_scoped";
export type SyncSchedulerOutcome = "pushed" | "no_op" | "blocked" | "retry_required";

export type SyncQueueItem = {
  queue_id: string;
  artifact_binding_sha256: string;
  task_id: string;
  path: string;
  sha256: string;
  git_blob_oid: string;
  size_bytes: number;
  source: string;
  approval: "system_verified" | "reviewed";
  classification: "syncable" | "conditional";
  classifier_policy_version: string;
  policy: string;
  scope_version: string;
  scope_revision: number;
  scope_sha256: string;
  queued_at: string;
  eligible_at: string;
};

export type SyncSchedulerRejectedItem = {
  task_id: string;
  path: string;
  classification: string;
  policy: string;
  reason: string;
  observed_at: string;
};

export type SyncSchedulerAttempt = {
  attempt_id: string;
  mode: SyncSchedulerMode;
  started_at: string;
  finished_at: string;
  outcome: SyncSchedulerOutcome;
  reason: string;
  item_count: number;
  commit: string | null;
};

export type SyncSchedulerState = {
  version: typeof SYNC_SCHEDULER_VERSION;
  revision: number;
  updated_at: string;
  automatic_enabled: boolean;
  queue: SyncQueueItem[];
  rejected: SyncSchedulerRejectedItem[];
  automatic_push_history: string[];
  retry: { failure_count: number; next_retry_at: string; reason: string } | null;
  in_flight: { attempt_id: string; mode: SyncSchedulerMode; started_at: string; queue_ids: string[] } | null;
  last_attempt: SyncSchedulerAttempt | null;
  last_success_at: string | null;
  last_evaluation: { evaluated_at: string; eligible: boolean; reason_codes: string[]; next_eligible_at: string | null } | null;
  integrity_sha256: string;
};

export type SyncRepositoryObservation = {
  branch: string | null;
  remote: string;
  parity: "even" | "ahead" | "behind" | "diverged" | "unknown";
  ahead: number | null;
  behind: number | null;
  queued_dirty_paths: string[];
  unrelated_dirty_paths: string[];
  staged_paths: string[];
  conflict_paths: string[];
  remote_reachable: boolean | null;
  auth_available: boolean | null;
  reason_codes: string[];
};

export type SyncSchedulerEligibility = {
  eligible: boolean;
  queue_ids: string[];
  reason_codes: string[];
  next_eligible_at: string | null;
};

export type SyncSchedulerExecutionResult =
  | {
      outcome: "pushed";
      reason: string;
      pushed: true;
      commit: string;
      branch: string;
      remote_ref: string;
    }
  | {
      outcome: "no_op";
      reason: string;
      pushed: false;
      commit: string;
      branch: string;
      remote_ref: string;
    }
  | {
      outcome: "blocked" | "retry_required";
      reason: string;
      pushed: false;
      commit?: string | null;
      branch?: string | null;
      remote_ref?: string | null;
    };

export type SyncSchedulerExecutionBatch = {
  attempt_id: string;
  mode: SyncSchedulerMode;
  remote: string;
  items: SyncQueueItem[];
  tasks: Array<{ task_id: string; allowed_paths: string[]; allow_conditional: boolean }>;
};

export type SyncSchedulerRunResult = {
  executed: boolean;
  outcome: SyncSchedulerOutcome | "skipped";
  reason_codes: string[];
  next_eligible_at: string | null;
  attempt: SyncSchedulerAttempt | null;
  state: SyncSchedulerState;
  repository: SyncRepositoryObservation;
};

export type ObservatorySyncStateDto = {
  version: typeof SYNC_SCHEDULER_VERSION;
  operating_mode: "local_only" | "remote_capable";
  push_policy: "blocked" | "configured_by_git";
  automatic: {
    enabled: boolean;
    idle_minutes: number;
    coalesce_hours: number;
    maximum_pushes_per_24h: number;
    pushes_in_rolling_24h: number;
  };
  last_successful_sync: string | null;
  last_attempt: SyncSchedulerAttempt | null;
  next_eligible_automatic_sync: string | null;
  queued_safe_file_count: number;
  queued_conditional_count: number;
  blocked_count: number;
  skip_reasons: string[];
  queued_items: Array<Pick<SyncQueueItem, "queue_id" | "task_id" | "path" | "classification" | "queued_at" | "eligible_at">>;
  branch: string | null;
  remote: string;
  remote_parity: SyncRepositoryObservation["parity"];
  ahead: number | null;
  behind: number | null;
  manual_sync: {
    enabled: boolean;
    blocked_reason: string | null;
    command_kind: "safe_task_scoped";
    broad_recovery_separate: true;
    release_gate_separate: true;
  };
};

function iso(value: number): string {
  return new Date(value).toISOString();
}

function time(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value as Record<string, unknown>)
      .sort()
      .map((key) => [key, canonicalValue((value as Record<string, unknown>)[key])]),
  );
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonicalValue(value))).digest("hex");
}

function statePayload(state: SyncSchedulerState): Omit<SyncSchedulerState, "integrity_sha256"> {
  const { integrity_sha256: _integrity, ...payload } = state;
  return payload;
}

function withIntegrity(payload: Omit<SyncSchedulerState, "integrity_sha256">): SyncSchedulerState {
  return { ...payload, integrity_sha256: digest(payload) };
}

function initialState(now: number, automaticEnabled: boolean): SyncSchedulerState {
  return withIntegrity({
    version: SYNC_SCHEDULER_VERSION,
    revision: 0,
    updated_at: iso(now),
    automatic_enabled: automaticEnabled,
    queue: [],
    rejected: [],
    automatic_push_history: [],
    retry: null,
    in_flight: null,
    last_attempt: null,
    last_success_at: null,
    last_evaluation: null,
  });
}

function stateAbsolutePath(dataRoot: string): string {
  return path.join(path.resolve(dataRoot), ...SYNC_SCHEDULER_STATE_PATH.split("/"));
}

function lockAbsolutePath(dataRoot: string): string {
  return path.join(path.resolve(dataRoot), ...SYNC_SCHEDULER_LOCK_PATH.split("/"));
}

function validateQueueItem(item: SyncQueueItem): void {
  if (!SHA256_PATTERN.test(item.queue_id) || !SHA256_PATTERN.test(item.artifact_binding_sha256)) {
    throw new Error("Sync scheduler queue identity is invalid");
  }
  if (!SHA256_PATTERN.test(item.sha256) || !GIT_OID_PATTERN.test(item.git_blob_oid)) {
    throw new Error("Sync scheduler artifact identity is invalid");
  }
  if (!SHA256_PATTERN.test(item.scope_sha256) || !Number.isInteger(item.scope_revision) || item.scope_revision < 1) {
    throw new Error("Sync scheduler scope binding is invalid");
  }
  if (!time(item.queued_at) || !time(item.eligible_at) || !item.task_id || !item.path) {
    throw new Error("Sync scheduler queue metadata is invalid");
  }
}

function validateState(value: unknown): SyncSchedulerState {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Sync scheduler state is not an object");
  const state = value as SyncSchedulerState;
  if (state.version !== SYNC_SCHEDULER_VERSION) throw new Error("Sync scheduler state version mismatch");
  if (!Number.isInteger(state.revision) || state.revision < 0 || !Array.isArray(state.queue)) {
    throw new Error("Sync scheduler state schema is invalid");
  }
  for (const item of state.queue) validateQueueItem(item);
  if (new Set(state.queue.map((item) => item.queue_id)).size !== state.queue.length) {
    throw new Error("Sync scheduler queue contains duplicate identities");
  }
  if (!SHA256_PATTERN.test(state.integrity_sha256) || digest(statePayload(state)) !== state.integrity_sha256) {
    throw new Error("Sync scheduler state integrity mismatch");
  }
  return state;
}

export async function readSyncSchedulerState(input: {
  dataRoot: string;
  now?: number;
  automaticEnabledDefault?: boolean;
}): Promise<SyncSchedulerState> {
  try {
    return validateState(JSON.parse(await fs.readFile(stateAbsolutePath(input.dataRoot), "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return initialState(input.now ?? Date.now(), input.automaticEnabledDefault ?? true);
    }
    throw error;
  }
}

async function persistState(dataRoot: string, state: SyncSchedulerState, now: number): Promise<SyncSchedulerState> {
  const payload = statePayload(state);
  const next = withIntegrity({
    ...payload,
    revision: payload.revision + 1,
    updated_at: iso(now),
    queue: [...payload.queue].sort((left, right) => left.queue_id.localeCompare(right.queue_id)),
    rejected: payload.rejected.slice(-MAX_REJECTED_ITEMS),
    automatic_push_history: payload.automatic_push_history.slice(-MAX_PUSH_HISTORY),
  });
  await atomicWriteJson(stateAbsolutePath(dataRoot), next);
  return next;
}

function queueItem(input: {
  candidate: TaskSyncQueueCandidate;
  resolution: TaskSyncQueueCandidateResolution;
  now: number;
}): SyncQueueItem {
  const scopeRevision = input.resolution.scope.scope_revision;
  const scopeSha256 = input.resolution.scope.scope_sha256;
  const scopeVersion = input.resolution.scope.scope_version;
  if (!input.candidate.git_blob_oid || !scopeRevision || !scopeSha256 || !scopeVersion) {
    throw new Error(`Task sync queue candidate lacks scope identity: ${input.candidate.path}`);
  }
  if (input.candidate.approval === "pending_review") {
    throw new Error(`Task sync queue candidate is pending review: ${input.candidate.path}`);
  }
  const approval = input.candidate.approval;
  const artifactBinding = publicSyncArtifactBindingSha256({
    path: input.candidate.path,
    sha256: input.candidate.sha256,
    git_blob_oid: input.candidate.git_blob_oid,
    size_bytes: input.candidate.size_bytes,
    classification: input.candidate.classification,
    policy: input.candidate.policy,
    approval,
    source: input.candidate.source,
  });
  const queueId = digest({
    task_id: input.resolution.task_id,
    artifact_binding_sha256: artifactBinding,
    scope_version: scopeVersion,
    scope_sha256: scopeSha256,
    classifier_policy_version: input.candidate.classifier_policy_version,
  });
  return {
    queue_id: queueId,
    artifact_binding_sha256: artifactBinding,
    task_id: input.resolution.task_id,
    path: input.candidate.path,
    sha256: input.candidate.sha256,
    git_blob_oid: input.candidate.git_blob_oid,
    size_bytes: input.candidate.size_bytes,
    source: input.candidate.source,
    approval,
    classification: input.candidate.classification,
    classifier_policy_version: input.candidate.classifier_policy_version,
    policy: input.candidate.policy,
    scope_version: scopeVersion,
    scope_revision: scopeRevision,
    scope_sha256: scopeSha256,
    queued_at: iso(input.now),
    eligible_at: iso(input.now + SYNC_SCHEDULER_POLICY.coalesce_ms),
  };
}

export async function enqueueTaskScopedSync(input: {
  dataRoot: string;
  taskId: string;
  requestedPaths: string[];
  allowConditional?: boolean;
  now?: number;
  automaticEnabledDefault?: boolean;
}): Promise<{ state: SyncSchedulerState; resolution: TaskSyncQueueCandidateResolution; queued: SyncQueueItem[] }> {
  const now = input.now ?? Date.now();
  return withFileLock(lockAbsolutePath(input.dataRoot), async () => {
    let state = await readSyncSchedulerState({
      dataRoot: input.dataRoot,
      now,
      automaticEnabledDefault: input.automaticEnabledDefault,
    });
    const resolution = await resolveTaskSyncQueueCandidates({
      dataRoot: input.dataRoot,
      taskId: input.taskId,
      requestedPaths: input.requestedPaths,
      allowConditional: input.allowConditional,
    });
    const additions = resolution.candidates.map((candidate) => queueItem({ candidate, resolution, now }));
    for (const addition of additions) {
      const existing = state.queue.find((item) => item.queue_id === addition.queue_id);
      state.queue = state.queue.filter(
        (item) => !(item.task_id === addition.task_id && item.path === addition.path && item.queue_id !== addition.queue_id),
      );
      if (!existing) state.queue.push(addition);
    }
    state.rejected.push(
      ...resolution.rejected_paths.map((entry) => ({
        task_id: input.taskId,
        path: entry.path,
        classification: entry.classification,
        policy: entry.policy,
        reason: entry.reason.slice(0, 240),
        observed_at: iso(now),
      })),
    );
    state = await persistState(input.dataRoot, state, now);
    return { state, resolution, queued: additions };
  });
}

export async function setSyncSchedulerAutomaticEnabled(input: {
  dataRoot: string;
  enabled: boolean;
  now?: number;
}): Promise<SyncSchedulerState> {
  const now = input.now ?? Date.now();
  return withFileLock(lockAbsolutePath(input.dataRoot), async () => {
    const state = await readSyncSchedulerState({ dataRoot: input.dataRoot, now });
    const localOnly = isLocalOnlyMode(input.dataRoot);
    state.automatic_enabled = localOnly ? false : input.enabled;
    if (localOnly && input.enabled) {
      state.last_evaluation = {
        evaluated_at: iso(now),
        eligible: false,
        reason_codes: ["local_only_remote_push_disabled"],
        next_eligible_at: null,
      };
    }
    return persistState(input.dataRoot, state, now);
  });
}

function parseStatus(stdout: string, queued: Set<string>): Pick<SyncRepositoryObservation, "queued_dirty_paths" | "unrelated_dirty_paths" | "staged_paths" | "conflict_paths"> {
  const queuedDirty = new Set<string>();
  const unrelated = new Set<string>();
  const staged = new Set<string>();
  const conflicts = new Set<string>();
  const records = stdout.split("\0").filter(Boolean);
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    const status = record.slice(0, 2);
    let relativePath = record.slice(3).replace(/\\/g, "/");
    if (status[0] === "R" || status[0] === "C") {
      const destination = records[index + 1];
      if (destination) {
        relativePath = destination.replace(/\\/g, "/");
        index += 1;
      }
    }
    if (status[0] !== " " && status[0] !== "?") staged.add(relativePath);
    if (status.includes("U") || status === "AA" || status === "DD") conflicts.add(relativePath);
    if (queued.has(relativePath)) queuedDirty.add(relativePath);
    else unrelated.add(relativePath);
  }
  return {
    queued_dirty_paths: Array.from(queuedDirty).sort(),
    unrelated_dirty_paths: Array.from(unrelated).sort(),
    staged_paths: Array.from(staged).sort(),
    conflict_paths: Array.from(conflicts).sort(),
  };
}

async function git(dataRoot: string, args: string[], timeout = 15_000): Promise<string> {
  const result = await execFileAsync("git", ["-c", `safe.directory=${path.resolve(dataRoot)}`, "-C", dataRoot, ...args], {
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 8 * 1024 * 1024,
    timeout,
  });
  return args.includes("-z") ? result.stdout : result.stdout.trim();
}

export function classifySyncRemoteFailure(value: string): "auth_unavailable" | "offline" | "remote_unavailable" {
  if (/auth|credential|permission denied|repository not found|could not read username|terminal prompts disabled/i.test(value)) {
    return "auth_unavailable";
  }
  if (/could not resolve|network is unreachable|connection (?:timed out|refused)|unable to access|failed to connect/i.test(value)) {
    return "offline";
  }
  return "remote_unavailable";
}

export async function observeSyncRepository(input: {
  dataRoot: string;
  queuedPaths: string[];
  remote?: string;
  probeRemote?: boolean;
}): Promise<SyncRepositoryObservation> {
  const remote = input.remote ?? "origin";
  const reasons = new Set<string>();
  let branch: string | null = null;
  let parity: SyncRepositoryObservation["parity"] = "unknown";
  let ahead: number | null = null;
  let behind: number | null = null;
  let remoteReachable: boolean | null = null;
  let authAvailable: boolean | null = null;
  let status = { queued_dirty_paths: [] as string[], unrelated_dirty_paths: [] as string[], staged_paths: [] as string[], conflict_paths: [] as string[] };
  try {
    branch = (await git(input.dataRoot, ["branch", "--show-current"])) || null;
    status = parseStatus(await git(input.dataRoot, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]), new Set(input.queuedPaths));
    if (status.conflict_paths.length > 0) reasons.add("git_conflict");
    if (status.staged_paths.length > 0) reasons.add("staged_changes_present");
    if (status.unrelated_dirty_paths.length > 0) reasons.add("unrelated_dirty_backlog");
    try {
      const counts = (await git(input.dataRoot, ["rev-list", "--left-right", "--count", "HEAD...@{upstream}"]))
        .split(/\s+/)
        .map(Number);
      ahead = Number.isFinite(counts[0]) ? counts[0] : null;
      behind = Number.isFinite(counts[1]) ? counts[1] : null;
      parity = ahead === 0 && behind === 0 ? "even" : ahead! > 0 && behind! > 0 ? "diverged" : ahead! > 0 ? "ahead" : "behind";
      if (behind! > 0) reasons.add("remote_branch_ahead");
      if (parity === "diverged") reasons.add("remote_branch_diverged");
    } catch {
      reasons.add("remote_parity_unknown");
    }
    try {
      await git(input.dataRoot, ["remote", "get-url", remote]);
    } catch {
      reasons.add("remote_missing");
      remoteReachable = false;
      authAvailable = null;
    }
    if (input.probeRemote && !reasons.has("remote_missing")) {
      try {
        await git(input.dataRoot, ["ls-remote", "--exit-code", remote, "HEAD"]);
        remoteReachable = true;
        authAvailable = true;
      } catch (error) {
        const detail = `${(error as { stderr?: string }).stderr ?? ""} ${(error as Error).message}`;
        const reason = classifySyncRemoteFailure(detail);
        reasons.add(reason);
        remoteReachable = false;
        authAvailable = reason === "auth_unavailable" ? false : null;
      }
    }
  } catch {
    reasons.add("git_repository_unavailable");
  }
  return {
    branch,
    remote,
    parity,
    ahead,
    behind,
    ...status,
    remote_reachable: remoteReachable,
    auth_available: authAvailable,
    reason_codes: Array.from(reasons),
  };
}

function recentAutomaticPushes(state: SyncSchedulerState, now: number): number[] {
  return state.automatic_push_history
    .map((entry) => time(entry))
    .filter((entry): entry is number => entry !== null && now - entry < SYNC_SCHEDULER_POLICY.rolling_window_ms)
    .sort((left, right) => left - right);
}

export function evaluateSyncSchedulerEligibility(input: {
  state: SyncSchedulerState;
  repository: SyncRepositoryObservation;
  mode: SyncSchedulerMode;
  now: number;
  lastActivityAt?: number | null;
}): SyncSchedulerEligibility {
  const reasons = new Set<string>();
  const futureTimes: number[] = [];
  let candidates = input.state.queue;
  if (input.mode === "automatic") {
    if (!input.state.automatic_enabled) reasons.add("automatic_sync_disabled");
    const matured = candidates.filter((item) => (time(item.eligible_at) ?? Number.POSITIVE_INFINITY) <= input.now);
    if (matured.length === 0 && candidates.length > 0) {
      reasons.add("coalescing");
      const earliestMaturity = candidates
        .map((item) => time(item.eligible_at))
        .filter((entry): entry is number => entry !== null)
        .sort((left, right) => left - right)[0];
      if (earliestMaturity !== undefined) futureTimes.push(earliestMaturity);
    }
    candidates = matured;
    const retryAt = time(input.state.retry?.next_retry_at);
    if (retryAt !== null && retryAt > input.now) {
      reasons.add("retry_backoff");
      futureTimes.push(retryAt);
    }
    const pushes = recentAutomaticPushes(input.state, input.now);
    if (pushes.length >= SYNC_SCHEDULER_POLICY.max_automatic_pushes) {
      reasons.add("automatic_push_rate_limited");
      futureTimes.push(pushes[pushes.length - SYNC_SCHEDULER_POLICY.max_automatic_pushes] + SYNC_SCHEDULER_POLICY.rolling_window_ms);
    }
    if (input.lastActivityAt != null && input.now - input.lastActivityAt < SYNC_SCHEDULER_POLICY.idle_ms) {
      reasons.add("user_not_idle");
      futureTimes.push(input.lastActivityAt + SYNC_SCHEDULER_POLICY.idle_ms);
    }
  }
  if (input.state.in_flight) reasons.add("sync_in_progress");
  if (candidates.length === 0 && input.state.queue.length === 0) reasons.add("queue_empty");
  if (candidates.length > 0) {
    const oldestTaskId = Array.from(
      candidates.reduce((byTask, item) => {
        const queuedAt = time(item.queued_at) ?? Number.POSITIVE_INFINITY;
        byTask.set(item.task_id, Math.min(byTask.get(item.task_id) ?? Number.POSITIVE_INFINITY, queuedAt));
        return byTask;
      }, new Map<string, number>()),
    )
      .sort((left, right) => left[1] - right[1] || left[0].localeCompare(right[0]))[0]?.[0];
    candidates = candidates.filter((item) => item.task_id === oldestTaskId);
  }
  for (const reason of input.repository.reason_codes) {
    if (
      [
        "git_conflict",
        "staged_changes_present",
        "remote_missing",
        "remote_branch_ahead",
        "remote_branch_diverged",
        "auth_unavailable",
        "offline",
        "remote_unavailable",
        "git_repository_unavailable",
      ].includes(reason)
    ) {
      reasons.add(reason);
    }
  }
  return {
    eligible: candidates.length > 0 && reasons.size === 0,
    queue_ids: candidates.map((item) => item.queue_id).sort(),
    reason_codes: Array.from(reasons),
    next_eligible_at: futureTimes.length > 0 ? iso(Math.max(...futureTimes)) : null,
  };
}

function retryState(state: SyncSchedulerState, now: number, reason: string): SyncSchedulerState["retry"] {
  const failureCount = Math.max(0, state.retry?.failure_count ?? 0) + 1;
  const delay = SYNC_SCHEDULER_POLICY.retry_backoff_ms[Math.min(failureCount - 1, SYNC_SCHEDULER_POLICY.retry_backoff_ms.length - 1)];
  return { failure_count: failureCount, next_retry_at: iso(now + delay), reason: reason.slice(0, 160) };
}

function candidateBinding(item: SyncQueueItem): string {
  return publicSyncArtifactBindingSha256({
    path: item.path,
    sha256: item.sha256,
    git_blob_oid: item.git_blob_oid,
    size_bytes: item.size_bytes,
    classification: item.classification,
    policy: item.policy,
    approval: item.approval,
    source: item.source,
  });
}

async function revalidateQueue(dataRoot: string, state: SyncSchedulerState, now: number): Promise<SyncSchedulerState> {
  const groups = new Map<string, SyncQueueItem[]>();
  for (const item of state.queue) groups.set(item.task_id, [...(groups.get(item.task_id) ?? []), item]);
  const valid = new Set<string>();
  for (const [taskId, items] of groups) {
    const resolution = await resolveTaskSyncQueueCandidates({
      dataRoot,
      taskId,
      requestedPaths: items.map((item) => item.path),
      allowConditional: items.some((item) => item.classification === "conditional"),
    });
    const candidates = new Map(resolution.candidates.map((candidate) => [candidate.path, candidate]));
    for (const item of items) {
      const candidate = candidates.get(item.path);
      const candidateArtifactBinding = candidate
        ? publicSyncArtifactBindingSha256({
            path: candidate.path,
            sha256: candidate.sha256,
            git_blob_oid: candidate.git_blob_oid ?? "",
            size_bytes: candidate.size_bytes,
            classification: candidate.classification,
            policy: candidate.policy,
            approval: candidate.approval === "pending_review" ? "system_verified" : candidate.approval,
            source: candidate.source,
          })
        : null;
      if (
        candidate &&
        candidate.approval !== "pending_review" &&
        resolution.scope.scope_revision === item.scope_revision &&
        resolution.scope.scope_sha256 === item.scope_sha256 &&
        candidateArtifactBinding === item.artifact_binding_sha256 &&
        candidateBinding(item) === item.artifact_binding_sha256
      ) {
        valid.add(item.queue_id);
      } else {
        state.rejected.push({
          task_id: item.task_id,
          path: item.path,
          classification: "blocked",
          policy: "scheduler_revalidation",
          reason: "queued task scope, classifier decision, or artifact hash no longer matches",
          observed_at: iso(now),
        });
      }
    }
  }
  state.queue = state.queue.filter((item) => valid.has(item.queue_id));
  return state;
}

function taskBatches(items: SyncQueueItem[]): SyncSchedulerExecutionBatch["tasks"] {
  const groups = new Map<string, SyncQueueItem[]>();
  for (const item of items) groups.set(item.task_id, [...(groups.get(item.task_id) ?? []), item]);
  return Array.from(groups, ([task_id, taskItems]) => ({
    task_id,
    allowed_paths: taskItems.map((item) => item.path).sort(),
    allow_conditional: taskItems.some((item) => item.classification === "conditional"),
  })).sort((left, right) => left.task_id.localeCompare(right.task_id));
}

function sameStringSet(left: string[], right: string[]): boolean {
  const a = Array.from(new Set(left)).sort();
  const b = Array.from(new Set(right)).sort();
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function receiptMatchesSelectedTask(receipt: PublicSyncReceipt, taskItems: SyncQueueItem[], receiptPath: string): boolean {
  if (taskItems.length === 0 || receipt.task_id !== taskItems[0].task_id) return false;
  const artifactItems = taskItems.filter((item) => item.path !== receiptPath);
  if (!sameStringSet(receipt.artifacts.map((artifact) => artifact.path), artifactItems.map((item) => item.path))) return false;
  if (!sameStringSet(receipt.conditional_paths, artifactItems.filter((item) => item.classification === "conditional").map((item) => item.path))) {
    return false;
  }
  if (!artifactItems.some((item) => item.path === receipt.task_record_path)) return false;
  if (
    artifactItems.some(
      (item) =>
        item.classifier_policy_version !== receipt.classifier_policy_version ||
        item.scope_version !== receipt.scope.version ||
        item.scope_revision !== receipt.scope.revision ||
        item.scope_sha256 !== receipt.scope.sha256,
    )
  ) {
    return false;
  }
  const byPath = new Map(artifactItems.map((item) => [item.path, item]));
  return receipt.artifacts.every((artifact) => {
    const item = byPath.get(artifact.path);
    return Boolean(
      item &&
        publicSyncArtifactBindingSha256(artifact) === item.artifact_binding_sha256 &&
        artifact.sha256 === item.sha256 &&
        artifact.git_blob_oid === item.git_blob_oid &&
        artifact.size_bytes === item.size_bytes,
    );
  });
}

async function verifyReceiptPath(input: {
  dataRoot: string;
  commit: string;
  receiptPath: string;
  selected: SyncQueueItem[];
  verifiedTaskIds: Set<string>;
}): Promise<boolean> {
  const pathMatch = PUBLIC_SYNC_RECEIPT_PATH_PATTERN.exec(input.receiptPath);
  if (!pathMatch) return false;
  try {
    const raw = await git(input.dataRoot, ["show", `${input.commit}:${input.receiptPath}`]);
    const validation = validatePublicSyncReceipt(JSON.parse(raw));
    const receipt = validation.receipt;
    if (!validation.ok || !receipt || receipt.receipt_id !== pathMatch[1]) return false;
    if (input.verifiedTaskIds.has(receipt.task_id)) return false;
    const taskItems = input.selected.filter((item) => item.task_id === receipt.task_id);
    if (!taskItems.some((item) => item.classification === "conditional")) return false;
    if (!receiptMatchesSelectedTask(receipt, taskItems, input.receiptPath)) return false;
    input.verifiedTaskIds.add(receipt.task_id);
    return true;
  } catch {
    return false;
  }
}

async function verifySuccessfulExecution(input: {
  dataRoot: string;
  remote: string;
  selected: SyncQueueItem[];
  execution: Extract<SyncSchedulerExecutionResult, { outcome: "pushed" | "no_op" }>;
}): Promise<{ ok: boolean; reason: string }> {
  const { execution } = input;
  if (!GIT_OID_PATTERN.test(execution.commit)) return { ok: false, reason: "execution_proof_commit_invalid" };
  if (!execution.branch || execution.remote_ref !== `refs/heads/${execution.branch}`) {
    return { ok: false, reason: "execution_proof_branch_ref_invalid" };
  }
  try {
    await git(input.dataRoot, ["check-ref-format", execution.remote_ref]);
    await git(input.dataRoot, ["cat-file", "-e", `${execution.commit}^{commit}`]);
    const currentBranch = await git(input.dataRoot, ["branch", "--show-current"]);
    const localTip = (await git(input.dataRoot, ["rev-parse", `refs/heads/${execution.branch}`])).toLowerCase();
    if (currentBranch !== execution.branch || localTip !== execution.commit.toLowerCase()) {
      return { ok: false, reason: "execution_proof_local_branch_mismatch" };
    }
    const remoteLines = (await git(input.dataRoot, ["ls-remote", "--exit-code", input.remote, execution.remote_ref]))
      .split(/\r?\n/)
      .filter(Boolean);
    const remoteTip = remoteLines
      .map((line) => line.split(/\s+/))
      .find((parts) => parts[1] === execution.remote_ref)?.[0]?.toLowerCase();
    if (!remoteTip || remoteTip !== execution.commit.toLowerCase()) {
      return { ok: false, reason: "execution_proof_remote_ref_mismatch" };
    }
    for (const item of input.selected) {
      const committedBlob = (await git(input.dataRoot, ["rev-parse", `${execution.commit}:${item.path}`])).toLowerCase();
      if (committedBlob !== item.git_blob_oid) return { ok: false, reason: "execution_proof_queue_blob_mismatch" };
    }
    const changedPaths = execution.outcome === "pushed"
      ? (await git(input.dataRoot, ["diff-tree", "--root", "--no-commit-id", "--name-only", "-r", "-z", execution.commit]))
          .split("\0")
          .filter(Boolean)
          .map((entry) => entry.replace(/\\/g, "/"))
      : [];
    const selectedPaths = new Set(input.selected.map((item) => item.path));
    const receiptPaths = Array.from(
      new Set(
        [...changedPaths, ...input.selected.map((item) => item.path)].filter((candidatePath) =>
          PUBLIC_SYNC_RECEIPT_PATH_PATTERN.test(candidatePath),
        ),
      ),
    );
    const extraPaths = changedPaths.filter(
      (changedPath) => !selectedPaths.has(changedPath) && !PUBLIC_SYNC_RECEIPT_PATH_PATTERN.test(changedPath),
    );
    if (extraPaths.length > 0) return { ok: false, reason: "execution_proof_changed_paths_out_of_scope" };
    const verifiedTaskIds = new Set<string>();
    for (const receiptPath of receiptPaths) {
      if (!(await verifyReceiptPath({
        dataRoot: input.dataRoot,
        commit: execution.commit,
        receiptPath,
        selected: input.selected,
        verifiedTaskIds,
      }))) {
        return { ok: false, reason: "execution_proof_changed_paths_out_of_scope" };
      }
    }
    const conditionalTaskIds = new Set(
      input.selected.filter((item) => item.classification === "conditional").map((item) => item.task_id),
    );
    if (!sameStringSet(Array.from(verifiedTaskIds), Array.from(conditionalTaskIds))) {
      return { ok: false, reason: "execution_proof_conditional_receipt_missing" };
    }
    if (execution.outcome === "no_op") {
      return execution.pushed === false
        ? { ok: true, reason: "execution_no_op_verified" }
        : { ok: false, reason: "execution_proof_no_op_push_flag_invalid" };
    }
    if (execution.pushed !== true) return { ok: false, reason: "execution_proof_push_flag_invalid" };
    return { ok: true, reason: "execution_push_verified" };
  } catch {
    return { ok: false, reason: "execution_proof_git_observation_failed" };
  }
}

async function runScheduler(input: {
  dataRoot: string;
  mode: SyncSchedulerMode;
  lastActivityAt?: number | null;
  remote?: string;
  now?: number;
  execute: (batch: SyncSchedulerExecutionBatch) => Promise<SyncSchedulerExecutionResult>;
}): Promise<SyncSchedulerRunResult> {
  const now = input.now ?? Date.now();
  const remote = input.remote ?? "origin";
  return withFileLock(lockAbsolutePath(input.dataRoot), async () => {
    let state = await readSyncSchedulerState({ dataRoot: input.dataRoot, now });
    if (isLocalOnlyMode(input.dataRoot)) {
      state.automatic_enabled = false;
      state.in_flight = null;
      state.last_evaluation = {
        evaluated_at: iso(now),
        eligible: false,
        reason_codes: ["local_only_remote_push_disabled"],
        next_eligible_at: null,
      };
      const repository = await observeSyncRepository({
        dataRoot: input.dataRoot,
        queuedPaths: state.queue.map((item) => item.path),
        remote,
        probeRemote: false,
      });
      state = await persistState(input.dataRoot, state, now);
      return {
        executed: false,
        outcome: "skipped",
        reason_codes: ["local_only_remote_push_disabled"],
        next_eligible_at: null,
        attempt: null,
        state,
        repository,
      };
    }
    if (state.in_flight) {
      state.last_attempt = {
        attempt_id: state.in_flight.attempt_id,
        mode: state.in_flight.mode,
        started_at: state.in_flight.started_at,
        finished_at: iso(now),
        outcome: "retry_required",
        reason: "abandoned_attempt_recovered",
        item_count: state.in_flight.queue_ids.length,
        commit: null,
      };
      state.retry = retryState(state, now, "abandoned_attempt_recovered");
      state.in_flight = null;
    }
    state = await revalidateQueue(input.dataRoot, state, now);
    const repository = await observeSyncRepository({
      dataRoot: input.dataRoot,
      queuedPaths: state.queue.map((item) => item.path),
      remote,
      probeRemote: true,
    });
    const eligibility = evaluateSyncSchedulerEligibility({
      state,
      repository,
      mode: input.mode,
      now,
      lastActivityAt: input.lastActivityAt,
    });
    state.last_evaluation = {
      evaluated_at: iso(now),
      eligible: eligibility.eligible,
      reason_codes: eligibility.reason_codes,
      next_eligible_at: eligibility.next_eligible_at,
    };
    if (!eligibility.eligible) {
      state = await persistState(input.dataRoot, state, now);
      return {
        executed: false,
        outcome: "skipped",
        reason_codes: eligibility.reason_codes,
        next_eligible_at: eligibility.next_eligible_at,
        attempt: null,
        state,
        repository,
      };
    }

    const selected = state.queue.filter((item) => eligibility.queue_ids.includes(item.queue_id));
    const attemptId = digest({ mode: input.mode, now: iso(now), queue_ids: eligibility.queue_ids, nonce: randomUUID() });
    const startedAt = iso(now);
    state.in_flight = { attempt_id: attemptId, mode: input.mode, started_at: startedAt, queue_ids: eligibility.queue_ids };
    state = await persistState(input.dataRoot, state, now);

    let execution: SyncSchedulerExecutionResult;
    try {
      execution = await input.execute({
        attempt_id: attemptId,
        mode: input.mode,
        remote,
        items: selected,
        tasks: taskBatches(selected),
      });
    } catch {
      execution = { outcome: "retry_required", reason: "sync_executor_failed", pushed: false };
    }
    if (execution.outcome === "pushed" || execution.outcome === "no_op") {
      const proof = await verifySuccessfulExecution({
        dataRoot: input.dataRoot,
        remote,
        selected,
        execution,
      });
      if (!proof.ok) execution = { outcome: "retry_required", reason: proof.reason, pushed: false };
    }
    const attempt: SyncSchedulerAttempt = {
      attempt_id: attemptId,
      mode: input.mode,
      started_at: startedAt,
      finished_at: iso(now),
      outcome: execution.outcome,
      reason: execution.reason.slice(0, 160),
      item_count: selected.length,
      commit: execution.commit && GIT_OID_PATTERN.test(execution.commit) ? execution.commit : null,
    };
    state.in_flight = null;
    state.last_attempt = attempt;
    if (execution.outcome === "pushed" || execution.outcome === "no_op") {
      const selectedIds = new Set(selected.map((item) => item.queue_id));
      state.queue = state.queue.filter((item) => !selectedIds.has(item.queue_id));
      state.retry = null;
      if (execution.outcome === "pushed") {
        state.last_success_at = iso(now);
        if (input.mode === "automatic") state.automatic_push_history.push(iso(now));
      }
    } else if (execution.outcome === "retry_required") {
      state.retry = retryState(state, now, execution.reason);
    }
    state = await persistState(input.dataRoot, state, now);
    return {
      executed: true,
      outcome: execution.outcome,
      reason_codes: [execution.reason],
      next_eligible_at: state.retry?.next_retry_at ?? null,
      attempt,
      state,
      repository,
    };
  });
}

export async function runAutomaticSyncScheduler(input: {
  dataRoot: string;
  lastActivityAt: number;
  remote?: string;
  now?: number;
  execute: (batch: SyncSchedulerExecutionBatch) => Promise<SyncSchedulerExecutionResult>;
}): Promise<SyncSchedulerRunResult> {
  return runScheduler({ ...input, mode: "automatic" });
}

export async function runManualSafeScopedSync(input: {
  dataRoot: string;
  remote?: string;
  now?: number;
  execute: (batch: SyncSchedulerExecutionBatch) => Promise<SyncSchedulerExecutionResult>;
}): Promise<SyncSchedulerRunResult> {
  return runScheduler({ ...input, mode: "manual_safe_scoped" });
}

function projectedNextAutomatic(state: SyncSchedulerState, now: number): string | null {
  const queueTimes = state.queue
    .map((item) => time(item.eligible_at))
    .filter((entry): entry is number => entry !== null)
    .sort((left, right) => left - right);
  const times = queueTimes.length > 0 ? [queueTimes[0]] : [];
  const retryAt = time(state.retry?.next_retry_at);
  if (retryAt !== null) times.push(retryAt);
  const pushes = recentAutomaticPushes(state, now);
  if (pushes.length >= SYNC_SCHEDULER_POLICY.max_automatic_pushes) {
    times.push(pushes[pushes.length - SYNC_SCHEDULER_POLICY.max_automatic_pushes] + SYNC_SCHEDULER_POLICY.rolling_window_ms);
  }
  return times.length > 0 ? iso(Math.max(now, ...times)) : null;
}

export async function readObservatorySyncState(input: {
  dataRoot: string;
  remote?: string;
  now?: number;
}): Promise<ObservatorySyncStateDto> {
  const now = input.now ?? Date.now();
  const localOnly = isLocalOnlyMode(input.dataRoot);
  const state = await readSyncSchedulerState({ dataRoot: input.dataRoot, now });
  const repository = await observeSyncRepository({
    dataRoot: input.dataRoot,
    queuedPaths: state.queue.map((item) => item.path),
    remote: input.remote,
    probeRemote: false,
  });
  const recentPushes = recentAutomaticPushes(state, now);
  return {
    version: SYNC_SCHEDULER_VERSION,
    operating_mode: localOnly ? "local_only" : "remote_capable",
    push_policy: localOnly ? "blocked" : "configured_by_git",
    automatic: {
      enabled: !localOnly && state.automatic_enabled,
      idle_minutes: SYNC_SCHEDULER_POLICY.idle_ms / 60_000,
      coalesce_hours: SYNC_SCHEDULER_POLICY.coalesce_ms / (60 * 60 * 1_000),
      maximum_pushes_per_24h: SYNC_SCHEDULER_POLICY.max_automatic_pushes,
      pushes_in_rolling_24h: recentPushes.length,
    },
    last_successful_sync: state.last_success_at,
    last_attempt: state.last_attempt,
    next_eligible_automatic_sync: localOnly ? null : projectedNextAutomatic(state, now),
    queued_safe_file_count: state.queue.filter((item) => item.classification === "syncable").length,
    queued_conditional_count: state.queue.filter((item) => item.classification === "conditional").length,
    blocked_count: state.rejected.length,
    skip_reasons: localOnly
      ? Array.from(new Set(["local_only_remote_push_disabled", ...(state.last_evaluation?.reason_codes ?? [])]))
      : state.last_evaluation?.reason_codes ?? [],
    queued_items: state.queue.slice(0, 100).map((item) => ({
      queue_id: item.queue_id,
      task_id: item.task_id,
      path: item.path,
      classification: item.classification,
      queued_at: item.queued_at,
      eligible_at: item.eligible_at,
    })),
    branch: repository.branch,
    remote: repository.remote,
    remote_parity: repository.parity,
    ahead: repository.ahead,
    behind: repository.behind,
    manual_sync: {
      enabled: !localOnly,
      blocked_reason: localOnly ? "local_only_remote_push_disabled" : null,
      command_kind: "safe_task_scoped",
      broad_recovery_separate: true,
      release_gate_separate: true,
    },
  };
}
