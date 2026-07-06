import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(__dirname, "..");
const sessionIngestModule = await import(pathToFileURL(path.join(appRoot, "dist", "session-ingest.js")).href);
const { redactSensitiveText } = sessionIngestModule;

const DEFAULT_DATA_ROOT = process.env.DINOBRAIN_DATA_DIR || path.join(process.env.USERPROFILE || "", "Documents", "dinobrain-data");
const DEFAULT_SESSIONS_DIR = path.join(process.env.USERPROFILE || "", ".codex", "sessions");

const args = new Map();
for (let index = 2; index < process.argv.length; index += 1) {
  const arg = process.argv[index];
  if (!arg.startsWith("--")) continue;
  const [key, inlineValue] = arg.slice(2).split("=", 2);
  const value = inlineValue ?? (process.argv[index + 1]?.startsWith("--") ? "true" : process.argv[++index] ?? "true");
  args.set(key, value);
}

const write = args.get("write") === "true";
const dataRoot = path.resolve(String(args.get("data-root") || DEFAULT_DATA_ROOT));
const sessionsDir = path.resolve(String(args.get("sessions-dir") || DEFAULT_SESSIONS_DIR));
const importedAt = new Date().toISOString();

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function shortHash(value, length = 12) {
  return sha256(value).slice(0, length);
}

function safeSlug(value) {
  const slug = String(value || "")
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 96);
  return slug || "codex-session";
}

function walkJsonl(dir, acc = []) {
  if (!existsSync(dir)) return acc;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkJsonl(full, acc);
    else if (entry.isFile() && entry.name.toLowerCase().endsWith(".jsonl")) acc.push(full);
  }
  return acc;
}

function textFromContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (!part || typeof part !== "object") return "";
      if (typeof part.text === "string") return part.text;
      if (typeof part.content === "string") return part.content;
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function projectLabel(cwd) {
  if (typeof cwd !== "string" || cwd.trim().length === 0) return null;
  return path.basename(cwd.replace(/[\\/]+$/, "")) || null;
}

function mergeHits(target, hits) {
  for (const hit of hits || []) {
    target.set(hit.pattern, (target.get(hit.pattern) || 0) + hit.count);
  }
}

function parseSession(file) {
  const raw = readFileSync(file, "utf8");
  const sourceHash = sha256(raw);
  const relSource = path.relative(sessionsDir, file).replace(/\\/g, "/");
  const stat = statSync(file);
  let meta = {};
  const messages = [];
  const redactionCounts = new Map();

  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let item;
    try {
      item = JSON.parse(line);
    } catch {
      continue;
    }
    const payload = item.payload || {};
    if (item.type === "session_meta" && typeof payload === "object") {
      meta = { ...meta, ...payload };
      continue;
    }
    if (item.type !== "response_item" || payload.type !== "message") continue;
    const role = payload.role === "user" || payload.role === "assistant" ? payload.role : null;
    if (!role) continue;
    const content = textFromContent(payload.content).trim();
    if (!content) continue;
    const redacted = redactSensitiveText(content);
    mergeHits(redactionCounts, redacted.hits);
    messages.push({
      role,
      at: typeof item.timestamp === "string" ? item.timestamp : null,
      original_char_count: content.length,
      redacted_sha256: sha256(redacted.text),
    });
  }

  const threadId = String(meta.id || meta.session_id || path.basename(file, ".jsonl"));
  const sessionId = `codex-${safeSlug(threadId).slice(0, 44)}-${shortHash(relSource, 8)}`;
  const archivePath = `10_Conversations/raw/${sessionId}.json`;
  const startedAt = String(meta.timestamp || messages[0]?.at || stat.birthtime.toISOString());
  const userCount = messages.filter((message) => message.role === "user").length;
  const assistantCount = messages.filter((message) => message.role === "assistant").length;
  const totalChars = messages.reduce((sum, message) => sum + message.original_char_count, 0);
  const redactions = Array.from(redactionCounts, ([pattern, count]) => ({ pattern, count }));

  const archive = {
    session_id: sessionId,
    status: "raw_imported",
    source: "codex-jsonl",
    source_relative_path: relSource,
    source_sha256: sourceHash,
    thread_id: threadId,
    project: projectLabel(meta.cwd),
    title: path.basename(file, ".jsonl"),
    sensitivity: "sensitive",
    temperature: "cold",
    sync_policy: "local_only",
    storage_policy: {
      raw_full_transcript_stored: false,
      raw_retention: "metadata_only",
      message_content_stored: false,
      candidate_promotion_requires_review: true,
    },
    imported_at: importedAt,
    session_started_at: startedAt,
    message_count: messages.length,
    user_message_count: userCount,
    assistant_message_count: assistantCount,
    total_message_chars: totalChars,
    messages: messages.map((message, index) => ({
      message_id: `m${String(index + 1).padStart(4, "0")}`,
      role: message.role,
      at: message.at,
      original_char_count: message.original_char_count,
      redacted_sha256: message.redacted_sha256,
      preview: null,
      preview_truncated: false,
    })),
    extraction: {
      version: "codex_session_registry_v1",
      candidate_count: 0,
      candidate_paths: [],
      review_paths: [],
      next_step: "Run a separate reviewed extraction/promotion pass before any content enters accepted memory.",
    },
    redactions,
  };

  return {
    sessionId,
    archivePath,
    archive,
    relSource,
    startedAt,
    threadId,
    project: archive.project,
    sourceHash,
    fileSize: stat.size,
    messageCount: messages.length,
    userCount,
    assistantCount,
    totalChars,
    redactionCount: redactions.reduce((sum, hit) => sum + hit.count, 0),
  };
}

function ensureDirFor(file) {
  mkdirSync(path.dirname(file), { recursive: true });
}

function writeJson(relativePath, value) {
  const full = path.join(dataRoot, ...relativePath.split("/"));
  ensureDirFor(full);
  writeFileSync(full, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function writeText(relativePath, value) {
  const full = path.join(dataRoot, ...relativePath.split("/"));
  ensureDirFor(full);
  writeFileSync(full, value, "utf8");
}

function existingArchiveHash(relativePath) {
  const full = path.join(dataRoot, ...relativePath.split("/"));
  if (!existsSync(full)) return null;
  try {
    const parsed = JSON.parse(readFileSync(full, "utf8"));
    return typeof parsed.source_sha256 === "string" ? parsed.source_sha256 : null;
  } catch {
    return null;
  }
}

function markdownTable(rows) {
  const header = "| Started | Session | Project | Messages | User | Assistant | Chars | Archive |\n| --- | --- | --- | ---: | ---: | ---: | ---: | --- |";
  const body = rows
    .map((row) =>
      [
        row.startedAt.slice(0, 10),
        `\`${row.sessionId}\``,
        row.project ? `\`${row.project.replace(/\|/g, " ")}\`` : "",
        row.messageCount,
        row.userCount,
        row.assistantCount,
        row.totalChars,
        `\`${row.archivePath}\``,
      ].join(" | "),
    )
    .map((line) => `| ${line} |`)
    .join("\n");
  return `${header}\n${body}`;
}

const files = walkJsonl(sessionsDir).sort();
const sessions = files.map(parseSession).filter((session) => session.messageCount > 0);
let imported = 0;
let updated = 0;
let skipped = 0;

for (const session of sessions) {
  const existingHash = existingArchiveHash(session.archivePath);
  if (existingHash === session.sourceHash) {
    skipped += 1;
    continue;
  }
  if (write) writeJson(session.archivePath, session.archive);
  if (existingHash) updated += 1;
  else imported += 1;
}

const registryPath = "20_Wiki/Codex-Conversation-Registry.md";
const reportPath = "60_Operations/session-imports/codex-conversation-registry.json";
const eventPath = `.dino/events/${importedAt.slice(0, 10)}.jsonl`;
const totalMessages = sessions.reduce((sum, session) => sum + session.messageCount, 0);
const totalChars = sessions.reduce((sum, session) => sum + session.totalChars, 0);
const totalRedactions = sessions.reduce((sum, session) => sum + session.redactionCount, 0);
const projectCounts = {};
for (const session of sessions) {
  const key = session.project || "unknown";
  projectCounts[key] = (projectCounts[key] || 0) + 1;
}

const sortedSessions = sessions.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
const projectCountLines = Object.entries(projectCounts)
  .sort(([a], [b]) => a.localeCompare(b))
  .map(([project, count]) => `- ${project}: ${count}`)
  .join("\n");
const wiki = [
  "---",
  "title: Codex Conversation Registry",
  "summary: Metadata-only registry of Codex conversations imported as local-only source archives; no raw transcript content is stored here.",
  "tags: [codex, sessions, llm-wiki, conversation-registry, local-only-source]",
  "---",
  "",
  "# Codex Conversation Registry",
  "",
  "Status: metadata-only source registration.",
  `Imported at: ${importedAt}`,
  `Sessions scanned: ${sessions.length}`,
  `Messages indexed as metadata: ${totalMessages}`,
  "Raw full transcripts stored: false",
  "Message content stored in this Wiki page: false",
  "",
  "## Policy",
  "",
  "This registry records that Codex sessions exist as source material for the LLM Wiki. It does not store raw conversation text, assistant/tool output, secrets, or full transcripts. Per-session source archives are metadata-only and local-only under `10_Conversations/raw`. Any content-level memory must be extracted and reviewed in a separate promotion pass before it can enter accepted memory.",
  "",
  "## Project Counts",
  "",
  projectCountLines,
  "",
  "## Sessions",
  "",
  markdownTable(sortedSessions),
  "",
].join("\n");

const report = {
  ok: true,
  mode: "metadata_only_registry",
  imported_at: importedAt,
  sessions_dir: "local-codex-sessions",
  data_root: "local-dinobrain-data",
  registry_path: registryPath,
  report_path: reportPath,
  raw_full_transcript_stored: false,
  message_content_stored: false,
  candidate_count: 0,
  session_count: sessions.length,
  imported,
  updated,
  skipped,
  total_messages: totalMessages,
  total_message_chars: totalChars,
  total_redaction_hits: totalRedactions,
  project_counts: projectCounts,
  sessions: sortedSessions.map((session) => ({
    session_id: session.sessionId,
    thread_id: session.threadId,
    started_at: session.startedAt,
    project: session.project,
    archive_path: session.archivePath,
    source_relative_path: session.relSource,
    source_sha256: session.sourceHash,
    file_size: session.fileSize,
    message_count: session.messageCount,
    user_message_count: session.userCount,
    assistant_message_count: session.assistantCount,
    total_message_chars: session.totalChars,
    redaction_hits: session.redactionCount,
  })),
};

if (write) {
  writeText(registryPath, wiki);
  writeJson(reportPath, report);
  const eventFull = path.join(dataRoot, ...eventPath.split("/"));
  ensureDirFor(eventFull);
  writeFileSync(
    eventFull,
    `${JSON.stringify({
      event: "codex_sessions_registered",
      at: importedAt,
      mode: "metadata_only_registry",
      registry_path: registryPath,
      report_path: reportPath,
      session_count: sessions.length,
      imported,
      updated,
      skipped,
      raw_full_transcript_stored: false,
      message_content_stored: false,
      candidate_count: 0,
    })}\n`,
    { encoding: "utf8", flag: "a" },
  );
}

console.log(JSON.stringify(report, null, 2));
