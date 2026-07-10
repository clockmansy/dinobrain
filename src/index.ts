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
  recordFeedbackCorrectionRecall,
} from "./behavior-recall.js";
import { ClientMcpProofRuntime } from "./client-mcp-proof.js";
import { appendFileWithLock, atomicWriteJson } from "./concurrency.js";
import { evaluateBehaviorMemoryLift } from "./behavior-eval.js";
import { runCompoundingCycle } from "./compounding.js";
import { SEARCH_ROOTS, standardRankingInputsForMode } from "./context.js";
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
  restoreDeletedNode,
  transitionLifecycleWrite,
  transitionNodeLifecycleFile,
  writeNodeLifecycleBatch,
  type LifecycleBatchWrite,
} from "./node-lifecycle-store.js";
import { classifyPromptLaunch } from "./prompt-eligibility.js";
import { withTaskLifecycleMutationLock } from "./task-lifecycle-lock.js";
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
  const normalized = value.replace(/\\/g, "/").replace(/^\/+/, "");
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

type PathClassification = {
  classification: SyncClassification;
  policy: string;
  reasons: string[];
};

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
  };
  sensitive_patterns: SensitivityHit[];
};

type SyncPlan = {
  ok: boolean;
  dry_run: boolean;
  data_root: string;
  changed_file_count: number;
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
  const paths = stringList([value.cycle_path, value.behavior_rule_index_path, value.event_log]);
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

function classifyPath(normalizedPath: string): PathClassification {
  const blockedPrefixes = [
    "10_Conversations/raw/",
    "50_Instances/raw/",
    "attachments/private/",
    ".dino/cache/",
    ".dino/tmp/",
    ".dino/locks/",
    ".dino/local-backups/",
    ".dino/events/",
  ];
  const blockedExact = new Set([".env", ".dino/secrets.json", ".dino/local.json"]);
  const blockedExtensions = [".pem", ".key", ".p12", ".pfx"];
  const conditionalPrefixes = [
    "50_Instances/candidates/",
    "80_Review_Queue/",
    ".dino/index/",
    ".dino/evaluations/",
    ".dino/tasks/",
    ".dino/traces/",
    ".dino/context-packs/",
    ".dino/compounding/",
    ".dino/audits/",
    ".dino/proofs/",
    ".dino/quarantine/",
  ];
  const syncablePrefixes = [
    "00_Home/",
    "20_Wiki/",
    "30_Sources/",
    "40_Projects/",
    "50_Instances/accepted/",
    "60_Operations/",
    "70_Error_Book/",
  ];
  const syncableExact = new Set(["README.md", ".gitignore"]);

  if (
    blockedExact.has(normalizedPath) ||
    blockedPrefixes.some((prefix) => normalizedPath.startsWith(prefix)) ||
    blockedExtensions.some((extension) => normalizedPath.toLowerCase().endsWith(extension))
  ) {
    return {
      classification: "blocked",
      policy: "local_only",
      reasons: ["path is local-only or secret-bearing"],
    };
  }

  if (conditionalPrefixes.some((prefix) => normalizedPath.startsWith(prefix))) {
    return {
      classification: "conditional",
      policy: "requires_review",
      reasons: ["path requires review before sync"],
    };
  }

  if (syncableExact.has(normalizedPath) || syncablePrefixes.some((prefix) => normalizedPath.startsWith(prefix))) {
    return {
      classification: "syncable",
      policy: "syncable_after_review",
      reasons: ["path is allowed by sync policy"],
    };
  }

  return {
    classification: "conditional",
    policy: "unclassified_requires_review",
    reasons: ["path is not explicitly classified"],
  };
}

async function sensitivityHits(filePath: string): Promise<SensitivityHit[]> {
  try {
    const stat = await fs.stat(filePath);
    if (!stat.isFile() || stat.size > 512 * 1024) return [];
    const text = await fs.readFile(filePath, "utf8");
    const patterns: Array<[string, RegExp]> = [
      ["api_key_assignment", /api[_-]?key\s*[:=]/i],
      ["secret_assignment", /secret\s*[:=]/i],
      ["token_assignment", /token\s*[:=]/i],
      ["password_assignment", /password\s*[:=]/i],
      ["private_key_block", /BEGIN [A-Z ]*PRIVATE KEY/],
      ["openai_key_shape", /sk-[A-Za-z0-9]{20,}/],
      ["github_token_shape", /(?:github_pat_[A-Za-z0-9_]{20,}|(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{20,})/],
      ["aws_access_key_shape", /(?:AKIA|ASIA)[A-Z0-9]{16}/],
      ["jwt_shape", /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/],
      ["cookie_assignment", /(session[_-]?id|session[_-]?token|cookie)\s*[:=]/i],
    ];
    const hits: SensitivityHit[] = [];
    const lines = text.split(/\r?\n/);
    for (const [patternName, pattern] of patterns) {
      const lineIndex = lines.findIndex((line) => pattern.test(line));
      if (lineIndex >= 0) {
        hits.push({ pattern: patternName, line: lineIndex + 1 });
      }
    }
    return hits;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function largeUnscannedFinding(normalizedPath: string, deleted: boolean): Promise<string | null> {
  if (deleted) return null;
  try {
    const stat = await fs.stat(dataPath(normalizedPath));
    if (!stat.isFile()) return null;
    return stat.size > 512 * 1024 ? "file exceeds automatic sensitivity scan size limit" : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function acceptedInstancePolicyFinding(normalizedPath: string, deleted: boolean): Promise<string | null> {
  if (deleted || !normalizedPath.startsWith("50_Instances/accepted/") || !normalizedPath.endsWith(".json")) return null;
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(await fs.readFile(dataPath(normalizedPath), "utf8")) as Record<string, unknown>;
  } catch {
    return "accepted JSON is unreadable";
  }
  if (parsed.auto_generated !== true) return null;
  const hasReviewLineage = Boolean(
    parsed.source_candidate_path ||
      parsed.reviewed_by ||
      parsed.reviewed_at ||
      String(parsed.review_status ?? "").toLowerCase().includes("accepted"),
  );
  return hasReviewLineage ? null : "auto-generated accepted memory lacks review lineage";
}

async function buildSyncPlan(options: {
  includeSensitiveScan: boolean;
  allowConditionalAutoSync?: boolean;
  dryRun: boolean;
  wouldPush?: boolean;
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
      changed_file_count: 0,
      would_commit: false,
      would_push: false,
      manual_approval_required: options.dryRun,
      commit_allowed_by_tool: false,
      policy_version: options.dryRun ? "phase-6-dry-run" : "phase-7-auto-sync",
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

  const changes = parseGitStatus(stdout);
  const files: SyncFileReport[] = [];
  for (const change of changes) {
    const classification = classifyPath(change.path);
    const deleted = change.status.includes("D");
    const hits = options.includeSensitiveScan && !deleted ? await sensitivityHits(dataPath(change.path)) : [];
    const largeFinding = options.includeSensitiveScan ? await largeUnscannedFinding(change.path, deleted) : null;
    const acceptedFinding = await acceptedInstancePolicyFinding(change.path, deleted);
    const finalClassification: SyncClassification =
      hits.length > 0 || acceptedFinding || largeFinding ? "blocked" : classification.classification;
    const reasons = [
      ...classification.reasons,
      ...(hits.length > 0 ? ["sensitive pattern detected"] : []),
      ...(acceptedFinding ? [acceptedFinding] : []),
      ...(largeFinding ? [largeFinding] : []),
    ];
    const file: SyncFileReport = {
      ...change,
      classification: finalClassification,
      policy: hits.length > 0
        ? "sensitive_pattern_block"
        : acceptedFinding
          ? "unreviewed_generated_accepted_block"
          : largeFinding
            ? "large_unscanned_file_block"
            : classification.policy,
      reasons,
      action:
        finalClassification === "syncable"
          ? "ready_for_manual_commit"
          : finalClassification === "conditional"
            ? "requires_review"
            : "do_not_sync",
      sensitivity_scan: {
        enabled: options.includeSensitiveScan,
        scanned: options.includeSensitiveScan && !deleted,
      },
      sensitive_patterns: hits,
    };
    if (!options.dryRun && isAutoSyncAllowed(file, options.allowConditionalAutoSync === true)) {
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
    changed_file_count: files.length,
    would_commit: !options.dryRun && summary.ready_for_auto_commit > 0,
    would_push: !options.dryRun && options.wouldPush === true && summary.ready_for_auto_commit > 0,
    manual_approval_required: options.dryRun,
    commit_allowed_by_tool: !options.dryRun,
    policy_version: options.dryRun ? "phase-6-dry-run" : "phase-7-auto-sync",
    files,
    summary,
  };
}

async function observeGateSyncRisk(request: string): Promise<SyncRiskObservation> {
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
    const plan = await buildSyncPlan({
      includeSensitiveScan: true,
      dryRun: true,
      wouldPush: false,
    });
    if (!plan.ok) {
      return {
        status: "unavailable",
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

async function runDataAutoSync(options: {
  includeSensitiveScan: boolean;
  allowConditional: boolean;
  push: boolean;
  commitMessage: string;
  allowedPaths?: string[];
}): Promise<Record<string, unknown>> {
  const plan = await buildSyncPlan({
    includeSensitiveScan: options.includeSensitiveScan,
    allowConditionalAutoSync: options.allowConditional,
    dryRun: false,
    wouldPush: options.push,
  });
  if (!plan.ok) return plan as unknown as Record<string, unknown>;

  const scope = options.allowedPaths && options.allowedPaths.length > 0 ? new Set(normalizeVaultPaths(options.allowedPaths)) : null;
  const scopedFiles = scope ? plan.files.filter((file) => scope.has(file.path)) : plan.files;
  const outOfScopeChangedPaths = scope
    ? plan.files
        .filter((file) => !scope.has(file.path))
        .map((file) => ({ path: file.path, classification: file.classification, policy: file.policy }))
    : [];

  const allowedPaths = scopedFiles
    .filter((file) => isAutoSyncAllowed(file, options.allowConditional))
    .map((file) => file.path);
  const skippedPaths = scopedFiles
    .filter((file) => !isAutoSyncAllowed(file, options.allowConditional))
    .map((file) => ({ path: file.path, classification: file.classification, policy: file.policy }));

  if (allowedPaths.length === 0) {
    return {
      ...plan,
      committed: false,
      pushed: false,
      reason: "no_auto_sync_allowed_changes",
      sync_scope: scope ? "allowed_paths" : "repo_policy",
      scoped_path_count: scopedFiles.length,
      skipped_paths: skippedPaths,
      out_of_scope_changed_paths: outOfScopeChangedPaths,
    };
  }

  const stagedBefore = (await gitOutput(["diff", "--cached", "--name-only"])).split(/\r?\n/).filter(Boolean);
  const allowedSet = new Set(allowedPaths);
  const disallowedStaged = stagedBefore.filter((stagedPath) => !allowedSet.has(stagedPath.replace(/\\/g, "/")));
  if (disallowedStaged.length > 0) {
    return {
      ...plan,
      committed: false,
      pushed: false,
      blocked: true,
      reason: "disallowed_files_already_staged",
      disallowed_staged_paths: disallowedStaged,
      sync_scope: scope ? "allowed_paths" : "repo_policy",
      scoped_path_count: scopedFiles.length,
      skipped_paths: skippedPaths,
      out_of_scope_changed_paths: outOfScopeChangedPaths,
    };
  }

  await gitRun(["add", "--", ...allowedPaths]);
  if (!(await hasStagedChanges())) {
    return {
      ...plan,
      committed: false,
      pushed: false,
      reason: "no_staged_changes_after_policy_add",
      allowed_paths: allowedPaths,
      sync_scope: scope ? "allowed_paths" : "repo_policy",
      scoped_path_count: scopedFiles.length,
      skipped_paths: skippedPaths,
      out_of_scope_changed_paths: outOfScopeChangedPaths,
    };
  }

  const message = options.commitMessage.trim() || "data: auto sync DinoBrain OS loop";
  await gitRun(["commit", "-m", message]);
  const commit = await gitOutput(["rev-parse", "HEAD"]);
  const branch = await gitOutput(["rev-parse", "--abbrev-ref", "HEAD"]);
  let pushed = false;
  let remote = "";
  if (options.push) {
    remote = await gitOutput(["remote", "get-url", "origin"]);
    await gitRun(["push", "origin", branch]);
    pushed = true;
  }

  return {
    ...plan,
    committed: true,
    pushed,
    commit,
    branch,
    remote: remote || null,
    allowed_paths: allowedPaths,
    sync_scope: scope ? "allowed_paths" : "repo_policy",
    scoped_path_count: scopedFiles.length,
    skipped_paths: skippedPaths,
    out_of_scope_changed_paths: outOfScopeChangedPaths,
  };
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

function isAutoSyncAllowed(file: SyncFileReport, allowConditional: boolean): boolean {
  if (file.classification === "blocked" || file.sensitive_patterns.length > 0) return false;
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

function makeSourceChunkId(sourceTitle: string): string {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "-");
  return `sourcechunk-${stamp}-${safeSlug(sourceTitle).slice(0, 36)}`;
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

  await writeJson(operationPath, operationRecord);
  await writeJson(candidatePath, candidateRecord);
  await writeJson(reviewPath, reviewRecord);
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
    destination: "candidate_review",
    created_paths: [relDataPath(operationPath), relDataPath(candidatePath), relDataPath(reviewPath)],
    operation_path: relDataPath(operationPath),
    candidate_path: relDataPath(candidatePath),
    review_path: relDataPath(reviewPath),
    event_log: eventLog,
  };
}

async function runCompoundingCycleWithIndexRefresh(options: {
  apply: boolean;
  reviewer: string;
  traceLimit: number;
}): Promise<Record<string, unknown>> {
  const report = await runCompoundingCycle(DATA_ROOT, {
    apply: options.apply,
    reviewer: options.reviewer,
    traceLimit: options.traceLimit,
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
  const items = ranked.map(({ path: recordPath, kind, title, summary, tags, score, reasons }) => ({
    path: recordPath,
    kind,
    title,
    summary,
    tags,
    score,
    reasons,
  }));
  const trace = {
    pack_id: packId,
    pack_type: "standard",
    os_version: DINOBRAIN_OS_VERSION,
    task_id: linkage.taskId ?? null,
    hook_run_id: linkage.hookRunId ?? null,
    prompt_hash: linkage.promptHash ?? null,
    question,
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
    question,
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
    const metadata = launchMetadata as TaskLaunchMetadata;
    const sanitized = sanitizeTaskRequest(request);
    const storedRequest = sanitized.request;
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
      project: project ?? null,
      mode,
      sensitivity: sensitivityEvidence.sensitivity,
      reported_sensitivity: sensitivityEvidence.reported,
      detected_sensitivity: sensitivityEvidence.detected,
      sensitivity_hits: sensitivityEvidence.hits,
      os_version: DINOBRAIN_OS_VERSION,
      contract: DINOBRAIN_OS_CONTRACT,
      created_at: createdAt,
      updated_at: createdAt,
      data_root: DATA_ROOT,
      sync_policy: sensitivityEvidence.sensitivity === "normal" ? "conditional" : "blocked_until_review",
      ...taskLaunchEvidence(storedRequest, metadata, eligibility),
      lease,
      terminal_owner_id: null,
    };
    await writeJson(taskPath, record);
    const taskRelativePath = relDataPath(taskPath);
    await upsertOperationTask(DATA_ROOT, taskRelativePath, record);
    await upsertSqliteOperationTask(DATA_ROOT, taskEntryFromRecord(taskRelativePath, record));
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
    const metadata = launchMetadata as TaskLaunchMetadata;
    const sanitized = sanitizeTaskRequest(request);
    const storedRequest = sanitized.request;
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
      project: project ?? null,
      mode,
      sensitivity: sensitivityEvidence.sensitivity,
      reported_sensitivity: sensitivityEvidence.reported,
      detected_sensitivity: sensitivityEvidence.detected,
      sensitivity_hits: sensitivityEvidence.hits,
      os_version: DINOBRAIN_OS_VERSION,
      contract: DINOBRAIN_OS_CONTRACT,
      created_at: createdAt,
      updated_at: createdAt,
      data_root: DATA_ROOT,
      sync_policy: sensitivityEvidence.sensitivity === "normal" ? "conditional" : "blocked_until_review",
      ...taskLaunchEvidence(storedRequest, metadata, eligibility),
      lease,
      terminal_owner_id: null,
    };
    await writeJson(taskPath, record);
    const taskRelativePath = relDataPath(taskPath);
    await upsertOperationTask(DATA_ROOT, taskRelativePath, record);
    await upsertSqliteOperationTask(DATA_ROOT, taskEntryFromRecord(taskRelativePath, record));
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
    const terminalOwnerId = firstString(params.terminalOwnerId, existingLease?.owner_id, "legacy-unleased-owner");
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
    const normalizedUsedMemoryPaths = normalizeVaultPaths(params.usedMemoryPaths);
    const normalizedContextPackPaths = normalizeVaultPaths(params.contextPackPaths);
    const normalizedSessionArchivePaths = normalizeVaultPaths(params.sessionArchivePaths);
    const normalizedCandidatePaths = normalizeVaultPaths(params.candidatePaths);
    const normalizedSearchQueries = normalizeTextList(params.searchQueries);
    const trace = {
      task_id: params.taskId,
      outcome: params.outcome,
      summary: params.summary,
      growth_policy: params.growthPolicy,
      changed_files: params.changedFiles,
      decisions: params.decisions,
      next_steps: params.nextSteps,
      used_memory_paths: normalizedUsedMemoryPaths,
      context_pack_paths: normalizedContextPackPaths,
      session_archive_paths: normalizedSessionArchivePaths,
      candidate_paths: normalizedCandidatePaths,
      search_queries: normalizedSearchQueries,
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
    let autoSync: Record<string, unknown> | null = null;
    if (!traceOnly && envFlag("DINOBRAIN_AUTO_SYNC", false)) {
      try {
        const growthPaths = stringList((growth as { created_paths?: unknown }).created_paths);
        const compoundingPaths = compoundingSyncPaths(compounding);
        autoSync = await runDataAutoSync({
          includeSensitiveScan: true,
          allowConditional: envFlag("DINOBRAIN_AUTO_SYNC_ALLOW_CONDITIONAL", false),
          push: envFlag("DINOBRAIN_AUTO_SYNC_PUSH", false),
          commitMessage: `data: auto sync ${safeSlug(task_id).slice(0, 48)}`,
          allowedPaths: [taskRelativePath, traceRelativePath, ...growthPaths, ...compoundingPaths],
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
  "os_gate",
  {
    title: "OS Action Gate",
    description: "Evaluate DinoBrain OS v2 action gates and write a gate report.",
    inputSchema: {
      request: z.string().min(1),
      task_id: z.string().optional(),
      context_pack_path: z.string().optional(),
      context_item_count: z.number().int().min(0).default(0),
      has_context_pack: z.boolean().default(false),
      sensitivity: z.enum(["normal", "sensitive", "unknown"]).default("unknown"),
      backup_risk: z.boolean().optional(),
    },
  },
  async ({ request, task_id, context_pack_path, context_item_count, has_context_pack, sensitivity, backup_risk }) => {
    const sanitized = sanitizeTaskRequest(request);
    const gateTaskId = task_id?.trim() || makeTaskId(sanitized.request);
    const contextEvidence = await deriveGateContextEvidence({
      taskId: gateTaskId,
      contextPackPath: context_pack_path,
      declaredHasContextPack: has_context_pack,
      declaredContextItemCount: context_item_count,
    });
    const syncObservation = await observeGateSyncRisk(request);
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
    description: "Store an external/internal durable source chunk and link it to claim paths.",
    inputSchema: {
      source_title: z.string().min(1),
      source_uri: z.string().min(1),
      chunk_text: z.string().min(1),
      chunk_type: z.enum(["external_doc", "paper", "community", "internal_doc", "conversation_excerpt"]).default("external_doc"),
      claim_paths: z.array(z.string()).default([]),
      tags: z.array(z.string()).default([]),
      last_verified: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    },
  },
  async ({ source_title, source_uri, chunk_text, chunk_type, claim_paths, tags, last_verified }) => {
    const chunkId = makeSourceChunkId(source_title);
    const createdAt = nowIso();
    const sourcePath = dataPath("30_Sources", "chunks", `${chunkId}.json`);
    const normalizedClaimPaths = normalizeVaultPaths(claim_paths);
    const sanitizedChunk = redactSensitiveText(chunk_text);
    const sourceRecord = {
      source_chunk_id: chunkId,
      type: "source_chunk",
      status: "active",
      title: source_title,
      source_uri,
      chunk_type,
      chunk_text: sanitizedChunk.text,
      chunk_text_redactions: sanitizedChunk.redactions,
      chunk_text_truncated: sanitizedChunk.truncated,
      chunk_text_original_length: chunk_text.length,
      chunk_text_stored_length: sanitizedChunk.text.length,
      claim_paths: normalizedClaimPaths,
      tags,
      last_verified: last_verified ?? dateStamp(),
      created_at: createdAt,
      updated_at: createdAt,
    };
    await writeJson(sourcePath, sourceRecord);
    const sourceRelativePath = relDataPath(sourcePath);
    const linkPath = dataPath(".dino", "provenance", `${chunkId}.json`);
    await writeJson(linkPath, {
      provenance_id: chunkId,
      source_chunk_path: sourceRelativePath,
      claim_paths: normalizedClaimPaths,
      source_uri,
      created_at: createdAt,
      updated_at: createdAt,
    });
    await invalidateWikiIndex(DATA_ROOT);
    await invalidateSqliteWikiShard(DATA_ROOT);
    const eventLog = await appendEvent({
      event: "source_chunk_created",
      source_chunk_id: chunkId,
      at: createdAt,
      source_chunk_path: sourceRelativePath,
      provenance_path: relDataPath(linkPath),
      claim_paths: normalizedClaimPaths,
      redactions: sanitizedChunk.redactions,
      truncated: sanitizedChunk.truncated,
      os_version: DINOBRAIN_OS_VERSION,
    });
    return jsonResult({
      ok: true,
      source_chunk_id: chunkId,
      source_chunk_path: sourceRelativePath,
      provenance_path: relDataPath(linkPath),
      redactions: sanitizedChunk.redactions,
      truncated: sanitizedChunk.truncated,
      event_log: eventLog,
    });
  },
);

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
    },
  },
  async ({ correction, applies_to, task_id, tags }) => {
    const feedbackId = makeFeedbackId(correction);
    const createdAt = nowIso();
    const candidatePath = dataPath("50_Instances", "candidates", `${feedbackId}.json`);
    const reviewPath = dataPath("80_Review_Queue", "promotion", `${feedbackId}.json`);
    const provenancePath = dataPath(".dino", "provenance", `${feedbackId}.json`);
    const candidateRelativePath = relDataPath(candidatePath);
    const reviewRelativePath = relDataPath(reviewPath);
    const provenanceRelativePath = relDataPath(provenancePath);
    const provenanceRecord = {
      provenance_id: feedbackId,
      type: "user_feedback_provenance",
      status: "active",
      source_kind: "direct_user_correction",
      task_id: task_id ?? null,
      correction_sha256: sha256(correction),
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
      auto_promote: false,
      promotion_blockers: ["manual_review_required", "correction_conflict_review_required"],
      created_at: createdAt,
      updated_at: createdAt,
    };
    const review = {
      review_id: feedbackId,
      type: "correction_promotion",
      status: "pending",
      candidate_path: candidateRelativePath,
      provenance_path: provenanceRelativePath,
      required_checks: ["direct_user_correction", "conflicting_memory_review", "scope", "sensitivity"],
      created_at: createdAt,
      updated_at: createdAt,
    };
    const lifecycleTransaction = await writeNodeLifecycleBatch(
      DATA_ROOT,
      [
        { target_path: provenanceRelativePath, record: provenanceRecord },
        initializeLifecycleWrite(candidateRelativePath, candidate, {
          to_state: "candidate",
          reason_code: "feedback_correction_candidate_created",
          reason: "Direct user correction entered review before durable promotion.",
          actor: "record_feedback_correction",
          evidence_paths: [provenanceRelativePath],
          predecessor_paths: task_id ? [`.dino/tasks/${safeSlug(task_id)}.json`] : [],
          at: createdAt,
          idempotency_key: `feedback-candidate|${feedbackId}`,
        }).write,
        initializeLifecycleWrite(reviewRelativePath, review, {
          to_state: "review",
          reason_code: "feedback_correction_review_opened",
          reason: "Direct user correction requires conflict and scope review.",
          actor: "record_feedback_correction",
          evidence_paths: [candidateRelativePath, provenanceRelativePath],
          predecessor_paths: [candidateRelativePath],
          at: createdAt,
          idempotency_key: `feedback-review|${feedbackId}`,
          sync_status: false,
        }).write,
      ],
      { actor: "record_feedback_correction", reason: `Create feedback correction candidate ${feedbackId}.` },
    );
    const eventLog = await appendEvent({
      event: "feedback_correction_candidate_created",
      feedback_id: feedbackId,
      at: createdAt,
      candidate_path: candidateRelativePath,
      review_path: reviewRelativePath,
      provenance_path: provenanceRelativePath,
      task_id: task_id ?? null,
      lifecycle_transaction_id: lifecycleTransaction.transaction_id,
      os_version: DINOBRAIN_OS_VERSION,
    });
    return jsonResult({
      ok: true,
      feedback_id: feedbackId,
      candidate_path: candidateRelativePath,
      review_path: reviewRelativePath,
      provenance_path: provenanceRelativePath,
      accepted_path: null,
      lifecycle_transaction: lifecycleTransaction,
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
    },
  },
  async ({ source, project, title, transcript, messages, sensitivity, max_candidates, raw_retention }) => {
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
    const lifecycleWrites: LifecycleBatchWrite[] = [{ target_path: plan.archivePath, record: plan.archive }];
    for (const candidate of plan.candidates) {
      const existingCandidate = await readJson<Record<string, unknown>>(dataPath(candidate.candidatePath));
      const existingReview = await readJson<Record<string, unknown>>(dataPath(candidate.reviewPath));
      const candidateRecord = mergePreservingNodeLifecycle(existingCandidate, candidate.candidate);
      const reviewRecord = mergePreservingNodeLifecycle(existingReview, candidate.review);
      lifecycleWrites.push(
        initializeLifecycleWrite(candidate.candidatePath, candidateRecord, {
          to_state: getNodeLifecycleState(candidateRecord, candidate.candidatePath),
          reason_code: "session_candidate_created",
          reason: "Session extraction created a review-gated memory candidate.",
          actor: "import_session",
          evidence_paths: [plan.archivePath],
          predecessor_paths: [plan.archivePath],
          at: importedAt,
          idempotency_key: `session-candidate|${candidate.candidateId}`,
        }).write,
        initializeLifecycleWrite(candidate.reviewPath, reviewRecord, {
          to_state: getNodeLifecycleState(reviewRecord, candidate.reviewPath),
          reason_code: "session_review_opened",
          reason: "Session extraction opened a mandatory promotion review.",
          actor: "import_session",
          evidence_paths: [plan.archivePath, candidate.candidatePath],
          predecessor_paths: [candidate.candidatePath],
          at: importedAt,
          idempotency_key: `session-review|${candidate.candidateId}`,
          sync_status: false,
        }).write,
      );
    }
    const lifecycleTransaction = await writeNodeLifecycleBatch(DATA_ROOT, lifecycleWrites, {
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
      lifecycle_transaction: lifecycleTransaction,
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
    const lifecycleTransaction = await writeNodeLifecycleBatch(
      DATA_ROOT,
      [
        initializeLifecycleWrite(candidateRelativePath, candidate, {
          to_state: "candidate",
          reason_code: "candidate_created",
          reason: "A new memory candidate entered mandatory review.",
          actor: "create_candidate_instance",
          evidence_paths: normalizeVaultPaths(provenance_paths),
          at: createdAt,
          idempotency_key: `candidate-created|${candidateId}`,
        }).write,
        initializeLifecycleWrite(reviewRelativePath, review, {
          to_state: "review",
          reason_code: "promotion_review_opened",
          reason: "A promotion review was opened for the new candidate.",
          actor: "create_candidate_instance",
          evidence_paths: [candidateRelativePath, ...normalizeVaultPaths(provenance_paths)],
          predecessor_paths: [candidateRelativePath],
          at: createdAt,
          idempotency_key: `candidate-review-opened|${candidateId}`,
          sync_status: false,
        }).write,
      ],
      { actor: "create_candidate_instance", reason: `Create candidate and review ${candidateId}.` },
    );
    await appendEvent({
      event: "candidate_instance_created",
      candidate_id: candidateId,
      at: createdAt,
      candidate_path: relDataPath(candidatePath),
      review_path: relDataPath(reviewPath),
      lifecycle_transaction: lifecycleTransaction,
    });
    return jsonResult({
      ok: true,
      candidate_id: candidateId,
      candidate_path: relDataPath(candidatePath),
      review_path: relDataPath(reviewPath),
      auto_promote: false,
      reason: "Candidate instances always enter Review Queue first.",
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
    },
  },
  async ({ candidate_id, decision, reviewer, notes }) => {
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
      reviewed_at: reviewedAt,
      updated_at: reviewedAt,
    });

    if (decision === "approve") {
      const acceptedBase = {
        ...withoutNodeLifecycle(candidate),
        status: "accepted",
        review_status: "accepted_by_agent_review",
        reviewed_by: reviewer,
        review_notes: notes,
        reviewed_at: reviewedAt,
        accepted_at: reviewedAt,
        source_candidate_path: candidateRelativePath,
        source_review_path: reviewRelativePath,
        promotion_blockers: [],
        predecessor_paths: [candidateRelativePath, reviewRelativePath],
        updated_at: reviewedAt,
      };
      const acceptedStage = initializeLifecycleWrite(acceptedRelativePath, acceptedBase, {
        to_state: "accepted",
        reason_code: "candidate_review_approved",
        reason: "A reviewer approved the candidate after evidence and provenance checks.",
        actor: reviewer,
        evidence_paths: [reviewRelativePath],
        predecessor_paths: [candidateRelativePath, reviewRelativePath],
        at: reviewedAt,
        idempotency_key: `candidate-approved|${candidateId}`,
      });
      const approvedReview = { ...reviewBase, status: "approved", blockers: [] };
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
      acceptedStage.write.expected_before_sha256 = null;
      const lifecycleTransaction = await writeNodeLifecycleBatch(
        DATA_ROOT,
        [candidateWrite, reviewWrite, acceptedStage.write],
        { actor: reviewer, reason: `Approve candidate ${candidateId} into accepted memory.` },
      );
      await invalidateWikiIndex(DATA_ROOT);
      await invalidateSqliteWikiShard(DATA_ROOT);
      if (candidate.type === "feedback_correction") {
        await recordFeedbackCorrectionRecall(DATA_ROOT, {
          feedbackId: candidateId,
          correction: firstString(candidate.claim, candidate.behavior_rule),
          appliesTo: firstString(candidate.applies_to, "agent_behavior"),
          taskId: firstString(candidate.task_id) || null,
          acceptedPath: acceptedRelativePath,
          createdAt: reviewedAt,
        });
      }
      await appendEvent({
        event: "candidate_instance_reviewed",
        candidate_id: candidateId,
        decision,
        at: reviewedAt,
        accepted_path: acceptedRelativePath,
        lifecycle_transaction_id: lifecycleTransaction.transaction_id,
      });
      return jsonResult({
        ok: true,
        candidate_id: candidateId,
        decision,
        candidate_path: candidateRelativePath,
        review_path: reviewRelativePath,
        accepted_path: acceptedRelativePath,
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
    await appendEvent({
      event: "candidate_instance_reviewed",
      candidate_id: candidateId,
      decision,
      at: reviewedAt,
      accepted_path: null,
      lifecycle_transaction_id: lifecycleTransaction.transaction_id,
    });

    return jsonResult({
      ok: true,
      candidate_id: candidateId,
      decision,
      candidate_path: candidateRelativePath,
      review_path: reviewRelativePath,
      accepted_path: null,
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
    description: "Distill completed task traces into accepted behavior rules, merge duplicates, hold invalid rules, and refresh retrieval indexes.",
    inputSchema: {
      apply: z.boolean().default(true),
      reviewer: z.string().default("manual-compounding-cycle"),
      trace_limit: z.number().int().min(1).max(200).default(50),
    },
  },
  async ({ apply, reviewer, trace_limit }) => {
    try {
      return jsonResult(
        await runCompoundingCycleWithIndexRefresh({
          apply,
          reviewer,
          traceLimit: trace_limit,
        }),
      );
    } catch (error) {
      return jsonResult({
        ok: false,
        error: safeError(error),
        apply,
        reviewer,
        trace_limit,
      });
    }
  },
);

registerTool(
  "auto_sync",
  {
    title: "Auto Sync",
    description: "Commit and push policy-approved DinoBrain data changes while excluding blocked local-only records.",
    inputSchema: {
      include_sensitive_scan: z.boolean().default(true),
      allow_conditional: z.boolean().default(false),
      push: z.boolean().default(true),
      commit_message: z.string().default("data: auto sync DinoBrain OS loop"),
      allowed_paths: z.array(z.string()).default([]),
    },
  },
  async ({ include_sensitive_scan, allow_conditional, push, commit_message, allowed_paths }) => {
    try {
      return jsonResult(
        await runDataAutoSync({
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
        dry_run: false,
        data_root: DATA_ROOT,
        error: safeError(error),
        policy_version: "phase-7-auto-sync",
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
