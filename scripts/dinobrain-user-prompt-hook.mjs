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
      return { acquired: true, path: lockPath };
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
      return { acquired: false, path: lockPath };
    }
  }

  return { acquired: false, path: lockPath };
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

async function withClient(callback) {
  const client = new Client({ name: "dinobrain-codex-hook", version: "0.1.0" });
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

function additionalContext({ start, contextPack, redactions, reportPath }) {
  const reportRel = path.relative(root, reportPath).split(path.sep).join("/");
  return [
    "DinoBrain OS preflight completed for this Codex prompt.",
    `task_id: ${start.task_id}`,
    `task_path: ${start.task_path}`,
    `context_pack_trace: ${contextPack.trace_path}`,
    `context_items: ${contextPack.item_count}`,
    `prompt_redactions: ${redactions.length > 0 ? redactions.join(", ") : "none"}`,
    `hook_report: ${reportRel}`,
    "",
    "Relevant DinoBrain memory:",
    ...contextLines(contextPack),
    "",
    "Agent protocol:",
    "- Treat DinoBrain memory as subordinate evidence; the current user message wins.",
    `- When the work is finished, call finish_task for task_id "${start.task_id}" with summary, changed_files, decisions, and next_steps.`,
    "- Use wiki_search only for narrow extra memory lookup.",
    "- Live view: run npm run observatory and open http://127.0.0.1:3847/.",
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
    process.stdout.write(
      `${JSON.stringify(
        hookOutput(
          [
            "DinoBrain OS preflight skipped because another matching DinoBrain hook is already handling this prompt.",
            "Use the other injected DinoBrain context for this turn.",
          ].join("\n"),
        ),
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

    const { start, contextPack } = await withClient(async (client) => {
      const startResult = parseTool(
        await client.callTool({
          name: "start_task",
          arguments: {
            request,
            project,
            mode: "standard",
            sensitivity,
          },
        }),
      );

      const contextResult = parseTool(
        await client.callTool({
          name: "get_context_pack",
          arguments: {
            question: request,
            limit,
          },
        }),
      );

      return { start: startResult, contextPack: contextResult };
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
      redactions,
    });

    const reportPath = await writeReport({
      event: "codex_preflight_completed",
      at: nowIso(),
      data_root: dataRoot,
      project,
      cwd: inputCwd(input) || null,
      task_id: start.task_id,
      task_path: start.task_path,
      context_pack_trace: contextPack.trace_path,
      context_item_count: contextPack.item_count,
      context_paths: Array.isArray(contextPack.items) ? contextPack.items.map((item) => item.path) : [],
      redactions,
    });

    process.stdout.write(`${JSON.stringify(hookOutput(additionalContext({ start, contextPack, redactions, reportPath })))}\n`);
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
          "Continue with the current user request; no DinoBrain Context Pack was injected for this turn.",
          "If this persists, run npm run build and npm run hook:verify from the DinoBrain repo.",
        ].join("\n"),
      ),
    )}\n`,
  );
  process.exitCode = 0;
});
