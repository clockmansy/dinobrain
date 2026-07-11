import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { promisify } from "node:util";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import {
  appendBehaviorRecallEntry,
  buildFinishBehaviorRecallEntry,
  findPotentialBehaviorConflicts,
  recordFeedbackCorrectionRecall,
} from "./behavior-recall.js";
import { ClientMcpProofRuntime } from "./client-mcp-proof.js";
import { applyColdPartitions, searchColdPartitions } from "./cold-partitions.js";
import { appendFileWithLock, atomicWriteJson, withFileLock } from "./concurrency.js";
import { evaluateBehaviorMemoryLift } from "./behavior-eval.js";
import {
  buildAndWriteControlledCompoundingStatus,
  CONTROLLED_COMPOUNDING_PROPOSAL_VERSION,
  evaluateControlledCompoundingPromotion,
  runCompoundingCycle,
} from "./compounding.js";
import { SEARCH_ROOTS, standardRankingInputsForMode } from "./context.js";
import {
  DATA_CLASSIFICATION_POLICY_VERSION,
  classifyDataFileAtPath,
  redactMachineLocalPaths,
  redactMachineLocalValue,
  type DataFileClassification,
} from "./data-classification.js";
import { retrievalCaveatsForMode } from "./hybrid-retrieval.js";
import { makeUniqueId } from "./ids.js";
import { buildMemoryAudit } from "./memory-audit.js";
import { applyNodeLifecycle } from "./lifecycle.js";
import {
  evaluateAcceptedEligibility,
  getNodeLifecycleState,
  NODE_LIFECYCLE_STATES,
  type LifecycleMutationInput,
  type NodeLifecycleState,
} from "./node-lifecycle.js";
import {
  currentNodeRecord,
  initializeLifecycleWrite,
  rollbackNodeLifecycleTransaction,
  restoreDeletedNode,
  transitionLifecycleWrite,
  transitionNodeLifecycleFile,
  writeNodeLifecycleBatch,
  type LifecycleBatchWrite,
} from "./node-lifecycle-store.js";
import { classifyPromptLaunch } from "./prompt-eligibility.js";
import { publicSyncReceiptCommitMessage, writePublicSyncReceipt } from "./public-sync-receipt.js";
import { buildReviewQueueBackpressure, writeReviewGatedBatch } from "./review-backpressure.js";
import { buildReviewWorklistActions } from "./review-worklist-actions.js";
import { publishSourceLineage } from "./source-lineage-publication.js";
import { withTaskLifecycleMutationLock } from "./task-lifecycle-lock.js";
import {
  TASK_SYNC_SCOPE_VERSION,
  registerTaskSyncPaths,
  resolveTaskSyncScope,
  type TaskSyncScopeEntry,
} from "./task-sync-scope.js";
import { writeTerminalTaskAndTrace, writeTerminalTaskAndTraceUnlocked } from "./task-terminal-store.js";
import {
  type OperationContextPackEntry,
  type OperationEventEntry,
  type OperationTaskEntry,
  type OperationTraceEntry,
  appendOperationEvent,
  upsertOperationContextPack,
  upsertOperationTask,
  upsertOperationTrace,
} from "./operations-index.js";
import { getContextPackItems, searchWiki } from "./retrieval.js";
import {
  appendSqliteOperationEvent,
  invalidateSqliteWikiShard,
  upsertSqliteOperationContextPack,
  upsertSqliteOperationTask,
  upsertSqliteOperationTrace,
} from "./sqlite-shards.js";
import { buildSessionImportPlan, type SessionMessageInput } from "./session-ingest.js";
import {
  DINOBRAIN_OS_CONTRACT,
  DINOBRAIN_OS_VERSION,
  detectRequestActionIntent,
  effectiveSensitivity,
  evaluateActionGates,
  type SyncRiskObservation,
} from "./os-contract.js";
import { invalidateWikiIndex } from "./wiki-index.js";

const execFileAsync = promisify(execFile);

const DATA_ROOT = path.resolve(
  process.env.DINOBRAIN_DATA_DIR ?? path.join(process.cwd(), "..", "dinobrain-data"),
);

function envFlag(name: string, defaultValue: boolean): boolean {
  const value = process.env[name];
  if (value === undefined || value.trim() === "") return defaultValue;
  return /^(1|true|yes|on)$/i.test(value.trim());
}

function nowIso(): string {
  return new Date().toISOString();
}

function dateStamp(date = new Date()): string {
  return date.toISOString().slice(0, 10);
}

function safeSlug(value: string): string {
  const slug = value
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 160);
  return slug || "task";
}

function makeTaskId(request: string): string {
  return makeUniqueId("task", request, 28);
}

function makePackId(question: string): string {
  return makeUniqueId("pack", question, 28);
}

function makeCandidateId(claim: string): string {
  return makeUniqueId("candidate", claim, 28);
}

function makeQuarantineId(targetPath: string): string {
  return `quarantine-${sha256(targetPath).slice(0, 32)}`;
}

function isInside(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!!relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}

function dataPath(...parts: string[]): string {
  const target = path.resolve(DATA_ROOT, ...parts);
  if (!isInside(target, DATA_ROOT)) {
    throw new Error(`Path escapes data root: ${parts.join("/")}`);
  }
  return target;
}

function relDataPath(filePath: string): string {
  return path.relative(DATA_ROOT, filePath).split(path.sep).join("/");
}

function normalizeVaultPath(value: string): string {
  const trimmed = value.trim();
  if (
    path.win32.isAbsolute(trimmed) ||
    path.posix.isAbsolute(trimmed) ||
    /^[A-Za-z]:[\\/]/.test(trimmed) ||
    /^\\\\/.test(trimmed)
  ) {
    throw new Error("Vault paths must be relative to the DinoBrain data root");
  }
  const normalized = trimmed.replace(/\\/g, "/");
  dataPath(normalized);
  return normalized;
}

function normalizeVaultPaths(values: string[]): string[] {
  return Array.from(
    new Set(
      values
        .map((value) => value.trim())
        .filter(Boolean)
        .map((value) => normalizeVaultPath(value)),
    ),
  );
}

function normalizeTextList(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}

function envString(name: string, defaultValue: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === "") return defaultValue;
  return value.trim();
}

const promptLaunchInputSchema = {
  launch_kind: z.string().max(80).optional(),
  prompt_surface: z.string().max(120).optional(),
  task_type: z.string().max(120).optional(),
  launch_source: z.string().max(120).optional(),
  hook_run_id: z.string().max(200).optional(),
  client_session_id: z.string().max(300).optional(),
  prompt_hash: z.string().regex(/^[a-f0-9]{64}$/i).optional(),
  dedupe_key: z.string().regex(/^[a-f0-9]{32,64}$/i).optional(),
  owner_id: z.string().max(240).optional(),
  lease_seconds: z.number().int().min(60).max(7 * 24 * 60 * 60).optional(),
};

type TaskLaunchMetadata = {
  launch_kind?: string;
  prompt_surface?: string;
  task_type?: string;
  launch_source?: string;
  hook_run_id?: string;
  client_session_id?: string;
  prompt_hash?: string;
  dedupe_key?: string;
  owner_id?: string;
  lease_seconds?: number;
};

function sanitizeOptionalMetadata(value: string | undefined): string | undefined {
  if (!value) return value;
  const sanitized = redactSensitiveText(value);
  return sanitized.redactions.length > 0 ? `metadata:${sha256(value).slice(0, 32)}` : sanitized.text;
}

function sanitizeTaskLaunchMetadata(metadata: TaskLaunchMetadata): TaskLaunchMetadata {
  return {
    ...metadata,
    launch_kind: sanitizeOptionalMetadata(metadata.launch_kind),
    prompt_surface: sanitizeOptionalMetadata(metadata.prompt_surface),
    task_type: sanitizeOptionalMetadata(metadata.task_type),
    launch_source: sanitizeOptionalMetadata(metadata.launch_source),
    hook_run_id: sanitizeOptionalMetadata(metadata.hook_run_id),
    owner_id: sanitizeOptionalMetadata(metadata.owner_id),
  };
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function sanitizeTaskRequest(request: string): {
  request: string;
  request_hash: string;
  redactions: string[];
  truncated: boolean;
} {
  const redacted = redactSensitiveText(request);
  const maxChars = Math.max(200, Math.min(12_000, Number(process.env.DINOBRAIN_TASK_REQUEST_MAX_CHARS ?? 4_000)));
  const truncated = redacted.truncated || redacted.text.length > maxChars;
  return {
    request: truncated ? `${redacted.text.slice(0, maxChars)}\n[truncated by DinoBrain task guard]` : redacted.text,
    request_hash: sha256(request),
    redactions: redacted.redactions,
    truncated,
  };
}

function classifyTaskLaunch(request: string, metadata: TaskLaunchMetadata) {
  return classifyPromptLaunch({
    request,
    launchKind: metadata.launch_kind ?? "direct_mcp",
    surface: metadata.prompt_surface,
    taskType: metadata.task_type,
    source: metadata.launch_source,
    promptPresent: request.trim().length > 0,
  });
}

function taskLease(request: string, metadata: TaskLaunchMetadata, acquiredAt: string) {
  const leaseSeconds = metadata.lease_seconds ?? 24 * 60 * 60;
  const ownerId = firstString(
    metadata.owner_id,
    metadata.dedupe_key,
    metadata.hook_run_id,
    `mcp-${sha256(request).slice(0, 16)}`,
  );
  return {
    lease_id: makeUniqueId("lease", ownerId, 20),
    owner_id: ownerId,
    acquired_at: acquiredAt,
    heartbeat_at: acquiredAt,
    expires_at: new Date(Date.parse(acquiredAt) + leaseSeconds * 1000).toISOString(),
    lease_seconds: leaseSeconds,
    state: "active",
  };
}

function taskLaunchEvidence(
  request: string,
  metadata: TaskLaunchMetadata,
  eligibility: ReturnType<typeof classifyTaskLaunch>,
) {
  const derivedPromptHash = sha256(request);
  return {
    prompt_hash: derivedPromptHash,
    supplied_prompt_hash_matches: metadata.prompt_hash
      ? metadata.prompt_hash.toLowerCase() === derivedPromptHash
      : null,
    prompt_classification: eligibility.classification,
    prompt_eligibility_version: eligibility.version,
    prompt_eligibility_confidence: eligibility.confidence,
    prompt_eligibility_reasons: eligibility.reason_codes,
    launch_kind: metadata.launch_kind ?? "direct_mcp",
    prompt_surface: metadata.prompt_surface ?? null,
    task_type: metadata.task_type ?? null,
    launch_source: metadata.launch_source ?? null,
    hook_run_id: metadata.hook_run_id ?? null,
    client_session_hash: metadata.client_session_id ? sha256(metadata.client_session_id) : null,
    dedupe_key: metadata.dedupe_key ?? null,
  };
}

async function filteredTaskLaunch(request: string, metadata: TaskLaunchMetadata, toolName: string) {
  const eligibility = classifyTaskLaunch(request, metadata);
  if (eligibility.durable_task_eligible) return null;
  const at = nowIso();
  const promptHash = sha256(request);
  const eventLog = await appendEvent({
    event: "task_launch_filtered",
    source: toolName,
    at,
    prompt_hash: promptHash,
    prompt_classification: eligibility.classification,
    prompt_eligibility_version: eligibility.version,
    prompt_eligibility_reasons: eligibility.reason_codes,
    launch_kind: metadata.launch_kind ?? "direct_mcp",
    hook_run_id: metadata.hook_run_id ?? null,
    client_session_hash: metadata.client_session_id ? sha256(metadata.client_session_id) : null,
  });
  return {
    ok: true,
    skipped: true,
    durable_task_created: false,
    prompt_hash: promptHash,
    prompt_classification: eligibility.classification,
    prompt_eligibility: eligibility,
    event_log: eventLog,
    safe_action: "Do not create a durable task, Context Pack, session archive, candidate memory, or sync action for this launch.",
  };
}

type TaskStartDedupeClaim = {
  enabled: boolean;
  acquired: boolean;
  key: string | null;
  path: string | null;
  owner: string | null;
  response: Record<string, unknown> | null;
};

function hasStableTaskIdentity(metadata: TaskLaunchMetadata, request: string): boolean {
  return Boolean(
    metadata.dedupe_key &&
      metadata.hook_run_id &&
      metadata.client_session_id &&
      metadata.prompt_hash &&
      metadata.prompt_hash.toLowerCase() === sha256(request),
  );
}

async function claimTaskStart(metadata: TaskLaunchMetadata, request: string): Promise<TaskStartDedupeClaim> {
  if (!hasStableTaskIdentity(metadata, request)) {
    return { enabled: false, acquired: true, key: null, path: null, owner: null, response: null };
  }
  const key = metadata.dedupe_key!.toLowerCase();
  const receiptPath = dataPath(".dino", "tmp", "task-start-receipts", `${key}.json`);
  const owner = makeUniqueId("task-start-owner", key, 16);
  const deadline = Date.now() + 30_000;
  await ensureDir(path.dirname(receiptPath));
  while (Date.now() < deadline) {
    try {
      const handle = await fs.open(receiptPath, "wx");
      try {
        await handle.writeFile(
          `${JSON.stringify({
            version: "task_start_receipt_v1",
            status: "pending",
            key,
            owner,
            created_at: nowIso(),
            prompt_hash: sha256(request),
          }, null, 2)}\n`,
          "utf8",
        );
        await handle.sync();
      } finally {
        await handle.close();
      }
      return { enabled: true, acquired: true, key, path: receiptPath, owner, response: null };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const existing = await readJson<Record<string, unknown>>(receiptPath).catch(() => null);
      if (existing?.status === "completed" && existing.key === key && existing.response) {
        return {
          enabled: true,
          acquired: false,
          key,
          path: receiptPath,
          owner: firstString(existing.owner) || null,
          response: existing.response as Record<string, unknown>,
        };
      }
      const createdMs = Date.parse(firstString(existing?.created_at));
      if (Number.isFinite(createdMs) && Date.now() - createdMs > 60_000) {
        await fs.rm(receiptPath, { force: true });
        continue;
      }
      await new Promise((resolve) => setTimeout(resolve, 75));
    }
  }
  return { enabled: true, acquired: false, key, path: receiptPath, owner: null, response: null };
}

async function completeTaskStart(claim: TaskStartDedupeClaim, response: Record<string, unknown>): Promise<void> {
  if (!claim.enabled || !claim.acquired || !claim.path || !claim.key || !claim.owner) return;
  await atomicWriteJson(claim.path, {
    version: "task_start_receipt_v1",
    status: "completed",
    key: claim.key,
    owner: claim.owner,
    completed_at: nowIso(),
    response,
  });
  const receiptDir = path.dirname(claim.path);
  const entries = await fs.readdir(receiptDir, { withFileTypes: true });
  const receipts: Array<{ path: string; mtimeMs: number }> = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const receiptPath = path.join(receiptDir, entry.name);
    const stat = await fs.stat(receiptPath);
    receipts.push({ path: receiptPath, mtimeMs: stat.mtimeMs });
  }
  receipts.sort((a, b) => b.mtimeMs - a.mtimeMs);
  await Promise.all(receipts.slice(512).map((entry) => fs.rm(entry.path, { force: true })));
}

async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await atomicWriteJson(filePath, value);
}

async function readJson<T>(filePath: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function appendJsonLine(filePath: string, value: unknown): Promise<void> {
  await appendFileWithLock(filePath, `${JSON.stringify(value)}\n`);
}

async function appendEvent(value: Record<string, unknown>): Promise<string> {
  const eventPath = dataPath(".dino", "events", `${dateStamp()}.jsonl`);
  await appendJsonLine(eventPath, value);
  const relativePath = relDataPath(eventPath);
  await appendOperationEvent(DATA_ROOT, relativePath, value);
  await appendSqliteOperationEvent(DATA_ROOT, {
    ...value,
    event: typeof value.event === "string" ? value.event : "event",
    at: typeof value.at === "string" ? value.at : null,
    _path: relativePath,
  } as OperationEventEntry);
  return relativePath;
}

function firstString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return "";
}

function taskEntryFromRecord(taskPath: string, task: Record<string, unknown>): OperationTaskEntry {
  const taskId = firstString(task.task_id, path.basename(taskPath, ".json"));
  return {
    path: taskPath,
    task_id: taskId,
    status: firstString(task.status, "unknown"),
    request: firstString(task.request, taskId),
    project: typeof task.project === "string" ? task.project : null,
    sync_policy: typeof task.sync_policy === "string" ? task.sync_policy : null,
    trace_path: typeof task.trace_path === "string" ? task.trace_path : null,
    created_at: firstString(task.created_at),
    updated_at: firstString(task.updated_at, task.finished_at, task.created_at),
    finished_at: typeof task.finished_at === "string" ? task.finished_at : null,
  };
}

function traceEntryFromRecord(tracePath: string, trace: Record<string, unknown>): OperationTraceEntry {
  return {
    path: tracePath,
    task_id: firstString(trace.task_id, path.basename(tracePath, ".json")),
    outcome: firstString(trace.outcome, "unknown"),
    summary: firstString(trace.summary),
    finished_at: firstString(trace.finished_at),
    used_memory_paths: Array.isArray(trace.used_memory_paths) ? trace.used_memory_paths.map(String) : [],
    context_pack_paths: Array.isArray(trace.context_pack_paths) ? trace.context_pack_paths.map(String) : [],
    session_archive_paths: Array.isArray(trace.session_archive_paths) ? trace.session_archive_paths.map(String) : [],
    candidate_paths: Array.isArray(trace.candidate_paths) ? trace.candidate_paths.map(String) : [],
  };
}

function contextPackEntryFromRecord(packPath: string, pack: Record<string, unknown>): OperationContextPackEntry {
  const items = Array.isArray(pack.items) ? pack.items : [];
  return {
    path: packPath,
    pack_id: firstString(pack.pack_id, path.basename(packPath, ".json")),
    question: firstString(pack.question),
    created_at: firstString(pack.created_at),
    item_count: typeof pack.included_item_count === "number" ? pack.included_item_count : items.length,
    retrieval_mode: typeof pack.retrieval_mode === "string" ? pack.retrieval_mode : null,
    items: items
      .filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null && !Array.isArray(item))
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

function jsonResult(value: unknown): CallToolResult {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(value, null, 2),
      },
    ],
  };
}

function taskIdFromMemoryRecord(record: Record<string, unknown>): string {
  const source = record.source && typeof record.source === "object"
    ? record.source as Record<string, unknown>
    : null;
  return firstString(record.task_id, source?.task_id);
}

const NODE_LIFECYCLE_FIELDS = [
  "node_id",
  "lifecycle_version",
  "lifecycle_state",
  "lifecycle_state_entered_at",
  "lifecycle_last_transition_id",
  "lifecycle_history",
  "predecessor_paths",
  "successor_paths",
] as const;

function mergePreservingNodeLifecycle(
  existing: Record<string, unknown> | null,
  next: Record<string, unknown>,
): Record<string, unknown> {
  if (!existing) return next;
  const merged = { ...existing, ...next };
  for (const field of NODE_LIFECYCLE_FIELDS) {
    if (existing[field] !== undefined) merged[field] = existing[field];
  }
  if (typeof existing.created_at === "string") merged.created_at = existing.created_at;
  return merged;
}

function withoutNodeLifecycle(record: Record<string, unknown>): Record<string, unknown> {
  const result = { ...record };
  for (const field of NODE_LIFECYCLE_FIELDS) delete result[field];
  return result;
}

function combineLifecycleStages(
  stages: Array<{ write: LifecycleBatchWrite; mutation: { record: Record<string, unknown> } }>,
  expectedBeforeSha256?: string | null,
): LifecycleBatchWrite {
  const first = stages[0];
  const last = stages.at(-1);
  if (!first || !last) throw new Error("Lifecycle stage list cannot be empty");
  return {
    target_path: last.write.target_path,
    record: last.mutation.record,
    transitions: stages.flatMap((stage) => stage.write.transitions ?? []),
    ...(expectedBeforeSha256 !== undefined ? { expected_before_sha256: expectedBeforeSha256 } : {}),
  };
}

function transitionThroughLifecycleStates(
  targetPath: string,
  record: Record<string, unknown>,
  states: NodeLifecycleState[],
  input: Omit<LifecycleMutationInput, "target_path" | "to_state" | "idempotency_key"> & {
    idempotency_key: string;
  },
  expectedBeforeSha256?: string | null,
): LifecycleBatchWrite {
  const stages: Array<{ write: LifecycleBatchWrite; mutation: { record: Record<string, unknown> } }> = [];
  let current = record;
  for (const state of states) {
    const stage = transitionLifecycleWrite(targetPath, current, {
      ...input,
      to_state: state,
      idempotency_key: `${input.idempotency_key}|${state}`,
    });
    stages.push(stage);
    current = stage.mutation.record;
  }
  return combineLifecycleStages(stages, expectedBeforeSha256);
}

async function upsertLifecycleStateWrite(
  targetPath: string,
  record: Record<string, unknown>,
  state: NodeLifecycleState,
  input: Omit<LifecycleMutationInput, "target_path" | "to_state" | "idempotency_key"> & {
    idempotency_key: string;
  },
): Promise<LifecycleBatchWrite> {
  try {
    const existing = await currentNodeRecord(DATA_ROOT, targetPath);
    const merged = mergePreservingNodeLifecycle(existing.record, record);
    return transitionThroughLifecycleStates(targetPath, merged, [state], input, existing.sha256);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return initializeLifecycleWrite(targetPath, record, {
      ...input,
      to_state: state,
      idempotency_key: `${input.idempotency_key}|${state}`,
    }).write;
  }
}

function safeError(error: unknown): string {
  return String((error as Error | undefined)?.message ?? error).replace(/\s+/g, " ").slice(0, 500);
}

type SyncClassification = "syncable" | "conditional" | "blocked";

type SensitivityHit = {
  pattern: string;
  line: number;
};

type SyncFileReport = {
  status: string;
  path: string;
  classification: SyncClassification;
  policy: string;
  reasons: string[];
  action: "ready_for_manual_commit" | "requires_review" | "do_not_sync" | "ready_for_auto_commit";
  sensitivity_scan: {
    enabled: boolean;
    scanned: boolean;
    complete: boolean;
  };
  sensitive_patterns: SensitivityHit[];
  classifier: Pick<
    DataFileClassification,
    "policy_version" | "path_classification" | "explicit_allowlist" | "findings" | "scan"
  >;
};

type SyncPlan = {
  ok: boolean;
  dry_run: boolean;
  data_root: string;
  observed_changed_file_count: number;
  changed_file_count: number;
  out_of_scope_changed_count: number;
  out_of_scope_changed_paths: Array<{ path: string; status: string }>;
  would_commit: boolean;
  would_push: boolean;
  manual_approval_required: boolean;
  commit_allowed_by_tool: boolean;
  policy_version: string;
  files: SyncFileReport[];
  summary: {
    syncable: number;
    conditional: number;
    blocked: number;
    ready_for_manual_commit: number;
    requires_review: number;
    do_not_sync: number;
    ready_for_auto_commit: number;
  };
};

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function compoundingSyncPaths(value: Record<string, unknown> | null): string[] {
  if (!value) return [];
  const paths = stringList([
    value.cycle_path,
    value.behavior_rule_index_path,
    value.controlled_compounding_status_path,
    value.public_summary_path,
    value.event_log,
  ]);
  for (const promotion of Array.isArray(value.promotions) ? value.promotions : []) {
    if (typeof promotion !== "object" || promotion === null) continue;
    const record = promotion as Record<string, unknown>;
    paths.push(...stringList([record.path, record.review_path, record.accepted_path]));
  }
  for (const action of Array.isArray(value.cleanup_actions) ? value.cleanup_actions : []) {
    if (typeof action !== "object" || action === null) continue;
    const record = action as Record<string, unknown>;
    paths.push(...stringList([record.target_path, record.kept_path, record.archive_path]));
  }
  return Array.from(new Set(paths.filter(Boolean)));
}

async function buildSyncPlan(options: {
  includeSensitiveScan: boolean;
  allowConditionalAutoSync?: boolean;
  dryRun: boolean;
  wouldPush?: boolean;
  candidatePaths?: Set<string>;
  scopeEntries?: Map<string, TaskSyncScopeEntry>;
}): Promise<SyncPlan> {
  let stdout = "";
  try {
    const result = await execFileAsync("git", ["status", "--porcelain=v1", "--untracked-files=all"], {
      cwd: DATA_ROOT,
      windowsHide: true,
    });
    stdout = result.stdout;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return {
      ok: false,
      unavailable: true,
      reason: code === "ENOENT" ? "git_missing" : "data_root_not_git_repository",
      dry_run: options.dryRun,
      data_root: DATA_ROOT,
      observed_changed_file_count: 0,
      changed_file_count: 0,
      out_of_scope_changed_count: 0,
      out_of_scope_changed_paths: [],
      would_commit: false,
      would_push: false,
      manual_approval_required: options.dryRun,
      commit_allowed_by_tool: false,
      policy_version: DATA_CLASSIFICATION_POLICY_VERSION,
      files: [],
      summary: {
        syncable: 0,
        conditional: 0,
        blocked: 0,
        ready_for_manual_commit: 0,
        requires_review: 0,
        do_not_sync: 0,
        ready_for_auto_commit: 0,
      },
    } as SyncPlan & { unavailable: true; reason: string };
  }

  const observedChanges = parseGitStatus(stdout);
  const changes = options.candidatePaths
    ? observedChanges.filter((change) => options.candidatePaths?.has(change.path))
    : observedChanges;
  const outOfScopeChanges = options.candidatePaths
    ? observedChanges.filter((change) => !options.candidatePaths?.has(change.path))
    : [];
  const files: SyncFileReport[] = [];
  for (const change of changes) {
    const deleted = change.status.includes("D");
    const classification = await classifyDataFileAtPath({
      root: DATA_ROOT,
      relativePath: change.path,
      deleted,
      scanContent: options.includeSensitiveScan,
    });
    const hits = classification.findings
      .filter((finding) => finding.category === "secret")
      .map((finding) => ({ pattern: finding.id, line: finding.line ?? 0 }));
    const file: SyncFileReport = {
      ...change,
      classification: classification.classification,
      policy: classification.policy,
      reasons: classification.reasons,
      action:
        classification.classification === "syncable"
          ? "ready_for_manual_commit"
          : classification.classification === "conditional"
            ? "requires_review"
            : "do_not_sync",
      sensitivity_scan: {
        enabled: options.includeSensitiveScan,
        scanned: classification.scan.deleted || classification.scan.decode_status === "utf8",
        complete: classification.scan.complete,
      },
      sensitive_patterns: hits,
      classifier: {
        policy_version: classification.policy_version,
        path_classification: classification.path_classification,
        explicit_allowlist: classification.explicit_allowlist,
        findings: classification.findings,
        scan: classification.scan,
      },
    };
    if (
      !options.dryRun &&
      isAutoSyncAllowed(file, options.allowConditionalAutoSync === true, options.scopeEntries?.get(file.path))
    ) {
      file.action = "ready_for_auto_commit";
    }
    files.push(file);
  }

  const summary = {
    syncable: files.filter((file) => file.classification === "syncable").length,
    conditional: files.filter((file) => file.classification === "conditional").length,
    blocked: files.filter((file) => file.classification === "blocked").length,
    ready_for_manual_commit: files.filter((file) => file.action === "ready_for_manual_commit").length,
    requires_review: files.filter((file) => file.action === "requires_review").length,
    do_not_sync: files.filter((file) => file.action === "do_not_sync").length,
    ready_for_auto_commit: files.filter((file) => file.action === "ready_for_auto_commit").length,
  };

  return {
    ok: true,
    dry_run: options.dryRun,
    data_root: DATA_ROOT,
    observed_changed_file_count: observedChanges.length,
    changed_file_count: files.length,
    out_of_scope_changed_count: outOfScopeChanges.length,
    out_of_scope_changed_paths: outOfScopeChanges.slice(0, 100).map((change) => ({ path: change.path, status: change.status })),
    would_commit: !options.dryRun && summary.ready_for_auto_commit > 0,
    would_push: !options.dryRun && options.wouldPush === true && summary.ready_for_auto_commit > 0,
    manual_approval_required: options.dryRun,
    commit_allowed_by_tool: !options.dryRun,
    policy_version: DATA_CLASSIFICATION_POLICY_VERSION,
    files,
    summary,
  };
}

async function observeGateSyncRisk(
  request: string,
  options: { taskId?: string; allowedPaths?: string[]; allowConditional?: boolean } = {},
): Promise<SyncRiskObservation> {
  const intent = detectRequestActionIntent(request);
  if (!intent.data_sync) {
    return {
      status: "not_requested",
      changed_file_count: 0,
      syncable_count: 0,
      conditional_count: 0,
      blocked_count: 0,
      reason_codes: [],
    };
  }

  try {
    if (options.taskId && Array.isArray(options.allowedPaths) && options.allowedPaths.length > 0) {
      const scopeResolution = await resolveTaskSyncScope({
        dataRoot: DATA_ROOT,
        taskId: options.taskId,
        requestedPaths: options.allowedPaths,
      });
      if (!scopeResolution.ok) {
        return {
          status: "blocked",
          scope: "task_scope",
          task_id: options.taskId,
          changed_file_count: 0,
          requested_path_count: scopeResolution.requested_path_count,
          selected_path_count: scopeResolution.selected_path_count,
          out_of_scope_changed_count: 0,
          syncable_count: 0,
          conditional_count: 0,
          blocked_count: Math.max(1, scopeResolution.rejected_paths.length),
          reason_codes: scopeResolution.reason_codes,
        };
      }
      const scopeEntries = new Map(scopeResolution.entries.map((entry) => [entry.path, entry]));
      const plan = await buildSyncPlan({
        includeSensitiveScan: true,
        allowConditionalAutoSync: options.allowConditional === true,
        dryRun: false,
        wouldPush: false,
        candidatePaths: new Set(scopeEntries.keys()),
        scopeEntries,
      });
      if (!plan.ok) {
        return {
          status: "unavailable",
          scope: "task_scope",
          task_id: options.taskId,
          changed_file_count: 0,
          requested_path_count: scopeResolution.requested_path_count,
          selected_path_count: scopeResolution.selected_path_count,
          out_of_scope_changed_count: 0,
          syncable_count: 0,
          conditional_count: 0,
          blocked_count: 0,
          reason_codes: ["task_scoped_sync_plan_unavailable"],
        };
      }
      const unresolved = plan.files.filter(
        (file) => !isAutoSyncAllowed(file, options.allowConditional === true, scopeEntries.get(file.path)),
      );
      const blockedCount = unresolved.filter((file) => file.classification === "blocked").length;
      const reviewCount = unresolved.filter((file) => file.classification === "conditional").length;
      return {
        status: blockedCount > 0 ? "blocked" : reviewCount > 0 ? "review_required" : "clean",
        scope: "task_scope",
        task_id: options.taskId,
        changed_file_count: plan.changed_file_count,
        requested_path_count: scopeResolution.requested_path_count,
        selected_path_count: scopeResolution.selected_path_count,
        out_of_scope_changed_count: plan.out_of_scope_changed_count,
        syncable_count: plan.summary.syncable,
        conditional_count: plan.summary.conditional,
        blocked_count: blockedCount,
        reason_codes: Array.from(new Set(unresolved.flatMap((file) => file.reasons))).slice(0, 24),
      };
    }
    const plan = await buildSyncPlan({
      includeSensitiveScan: true,
      dryRun: true,
      wouldPush: false,
    });
    if (!plan.ok) {
      return {
        status: "unavailable",
        scope: "repository",
        changed_file_count: 0,
        syncable_count: 0,
        conditional_count: 0,
        blocked_count: 0,
        reason_codes: ["git_sync_plan_unavailable"],
      };
    }
    const status = plan.summary.blocked > 0
      ? "blocked"
      : plan.summary.conditional > 0
        ? "review_required"
        : "clean";
    return {
      status,
      scope: "repository",
      changed_file_count: plan.changed_file_count,
      syncable_count: plan.summary.syncable,
      conditional_count: plan.summary.conditional,
      blocked_count: plan.summary.blocked,
      reason_codes: Array.from(
        new Set(
          plan.files
            .filter((file) => file.classification !== "syncable")
            .flatMap((file) => file.reasons)
            .slice(0, 24),
        ),
      ),
    };
  } catch (error) {
    return {
      status: "unavailable",
      scope: options.taskId && options.allowedPaths?.length ? "task_scope" : "repository",
      task_id: options.taskId ?? null,
      changed_file_count: 0,
      syncable_count: 0,
      conditional_count: 0,
      blocked_count: 0,
      reason_codes: [`git_sync_observation_failed:${safeError(error)}`],
    };
  }
}

async function gitOutput(args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, {
    cwd: DATA_ROOT,
    windowsHide: true,
    maxBuffer: 1024 * 1024 * 8,
  });
  return result.stdout.trim();
}

async function gitRun(args: string[]): Promise<void> {
  await execFileAsync("git", args, {
    cwd: DATA_ROOT,
    windowsHide: true,
    maxBuffer: 1024 * 1024 * 8,
  });
}

async function hasStagedChanges(): Promise<boolean> {
  try {
    await gitRun(["diff", "--cached", "--quiet"]);
    return false;
  } catch {
    return true;
  }
}

async function runDataAutoSyncUnlocked(options: {
  taskId: string;
  includeSensitiveScan: boolean;
  allowConditional: boolean;
  push: boolean;
  commitMessage: string;
  allowedPaths: string[];
}): Promise<Record<string, unknown>> {
  const scopeResolution = await resolveTaskSyncScope({
    dataRoot: DATA_ROOT,
    taskId: options.taskId,
    requestedPaths: options.allowedPaths,
  });
  if (!scopeResolution.ok) {
    return {
      ok: false,
      state: "blocked",
      committed: false,
      pushed: false,
      reason: "task_sync_scope_blocked",
      task_id: options.taskId,
      scope_version: TASK_SYNC_SCOPE_VERSION,
      scope: scopeResolution,
    };
  }

  const scopeEntries = new Map(scopeResolution.entries.map((entry) => [entry.path, entry]));
  const scopedPathSet = new Set(scopeEntries.keys());
  const plan = await buildSyncPlan({
    includeSensitiveScan: options.includeSensitiveScan,
    allowConditionalAutoSync: options.allowConditional,
    dryRun: false,
    wouldPush: options.push,
    candidatePaths: scopedPathSet,
    scopeEntries,
  });
  if (!plan.ok) {
    return {
      ...plan,
      ok: false,
      state: "retry_required",
      committed: false,
      pushed: false,
      reason: "task_scoped_sync_plan_unavailable",
      task_id: options.taskId,
      scope_version: TASK_SYNC_SCOPE_VERSION,
      scope_path: scopeResolution.scope_path,
    };
  }

  const unresolvedPaths = plan.files
    .filter((file) => !isAutoSyncAllowed(file, options.allowConditional, scopeEntries.get(file.path)))
    .map((file) => ({ path: file.path, classification: file.classification, policy: file.policy }));
  if (unresolvedPaths.length > 0) {
    return {
      ...plan,
      ok: false,
      state: "blocked",
      committed: false,
      pushed: false,
      reason: "unresolved_conditional_or_blocked_paths",
      task_id: options.taskId,
      scope_version: TASK_SYNC_SCOPE_VERSION,
      scope_path: scopeResolution.scope_path,
      requested_path_count: scopeResolution.requested_path_count,
      scoped_path_count: scopeResolution.selected_path_count,
      unresolved_paths: unresolvedPaths,
    };
  }

  if (plan.files.length === 0) {
    return {
      ...plan,
      ok: true,
      state: "no_op",
      committed: false,
      pushed: false,
      reason: "no_task_scoped_changes",
      task_id: options.taskId,
      scope_version: TASK_SYNC_SCOPE_VERSION,
      scope_path: scopeResolution.scope_path,
      requested_path_count: scopeResolution.requested_path_count,
      scoped_path_count: scopeResolution.selected_path_count,
    };
  }

  const allowedPaths = plan.files.map((file) => file.path);

  const stagedBefore = (await gitOutput(["diff", "--cached", "--name-only"])).split(/\r?\n/).filter(Boolean);
  const allowedSet = new Set(allowedPaths);
  const disallowedStaged = stagedBefore.filter((stagedPath) => !allowedSet.has(stagedPath.replace(/\\/g, "/")));
  if (stagedBefore.length > 0) {
    return {
      ...plan,
      ok: false,
      state: "blocked",
      committed: false,
      pushed: false,
      blocked: true,
      reason: "disallowed_files_already_staged",
      disallowed_staged_paths: disallowedStaged.length > 0 ? disallowedStaged : stagedBefore,
      task_id: options.taskId,
      scope_version: TASK_SYNC_SCOPE_VERSION,
      scope_path: scopeResolution.scope_path,
      scoped_path_count: scopeResolution.selected_path_count,
    };
  }

  let createdCommit = "";
  let createdBranch = "";
  let generatedReceiptPath = "";
  let generatedReceipt: Record<string, unknown> | null = null;
  let retryStage: "stage" | "commit" | "push" = "stage";
  try {
    await gitRun(["add", "--", ...allowedPaths]);
    const stagedIdentityMismatches: Array<{ path: string; expected: string | null; observed: string | null }> = [];
    for (const allowedPath of allowedPaths) {
      const entry = scopeEntries.get(allowedPath);
      let observed: string | null = null;
      try {
        observed = (await gitOutput(["rev-parse", `:${allowedPath}`])).toLowerCase();
      } catch {
        observed = null;
      }
      if (!entry?.git_blob_oid || observed !== entry.git_blob_oid) {
        stagedIdentityMismatches.push({
          path: allowedPath,
          expected: entry?.git_blob_oid ?? null,
          observed,
        });
      }
    }
    if (stagedIdentityMismatches.length > 0) {
      await gitRun(["reset", "--", ...allowedPaths]);
      return {
        ...plan,
        ok: false,
        state: "blocked",
        committed: false,
        pushed: false,
        reason: "staged_blob_identity_mismatch",
        staged_identity_mismatches: stagedIdentityMismatches,
        task_id: options.taskId,
        scope_version: TASK_SYNC_SCOPE_VERSION,
        scope_path: scopeResolution.scope_path,
        allowed_paths: allowedPaths,
      };
    }
    if (!(await hasStagedChanges())) {
      return {
        ...plan,
        ok: true,
        state: "no_op",
        committed: false,
        pushed: false,
        reason: "no_staged_changes_after_task_scope_add",
        task_id: options.taskId,
        scope_version: TASK_SYNC_SCOPE_VERSION,
        scope_path: scopeResolution.scope_path,
        allowed_paths: allowedPaths,
        scoped_path_count: scopeResolution.selected_path_count,
      };
    }

    const baseMessage = options.commitMessage.trim() || `data: task-scoped sync ${safeSlug(options.taskId).slice(0, 48)}`;
    const conditionalFiles = plan.files.filter((file) => file.classification === "conditional");
    let message = baseMessage;
    if (conditionalFiles.length > 0) {
      if (!scopeResolution.task_path || !scopeResolution.scope_sha256 || !scopeResolution.scope_revision) {
        await gitRun(["reset", "--", ...allowedPaths]);
        return {
          ...plan,
          ok: false,
          state: "blocked",
          committed: false,
          pushed: false,
          reason: "public_sync_receipt_scope_evidence_missing",
          task_id: options.taskId,
          scope_version: TASK_SYNC_SCOPE_VERSION,
          scope_path: scopeResolution.scope_path,
          allowed_paths: allowedPaths,
        };
      }
      if (!allowedSet.has(scopeResolution.task_path)) {
        await gitRun(["reset", "--", ...allowedPaths]);
        return {
          ...plan,
          ok: false,
          state: "blocked",
          committed: false,
          pushed: false,
          reason: "conditional_sync_requires_task_record",
          required_task_path: scopeResolution.task_path,
          task_id: options.taskId,
          scope_version: TASK_SYNC_SCOPE_VERSION,
          scope_path: scopeResolution.scope_path,
          allowed_paths: allowedPaths,
        };
      }
      const baseCommit = await gitOutput(["rev-parse", "HEAD"]);
      const receipt = await writePublicSyncReceipt({
        dataRoot: DATA_ROOT,
        taskId: options.taskId,
        taskPath: scopeResolution.task_path,
        baseCommit,
        classifierPolicyVersion: DATA_CLASSIFICATION_POLICY_VERSION,
        scopeVersion: TASK_SYNC_SCOPE_VERSION,
        scopeRevision: scopeResolution.scope_revision,
        scopeSha256: scopeResolution.scope_sha256,
        entries: plan.files.map((file) => ({
          scope: scopeEntries.get(file.path)!,
          classification: file.classification as "syncable" | "conditional",
          policy: file.policy,
        })),
      });
      generatedReceiptPath = receipt.receipt_path;
      const receiptClassification = await classifyDataFileAtPath({
        root: DATA_ROOT,
        relativePath: generatedReceiptPath,
        scanContent: true,
      });
      if (
        receiptClassification.classification !== "syncable" ||
        !receiptClassification.scan.complete ||
        receiptClassification.findings.length > 0
      ) {
        await fs.rm(dataPath(generatedReceiptPath), { force: true });
        await gitRun(["reset", "--", ...allowedPaths]);
        return {
          ...plan,
          ok: false,
          state: "blocked",
          committed: false,
          pushed: false,
          reason: "public_sync_receipt_classification_failed",
          receipt_classification: receiptClassification,
          task_id: options.taskId,
          scope_version: TASK_SYNC_SCOPE_VERSION,
          scope_path: scopeResolution.scope_path,
          allowed_paths: allowedPaths,
        };
      }
      await gitRun(["add", "--", generatedReceiptPath]);
      const observedReceiptBlob = (await gitOutput(["rev-parse", `:${generatedReceiptPath}`])).toLowerCase();
      if (observedReceiptBlob !== receipt.receipt_git_blob_oid) {
        await gitRun(["reset", "--", generatedReceiptPath, ...allowedPaths]);
        await fs.rm(dataPath(generatedReceiptPath), { force: true });
        return {
          ...plan,
          ok: false,
          state: "blocked",
          committed: false,
          pushed: false,
          reason: "public_sync_receipt_staged_identity_mismatch",
          task_id: options.taskId,
          scope_version: TASK_SYNC_SCOPE_VERSION,
          scope_path: scopeResolution.scope_path,
          allowed_paths: allowedPaths,
        };
      }
      message = publicSyncReceiptCommitMessage({
        message: baseMessage,
        taskId: options.taskId,
        receiptPath: generatedReceiptPath,
        receiptSha256: receipt.receipt_sha256,
        receiptGitBlobOid: receipt.receipt_git_blob_oid,
      });
      generatedReceipt = {
        path: generatedReceiptPath,
        receipt_id: receipt.receipt.receipt_id,
        sha256: receipt.receipt_sha256,
        git_blob_oid: receipt.receipt_git_blob_oid,
        conditional_path_count: receipt.receipt.conditional_paths.length,
      };
    }
    retryStage = "commit";
    await gitRun(["commit", "-m", message]);
    createdCommit = await gitOutput(["rev-parse", "HEAD"]);
    createdBranch = await gitOutput(["rev-parse", "--abbrev-ref", "HEAD"]);
    let pushed = false;
    let remote = "";
    if (options.push) {
      retryStage = "push";
      remote = await gitOutput(["remote", "get-url", "origin"]);
      await gitRun(["push", "origin", createdBranch]);
      pushed = true;
    }

    return {
      ...plan,
      ok: true,
      state: pushed ? "pushed" : "committed",
      committed: true,
      pushed,
      commit: createdCommit,
      branch: createdBranch,
      remote: remote || null,
      task_id: options.taskId,
      scope_version: TASK_SYNC_SCOPE_VERSION,
      scope_path: scopeResolution.scope_path,
      allowed_paths: allowedPaths,
      public_sync_receipt: generatedReceipt,
      sync_scope: "task_scope",
      scoped_path_count: scopeResolution.selected_path_count,
    };
  } catch (error) {
    if (!createdCommit && (retryStage === "stage" || retryStage === "commit")) {
      const resetPaths = generatedReceiptPath ? [generatedReceiptPath, ...allowedPaths] : allowedPaths;
      await gitRun(["reset", "--", ...resetPaths]).catch(() => undefined);
      if (generatedReceiptPath) await fs.rm(dataPath(generatedReceiptPath), { force: true }).catch(() => undefined);
    }
    return {
      ...plan,
      ok: false,
      state: "retry_required",
      committed: Boolean(createdCommit),
      pushed: false,
      reason: retryStage === "push" ? "push_failed_after_commit" : "git_operation_failed",
      retry_stage: retryStage,
      error: safeError(error),
      commit: createdCommit || null,
      branch: createdBranch || null,
      task_id: options.taskId,
      scope_version: TASK_SYNC_SCOPE_VERSION,
      scope_path: scopeResolution.scope_path,
      allowed_paths: allowedPaths,
      public_sync_receipt: generatedReceipt,
      sync_scope: "task_scope",
      scoped_path_count: scopeResolution.selected_path_count,
    };
  }
}

async function runDataAutoSync(options: {
  taskId: string;
  includeSensitiveScan: boolean;
  allowConditional: boolean;
  push: boolean;
  commitMessage: string;
  allowedPaths: string[];
}): Promise<Record<string, unknown>> {
  return withFileLock(
    dataPath(".dino", "locks", "auto-sync-git.lock"),
    () => runDataAutoSyncUnlocked(options),
    { timeoutMs: 60_000, staleMs: 10 * 60_000 },
  );
}

function isAutoSyncConditionalPath(normalizedPath: string): boolean {
  const allowedPrefixes = [
    ".dino/audits/",
    ".dino/context-packs/",
    ".dino/evaluations/",
    ".dino/gates/",
    ".dino/lifecycle/",
    ".dino/provenance/",
    ".dino/proofs/",
    ".dino/quarantine/",
    ".dino/tasks/",
    ".dino/traces/",
    ".dino/compounding/",
    "50_Instances/candidates/",
    "80_Review_Queue/",
  ];
  return allowedPrefixes.some((prefix) => normalizedPath.startsWith(prefix));
}

function isAutoSyncAllowed(
  file: SyncFileReport,
  allowConditional: boolean,
  scopeEntry?: TaskSyncScopeEntry,
): boolean {
  if (file.classification === "blocked" || file.sensitive_patterns.length > 0) return false;
  if (!scopeEntry || scopeEntry.approval === "pending_review") return false;
  if (file.classification === "syncable") return true;
  return allowConditional && file.classification === "conditional" && isAutoSyncConditionalPath(file.path);
}

function redactSensitiveText(value: string): { text: string; redactions: string[]; truncated: boolean } {
  const redactions: string[] = [];
  let text = value.replace(/\r\n/g, "\n");

  text = text.replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, () => {
    redactions.push("private_key_block");
    return "[REDACTED_PRIVATE_KEY]";
  });
  text = text.replace(/\bsk-[A-Za-z0-9_-]{20,}\b/g, () => {
    redactions.push("openai_key_shape");
    return "[REDACTED_OPENAI_KEY]";
  });
  text = text.replace(/\b(?:github_pat_[A-Za-z0-9_]{20,}|(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{20,})\b/g, () => {
    redactions.push("github_token_shape");
    return "[REDACTED_GITHUB_TOKEN]";
  });
  text = text.replace(/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, () => {
    redactions.push("aws_access_key_shape");
    return "[REDACTED_AWS_ACCESS_KEY]";
  });
  text = text.replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, () => {
    redactions.push("jwt_shape");
    return "[REDACTED_JWT]";
  });
  text = text.replace(/\bBearer\s+[A-Za-z0-9._-]{12,}\b/gi, () => {
    redactions.push("bearer_token");
    return "Bearer [REDACTED_TOKEN]";
  });
  text = text.replace(/\b(api[_-]?key|secret|token|password|session[_-]?id|session[_-]?token|cookie)\s*[:=]\s*(['"]?)([^\s"',;]+)/gi, (_match, key) => {
    redactions.push(`${String(key).toLowerCase()}_assignment`);
    return `${key}: [REDACTED]`;
  });

  const machineLocal = redactMachineLocalPaths(text);
  text = machineLocal.text;
  redactions.push(...machineLocal.redactions);

  const maxChars = Math.max(2000, Math.min(128000, Number(process.env.DINOBRAIN_SOURCE_CHUNK_MAX_CHARS ?? 24000)));
  const truncated = text.length > maxChars;
  if (truncated) text = `${text.slice(0, maxChars)}\n[truncated by DinoBrain source chunk guard]`;

  return {
    text,
    redactions: Array.from(new Set(redactions)),
    truncated,
  };
}

function parseGitStatus(stdout: string): Array<{ status: string; path: string }> {
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .map((line) => {
      const status = line.slice(0, 2);
      const rawPath = line.slice(3);
      const normalized = rawPath.includes(" -> ") ? rawPath.split(" -> ").pop() ?? rawPath : rawPath;
      return { status, path: normalized.replace(/\\/g, "/").replace(/^"|"$/g, "") };
    });
}

function makeGateId(taskId: string): string {
  return makeUniqueId("gate", taskId, 36);
}

type GateContextEvidence = {
  hasContextPack: boolean;
  contextItemCount: number;
  contextPackPath: string | null;
  contextPackId: string | null;
  contextTraceSha256: string | null;
  contextCreatedAt: string | null;
  contextAgeMs: number | null;
  contextTraceVerified: boolean;
  contextTraceFresh: boolean;
  eventOrderVerified: boolean;
  eventOrder: string[];
  hookRunId: string | null;
  promptHash: string | null;
  verificationStatus: "verified" | "missing" | "not_provided" | "invalid" | "stale" | "unbound";
  declaredHasContextPack: boolean;
  declaredContextItemCount: number;
  declarationMismatch: boolean;
  reasonCodes: string[];
};

type TaskPreflightEvidence = {
  contextPackPath: string | null;
  contextTraceSha256: string | null;
  hookRunId: string | null;
  promptHash: string | null;
  eventOrderVerified: boolean;
  eventOrder: string[];
  reasonCodes: string[];
};

function makeSourceChunkId(sourceTitle: string, sourceUri: string): string {
  return `sourcechunk-${sha256(`${sourceTitle}\n${sourceUri}`).slice(0, 40)}`;
}

function makeFeedbackId(feedback: string): string {
  return makeUniqueId("feedback", feedback, 36);
}

async function writeFinishGrowthRecords(params: {
  taskId: string;
  taskRecord: Record<string, unknown>;
  tracePath: string;
  trace: Record<string, unknown>;
  finishedAt: string;
}): Promise<Record<string, unknown>> {
  if (!envFlag("DINOBRAIN_AUTO_GROWTH", false)) {
    return {
      ok: true,
      enabled: false,
      reason: "DINOBRAIN_AUTO_GROWTH disabled",
      created_paths: [],
    };
  }

  const summary = firstString(params.trace.summary);
  if (!summary) {
    return {
      ok: false,
      enabled: true,
      reason: "finish_trace_has_no_summary",
      created_paths: [],
    };
  }

  const request = firstString(params.taskRecord.request, params.taskId);
  const project = typeof params.taskRecord.project === "string" ? params.taskRecord.project : null;
  const outcome = firstString(params.trace.outcome, "completed");
  const growthId = `task-memory-${safeSlug(params.taskId)}`;
  const operationPath = dataPath("60_Operations", "task-summaries", `${growthId}.json`);
  const candidatePath = dataPath("50_Instances", "candidates", `${growthId}.json`);
  const reviewPath = dataPath("80_Review_Queue", "promotion", `${growthId}.json`);
  const decisions = Array.isArray(params.trace.decisions) ? params.trace.decisions.map(String) : [];
  const nextSteps = Array.isArray(params.trace.next_steps) ? params.trace.next_steps.map(String) : [];
  const usedMemoryPaths = Array.isArray(params.trace.used_memory_paths) ? params.trace.used_memory_paths.map(String) : [];
  const contextPackPaths = Array.isArray(params.trace.context_pack_paths)
    ? params.trace.context_pack_paths.map(String)
    : [];
  const tags = Array.from(
    new Set(
      [
        "auto-growth",
        "task-outcome",
        `outcome:${safeSlug(outcome).toLowerCase()}`,
        project ? `project:${safeSlug(project).toLowerCase()}` : null,
      ].filter((tag): tag is string => typeof tag === "string"),
    ),
  );
  const source = {
    trace_path: params.tracePath,
    task_id: params.taskId,
    task_path: `.dino/tasks/${safeSlug(params.taskId)}.json`,
  };
  const operationRecord = {
    memory_id: growthId,
    type: "task_summary_memory",
    status: "pending_review",
    title: `Task outcome: ${request.slice(0, 96)}`,
    summary,
    claim: `Task outcome for ${project ?? "DinoBrain"}: ${summary.slice(0, 600)}`,
    request,
    outcome,
    decisions,
    next_steps: nextSteps,
    used_memory_paths: usedMemoryPaths,
    context_pack_paths: contextPackPaths,
    evidence: {
      source: params.tracePath,
      snippet: summary.slice(0, 900),
    },
    source_status: "internal",
    confidence: outcome === "completed" ? "medium" : "low",
    last_verified: dateStamp(),
    tags,
    auto_generated: true,
    created_at: params.finishedAt,
    updated_at: params.finishedAt,
    source,
  };
  const candidateRecord = {
    ...operationRecord,
    status: "pending_review",
    source_operation_path: relDataPath(operationPath),
    candidate_id: growthId,
    sensitivity: firstString(params.taskRecord.sensitivity, "unknown"),
    auto_promote: false,
    promotion_blockers: ["manual_review_required", "auto_generated_task_memory"],
  };
  const reviewRecord = {
    review_id: growthId,
    type: "promotion",
    status: "pending",
    candidate_path: relDataPath(candidatePath),
    source_operation_path: relDataPath(operationPath),
    required_checks: ["evidence_snippet", "confidence", "last_verified", "sensitivity", "scope"],
    promotion_blockers: ["manual_review_required", "auto_generated_task_memory"],
    created_at: params.finishedAt,
    updated_at: params.finishedAt,
  };

  const candidateRelativePath = relDataPath(candidatePath);
  const reviewRelativePath = relDataPath(reviewPath);
  const operationRelativePath = relDataPath(operationPath);
  const reviewAdmission = await writeReviewGatedBatch(DATA_ROOT, {
    items: [
      {
        idempotency_key: `task-growth|${growthId}`,
        lane: "manual_semantic",
        candidate_path: candidateRelativePath,
        candidate_record: candidateRecord,
        review_path: reviewRelativePath,
        review_record: reviewRecord,
        candidate_evidence_paths: [params.tracePath, operationRelativePath],
        review_evidence_paths: [candidateRelativePath, params.tracePath, operationRelativePath],
        predecessor_paths: [params.tracePath],
        at: params.finishedAt,
      },
    ],
    extra_writes: [{ target_path: operationRelativePath, record: operationRecord }],
    actor: "finish_task:auto_growth",
    reason: `Create bounded task memory candidate ${growthId}.`,
  });
  await invalidateWikiIndex(DATA_ROOT);
  await invalidateSqliteWikiShard(DATA_ROOT);
  const eventLog = await appendEvent({
    event: "auto_growth_records_created",
    task_id: params.taskId,
    at: params.finishedAt,
    operation_path: relDataPath(operationPath),
    candidate_path: relDataPath(candidatePath),
    review_path: relDataPath(reviewPath),
    os_version: DINOBRAIN_OS_VERSION,
  });

  return {
    ok: true,
    enabled: true,
    memory_id: growthId,
    destination: reviewAdmission.decisions[0]?.destination ?? "cold_hold",
    created_paths: [relDataPath(operationPath), relDataPath(candidatePath), relDataPath(reviewPath)],
    operation_path: relDataPath(operationPath),
    candidate_path: relDataPath(candidatePath),
    review_path: relDataPath(reviewPath),
    queue_admission: reviewAdmission.decisions[0],
    lifecycle_transaction: reviewAdmission.lifecycle_transaction,
    event_log: eventLog,
  };
}

async function runCompoundingCycleWithIndexRefresh(options: {
  apply: boolean;
  reviewer: string;
  traceLimit: number;
  rollbackCyclePath?: string;
  reapplyCyclePath?: string;
}): Promise<Record<string, unknown>> {
  const report = await runCompoundingCycle(DATA_ROOT, {
    apply: options.apply,
    reviewer: options.reviewer,
    traceLimit: options.traceLimit,
    rollbackCyclePath: options.rollbackCyclePath,
    reapplyCyclePath: options.reapplyCyclePath,
  });
  if (report.changed === true) {
    await invalidateWikiIndex(DATA_ROOT);
    await invalidateSqliteWikiShard(DATA_ROOT);
  }
  const eventLog = await appendEvent({
    event: "compounding_cycle_completed",
    at: nowIso(),
    apply: options.apply,
    reviewer: options.reviewer,
    trace_limit: options.traceLimit,
    changed: report.changed === true,
    promoted_count: Number(report.promoted_count ?? 0),
    updated_count: Number(report.updated_count ?? 0),
    cleanup_count: Number(report.cleanup_count ?? 0),
    applied_cleanup_count: Number(report.applied_cleanup_count ?? 0),
    cycle_path: typeof report.cycle_path === "string" ? report.cycle_path : null,
    behavior_rule_index_path: typeof report.behavior_rule_index_path === "string" ? report.behavior_rule_index_path : null,
    controlled_compounding_status_path:
      typeof report.controlled_compounding_status_path === "string" ? report.controlled_compounding_status_path : null,
    public_summary_path: typeof report.public_summary_path === "string" ? report.public_summary_path : null,
    action: typeof report.action === "string" ? report.action : "cycle",
    os_version: DINOBRAIN_OS_VERSION,
  });
  return {
    ...report,
    event_log: eventLog,
  };
}

async function writeGateReport(taskId: string, value: Record<string, unknown>): Promise<string> {
  const gateId = makeGateId(taskId);
  const gatePath = dataPath(".dino", "gates", `${gateId}.json`);
  await writeJson(gatePath, {
    gate_id: gateId,
    os_version: DINOBRAIN_OS_VERSION,
    contract: DINOBRAIN_OS_CONTRACT,
    ...value,
  });
  return relDataPath(gatePath);
}

async function finalizePreflightBlockedTask(params: {
  taskId: string;
  taskPath: string;
  taskRecord: Record<string, unknown>;
  contextPackPath: string | null;
  gateReportPath: string;
  gates: ReturnType<typeof evaluateActionGates>;
}): Promise<{ record: Record<string, unknown>; trace_path: string; event_log: string }> {
  const finishedAt = nowIso();
  const traceRelativePath = `.dino/traces/${safeSlug(params.taskId)}.json`;
  const tracePath = dataPath(traceRelativePath);
  const lease = params.taskRecord.lease as Record<string, unknown> | undefined;
  const terminalOwnerId = firstString(lease?.owner_id, "preflight-gate");
  const terminalLease = lease
    ? {
        ...lease,
        heartbeat_at: finishedAt,
        state: "terminal",
        terminal_at: finishedAt,
      }
    : null;
  const contextPackPaths = params.contextPackPath ? [normalizeVaultPath(params.contextPackPath)] : [];
  const trace = {
    task_id: params.taskId,
    outcome: "blocked",
    summary: `Pre-response gate blocked the requested action: ${params.gates.reason_codes.join(", ")}`,
    growth_policy: "trace_only",
    changed_files: [],
    decisions: params.gates.reason_codes,
    next_steps: params.gates.gates.filter((gate) => gate.level === "block").map((gate) => gate.safe_action),
    used_memory_paths: [],
    context_pack_paths: contextPackPaths,
    session_archive_paths: [],
    candidate_paths: [],
    search_queries: [],
    gate_report_path: params.gateReportPath,
    action_decision: params.gates.action_decision,
    lease_id: firstString(lease?.lease_id) || null,
    terminal_owner_id: terminalOwnerId,
    memory_use: {
      used_memory_count: 0,
      context_pack_count: contextPackPaths.length,
      session_archive_count: 0,
      candidate_count: 0,
      search_query_count: 0,
    },
    finished_at: finishedAt,
  };
  const updated = {
    ...params.taskRecord,
    status: "blocked",
    block_reason: "pre_response_action_gate",
    gate_report_path: params.gateReportPath,
    action_decision: params.gates.action_decision,
    gate_reason_codes: params.gates.reason_codes,
    updated_at: finishedAt,
    finished_at: finishedAt,
    trace_path: traceRelativePath,
    lease: terminalLease,
    terminal_owner_id: terminalOwnerId,
  };
  const terminalTransaction = await writeTerminalTaskAndTrace({
    dataRoot: DATA_ROOT,
    taskPath: params.taskPath,
    taskRecord: updated,
    tracePath,
    traceRecord: trace,
  });
  const taskRelativePath = relDataPath(params.taskPath);
  await upsertOperationTask(DATA_ROOT, taskRelativePath, updated);
  await upsertOperationTrace(DATA_ROOT, traceRelativePath, trace);
  await upsertSqliteOperationTask(DATA_ROOT, taskEntryFromRecord(taskRelativePath, updated));
  await upsertSqliteOperationTrace(DATA_ROOT, traceEntryFromRecord(traceRelativePath, trace));
  const eventLog = await appendEvent({
    event: "task_finished",
    task_id: params.taskId,
    outcome: "blocked",
    at: finishedAt,
    trace_path: traceRelativePath,
    context_pack_paths: contextPackPaths,
    gate_report_path: params.gateReportPath,
    action_decision: params.gates.action_decision,
    gate_reason_codes: params.gates.reason_codes,
    lease_id: firstString(lease?.lease_id) || null,
    terminal_owner_id: terminalOwnerId,
    pre_response_auto_terminal: true,
    terminal_transaction_id: terminalTransaction.transaction_id,
    terminal_transaction_journal: terminalTransaction.journal_path,
  });
  return { record: updated, trace_path: traceRelativePath, event_log: eventLog };
}

async function readRecentOsEvents(): Promise<Record<string, unknown>[]> {
  const eventDir = dataPath(".dino", "events");
  let entries: Array<import("node:fs").Dirent>;
  try {
    entries = await fs.readdir(eventDir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const files = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
    .map((entry) => path.join(eventDir, entry.name))
    .sort((a, b) => a.localeCompare(b))
    .slice(-4);
  const events: Record<string, unknown>[] = [];
  for (const file of files) {
    const lines = (await fs.readFile(file, "utf8")).split(/\r?\n/).filter(Boolean);
    for (const line of lines) {
      try {
        events.push(JSON.parse(line) as Record<string, unknown>);
      } catch {
        continue;
      }
    }
  }
  return events;
}

async function findTaskPreflightEvidence(taskId: string, requireCompleted: boolean): Promise<TaskPreflightEvidence> {
  const events = await readRecentOsEvents();
  const startedIndex = events.findIndex((event) => event.event === "task_started" && event.task_id === taskId);
  const started = startedIndex >= 0 ? events[startedIndex] : null;
  const contextIndex = events.findIndex(
    (event, index) => index > startedIndex && event.event === "context_pack_created" && event.task_id === taskId,
  );
  const contextEvent = contextIndex >= 0 ? events[contextIndex] : null;
  const completedIndex = events.findIndex(
    (event, index) =>
      index > contextIndex &&
      ["os_begin_task_completed", "manual_preflight_context_ready"].includes(firstString(event.event)) &&
      event.task_id === taskId,
  );
  const completed = completedIndex >= 0 ? events[completedIndex] : null;
  const hookRunId = firstString(started?.hook_run_id, contextEvent?.hook_run_id, completed?.hook_run_id) || null;
  const promptHash = firstString(started?.prompt_hash, contextEvent?.prompt_hash, completed?.prompt_hash) || null;
  const hookSubmissionRequired = firstString(started?.launch_source).toLowerCase().includes("hook");
  const submittedIndex = hookRunId && hookSubmissionRequired
    ? events.findIndex(
        (event, index) =>
          index < startedIndex &&
          event.event === "codex_prompt_submitted" &&
          event.hook_run_id === hookRunId &&
          (!promptHash || event.prompt_hash === promptHash),
      )
    : -1;
  const reasonCodes: string[] = [];
  if (!started) reasonCodes.push("task_started_event_missing");
  if (!contextEvent) reasonCodes.push("context_pack_created_event_missing");
  if (requireCompleted && !completed) reasonCodes.push("preflight_completion_event_missing");
  if (hookSubmissionRequired && submittedIndex < 0) reasonCodes.push("codex_prompt_submitted_event_missing");
  const hashes = [started?.prompt_hash, contextEvent?.prompt_hash, completed?.prompt_hash]
    .filter((value): value is string => typeof value === "string" && value.length > 0);
  if (new Set(hashes).size > 1) reasonCodes.push("preflight_prompt_hash_mismatch");
  const hookIds = [started?.hook_run_id, contextEvent?.hook_run_id, completed?.hook_run_id]
    .filter((value): value is string => typeof value === "string" && value.length > 0);
  if (new Set(hookIds).size > 1) reasonCodes.push("preflight_hook_run_mismatch");
  const orderVerified =
    reasonCodes.length === 0 &&
    startedIndex >= 0 &&
    contextIndex > startedIndex &&
    (!requireCompleted || completedIndex > contextIndex) &&
    (!hookSubmissionRequired || submittedIndex < startedIndex);
  return {
    contextPackPath: firstString(completed?.context_pack_trace, contextEvent?.path) || null,
    contextTraceSha256: firstString(completed?.context_trace_sha256, contextEvent?.trace_sha256) || null,
    hookRunId,
    promptHash,
    eventOrderVerified: orderVerified,
    eventOrder: [
      ...(hookSubmissionRequired && submittedIndex >= 0 ? ["codex_prompt_submitted"] : []),
      ...(startedIndex >= 0 ? ["task_started"] : []),
      ...(contextIndex >= 0 ? ["context_pack_created"] : []),
      ...(completedIndex >= 0 ? [firstString(completed?.event)] : []),
    ],
    reasonCodes,
  };
}

async function inspectContextPackEvidence(params: {
  taskId: string;
  contextPackPath: string;
  expectedTraceSha256: string | null;
  preflight: TaskPreflightEvidence;
  declaredHasContextPack: boolean;
  declaredContextItemCount: number;
}): Promise<GateContextEvidence> {
  const reasonCodes = [...params.preflight.reasonCodes];
  let normalized: string;
  try {
    normalized = normalizeVaultPath(params.contextPackPath);
  } catch {
    return {
      hasContextPack: false,
      contextItemCount: 0,
      contextPackPath: null,
      contextPackId: null,
      contextTraceSha256: null,
      contextCreatedAt: null,
      contextAgeMs: null,
      contextTraceVerified: false,
      contextTraceFresh: false,
      eventOrderVerified: params.preflight.eventOrderVerified,
      eventOrder: params.preflight.eventOrder,
      hookRunId: params.preflight.hookRunId,
      promptHash: params.preflight.promptHash,
      verificationStatus: "invalid",
      declaredHasContextPack: params.declaredHasContextPack,
      declaredContextItemCount: params.declaredContextItemCount,
      declarationMismatch: true,
      reasonCodes: [...reasonCodes, "context_trace_path_invalid"],
    };
  }
  if (!normalized.startsWith(".dino/context-packs/") || !normalized.endsWith(".json")) {
    reasonCodes.push("context_trace_path_outside_context_pack_root");
  }
  let raw: Buffer;
  try {
    raw = await fs.readFile(dataPath(normalized));
  } catch {
    return {
      hasContextPack: false,
      contextItemCount: 0,
      contextPackPath: normalized,
      contextPackId: null,
      contextTraceSha256: null,
      contextCreatedAt: null,
      contextAgeMs: null,
      contextTraceVerified: false,
      contextTraceFresh: false,
      eventOrderVerified: params.preflight.eventOrderVerified,
      eventOrder: params.preflight.eventOrder,
      hookRunId: params.preflight.hookRunId,
      promptHash: params.preflight.promptHash,
      verificationStatus: "missing",
      declaredHasContextPack: params.declaredHasContextPack,
      declaredContextItemCount: params.declaredContextItemCount,
      declarationMismatch: params.declaredHasContextPack || params.declaredContextItemCount > 0,
      reasonCodes: [...reasonCodes, "context_trace_missing"],
    };
  }
  const traceSha256 = sha256(raw);
  let pack: Record<string, unknown>;
  try {
    pack = JSON.parse(raw.toString("utf8")) as Record<string, unknown>;
  } catch {
    pack = {};
    reasonCodes.push("context_trace_json_invalid");
  }
  const packId = firstString(pack.pack_id) || null;
  const createdAt = firstString(pack.created_at) || null;
  const items = Array.isArray(pack.items) ? pack.items : [];
  const declaredPackItemCount = typeof pack.included_item_count === "number" ? pack.included_item_count : -1;
  if (!packId || path.basename(normalized, ".json") !== packId) reasonCodes.push("context_trace_pack_id_mismatch");
  if (pack.task_id !== params.taskId) reasonCodes.push("context_trace_task_binding_mismatch");
  if (declaredPackItemCount !== items.length) reasonCodes.push("context_trace_item_count_mismatch");
  if (!params.expectedTraceSha256 || traceSha256 !== params.expectedTraceSha256) {
    reasonCodes.push("context_trace_hash_mismatch");
  }
  const createdMs = createdAt ? Date.parse(createdAt) : Number.NaN;
  const ageMs = Number.isFinite(createdMs) ? Date.now() - createdMs : null;
  if (ageMs === null) reasonCodes.push("context_trace_created_at_invalid");
  if (ageMs !== null && ageMs < -60_000) reasonCodes.push("context_trace_from_future");
  const maxAgeMs = Math.max(
    100,
    Math.min(24 * 60 * 60 * 1000, Number(process.env.DINOBRAIN_GATE_CONTEXT_MAX_AGE_SECONDS ?? 900) * 1000),
  );
  const fresh = ageMs !== null && ageMs >= -60_000 && ageMs <= maxAgeMs;
  if (!fresh) reasonCodes.push("context_trace_stale");
  const verificationErrors = reasonCodes.filter((code) => code !== "context_trace_stale");
  const verified = verificationErrors.length === 0 && params.preflight.eventOrderVerified;
  return {
    hasContextPack: true,
    contextItemCount: declaredPackItemCount >= 0 ? declaredPackItemCount : 0,
    contextPackPath: normalized,
    contextPackId: packId,
    contextTraceSha256: traceSha256,
    contextCreatedAt: createdAt,
    contextAgeMs: ageMs,
    contextTraceVerified: verified,
    contextTraceFresh: fresh,
    eventOrderVerified: params.preflight.eventOrderVerified,
    eventOrder: params.preflight.eventOrder,
    hookRunId: params.preflight.hookRunId,
    promptHash: params.preflight.promptHash,
    verificationStatus: verified ? (fresh ? "verified" : "stale") : "invalid",
    declaredHasContextPack: params.declaredHasContextPack,
    declaredContextItemCount: params.declaredContextItemCount,
    declarationMismatch:
      !params.declaredHasContextPack || params.declaredContextItemCount !== Math.max(0, declaredPackItemCount),
    reasonCodes,
  };
}

async function deriveGateContextEvidence(params: {
  taskId: string;
  contextPackPath?: string;
  declaredHasContextPack: boolean;
  declaredContextItemCount: number;
}): Promise<GateContextEvidence> {
  const preflight = await findTaskPreflightEvidence(params.taskId, true);
  const canonicalPath = preflight.contextPackPath;
  let declaredPath = "";
  if (params.contextPackPath?.trim()) {
    try {
      declaredPath = normalizeVaultPath(params.contextPackPath);
    } catch {
      declaredPath = "invalid";
    }
  }
  if (declaredPath && canonicalPath && declaredPath !== canonicalPath) {
    return {
      hasContextPack: false,
      contextItemCount: 0,
      contextPackPath: canonicalPath,
      contextPackId: null,
      contextTraceSha256: preflight.contextTraceSha256,
      contextCreatedAt: null,
      contextAgeMs: null,
      contextTraceVerified: false,
      contextTraceFresh: false,
      eventOrderVerified: preflight.eventOrderVerified,
      eventOrder: preflight.eventOrder,
      hookRunId: preflight.hookRunId,
      promptHash: preflight.promptHash,
      verificationStatus: "unbound",
      declaredHasContextPack: params.declaredHasContextPack,
      declaredContextItemCount: params.declaredContextItemCount,
      declarationMismatch: true,
      reasonCodes: [...preflight.reasonCodes, "declared_context_trace_not_bound_to_task"],
    };
  }
  if (canonicalPath) {
    return inspectContextPackEvidence({
      taskId: params.taskId,
      contextPackPath: canonicalPath,
      expectedTraceSha256: preflight.contextTraceSha256,
      preflight,
      declaredHasContextPack: params.declaredHasContextPack,
      declaredContextItemCount: params.declaredContextItemCount,
    });
  }
  return {
    hasContextPack: false,
    contextItemCount: 0,
    contextPackPath: null,
    contextPackId: null,
    contextTraceSha256: null,
    contextCreatedAt: null,
    contextAgeMs: null,
    contextTraceVerified: false,
    contextTraceFresh: false,
    eventOrderVerified: false,
    eventOrder: preflight.eventOrder,
    hookRunId: preflight.hookRunId,
    promptHash: preflight.promptHash,
    verificationStatus: params.contextPackPath ? "missing" : "not_provided",
    declaredHasContextPack: params.declaredHasContextPack,
    declaredContextItemCount: params.declaredContextItemCount,
    declarationMismatch: params.declaredHasContextPack || params.declaredContextItemCount > 0,
    reasonCodes: [...preflight.reasonCodes, "task_bound_context_trace_missing"],
  };
}

async function buildContextPackRecord(
  question: string,
  limit: number,
  linkage: { taskId?: string; hookRunId?: string; promptHash?: string } = {},
): Promise<Record<string, unknown>> {
  const { records, ranked, stats } = await getContextPackItems(DATA_ROOT, question, limit);
  const packId = makePackId(question);
  const createdAt = nowIso();
  const packPath = dataPath(".dino", "context-packs", `${packId}.json`);
  const persistedQuestion = sanitizeTaskRequest(question).request;
  const items = ranked.map(({
    path: recordPath,
    kind,
    title,
    summary,
    tags,
    score,
    reasons,
    score_breakdown,
    source_sha256,
    parent_record_path,
    language,
    lifecycle_state,
    verification_status,
    retrieval_lane,
    knowledge_role,
    aliases,
    contextual_chunk,
    modified_at_ms,
  }) => redactMachineLocalValue({
    path: recordPath,
    kind,
    title,
    summary,
    tags,
    score,
    reasons,
    score_breakdown,
    source_sha256,
    parent_record_path,
    language,
    lifecycle_state,
    verification_status,
    retrieval_lane,
    knowledge_role,
    aliases,
    contextual_chunk,
    modified_at_ms,
  }));
  const trace = {
    pack_id: packId,
    pack_type: "standard",
    os_version: DINOBRAIN_OS_VERSION,
    task_id: linkage.taskId ?? null,
    hook_run_id: linkage.hookRunId ?? null,
    prompt_hash: linkage.promptHash ?? null,
    question: persistedQuestion,
    created_at: createdAt,
    ranking_inputs: standardRankingInputsForMode(stats.retrieval_mode),
    source_roots: SEARCH_ROOTS,
    recent_task_limit: 10,
    candidate_records_excluded: true,
    review_queue_excluded: true,
    scanned_record_count: records.length,
    retrieval_mode: stats.retrieval_mode,
    candidate_source: "candidate_source" in stats ? stats.candidate_source : null,
    index_path: stats.index_path,
    indexed_record_count: stats.index_record_count,
    index_candidate_count: stats.candidate_record_count,
    index_total_candidate_count: stats.total_candidate_count,
    index_matching_terms: stats.matching_terms,
    included_item_count: items.length,
    excluded_record_count: Math.max(0, stats.index_record_count + (stats.recent_task_count ?? 0) - ranked.length),
    items,
  };
  await writeJson(packPath, trace);
  const packRelativePath = relDataPath(packPath);
  const traceSha256 = sha256(await fs.readFile(packPath));
  await upsertOperationContextPack(DATA_ROOT, packRelativePath, trace);
  await upsertSqliteOperationContextPack(DATA_ROOT, contextPackEntryFromRecord(packRelativePath, trace));
  const eventLog = await appendEvent({
    event: "context_pack_created",
    pack_id: packId,
    task_id: linkage.taskId ?? null,
    hook_run_id: linkage.hookRunId ?? null,
    prompt_hash: linkage.promptHash ?? null,
    at: createdAt,
    path: packRelativePath,
    trace_sha256: traceSha256,
    item_count: items.length,
    retrieval_mode: stats.retrieval_mode,
    os_version: DINOBRAIN_OS_VERSION,
  });
  return {
    ok: true,
    pack_id: packId,
    pack_type: "standard",
    os_version: DINOBRAIN_OS_VERSION,
    question: persistedQuestion,
    created_at: createdAt,
    data_root: DATA_ROOT,
    trace_path: packRelativePath,
    trace_sha256: traceSha256,
    event_log: eventLog,
    ranking_inputs: trace.ranking_inputs,
    scanned_record_count: records.length,
    retrieval_mode: stats.retrieval_mode,
    candidate_source: trace.candidate_source,
    index_path: stats.index_path,
    indexed_record_count: stats.index_record_count,
    index_candidate_count: stats.candidate_record_count,
    index_total_candidate_count: stats.total_candidate_count,
    item_count: items.length,
    items,
    caveats: retrievalCaveatsForMode(stats.retrieval_mode),
  };
}

async function buildSearchResult(query: string, limit: number): Promise<Record<string, unknown>> {
  const { ranked, stats } = await searchWiki(DATA_ROOT, query, limit);
  return {
    ok: true,
    query,
    retrieval_mode: stats.retrieval_mode,
    index_path: stats.index_path,
    indexed_record_count: stats.index_record_count,
    candidate_record_count: stats.candidate_record_count,
    total_candidate_count: stats.total_candidate_count,
    matching_terms: stats.matching_terms,
    result_count: ranked.length,
    results: ranked,
  };
}

const server = new McpServer({
  name: "dinobrain",
  version: DINOBRAIN_OS_VERSION,
});

const clientMcpProofRuntime = new ClientMcpProofRuntime(DATA_ROOT, {
  getClientInfo: () => {
    const value = server.server.getClientVersion();
    return value ? { name: value.name, version: value.version } : undefined;
  },
});

const disabledOsTools = new Set(
  envString("DINOBRAIN_DISABLED_OS_TOOLS", "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean),
);
const registeredToolNames = new Set<string>();
const registerTool = ((name: string, config: unknown, callback: unknown) => {
  const protectedEntrypoint =
    name === "os_begin_task" ||
    name === "os_gate" ||
    name === "begin_client_mcp_proof" ||
    name === "finalize_client_mcp_proof";
  if (disabledOsTools.has(name) && !protectedEntrypoint) return undefined;
  const handler = callback as (...args: unknown[]) => Promise<CallToolResult>;
  const wrapped = (...args: unknown[]) =>
    clientMcpProofRuntime.captureToolCall(name, args[0], () => handler(...args));
  const registered = server.registerTool(name, config as never, wrapped as never);
  registeredToolNames.add(name);
  return registered;
}) as McpServer["registerTool"];

function observedOsTools(): string[] {
  return Array.from(registeredToolNames).sort((a, b) => a.localeCompare(b));
}

registerTool(
  "begin_client_mcp_proof",
  {
    title: "Begin Direct Client MCP Proof",
    description: "Activate a one-time server-observed direct MCP proof challenge for this real client process.",
    inputSchema: {
      challenge_id: z.string().min(1),
    },
  },
  async ({ challenge_id }) => jsonResult(await clientMcpProofRuntime.begin(challenge_id)),
);

registerTool(
  "finalize_client_mcp_proof",
  {
    title: "Finalize Direct Client MCP Proof",
    description: "Verify the challenge-bound tool receipt chain and publish a signed direct-client MCP proof.",
    inputSchema: {
      challenge_id: z.string().min(1),
    },
  },
  async ({ challenge_id }) => jsonResult(await clientMcpProofRuntime.finalize(challenge_id)),
);

registerTool(
  "os_begin_task",
  {
    title: "OS Begin Task",
    description: "Fail-closed DinoBrain OS v2 pre-response entrypoint: start task, retrieve Context Pack, and evaluate action gates.",
    inputSchema: {
      request: z.string().min(1),
      project: z.string().optional(),
      mode: z.enum(["standard", "deep"]).default("standard"),
      sensitivity: z.enum(["normal", "sensitive", "unknown"]).default("unknown"),
      limit: z.number().int().min(1).max(20).default(7),
      ...promptLaunchInputSchema,
    },
  },
  async ({ request, project, mode, sensitivity, limit, ...launchMetadata }) => {
    let metadata = sanitizeTaskLaunchMetadata(launchMetadata as TaskLaunchMetadata);
    if (clientMcpProofRuntime.hasActiveChallenge()) {
      metadata = {
        ...metadata,
        launch_kind: "direct_mcp",
        prompt_surface: "client_mcp_proof",
        task_type: "client_mcp_proof",
        launch_source: "server_observed_client_mcp_challenge",
      };
    }
    const sanitized = sanitizeTaskRequest(request);
    const storedRequest = sanitized.request;
    const storedProject = project ? redactSensitiveText(project).text : null;
    const sensitivityEvidence = effectiveSensitivity(sensitivity, request);
    const filtered = await filteredTaskLaunch(storedRequest, metadata, "os_begin_task");
    if (filtered) return jsonResult(filtered);
    const eligibility = classifyTaskLaunch(storedRequest, metadata);
    const dedupeClaim = await claimTaskStart(metadata, storedRequest);
    if (!dedupeClaim.acquired) {
      if (dedupeClaim.response) {
        return jsonResult({ ...dedupeClaim.response, idempotent: true, dedupe_receipt_reused: true });
      }
      return jsonResult({
        ok: false,
        fail_closed: true,
        gate_status: "block",
        skipped: true,
        durable_task_created: false,
        prompt_classification: eligibility.classification,
        error: "task_start_dedupe_timeout",
        safe_action: "Do not perform substantial work; retry from the same trusted client session after the first preflight completes.",
      });
    }
    const taskId = makeTaskId(storedRequest);
    const taskPath = dataPath(".dino", "tasks", `${taskId}.json`);
    const createdAt = nowIso();
    const lease = taskLease(storedRequest, metadata, createdAt);
    const record = {
      task_id: taskId,
      status: "started",
      request: storedRequest,
      request_hash: sanitized.request_hash,
      request_redactions: sanitized.redactions,
      request_truncated: sanitized.truncated,
      project: storedProject,
      mode,
      sensitivity: sensitivityEvidence.sensitivity,
      reported_sensitivity: sensitivityEvidence.reported,
      detected_sensitivity: sensitivityEvidence.detected,
      sensitivity_hits: sensitivityEvidence.hits,
      os_version: DINOBRAIN_OS_VERSION,
      contract: DINOBRAIN_OS_CONTRACT,
      created_at: createdAt,
      updated_at: createdAt,
      data_root: ".",
      sync_policy: sensitivityEvidence.sensitivity === "normal" ? "conditional" : "blocked_until_review",
      ...taskLaunchEvidence(storedRequest, metadata, eligibility),
      lease,
      terminal_owner_id: null,
    };
    await writeJson(taskPath, record);
    const taskRelativePath = relDataPath(taskPath);
    await upsertOperationTask(DATA_ROOT, taskRelativePath, record);
    await upsertSqliteOperationTask(DATA_ROOT, taskEntryFromRecord(taskRelativePath, record));
    await registerTaskSyncPaths({
      dataRoot: DATA_ROOT,
      taskId,
      paths: [taskRelativePath],
      source: "os_begin_task:task",
      approval: "system_verified",
    });
    const taskEventLog = await appendEvent({
      event: "task_started",
      task_id: taskId,
      at: record.created_at,
      path: taskRelativePath,
      os_version: DINOBRAIN_OS_VERSION,
      prompt_hash: record.prompt_hash,
      prompt_classification: record.prompt_classification,
      hook_run_id: record.hook_run_id,
      launch_kind: record.launch_kind,
      launch_source: record.launch_source,
      lease_id: lease.lease_id,
      owner_id: lease.owner_id,
    });

    let contextPack: Record<string, unknown>;
    try {
      contextPack = await buildContextPackRecord(storedRequest, limit, {
        taskId,
        hookRunId: metadata.hook_run_id,
        promptHash: firstString(record.prompt_hash),
      });
    } catch (error) {
      const errorMessage = safeError(error);
      const blockedAt = nowIso();
      const syncObservation = await observeGateSyncRisk(request);
      const gates = evaluateActionGates({
        request,
        hasContextPack: false,
        contextItemCount: 0,
        contextTraceVerified: false,
        contextTraceFresh: false,
        preflightEventOrderVerified: false,
        sensitivity: sensitivityEvidence.sensitivity,
        exposedTools: observedOsTools(),
        syncObservation,
      });
      const gateReportPath = await writeGateReport(taskId, {
        task_id: taskId,
        request: storedRequest,
        request_hash: sanitized.request_hash,
        request_redactions: sanitized.redactions,
        generated_at: blockedAt,
        context_pack_path: null,
        context_item_count: 0,
        observed_tools: observedOsTools(),
        sync_observation: syncObservation,
        error: errorMessage,
        ...gates,
      });
      const gateEventLog = await appendEvent({
        event: "os_begin_task_failed_closed",
        task_id: taskId,
        at: blockedAt,
        gate_status: gates.status,
        action_decision: gates.action_decision,
        fail_closed: true,
        gate_report_path: gateReportPath,
        error: errorMessage,
        os_version: DINOBRAIN_OS_VERSION,
      });
      const blocked = await finalizePreflightBlockedTask({
        taskId,
        taskPath,
        taskRecord: { ...record, error: errorMessage },
        contextPackPath: null,
        gateReportPath,
        gates,
      });
      const response = {
        ok: false,
        os_version: DINOBRAIN_OS_VERSION,
        contract: DINOBRAIN_OS_CONTRACT,
        gate_status: gates.status,
        ...gates,
        task_id: taskId,
        task_path: taskRelativePath,
        lease: blocked.record.lease,
        event_log: taskEventLog,
        gate_event_log: gateEventLog,
        gate_report_path: gateReportPath,
        trace_path: blocked.trace_path,
        terminal_event_log: blocked.event_log,
        record: blocked.record,
        context_pack: null,
        error: errorMessage,
      };
      await completeTaskStart(dedupeClaim, response);
      return jsonResult(response);
    }
    const preliminaryPreflight = await findTaskPreflightEvidence(taskId, false);
    const contextEvidence = await inspectContextPackEvidence({
      taskId,
      contextPackPath: firstString(contextPack.trace_path),
      expectedTraceSha256: firstString(contextPack.trace_sha256) || null,
      preflight: preliminaryPreflight,
      declaredHasContextPack: true,
      declaredContextItemCount: typeof contextPack.item_count === "number" ? contextPack.item_count : 0,
    });
    const syncObservation = await observeGateSyncRisk(request);
    let gates = evaluateActionGates({
      request,
      hasContextPack: contextEvidence.hasContextPack,
      contextItemCount: contextEvidence.contextItemCount,
      contextTraceVerified: contextEvidence.contextTraceVerified,
      contextTraceFresh: contextEvidence.contextTraceFresh,
      preflightEventOrderVerified: contextEvidence.eventOrderVerified,
      sensitivity: sensitivityEvidence.sensitivity,
      exposedTools: observedOsTools(),
      syncObservation,
    });
    const gateReportPath = await writeGateReport(taskId, {
      task_id: taskId,
      request: storedRequest,
      request_hash: sanitized.request_hash,
      request_redactions: sanitized.redactions,
      generated_at: nowIso(),
      context_pack_path: contextPack.trace_path,
      context_item_count: contextPack.item_count,
      context_evidence: contextEvidence,
      observed_tools: observedOsTools(),
      sync_observation: syncObservation,
      ...gates,
    });
    const gateEventLog = await appendEvent({
      event: "os_begin_task_completed",
      task_id: taskId,
      at: nowIso(),
      context_pack_trace: contextPack.trace_path,
      context_trace_sha256: contextPack.trace_sha256,
      context_item_count: contextPack.item_count,
      hook_run_id: metadata.hook_run_id ?? null,
      prompt_hash: record.prompt_hash,
      gate_status: gates.status,
      action_decision: gates.action_decision,
      fail_closed: gates.fail_closed,
      gate_report_path: gateReportPath,
      os_version: DINOBRAIN_OS_VERSION,
    });
    const finalPreflight = await findTaskPreflightEvidence(taskId, true);
    if (!finalPreflight.eventOrderVerified) {
      gates = evaluateActionGates({
        request,
        hasContextPack: contextEvidence.hasContextPack,
        contextItemCount: contextEvidence.contextItemCount,
        contextTraceVerified: contextEvidence.contextTraceVerified,
        contextTraceFresh: contextEvidence.contextTraceFresh,
        preflightEventOrderVerified: false,
        sensitivity: sensitivityEvidence.sensitivity,
        exposedTools: observedOsTools(),
        syncObservation,
      });
      await appendEvent({
        event: "os_begin_task_order_failed_closed",
        task_id: taskId,
        at: nowIso(),
        gate_report_path: gateReportPath,
        reason_codes: finalPreflight.reasonCodes,
        os_version: DINOBRAIN_OS_VERSION,
      });
    }
    const existingGateReport = (await readJson<Record<string, unknown>>(dataPath(gateReportPath))) ?? {};
    await writeJson(dataPath(gateReportPath), {
      ...existingGateReport,
      generated_at: nowIso(),
      context_evidence: { ...contextEvidence, eventOrderVerified: finalPreflight.eventOrderVerified, eventOrder: finalPreflight.eventOrder },
      preflight_evidence: finalPreflight,
      ...gates,
    });
    const gatedRecord = {
      ...record,
      gate_report_path: gateReportPath,
      gate_status: gates.status,
      action_decision: gates.action_decision,
      gate_reason_codes: gates.reason_codes,
      persistence_policy: gates.persistence_policy,
      sync_policy: gates.sync_policy,
      updated_at: nowIso(),
    };
    await writeJson(taskPath, gatedRecord);
    await upsertOperationTask(DATA_ROOT, taskRelativePath, gatedRecord);
    await upsertSqliteOperationTask(DATA_ROOT, taskEntryFromRecord(taskRelativePath, gatedRecord));
    const blocked = gates.fail_closed
      ? await finalizePreflightBlockedTask({
          taskId,
          taskPath,
          taskRecord: gatedRecord,
          contextPackPath: firstString(contextPack.trace_path) || null,
          gateReportPath,
          gates,
        })
      : null;
    await registerTaskSyncPaths({
      dataRoot: DATA_ROOT,
      taskId,
      paths: [
        taskRelativePath,
        firstString(contextPack.trace_path),
        gateReportPath,
        blocked?.trace_path ?? "",
      ].filter(Boolean),
      source: "os_begin_task:preflight",
      approval: "system_verified",
      terminal: Boolean(blocked),
    });
    const response = {
      ok: !gates.fail_closed,
      os_version: DINOBRAIN_OS_VERSION,
      contract: DINOBRAIN_OS_CONTRACT,
      gate_status: gates.status,
      ...gates,
      task_id: taskId,
      task_path: taskRelativePath,
      lease: blocked?.record.lease ?? gatedRecord.lease,
      event_log: taskEventLog,
      gate_event_log: gateEventLog,
      gate_report_path: gateReportPath,
      trace_path: blocked?.trace_path ?? null,
      terminal_event_log: blocked?.event_log ?? null,
      record: blocked?.record ?? gatedRecord,
      context_evidence: { ...contextEvidence, eventOrderVerified: finalPreflight.eventOrderVerified, eventOrder: finalPreflight.eventOrder },
      preflight_evidence: finalPreflight,
      observed_tools: observedOsTools(),
      sync_observation: syncObservation,
      context_pack: contextPack,
    };
    await completeTaskStart(dedupeClaim, response);
    return jsonResult(response);
  },
);

registerTool(
  "start_task",
  {
    title: "Start Task",
    description: "Register a new DinoBrain task record in the data repo.",
    inputSchema: {
      request: z.string().min(1),
      project: z.string().optional(),
      mode: z.enum(["standard", "deep"]).default("standard"),
      sensitivity: z.enum(["normal", "sensitive", "unknown"]).default("unknown"),
      ...promptLaunchInputSchema,
    },
  },
  async ({ request, project, mode, sensitivity, ...launchMetadata }) => {
    const metadata = sanitizeTaskLaunchMetadata(launchMetadata as TaskLaunchMetadata);
    const sanitized = sanitizeTaskRequest(request);
    const storedRequest = sanitized.request;
    const storedProject = project ? redactSensitiveText(project).text : null;
    const sensitivityEvidence = effectiveSensitivity(sensitivity, request);
    const filtered = await filteredTaskLaunch(storedRequest, metadata, "start_task");
    if (filtered) return jsonResult(filtered);
    const eligibility = classifyTaskLaunch(storedRequest, metadata);
    const dedupeClaim = await claimTaskStart(metadata, storedRequest);
    if (!dedupeClaim.acquired) {
      if (dedupeClaim.response) {
        return jsonResult({ ...dedupeClaim.response, idempotent: true, dedupe_receipt_reused: true });
      }
      return jsonResult({
        ok: false,
        fail_closed: true,
        skipped: true,
        durable_task_created: false,
        prompt_classification: eligibility.classification,
        error: "task_start_dedupe_timeout",
      });
    }
    const taskId = makeTaskId(storedRequest);
    const taskPath = dataPath(".dino", "tasks", `${taskId}.json`);
    const createdAt = nowIso();
    const lease = taskLease(storedRequest, metadata, createdAt);
    const record = {
      task_id: taskId,
      status: "started",
      request: storedRequest,
      request_hash: sanitized.request_hash,
      request_redactions: sanitized.redactions,
      request_truncated: sanitized.truncated,
      project: storedProject,
      mode,
      sensitivity: sensitivityEvidence.sensitivity,
      reported_sensitivity: sensitivityEvidence.reported,
      detected_sensitivity: sensitivityEvidence.detected,
      sensitivity_hits: sensitivityEvidence.hits,
      os_version: DINOBRAIN_OS_VERSION,
      contract: DINOBRAIN_OS_CONTRACT,
      created_at: createdAt,
      updated_at: createdAt,
      data_root: ".",
      sync_policy: sensitivityEvidence.sensitivity === "normal" ? "conditional" : "blocked_until_review",
      ...taskLaunchEvidence(storedRequest, metadata, eligibility),
      lease,
      terminal_owner_id: null,
    };
    await writeJson(taskPath, record);
    const taskRelativePath = relDataPath(taskPath);
    await upsertOperationTask(DATA_ROOT, taskRelativePath, record);
    await upsertSqliteOperationTask(DATA_ROOT, taskEntryFromRecord(taskRelativePath, record));
    await registerTaskSyncPaths({
      dataRoot: DATA_ROOT,
      taskId,
      paths: [taskRelativePath],
      source: "start_task:task",
      approval: "system_verified",
    });
    const eventLog = await appendEvent({
      event: "task_started",
      task_id: taskId,
      at: record.created_at,
      path: relDataPath(taskPath),
      prompt_hash: record.prompt_hash,
      prompt_classification: record.prompt_classification,
      hook_run_id: record.hook_run_id,
      launch_kind: record.launch_kind,
      launch_source: record.launch_source,
      lease_id: lease.lease_id,
      owner_id: lease.owner_id,
    });
    const response = {
      ok: true,
      task_id: taskId,
      task_path: taskRelativePath,
      lease,
      event_log: eventLog,
      record,
    };
    await completeTaskStart(dedupeClaim, response);
    return jsonResult(response);
  },
);

registerTool(
  "heartbeat_task",
  {
    title: "Heartbeat Task",
    description: "Renew the lease for an active DinoBrain task owned by the current prompt.",
    inputSchema: {
      task_id: z.string().min(1),
      lease_id: z.string().min(1),
      extend_seconds: z.number().int().min(60).max(24 * 60 * 60).default(60 * 60),
    },
  },
  async ({ task_id, lease_id, extend_seconds }) => {
    return withTaskLifecycleMutationLock(DATA_ROOT, async () => {
    const taskPath = dataPath(".dino", "tasks", `${safeSlug(task_id)}.json`);
    const existing = await readJson<Record<string, unknown>>(taskPath);
    if (!existing) throw new Error(`Task does not exist: ${task_id}`);
    if (firstString(existing.status) !== "started") throw new Error(`Task is not active: ${task_id}`);
    const lease = existing.lease as Record<string, unknown> | undefined;
    if (!lease || firstString(lease.lease_id) !== lease_id) throw new Error(`Task lease ownership mismatch: ${task_id}`);
    const heartbeatAt = nowIso();
    const renewedLease = {
      ...lease,
      heartbeat_at: heartbeatAt,
      expires_at: new Date(Date.parse(heartbeatAt) + extend_seconds * 1000).toISOString(),
      lease_seconds: extend_seconds,
      state: "active",
    };
    const updated = {
      ...existing,
      lease: renewedLease,
      updated_at: heartbeatAt,
    };
    await writeJson(taskPath, updated);
    const taskRelativePath = relDataPath(taskPath);
    await upsertOperationTask(DATA_ROOT, taskRelativePath, updated);
    await upsertSqliteOperationTask(DATA_ROOT, taskEntryFromRecord(taskRelativePath, updated));
    await registerTaskSyncPaths({
      dataRoot: DATA_ROOT,
      taskId: task_id,
      paths: [taskRelativePath],
      source: "heartbeat_task:task",
      approval: "system_verified",
    });
    const eventLog = await appendEvent({
      event: "task_lease_heartbeat",
      task_id,
      at: heartbeatAt,
      lease_id,
      owner_id: firstString(lease.owner_id),
      expires_at: renewedLease.expires_at,
    });
    return jsonResult({
      ok: true,
      task_id,
      task_path: taskRelativePath,
      lease: renewedLease,
      event_log: eventLog,
    });
    });
  },
);

type FinishTaskTerminalResult =
  | {
      idempotent: true;
      taskPath: string;
      traceRelativePath: string;
      terminalOwnerId: string;
      outcome: string;
    }
  | {
      idempotent: false;
      taskPath: string;
      tracePath: string;
      taskRelativePath: string;
      traceRelativePath: string;
      expectedLeaseId: string;
      terminalOwnerId: string;
      finishedAt: string;
      trace: Record<string, unknown>;
      updated: Record<string, unknown>;
      normalizedUsedMemoryPaths: string[];
      normalizedContextPackPaths: string[];
      normalizedSessionArchivePaths: string[];
      normalizedCandidatePaths: string[];
      normalizedSearchQueries: string[];
      terminalTransaction: { transaction_id: string; journal_path: string };
    };

async function finishTaskTerminalWrite(params: {
  taskId: string;
  leaseId?: string;
  terminalOwnerId?: string;
  summary: string;
  outcome: "completed" | "partial" | "blocked";
  growthPolicy: "auto" | "trace_only";
  changedFiles: string[];
  decisions: string[];
  nextSteps: string[];
  usedMemoryPaths: string[];
  contextPackPaths: string[];
  sessionArchivePaths: string[];
  candidatePaths: string[];
  searchQueries: string[];
}): Promise<FinishTaskTerminalResult> {
  return withTaskLifecycleMutationLock(DATA_ROOT, async () => {
    const taskPath = dataPath(".dino", "tasks", `${safeSlug(params.taskId)}.json`);
    const existing = await readJson<Record<string, unknown>>(taskPath);
    if (!existing) throw new Error(`Task does not exist: ${params.taskId}`);
    const existingLease = existing.lease as Record<string, unknown> | undefined;
    const expectedLeaseId = firstString(existingLease?.lease_id);
    if (expectedLeaseId && params.leaseId !== expectedLeaseId) {
      throw new Error(`Task lease ownership mismatch: ${params.taskId}`);
    }
    const leaseExpiresAt = firstString(existingLease?.expires_at);
    if (
      expectedLeaseId &&
      firstString(existingLease?.state, "active") === "active" &&
      leaseExpiresAt &&
      Number.isFinite(Date.parse(leaseExpiresAt)) &&
      Date.now() > Date.parse(leaseExpiresAt)
    ) {
      throw new Error(`Task lease expired; renew it with heartbeat_task before finishing: ${params.taskId}`);
    }
    const sanitizedTerminalOwnerId = sanitizeOptionalMetadata(params.terminalOwnerId);
    const terminalOwnerId = firstString(sanitizedTerminalOwnerId, existingLease?.owner_id, "legacy-unleased-owner");
    const existingTerminalOwner = firstString(existing.terminal_owner_id);
    if (existingTerminalOwner && existingTerminalOwner !== terminalOwnerId) {
      throw new Error(`Task terminal owner mismatch: ${params.taskId}`);
    }
    const existingStatus = firstString(existing.status).toLowerCase();
    if (["completed", "partial", "blocked"].includes(existingStatus)) {
      const existingTracePath = firstString(existing.trace_path, `.dino/traces/${safeSlug(params.taskId)}.json`);
      const existingTrace = await readJson<Record<string, unknown>>(dataPath(existingTracePath));
      if (!existingTrace) throw new Error(`Terminal task is missing its trace: ${params.taskId}`);
      return {
        idempotent: true,
        taskPath,
        traceRelativePath: existingTracePath,
        terminalOwnerId,
        outcome: existingStatus,
      };
    }
    const finishedAt = nowIso();
    const outputRedactions = new Set<string>();
    const sanitizeOutput = (value: string): string => {
      const sanitized = redactSensitiveText(value);
      for (const redaction of sanitized.redactions) outputRedactions.add(redaction);
      return sanitized.text;
    };
    const sanitizedSummary = sanitizeOutput(params.summary);
    const sanitizedChangedFiles = params.changedFiles.map(sanitizeOutput);
    const sanitizedDecisions = params.decisions.map(sanitizeOutput);
    const sanitizedNextSteps = params.nextSteps.map(sanitizeOutput);
    const sanitizedSearchQueries = params.searchQueries.map(sanitizeOutput);
    const normalizedUsedMemoryPaths = normalizeVaultPaths(params.usedMemoryPaths);
    const normalizedContextPackPaths = normalizeVaultPaths(params.contextPackPaths);
    const normalizedSessionArchivePaths = normalizeVaultPaths(params.sessionArchivePaths);
    const normalizedCandidatePaths = normalizeVaultPaths(params.candidatePaths);
    const normalizedSearchQueries = normalizeTextList(sanitizedSearchQueries);
    const trace = {
      task_id: params.taskId,
      outcome: params.outcome,
      summary: sanitizedSummary,
      growth_policy: params.growthPolicy,
      changed_files: sanitizedChangedFiles,
      decisions: sanitizedDecisions,
      next_steps: sanitizedNextSteps,
      used_memory_paths: normalizedUsedMemoryPaths,
      context_pack_paths: normalizedContextPackPaths,
      session_archive_paths: normalizedSessionArchivePaths,
      candidate_paths: normalizedCandidatePaths,
      search_queries: normalizedSearchQueries,
      output_redactions: Array.from(outputRedactions).sort(),
      lease_id: expectedLeaseId || null,
      terminal_owner_id: terminalOwnerId,
      memory_use: {
        used_memory_count: normalizedUsedMemoryPaths.length,
        context_pack_count: normalizedContextPackPaths.length,
        session_archive_count: normalizedSessionArchivePaths.length,
        candidate_count: normalizedCandidatePaths.length,
        search_query_count: normalizedSearchQueries.length,
      },
      finished_at: finishedAt,
    };
    const terminalLease = existingLease
      ? {
          ...existingLease,
          heartbeat_at: finishedAt,
          state: "terminal",
          terminal_at: finishedAt,
        }
      : null;
    const traceRelativePath = `.dino/traces/${safeSlug(params.taskId)}.json`;
    const updated = {
      ...existing,
      status: params.outcome,
      updated_at: finishedAt,
      finished_at: finishedAt,
      trace_path: traceRelativePath,
      lease: terminalLease,
      terminal_owner_id: terminalOwnerId,
    };
    const tracePath = dataPath(traceRelativePath);
    const terminalTransaction = await writeTerminalTaskAndTraceUnlocked({
      dataRoot: DATA_ROOT,
      taskPath,
      taskRecord: updated,
      tracePath,
      traceRecord: trace,
    });
    return {
      idempotent: false,
      taskPath,
      tracePath,
      taskRelativePath: relDataPath(taskPath),
      traceRelativePath,
      expectedLeaseId,
      terminalOwnerId,
      finishedAt,
      trace,
      updated,
      normalizedUsedMemoryPaths,
      normalizedContextPackPaths,
      normalizedSessionArchivePaths,
      normalizedCandidatePaths,
      normalizedSearchQueries,
      terminalTransaction,
    };
  });
}

registerTool(
  "finish_task",
  {
    title: "Finish Task",
    description: "Finish a DinoBrain task and write a trace/event log entry.",
    inputSchema: {
      task_id: z.string().min(1),
      lease_id: z.string().min(1).optional(),
      terminal_owner_id: z.string().max(240).optional(),
      summary: z.string().min(1),
      outcome: z.enum(["completed", "partial", "blocked"]).default("completed"),
      growth_policy: z.enum(["auto", "trace_only"]).default("auto"),
      changed_files: z.array(z.string()).default([]),
      decisions: z.array(z.string()).default([]),
      next_steps: z.array(z.string()).default([]),
      used_memory_paths: z.array(z.string()).default([]),
      context_pack_paths: z.array(z.string()).default([]),
      session_archive_paths: z.array(z.string()).default([]),
      candidate_paths: z.array(z.string()).default([]),
      search_queries: z.array(z.string()).default([]),
    },
  },
  async ({
    task_id,
    lease_id,
    terminal_owner_id,
    summary,
    outcome,
    growth_policy,
    changed_files,
    decisions,
    next_steps,
    used_memory_paths,
    context_pack_paths,
    session_archive_paths,
    candidate_paths,
    search_queries,
  }) => {
    const terminalWrite = await finishTaskTerminalWrite({
      taskId: task_id,
      leaseId: lease_id,
      terminalOwnerId: terminal_owner_id,
      summary,
      outcome,
      growthPolicy: growth_policy,
      changedFiles: changed_files,
      decisions,
      nextSteps: next_steps,
      usedMemoryPaths: used_memory_paths,
      contextPackPaths: context_pack_paths,
      sessionArchivePaths: session_archive_paths,
      candidatePaths: candidate_paths,
      searchQueries: search_queries,
    });
    if (terminalWrite.idempotent) {
      return jsonResult({
        ok: true,
        idempotent: true,
        task_id,
        task_path: relDataPath(terminalWrite.taskPath),
        trace_path: terminalWrite.traceRelativePath,
        terminal_owner_id: terminalWrite.terminalOwnerId,
        outcome: terminalWrite.outcome,
      });
    }
    const {
      taskPath,
      tracePath,
      taskRelativePath,
      traceRelativePath,
      expectedLeaseId,
      terminalOwnerId,
      finishedAt,
      trace,
      updated,
      normalizedUsedMemoryPaths,
      normalizedContextPackPaths,
      normalizedSessionArchivePaths,
      normalizedCandidatePaths,
      normalizedSearchQueries,
      terminalTransaction,
    } = terminalWrite;
    await upsertOperationTask(DATA_ROOT, taskRelativePath, updated);
    await upsertOperationTrace(DATA_ROOT, traceRelativePath, trace);
    await upsertSqliteOperationTask(DATA_ROOT, taskEntryFromRecord(taskRelativePath, updated));
    await upsertSqliteOperationTrace(DATA_ROOT, traceEntryFromRecord(traceRelativePath, trace));
    const behaviorRecall = await appendBehaviorRecallEntry(
      DATA_ROOT,
      buildFinishBehaviorRecallEntry({
        taskId: task_id,
        outcome,
        summary,
        decisions,
        nextSteps: next_steps,
        usedMemoryPaths: normalizedUsedMemoryPaths,
        contextPackPaths: normalizedContextPackPaths,
        tracePath: traceRelativePath,
        finishedAt,
      }),
    );
    const eventLog = await appendEvent({
      event: "task_finished",
      task_id,
      outcome,
      at: finishedAt,
      trace_path: relDataPath(tracePath),
      behavior_recall_ledger_path: behaviorRecall.ledger_path,
      behavior_recall_id: behaviorRecall.entry.recall_id,
      behavior_recall_trigger: behaviorRecall.entry.trigger_type,
      behavior_recall_decision_status: behaviorRecall.entry.decision_status,
      used_memory_paths: normalizedUsedMemoryPaths,
      context_pack_paths: normalizedContextPackPaths,
      session_archive_paths: normalizedSessionArchivePaths,
      candidate_paths: normalizedCandidatePaths,
      search_query_count: normalizedSearchQueries.length,
      lease_id: expectedLeaseId || null,
      terminal_owner_id: terminalOwnerId,
      terminal_transaction_id: terminalTransaction.transaction_id,
      terminal_transaction_journal: terminalTransaction.journal_path,
    });
    const effectiveGrowthPolicy = growth_policy === "auto" ? envString("DINOBRAIN_FINISH_GROWTH_POLICY", "auto") : growth_policy;
    const traceOnly = effectiveGrowthPolicy === "trace_only";
    const growth = traceOnly
      ? {
          ok: true,
          enabled: false,
          reason: "growth_policy_trace_only",
          created_paths: [],
        }
      : await writeFinishGrowthRecords({
          taskId: task_id,
          taskRecord: updated,
          tracePath: traceRelativePath,
          trace,
          finishedAt,
        });
    let compounding: Record<string, unknown> | null = null;
    if (!traceOnly && envFlag("DINOBRAIN_AUTO_COMPOUND", false)) {
      try {
        const traceLimit = Math.max(1, Math.min(200, Number(process.env.DINOBRAIN_AUTO_COMPOUND_TRACE_LIMIT ?? 50)));
        compounding = await runCompoundingCycleWithIndexRefresh({
          apply: true,
          reviewer: "finish_task:auto-compound",
          traceLimit,
        });
      } catch (error) {
        compounding = {
          ok: false,
          error: safeError(error),
        };
      }
    }
    await registerTaskSyncPaths({
      dataRoot: DATA_ROOT,
      taskId: task_id,
      paths: [taskRelativePath, traceRelativePath],
      source: "finish_task:terminal",
      approval: "system_verified",
      terminal: true,
    });
    const growthPaths = stringList((growth as { created_paths?: unknown }).created_paths);
    if (growthPaths.length > 0) {
      await registerTaskSyncPaths({
        dataRoot: DATA_ROOT,
        taskId: task_id,
        paths: growthPaths,
        source: "finish_task:growth_pending_review",
        approval: "pending_review",
      });
    }
    const compoundingPaths = compoundingSyncPaths(compounding);
    if (compoundingPaths.length > 0) {
      await registerTaskSyncPaths({
        dataRoot: DATA_ROOT,
        taskId: task_id,
        paths: compoundingPaths,
        source: "finish_task:compounding_pending_review",
        approval: "pending_review",
        ignoreMissing: true,
      });
    }
    let autoSync: Record<string, unknown> | null = null;
    if (!traceOnly && envFlag("DINOBRAIN_AUTO_SYNC", false)) {
      try {
        autoSync = await runDataAutoSync({
          taskId: task_id,
          includeSensitiveScan: true,
          allowConditional: envFlag("DINOBRAIN_AUTO_SYNC_ALLOW_CONDITIONAL", false),
          push: envFlag("DINOBRAIN_AUTO_SYNC_PUSH", false),
          commitMessage: `data: auto sync ${safeSlug(task_id).slice(0, 48)}`,
          allowedPaths: [taskRelativePath, traceRelativePath],
        });
      } catch (error) {
        autoSync = {
          ok: false,
          error: safeError(error),
        };
      }
    } else if (traceOnly) {
      autoSync = {
        ok: true,
        skipped: true,
        reason: "growth_policy_trace_only",
      };
    }
    return jsonResult({
      ok: true,
      task_id,
      task_path: taskRelativePath,
      trace_path: traceRelativePath,
      lease_id: expectedLeaseId || null,
      terminal_owner_id: terminalOwnerId,
      event_log: eventLog,
      terminal_transaction: terminalTransaction,
      behavior_recall: {
        ledger_path: behaviorRecall.ledger_path,
        recall_id: behaviorRecall.entry.recall_id,
        trigger_type: behaviorRecall.entry.trigger_type,
        decision_status: behaviorRecall.entry.decision_status,
      },
      growth,
      compounding,
      auto_sync: autoSync,
    });
  },
);

registerTool(
  "audit_memory_use",
  {
    title: "Audit Memory Use",
    description: "Create a short trust audit for whether provided DinoBrain memories were declared and observably used.",
    inputSchema: {
      task_id: z.string().optional(),
      trace_path: z.string().optional(),
      context_pack_paths: z.array(z.string()).default([]),
      expected_memory_paths: z.array(z.string()).default([]),
      observed_artifact_paths: z.array(z.string()).default([]),
      observed_summary: z.string().default(""),
      auditor: z.string().default("memory-audit"),
      notes: z.string().default(""),
    },
  },
  async ({
    task_id,
    trace_path,
    context_pack_paths,
    expected_memory_paths,
    observed_artifact_paths,
    observed_summary,
    auditor,
    notes,
  }) => {
    let plan;
    try {
      plan = await buildMemoryAudit(DATA_ROOT, {
        taskId: task_id,
        tracePath: trace_path,
        contextPackPaths: context_pack_paths,
        expectedMemoryPaths: expected_memory_paths,
        observedArtifactPaths: observed_artifact_paths,
        observedSummary: observed_summary,
        auditor,
        notes,
      });
    } catch (error) {
      return jsonResult({
        ok: false,
        error: (error as Error).message,
      });
    }

    const auditPath = dataPath(plan.auditPath);
    await writeJson(auditPath, plan.audit);
    const eventLog = await appendEvent({
      event: "memory_use_audited",
      audit_id: plan.auditId,
      at: typeof plan.audit.audited_at === "string" ? plan.audit.audited_at : nowIso(),
      task_id: plan.audit.task_id,
      trace_path: plan.audit.trace_path,
      audit_path: plan.auditPath,
      trust_score: plan.audit.trust_score,
      verdict: plan.audit.verdict,
      graph_health_score:
        typeof plan.audit.graph_health_snapshot === "object" &&
        plan.audit.graph_health_snapshot !== null &&
        "score" in plan.audit.graph_health_snapshot
          ? (plan.audit.graph_health_snapshot as { score?: unknown }).score
          : null,
    });

    return jsonResult({
      ok: true,
      audit_id: plan.auditId,
      audit_path: plan.auditPath,
      event_log: eventLog,
      trust_score: plan.audit.trust_score,
      verdict: plan.audit.verdict,
      provided_memory_count: (plan.audit.counts as { provided?: number }).provided ?? 0,
      declared_used_count: (plan.audit.counts as { declared_used?: number }).declared_used ?? 0,
      observed_used_count: (plan.audit.counts as { observed_used?: number }).observed_used ?? 0,
      graph_health_snapshot: plan.audit.graph_health_snapshot,
      missing_expected_memory: plan.audit.missing_expected_memory,
      hallucinated_memory_reference: plan.audit.hallucinated_memory_reference,
      observed_artifacts_verified: plan.audit.observed_artifacts_verified,
      observed_artifacts_unverified: plan.audit.observed_artifacts_unverified,
    });
  },
);

registerTool(
  "get_context_pack",
  {
    title: "Get Context Pack",
    description: "Build a Standard Context Pack from curated DinoBrain records.",
    inputSchema: {
      question: z.string().min(1),
      limit: z.number().int().min(1).max(20).default(7),
      task_id: z.string().optional(),
    },
  },
  async ({ question, limit, task_id }) => {
    const linkedTaskId = task_id?.trim() || "";
    let task: Record<string, unknown> | null = null;
    if (linkedTaskId) {
      task = await readJson<Record<string, unknown>>(dataPath(".dino", "tasks", `${safeSlug(linkedTaskId)}.json`));
      if (!task) throw new Error(`Task does not exist: ${linkedTaskId}`);
      if (firstString(task.status) !== "started") throw new Error(`Task is not active: ${linkedTaskId}`);
    }
    const pack = await buildContextPackRecord(question, limit, linkedTaskId
      ? {
          taskId: linkedTaskId,
          hookRunId: firstString(task?.hook_run_id) || undefined,
          promptHash: firstString(task?.prompt_hash) || undefined,
        }
      : {});
    if (!linkedTaskId) return jsonResult(pack);
    const preflightEventLog = await appendEvent({
      event: "manual_preflight_context_ready",
      task_id: linkedTaskId,
      at: nowIso(),
      context_pack_trace: pack.trace_path,
      context_trace_sha256: pack.trace_sha256,
      context_item_count: pack.item_count,
      hook_run_id: firstString(task?.hook_run_id) || null,
      prompt_hash: firstString(task?.prompt_hash) || null,
      os_version: DINOBRAIN_OS_VERSION,
    });
    await registerTaskSyncPaths({
      dataRoot: DATA_ROOT,
      taskId: linkedTaskId,
      paths: [firstString(pack.trace_path)],
      source: "get_context_pack:task_bound",
      approval: "system_verified",
    });
    return jsonResult({ ...pack, preflight_event_log: preflightEventLog });
  },
);

registerTool(
  "wiki_search",
  {
    title: "Wiki Search",
    description: "Search curated Wiki, Source, Project, and accepted Instance records.",
    inputSchema: {
      query: z.string().min(1),
      limit: z.number().int().min(1).max(50).default(10),
    },
  },
  async ({ query, limit }) => {
    return jsonResult(await buildSearchResult(query, limit));
  },
);

registerTool(
  "search_memory",
  {
    title: "Search Memory",
    description: "Alias for narrow DinoBrain memory search across curated Wiki, Source, Project, and accepted Instance records.",
    inputSchema: {
      query: z.string().min(1),
      limit: z.number().int().min(1).max(50).default(10),
    },
  },
  async ({ query, limit }) => {
    return jsonResult(await buildSearchResult(query, limit));
  },
);

registerTool(
  "search_cold_memory",
  {
    title: "Search Cold Memory",
    description: "Search metadata for time-partitioned cold records excluded from normal prompt retrieval.",
    inputSchema: {
      query: z.string().default(""),
      limit: z.number().int().min(1).max(100).default(20),
    },
  },
  async ({ query, limit }) => {
    const results = await searchColdPartitions(DATA_ROOT, query, limit);
    return jsonResult({
      ok: true,
      query,
      result_count: results.length,
      retrieval_mode: "cold_partition_metadata_only",
      excluded_from_default_context: true,
      results,
    });
  },
);

registerTool(
  "os_gate",
  {
    title: "OS Action Gate",
    description: "Evaluate DinoBrain OS v2 action gates and write a gate report.",
    inputSchema: {
      request: z.string().min(1),
      task_id: z.string().optional(),
      context_pack_path: z.string().optional(),
      allowed_paths: z.array(z.string()).default([]),
      allow_conditional: z.boolean().default(false),
      context_item_count: z.number().int().min(0).default(0),
      has_context_pack: z.boolean().default(false),
      sensitivity: z.enum(["normal", "sensitive", "unknown"]).default("unknown"),
      backup_risk: z.boolean().optional(),
    },
  },
  async ({
    request,
    task_id,
    context_pack_path,
    allowed_paths,
    allow_conditional,
    context_item_count,
    has_context_pack,
    sensitivity,
    backup_risk,
  }) => {
    const sanitized = sanitizeTaskRequest(request);
    const gateTaskId = task_id?.trim() || makeTaskId(sanitized.request);
    const contextEvidence = await deriveGateContextEvidence({
      taskId: gateTaskId,
      contextPackPath: context_pack_path,
      declaredHasContextPack: has_context_pack,
      declaredContextItemCount: context_item_count,
    });
    const syncObservation = await observeGateSyncRisk(request, {
      taskId: task_id?.trim() || undefined,
      allowedPaths: allowed_paths,
      allowConditional: allow_conditional,
    });
    const gates = evaluateActionGates({
      request,
      hasContextPack: contextEvidence.hasContextPack,
      contextItemCount: contextEvidence.contextItemCount,
      contextTraceVerified: contextEvidence.contextTraceVerified,
      contextTraceFresh: contextEvidence.contextTraceFresh,
      preflightEventOrderVerified: contextEvidence.eventOrderVerified,
      sensitivity,
      exposedTools: observedOsTools(),
      syncObservation,
    });
    const gateReportPath = await writeGateReport(gateTaskId, {
      task_id: gateTaskId,
      request: sanitized.request,
      request_hash: sanitized.request_hash,
      request_redactions: sanitized.redactions,
      generated_at: nowIso(),
      context_pack_path: contextEvidence.contextPackPath,
      context_verification_status: contextEvidence.verificationStatus,
      context_evidence: contextEvidence,
      declared_has_context_pack: contextEvidence.declaredHasContextPack,
      declared_context_item_count: contextEvidence.declaredContextItemCount,
      verified_context_item_count: contextEvidence.contextItemCount,
      context_declaration_mismatch: contextEvidence.declarationMismatch,
      declared_backup_risk: backup_risk ?? null,
      requested_allowed_paths: allowed_paths,
      allow_conditional,
      backup_risk_source: "os_observed_sync_plan",
      observed_tools: observedOsTools(),
      sync_observation: syncObservation,
      ...gates,
    });
    const eventLog = await appendEvent({
      event: "os_gate_evaluated",
      task_id: gateTaskId,
      at: nowIso(),
      gate_status: gates.status,
      action_decision: gates.action_decision,
      fail_closed: gates.fail_closed,
      reason_codes: gates.reason_codes,
      gate_report_path: gateReportPath,
      context_pack_path: contextEvidence.contextPackPath,
      context_verification_status: contextEvidence.verificationStatus,
      context_trace_fresh: contextEvidence.contextTraceFresh,
      preflight_event_order_verified: contextEvidence.eventOrderVerified,
      context_declaration_mismatch: contextEvidence.declarationMismatch,
      os_version: DINOBRAIN_OS_VERSION,
    });
    if (task_id?.trim()) {
      await registerTaskSyncPaths({
        dataRoot: DATA_ROOT,
        taskId: gateTaskId,
        paths: [gateReportPath, contextEvidence.contextPackPath ?? ""].filter(Boolean),
        source: "os_gate:task_bound",
        approval: "system_verified",
        ignoreMissing: true,
      });
    }
    return jsonResult({
      ok: !gates.fail_closed,
      os_version: DINOBRAIN_OS_VERSION,
      gate_status: gates.status,
      gate_report_path: gateReportPath,
      event_log: eventLog,
      context_pack_path: contextEvidence.contextPackPath,
      context_verification_status: contextEvidence.verificationStatus,
      context_trace_sha256: contextEvidence.contextTraceSha256,
      context_trace_fresh: contextEvidence.contextTraceFresh,
      context_age_ms: contextEvidence.contextAgeMs,
      preflight_event_order_verified: contextEvidence.eventOrderVerified,
      preflight_event_order: contextEvidence.eventOrder,
      context_evidence_reason_codes: contextEvidence.reasonCodes,
      context_declaration_mismatch: contextEvidence.declarationMismatch,
      declared_has_context_pack: contextEvidence.declaredHasContextPack,
      declared_context_item_count: contextEvidence.declaredContextItemCount,
      verified_context_item_count: contextEvidence.contextItemCount,
      declared_backup_risk: backup_risk ?? null,
      backup_risk_source: "os_observed_sync_plan",
      observed_tools: observedOsTools(),
      sync_observation: syncObservation,
      ...gates,
    });
  },
);

registerTool(
  "apply_node_lifecycle",
  {
    title: "Apply Node Lifecycle",
    description: "Dry-run, apply, or exactly roll back DinoBrain memory lifecycle migrations.",
    inputSchema: {
      apply: z.boolean().default(false),
      reviewer: z.string().default("node-lifecycle-v3"),
      rollback_transaction_id: z.string().regex(/^node-lifecycle-[A-Za-z0-9-]+$/).optional(),
    },
  },
  async ({ apply, reviewer, rollback_transaction_id }) => {
    if (apply && rollback_transaction_id) throw new Error("Use apply or rollback_transaction_id, not both.");
    const report = await applyNodeLifecycle(DATA_ROOT, {
      apply,
      reviewer,
      rollbackTransactionId: rollback_transaction_id,
    });
    if (apply || rollback_transaction_id) {
      await invalidateWikiIndex(DATA_ROOT);
      await invalidateSqliteWikiShard(DATA_ROOT);
    }
    const eventLog = await appendEvent({
      event: rollback_transaction_id ? "node_lifecycle_rolled_back" : apply ? "node_lifecycle_applied" : "node_lifecycle_checked",
      at: nowIso(),
      lifecycle_id: report.lifecycle_id,
      lifecycle_path: report.lifecycle_path,
      apply,
      rollback_transaction_id: rollback_transaction_id ?? null,
      status: report.status,
      counts: report.counts,
      os_version: DINOBRAIN_OS_VERSION,
    });
    return jsonResult({
      ...report,
      event_log: eventLog,
    });
  },
);

registerTool(
  "apply_review_backpressure",
  {
    title: "Apply Review Backpressure",
    description: "Dry-run, apply, or roll back deterministic holds and provenance-preserving duplicate review merges.",
    inputSchema: {
      apply_holds: z.boolean().default(false),
      apply_merge_reviews: z.boolean().default(false),
      reviewer: z.string().default("review-backpressure"),
      rollback_transaction_id: z.string().regex(/^node-lifecycle-[A-Za-z0-9-]+$/).optional(),
    },
  },
  async ({ apply_holds, apply_merge_reviews, reviewer, rollback_transaction_id }) => {
    if (rollback_transaction_id && (apply_holds || apply_merge_reviews)) {
      throw new Error("Use apply flags or rollback_transaction_id, not both.");
    }
    const result = await buildReviewWorklistActions(DATA_ROOT, {
      applyHolds: apply_holds,
      applyMergeReviews: apply_merge_reviews,
      reviewer,
      rollbackTransactionId: rollback_transaction_id,
    });
    await invalidateWikiIndex(DATA_ROOT);
    await invalidateSqliteWikiShard(DATA_ROOT);
    const queue = await buildReviewQueueBackpressure(DATA_ROOT, { reconcileAdmission: true });
    const eventLog = await appendEvent({
      event: rollback_transaction_id
        ? "review_backpressure_rolled_back"
        : apply_holds || apply_merge_reviews
          ? "review_backpressure_applied"
          : "review_backpressure_checked",
      at: nowIso(),
      status: result.report.status,
      transaction_id: result.report.transaction_id,
      rollback_transaction_id: rollback_transaction_id ?? null,
      counts: result.report.counts,
      queue_status: queue.report.status,
      os_version: DINOBRAIN_OS_VERSION,
    });
    return jsonResult({ ok: result.report.counts.skipped === 0, ...result.report, queue: queue.report, event_log: eventLog });
  },
);

registerTool(
  "apply_cold_partitions",
  {
    title: "Apply Cold Partitions",
    description: "Dry-run, apply, or roll back logical time partitioning for old operations and obsolete rules.",
    inputSchema: {
      apply: z.boolean().default(false),
      rollback_transaction_id: z.string().regex(/^node-lifecycle-[A-Za-z0-9-]+$/).optional(),
    },
  },
  async ({ apply, rollback_transaction_id }) => {
    if (apply && rollback_transaction_id) throw new Error("Use apply or rollback_transaction_id, not both.");
    const result = await applyColdPartitions(DATA_ROOT, { apply, rollbackTransactionId: rollback_transaction_id });
    await invalidateWikiIndex(DATA_ROOT);
    await invalidateSqliteWikiShard(DATA_ROOT);
    const eventLog = await appendEvent({
      event: rollback_transaction_id ? "cold_partitions_rolled_back" : apply ? "cold_partitions_applied" : "cold_partitions_checked",
      at: nowIso(),
      status: result.report.status,
      transaction_id: result.report.transaction_id,
      rollback_transaction_id: rollback_transaction_id ?? null,
      counts: result.report.counts,
      os_version: DINOBRAIN_OS_VERSION,
    });
    return jsonResult({ ok: result.report.status !== "needs_apply", ...result.report, event_log: eventLog });
  },
);

registerTool(
  "transition_memory_node",
  {
    title: "Transition Memory Node",
    description: "Apply one verified lifecycle transition to a JSON memory node.",
    inputSchema: {
      target_path: z.string().min(1),
      to_state: z.enum(NODE_LIFECYCLE_STATES),
      reason_code: z.string().min(1),
      reason: z.string().min(1),
      actor: z.string().default("manual-lifecycle-review"),
      evidence_paths: z.array(z.string()).default([]),
      predecessor_paths: z.array(z.string()).default([]),
      successor_paths: z.array(z.string()).default([]),
      expected_before_sha256: z.string().regex(/^[a-f0-9]{64}$/i).optional(),
    },
  },
  async ({
    target_path,
    to_state,
    reason_code,
    reason,
    actor,
    evidence_paths,
    predecessor_paths,
    successor_paths,
    expected_before_sha256,
  }) => {
    const targetPath = normalizeVaultPath(target_path);
    const result = await transitionNodeLifecycleFile(DATA_ROOT, {
      target_path: targetPath,
      to_state,
      reason_code,
      reason,
      actor,
      evidence_paths: normalizeVaultPaths(evidence_paths),
      predecessor_paths: normalizeVaultPaths(predecessor_paths),
      successor_paths: normalizeVaultPaths(successor_paths),
      expected_before_sha256,
    });
    await invalidateWikiIndex(DATA_ROOT);
    await invalidateSqliteWikiShard(DATA_ROOT);
    const eventLog = await appendEvent({
      event: "memory_node_transitioned",
      at: nowIso(),
      target_path: targetPath,
      to_state,
      transition_id: result.transition_id,
      transaction_id: result.transaction_id,
      idempotent: result.idempotent,
      actor,
      os_version: DINOBRAIN_OS_VERSION,
    });
    return jsonResult({ ok: true, ...result, event_log: eventLog });
  },
);

registerTool(
  "restore_memory_node",
  {
    title: "Restore Memory Node",
    description: "Restore a deleted tombstone from its exact local backup into deletion-proposed review state.",
    inputSchema: {
      target_path: z.string().min(1),
      deletion_transition_id: z.string().min(1),
      reason: z.string().min(1),
      actor: z.string().default("manual-lifecycle-review"),
      evidence_paths: z.array(z.string()).default([]),
    },
  },
  async ({ target_path, deletion_transition_id, reason, actor, evidence_paths }) => {
    const targetPath = normalizeVaultPath(target_path);
    const result = await restoreDeletedNode(DATA_ROOT, {
      target_path: targetPath,
      deletion_transition_id,
      reason,
      actor,
      evidence_paths: normalizeVaultPaths(evidence_paths),
    });
    await invalidateWikiIndex(DATA_ROOT);
    await invalidateSqliteWikiShard(DATA_ROOT);
    const eventLog = await appendEvent({
      event: "memory_node_restored",
      at: nowIso(),
      target_path: targetPath,
      deletion_transition_id,
      restore_transition_id: result.transition_id,
      transaction_id: result.transaction_id,
      actor,
      os_version: DINOBRAIN_OS_VERSION,
    });
    return jsonResult({ ok: true, ...result, event_log: eventLog });
  },
);

registerTool(
  "create_source_chunk",
  {
    title: "Create Source Chunk",
    description: "Transactionally publish a fetched source, verified chunk, provenance, and hash-bound claim support.",
    inputSchema: {
      source_title: z.string().min(1),
      source_uri: z.string().min(1),
      chunk_text: z.string().min(1),
      chunk_type: z.enum(["external_doc", "paper", "community", "internal_doc", "conversation_excerpt"]).default("external_doc"),
      claim_paths: z.array(z.string()).default([]),
      evidence_paths: z.array(z.string()).default([]),
      tags: z.array(z.string()).default([]),
      verification_status: z
        .enum(["anchor_only_unverified", "fetched_unverified", "verified_chunk", "verified_summary", "reviewed_source_chunk"])
        .default("fetched_unverified"),
      last_verified: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      fetched_at: z.string().datetime().optional(),
      verification_method: z.string().min(1).optional(),
      verification_actor: z.string().min(1).optional(),
      source_content_sha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
      source_content_length: z.number().int().nonnegative().optional(),
      source_content_scope: z.enum(["full_response", "bounded_excerpt", "verified_summary"]).default("bounded_excerpt"),
    },
  },
  async ({
    source_title,
    source_uri,
    chunk_text,
    chunk_type,
    claim_paths,
    evidence_paths,
    tags,
    verification_status,
    last_verified,
    fetched_at,
    verification_method,
    verification_actor,
    source_content_sha256,
    source_content_length,
    source_content_scope,
  }) => {
    const sanitizedSourceTitle = redactSensitiveText(source_title).text;
    const sanitizedSourceUri = redactSensitiveText(source_uri).text;
    const chunkId = makeSourceChunkId(source_title, source_uri);
    const createdAt = nowIso();
    const normalizedClaimPaths = normalizeVaultPaths(claim_paths);
    const sanitizedChunk = redactSensitiveText(chunk_text);
    const publication = await publishSourceLineage(DATA_ROOT, {
      source_chunk_id: chunkId,
      source_title: sanitizedSourceTitle,
      source_uri: sanitizedSourceUri,
      chunk_type,
      chunk_text: sanitizedChunk.text,
      claim_paths: normalizedClaimPaths,
      evidence_paths: normalizeVaultPaths(evidence_paths),
      tags: redactMachineLocalValue(tags),
      verification_status,
      last_verified,
      fetched_at,
      verification_method,
      verification_actor,
      source_content_sha256: source_content_sha256 ?? sha256(chunk_text),
      source_content_length: source_content_length ?? chunk_text.length,
      source_content_scope,
      chunk_text_redactions: sanitizedChunk.redactions,
      chunk_text_truncated: sanitizedChunk.truncated,
      chunk_text_original_length: chunk_text.length,
      chunk_text_stored_length: sanitizedChunk.text.length,
      actor: "create_source_chunk",
    });
    await invalidateWikiIndex(DATA_ROOT);
    await invalidateSqliteWikiShard(DATA_ROOT);
    const eventLog = await appendEvent({
      event: publication.content_changed || publication.support_bindings_changed ? "source_chunk_reverified" : "source_lineage_published",
      source_chunk_id: chunkId,
      at: createdAt,
      source_snapshot_path: publication.source_snapshot_path,
      source_chunk_path: publication.source_chunk_path,
      provenance_path: publication.provenance_path,
      generation_id: publication.generation_id,
      generation_receipt_path: publication.generation_receipt_path,
      transaction_id: publication.transaction_id,
      claim_paths: normalizedClaimPaths,
      verification_status,
      content_changed: publication.content_changed,
      support_bindings_changed: publication.support_bindings_changed,
      idempotent: publication.idempotent,
      redactions: sanitizedChunk.redactions,
      truncated: sanitizedChunk.truncated,
      os_version: DINOBRAIN_OS_VERSION,
    });
    return jsonResult({
      ok: true,
      source_chunk_id: chunkId,
      source_snapshot_path: publication.source_snapshot_path,
      source_chunk_path: publication.source_chunk_path,
      provenance_path: publication.provenance_path,
      generation_id: publication.generation_id,
      generation_receipt_path: publication.generation_receipt_path,
      transaction_id: publication.transaction_id,
      transaction_path: publication.transaction_path,
      verification_status,
      content_changed: publication.content_changed,
      support_bindings_changed: publication.support_bindings_changed,
      idempotent: publication.idempotent,
      redactions: sanitizedChunk.redactions,
      truncated: sanitizedChunk.truncated,
      event_log: eventLog,
    });
  },
);

type CorrectionPromptBinding = {
  binding_status: "verified" | "missing_task_id" | "task_not_found" | "prompt_hash_unverified";
  task_id: string | null;
  task_path: string | null;
  prompt_hash: string | null;
  request_hash: string | null;
  prompt_classification: string | null;
  prompt_eligibility_version: string | null;
  launch_kind: string | null;
  launch_source: string | null;
  verified_at: string;
};

async function correctionPromptBinding(taskId: string | undefined, verifiedAt: string): Promise<CorrectionPromptBinding> {
  const normalizedTaskId = firstString(taskId);
  if (!normalizedTaskId) {
    return {
      binding_status: "missing_task_id",
      task_id: null,
      task_path: null,
      prompt_hash: null,
      request_hash: null,
      prompt_classification: null,
      prompt_eligibility_version: null,
      launch_kind: null,
      launch_source: null,
      verified_at: verifiedAt,
    };
  }
  const taskRelativePath = `.dino/tasks/${safeSlug(normalizedTaskId)}.json`;
  const task = await readJson<Record<string, unknown>>(dataPath(taskRelativePath));
  if (!task || firstString(task.task_id) !== normalizedTaskId) {
    return {
      binding_status: "task_not_found",
      task_id: normalizedTaskId,
      task_path: taskRelativePath,
      prompt_hash: null,
      request_hash: null,
      prompt_classification: null,
      prompt_eligibility_version: null,
      launch_kind: null,
      launch_source: null,
      verified_at: verifiedAt,
    };
  }
  const promptHash = firstString(task.prompt_hash);
  const request = firstString(task.request);
  const promptHashVerified = /^[a-f0-9]{64}$/i.test(promptHash) && request.length > 0 && sha256(request) === promptHash;
  return {
    binding_status: promptHashVerified ? "verified" : "prompt_hash_unverified",
    task_id: normalizedTaskId,
    task_path: taskRelativePath,
    prompt_hash: promptHash || null,
    request_hash: firstString(task.request_hash) || null,
    prompt_classification: firstString(task.prompt_classification) || null,
    prompt_eligibility_version: firstString(task.prompt_eligibility_version) || null,
    launch_kind: firstString(task.launch_kind) || null,
    launch_source: firstString(task.launch_source) || null,
    verified_at: verifiedAt,
  };
}

async function correctionConflictPaths(params: {
  correction: string;
  appliesTo: string;
  acceptedPath: string;
  explicitPaths: string[];
}): Promise<{ paths: string[]; inferred_paths: string[]; invalid_paths: string[] }> {
  const inferred = await findPotentialBehaviorConflicts(DATA_ROOT, params.correction, params.acceptedPath, params.appliesTo);
  const paths = normalizeVaultPaths([...params.explicitPaths, ...inferred]).slice(0, 12);
  const valid: string[] = [];
  const invalid: string[] = [];
  for (const targetPath of paths) {
    if (!targetPath.startsWith("50_Instances/accepted/") || targetPath === params.acceptedPath) {
      invalid.push(targetPath);
      continue;
    }
    try {
      const state = await currentNodeRecord(DATA_ROOT, targetPath);
      if (state.state === "accepted") valid.push(targetPath);
      else invalid.push(targetPath);
    } catch {
      invalid.push(targetPath);
    }
  }
  return { paths: valid, inferred_paths: inferred.filter((targetPath) => valid.includes(targetPath)), invalid_paths: invalid };
}

registerTool(
  "record_feedback_correction",
  {
    title: "Record Feedback Correction",
    description: "Create a provenance-backed review candidate from direct user correction.",
    inputSchema: {
      correction: z.string().min(1),
      applies_to: z.string().default("agent_behavior"),
      task_id: z.string().optional(),
      tags: z.array(z.string()).default([]),
      contradicted_memory_paths: z.array(z.string()).max(12).default([]),
      behavior_action: z.object({
        memory_off_action: z.string().min(1),
        expected_memory_on_action: z.string().min(1),
      }).optional(),
    },
  },
  async ({ correction, applies_to, task_id, tags, contradicted_memory_paths, behavior_action }) => {
    const feedbackId = makeFeedbackId(correction);
    const createdAt = nowIso();
    const candidatePath = dataPath("50_Instances", "candidates", `${feedbackId}.json`);
    const reviewPath = dataPath("80_Review_Queue", "promotion", `${feedbackId}.json`);
    const provenancePath = dataPath(".dino", "provenance", `${feedbackId}.json`);
    const candidateRelativePath = relDataPath(candidatePath);
    const reviewRelativePath = relDataPath(reviewPath);
    const provenanceRelativePath = relDataPath(provenancePath);
    const sourcePromptMetadata = await correctionPromptBinding(task_id, createdAt);
    const conflicts = await correctionConflictPaths({
      correction,
      appliesTo: applies_to,
      acceptedPath: `50_Instances/accepted/${feedbackId}.json`,
      explicitPaths: contradicted_memory_paths,
    });
    if (conflicts.invalid_paths.length > 0) {
      return jsonResult({
        ok: false,
        error: "invalid_contradicted_memory_paths",
        invalid_paths: conflicts.invalid_paths,
        safe_action: "Use only existing accepted behavior-memory paths that are still in accepted lifecycle state.",
      });
    }
    const provenanceRecord = {
      provenance_id: feedbackId,
      type: "user_feedback_provenance",
      status: "active",
      source_kind: "direct_user_correction",
      task_id: task_id ?? null,
      correction_sha256: sha256(correction),
      source_prompt_metadata: sourcePromptMetadata,
      contradicted_memory_paths: conflicts.paths,
      created_at: createdAt,
      updated_at: createdAt,
    };
    const candidate = {
      candidate_id: feedbackId,
      feedback_id: feedbackId,
      type: "feedback_correction",
      status: "pending_review",
      claim: correction,
      behavior_rule: correction,
      applies_to,
      evidence: {
        source: provenanceRelativePath,
        snippet: correction.slice(0, 600),
      },
      provenance_paths: [provenanceRelativePath],
      source_status: "internal",
      confidence: "high",
      last_verified: dateStamp(),
      tags: Array.from(new Set(["feedback", "correction", "behavior", ...tags])),
      task_id: task_id ?? null,
      source_prompt_metadata: sourcePromptMetadata,
      contradicted_memory_paths: conflicts.paths,
      conflict_detection: {
        explicit_count: normalizeVaultPaths(contradicted_memory_paths).length,
        inferred_count: conflicts.inferred_paths.length,
        verified_count: conflicts.paths.length,
      },
      behavior_action: behavior_action ?? null,
      auto_promote: false,
      promotion_blockers: [
        "manual_review_required",
        "correction_conflict_resolution_required",
        ...(sourcePromptMetadata.binding_status === "verified" ? [] : ["source_prompt_metadata_required"]),
      ],
      created_at: createdAt,
      updated_at: createdAt,
    };
    const review = {
      review_id: feedbackId,
      type: "correction_promotion",
      status: "pending",
      candidate_path: candidateRelativePath,
      provenance_path: provenanceRelativePath,
      contradicted_memory_paths: conflicts.paths,
      source_prompt_binding_status: sourcePromptMetadata.binding_status,
      required_checks: ["direct_user_correction", "source_prompt_binding", "conflicting_memory_review", "scope", "sensitivity"],
      created_at: createdAt,
      updated_at: createdAt,
    };
    const reviewAdmission = await writeReviewGatedBatch(DATA_ROOT, {
      items: [
        {
          idempotency_key: `feedback-candidate|${feedbackId}`,
          lane: "correction",
          candidate_path: candidateRelativePath,
          candidate_record: candidate,
          review_path: reviewRelativePath,
          review_record: review,
          candidate_evidence_paths: [provenanceRelativePath],
          review_evidence_paths: [candidateRelativePath, provenanceRelativePath],
          predecessor_paths: sourcePromptMetadata.binding_status === "verified" && sourcePromptMetadata.task_path
            ? [sourcePromptMetadata.task_path]
            : [],
          at: createdAt,
        },
      ],
      extra_writes: [{ target_path: provenanceRelativePath, record: provenanceRecord }],
      actor: "record_feedback_correction",
      reason: `Create feedback correction candidate ${feedbackId}.`,
    });
    const eventLog = await appendEvent({
      event: "feedback_correction_candidate_created",
      feedback_id: feedbackId,
      at: createdAt,
      candidate_path: candidateRelativePath,
      review_path: reviewRelativePath,
      provenance_path: provenanceRelativePath,
      task_id: task_id ?? null,
      source_prompt_binding_status: sourcePromptMetadata.binding_status,
      contradicted_memory_paths: conflicts.paths,
      lifecycle_transaction_id: reviewAdmission.lifecycle_transaction.transaction_id,
      queue_destination: reviewAdmission.decisions[0]?.destination,
      os_version: DINOBRAIN_OS_VERSION,
    });
    return jsonResult({
      ok: true,
      feedback_id: feedbackId,
      candidate_path: candidateRelativePath,
      review_path: reviewRelativePath,
      provenance_path: provenanceRelativePath,
      accepted_path: null,
      source_prompt_binding_status: sourcePromptMetadata.binding_status,
      contradicted_memory_paths: conflicts.paths,
      lifecycle_transaction: reviewAdmission.lifecycle_transaction,
      queue_admission: reviewAdmission.decisions[0],
      event_log: eventLog,
      next_context_effect: "available only after review_candidate approves the correction",
    });
  },
);

registerTool(
  "evaluate_behavior",
  {
    title: "Evaluate Behavior",
    description: "Evaluate whether memory-on behavior beats memory-off baseline for golden OS behavior cases.",
    inputSchema: {
      golden_path: z.string().optional(),
      pack_limit: z.number().int().min(1).max(20).default(8),
    },
  },
  async ({ golden_path, pack_limit }) => {
    const report = await evaluateBehaviorMemoryLift(DATA_ROOT, {
      goldenPath: golden_path ? dataPath(normalizeVaultPath(golden_path)) : undefined,
      packLimit: pack_limit,
    });
    const evalId = `behavior-eval-${new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "-")}`;
    const evalPath = dataPath(".dino", "evaluations", `${evalId}.json`);
    await writeJson(evalPath, {
      evaluation_id: evalId,
      os_version: DINOBRAIN_OS_VERSION,
      ...report,
    });
    const eventLog = await appendEvent({
      event: "behavior_eval_completed",
      evaluation_id: evalId,
      at: nowIso(),
      evaluation_path: relDataPath(evalPath),
      ok: report.ok,
      average_memory_lift: report.average_memory_lift,
      os_version: DINOBRAIN_OS_VERSION,
    });
    return jsonResult({
      ...report,
      evaluation_path: relDataPath(evalPath),
      event_log: eventLog,
    });
  },
);

registerTool(
  "import_session",
  {
    title: "Import Session",
    description: "Import a redacted session excerpt and extract pending-review memory candidates.",
    inputSchema: {
      source: z.string().min(1).default("manual"),
      project: z.string().optional(),
      title: z.string().optional(),
      transcript: z.string().optional(),
      messages: z
        .array(
          z.object({
            role: z.enum(["user", "assistant", "system", "tool", "unknown"]).default("unknown"),
            content: z.string().min(1),
            at: z.string().optional(),
          }),
        )
        .optional(),
      sensitivity: z.enum(["normal", "sensitive", "unknown"]).default("unknown"),
      max_candidates: z.number().int().min(1).max(50).default(12),
      raw_retention: z.enum(["metadata_only", "redacted_excerpt"]).default("redacted_excerpt"),
      task_id: z.string().optional(),
    },
  },
  async ({ source, project, title, transcript, messages, sensitivity, max_candidates, raw_retention, task_id }) => {
    let plan;
    try {
      plan = buildSessionImportPlan({
        source,
        project,
        title,
        transcript,
        messages: messages as SessionMessageInput[] | undefined,
        sensitivity,
        maxCandidates: max_candidates,
        rawRetention: raw_retention,
      });
    } catch (error) {
      return jsonResult({
        ok: false,
        error: (error as Error).message,
      });
    }

    const importedAt = typeof plan.archive.imported_at === "string" ? plan.archive.imported_at : nowIso();
    const reviewItems = [];
    for (const candidate of plan.candidates) {
      const existingCandidate = await readJson<Record<string, unknown>>(dataPath(candidate.candidatePath));
      const existingReview = await readJson<Record<string, unknown>>(dataPath(candidate.reviewPath));
      const candidateRecord = mergePreservingNodeLifecycle(existingCandidate, {
        ...candidate.candidate,
        task_id: task_id ?? null,
      });
      const reviewRecord = mergePreservingNodeLifecycle(existingReview, {
        ...candidate.review,
        task_id: task_id ?? null,
      });
      reviewItems.push({
        idempotency_key: `session-candidate|${candidate.candidateId}`,
        lane: "manual_semantic" as const,
        candidate_path: candidate.candidatePath,
        candidate_record: candidateRecord,
        review_path: candidate.reviewPath,
        review_record: reviewRecord,
        candidate_evidence_paths: [plan.archivePath],
        review_evidence_paths: [plan.archivePath, candidate.candidatePath],
        predecessor_paths: [plan.archivePath],
        at: importedAt,
      });
    }
    const reviewAdmission = await writeReviewGatedBatch(DATA_ROOT, {
      items: reviewItems,
      extra_writes: [{ target_path: plan.archivePath, record: { ...plan.archive, task_id: task_id ?? null } }],
      actor: "import_session",
      reason: `Register session ${plan.sessionId} and its review-gated candidates.`,
    });
    const eventLog = await appendEvent({
      event: "session_imported",
      session_id: plan.sessionId,
      at: importedAt,
      source,
      project: project ?? null,
      archive_path: plan.archivePath,
      raw_retention,
      raw_full_transcript_stored: false,
      candidate_count: plan.candidates.length,
      temperature_counts: plan.stats.temperature_counts,
      category_counts: plan.stats.category_counts,
      redaction_hits: plan.stats.redaction_hits,
    });
    if (task_id) {
      await registerTaskSyncPaths({
        dataRoot: DATA_ROOT,
        taskId: task_id,
        paths: [
          plan.archivePath,
          ...plan.candidates.map((candidate) => candidate.candidatePath),
          ...plan.candidates.map((candidate) => candidate.reviewPath),
        ],
        source: "import_session:pending_review",
        approval: "pending_review",
      });
    }

    return jsonResult({
      ok: true,
      session_id: plan.sessionId,
      archive_path: plan.archivePath,
      event_log: eventLog,
      raw_retention,
      raw_full_transcript_stored: false,
      sync_policy: "local_only",
      candidate_count: plan.candidates.length,
      candidate_paths: plan.candidates.map((candidate) => candidate.candidatePath),
      review_paths: plan.candidates.map((candidate) => candidate.reviewPath),
      lifecycle_transaction: reviewAdmission.lifecycle_transaction,
      queue_admission: reviewAdmission.decisions,
      temperature_counts: plan.stats.temperature_counts,
      category_counts: plan.stats.category_counts,
      redaction_hits: plan.stats.redaction_hits,
      next_step: "Review candidates with review_candidate before they can enter accepted memory.",
    });
  },
);

registerTool(
  "create_candidate_instance",
  {
    title: "Create Candidate Instance",
    description: "Create a reviewed-by-default memory candidate with required evidence metadata.",
    inputSchema: {
      claim: z.string().min(1),
      evidence_snippet: z.string().min(1),
      evidence_source: z.string().min(1),
      confidence: z.enum(["low", "medium", "high"]),
      last_verified: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      source_status: z.enum(["internal", "external", "mixed", "unknown"]).default("unknown"),
      provenance_paths: z.array(z.string()).default([]),
      tags: z.array(z.string()).default([]),
      task_id: z.string().optional(),
      sensitivity: z.enum(["normal", "sensitive", "unknown"]).default("unknown"),
    },
  },
  async ({
    claim,
    evidence_snippet,
    evidence_source,
    confidence,
    last_verified,
    source_status,
    provenance_paths,
    tags,
    task_id,
    sensitivity,
  }) => {
    const candidateId = makeCandidateId(claim);
    const createdAt = nowIso();
    const candidatePath = dataPath("50_Instances", "candidates", `${candidateId}.json`);
    const reviewPath = dataPath("80_Review_Queue", "promotion", `${candidateId}.json`);
    const candidate = {
      candidate_id: candidateId,
      status: "pending_review",
      claim,
      evidence: {
        snippet: evidence_snippet,
        source: evidence_source,
      },
      confidence,
      last_verified,
      source_status,
      provenance_paths: normalizeVaultPaths(provenance_paths),
      tags,
      task_id: task_id ?? null,
      sensitivity,
      auto_promote: false,
      promotion_blockers: ["manual_review_required"],
      created_at: createdAt,
      updated_at: createdAt,
    };
    const review = {
      review_id: candidateId,
      type: "promotion",
      status: "pending",
      candidate_path: relDataPath(candidatePath),
      required_checks: ["evidence_snippet", "confidence", "last_verified", "sensitivity"],
      created_at: createdAt,
      updated_at: createdAt,
    };
    const candidateRelativePath = relDataPath(candidatePath);
    const reviewRelativePath = relDataPath(reviewPath);
    const reviewAdmission = await writeReviewGatedBatch(DATA_ROOT, {
      items: [
        {
          idempotency_key: `candidate-created|${candidateId}`,
          lane: "manual_semantic",
          candidate_path: candidateRelativePath,
          candidate_record: candidate,
          review_path: reviewRelativePath,
          review_record: review,
          candidate_evidence_paths: normalizeVaultPaths(provenance_paths),
          review_evidence_paths: [candidateRelativePath, ...normalizeVaultPaths(provenance_paths)],
          at: createdAt,
        },
      ],
      actor: "create_candidate_instance",
      reason: `Create candidate and bounded review ${candidateId}.`,
    });
    await appendEvent({
      event: "candidate_instance_created",
      candidate_id: candidateId,
      at: createdAt,
      candidate_path: relDataPath(candidatePath),
      review_path: relDataPath(reviewPath),
      lifecycle_transaction: reviewAdmission.lifecycle_transaction,
      queue_admission: reviewAdmission.decisions[0],
    });
    if (task_id) {
      await registerTaskSyncPaths({
        dataRoot: DATA_ROOT,
        taskId: task_id,
        paths: [candidateRelativePath, reviewRelativePath],
        source: "create_candidate_instance:pending_review",
        approval: "pending_review",
      });
    }
    return jsonResult({
      ok: true,
      candidate_id: candidateId,
      candidate_path: relDataPath(candidatePath),
      review_path: relDataPath(reviewPath),
      auto_promote: false,
      destination: reviewAdmission.decisions[0]?.destination,
      reason:
        reviewAdmission.decisions[0]?.destination === "hot_review"
          ? "Candidate entered the bounded Review Queue."
          : "Candidate was preserved in cold hold because the Review Queue is constrained.",
    });
  },
);

registerTool(
  "review_candidate",
  {
    title: "Review Candidate",
    description: "Approve or reject a candidate instance from the Review Queue.",
    inputSchema: {
      candidate_id: z.string().min(1),
      decision: z.enum(["approve", "reject"]),
      reviewer: z.string().default("manual-review"),
      notes: z.string().default(""),
      correction_resolution: z.enum(["hold_superseded", "demote_superseded", "no_conflict"]).optional(),
      compounding_scope_approved: z.boolean().default(false),
    },
  },
  async ({ candidate_id, decision, reviewer, notes, correction_resolution, compounding_scope_approved }) => {
    reviewer = redactSensitiveText(reviewer).text;
    notes = redactSensitiveText(notes).text;
    const candidateId = safeSlug(candidate_id);
    const candidatePath = dataPath("50_Instances", "candidates", `${candidateId}.json`);
    const reviewPath = dataPath("80_Review_Queue", "promotion", `${candidateId}.json`);
    const candidateRelativePath = relDataPath(candidatePath);
    const reviewRelativePath = relDataPath(reviewPath);
    const acceptedPath = dataPath("50_Instances", "accepted", `${candidateId}.json`);
    const acceptedRelativePath = relDataPath(acceptedPath);
    let candidateState;
    let reviewState;
    try {
      candidateState = await currentNodeRecord(DATA_ROOT, candidateRelativePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return jsonResult({
        ok: false,
        candidate_id: candidateId,
        error: "candidate_not_found",
      });
    }
    try {
      reviewState = await currentNodeRecord(DATA_ROOT, reviewRelativePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return jsonResult({
        ok: false,
        candidate_id: candidateId,
        error: "promotion_review_not_found",
      });
    }

    const existingAccepted = await readJson<Record<string, unknown>>(acceptedPath);
    if (decision === "approve" && existingAccepted) {
      const controlledGate = existingAccepted.controlled_compounding_gate as Record<string, unknown> | undefined;
      if (
        candidateState.record.proposal_version === CONTROLLED_COMPOUNDING_PROPOSAL_VERSION &&
        (existingAccepted.independently_reviewed !== true || controlledGate?.eligible !== true)
      ) {
        return jsonResult({
          ok: false,
          candidate_id: candidateId,
          error: "existing_controlled_rule_failed_promotion_gate",
          mutation_performed: false,
          blockers: Array.isArray(controlledGate?.issues) ? controlledGate.issues : ["controlled_compounding_gate_missing"],
          accepted_path: acceptedRelativePath,
        });
      }
      const eligibility = await evaluateAcceptedEligibility(DATA_ROOT, acceptedRelativePath, existingAccepted);
      if (!eligibility.eligible) {
        return jsonResult({
          ok: false,
          candidate_id: candidateId,
          error: "existing_accepted_record_failed_lifecycle_gate",
          blockers: eligibility.issues,
          accepted_path: acceptedRelativePath,
        });
      }
      const existingTaskId = firstString(
        taskIdFromMemoryRecord(existingAccepted),
        taskIdFromMemoryRecord(candidateState.record),
      );
      if (existingTaskId) {
        await registerTaskSyncPaths({
          dataRoot: DATA_ROOT,
          taskId: existingTaskId,
          paths: [candidateRelativePath, reviewRelativePath, acceptedRelativePath],
          source: "review_candidate:idempotent_approved",
          approval: "reviewed",
        });
      }
      return jsonResult({
        ok: true,
        idempotent: true,
        candidate_id: candidateId,
        decision,
        candidate_path: candidateRelativePath,
        review_path: reviewRelativePath,
        accepted_path: acceptedRelativePath,
      });
    }

    const candidate = candidateState.record;
    const isFeedbackCorrection = candidate.type === "feedback_correction";
    const isControlledCompounding = candidate.proposal_version === CONTROLLED_COMPOUNDING_PROPOSAL_VERSION;
    const controlledCompoundingGate = decision === "approve" && isControlledCompounding
      ? await evaluateControlledCompoundingPromotion(DATA_ROOT, candidate, {
          reviewer,
          scopeApproved: compounding_scope_approved,
        })
      : null;
    if (controlledCompoundingGate && !controlledCompoundingGate.eligible) {
      return jsonResult({
        ok: false,
        candidate_id: candidateId,
        status: "blocked",
        mutation_performed: false,
        blockers: controlledCompoundingGate.issues,
        controlled_compounding_gate: controlledCompoundingGate,
        reason: "Controlled compounding approval requires independent review, recurrence, scope, provenance, contradiction, and hot-budget gates.",
      });
    }
    const correctionConflictPaths = normalizeVaultPaths(
      Array.isArray(candidate.contradicted_memory_paths) ? candidate.contradicted_memory_paths.map(String) : [],
    );
    const sourcePromptMetadata = candidate.source_prompt_metadata && typeof candidate.source_prompt_metadata === "object"
      ? candidate.source_prompt_metadata as Record<string, unknown>
      : null;
    if (decision === "approve" && isFeedbackCorrection) {
      const correctionBlockers = [
        firstString(sourcePromptMetadata?.binding_status) !== "verified" ? "correction_source_prompt_unverified" : null,
        correctionConflictPaths.length > 0 && !["hold_superseded", "demote_superseded"].includes(correction_resolution ?? "")
          ? "correction_conflict_resolution_required"
          : null,
        correctionConflictPaths.length === 0 && correction_resolution !== "no_conflict"
          ? "correction_no_conflict_attestation_required"
          : null,
      ].filter((value): value is string => Boolean(value));
      if (correctionBlockers.length > 0) {
        return jsonResult({
          ok: false,
          candidate_id: candidateId,
          status: "blocked",
          mutation_performed: false,
          blockers: correctionBlockers,
          reason: "Feedback correction approval requires verified source-prompt binding and explicit conflict resolution.",
        });
      }
    }
    const evidence = candidate.evidence;
    const hasEvidence =
      typeof evidence === "object" &&
      evidence !== null &&
      typeof (evidence as { snippet?: unknown }).snippet === "string" &&
      ((evidence as { snippet: string }).snippet.trim().length > 0);
    const hasConfidence = ["low", "medium", "high"].includes(String(candidate.confidence));
    const hasLastVerified = /^\d{4}-\d{2}-\d{2}$/.test(String(candidate.last_verified ?? ""));
    const reviewedAt = nowIso();
    const staticBlockers = [
      !hasEvidence ? "missing_evidence_snippet" : null,
      !hasConfidence ? "missing_confidence" : null,
      !hasLastVerified ? "missing_last_verified" : null,
      String(candidate.sensitivity ?? "unknown").toLowerCase() === "sensitive" ? "sensitive_candidate_cannot_be_hot" : null,
    ].filter((value): value is string => Boolean(value));
    const reviewBase = mergePreservingNodeLifecycle(reviewState.record, {
      ...reviewState.record,
      review_id: candidateId,
      type: firstString(reviewState.record.type, "promotion"),
      candidate_path: candidateRelativePath,
      accepted_path: decision === "approve" ? acceptedRelativePath : null,
      decision,
      reviewer,
      notes,
      correction_resolution: isFeedbackCorrection ? correction_resolution ?? null : null,
      compounding_scope_approved: isControlledCompounding ? compounding_scope_approved : null,
      controlled_compounding_gate: controlledCompoundingGate,
      contradicted_memory_paths: isFeedbackCorrection ? correctionConflictPaths : [],
      reviewed_at: reviewedAt,
      updated_at: reviewedAt,
    });

    if (decision === "approve") {
      const correctionConflictStates: Array<Awaited<ReturnType<typeof currentNodeRecord>> & { path: string }> = [];
      if (isFeedbackCorrection) {
        for (const conflictPath of correctionConflictPaths) {
          try {
            const state = await currentNodeRecord(DATA_ROOT, conflictPath);
            if (state.state !== "accepted") {
              return jsonResult({
                ok: false,
                candidate_id: candidateId,
                status: "blocked",
                mutation_performed: false,
                blockers: ["correction_conflict_state_changed"],
                conflict_path: conflictPath,
                observed_state: state.state,
              });
            }
            correctionConflictStates.push({ ...state, path: conflictPath });
          } catch {
            return jsonResult({
              ok: false,
              candidate_id: candidateId,
              status: "blocked",
              mutation_performed: false,
              blockers: ["correction_conflict_missing_at_review"],
              conflict_path: conflictPath,
            });
          }
        }
      }
      const acceptedBase = {
        ...withoutNodeLifecycle(candidate),
        type: isControlledCompounding ? "behavior_rule" : candidate.type,
        source_proposal_type: isControlledCompounding ? candidate.type : null,
        status: "accepted",
        review_status: "accepted_by_agent_review",
        reviewed_by: reviewer,
        review_notes: notes,
        reviewed_at: reviewedAt,
        accepted_at: reviewedAt,
        source_candidate_path: candidateRelativePath,
        source_review_path: reviewRelativePath,
        correction_resolution: isFeedbackCorrection ? correction_resolution ?? null : null,
        independently_reviewed: isControlledCompounding ? true : candidate.independently_reviewed,
        compounding_scope_approved: isControlledCompounding ? compounding_scope_approved : null,
        controlled_compounding_gate: controlledCompoundingGate,
        contradicted_memory_paths: isFeedbackCorrection ? correctionConflictPaths : [],
        supersedes_paths: isFeedbackCorrection ? correctionConflictPaths : [],
        promotion_blockers: [],
        quarantine: false,
        temperature: "hot",
        hold_reason: null,
        queue_destination: "accepted",
        predecessor_paths: [candidateRelativePath, reviewRelativePath, ...correctionConflictPaths],
        updated_at: reviewedAt,
      };
      const acceptedStage = initializeLifecycleWrite(acceptedRelativePath, acceptedBase, {
        to_state: "accepted",
        reason_code: "candidate_review_approved",
        reason: "A reviewer approved the candidate after evidence and provenance checks.",
        actor: reviewer,
        evidence_paths: [reviewRelativePath],
        predecessor_paths: [candidateRelativePath, reviewRelativePath, ...correctionConflictPaths],
        at: reviewedAt,
        idempotency_key: `candidate-approved|${candidateId}`,
      });
      const approvedReview = {
        ...reviewBase,
        status: "approved",
        blockers: [],
        independently_reviewed: isControlledCompounding ? true : reviewBase.independently_reviewed,
        controlled_compounding_gate: controlledCompoundingGate,
        conflict_resolution_status: isFeedbackCorrection ? "resolved" : null,
      };
      const eligibility = await evaluateAcceptedEligibility(DATA_ROOT, acceptedRelativePath, acceptedStage.mutation.record, {
        staged_records: { [reviewRelativePath]: approvedReview },
      });
      const blockers = [...staticBlockers, ...eligibility.issues];
      if (blockers.length > 0) {
        const blockedReview = { ...reviewBase, status: "blocked", blockers: Array.from(new Set(blockers)) };
        const blockedCandidate = mergePreservingNodeLifecycle(candidate, {
          ...candidate,
          reviewed_by: reviewer,
          review_notes: notes,
          reviewed_at: reviewedAt,
          hold_reason: blockers.join(","),
          updated_at: reviewedAt,
        });
        const lifecycleTransaction = await writeNodeLifecycleBatch(
          DATA_ROOT,
          [
            transitionThroughLifecycleStates(candidateRelativePath, blockedCandidate, ["held"], {
              reason_code: "promotion_blocked",
              reason: `Promotion blocked: ${blockers.join(", ")}`,
              actor: reviewer,
              evidence_paths: [reviewRelativePath],
              at: reviewedAt,
              idempotency_key: `promotion-blocked|${candidateId}`,
            }, candidateState.sha256),
            transitionThroughLifecycleStates(reviewRelativePath, blockedReview, ["held"], {
              reason_code: "promotion_blocked",
              reason: `Promotion blocked: ${blockers.join(", ")}`,
              actor: reviewer,
              evidence_paths: [candidateRelativePath],
              at: reviewedAt,
              idempotency_key: `promotion-review-blocked|${candidateId}`,
              sync_status: false,
            }, reviewState.sha256),
          ],
          { actor: reviewer, reason: `Block unsupported promotion ${candidateId}.` },
        );
        return jsonResult({
          ok: false,
          candidate_id: candidateId,
          status: "blocked",
          blockers: Array.from(new Set(blockers)),
          lifecycle_transaction: lifecycleTransaction,
          reason: "Accepted memory requires lifecycle, review, and durable provenance evidence.",
        });
      }

      const candidateForReview = mergePreservingNodeLifecycle(candidate, {
        ...candidate,
        reviewed_by: reviewer,
        review_notes: notes,
        reviewed_at: reviewedAt,
        updated_at: reviewedAt,
      });
      const reviewSequence: NodeLifecycleState[] = candidateState.state === "review" ? [] : ["review"];
      reviewSequence.push("archived");
      const candidateWrite = transitionThroughLifecycleStates(candidateRelativePath, candidateForReview, reviewSequence, {
        reason_code: "promoted_to_accepted",
        reason: "The reviewed candidate was promoted to a successor accepted node.",
        actor: reviewer,
        evidence_paths: [reviewRelativePath],
        successor_paths: [acceptedRelativePath],
        at: reviewedAt,
        idempotency_key: `candidate-promoted|${candidateId}`,
      }, candidateState.sha256);
      const reviewSequenceStates: NodeLifecycleState[] = reviewState.state === "review" ? ["archived"] : ["review", "archived"];
      const reviewWrite = transitionThroughLifecycleStates(reviewRelativePath, approvedReview, reviewSequenceStates, {
        reason_code: "promotion_review_completed",
        reason: "The promotion review approved an accepted successor node.",
        actor: reviewer,
        evidence_paths: [candidateRelativePath],
        successor_paths: [acceptedRelativePath],
        at: reviewedAt,
        idempotency_key: `promotion-review-completed|${candidateId}`,
        sync_status: false,
      }, reviewState.sha256);
      const correctionConflictWrites = correctionConflictStates.map((state) => {
        const targetState: NodeLifecycleState = correction_resolution === "demote_superseded" ? "demoted" : "held";
        const updatedRecord = mergePreservingNodeLifecycle(state.record, {
          ...state.record,
          superseded_by: acceptedRelativePath,
          supersession_review_path: reviewRelativePath,
          supersession_resolution: correction_resolution,
          hold_reason: `Superseded by reviewed user correction ${candidateId}.`,
          updated_at: reviewedAt,
        });
        return transitionThroughLifecycleStates(state.path, updatedRecord, [targetState], {
          reason_code: "user_correction_superseded_behavior",
          reason: `A reviewed direct user correction superseded this behavior memory via ${correction_resolution}.`,
          actor: reviewer,
          evidence_paths: [candidateRelativePath, reviewRelativePath],
          successor_paths: [acceptedRelativePath],
          at: reviewedAt,
          idempotency_key: `correction-superseded|${candidateId}|${state.path}`,
        }, state.sha256);
      });
      acceptedStage.write.expected_before_sha256 = null;
      const lifecycleTransaction = await writeNodeLifecycleBatch(
        DATA_ROOT,
        [candidateWrite, reviewWrite, ...correctionConflictWrites, acceptedStage.write],
        { actor: reviewer, reason: `Approve candidate ${candidateId} into accepted memory.` },
      );
      let correctionRecall = null;
      if (isFeedbackCorrection) {
        try {
          correctionRecall = await recordFeedbackCorrectionRecall(DATA_ROOT, {
            feedbackId: candidateId,
            correction: firstString(candidate.claim, candidate.behavior_rule),
            appliesTo: firstString(candidate.applies_to, "agent_behavior"),
            taskId: firstString(candidate.task_id) || null,
            acceptedPath: acceptedRelativePath,
            createdAt: reviewedAt,
            conflictingMemoryPaths: correctionConflictPaths,
            conflictResolution: correction_resolution ?? null,
          });
        } catch (error) {
          if (lifecycleTransaction.transaction_id) {
            await rollbackNodeLifecycleTransaction(DATA_ROOT, lifecycleTransaction.transaction_id);
          }
          throw new Error(`Feedback correction recall write failed; lifecycle transaction rolled back: ${safeError(error)}`);
        }
      }
      let controlledCompoundingStatus = null;
      if (isControlledCompounding) {
        try {
          controlledCompoundingStatus = await buildAndWriteControlledCompoundingStatus(DATA_ROOT);
        } catch (error) {
          if (lifecycleTransaction.transaction_id) {
            await rollbackNodeLifecycleTransaction(DATA_ROOT, lifecycleTransaction.transaction_id);
          }
          throw new Error(`Controlled compounding status refresh failed; lifecycle transaction rolled back: ${safeError(error)}`);
        }
      }
      await invalidateWikiIndex(DATA_ROOT);
      await invalidateSqliteWikiShard(DATA_ROOT);
      await appendEvent({
        event: "candidate_instance_reviewed",
        candidate_id: candidateId,
        decision,
        at: reviewedAt,
        accepted_path: acceptedRelativePath,
        correction_resolution: isFeedbackCorrection ? correction_resolution ?? null : null,
        contradicted_memory_paths: isFeedbackCorrection ? correctionConflictPaths : [],
        controlled_compounding: isControlledCompounding,
        controlled_compounding_gate: controlledCompoundingGate,
        controlled_compounding_status_path: controlledCompoundingStatus?.path ?? null,
        lifecycle_transaction_id: lifecycleTransaction.transaction_id,
      });
      const candidateTaskId = taskIdFromMemoryRecord(candidate);
      if (candidateTaskId) {
        await registerTaskSyncPaths({
          dataRoot: DATA_ROOT,
          taskId: candidateTaskId,
          paths: [candidateRelativePath, reviewRelativePath, acceptedRelativePath],
          source: "review_candidate:approved",
          approval: "reviewed",
        });
      }
      return jsonResult({
        ok: true,
        candidate_id: candidateId,
        decision,
        candidate_path: candidateRelativePath,
        review_path: reviewRelativePath,
        accepted_path: acceptedRelativePath,
        correction_resolution: isFeedbackCorrection ? correction_resolution ?? null : null,
        contradicted_memory_paths: isFeedbackCorrection ? correctionConflictPaths : [],
        behavior_recall_path: correctionRecall?.ledger_path ?? null,
        controlled_compounding: isControlledCompounding,
        controlled_compounding_gate: controlledCompoundingGate,
        controlled_compounding_status_path: controlledCompoundingStatus?.path ?? null,
        lifecycle_transaction: lifecycleTransaction,
      });
    }

    const rejectedCandidate = mergePreservingNodeLifecycle(candidate, {
      ...candidate,
      reviewed_by: reviewer,
      review_notes: notes,
      reviewed_at: reviewedAt,
      rejection_reason: notes || "reviewer_rejected",
      updated_at: reviewedAt,
    });
    const rejectedReview = { ...reviewBase, status: "rejected", blockers: [] };
    const lifecycleTransaction = await writeNodeLifecycleBatch(
      DATA_ROOT,
      [
        transitionThroughLifecycleStates(candidateRelativePath, rejectedCandidate, ["archived"], {
          reason_code: "candidate_rejected",
          reason: notes || "The reviewer rejected the candidate.",
          actor: reviewer,
          evidence_paths: [reviewRelativePath],
          at: reviewedAt,
          idempotency_key: `candidate-rejected|${candidateId}`,
        }, candidateState.sha256),
        transitionThroughLifecycleStates(reviewRelativePath, rejectedReview, ["archived"], {
          reason_code: "promotion_review_rejected",
          reason: notes || "The promotion review rejected the candidate.",
          actor: reviewer,
          evidence_paths: [candidateRelativePath],
          at: reviewedAt,
          idempotency_key: `promotion-review-rejected|${candidateId}`,
          sync_status: false,
        }, reviewState.sha256),
      ],
      { actor: reviewer, reason: `Reject candidate ${candidateId}.` },
    );
    let controlledCompoundingStatus = null;
    if (isControlledCompounding) {
      try {
        controlledCompoundingStatus = await buildAndWriteControlledCompoundingStatus(DATA_ROOT);
      } catch (error) {
        if (lifecycleTransaction.transaction_id) {
          await rollbackNodeLifecycleTransaction(DATA_ROOT, lifecycleTransaction.transaction_id);
        }
        throw new Error(`Controlled compounding status refresh failed; rejection transaction rolled back: ${safeError(error)}`);
      }
    }
    await appendEvent({
      event: "candidate_instance_reviewed",
      candidate_id: candidateId,
      decision,
      at: reviewedAt,
      accepted_path: null,
      controlled_compounding: isControlledCompounding,
      controlled_compounding_status_path: controlledCompoundingStatus?.path ?? null,
      lifecycle_transaction_id: lifecycleTransaction.transaction_id,
    });

    return jsonResult({
      ok: true,
      candidate_id: candidateId,
      decision,
      candidate_path: candidateRelativePath,
      review_path: reviewRelativePath,
      accepted_path: null,
      controlled_compounding: isControlledCompounding,
      controlled_compounding_status_path: controlledCompoundingStatus?.path ?? null,
      lifecycle_transaction: lifecycleTransaction,
    });
  },
);

registerTool(
  "quarantine_record",
  {
    title: "Quarantine Record",
    description: "Mark a vault record as quarantined so default Context Packs exclude it.",
    inputSchema: {
      target_path: z.string().min(1),
      reason: z.string().min(1),
      reviewer: z.string().default("manual-review"),
      replacement_path: z.string().optional(),
    },
  },
  async ({ target_path, reason, reviewer, replacement_path }) => {
    const targetPath = normalizeVaultPath(target_path);
    const targetIsJson = path.extname(targetPath).toLowerCase() === ".json";
    let targetState: Awaited<ReturnType<typeof currentNodeRecord>> | null = null;
    let targetBytes: Buffer | null = null;
    try {
      if (targetIsJson) targetState = await currentNodeRecord(DATA_ROOT, targetPath);
      else targetBytes = await fs.readFile(dataPath(targetPath));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return jsonResult({
          ok: false,
          error: "target_not_found",
          target_path: targetPath,
        });
      }
      throw error;
    }

    const quarantineId = makeQuarantineId(targetPath);
    const createdAt = nowIso();
    const quarantinePath = dataPath(".dino", "quarantine", `${quarantineId}.json`);
    const reviewPath = dataPath("80_Review_Queue", "demotion", `${quarantineId}.json`);
    const quarantineRelativePath = relDataPath(quarantinePath);
    const reviewRelativePath = relDataPath(reviewPath);
    const normalizedReplacementPath = replacement_path ? normalizeVaultPath(replacement_path) : null;
    const targetLifecyclePath = targetIsJson
      ? targetPath
      : `.dino/lifecycle/nodes/${quarantineId}.json`;
    const record = {
      quarantine_id: quarantineId,
      status: "quarantined",
      target_path: targetPath,
      reason,
      reviewer,
      replacement_path: normalizedReplacementPath,
      created_at: createdAt,
      updated_at: createdAt,
    };
    const reviewRecord = {
      review_id: quarantineId,
      type: "demotion",
      status: "quarantined",
      target_path: targetPath,
      quarantine_path: quarantineRelativePath,
      reason,
      reviewer,
      created_at: createdAt,
      updated_at: createdAt,
    };
    let targetLifecycleWrite: LifecycleBatchWrite;
    if (targetIsJson && targetState) {
      const targetRecord = mergePreservingNodeLifecycle(targetState.record, {
        ...targetState.record,
        quarantine: true,
        quarantine_reason: reason,
        quarantined_by: reviewer,
        quarantined_at: createdAt,
        replacement_path: normalizedReplacementPath,
        updated_at: createdAt,
      });
      targetLifecycleWrite = transitionThroughLifecycleStates(targetPath, targetRecord, ["quarantined"], {
        reason_code: "record_quarantined",
        reason,
        actor: reviewer,
        evidence_paths: [reviewRelativePath, quarantineRelativePath],
        successor_paths: normalizedReplacementPath ? [normalizedReplacementPath] : [],
        at: createdAt,
        idempotency_key: `record-quarantined|${quarantineId}`,
      }, targetState.sha256);
    } else {
      const sidecar = {
        type: "node_lifecycle_sidecar",
        status: "quarantined",
        target_path: targetPath,
        target_content_sha256: sha256(targetBytes ?? Buffer.alloc(0)),
        quarantine_reason: reason,
        quarantined_by: reviewer,
        quarantined_at: createdAt,
        replacement_path: normalizedReplacementPath,
        created_at: createdAt,
        updated_at: createdAt,
      };
      targetLifecycleWrite = await upsertLifecycleStateWrite(targetLifecyclePath, sidecar, "quarantined", {
        reason_code: "non_json_record_quarantined",
        reason,
        actor: reviewer,
        evidence_paths: [targetPath, reviewRelativePath, quarantineRelativePath],
        predecessor_paths: [targetPath],
        successor_paths: normalizedReplacementPath ? [normalizedReplacementPath] : [],
        at: createdAt,
        idempotency_key: `record-quarantined|${quarantineId}`,
      });
    }
    const quarantineLifecycleWrite = await upsertLifecycleStateWrite(
      quarantineRelativePath,
      record,
      "quarantined",
      {
        reason_code: "quarantine_record_created",
        reason,
        actor: reviewer,
        evidence_paths: [targetPath, reviewRelativePath],
        predecessor_paths: [targetPath],
        successor_paths: normalizedReplacementPath ? [normalizedReplacementPath] : [],
        at: createdAt,
        idempotency_key: `quarantine-record|${quarantineId}`,
      },
    );
    const reviewLifecycleWrite = await upsertLifecycleStateWrite(
      reviewRelativePath,
      reviewRecord,
      "review",
      {
        reason_code: "demotion_review_opened",
        reason,
        actor: reviewer,
        evidence_paths: [targetPath, quarantineRelativePath],
        predecessor_paths: [targetPath],
        at: createdAt,
        idempotency_key: `demotion-review|${quarantineId}`,
        sync_status: false,
      },
    );
    const lifecycleTransaction = await writeNodeLifecycleBatch(
      DATA_ROOT,
      [
        targetLifecycleWrite,
        quarantineLifecycleWrite,
        reviewLifecycleWrite,
      ],
      { actor: reviewer, reason: `Quarantine ${targetPath}.` },
    );
    await appendEvent({
      event: "record_quarantined",
      quarantine_id: quarantineId,
      target_path: targetPath,
      at: createdAt,
      lifecycle_transaction_id: lifecycleTransaction.transaction_id,
    });
    await invalidateWikiIndex(DATA_ROOT);
    await invalidateSqliteWikiShard(DATA_ROOT);

    return jsonResult({
      ok: true,
      quarantine_id: quarantineId,
      target_path: targetPath,
      target_lifecycle_path: targetLifecyclePath,
      quarantine_path: relDataPath(quarantinePath),
      review_path: relDataPath(reviewPath),
      lifecycle_transaction: lifecycleTransaction,
      context_pack_effect: "excluded_from_default_context_packs",
    });
  },
);

registerTool(
  "run_compounding_cycle",
  {
    title: "Run Compounding Cycle",
    description: "Create bounded recurring behavior proposals, require independent review before acceptance, maintain low-value rule lifecycle, or rollback/reapply an exact cycle.",
    inputSchema: {
      apply: z.boolean().default(true),
      reviewer: z.string().default("manual-compounding-cycle"),
      trace_limit: z.number().int().min(1).max(200).default(50),
      rollback_cycle_path: z.string().optional(),
      reapply_cycle_path: z.string().optional(),
    },
  },
  async ({ apply, reviewer, trace_limit, rollback_cycle_path, reapply_cycle_path }) => {
    try {
      return jsonResult(
        await runCompoundingCycleWithIndexRefresh({
          apply,
          reviewer,
          traceLimit: trace_limit,
          rollbackCyclePath: rollback_cycle_path,
          reapplyCyclePath: reapply_cycle_path,
        }),
      );
    } catch (error) {
      return jsonResult({
        ok: false,
        error: safeError(error),
        apply,
        reviewer,
        trace_limit,
        rollback_cycle_path: rollback_cycle_path ?? null,
        reapply_cycle_path: reapply_cycle_path ?? null,
      });
    }
  },
);

registerTool(
  "auto_sync",
  {
    title: "Auto Sync",
    description: "Commit and push only hash-bound artifacts from one registered DinoBrain task sync scope.",
    inputSchema: {
      task_id: z.string().min(1),
      include_sensitive_scan: z.boolean().default(true),
      allow_conditional: z.boolean().default(false),
      push: z.boolean().default(true),
      commit_message: z.string().default("data: auto sync DinoBrain OS loop"),
      allowed_paths: z.array(z.string()).min(1),
    },
  },
  async ({ task_id, include_sensitive_scan, allow_conditional, push, commit_message, allowed_paths }) => {
    try {
      return jsonResult(
        await runDataAutoSync({
          taskId: task_id,
          includeSensitiveScan: include_sensitive_scan,
          allowConditional: allow_conditional,
          push,
          commitMessage: commit_message,
          allowedPaths: allowed_paths,
        }),
      );
    } catch (error) {
      return jsonResult({
        ok: false,
        state: "retry_required",
        dry_run: false,
        data_root: DATA_ROOT,
        error: safeError(error),
        policy_version: DATA_CLASSIFICATION_POLICY_VERSION,
        scope_version: TASK_SYNC_SCOPE_VERSION,
        task_id,
      });
    }
  },
);

registerTool(
  "git_sync",
  {
    title: "Git Sync Dry Run",
    description: "Classify data repo changes for safe git sync without committing or pushing.",
    inputSchema: {
      include_sensitive_scan: z.boolean().default(true),
    },
  },
  async ({ include_sensitive_scan }) => {
    return jsonResult(
      await buildSyncPlan({
        includeSensitiveScan: include_sensitive_scan,
        dryRun: true,
      }),
    );
  },
);

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
