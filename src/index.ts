import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
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
import { appendFileWithLock, atomicWriteJson } from "./concurrency.js";
import { evaluateBehaviorMemoryLift } from "./behavior-eval.js";
import { runCompoundingCycle } from "./compounding.js";
import { SEARCH_ROOTS, standardRankingInputsForMode } from "./context.js";
import { retrievalCaveatsForMode } from "./hybrid-retrieval.js";
import { makeUniqueId } from "./ids.js";
import { buildMemoryAudit } from "./memory-audit.js";
import { applyNodeLifecycle } from "./lifecycle.js";
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
import { DINOBRAIN_OS_CONTRACT, DINOBRAIN_OS_VERSION, REQUIRED_OS_TOOLS, evaluateActionGates } from "./os-contract.js";
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
  return makeUniqueId("quarantine", targetPath, 36);
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
  verificationStatus: "verified" | "missing" | "not_provided";
  declaredHasContextPack: boolean;
  declaredContextItemCount: number;
  declarationMismatch: boolean;
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

async function readContextPackEvidence(contextPackPath: string): Promise<{
  contextPackPath: string;
  contextItemCount: number;
} | null> {
  const normalized = normalizeVaultPath(contextPackPath);
  const pack = await readJson<Record<string, unknown>>(dataPath(normalized));
  if (!pack) return null;
  const items = Array.isArray(pack.items) ? pack.items : [];
  const contextItemCount = typeof pack.included_item_count === "number" ? pack.included_item_count : items.length;
  return {
    contextPackPath: normalized,
    contextItemCount,
  };
}

function eventContextPackPath(event: Record<string, unknown>, taskId: string): string | null {
  if (event.task_id !== taskId) return null;
  for (const key of ["context_pack_trace", "context_pack_path"]) {
    const value = event[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return null;
}

async function findTaskContextPackPath(taskId: string): Promise<string | null> {
  const eventDir = dataPath(".dino", "events");
  let entries: Array<import("node:fs").Dirent>;
  try {
    entries = await fs.readdir(eventDir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const files = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
    .map((entry) => path.join(eventDir, entry.name))
    .sort((a, b) => b.localeCompare(a));

  for (const file of files) {
    const lines = (await fs.readFile(file, "utf8")).split(/\r?\n/).filter(Boolean).reverse();
    for (const line of lines) {
      try {
        const event = JSON.parse(line) as Record<string, unknown>;
        const contextPackPath = eventContextPackPath(event, taskId);
        if (contextPackPath) return contextPackPath;
      } catch {
        continue;
      }
    }
  }
  return null;
}

async function deriveGateContextEvidence(params: {
  taskId: string;
  contextPackPath?: string;
  declaredHasContextPack: boolean;
  declaredContextItemCount: number;
}): Promise<GateContextEvidence> {
  const candidates = [
    params.contextPackPath?.trim() || "",
    params.taskId ? (await findTaskContextPackPath(params.taskId)) ?? "" : "",
  ].filter(Boolean);

  for (const candidate of candidates) {
    const verified = await readContextPackEvidence(candidate);
    if (!verified) continue;
    return {
      hasContextPack: true,
      contextItemCount: verified.contextItemCount,
      contextPackPath: verified.contextPackPath,
      verificationStatus: "verified",
      declaredHasContextPack: params.declaredHasContextPack,
      declaredContextItemCount: params.declaredContextItemCount,
      declarationMismatch:
        !params.declaredHasContextPack || params.declaredContextItemCount !== verified.contextItemCount,
    };
  }

  return {
    hasContextPack: false,
    contextItemCount: 0,
    contextPackPath: null,
    verificationStatus: candidates.length > 0 ? "missing" : "not_provided",
    declaredHasContextPack: params.declaredHasContextPack,
    declaredContextItemCount: params.declaredContextItemCount,
    declarationMismatch: params.declaredHasContextPack || params.declaredContextItemCount > 0,
  };
}

async function buildContextPackRecord(question: string, limit: number): Promise<Record<string, unknown>> {
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
  await upsertOperationContextPack(DATA_ROOT, packRelativePath, trace);
  await upsertSqliteOperationContextPack(DATA_ROOT, contextPackEntryFromRecord(packRelativePath, trace));
  const eventLog = await appendEvent({
    event: "context_pack_created",
    pack_id: packId,
    at: createdAt,
    path: packRelativePath,
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
    data_root: DATA_ROOT,
    trace_path: packRelativePath,
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

server.registerTool(
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
    },
  },
  async ({ request, project, mode, sensitivity, limit }) => {
    const taskId = makeTaskId(request);
    const taskPath = dataPath(".dino", "tasks", `${taskId}.json`);
    const createdAt = nowIso();
    const record = {
      task_id: taskId,
      status: "started",
      request,
      project: project ?? null,
      mode,
      sensitivity,
      os_version: DINOBRAIN_OS_VERSION,
      contract: DINOBRAIN_OS_CONTRACT,
      created_at: createdAt,
      updated_at: createdAt,
      data_root: DATA_ROOT,
      sync_policy: sensitivity === "normal" ? "conditional" : "blocked_until_review",
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
    });

    let contextPack: Record<string, unknown>;
    try {
      contextPack = await buildContextPackRecord(request, limit);
    } catch (error) {
      const errorMessage = safeError(error);
      const blockedAt = nowIso();
      const blockedRecord = {
        ...record,
        status: "blocked",
        block_reason: "context_pack_failed",
        error: errorMessage,
        updated_at: blockedAt,
      };
      await writeJson(taskPath, blockedRecord);
      await upsertOperationTask(DATA_ROOT, taskRelativePath, blockedRecord);
      await upsertSqliteOperationTask(DATA_ROOT, taskEntryFromRecord(taskRelativePath, blockedRecord));
      const gates = evaluateActionGates({
        request,
        hasContextPack: false,
        contextItemCount: 0,
        sensitivity,
        exposedTools: [...REQUIRED_OS_TOOLS],
      });
      const gateReportPath = await writeGateReport(taskId, {
        task_id: taskId,
        request,
        generated_at: blockedAt,
        context_pack_path: null,
        context_item_count: 0,
        error: errorMessage,
        ...gates,
      });
      const gateEventLog = await appendEvent({
        event: "os_begin_task_failed_closed",
        task_id: taskId,
        at: blockedAt,
        gate_status: gates.status,
        fail_closed: true,
        gate_report_path: gateReportPath,
        error: errorMessage,
        os_version: DINOBRAIN_OS_VERSION,
      });
      return jsonResult({
        ok: false,
        os_version: DINOBRAIN_OS_VERSION,
        contract: DINOBRAIN_OS_CONTRACT,
        fail_closed: true,
        gate_status: gates.status,
        gates: gates.gates,
        task_id: taskId,
        task_path: taskRelativePath,
        event_log: taskEventLog,
        gate_event_log: gateEventLog,
        gate_report_path: gateReportPath,
        record: blockedRecord,
        context_pack: null,
        error: errorMessage,
      });
    }
    const gates = evaluateActionGates({
      request,
      hasContextPack: typeof contextPack.trace_path === "string",
      contextItemCount: typeof contextPack.item_count === "number" ? contextPack.item_count : 0,
      sensitivity,
      exposedTools: [...REQUIRED_OS_TOOLS],
    });
    const gateReportPath = await writeGateReport(taskId, {
      task_id: taskId,
      request,
      generated_at: nowIso(),
      context_pack_path: contextPack.trace_path,
      context_item_count: contextPack.item_count,
      ...gates,
    });
    const gateEventLog = await appendEvent({
      event: "os_begin_task_completed",
      task_id: taskId,
      at: nowIso(),
      context_pack_trace: contextPack.trace_path,
      context_item_count: contextPack.item_count,
      gate_status: gates.status,
      fail_closed: gates.fail_closed,
      gate_report_path: gateReportPath,
      os_version: DINOBRAIN_OS_VERSION,
    });

    return jsonResult({
      ok: !gates.fail_closed,
      os_version: DINOBRAIN_OS_VERSION,
      contract: DINOBRAIN_OS_CONTRACT,
      fail_closed: gates.fail_closed,
      gate_status: gates.status,
      gates: gates.gates,
      task_id: taskId,
      task_path: taskRelativePath,
      event_log: taskEventLog,
      gate_event_log: gateEventLog,
      gate_report_path: gateReportPath,
      record,
      context_pack: contextPack,
    });
  },
);

server.registerTool(
  "start_task",
  {
    title: "Start Task",
    description: "Register a new DinoBrain task record in the data repo.",
    inputSchema: {
      request: z.string().min(1),
      project: z.string().optional(),
      mode: z.enum(["standard", "deep"]).default("standard"),
      sensitivity: z.enum(["normal", "sensitive", "unknown"]).default("unknown"),
    },
  },
  async ({ request, project, mode, sensitivity }) => {
    const taskId = makeTaskId(request);
    const taskPath = dataPath(".dino", "tasks", `${taskId}.json`);
    const record = {
      task_id: taskId,
      status: "started",
      request,
      project: project ?? null,
      mode,
      sensitivity,
      os_version: DINOBRAIN_OS_VERSION,
      contract: DINOBRAIN_OS_CONTRACT,
      created_at: nowIso(),
      updated_at: nowIso(),
      data_root: DATA_ROOT,
      sync_policy: sensitivity === "normal" ? "conditional" : "blocked_until_review",
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
    });
    return jsonResult({
      ok: true,
      task_id: taskId,
      task_path: taskRelativePath,
      event_log: eventLog,
      record,
    });
  },
);

server.registerTool(
  "finish_task",
  {
    title: "Finish Task",
    description: "Finish a DinoBrain task and write a trace/event log entry.",
    inputSchema: {
      task_id: z.string().min(1),
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
    const taskPath = dataPath(".dino", "tasks", `${safeSlug(task_id)}.json`);
    const existing = (await readJson<Record<string, unknown>>(taskPath)) ?? {
      task_id,
      status: "missing_start_record",
      created_at: null,
    };
    const finishedAt = nowIso();
    const normalizedUsedMemoryPaths = normalizeVaultPaths(used_memory_paths);
    const normalizedContextPackPaths = normalizeVaultPaths(context_pack_paths);
    const normalizedSessionArchivePaths = normalizeVaultPaths(session_archive_paths);
    const normalizedCandidatePaths = normalizeVaultPaths(candidate_paths);
    const normalizedSearchQueries = normalizeTextList(search_queries);
    const trace = {
      task_id,
      outcome,
      summary,
      growth_policy,
      changed_files,
      decisions,
      next_steps,
      used_memory_paths: normalizedUsedMemoryPaths,
      context_pack_paths: normalizedContextPackPaths,
      session_archive_paths: normalizedSessionArchivePaths,
      candidate_paths: normalizedCandidatePaths,
      search_queries: normalizedSearchQueries,
      memory_use: {
        used_memory_count: normalizedUsedMemoryPaths.length,
        context_pack_count: normalizedContextPackPaths.length,
        session_archive_count: normalizedSessionArchivePaths.length,
        candidate_count: normalizedCandidatePaths.length,
        search_query_count: normalizedSearchQueries.length,
      },
      finished_at: finishedAt,
    };
    const updated = {
      ...existing,
      status: outcome,
      updated_at: finishedAt,
      finished_at: finishedAt,
      trace_path: `.dino/traces/${safeSlug(task_id)}.json`,
    };
    const tracePath = dataPath(".dino", "traces", `${safeSlug(task_id)}.json`);
    await writeJson(taskPath, updated);
    await writeJson(tracePath, trace);
    const taskRelativePath = relDataPath(taskPath);
    const traceRelativePath = relDataPath(tracePath);
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
      event_log: eventLog,
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

server.registerTool(
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

server.registerTool(
  "get_context_pack",
  {
    title: "Get Context Pack",
    description: "Build a Standard Context Pack from curated DinoBrain records.",
    inputSchema: {
      question: z.string().min(1),
      limit: z.number().int().min(1).max(20).default(7),
    },
  },
  async ({ question, limit }) => {
    return jsonResult(await buildContextPackRecord(question, limit));
  },
);

server.registerTool(
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

server.registerTool(
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

server.registerTool(
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
      backup_risk: z.boolean().default(false),
    },
  },
  async ({ request, task_id, context_pack_path, context_item_count, has_context_pack, sensitivity, backup_risk }) => {
    const gateTaskId = task_id?.trim() || makeTaskId(request);
    const contextEvidence = await deriveGateContextEvidence({
      taskId: gateTaskId,
      contextPackPath: context_pack_path,
      declaredHasContextPack: has_context_pack,
      declaredContextItemCount: context_item_count,
    });
    const gates = evaluateActionGates({
      request,
      hasContextPack: contextEvidence.hasContextPack,
      contextItemCount: contextEvidence.contextItemCount,
      sensitivity,
      exposedTools: [...REQUIRED_OS_TOOLS],
      backupRisk: backup_risk,
    });
    const gateReportPath = await writeGateReport(gateTaskId, {
      task_id: gateTaskId,
      request,
      generated_at: nowIso(),
      context_pack_path: contextEvidence.contextPackPath,
      context_verification_status: contextEvidence.verificationStatus,
      declared_has_context_pack: contextEvidence.declaredHasContextPack,
      declared_context_item_count: contextEvidence.declaredContextItemCount,
      verified_context_item_count: contextEvidence.contextItemCount,
      context_declaration_mismatch: contextEvidence.declarationMismatch,
      ...gates,
    });
    const eventLog = await appendEvent({
      event: "os_gate_evaluated",
      task_id: gateTaskId,
      at: nowIso(),
      gate_status: gates.status,
      fail_closed: gates.fail_closed,
      gate_report_path: gateReportPath,
      context_pack_path: contextEvidence.contextPackPath,
      context_verification_status: contextEvidence.verificationStatus,
      context_declaration_mismatch: contextEvidence.declarationMismatch,
      os_version: DINOBRAIN_OS_VERSION,
    });
    return jsonResult({
      ok: !gates.fail_closed,
      os_version: DINOBRAIN_OS_VERSION,
      gate_report_path: gateReportPath,
      event_log: eventLog,
      context_pack_path: contextEvidence.contextPackPath,
      context_verification_status: contextEvidence.verificationStatus,
      context_declaration_mismatch: contextEvidence.declarationMismatch,
      declared_has_context_pack: contextEvidence.declaredHasContextPack,
      declared_context_item_count: contextEvidence.declaredContextItemCount,
      verified_context_item_count: contextEvidence.contextItemCount,
      ...gates,
    });
  },
);

server.registerTool(
  "apply_node_lifecycle",
  {
    title: "Apply Node Lifecycle",
    description: "Apply DinoBrain OS v2 lifecycle checks and write merge/hold/delete/provenance review records.",
    inputSchema: {
      apply: z.boolean().default(false),
      reviewer: z.string().default("node-lifecycle-v2"),
    },
  },
  async ({ apply, reviewer }) => {
    const report = await applyNodeLifecycle(DATA_ROOT, { apply, reviewer });
    if (apply) {
      await invalidateWikiIndex(DATA_ROOT);
      await invalidateSqliteWikiShard(DATA_ROOT);
    }
    const eventLog = await appendEvent({
      event: "node_lifecycle_applied",
      at: nowIso(),
      lifecycle_id: report.lifecycle_id,
      lifecycle_path: report.lifecycle_path,
      apply,
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

server.registerTool(
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

server.registerTool(
  "record_feedback_correction",
  {
    title: "Record Feedback Correction",
    description: "Promote direct user correction into accepted behavior memory for future sessions.",
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
    const acceptedPath = dataPath("50_Instances", "accepted", `${feedbackId}.json`);
    const record = {
      feedback_id: feedbackId,
      type: "feedback_correction",
      status: "accepted",
      claim: correction,
      behavior_rule: correction,
      applies_to,
      evidence: {
        source: "user_feedback",
        snippet: correction.slice(0, 600),
      },
      source_status: "internal",
      confidence: "high",
      last_verified: dateStamp(),
      tags: Array.from(new Set(["feedback", "correction", "behavior", ...tags])),
      task_id: task_id ?? null,
      accepted_at: createdAt,
      created_at: createdAt,
      updated_at: createdAt,
    };
    await writeJson(acceptedPath, record);
    await invalidateWikiIndex(DATA_ROOT);
    await invalidateSqliteWikiShard(DATA_ROOT);
    const behaviorRecall = await recordFeedbackCorrectionRecall(DATA_ROOT, {
      feedbackId,
      correction,
      appliesTo: applies_to,
      taskId: task_id ?? null,
      acceptedPath: relDataPath(acceptedPath),
      createdAt,
    });
    const eventLog = await appendEvent({
      event: "feedback_correction_accepted",
      feedback_id: feedbackId,
      at: createdAt,
      accepted_path: relDataPath(acceptedPath),
      task_id: task_id ?? null,
      behavior_recall_ledger_path: behaviorRecall.ledger_path,
      behavior_recall_id: behaviorRecall.entry.recall_id,
      conflicting_memory_paths: behaviorRecall.conflicting_memory_paths,
      quarantine_paths: behaviorRecall.quarantine_paths,
      review_path: behaviorRecall.review_path,
      os_version: DINOBRAIN_OS_VERSION,
    });
    return jsonResult({
      ok: true,
      feedback_id: feedbackId,
      accepted_path: relDataPath(acceptedPath),
      event_log: eventLog,
      behavior_recall: {
        ledger_path: behaviorRecall.ledger_path,
        recall_id: behaviorRecall.entry.recall_id,
        conflicting_memory_paths: behaviorRecall.conflicting_memory_paths,
        quarantine_paths: behaviorRecall.quarantine_paths,
        review_path: behaviorRecall.review_path,
      },
      next_context_effect: "included_in_default_context_packs_after_index_rebuild",
    });
  },
);

server.registerTool(
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

server.registerTool(
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

    await writeJson(dataPath(plan.archivePath), plan.archive);
    for (const candidate of plan.candidates) {
      await writeJson(dataPath(candidate.candidatePath), candidate.candidate);
      await writeJson(dataPath(candidate.reviewPath), candidate.review);
    }
    const importedAt = typeof plan.archive.imported_at === "string" ? plan.archive.imported_at : nowIso();
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
      temperature_counts: plan.stats.temperature_counts,
      category_counts: plan.stats.category_counts,
      redaction_hits: plan.stats.redaction_hits,
      next_step: "Review candidates with review_candidate before they can enter accepted memory.",
    });
  },
);

server.registerTool(
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
    await writeJson(candidatePath, candidate);
    await writeJson(reviewPath, review);
    await appendEvent({
      event: "candidate_instance_created",
      candidate_id: candidateId,
      at: createdAt,
      candidate_path: relDataPath(candidatePath),
      review_path: relDataPath(reviewPath),
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

server.registerTool(
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
    const candidate = await readJson<Record<string, unknown>>(candidatePath);
    if (!candidate) {
      return jsonResult({
        ok: false,
        candidate_id: candidateId,
        error: "candidate_not_found",
      });
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

    if (decision === "approve" && (!hasEvidence || !hasConfidence || !hasLastVerified)) {
      await writeJson(reviewPath, {
        review_id: candidateId,
        type: "promotion",
        status: "blocked",
        candidate_path: relDataPath(candidatePath),
        decision,
        reviewer,
        notes,
        blockers: [
          !hasEvidence ? "missing_evidence_snippet" : null,
          !hasConfidence ? "missing_confidence" : null,
          !hasLastVerified ? "missing_last_verified" : null,
        ].filter(Boolean),
        reviewed_at: reviewedAt,
        updated_at: reviewedAt,
      });
      return jsonResult({
        ok: false,
        candidate_id: candidateId,
        status: "blocked",
        reason: "Claims without evidence, confidence, and last_verified cannot be promoted.",
      });
    }

    const updatedCandidate = {
      ...candidate,
      status: decision === "approve" ? "accepted" : "rejected",
      reviewed_by: reviewer,
      review_notes: notes,
      reviewed_at: reviewedAt,
      updated_at: reviewedAt,
    };
    await writeJson(candidatePath, updatedCandidate);

    let acceptedPath: string | null = null;
    if (decision === "approve") {
      acceptedPath = dataPath("50_Instances", "accepted", `${candidateId}.json`);
      await writeJson(acceptedPath, {
        ...updatedCandidate,
        accepted_at: reviewedAt,
        source_candidate_path: relDataPath(candidatePath),
      });
      await invalidateWikiIndex(DATA_ROOT);
      await invalidateSqliteWikiShard(DATA_ROOT);
    }

    await writeJson(reviewPath, {
      review_id: candidateId,
      type: "promotion",
      status: decision === "approve" ? "approved" : "rejected",
      candidate_path: relDataPath(candidatePath),
      accepted_path: acceptedPath ? relDataPath(acceptedPath) : null,
      decision,
      reviewer,
      notes,
      reviewed_at: reviewedAt,
      updated_at: reviewedAt,
    });
    await appendEvent({
      event: "candidate_instance_reviewed",
      candidate_id: candidateId,
      decision,
      at: reviewedAt,
      accepted_path: acceptedPath ? relDataPath(acceptedPath) : null,
    });

    return jsonResult({
      ok: true,
      candidate_id: candidateId,
      decision,
      candidate_path: relDataPath(candidatePath),
      review_path: relDataPath(reviewPath),
      accepted_path: acceptedPath ? relDataPath(acceptedPath) : null,
    });
  },
);

server.registerTool(
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
    const targetAbsolutePath = dataPath(targetPath);
    try {
      await fs.stat(targetAbsolutePath);
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
    const record = {
      quarantine_id: quarantineId,
      status: "quarantined",
      target_path: targetPath,
      reason,
      reviewer,
      replacement_path: replacement_path ? normalizeVaultPath(replacement_path) : null,
      created_at: createdAt,
      updated_at: createdAt,
    };
    await writeJson(quarantinePath, record);
    await writeJson(reviewPath, {
      review_id: quarantineId,
      type: "demotion",
      status: "quarantined",
      target_path: targetPath,
      quarantine_path: relDataPath(quarantinePath),
      reason,
      reviewer,
      created_at: createdAt,
      updated_at: createdAt,
    });
    await appendEvent({
      event: "record_quarantined",
      quarantine_id: quarantineId,
      target_path: targetPath,
      at: createdAt,
    });
    await invalidateWikiIndex(DATA_ROOT);
    await invalidateSqliteWikiShard(DATA_ROOT);

    return jsonResult({
      ok: true,
      quarantine_id: quarantineId,
      target_path: targetPath,
      quarantine_path: relDataPath(quarantinePath),
      review_path: relDataPath(reviewPath),
      context_pack_effect: "excluded_from_default_context_packs",
    });
  },
);

server.registerTool(
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

server.registerTool(
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

server.registerTool(
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
