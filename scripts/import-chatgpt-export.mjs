import { createHash } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  appendFileWithLockSync,
  atomicWriteJsonSync,
  atomicWriteTextSync,
} from "./lib/atomic-files-sync.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(__dirname, "..");
const readerScript = path.join(__dirname, "read-chatgpt-export-entry.ps1");
const sessionIngestPath = path.join(appRoot, "dist", "session-ingest.js");

if (!existsSync(sessionIngestPath)) {
  throw new Error("DinoBrain build output is missing. Run npm run build before importing a ChatGPT export.");
}

const { redactSensitiveText } = await import(pathToFileURL(sessionIngestPath).href);

const args = new Map();
for (let index = 2; index < process.argv.length; index += 1) {
  const arg = process.argv[index];
  if (!arg.startsWith("--")) continue;
  const [key, inlineValue] = arg.slice(2).split("=", 2);
  const value = inlineValue ?? (process.argv[index + 1]?.startsWith("--") ? "true" : process.argv[++index] ?? "true");
  args.set(key, value);
}

const zipArgument = String(args.get("zip") ?? "").trim();
if (!zipArgument) throw new Error("ChatGPT export ZIP is required: --zip <path>");

const zipPath = path.resolve(zipArgument);
if (!existsSync(zipPath)) throw new Error(`ChatGPT export ZIP does not exist: ${zipPath}`);

const write = args.get("write") === "true";
const dataRoot = path.resolve(
  String(
    args.get("data-root") ??
      process.env.DINOBRAIN_DATA_DIR ??
      path.join(process.env.USERPROFILE ?? "", "Documents", "dinobrain-data"),
  ),
);
const importedAt = new Date().toISOString();
const powershell = existsSync(
  path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
)
  ? path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
  : "powershell";

const REGISTRY_PATH = "20_Wiki/ChatGPT-Conversation-Registry.md";
const PROFILE_PATH = "20_Wiki/ChatGPT-Session-Knowledge-Profile.md";
const REGISTRY_REPORT_PATH = "60_Operations/session-imports/chatgpt-export-registry.json";
const PROMOTION_REPORT_PATH = "60_Operations/session-promotions/chatgpt-session-knowledge-promotion.json";

const KNOWLEDGE_RULES = [
  {
    id: "local_evidence_over_claims",
    title: "Prefer direct local evidence over abstract claims",
    claim: "The user prefers conclusions grounded in directly inspected files, logs, screenshots, commands, and live state.",
    operating_rule: "For verification and debugging, inspect the real workspace and report concrete evidence before making broad claims.",
    patterns: [/직접\s*(?:보고|봐|확인|검증|열어)/i, /(?:파일|로그|스크린샷|레포|상태).*?(?:확인|검증|점검)/i, /실제.*?(?:구현|동작|상태)/i],
    min_sessions: 3,
    min_occurrences: 3,
  },
  {
    id: "plan_before_execution",
    title: "Plan before broad execution",
    claim: "The user wants broad or ambiguous work anchored to an explicit plan before implementation expands.",
    operating_rule: "For substantial work, establish scope, order, and completion criteria first, then execute inside that plan.",
    patterns: [/계획(?:서)?(?:부터|을|를|은| 세워)/i, /(?:분석|검토)부터.*?(?:진행|시작)/i, /(?:순서대로|단계별|완성조건|완료조건)/i],
    min_sessions: 2,
    min_occurrences: 2,
  },
  {
    id: "direct_execution_default",
    title: "Execute directly when the requested action is safe",
    claim: "The user prefers the agent to carry safe work through directly instead of stopping at a proposal.",
    operating_rule: "Once scope is clear, implement, verify, and report the result without asking avoidable approval questions.",
    patterns: [/니가\s*(?:해|만들|진행|수정|구현|배포)/i, /직접\s*(?:해|수정|구현|배포|푸시|푸쉬)/i, /(?:진행|시작|수정|구현|배포|푸시|푸쉬).*?(?:해줘|해주|부탁|ㄱㄱ)/i],
    min_sessions: 2,
    min_occurrences: 2,
  },
  {
    id: "end_to_end_completion",
    title: "Prove work end to end",
    claim: "The user values implementation, verification, persistence, and distribution as one completed workflow.",
    operating_rule: "Do not claim completion at scaffolding; run the relevant tests and include commit, push, or release when requested.",
    patterns: [/(?:끝까지|완성조건|완료조건)/i, /(?:검증|테스트).*?(?:배포|푸시|푸쉬)/i, /(?:배포|푸시|푸쉬)까지/i],
    min_sessions: 2,
    min_occurrences: 2,
  },
  {
    id: "critical_review_and_cross_check",
    title: "Use critical review and cross-checking",
    claim: "The user wants important designs and implementations challenged, reviewed, and independently checked.",
    operating_rule: "For high-impact decisions, look for failure modes and conflicting evidence instead of only confirming the current design.",
    patterns: [/(?:비판적|심층\s*검증|코드\s*리뷰)/i, /(?:상호\s*검증|독립\s*검토|동의.*?반복)/i, /검토.*?(?:부족|개선|문제|원인)/i],
    min_sessions: 2,
    min_occurrences: 2,
  },
  {
    id: "knowledge_compounding_from_sessions",
    title: "Compound knowledge from conversation history",
    claim: "The user wants conversation sessions converted into durable, reviewed knowledge that improves later sessions.",
    operating_rule: "Treat sessions as source material, promote repeated decisions and corrections, and preserve provenance without copying raw transcripts into public memory.",
    patterns: [/(?:지식의?\s*복리|LLM\s*WIKI|세컨드\s*브레인)/i, /(?:장기\s*기억|기억).*?(?:다음|세션|반영)/i, /(?:대화|세션).*?(?:학습|지식화|성장)/i],
    min_sessions: 1,
    min_occurrences: 1,
  },
  {
    id: "pre_response_os_context",
    title: "Load OS context before substantive response",
    claim: "The user expects DinoBrain OS context to be loaded before an agent performs substantive work.",
    operating_rule: "Require a verified pre-response task/context trace and fail closed when the OS context is unavailable.",
    patterns: [/(?:pre-?response|os_begin_task|context\s*pack|컨텍스트\s*팩)/i, /(?:훅|hook).*?(?:먼저|선행|강제|자동)/i],
    min_sessions: 1,
    min_occurrences: 1,
  },
  {
    id: "portable_setup_and_recovery",
    title: "Make setup and recovery portable",
    claim: "The user expects DinoBrain to install and recover consistently on another computer.",
    operating_rule: "Treat installer, client wiring, GitHub state, and recovery parity as one portable setup contract.",
    patterns: [/(?:다른\s*컴퓨터|새\s*PC|새로운\s*컴퓨터)/i, /(?:설치\s*파일|설치\s*마법사|복구\s*동등성|어디서든\s*세팅)/i],
    min_sessions: 1,
    min_occurrences: 1,
  },
  {
    id: "safe_action_autonomy",
    title: "Avoid approval prompts for non-critical actions",
    claim: "The user prefers non-critical actions to proceed without repeated approval prompts.",
    operating_rule: "Ask only when an action is destructive, credential-sensitive, externally consequential, or genuinely ambiguous.",
    patterns: [/(?:치명적|위험).*?아니면.*?승인/i, /승인.*?(?:받지|없이).*?(?:진행|해)/i],
    min_sessions: 1,
    min_occurrences: 1,
  },
  {
    id: "durable_provenance",
    title: "Keep durable provenance",
    claim: "The user wants memory claims separated from verified source evidence and linked through durable provenance.",
    operating_rule: "Store source and chunk identity, hashes, review state, and claim links so later agents can distinguish memory from verified evidence.",
    patterns: [/(?:근거|출처).*?(?:검증|연결|저장)/i, /(?:provenance|source\s*chunk|source\/chunk|원자료)/i],
    min_sessions: 1,
    min_occurrences: 1,
  },
];

const STOP_WORDS = new Set([
  "the", "and", "for", "that", "this", "with", "from", "have", "what", "when", "where", "which", "your", "about",
  "are", "was", "were", "will", "can", "could", "would", "should", "into", "using", "use", "user", "assistant",
  "그냥", "근데", "그리고", "그러면", "이거", "저거", "이제", "일단", "해줘", "해주", "해봐", "진행", "관련", "대한",
  "있는", "없는", "하는", "해서", "하면", "어떻게", "뭔지", "뭐야", "내가", "니가", "너가", "좀", "더", "다시", "현재",
]);

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function hashFile(filePath) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

function readZip(argsForReader, maxBuffer = 128 * 1024 * 1024) {
  const result = spawnSync(
    powershell,
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", readerScript, "-ZipPath", zipPath, ...argsForReader],
    { encoding: null, maxBuffer, windowsHide: true },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`Could not read ChatGPT export ZIP: ${Buffer.from(result.stderr ?? []).toString("utf8").trim()}`);
  }
  return Buffer.from(result.stdout ?? []);
}

function readJsonEntry(entryName) {
  const raw = readZip(["-EntryName", entryName]);
  const text = raw.toString("utf8").replace(/^\uFEFF/, "");
  return { raw, value: JSON.parse(text) };
}

function mergeCounts(target, source) {
  for (const [key, count] of Object.entries(source)) target.set(key, (target.get(key) ?? 0) + count);
}

function countMap(map) {
  return Object.fromEntries([...map.entries()].sort(([left], [right]) => left.localeCompare(right)));
}

function privateRedaction(value) {
  const base = redactSensitiveText(String(value ?? ""));
  const counts = new Map(base.hits.map((hit) => [hit.pattern, hit.count]));
  let text = base.text;
  const apply = (name, pattern, replacement) => {
    let count = 0;
    text = text.replace(pattern, (...match) => {
      count += 1;
      return typeof replacement === "function" ? replacement(...match) : replacement;
    });
    if (count > 0) counts.set(name, (counts.get(name) ?? 0) + count);
  };
  apply("email_address", /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[REDACTED_EMAIL]");
  apply("windows_user_path", /\b[A-Z]:\\Users\\[^\\\s]+/gi, "C:\\Users\\[REDACTED_USER]");
  apply("url_secret_query", /([?&](?:token|key|secret|password|signature)=)[^&#\s]+/gi, "$1[REDACTED_SECRET]");
  return { text, hits: Object.fromEntries(counts) };
}

function contentText(value, depth = 0) {
  if (depth > 8 || value === null || value === undefined) return "";
  if (typeof value === "string") {
    if (/^(?:file-service|sediment|sandbox):\/\//i.test(value)) return "";
    return value;
  }
  if (Array.isArray(value)) return value.map((part) => contentText(part, depth + 1)).filter(Boolean).join("\n");
  if (typeof value !== "object") return "";
  for (const key of ["text", "parts", "content", "caption"]) {
    if (Object.hasOwn(value, key)) {
      const text = contentText(value[key], depth + 1);
      if (text) return text;
    }
  }
  return "";
}

function collectAssetRefs(value, refs = new Set(), depth = 0) {
  if (depth > 10 || value === null || value === undefined) return refs;
  if (typeof value === "string") {
    const matches = value.match(/(?:file[-_][A-Za-z0-9_-]{8,}|(?:file-service|sediment):\/\/[^\s"']+)/g) ?? [];
    for (const match of matches) refs.add(sha256(match).slice(0, 24));
    return refs;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectAssetRefs(item, refs, depth + 1);
    return refs;
  }
  if (typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      if (["asset_pointer", "file_id", "upload_id"].includes(key) && typeof item === "string") {
        refs.add(sha256(item).slice(0, 24));
      } else {
        collectAssetRefs(item, refs, depth + 1);
      }
    }
  }
  return refs;
}

function isoFromUnix(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return null;
  return new Date(numeric * 1000).toISOString();
}

function preview(value, limit = 420) {
  const normalized = String(value ?? "").replace(/\s+/g, " ").trim();
  if (normalized.length <= limit) return normalized;
  return `${normalized.slice(0, Math.max(0, limit - 3)).trim()}...`;
}

function addKeywords(target, text) {
  for (const token of String(text).toLowerCase().match(/[\p{L}\p{N}_-]{2,32}/gu) ?? []) {
    if (STOP_WORDS.has(token) || /^\d+$/.test(token) || token.includes("redacted")) continue;
    target.set(token, (target.get(token) ?? 0) + 1);
  }
}

function topKeywords(target, limit = 14) {
  return [...target.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, limit)
    .map(([keyword]) => keyword);
}

function dataPath(relativePath) {
  const target = path.resolve(dataRoot, ...relativePath.split("/"));
  const relative = path.relative(dataRoot, target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(`Path escapes data root: ${relativePath}`);
  return target;
}

function ensureDirFor(filePath) {
  mkdirSync(path.dirname(filePath), { recursive: true });
}

function serializedJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function writeJsonIfChanged(relativePath, value) {
  const filePath = dataPath(relativePath);
  const next = serializedJson(value);
  if (existsSync(filePath) && readFileSync(filePath, "utf8") === next) return "skipped";
  const existed = existsSync(filePath);
  ensureDirFor(filePath);
  atomicWriteJsonSync(filePath, value);
  return existed ? "updated" : "imported";
}

function writeTextIfChanged(relativePath, value) {
  const filePath = dataPath(relativePath);
  const next = value.endsWith("\n") ? value : `${value}\n`;
  if (existsSync(filePath) && readFileSync(filePath, "utf8") === next) return "skipped";
  const existed = existsSync(filePath);
  ensureDirFor(filePath);
  atomicWriteTextSync(filePath, next);
  return existed ? "updated" : "imported";
}

const listedEntries = JSON.parse(readZip(["-List"]).toString("utf8"));
if (!Array.isArray(listedEntries) || listedEntries.length === 0) throw new Error("ChatGPT export ZIP is empty");
const entryByName = new Map(listedEntries.map((entry) => [entry.name, entry]));

for (const required of ["export_manifest.json", "conversation_asset_file_names.json", "user.json"]) {
  if (!entryByName.has(required)) throw new Error(`ChatGPT export is missing required entry: ${required}`);
}

const sourceZipSha256 = await hashFile(zipPath);
const { raw: manifestRaw, value: manifest } = readJsonEntry("export_manifest.json");
const conversationFiles = manifest?.logical_files?.["conversations.json"]?.files;
if (!Array.isArray(conversationFiles) || conversationFiles.length === 0) {
  throw new Error("ChatGPT export manifest does not declare conversation shards");
}
for (const shard of conversationFiles) {
  if (!/^conversations-\d+\.json$/.test(shard) || !entryByName.has(shard)) {
    throw new Error(`Invalid or missing ChatGPT conversation shard: ${shard}`);
  }
}

const ruleStats = new Map(
  KNOWLEDGE_RULES.map((rule) => [rule.id, { rule, occurrences: 0, sessions: new Set(), evidence: [] }]),
);
const globalRedactions = new Map();
const monthCounts = new Map();
const roleCounts = new Map();
const cards = [];
const sessionRows = [];
const shardRows = [];
let totalMessages = 0;
let totalMessageChars = 0;
let totalAssetRefs = 0;
let doNotRememberCount = 0;
let archivedCount = 0;
let parseErrors = 0;

function recordRuleEvidence(text, evidence) {
  for (const stats of ruleStats.values()) {
    if (!stats.rule.patterns.some((pattern) => pattern.test(text))) continue;
    stats.occurrences += 1;
    stats.sessions.add(evidence.conversation_ref);
    if (stats.evidence.length < 24) stats.evidence.push(evidence);
  }
}

function processConversation(conversation, sourceMember, ordinal, platform = "chatgpt") {
  if (!conversation || typeof conversation !== "object" || Array.isArray(conversation)) {
    parseErrors += 1;
    return;
  }
  const rawConversationId = String(conversation.conversation_id ?? conversation.id ?? `${sourceMember}:${ordinal}`);
  const conversationRef = `${platform}-${sha256(rawConversationId).slice(0, 16)}`;
  const archivePath = `10_Conversations/raw/${conversationRef}.json`;
  const sourceCardPath = `30_Sources/private/chatgpt/conversations/${conversationRef}.json`;
  const doNotRemember = conversation.is_do_not_remember === true;
  const archived = conversation.is_archived === true || conversation.archived === true;
  if (doNotRemember) doNotRememberCount += 1;
  if (archived) archivedCount += 1;

  const titleResult = privateRedaction(String(conversation.title ?? "ChatGPT conversation"));
  mergeCounts(globalRedactions, titleResult.hits);
  const messageRows = [];
  const excerpts = [];
  const keywordCounts = new Map();
  const conversationAssetRefs = new Set();
  const mapping = conversation.mapping && typeof conversation.mapping === "object" ? conversation.mapping : {};

  for (const [nodeId, node] of Object.entries(mapping)) {
    const message = node?.message;
    if (!message || typeof message !== "object") continue;
    const role = String(message.author?.role ?? "unknown").toLowerCase();
    const rawText = contentText(message.content);
    const redacted = privateRedaction(rawText);
    mergeCounts(globalRedactions, redacted.hits);
    const assetRefs = collectAssetRefs(message.content);
    for (const ref of assetRefs) conversationAssetRefs.add(ref);
    const messageIdentity = String(message.id ?? nodeId);
    const messageSha256 = sha256(`${messageIdentity}\0${role}\0${redacted.text}`);
    const at = isoFromUnix(message.create_time);
    const chars = rawText.length;
    messageRows.push({
      message_ref: sha256(messageIdentity).slice(0, 20),
      role,
      at,
      original_char_count: chars,
      redacted_sha256: messageSha256,
      asset_ref_count: assetRefs.size,
    });
    roleCounts.set(role, (roleCounts.get(role) ?? 0) + 1);
    totalMessages += 1;
    totalMessageChars += chars;
    if (role === "user" && !doNotRemember && redacted.text.trim()) {
      addKeywords(keywordCounts, redacted.text);
      if (excerpts.length < 3) {
        const item = preview(redacted.text);
        if (item) excerpts.push(item);
      }
      recordRuleEvidence(redacted.text, {
        conversation_ref: conversationRef,
        message_sha256: messageSha256,
        at,
      });
    }
  }

  const createdAt = isoFromUnix(conversation.create_time);
  const updatedAt = isoFromUnix(conversation.update_time) ?? createdAt;
  if (createdAt) {
    const month = createdAt.slice(0, 7);
    monthCounts.set(month, (monthCounts.get(month) ?? 0) + 1);
  }
  totalAssetRefs += conversationAssetRefs.size;
  const messageDigest = sha256(JSON.stringify(messageRows));
  const sourceRecordSha256 = sha256(
    JSON.stringify({
      conversation_id_hash: sha256(rawConversationId),
      title_hash: sha256(titleResult.text),
      created_at: createdAt,
      updated_at: updatedAt,
      do_not_remember: doNotRemember,
      archived,
      message_digest: messageDigest,
    }),
  );
  const summary = doNotRemember
    ? "Content withheld because the exported conversation is marked do-not-remember."
    : preview(excerpts.join(" | "), 1_200) || preview(titleResult.text, 240) || "ChatGPT conversation source card";
  const keywords = doNotRemember ? [] : topKeywords(keywordCounts);

  const archive = {
    version: "chatgpt_export_session_registry_v1",
    session_id: conversationRef,
    status: "raw_imported",
    source: `${platform}-export-zip`,
    source_zip_sha256: sourceZipSha256,
    source_member: sourceMember,
    source_record_sha256: sourceRecordSha256,
    conversation_id_sha256: sha256(rawConversationId),
    title_sha256: sha256(titleResult.text),
    sensitivity: "sensitive",
    temperature: "cold",
    sync_policy: "local_only",
    storage_policy: {
      raw_full_transcript_stored: false,
      assistant_content_stored: false,
      user_content_stored: false,
      message_hashes_stored: true,
      source_zip_is_durable_local_anchor: true,
    },
    do_not_remember: doNotRemember,
    archived,
    created_at: createdAt,
    updated_at: updatedAt,
    message_count: messageRows.length,
    message_digest_sha256: messageDigest,
    messages: messageRows,
    asset_ref_hashes: [...conversationAssetRefs].sort(),
  };
  const sourceCard = {
    version: "chatgpt_conversation_source_card_v1",
    type: "chatgpt_conversation_source_card",
    status: "source_only",
    source_status: "internal",
    review_status: "unreviewed_source",
    sync_policy: "local_only",
    sensitivity: "sensitive",
    title: doNotRemember ? "ChatGPT conversation (content withheld)" : preview(titleResult.text, 180),
    summary,
    tags: ["chatgpt-export", "conversation-source", "local-only", ...keywords],
    conversation_ref: conversationRef,
    source_archive_path: archivePath,
    provenance: {
      source_zip_sha256: sourceZipSha256,
      source_member: sourceMember,
      source_record_sha256: sourceRecordSha256,
      message_digest_sha256: messageDigest,
    },
    coverage: {
      mapping_node_count: Object.keys(mapping).length,
      message_count: messageRows.length,
      user_message_count: messageRows.filter((message) => message.role === "user").length,
      assistant_message_count: messageRows.filter((message) => message.role === "assistant").length,
      other_message_count: messageRows.filter((message) => !["user", "assistant"].includes(message.role)).length,
      total_message_chars: messageRows.reduce((sum, message) => sum + message.original_char_count, 0),
      asset_ref_count: conversationAssetRefs.size,
    },
    excerpt_policy: {
      raw_full_transcript_stored: false,
      assistant_content_stored: false,
      redacted_user_excerpt_count: doNotRemember ? 0 : excerpts.length,
      max_excerpt_count: 3,
      max_excerpt_chars_each: 420,
      max_summary_chars: 1200,
    },
    do_not_remember: doNotRemember,
    archived,
    created_at: createdAt,
    updated_at: updatedAt,
  };

  cards.push({ archivePath, sourceCardPath, archive, sourceCard });
  sessionRows.push({
    conversation_ref: conversationRef,
    platform,
    source_member: sourceMember,
    source_record_sha256: sourceRecordSha256,
    archive_path: archivePath,
    source_card_path: sourceCardPath,
    created_at: createdAt,
    updated_at: updatedAt,
    do_not_remember: doNotRemember,
    archived,
    message_count: messageRows.length,
    user_message_count: sourceCard.coverage.user_message_count,
    assistant_message_count: sourceCard.coverage.assistant_message_count,
    other_message_count: sourceCard.coverage.other_message_count,
    total_message_chars: sourceCard.coverage.total_message_chars,
    asset_ref_count: conversationAssetRefs.size,
  });
}

for (const shard of conversationFiles) {
  const { raw, value } = readJsonEntry(shard);
  if (!Array.isArray(value)) throw new Error(`Conversation shard is not an array: ${shard}`);
  const before = sessionRows.length;
  value.forEach((conversation, index) => processConversation(conversation, shard, index, "chatgpt"));
  shardRows.push({
    path: shard,
    sha256: sha256(raw),
    bytes: raw.length,
    conversation_count: sessionRows.length - before,
  });
}

let codexThreadCount = 0;
if (entryByName.has("codex.json")) {
  const { raw, value } = readJsonEntry("codex.json");
  if (!Array.isArray(value)) throw new Error("codex.json is not an array");
  codexThreadCount = value.length;
  for (let index = 0; index < value.length; index += 1) {
    const thread = value[index] ?? {};
    const mapping = {};
    let nodeIndex = 0;
    for (const turn of Array.isArray(thread.turns) ? thread.turns : []) {
      for (const item of Array.isArray(turn?.input_items) ? turn.input_items : []) {
        const text = contentText(item?.content);
        if (!text) continue;
        const nodeId = `codex-turn-${nodeIndex++}`;
        mapping[nodeId] = {
          message: {
            id: String(item?.id ?? nodeId),
            author: { role: String(turn?.role ?? item?.role ?? "unknown") },
            content: { parts: [text] },
          },
        };
      }
    }
    processConversation(
      {
        conversation_id: `codex:${String(thread.id ?? index)}`,
        title: thread.title ?? "Codex export conversation",
        archived: thread.archived === true,
        mapping,
      },
      "codex.json",
      index,
      "codex-export",
    );
  }
  shardRows.push({ path: "codex.json", sha256: sha256(raw), bytes: raw.length, conversation_count: codexThreadCount });
}

const { raw: assetMapRaw, value: assetNameMap } = readJsonEntry("conversation_asset_file_names.json");
const assetExtensionCounts = new Map();
for (const value of Object.values(assetNameMap && typeof assetNameMap === "object" ? assetNameMap : {})) {
  const name = typeof value === "string" ? value : String(value?.name ?? value?.file_name ?? "");
  const extension = path.extname(name).toLowerCase() || "[none]";
  assetExtensionCounts.set(extension, (assetExtensionCounts.get(extension) ?? 0) + 1);
}

let libraryFileCount = 0;
const libraryMimeCounts = new Map();
if (entryByName.has("library_files.json")) {
  const { value } = readJsonEntry("library_files.json");
  if (Array.isArray(value)) {
    libraryFileCount = value.length;
    for (const item of value) {
      const mime = String(item?.mime_type ?? "unknown").toLowerCase();
      libraryMimeCounts.set(mime, (libraryMimeCounts.get(mime) ?? 0) + 1);
    }
  }
}

let sharedConversationCount = 0;
if (entryByName.has("shared_conversations.json")) {
  const { value } = readJsonEntry("shared_conversations.json");
  sharedConversationCount = Array.isArray(value) ? value.length : 0;
}

const userEntry = entryByName.get("user.json");
const userEntryRaw = readZip(["-EntryName", "user.json"]);
const settingsEntryRaw = entryByName.has("user_settings.json") ? readZip(["-EntryName", "user_settings.json"]) : Buffer.alloc(0);
const datEntries = listedEntries.filter((entry) => entry.name.toLowerCase().endsWith(".dat"));
const entryLedger = listedEntries.map((entry) => ({
  entry_name_sha256: sha256(entry.name),
  entry_class: entry.name.match(/^conversations-\d+\.json$/)
    ? "conversation_shard"
    : entry.name.toLowerCase().endsWith(".dat")
      ? "attachment_binary"
      : entry.name.endsWith(".json")
        ? "metadata_json"
        : entry.name.endsWith(".html")
          ? "redundant_html_view"
          : "other",
  length: entry.length,
  compressed_length: entry.compressed_length,
}));

const promotedRules = [...ruleStats.values()]
  .map((stats) => ({
    id: stats.rule.id,
    title: stats.rule.title,
    claim: stats.rule.claim,
    operating_rule: stats.rule.operating_rule,
    occurrence_count: stats.occurrences,
    session_count: stats.sessions.size,
    threshold: { min_sessions: stats.rule.min_sessions, min_occurrences: stats.rule.min_occurrences },
    status:
      stats.sessions.size >= stats.rule.min_sessions && stats.occurrences >= stats.rule.min_occurrences
        ? "reviewed_pattern_supported"
        : "insufficient_pattern_support",
    evidence: stats.evidence,
  }))
  .sort((left, right) => right.session_count - left.session_count || right.occurrence_count - left.occurrence_count || left.id.localeCompare(right.id));
const supportedRules = promotedRules.filter((rule) => rule.status === "reviewed_pattern_supported");
const sortedSessions = sessionRows.sort(
  (left, right) => String(left.created_at ?? "").localeCompare(String(right.created_at ?? "")) || left.conversation_ref.localeCompare(right.conversation_ref),
);
const dateValues = sortedSessions.flatMap((session) => [session.created_at, session.updated_at]).filter(Boolean).sort();
const conversationCount = sortedSessions.filter((session) => session.platform === "chatgpt").length;
const sourceCardCount = sortedSessions.length;

const registryReport = {
  ok: parseErrors === 0,
  version: "chatgpt_export_registry_v1",
  generated_at: importedAt,
  mode: write ? "write" : "dry_run",
  source_zip: {
    sha256: sourceZipSha256,
    bytes: listedEntries.reduce((sum, entry) => sum + Number(entry.compressed_length ?? 0), 0),
    entry_count: listedEntries.length,
    manifest_sha256: sha256(manifestRaw),
  },
  coverage: {
    conversation_shard_count: conversationFiles.length,
    chatgpt_conversation_count: conversationCount,
    codex_thread_count: codexThreadCount,
    source_card_count: sourceCardCount,
    message_count: totalMessages,
    role_counts: countMap(roleCounts),
    total_message_chars: totalMessageChars,
    conversation_asset_ref_count: totalAssetRefs,
    attachment_entry_count: datEntries.length,
    attachment_entry_bytes: datEntries.reduce((sum, entry) => sum + Number(entry.length ?? 0), 0),
    mapped_asset_name_count: Object.keys(assetNameMap && typeof assetNameMap === "object" ? assetNameMap : {}).length,
    library_file_count: libraryFileCount,
    shared_conversation_count: sharedConversationCount,
    archived_conversation_count: archivedCount,
    do_not_remember_count: doNotRememberCount,
    parse_errors: parseErrors,
    earliest_at: dateValues[0] ?? null,
    latest_at: dateValues.at(-1) ?? null,
  },
  privacy: {
    sensitivity: "sensitive",
    raw_full_transcript_stored: false,
    public_message_content_stored: false,
    assistant_content_stored: false,
    local_private_source_cards: true,
    local_private_source_card_excerpt_policy: "up_to_three_redacted_user_excerpts_per_conversation",
    excluded_sensitive_entries: [
      { entry: "user.json", reason: "contains direct account identifiers", sha256: sha256(userEntryRaw), bytes: userEntry?.length ?? userEntryRaw.length },
      ...(settingsEntryRaw.length > 0
        ? [{ entry: "user_settings.json", reason: "settings values are not promoted as memory", sha256: sha256(settingsEntryRaw), bytes: settingsEntryRaw.length }]
        : []),
    ],
    redaction_counts: countMap(globalRedactions),
  },
  paths: {
    registry_path: REGISTRY_PATH,
    knowledge_profile_path: PROFILE_PATH,
    registry_report_path: REGISTRY_REPORT_PATH,
    promotion_report_path: PROMOTION_REPORT_PATH,
    local_archive_root: "10_Conversations/raw/",
    local_source_card_root: "30_Sources/private/chatgpt/conversations/",
  },
  shard_ledger: shardRows,
  archive_entry_ledger: entryLedger,
  attachment_metadata: {
    asset_map_sha256: sha256(assetMapRaw),
    extension_counts: countMap(assetExtensionCounts),
    library_mime_counts: countMap(libraryMimeCounts),
  },
  month_counts: countMap(monthCounts),
  sessions: sortedSessions,
};

const promotionReport = {
  ok: true,
  version: "chatgpt_session_knowledge_promotion_v1",
  generated_at: importedAt,
  source_registry_path: REGISTRY_PATH,
  source_report_path: REGISTRY_REPORT_PATH,
  source_zip_sha256: sourceZipSha256,
  review_method: "deterministic_user_message_patterns_plus_current_agent_review",
  raw_message_content_stored: false,
  supported_rule_count: supportedRules.length,
  rules: promotedRules,
};

function markdownCountTable(entries, leftLabel, rightLabel) {
  const rows = Object.entries(entries);
  if (rows.length === 0) return "No entries.";
  return [`| ${leftLabel} | ${rightLabel} |`, "| --- | ---: |", ...rows.map(([key, count]) => `| ${key} | ${count} |`)].join("\n");
}

const registryMarkdown = [
  "---",
  "title: ChatGPT Conversation Registry",
  "summary: Complete privacy-preserving registration of the supplied ChatGPT export, with local source cards and message-level hash coverage.",
  "tags: [chatgpt, sessions, conversation-registry, llm-wiki, provenance]",
  "---",
  "",
  "# ChatGPT Conversation Registry",
  "",
  `Last verified: ${importedAt}`,
  `Source ZIP SHA-256: \`${sourceZipSha256}\``,
  `ChatGPT conversations: ${conversationCount}`,
  `Codex export threads: ${codexThreadCount}`,
  `Messages registered: ${totalMessages}`,
  `Attachment files anchored by the ZIP: ${datEntries.length}`,
  `Parse errors: ${parseErrors}`,
  "",
  "## Coverage Contract",
  "",
  "Every exported conversation message is represented by role, timestamp when available, character count, and a redacted-content SHA-256 in a local-only session archive. Each conversation also has a local-only searchable source card with at most three redacted user excerpts. The source ZIP hash anchors the exact original export, including attachments.",
  "",
  "## Privacy Boundary",
  "",
  "Raw full transcripts, assistant response text, account identifiers, and attachment binaries are not copied into the Wiki or public Git data. `user.json` is hash-registered but excluded from content extraction. Local source cards under `30_Sources/private/` and session archives under `10_Conversations/raw/` must remain ignored by Git.",
  "",
  "## Conversation Months",
  "",
  markdownCountTable(countMap(monthCounts), "Month", "Conversations"),
  "",
  "## Durable Evidence",
  "",
  `- Registry report: \`${REGISTRY_REPORT_PATH}\``,
  `- Knowledge profile: \`${PROFILE_PATH}\``,
  `- Promotion evidence: \`${PROMOTION_REPORT_PATH}\``,
  "- Local source cards: `30_Sources/private/chatgpt/conversations/`",
  "- Local metadata archives: `10_Conversations/raw/`",
  "",
].join("\n");

const profileMarkdown = [
  "---",
  "title: ChatGPT Session Knowledge Profile",
  "summary: Reviewed aggregate operating preferences distilled from the user's full ChatGPT export without storing raw transcripts.",
  "tags: [chatgpt, user-preferences, operating-rules, llm-wiki, reviewed-memory]",
  "---",
  "",
  "# ChatGPT Session Knowledge Profile",
  "",
  `Last verified: ${importedAt}`,
  `Conversations reviewed by pattern coverage: ${conversationCount}`,
  `User messages available as evidence: ${roleCounts.get("user") ?? 0}`,
  `Supported operating rules: ${supportedRules.length}`,
  "",
  "## Authority",
  "",
  "These are aggregate, paraphrased operating preferences supported by repeated user-message patterns. They are subordinate to the user's current instruction. Exact evidence is stored only as conversation references and message hashes in the promotion report.",
  "",
  "## Reviewed Rules",
  "",
  ...(supportedRules.length > 0
    ? supportedRules.flatMap((rule) => [
        `### ${rule.title}`,
        "",
        rule.claim,
        "",
        `Operating rule: ${rule.operating_rule}`,
        "",
        `Evidence: ${rule.occurrence_count} matching messages across ${rule.session_count} conversations.`,
        "",
      ])
    : ["No rule met the configured evidence threshold.", ""]),
  "## Provenance",
  "",
  `- Conversation registry: \`${REGISTRY_PATH}\``,
  `- Promotion evidence: \`${PROMOTION_REPORT_PATH}\``,
  `- Source ZIP SHA-256: \`${sourceZipSha256}\``,
  "",
].join("\n");

const writeCounts = { imported: 0, updated: 0, skipped: 0 };
function noteWrite(result) {
  writeCounts[result] += 1;
}

if (write) {
  for (const card of cards) {
    noteWrite(writeJsonIfChanged(card.archivePath, card.archive));
    noteWrite(writeJsonIfChanged(card.sourceCardPath, card.sourceCard));
  }
  noteWrite(writeTextIfChanged(REGISTRY_PATH, registryMarkdown));
  noteWrite(writeTextIfChanged(PROFILE_PATH, profileMarkdown));
  noteWrite(writeJsonIfChanged(REGISTRY_REPORT_PATH, registryReport));
  noteWrite(writeJsonIfChanged(PROMOTION_REPORT_PATH, promotionReport));
  const eventPath = dataPath(`.dino/events/${importedAt.slice(0, 10)}.jsonl`);
  ensureDirFor(eventPath);
  appendFileWithLockSync(
    eventPath,
    `${JSON.stringify({
      event: "chatgpt_export_imported",
      at: importedAt,
      source_zip_sha256: sourceZipSha256,
      conversation_count: conversationCount,
      codex_thread_count: codexThreadCount,
      message_count: totalMessages,
      source_card_count: sourceCardCount,
      supported_rule_count: supportedRules.length,
      raw_full_transcript_stored: false,
      public_message_content_stored: false,
      write_counts: writeCounts,
    })}\n`,
  );
}

console.log(
  JSON.stringify(
    {
      ok: registryReport.ok,
      mode: write ? "write" : "dry_run",
      source_zip_sha256: sourceZipSha256,
      conversation_count: conversationCount,
      codex_thread_count: codexThreadCount,
      message_count: totalMessages,
      source_card_count: sourceCardCount,
      attachment_entry_count: datEntries.length,
      parse_errors: parseErrors,
      supported_rule_count: supportedRules.length,
      supported_rules: supportedRules.map((rule) => ({ id: rule.id, sessions: rule.session_count, occurrences: rule.occurrence_count })),
      paths: registryReport.paths,
      privacy: {
        raw_full_transcript_stored: false,
        public_message_content_stored: false,
        local_private_source_cards: true,
      },
      write_counts: writeCounts,
    },
    null,
    2,
  ),
);
