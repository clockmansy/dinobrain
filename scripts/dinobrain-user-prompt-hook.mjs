import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { DINOBRAIN_VERSION } from "./lib/version-manifest.mjs";
import { appendFileWithLock, atomicWriteJson } from "./lib/atomic-files.mjs";

const root = path.resolve(process.env.DINOBRAIN_REPO_ROOT ?? path.join(path.dirname(fileURLToPath(import.meta.url)), ".."));
const serverPath = path.join(root, "dist", "index.js");
const dataRoot = path.resolve(process.env.DINOBRAIN_DATA_DIR ?? path.join(root, "..", "dinobrain-data"));
const reportRoot = path.resolve(process.env.DINOBRAIN_HOOK_REPORT_DIR ?? path.join(root, "reports", "live-hooks"));
const { classifyPromptLaunch, makePromptIdentityHash } = await import(
  pathToFileURL(path.join(root, "dist", "prompt-eligibility.js")).href
);
let hookFailureContext = null;

class HookSoftTimeoutError extends Error {
  constructor(timeoutMs) {
    super(`DinoBrain hook cooperative timeout after ${timeoutMs} ms`);
    this.name = "HookSoftTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

function nowIso() {
  return new Date().toISOString();
}

function dateStamp(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

function stampForFile(date = new Date()) {
  return date.toISOString().replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "-");
}

function safeSlug(value) {
  const slug = String(value)
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 96);
  return slug || "hook-run";
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function parseInput(raw) {
  const text = raw.replace(/\u0000/g, "").replace(/^\uFEFF/, "").trim();
  if (!text) return {};
  try {
    const parsed = JSON.parse(text);
    if (typeof parsed === "string") return parseInput(parsed);
    return parsed;
  } catch {
    return { prompt: text };
  }
}

function contentToText(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value.map(contentToText).filter(Boolean).join("\n");
  }
  if (value && typeof value === "object") {
    if (typeof value.text === "string") return value.text;
    if (typeof value.content === "string") return value.content;
    if (Array.isArray(value.content)) return contentToText(value.content);
  }
  return "";
}

function extractPrompt(input) {
  const candidates = [
    input.prompt,
    input.user_prompt,
    input.userPrompt,
    input.message,
    input.text,
    input.params?.prompt,
    input.payload?.prompt,
    input.hookInput?.prompt,
    input.hook_input?.prompt,
  ];

  for (const candidate of candidates) {
    const text = contentToText(candidate).trim();
    if (text) return text;
  }

  if (Array.isArray(input.messages)) {
    const lastUserMessage = [...input.messages].reverse().find((message) => message?.role === "user");
    const text = contentToText(lastUserMessage?.content).trim();
    if (text) return text;
  }

  return "";
}

function unique(values) {
  return Array.from(new Set(values));
}

function redactPrompt(prompt) {
  const redactions = [];
  let text = String(prompt).replace(/\r\n/g, "\n");

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

  const maxChars = Math.max(200, Math.min(4000, Number(process.env.DINOBRAIN_HOOK_MAX_PROMPT_CHARS ?? 1200)));
  if (text.length > maxChars) {
    text = `${text.slice(0, maxChars)}\n[truncated by DinoBrain hook]`;
  }

  return { text, redactions: unique(redactions) };
}

function preview(value, max = 180) {
  const compact = String(value).replace(/\s+/g, " ").trim();
  return compact.length > max ? `${compact.slice(0, max - 3)}...` : compact;
}

function sha256(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

function hookLaunchProvenance() {
  const raw = process.env.DINOBRAIN_HOOK_LAUNCH_PROVENANCE;
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") return parsed;
    } catch {
      return {
        launch_kind: process.env.DINOBRAIN_HOOK_LAUNCH_KIND || "unknown",
        parse_error: "DINOBRAIN_HOOK_LAUNCH_PROVENANCE invalid JSON",
      };
    }
  }
  return {
    launch_kind: process.env.DINOBRAIN_HOOK_LAUNCH_KIND || "unknown",
  };
}

function inputCwd(input) {
  const candidates = [
    input.cwd,
    input.current_working_directory,
    input.workspace?.path,
    input.project?.path,
    input.payload?.cwd,
    input.hookInput?.cwd,
    input.hook_input?.cwd,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
  }
  return "";
}

function projectNameFor(input) {
  if (process.env.DINOBRAIN_HOOK_PROJECT) return process.env.DINOBRAIN_HOOK_PROJECT;
  const cwd = inputCwd(input);
  if (cwd) return path.basename(path.resolve(cwd)) || "codex";
  return path.basename(root);
}

function envFlag(name, defaultValue) {
  const value = process.env[name];
  if (value === undefined || value === "") return defaultValue;
  return /^(1|true|yes|on)$/i.test(value);
}

function hookRawRetention() {
  const value = process.env.DINOBRAIN_HOOK_RAW_RETENTION;
  if (value === "metadata_only" || value === "redacted_excerpt") return value;
  return "redacted_excerpt";
}

function hookSessionMaxCandidates() {
  return Math.max(1, Math.min(20, Number(process.env.DINOBRAIN_HOOK_SESSION_MAX_CANDIDATES ?? 8)));
}

function hookDedupeKey(input, request) {
  const source = JSON.stringify({
    hookEventName: input.hookEventName ?? input.hook_event_name ?? "UserPromptSubmit",
    session_id: input.session_id ?? input.sessionId ?? input.conversation_id ?? input.conversationId ?? "",
    turn_id: input.turn_id ?? input.turnId ?? input.message_id ?? input.messageId ?? "",
    cwd: inputCwd(input),
    request,
  });
  return createHash("sha256").update(source).digest("hex").slice(0, 32);
}

function firstInputString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function hookIdentity(input, request, promptHash) {
  const clientSessionId = firstInputString(
    input.session_id,
    input.sessionId,
    input.conversation_id,
    input.conversationId,
    input.thread_id,
    input.threadId,
  );
  const turnId = firstInputString(input.turn_id, input.turnId, input.message_id, input.messageId, input.event_id, input.eventId);
  const suppliedRunId = firstInputString(
    process.env.DINOBRAIN_HOOK_RUN_ID,
    input.hook_run_id,
    input.hookRunId,
    input.run_id,
    input.runId,
    turnId,
  );
  const stable = Boolean(clientSessionId && suppliedRunId);
  const key = stable
    ? makePromptIdentityHash({ hookRunId: suppliedRunId, promptHash, clientSessionId })
    : hookDedupeKey(input, request);
  return {
    key,
    stable,
    hookRunId: suppliedRunId || `hookrun-${randomUUID()}`,
    clientSessionId,
    clientSessionHash: clientSessionId ? sha256(clientSessionId) : "",
    turnId,
  };
}

function promptSurface(input) {
  return firstInputString(input.prompt_surface, input.promptSurface, input.surface, input.ui_surface, input.uiSurface);
}

function promptTaskType(input) {
  return firstInputString(input.task_type, input.taskType, input.purpose, input.job_type, input.jobType);
}

function hookReceiptPath(identity) {
  if (!identity.stable) return "";
  return path.join(dataRoot, ".dino", "tmp", "hook-receipts", `${identity.key}.json`);
}

async function readHookReceipt(identity) {
  const receiptPath = hookReceiptPath(identity);
  if (!receiptPath) return null;
  const receipt = await readJsonSafe(receiptPath);
  if (!receipt || receipt.hook_dedupe_key !== identity.key) return null;
  return { receipt, receiptPath };
}

async function writeHookReceipt(identity, receipt) {
  const receiptPath = hookReceiptPath(identity);
  if (!receiptPath) return null;
  await atomicWriteJson(receiptPath, {
    version: "hook_receipt_v1",
    hook_dedupe_key: identity.key,
    hook_run_id: identity.hookRunId,
    client_session_hash: identity.clientSessionHash,
    ...receipt,
  });
  const receiptDir = path.dirname(receiptPath);
  const maxReceipts = Math.max(32, Math.min(2048, Number(process.env.DINOBRAIN_HOOK_RECEIPT_LIMIT ?? 512)));
  const entries = await fs.readdir(receiptDir, { withFileTypes: true });
  const receipts = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const filePath = path.join(receiptDir, entry.name);
    const stat = await fs.stat(filePath);
    receipts.push({ filePath, mtimeMs: stat.mtimeMs });
  }
  receipts.sort((a, b) => b.mtimeMs - a.mtimeMs);
  await Promise.all(receipts.slice(maxReceipts).map((entry) => fs.rm(entry.filePath, { force: true })));
  return receiptPath;
}

async function acquireHookLock(input, request, identity) {
  const lockDir = path.join(dataRoot, ".dino", "hook-locks");
  await fs.mkdir(lockDir, { recursive: true });
  const key = identity.key;
  const lockPath = path.join(lockDir, `${key}.json`);
  const content = `${JSON.stringify({ at: nowIso(), key, cwd: inputCwd(input), preview: preview(request) }, null, 2)}\n`;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await fs.writeFile(lockPath, content, { encoding: "utf8", flag: "wx" });
      return { acquired: true, key, path: lockPath };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      try {
        const stat = await fs.stat(lockPath);
        if (Date.now() - stat.mtimeMs > 60_000) {
          await fs.unlink(lockPath);
          continue;
        }
      } catch (statError) {
        if (statError?.code === "ENOENT") continue;
        throw statError;
      }
      return { acquired: false, key, path: lockPath };
    }
  }

  return { acquired: false, key, path: lockPath };
}

async function releaseHookLock(lock) {
  if (!lock?.acquired || !lock.path) return;
  try {
    await fs.unlink(lock.path);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

function hookOutput(additionalContext, warningReason = "") {
  const output = {
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      additionalContext: warningReason ? `${additionalContext}\n\nDinoBrain warning: ${warningReason}` : additionalContext,
    },
  };
  return output;
}

function parseTool(result) {
  const text = result.content?.find((part) => part.type === "text")?.text;
  if (!text) throw new Error("MCP tool returned no text content");
  if (result.isError) throw new Error(`MCP tool failed: ${text}`);
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`MCP tool returned invalid JSON: ${text.slice(0, 240)}`, { cause: error });
  }
}

function safeError(error) {
  return String(error?.message ?? error).replace(/\s+/g, " ").slice(0, 300);
}

async function appendDataEvent(event) {
  const eventPath = path.join(dataRoot, ".dino", "events", `${dateStamp()}.jsonl`);
  await appendFileWithLock(eventPath, `${JSON.stringify(event)}\n`);
  return path.relative(dataRoot, eventPath).split(path.sep).join("/");
}

async function writeReport(report) {
  const identity = safeSlug(report.hook_run_id ?? randomUUID()).slice(0, 64);
  const reportPath = path.join(reportRoot, `${stampForFile()}-${safeSlug(report.event ?? "hook-run")}-${identity}.json`);
  await atomicWriteJson(reportPath, report);
  return reportPath;
}

async function readJsonSafe(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    return null;
  }
}

async function findSiblingPreflightReport(dedupeKey) {
  let entries;
  try {
    entries = await fs.readdir(reportRoot, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  const files = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const filePath = path.join(reportRoot, entry.name);
    const stat = await fs.stat(filePath);
    files.push({ filePath, mtimeMs: stat.mtimeMs });
  }
  files.sort((a, b) => b.mtimeMs - a.mtimeMs);
  for (const { filePath } of files.slice(0, 25)) {
    const report = await readJsonSafe(filePath);
    if (report?.event === "codex_preflight_completed" && report.hook_dedupe_key === dedupeKey) {
      return { report, reportPath: filePath };
    }
  }
  return null;
}

async function waitForSiblingPreflightReport(dedupeKey) {
  const deadline = Date.now() + Math.max(500, Math.min(10000, Number(process.env.DINOBRAIN_HOOK_SIBLING_WAIT_MS ?? 5000)));
  while (Date.now() < deadline) {
    const match = await findSiblingPreflightReport(dedupeKey);
    if (match) return match;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  return null;
}

async function waitForHookReceipt(identity) {
  if (!identity.stable) return null;
  const deadline = Date.now() + Math.max(500, Math.min(10000, Number(process.env.DINOBRAIN_HOOK_SIBLING_WAIT_MS ?? 5000)));
  while (Date.now() < deadline) {
    const match = await readHookReceipt(identity);
    if (match) return match;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  return null;
}

async function reportFromReceipt(receipt) {
  if (typeof receipt?.report_path !== "string" || !receipt.report_path) return null;
  const reportPath = path.resolve(root, receipt.report_path);
  const relative = path.relative(reportRoot, reportPath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return null;
  const report = await readJsonSafe(reportPath);
  return report ? { report, reportPath } : null;
}

async function withClient(callback, { timeoutMs = 0 } = {}) {
  const client = new Client({ name: "dinobrain-codex-hook", version: DINOBRAIN_VERSION });
  const processMarker = String(process.env.DINOBRAIN_HOOK_PROCESS_MARKER ?? "").trim();
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: processMarker ? [serverPath, "--hook-process-marker", processMarker] : [serverPath],
    cwd: root,
    env: {
      ...process.env,
      DINOBRAIN_DATA_DIR: dataRoot,
    },
    stderr: "pipe",
  });

  let timeoutHandle;
  try {
    await client.connect(transport);
    const testDelayAfterConnectMs = Math.max(
      0,
      Math.min(10_000, Number(process.env.DINOBRAIN_HOOK_TEST_DELAY_AFTER_CONNECT_MS ?? 0)),
    );
    if (testDelayAfterConnectMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, testDelayAfterConnectMs));
    }
    const operation = Promise.resolve().then(() => callback(client));
    if (timeoutMs <= 0) return await operation;
    const timeout = new Promise((_, reject) => {
      timeoutHandle = setTimeout(() => reject(new HookSoftTimeoutError(timeoutMs)), timeoutMs);
    });
    return await Promise.race([operation, timeout]);
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
    await client.close();
  }
}

function hookSoftTimeoutMs() {
  const configured = Number(process.env.DINOBRAIN_HOOK_SOFT_TIMEOUT_MS ?? 0);
  if (Number.isFinite(configured) && configured > 0) return Math.max(1000, Math.min(30_000, configured));
  const hardSeconds = Math.max(1, Math.min(15, Number(process.env.DINOBRAIN_HOOK_TIMEOUT_SECONDS ?? 8)));
  return Math.max(1000, hardSeconds * 1000 - 2000);
}

async function activeTasksForHookFailure(context) {
  if (!context?.hookRunId || !context?.dedupeKey || !context?.promptHash) return [];
  const taskDir = path.join(dataRoot, ".dino", "tasks");
  let entries;
  try {
    entries = await fs.readdir(taskDir, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  const matches = [];
  const promptFragment = context.promptHash.slice(0, 28);
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    if (!entry.name.includes(promptFragment)) continue;
    const record = await readJsonSafe(path.join(taskDir, entry.name));
    if (
      record?.status === "started" &&
      record?.hook_run_id === context.hookRunId &&
      record?.dedupe_key === context.dedupeKey &&
      record?.prompt_hash === context.promptHash
    ) {
      matches.push(record);
    }
  }
  return matches;
}

async function settleHookFailureTasks(context, reason) {
  const settledTaskIds = [];
  const failedTaskIds = [];
  const tasks = await activeTasksForHookFailure(context);
  for (const task of tasks) {
    try {
      await withClient(async (client) =>
        parseTool(
          await client.callTool({
            name: "finish_task",
            arguments: {
              task_id: task.task_id,
              lease_id: task.lease?.lease_id,
              terminal_owner_id: task.lease?.owner_id,
              outcome: "blocked",
              summary: `DinoBrain pre-response task auto-terminalized after hook failure: ${reason}`,
              changed_files: [],
              decisions: ["Do not use an undelivered Context Pack from an aborted hook run."],
              next_steps: ["Retry from a fresh managed-hook prompt or recover through direct MCP before state-changing work."],
              context_pack_paths: [],
              used_memory_paths: [],
              session_archive_paths: [],
              candidate_paths: [],
              growth_policy: "trace_only",
            },
          }),
        ),
      );
      settledTaskIds.push(task.task_id);
    } catch {
      failedTaskIds.push(task.task_id);
    }
  }
  return { settled_task_ids: settledTaskIds, failed_task_ids: failedTaskIds };
}

function sensitivityFor(redactions) {
  if (redactions.length > 0) return "sensitive";
  const configured = process.env.DINOBRAIN_HOOK_SENSITIVITY;
  if (["normal", "sensitive", "unknown"].includes(configured)) return configured;
  return "normal";
}

function contextLines(contextPack) {
  if (!Array.isArray(contextPack.items) || contextPack.items.length === 0) {
    return ["- No matching DinoBrain memory was selected for this prompt."];
  }

  return contextPack.items.slice(0, 7).map((item) => {
    const reasonText = Array.isArray(item.reasons) && item.reasons.length > 0 ? `; reasons: ${item.reasons.join(", ")}` : "";
    const summary = item.summary ? ` - ${preview(item.summary, 220)}` : "";
    return `- ${item.path} (${item.kind}, score ${item.score}${reasonText})${summary}`;
  });
}

function sessionImportLine(sessionImport) {
  if (!sessionImport) return "session_import: unavailable";
  if (sessionImport.skipped) return `session_import: skipped (${sessionImport.reason})`;
  if (sessionImport.ok) {
    return `session_import: ${sessionImport.archive_path}; candidates: ${sessionImport.candidate_count}`;
  }
  return `session_import: failed (${sessionImport.error ?? "unknown error"})`;
}

function autoSyncLine(autoSync) {
  if (!autoSync) return "auto_sync: unavailable";
  if (autoSync.skipped) return `auto_sync: skipped (${autoSync.reason})`;
  if (autoSync.ok) {
    if (autoSync.committed) {
      return `auto_sync: committed ${autoSync.commit}${autoSync.pushed ? " and pushed" : ""}`;
    }
    return `auto_sync: no commit (${autoSync.reason ?? "no eligible changes"})`;
  }
  return `auto_sync: failed (${autoSync.error ?? autoSync.reason ?? "unknown error"})`;
}

function additionalContext({ start, contextPack, sessionImport, autoSync, redactions, reportPath, deliveryNonce }) {
  const reportRel = path.relative(root, reportPath).split(path.sep).join("/");
  const degraded = start.fail_closed === true || start.action_decision === "block";
  const taskAlreadyTerminal = Boolean(
    start.trace_path || start.record?.status === "blocked" || start.record?.lease?.state === "terminal",
  );
  const usedMemoryPaths = !degraded && Array.isArray(contextPack.items)
    ? contextPack.items.map((item) => item.path).filter(Boolean)
    : [];
  const contextPackPaths = contextPack.trace_path ? [contextPack.trace_path] : [];
  const sessionArchivePaths = sessionImport?.ok && sessionImport.archive_path ? [sessionImport.archive_path] : [];
  const candidatePaths = sessionImport?.ok && Array.isArray(sessionImport.candidate_paths) ? sessionImport.candidate_paths : [];
  return [
    degraded
      ? "DinoBrain OS preflight completed in DEGRADED NON-BLOCKING mode for this Codex prompt."
      : "DinoBrain OS preflight completed for this Codex prompt.",
    `os_version: ${start.os_version || DINOBRAIN_VERSION}`,
    `task_id: ${start.task_id}`,
    `task_path: ${start.task_path}`,
    `lease_id: ${start.lease?.lease_id || "unavailable"}`,
    `lease_owner_id: ${start.lease?.owner_id || "unavailable"}`,
    `lease_expires_at: ${start.lease?.expires_at || "unavailable"}`,
    `context_pack_trace: ${contextPack.trace_path}`,
    `context_items: ${contextPack.item_count}`,
    `gate_status: ${start.gate_status || "unknown"}`,
    `action_decision: ${start.action_decision || "unknown"}`,
    `fail_closed: ${start.fail_closed ? "true" : "false"}`,
    `persistence_policy: ${start.persistence_policy || "unknown"}`,
    `sync_policy: ${start.sync_policy || "unknown"}`,
    `context_trace_verified: ${start.context_evidence?.contextTraceVerified === true ? "true" : "false"}`,
    `context_trace_fresh: ${start.context_evidence?.contextTraceFresh === true ? "true" : "false"}`,
    `preflight_event_order_verified: ${start.preflight_evidence?.eventOrderVerified === true ? "true" : "false"}`,
    `context_delivery_nonce: ${deliveryNonce}`,
    `gate_report: ${start.gate_report_path || "unavailable"}`,
    sessionImportLine(sessionImport),
    autoSyncLine(autoSync),
    `prompt_redactions: ${redactions.length > 0 ? redactions.join(", ") : "none"}`,
    `hook_report: ${reportRel}`,
    "",
    "Relevant DinoBrain memory:",
    ...(degraded
      ? ["- The Context Pack failed verification. Do not rely on or cite its memory items for this turn."]
      : contextLines(contextPack)),
    "",
    "Agent protocol:",
    degraded
      ? "- DEGRADED CONTINUATION: continue the current user conversation without relying on rejected DinoBrain memory."
      : start.action_decision === "constrained_action"
        ? "- CONSTRAINED ACTION: proceed only within the safe actions named by the gates below."
        : "- OS context and the independent action gate are verified; proceed with the user request.",
    ...(degraded
      ? [
          "- Read-only reasoning and ordinary conversation may continue.",
          "- Before persistence, sync, release, deployment, or destructive execution, restore a verified Context Pack through direct MCP and run os_gate. If recovery fails, block only that state-changing action.",
        ]
      : []),
    ...(Array.isArray(start.gates)
      ? start.gates.map((gate) => `- gate:${gate.level}:${gate.id} -> ${gate.safe_action}`)
      : []),
    "- Treat DinoBrain memory as subordinate evidence; the current user message wins.",
    ...(!degraded
      ? [
          `- Before any new persistence, sync, or destructive action, call os_gate with task_id ${JSON.stringify(start.task_id)} and context_pack_path ${JSON.stringify(contextPack.trace_path)}; do not trust caller-declared context fields.`,
        ]
      : []),
    ...(taskAlreadyTerminal
      ? ["- The rejected preflight task was already terminalized by DinoBrain; do not call finish_task for it again."]
      : [
          `- When the work is finished, call finish_task for task_id "${start.task_id}" with summary, changed_files, decisions, next_steps, and the structured fields below.`,
          `- finish_task.lease_id = ${JSON.stringify(start.lease?.lease_id || "")}`,
          `- If work runs for a long time, call heartbeat_task with task_id "${start.task_id}" and lease_id ${JSON.stringify(start.lease?.lease_id || "")}.`,
        ]),
    start.persistence_policy === "metadata_only_no_growth"
      ? "- This task is sensitive: finish with growth_policy = \"trace_only\" and do not persist or sync the sensitive value."
      : "- For read-only audit/review tasks, set finish_task.growth_policy = \"trace_only\" so no auto-growth, compounding, or auto-sync push runs.",
    `- finish_task.context_pack_paths = ${JSON.stringify(contextPackPaths)}`,
    `- finish_task.used_memory_paths = ${JSON.stringify(usedMemoryPaths)}`,
    `- finish_task.session_archive_paths = ${JSON.stringify(sessionArchivePaths)}`,
    `- finish_task.candidate_paths = ${JSON.stringify(candidatePaths)}`,
    "- Use wiki_search only for narrow extra memory lookup.",
    "- Live view: run npm run observatory and open http://127.0.0.1:3847/.",
  ].join("\n");
}

function degradedDuplicateContext(lockPath) {
  return [
    "DinoBrain OS preflight did not inject a verified Context Pack for this Codex prompt.",
    "DEGRADED NON-BLOCKING: another matching DinoBrain hook lock exists, but no completed sibling preflight report was found.",
    `lock_path: ${path.relative(dataRoot, lockPath).split(path.sep).join("/")}`,
    "Continue ordinary conversation without DinoBrain memory. Recover direct MCP context before any state-changing action.",
  ].join("\n");
}

function siblingContext({ report, reportPath }) {
  const reportRel = path.relative(root, reportPath).split(path.sep).join("/");
  const degraded = report.fail_closed === true || report.action_decision === "block";
  const taskAlreadyTerminal = Boolean(
    report.trace_path || ["blocked", "completed", "partial"].includes(String(report.task_status ?? "")),
  );
  const contextPaths = Array.isArray(report.context_paths) ? report.context_paths : [];
  return [
    degraded
      ? "DinoBrain OS preflight completed in DEGRADED NON-BLOCKING mode by another matching DinoBrain hook."
      : "DinoBrain OS preflight completed by another matching DinoBrain hook.",
    `os_version: ${report.os_version || DINOBRAIN_VERSION}`,
    `task_id: ${report.task_id || "unavailable"}`,
    `task_path: ${report.task_path || "unavailable"}`,
    `lease_id: ${report.lease_id || "unavailable"}`,
    `context_pack_trace: ${report.context_pack_trace || "unavailable"}`,
    `context_items: ${report.context_item_count ?? "unknown"}`,
    `gate_status: ${report.gate_status || "unknown"}`,
    `action_decision: ${report.action_decision || "unknown"}`,
    `fail_closed: ${report.fail_closed === true ? "true" : "false"}`,
    `persistence_policy: ${report.persistence_policy || "unknown"}`,
    `sync_policy: ${report.sync_policy || "unknown"}`,
    `preflight_event_order_verified: ${report.preflight_event_order_verified === true ? "true" : "false"}`,
    `context_delivery_nonce: ${report.context_delivery_nonce || "unavailable"}`,
    `gate_report: ${report.gate_report_path || "unavailable"}`,
    `hook_report: ${reportRel}`,
    "",
    "Relevant DinoBrain memory:",
    ...(degraded
      ? ["- The sibling Context Pack failed verification and must not be used for this turn."]
      : contextPaths.length > 0
        ? contextPaths.slice(0, 3).map((contextPath) => `- ${contextPath}`)
      : ["- Sibling preflight did not expose individual memory paths."]),
    "",
    "Agent protocol:",
    degraded
      ? "- DEGRADED CONTINUATION: continue ordinary conversation without DinoBrain memory; recover direct MCP context before state-changing work."
      : report.action_decision === "constrained_action"
        ? "- CONSTRAINED ACTION: proceed only within the safe actions recorded by the gate report."
        : "- OS context and the independent action gate are verified; proceed with the user request.",
    ...(taskAlreadyTerminal
      ? ["- The sibling preflight task is already terminal; do not call finish_task for it again."]
      : [
          `- When the work is finished, call finish_task for task_id "${report.task_id || "unavailable"}".`,
          `- finish_task.lease_id = ${JSON.stringify(report.lease_id || "")}`,
        ]),
  ].join("\n");
}

function filteredContext({ eligibility, reportPath, receiptReused = false }) {
  const reportRel = reportPath ? path.relative(root, reportPath).split(path.sep).join("/") : "unavailable";
  return [
    "DinoBrain OS preflight completed for a non-user Codex service launch.",
    `prompt_classification: ${eligibility.classification}`,
    `durable_task_created: false`,
    `dedupe_receipt_reused: ${receiptReused ? "true" : "false"}`,
    `reason_codes: ${eligibility.reason_codes.join(", ")}`,
    `hook_report: ${reportRel}`,
    "No durable task, Context Pack, session archive, memory candidate, or sync action was created.",
  ].join("\n");
}

async function main() {
  const testDelayMs = Math.max(0, Math.min(10_000, Number(process.env.DINOBRAIN_HOOK_TEST_DELAY_MS ?? 0)));
  if (testDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, testDelayMs));
  const raw = await readStdin();
  const input = parseInput(raw);
  const prompt = extractPrompt(input);
  const { text: sanitizedPrompt, redactions } = redactPrompt(
    prompt || "Codex prompt submitted, but the hook input did not include prompt text.",
  );
  const request = sanitizedPrompt.trim();
  const startedAt = nowIso();
  const promptHash = sha256(request);
  const launchProvenance = hookLaunchProvenance();
  const identity = hookIdentity(input, request, promptHash);
  const hookRunId = identity.hookRunId;
  hookFailureContext = {
    hookRunId,
    dedupeKey: identity.key,
    promptHash,
  };
  const eligibility = classifyPromptLaunch({
    request,
    launchKind: launchProvenance.launch_kind,
    surface: promptSurface(input),
    taskType: promptTaskType(input),
    source: "codex_user_prompt_hook",
    promptPresent: Boolean(prompt.trim()),
  });
  const project = projectNameFor(input);
  const limit = Math.max(1, Math.min(20, Number(process.env.DINOBRAIN_HOOK_CONTEXT_LIMIT ?? 3)));
  const sensitivity = sensitivityFor(redactions);
  const existingReceipt = await readHookReceipt(identity);
  if (existingReceipt) {
    if (existingReceipt.receipt.status === "filtered") {
      const reportMatch = await reportFromReceipt(existingReceipt.receipt);
      const context = filteredContext({
        eligibility: existingReceipt.receipt.prompt_eligibility ?? eligibility,
        reportPath: reportMatch?.reportPath ?? null,
        receiptReused: true,
      });
      process.stdout.write(`${JSON.stringify(hookOutput(context))}\n`);
      return;
    }
    const reportMatch = await reportFromReceipt(existingReceipt.receipt);
    if (reportMatch) {
      process.stdout.write(`${JSON.stringify(hookOutput(siblingContext(reportMatch)))}\n`);
      return;
    }
  }
  const hookLock = await acquireHookLock(input, request, identity);
  if (!hookLock.acquired) {
    const receipt = await waitForHookReceipt(identity);
    if (receipt?.receipt.status === "filtered") {
      const reportMatch = await reportFromReceipt(receipt.receipt);
      process.stdout.write(
        `${JSON.stringify(
          hookOutput(
            filteredContext({
              eligibility: receipt.receipt.prompt_eligibility ?? eligibility,
              reportPath: reportMatch?.reportPath ?? null,
              receiptReused: true,
            }),
          ),
        )}\n`,
      );
      return;
    }
    const receiptReport = receipt ? await reportFromReceipt(receipt.receipt) : null;
    const sibling = receiptReport ?? (await waitForSiblingPreflightReport(hookLock.key));
    const context = sibling ? siblingContext(sibling) : degradedDuplicateContext(hookLock.path);
    process.stdout.write(
      `${JSON.stringify(
        hookOutput(context, sibling ? "" : "DinoBrain preflight duplicate lock did not produce verified sibling context."),
      )}\n`,
    );
    return;
  }

  try {
    await fs.stat(serverPath);
    if (!eligibility.durable_task_eligible) {
      const serverClassification = await withClient(async (client) =>
        parseTool(
          await client.callTool({
            name: "os_begin_task",
            arguments: {
              request,
              project,
              mode: "standard",
              sensitivity,
              limit,
              launch_kind: launchProvenance.launch_kind,
              prompt_surface: promptSurface(input) || undefined,
              task_type: promptTaskType(input) || undefined,
              launch_source: "codex_user_prompt_hook",
              hook_run_id: hookRunId,
              client_session_id: identity.clientSessionId || undefined,
              prompt_hash: promptHash,
              dedupe_key: identity.key,
              owner_id: `hook:${identity.key}`,
            },
          }),
        ),
      );
      if (serverClassification.durable_task_created !== false || serverClassification.skipped !== true) {
        throw new Error("DinoBrain server did not honor filtered prompt classification");
      }
      await appendDataEvent({
        event: "codex_prompt_filtered",
        source: "codex_hook",
        hook_run_id: hookRunId,
        at: startedAt,
        project,
        prompt_hash: promptHash,
        prompt_classification: eligibility.classification,
        prompt_eligibility_version: eligibility.version,
        prompt_eligibility_reasons: eligibility.reason_codes,
        launch_kind: launchProvenance.launch_kind,
        client_session_hash: identity.clientSessionHash || null,
      });
      const reportPath = await writeReport({
        event: "codex_preflight_filtered",
        hook_run_id: hookRunId,
        hook_dedupe_key: hookLock.key,
        at: nowIso(),
        project,
        prompt_hash: promptHash,
        prompt_eligibility: eligibility,
        launch_provenance: launchProvenance,
        durable_task_created: false,
        server_classification_event: serverClassification.event_log ?? null,
        redactions,
      });
      await writeHookReceipt(identity, {
        status: "filtered",
        completed_at: nowIso(),
        prompt_hash: promptHash,
        prompt_eligibility: eligibility,
        report_path: path.relative(root, reportPath).split(path.sep).join("/"),
      });
      process.stdout.write(`${JSON.stringify(hookOutput(filteredContext({ eligibility, reportPath })))}\n`);
      return;
    }
    await appendDataEvent({
      event: "codex_prompt_submitted",
      source: "codex_hook",
      hook_run_id: hookRunId,
      at: startedAt,
      project,
      cwd: inputCwd(input) || null,
      sensitivity,
      prompt_hash: promptHash,
      prompt_preview: preview(request),
      prompt_classification: eligibility.classification,
      hook_dedupe_key: hookLock.key,
      client_session_hash: identity.clientSessionHash || null,
      launch_provenance: launchProvenance,
      redactions,
    });

    const { start, contextPack, sessionImport } = await withClient(async (client) => {
      const beginResult = parseTool(
        await client.callTool({
          name: "os_begin_task",
          arguments: {
            request,
            project,
            mode: "standard",
            sensitivity,
            limit,
            launch_kind: launchProvenance.launch_kind,
            prompt_surface: promptSurface(input) || undefined,
            task_type: promptTaskType(input) || undefined,
            launch_source: "codex_user_prompt_hook",
            hook_run_id: hookRunId,
            client_session_id: identity.clientSessionId || undefined,
            prompt_hash: promptHash,
            dedupe_key: identity.key,
            owner_id: `hook:${identity.key}`,
            lease_seconds: Math.max(60, Math.min(7 * 24 * 60 * 60, Number(process.env.DINOBRAIN_HOOK_LEASE_SECONDS ?? 3600))),
          },
        }),
      );

      const testDelayAfterBeginMs = Math.max(
        0,
        Math.min(10_000, Number(process.env.DINOBRAIN_HOOK_TEST_DELAY_AFTER_BEGIN_MS ?? 0)),
      );
      if (testDelayAfterBeginMs > 0) {
        await new Promise((resolve) => {
          const timer = setTimeout(resolve, testDelayAfterBeginMs);
          timer.unref?.();
        });
      }

      const startResult = beginResult;
      if (startResult.skipped || startResult.durable_task_created === false) {
        throw new Error(`Interactive prompt was filtered as ${startResult.prompt_classification ?? "unknown"}`);
      }
      const contextResult = beginResult.context_pack;
      if (!contextResult?.trace_path) throw new Error("Interactive preflight returned no Context Pack trace");
      if (
        startResult.fail_closed !== true &&
        (startResult.context_evidence?.contextTraceVerified !== true ||
          startResult.context_evidence?.contextTraceFresh !== true ||
          startResult.preflight_evidence?.eventOrderVerified !== true)
      ) {
        throw new Error("Interactive preflight did not return independently verified fresh ordered evidence");
      }

      let importResult;
      if (
        envFlag("DINOBRAIN_HOOK_IMPORT_SESSION", true) &&
        startResult.fail_closed !== true &&
        startResult.persistence_policy === "normal"
      ) {
        try {
          importResult = parseTool(
            await client.callTool({
              name: "import_session",
              arguments: {
                source: "codex-user-prompt-hook",
                project,
                title: `Codex prompt ${stampForFile(new Date(startedAt))}`,
                messages: [
                  {
                    role: "user",
                    content: request,
                    at: startedAt,
                  },
                ],
                sensitivity,
                max_candidates: hookSessionMaxCandidates(),
                raw_retention: hookRawRetention(),
                task_id: startResult.task_id,
              },
            }),
          );
        } catch (error) {
          importResult = {
            ok: false,
            error: safeError(error),
          };
        }
      } else {
        importResult = {
          skipped: true,
          reason:
            startResult.fail_closed === true
              ? "pre_response_gate_blocked"
              : startResult.persistence_policy !== "normal"
                ? "sensitive_metadata_only_policy"
                : "DINOBRAIN_HOOK_IMPORT_SESSION disabled",
        };
      }

      return { start: startResult, contextPack: contextResult, sessionImport: importResult };
    }, { timeoutMs: hookSoftTimeoutMs() });

    let autoSync;
    if (
      envFlag("DINOBRAIN_HOOK_AUTO_SYNC", true) &&
      start.fail_closed !== true &&
      start.persistence_policy === "normal" &&
      start.sync_policy !== "blocked"
    ) {
      try {
        const allowedPaths = [
          start.task_path,
          contextPack.trace_path,
          start.gate_report_path,
        ].filter((item) => typeof item === "string" && item.length > 0);
        autoSync = await withClient(async (client) =>
          parseTool(
            await client.callTool({
              name: "auto_sync",
              arguments: {
                include_sensitive_scan: true,
                allow_conditional: envFlag("DINOBRAIN_AUTO_SYNC_ALLOW_CONDITIONAL", false),
                push: envFlag("DINOBRAIN_AUTO_SYNC_PUSH", false),
                commit_message: `data: auto sync Codex preflight ${stampForFile(new Date(startedAt))}`,
                task_id: start.task_id,
                allowed_paths: allowedPaths,
              },
            }),
          ),
        );
      } catch (error) {
        autoSync = {
          ok: false,
          error: safeError(error),
        };
      }
    } else {
      autoSync = {
        skipped: true,
        reason:
          start.fail_closed === true
            ? "pre_response_gate_blocked"
            : start.persistence_policy !== "normal"
              ? "sensitive_metadata_only_policy"
              : start.sync_policy === "blocked"
                ? "sync_policy_blocked"
                : "DINOBRAIN_HOOK_AUTO_SYNC disabled",
      };
    }

    const deliveryNonce = `delivery-${randomUUID()}`;
    const reportPath = await writeReport({
      event: "codex_preflight_completed",
      hook_run_id: hookRunId,
      hook_dedupe_key: hookLock.key,
      at: nowIso(),
      data_root: dataRoot,
      project,
      cwd: inputCwd(input) || null,
      prompt_hash: promptHash,
      prompt_classification: eligibility.classification,
      prompt_eligibility: eligibility,
      client_session_hash: identity.clientSessionHash || null,
      stable_dedupe_identity: identity.stable,
      launch_provenance: launchProvenance,
      os_version: start.os_version || DINOBRAIN_VERSION,
      task_id: start.task_id,
      task_path: start.task_path,
      task_status: start.record?.status ?? (start.trace_path ? "blocked" : "started"),
      trace_path: start.trace_path ?? null,
      lease_id: start.lease?.lease_id ?? null,
      lease_owner_id: start.lease?.owner_id ?? null,
      lease_expires_at: start.lease?.expires_at ?? null,
      context_pack_trace: contextPack.trace_path,
      context_item_count: contextPack.item_count,
      gate_status: start.gate_status || "unknown",
      action_decision: start.action_decision || "unknown",
      fail_closed: start.fail_closed === true,
      gate_reason_codes: start.reason_codes ?? [],
      persistence_policy: start.persistence_policy || "unknown",
      sync_policy: start.sync_policy || "unknown",
      context_trace_verified: start.context_evidence?.contextTraceVerified === true,
      context_trace_fresh: start.context_evidence?.contextTraceFresh === true,
      context_trace_sha256: start.context_evidence?.contextTraceSha256 ?? contextPack.trace_sha256 ?? null,
      preflight_event_order_verified: start.preflight_evidence?.eventOrderVerified === true,
      preflight_event_order: start.preflight_evidence?.eventOrder ?? [],
      context_delivery_nonce: deliveryNonce,
      context_delivery_status: "preparing",
      gate_report_path: start.gate_report_path || null,
      context_paths: Array.isArray(contextPack.items) ? contextPack.items.map((item) => item.path) : [],
      session_import: sessionImport?.ok
        ? {
            session_id: sessionImport.session_id,
            archive_path: sessionImport.archive_path,
            candidate_count: sessionImport.candidate_count,
            candidate_paths: sessionImport.candidate_paths,
            review_paths: sessionImport.review_paths,
            temperature_counts: sessionImport.temperature_counts,
            category_counts: sessionImport.category_counts,
          }
        : sessionImport,
      auto_sync: autoSync,
      redactions,
    });

    const receiptPath = await writeHookReceipt(identity, {
      status: "completed",
      completed_at: nowIso(),
      prompt_hash: promptHash,
      task_id: start.task_id,
      lease_id: start.lease?.lease_id ?? null,
      report_path: path.relative(root, reportPath).split(path.sep).join("/"),
    });

    const context = additionalContext({
      start,
      contextPack,
      sessionImport,
      autoSync,
      redactions,
      reportPath,
      deliveryNonce,
    });
    const contextSha256 = sha256(context);
    const existingReport = (await readJsonSafe(reportPath)) ?? {};
    await atomicWriteJson(reportPath, {
      ...existingReport,
      context_delivery_status: "ready_for_model",
      context_delivery_sha256: contextSha256,
      receipt_path: receiptPath ? path.relative(dataRoot, receiptPath).split(path.sep).join("/") : null,
    });
    await appendDataEvent({
      event: "codex_preflight_completed",
      source: "codex_hook",
      hook_run_id: hookRunId,
      at: nowIso(),
      task_id: start.task_id,
      task_path: start.task_path,
      lease_id: start.lease?.lease_id ?? null,
      lease_owner_id: start.lease?.owner_id ?? null,
      lease_expires_at: start.lease?.expires_at ?? null,
      context_pack_trace: contextPack.trace_path,
      context_trace_sha256: start.context_evidence?.contextTraceSha256 ?? contextPack.trace_sha256 ?? null,
      context_item_count: contextPack.item_count,
      context_paths: Array.isArray(contextPack.items) ? contextPack.items.map((item) => item.path) : [],
      prompt_hash: promptHash,
      prompt_classification: eligibility.classification,
      hook_dedupe_key: hookLock.key,
      client_session_hash: identity.clientSessionHash || null,
      launch_provenance: launchProvenance,
      gate_status: start.gate_status || "unknown",
      action_decision: start.action_decision || "unknown",
      fail_closed: start.fail_closed === true,
      gate_reason_codes: start.reason_codes ?? [],
      persistence_policy: start.persistence_policy || "unknown",
      sync_policy: start.sync_policy || "unknown",
      preflight_event_order_verified: start.preflight_evidence?.eventOrderVerified === true,
      preflight_event_order: [...(start.preflight_evidence?.eventOrder ?? []), "codex_preflight_completed"],
      context_delivery_status: "ready_for_model",
      context_delivery_nonce: deliveryNonce,
      context_delivery_sha256: contextSha256,
      hook_report: path.relative(root, reportPath).split(path.sep).join("/"),
      receipt_path: receiptPath ? path.relative(dataRoot, receiptPath).split(path.sep).join("/") : null,
      redactions,
    });
    process.stdout.write(
      `${JSON.stringify(
        hookOutput(
          context,
          start.fail_closed || start.action_decision === "block"
            ? "DinoBrain memory verification failed; conversation continues in degraded mode."
            : "",
        ),
      )}\n`,
    );
  } finally {
    await releaseHookLock(hookLock);
  }
}

main().catch(async (error) => {
  const message = safeError(error);
  let timeoutCleanup = { settled_task_ids: [], failed_task_ids: [] };
  try {
    timeoutCleanup = await settleHookFailureTasks(hookFailureContext, message);
  } catch (cleanupError) {
    timeoutCleanup = { settled_task_ids: [], failed_task_ids: [], error: safeError(cleanupError) };
  }
  try {
    await appendDataEvent({
      event: "codex_preflight_failed",
      source: "codex_hook",
      at: nowIso(),
      error: message,
      hook_run_id: hookFailureContext?.hookRunId ?? null,
      prompt_hash: hookFailureContext?.promptHash ?? null,
      timeout_cleanup: timeoutCleanup,
    });
  } catch {
    // Keep hook output valid even if the data vault is unavailable.
  }

  process.stdout.write(
    `${JSON.stringify(
      hookOutput(
        [
          `DinoBrain OS preflight failed: ${message}`,
          "DEGRADED MODE: continue with the current user instruction; no DinoBrain Context Pack was injected for this turn.",
          `timeout_cleanup: settled=${timeoutCleanup.settled_task_ids.length}, failed=${timeoutCleanup.failed_task_ids.length}`,
          "If this persists, run npm run build and npm run hook:verify from the DinoBrain repo.",
        ].join("\n"),
        "DinoBrain OS preflight failed before context injection.",
      ),
    )}\n`,
  );
  process.exitCode = 0;
});
