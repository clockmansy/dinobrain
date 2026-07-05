import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = path.resolve(process.env.DINOBRAIN_REPO_ROOT ?? path.join(path.dirname(fileURLToPath(import.meta.url)), ".."));
const serverPath = path.join(root, "dist", "index.js");
const dataRoot = path.resolve(process.env.DINOBRAIN_DATA_DIR ?? path.join(root, "..", "dinobrain-data"));
const reportRoot = path.resolve(process.env.DINOBRAIN_HOOK_REPORT_DIR ?? path.join(root, "reports", "live-hooks"));

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

  text = text.replace(/\b(api[_-]?key|secret|token|password|session|sessionid|cookie)\s*[:=]\s*(['"]?)([^\s"',;]+)/gi, (_match, key) => {
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

async function acquireHookLock(input, request) {
  const lockDir = path.join(dataRoot, ".dino", "hook-locks");
  await fs.mkdir(lockDir, { recursive: true });
  const key = hookDedupeKey(input, request);
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

function hookOutput(additionalContext) {
  return {
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      additionalContext,
    },
  };
}

function parseTool(result) {
  const text = result.content?.find((part) => part.type === "text")?.text;
  if (!text) throw new Error("MCP tool returned no text content");
  return JSON.parse(text);
}

function safeError(error) {
  return String(error?.message ?? error).replace(/\s+/g, " ").slice(0, 300);
}

async function appendDataEvent(event) {
  const eventPath = path.join(dataRoot, ".dino", "events", `${dateStamp()}.jsonl`);
  await fs.mkdir(path.dirname(eventPath), { recursive: true });
  await fs.appendFile(eventPath, `${JSON.stringify(event)}\n`, "utf8");
  return path.relative(dataRoot, eventPath).split(path.sep).join("/");
}

async function writeReport(report) {
  await fs.mkdir(reportRoot, { recursive: true });
  const reportPath = path.join(reportRoot, `${stampForFile()}-${safeSlug(report.event ?? "hook-run")}.json`);
  await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
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

async function withClient(callback) {
  const client = new Client({ name: "dinobrain-codex-hook", version: "2.0.2" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath],
    cwd: root,
    env: {
      ...process.env,
      DINOBRAIN_DATA_DIR: dataRoot,
    },
    stderr: "pipe",
  });

  try {
    await client.connect(transport);
    return await callback(client);
  } finally {
    await client.close();
  }
}

function sensitivityFor(redactions) {
  if (redactions.length > 0) return "sensitive";
  const configured = process.env.DINOBRAIN_HOOK_SENSITIVITY;
  if (["normal", "sensitive", "unknown"].includes(configured)) return configured;
  return "unknown";
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

function additionalContext({ start, contextPack, sessionImport, redactions, reportPath }) {
  const reportRel = path.relative(root, reportPath).split(path.sep).join("/");
  const usedMemoryPaths = Array.isArray(contextPack.items)
    ? contextPack.items.map((item) => item.path).filter(Boolean)
    : [];
  const contextPackPaths = contextPack.trace_path ? [contextPack.trace_path] : [];
  const sessionArchivePaths = sessionImport?.ok && sessionImport.archive_path ? [sessionImport.archive_path] : [];
  const candidatePaths = sessionImport?.ok && Array.isArray(sessionImport.candidate_paths) ? sessionImport.candidate_paths : [];
  return [
    start.fail_closed
      ? "DinoBrain OS preflight completed in FAIL-CLOSED mode for this Codex prompt."
      : "DinoBrain OS preflight completed for this Codex prompt.",
    `os_version: ${start.os_version || "2.0.2"}`,
    `task_id: ${start.task_id}`,
    `task_path: ${start.task_path}`,
    `context_pack_trace: ${contextPack.trace_path}`,
    `context_items: ${contextPack.item_count}`,
    `gate_status: ${start.gate_status || "unknown"}`,
    `fail_closed: ${start.fail_closed ? "true" : "false"}`,
    `gate_report: ${start.gate_report_path || "unavailable"}`,
    sessionImportLine(sessionImport),
    `prompt_redactions: ${redactions.length > 0 ? redactions.join(", ") : "none"}`,
    `hook_report: ${reportRel}`,
    "",
    "Relevant DinoBrain memory:",
    ...contextLines(contextPack),
    "",
    "Agent protocol:",
    start.fail_closed
      ? "- FAIL-CLOSED: do not perform substantial work. Explain the block and restore OS context/gate safety first."
      : "- OS context is present; proceed with the user request under the gates below.",
    ...(Array.isArray(start.gates)
      ? start.gates.map((gate) => `- gate:${gate.level}:${gate.id} -> ${gate.safe_action}`)
      : []),
    "- Treat DinoBrain memory as subordinate evidence; the current user message wins.",
    `- When the work is finished, call finish_task for task_id "${start.task_id}" with summary, changed_files, decisions, next_steps, and the structured fields below.`,
    `- finish_task.context_pack_paths = ${JSON.stringify(contextPackPaths)}`,
    `- finish_task.used_memory_paths = ${JSON.stringify(usedMemoryPaths)}`,
    `- finish_task.session_archive_paths = ${JSON.stringify(sessionArchivePaths)}`,
    `- finish_task.candidate_paths = ${JSON.stringify(candidatePaths)}`,
    "- Use wiki_search only for narrow extra memory lookup.",
    "- Live view: run npm run observatory and open http://127.0.0.1:3847/.",
  ].join("\n");
}

function failClosedDuplicateContext(lockPath) {
  return [
    "DinoBrain OS preflight did not inject a verified Context Pack for this Codex prompt.",
    "FAIL-CLOSED: another matching DinoBrain hook lock exists, but no completed sibling preflight report was found.",
    `lock_path: ${path.relative(dataRoot, lockPath).split(path.sep).join("/")}`,
    "Do not perform substantial work until the DinoBrain hook/MCP setup is repaired or a new trusted session is started.",
  ].join("\n");
}

function siblingContext({ report, reportPath }) {
  const reportRel = path.relative(root, reportPath).split(path.sep).join("/");
  const failClosed = report.fail_closed === true;
  const contextPaths = Array.isArray(report.context_paths) ? report.context_paths : [];
  return [
    failClosed
      ? "DinoBrain OS preflight completed in FAIL-CLOSED mode by another matching DinoBrain hook."
      : "DinoBrain OS preflight completed by another matching DinoBrain hook.",
    `os_version: ${report.os_version || "2.0.2"}`,
    `task_id: ${report.task_id || "unavailable"}`,
    `task_path: ${report.task_path || "unavailable"}`,
    `context_pack_trace: ${report.context_pack_trace || "unavailable"}`,
    `context_items: ${report.context_item_count ?? "unknown"}`,
    `gate_status: ${report.gate_status || "unknown"}`,
    `fail_closed: ${failClosed ? "true" : "false"}`,
    `gate_report: ${report.gate_report_path || "unavailable"}`,
    `hook_report: ${reportRel}`,
    "",
    "Relevant DinoBrain memory:",
    ...(contextPaths.length > 0
      ? contextPaths.slice(0, 7).map((contextPath) => `- ${contextPath}`)
      : ["- Sibling preflight did not expose individual memory paths."]),
    "",
    "Agent protocol:",
    failClosed
      ? "- FAIL-CLOSED: do not perform substantial work. Explain the block and restore OS context/gate safety first."
      : "- OS context is present; proceed with the user request under the gates below.",
    `- When the work is finished, call finish_task for task_id "${report.task_id || "unavailable"}".`,
  ].join("\n");
}

async function main() {
  const raw = await readStdin();
  const input = parseInput(raw);
  const prompt = extractPrompt(input);
  const { text: sanitizedPrompt, redactions } = redactPrompt(
    prompt || "Codex prompt submitted, but the hook input did not include prompt text.",
  );
  const request = sanitizedPrompt.trim();
  const startedAt = nowIso();
  const project = projectNameFor(input);
  const limit = Math.max(1, Math.min(20, Number(process.env.DINOBRAIN_HOOK_CONTEXT_LIMIT ?? 7)));
  const sensitivity = sensitivityFor(redactions);
  const hookLock = await acquireHookLock(input, request);
  if (!hookLock.acquired) {
    const sibling = await waitForSiblingPreflightReport(hookLock.key);
    process.stdout.write(
      `${JSON.stringify(
        hookOutput(sibling ? siblingContext(sibling) : failClosedDuplicateContext(hookLock.path)),
      )}\n`,
    );
    return;
  }

  try {
    await fs.stat(serverPath);
    await appendDataEvent({
      event: "codex_prompt_submitted",
      source: "codex_hook",
      at: startedAt,
      project,
      cwd: inputCwd(input) || null,
      sensitivity,
      prompt_preview: preview(request),
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
          },
        }),
      );

      const startResult = beginResult;
      const contextResult = beginResult.context_pack;

      let importResult;
      if (envFlag("DINOBRAIN_HOOK_IMPORT_SESSION", true)) {
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
          reason: "DINOBRAIN_HOOK_IMPORT_SESSION disabled",
        };
      }

      return { start: startResult, contextPack: contextResult, sessionImport: importResult };
    });

    await appendDataEvent({
      event: "codex_preflight_completed",
      source: "codex_hook",
      at: nowIso(),
      task_id: start.task_id,
      task_path: start.task_path,
      context_pack_trace: contextPack.trace_path,
      context_item_count: contextPack.item_count,
      context_paths: Array.isArray(contextPack.items) ? contextPack.items.map((item) => item.path) : [],
      session_import: sessionImport?.ok
        ? {
            session_id: sessionImport.session_id,
            archive_path: sessionImport.archive_path,
            candidate_count: sessionImport.candidate_count,
            review_paths: sessionImport.review_paths,
          }
        : sessionImport,
      redactions,
    });

    const reportPath = await writeReport({
      event: "codex_preflight_completed",
      hook_dedupe_key: hookLock.key,
      at: nowIso(),
      data_root: dataRoot,
      project,
      cwd: inputCwd(input) || null,
      os_version: start.os_version || "2.0.2",
      task_id: start.task_id,
      task_path: start.task_path,
      context_pack_trace: contextPack.trace_path,
      context_item_count: contextPack.item_count,
      gate_status: start.gate_status || "unknown",
      fail_closed: start.fail_closed === true,
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
      redactions,
    });

    process.stdout.write(
      `${JSON.stringify(hookOutput(additionalContext({ start, contextPack, sessionImport, redactions, reportPath })))}\n`,
    );
  } finally {
    await releaseHookLock(hookLock);
  }
}

main().catch(async (error) => {
  const message = safeError(error);
  try {
    await appendDataEvent({
      event: "codex_preflight_failed",
      source: "codex_hook",
      at: nowIso(),
      error: message,
    });
  } catch {
    // Keep hook output valid even if the data vault is unavailable.
  }

  process.stdout.write(
    `${JSON.stringify(
      hookOutput(
        [
          `DinoBrain OS preflight failed: ${message}`,
          "FAIL-CLOSED: do not perform substantial work because no DinoBrain Context Pack was injected for this turn.",
          "Only explain the block or repair the DinoBrain hook/MCP setup.",
          "If this persists, run npm run build and npm run hook:verify from the DinoBrain repo.",
        ].join("\n"),
      ),
    )}\n`,
  );
  process.exitCode = 0;
});
