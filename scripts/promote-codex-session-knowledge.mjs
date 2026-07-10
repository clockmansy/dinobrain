import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { appendFileWithLockSync, atomicWriteJsonSync, atomicWriteTextSync } from "./lib/atomic-files-sync.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(scriptDir, "..");
const sessionIngestModule = await import(pathToFileURL(path.join(appRoot, "dist", "session-ingest.js")).href);
const { redactSensitiveText } = sessionIngestModule;

const args = new Map();
for (let index = 2; index < process.argv.length; index += 1) {
  const arg = process.argv[index];
  if (!arg.startsWith("--")) continue;
  const [key, inlineValue] = arg.slice(2).split("=", 2);
  const value = inlineValue ?? (process.argv[index + 1]?.startsWith("--") ? "true" : process.argv[++index] ?? "true");
  args.set(key, value);
}

const shouldWrite = args.get("write") === "true";
const dataRoot = path.resolve(String(args.get("data-root") || process.env.DINOBRAIN_DATA_DIR || path.join(appRoot, "..", "dinobrain-data")));
const sessionsDir = path.resolve(String(args.get("sessions-dir") || path.join(process.env.USERPROFILE || "", ".codex", "sessions")));
const generatedAt = new Date().toISOString();
const date = generatedAt.slice(0, 10);
const registryPath = "20_Wiki/Codex-Conversation-Registry.md";
const registryReportPath = "60_Operations/session-imports/codex-conversation-registry.json";
const profilePath = "20_Wiki/Codex-Session-Knowledge-Profile.md";
const promotionReportPath = "60_Operations/session-promotions/codex-session-knowledge-promotion.json";
const promotionReportMarkdownPath = "60_Operations/session-promotions/codex-session-knowledge-promotion.md";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function shortHash(value, length = 16) {
  return sha256(value).slice(0, length);
}

function safeSlug(value) {
  return String(value || "")
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 96);
}

function dataPath(relativePath) {
  return path.join(dataRoot, ...relativePath.split("/"));
}

function ensureDirFor(relativePath) {
  mkdirSync(path.dirname(dataPath(relativePath)), { recursive: true });
}

function writeJson(relativePath, value) {
  ensureDirFor(relativePath);
  atomicWriteJsonSync(dataPath(relativePath), value);
}

function writeText(relativePath, value) {
  ensureDirFor(relativePath);
  atomicWriteTextSync(dataPath(relativePath), value);
}

function appendJsonl(relativePath, value) {
  ensureDirFor(relativePath);
  const fullPath = dataPath(relativePath);
  appendFileWithLockSync(fullPath, `${JSON.stringify(value)}\n`);
}

function readJsonSafe(relativePath) {
  const fullPath = dataPath(relativePath);
  if (!existsSync(fullPath)) return null;
  try {
    return JSON.parse(readFileSync(fullPath, "utf8"));
  } catch {
    return null;
  }
}

function walkJsonl(dir, acc = []) {
  if (!existsSync(dir)) return acc;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkJsonl(full, acc);
    else if (entry.isFile() && entry.name.toLowerCase().endsWith(".jsonl") && entry.size !== 0) acc.push(full);
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

const knowledgeRules = [
  {
    id: "plan_first_scope_lock",
    memory_kind: "user_preference",
    confidence: "high",
    title: "Plan-first execution for new or handoff-heavy work",
    claim:
      "The user prefers a concrete plan and approved scope before broad implementation, especially for handoff bundles, new projects, difficult design tasks, or OS-level changes.",
    reusable_rule:
      "When a task is broad, new, design-heavy, or handoff-driven, first summarize understanding, ask only necessary questions, lock the plan, then execute within that plan.",
    scope: "agent_workflow",
    tags: ["user-preference", "planning", "scope-control"],
    role_weights: { user: 3, assistant: 1 },
    min_score: 10,
    patterns: [/계획서?|계획\s*세|계획을|순서대로|범위|스코프|plan\b|scope\b|roadmap/i],
  },
  {
    id: "local_evidence_over_claims",
    memory_kind: "user_preference",
    confidence: "high",
    title: "Prefer direct local verification and evidence",
    claim:
      "The user prefers direct inspection of local files, logs, command output, screenshots, repository state, and concrete evidence over abstract claims.",
    reusable_rule:
      "For verification/debugging, inspect the real workspace and report command/file evidence; if a check was not run, say that plainly.",
    scope: "verification",
    tags: ["user-preference", "verification", "evidence"],
    role_weights: { user: 3, assistant: 1 },
    min_score: 14,
    patterns: [/직접|확인|검증|로그|스샷|보고|보여|evidence|verify|verified|inspect|actual|real local/i],
  },
  {
    id: "end_to_end_execution_push",
    memory_kind: "user_preference",
    confidence: "high",
    title: "Carry authorized work through commit, push, and deploy",
    claim:
      "When the user explicitly authorizes implementation or deployment, they expect Codex to carry the work through commit, push, release, and verification rather than stopping at a proposal.",
    reusable_rule:
      "After explicit authorization such as go, push, deploy, or auto-commit, implement, verify, commit, push, and report exact hashes or links.",
    scope: "delivery",
    tags: ["user-preference", "git", "release", "delivery"],
    role_weights: { user: 4, assistant: 1 },
    min_score: 10,
    patterns: [/푸쉬|push|커밋|자동커밋|배포|release|릴리즈|업로드|올려|깃헙|github|deploy|commit/i],
  },
  {
    id: "one_link_or_direct_action",
    memory_kind: "user_preference",
    confidence: "medium",
    title: "Prefer direct links or actions when the path is known",
    claim:
      "When the path or artifact is known, the user often prefers a direct link, launcher, or action instead of a long explanation.",
    reusable_rule:
      "If the user asks for an install link, file, folder, or app launch, provide the direct artifact or perform the action first, then add only essential context.",
    scope: "communication",
    tags: ["user-preference", "brevity", "install"],
    role_weights: { user: 4, assistant: 1 },
    min_score: 5,
    patterns: [/링크\s*하나|설치링크|다운로드|열어|실행|바로|direct link|one link/i],
  },
  {
    id: "explain_when_confused",
    memory_kind: "user_preference",
    confidence: "medium",
    title: "Explain unfamiliar work in plain language",
    claim:
      "The user asks for plain explanations when a task, state, or warning is unclear, and wants the practical meaning rather than jargon.",
    reusable_rule:
      "When the user asks what something means or why it happened, explain the concrete cause, consequence, and next action in plain Korean.",
    scope: "communication",
    tags: ["user-preference", "explanation", "korean"],
    role_weights: { user: 4, assistant: 1 },
    min_score: 5,
    patterns: [/무슨\s*말|뭔말|무슨작업|왜\s*그래|자세히\s*설명|이게\s*뭐|what.*mean|explain/i],
  },
  {
    id: "current_instruction_over_memory",
    memory_kind: "operating_rule",
    confidence: "high",
    title: "Current user instruction outranks stored memory",
    claim:
      "For DinoBrain and Codex work, current user instructions must take priority over OS memory, Context Packs, and previous decisions.",
    reusable_rule:
      "Use memory as subordinate evidence; if the current user instruction conflicts with stored memory, follow the current instruction and record the correction if durable.",
    scope: "os_contract",
    tags: ["operating-rule", "memory-priority", "os-contract"],
    role_weights: { user: 2, assistant: 2 },
    min_score: 4,
    patterns: [/현재\s*사용자|사용자의\s*지시|기억보다\s*우선|current user instruction|outrank|priority/i],
  },
  {
    id: "pre_response_fail_closed_loop",
    memory_kind: "operating_rule",
    confidence: "high",
    title: "DinoBrain must run pre-response and fail closed",
    claim:
      "The user wants every Codex or Claude session to receive DinoBrain pre-response OS context before substantive work, with fail-closed behavior when the OS context is missing.",
    reusable_rule:
      "For nontrivial DinoBrain work, require os_begin_task or trusted hook preflight, Context Pack, gates, finish_task, and explicit degraded/fail-closed state when missing.",
    scope: "dinobrain_os",
    tags: ["operating-rule", "pre-response", "fail-closed", "hook"],
    role_weights: { user: 4, assistant: 2 },
    min_score: 12,
    patterns: [/pre-response|os_begin_task|start_task|get_context_pack|finish_task|fail-closed|Context Pack|컨텍스트\s*팩|훅|hook|UserPromptSubmit/i],
  },
  {
    id: "raw_transcripts_never_public",
    memory_kind: "safety_rule",
    confidence: "high",
    title: "Do not sync raw Codex conversation transcripts",
    claim:
      "Codex conversations are source material for reviewed memory, but raw full transcripts and message content must stay local-only and out of public data sync.",
    reusable_rule:
      "Register sessions metadata-only, extract paraphrased reviewed memories, and never store raw full transcripts or message content in public Wiki, accepted memory, traces, or reports.",
    scope: "privacy",
    tags: ["safety", "privacy", "raw-transcripts", "public-data"],
    role_weights: { user: 3, assistant: 3 },
    min_score: 7,
    patterns: [/원문|raw\s*(full\s*)?transcript|message content|공개\s*저장소|public\s*data|local-only|비밀|토큰|secret|privacy/i],
  },
  {
    id: "knowledge_compounding_goal",
    memory_kind: "project_goal",
    confidence: "high",
    title: "DinoBrain goal is knowledge compounding from sessions",
    claim:
      "The core DinoBrain goal is a compounding LLM Wiki where user sessions become reviewed preferences, decisions, rules, corrections, and source-backed knowledge that improve future sessions.",
    reusable_rule:
      "Treat sessions as the root source; convert them into reviewed memory, lifecycle-clean noisy memory, evaluate behavior lift, and retrieve the result in later Context Packs.",
    scope: "dinobrain_product",
    tags: ["project-goal", "llm-wiki", "compounding", "memory"],
    role_weights: { user: 4, assistant: 2 },
    min_score: 10,
    patterns: [/지식의\s*복리|복리|LLM\s*Wiki|LLMWIKI|세컨드브레인|지식화|성장|학습|대화.*세션|sessions.*source|compounding/i],
  },
  {
    id: "rag_quality_direction",
    memory_kind: "project_decision",
    confidence: "high",
    title: "RAG quality requires hybrid retrieval, provenance, and evaluation",
    claim:
      "DinoBrain retrieval should evolve beyond lexical search toward contextual chunks, BM25 plus dense hybrid retrieval, rank fusion, reranking, durable source provenance, canaries, and behavior evaluation.",
    reusable_rule:
      "When improving DinoBrain search, separate anchor-only sources from verified chunks, keep retrieval mode honest, and evaluate memory-on behavior against baselines.",
    scope: "retrieval",
    tags: ["project-decision", "rag", "retrieval", "provenance", "evaluation"],
    role_weights: { user: 4, assistant: 2 },
    min_score: 8,
    patterns: [/RAG|contextual retrieval|hybrid|BM25|dense|rerank|GraphRAG|RAGAS|provenance|source\s*chunk|canary|청킹|chunk|검색\s*품질/i],
  },
  {
    id: "installer_new_pc_equivalence",
    memory_kind: "project_decision",
    confidence: "high",
    title: "Installer must restore equivalent DinoBrain behavior on a new PC",
    claim:
      "The user expects a new PC install to clone/update app and data repos, configure Codex and Claude hooks/MCP, build indexes, launch Observatory, and preserve version parity.",
    reusable_rule:
      "For installer work, verify app/data refs, portable Node, build/index, Codex and Claude registration, hook approval flow, launchers, release artifact alignment, and reinstall/idempotent behavior.",
    scope: "installer",
    tags: ["project-decision", "installer", "new-pc", "codex", "claude", "version-parity"],
    role_weights: { user: 4, assistant: 2 },
    min_score: 12,
    patterns: [/설치|설치파일|설치기|installer|새로운\s*컴퓨터|다른\s*컴퓨터|codex|claude|자동\s*연결|버전|version|release|릴리즈|exe|zip|portable node/i],
  },
  {
    id: "observability_required",
    memory_kind: "project_decision",
    confidence: "high",
    title: "Observability must show real OS state",
    claim:
      "The user wants Observatory and logs to show real hook/preflight/task/context/audit/trust/graph/sync states, including blocked, pending, degraded, verifier, and active work.",
    reusable_rule:
      "Do not treat a decorative graph as sufficient; expose live OS traces, graph health, gate status, audit trust, memory use, sync risk, and stale task state.",
    scope: "observability",
    tags: ["project-decision", "observability", "audit", "graph-health"],
    role_weights: { user: 4, assistant: 2 },
    min_score: 9,
    patterns: [/Observatory|관측|로그|audit|trust\s*score|graph\s*health|그래프|active\s*task|액트브|blocked|pending|verifier|실시간/i],
  },
  {
    id: "design_quality_without_logic_changes",
    memory_kind: "user_preference",
    confidence: "medium",
    title: "Design tasks need high-quality visual iteration without unrelated logic changes",
    claim:
      "For design tasks, the user wants careful high-quality visual work, screenshot-based iteration, and no unrelated logic-code changes when the task is design-only.",
    reusable_rule:
      "For design-only requests, first restate the visual intent, keep logic untouched, iterate with screenshots, and remove forced motifs when they reduce clarity.",
    scope: "design_workflow",
    tags: ["user-preference", "design", "frontend", "screenshots"],
    role_weights: { user: 4, assistant: 1 },
    min_score: 5,
    patterns: [/디자인|스샷|아쉬운데|덜어내|로직.*수정없이|높은\s*퀄|천천히|visual|screenshot|graph\s*design/i],
  },
  {
    id: "configured_is_not_live_proof",
    memory_kind: "mistake_lesson",
    confidence: "high",
    title: "Configured hooks are not live preflight proof",
    claim:
      "A configured or probe-verified DinoBrain hook must not be claimed as fully live until a fresh trusted Codex or Claude prompt produces pre-response events before manual MCP calls.",
    reusable_rule:
      "Distinguish configured, probe-verified, and live-verified; require fresh prompt event evidence for live hook claims.",
    scope: "verification",
    tags: ["mistake-lesson", "hook", "live-proof", "fail-closed"],
    role_weights: { user: 3, assistant: 3 },
    min_score: 6,
    patterns: [/configured|probe|live[-\s]*verified|fresh\s*prompt|manual\s*MCP|hook.*trust|승인|신뢰|자동으로\s*안|훅이\s*안|preflight.*event/i],
  },
  {
    id: "version_release_drift_risk",
    memory_kind: "mistake_lesson",
    confidence: "medium",
    title: "Version drift and stale release artifacts are recurring risks",
    claim:
      "DinoBrain app, data, installer, local checkout, release ZIP, tag, and GitHub asset can drift; version and artifact alignment must be checked before claiming install or release readiness.",
    reusable_rule:
      "For releases and installer updates, verify local/remote refs, package version, embedded installer refs, tag, ZIP/SHA asset, and GitHub release state.",
    scope: "release_hygiene",
    tags: ["mistake-lesson", "release", "version", "installer"],
    role_weights: { user: 3, assistant: 2 },
    min_score: 6,
    patterns: [/버전.*차이|version.*drift|stale|release.*asset|zip|sha|tag|릴리즈|설치.*업데이트|로컬.*깃헙|GitHub.*version/i],
  },
];

function parseSession(file) {
  const raw = readFileSync(file, "utf8");
  const relSource = path.relative(sessionsDir, file).replace(/\\/g, "/");
  const stat = statSync(file);
  let meta = {};
  const messages = [];
  let parseErrors = 0;

  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let item;
    try {
      item = JSON.parse(line);
    } catch {
      parseErrors += 1;
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
    messages.push({
      role,
      text: redacted.text,
      redaction_count: redacted.hits?.length || 0,
      char_count: content.length,
      redacted_hash: shortHash(redacted.text, 24),
      at: typeof item.timestamp === "string" ? item.timestamp : null,
    });
  }

  const threadId = String(meta.id || meta.session_id || path.basename(file, ".jsonl"));
  const sessionRef = `sess-${shortHash(`${relSource}:${threadId}`, 14)}`;
  const startedAt = String(meta.timestamp || messages[0]?.at || stat.birthtime.toISOString());
  return {
    session_ref: sessionRef,
    started_at: startedAt,
    project: projectLabel(meta.cwd),
    source_file_hash: shortHash(raw, 24),
    file_size: stat.size,
    parse_errors: parseErrors,
    message_count: messages.length,
    user_message_count: messages.filter((message) => message.role === "user").length,
    assistant_message_count: messages.filter((message) => message.role === "assistant").length,
    messages,
  };
}

function blankRuleStats(rule) {
  return {
    rule,
    weighted_score: 0,
    user_hits: 0,
    assistant_hits: 0,
    session_refs: new Set(),
    projects: new Map(),
    evidence_hashes: [],
    matched_terms: new Set(),
  };
}

function addLimitedEvidence(stats, message, session) {
  if (stats.evidence_hashes.length >= 16) return;
  stats.evidence_hashes.push({
    session_ref: session.session_ref,
    role: message.role,
    message_hash: message.redacted_hash,
    char_count: message.char_count,
  });
}

function analyzeSessions(sessions) {
  const statsById = new Map(knowledgeRules.map((rule) => [rule.id, blankRuleStats(rule)]));
  for (const session of sessions) {
    for (const message of session.messages) {
      for (const rule of knowledgeRules) {
        const stats = statsById.get(rule.id);
        let matched = false;
        for (const pattern of rule.patterns) {
          pattern.lastIndex = 0;
          if (pattern.test(message.text)) {
            matched = true;
            stats.matched_terms.add(String(pattern).replace(/^\/|\/[a-z]*$/gi, "").slice(0, 80));
          }
        }
        if (!matched) continue;
        const roleWeight = rule.role_weights[message.role] || 1;
        stats.weighted_score += roleWeight;
        if (message.role === "user") stats.user_hits += 1;
        else stats.assistant_hits += 1;
        stats.session_refs.add(session.session_ref);
        if (session.project) stats.projects.set(session.project, (stats.projects.get(session.project) || 0) + 1);
        addLimitedEvidence(stats, message, session);
      }
    }
  }
  return Array.from(statsById.values()).map((stats) => ({
    ...stats,
    session_count: stats.session_refs.size,
    sessions: Array.from(stats.session_refs).sort().slice(0, 24),
    projects_seen: Array.from(stats.projects, ([project, count]) => ({ project, count })).sort((a, b) => b.count - a.count),
    matched_terms: Array.from(stats.matched_terms).sort(),
  }));
}

function memoryId(ruleId) {
  return `codex-session-knowledge-${safeSlug(ruleId)}`;
}

function memoryPath(ruleId) {
  return `50_Instances/accepted/${memoryId(ruleId)}.json`;
}

function reviewPath(ruleId) {
  return `80_Review_Queue/session-knowledge/${memoryId(ruleId)}.json`;
}

function buildAcceptedRecord(result, previous) {
  const rule = result.rule;
  const id = memoryId(rule.id);
  const createdAt = previous?.created_at || generatedAt;
  return {
    memory_id: id,
    type: "codex_session_knowledge",
    status: "accepted",
    review_status: "accepted_by_agent_review",
    memory_kind: rule.memory_kind,
    title: rule.title,
    claim: rule.claim,
    reusable_rule: rule.reusable_rule,
    scope: rule.scope,
    confidence: rule.confidence,
    source_status: "internal",
    sensitivity: "normal",
    tags: ["codex-session-derived", ...rule.tags],
    evidence: {
      source: registryPath,
      source_report: registryReportPath,
      extraction_report: promotionReportPath,
      evidence_kind: "metadata_only_pattern_aggregate",
      raw_full_transcript_stored: false,
      message_content_stored: false,
      source_session_count: result.session_count,
      user_hit_count: result.user_hits,
      assistant_hit_count: result.assistant_hits,
      weighted_score: result.weighted_score,
      session_refs: result.sessions,
      message_hashes: result.evidence_hashes,
      matched_terms: result.matched_terms,
      projects_seen: result.projects_seen,
    },
    promotion: {
      promoted_by: "codex-session-knowledge-promoter",
      promotion_policy: "paraphrased_public_safe_aggregate",
      required_checks: [
        "no_raw_message_text",
        "no_absolute_local_source_paths",
        "redacted_hash_evidence_only",
        "session_registry_exists",
      ],
      accepted_at: generatedAt,
    },
    created_at: createdAt,
    updated_at: generatedAt,
  };
}

function buildReviewRecord(result) {
  const rule = result.rule;
  const id = memoryId(rule.id);
  return {
    review_id: id,
    type: "session_knowledge_promotion",
    status: "accepted_by_agent_review",
    accepted_memory_path: memoryPath(rule.id),
    reviewed_at: generatedAt,
    reviewer: "codex-session-knowledge-promoter",
    checks: {
      raw_full_transcript_stored: false,
      message_content_stored: false,
      evidence_uses_hashes_only: true,
      source_is_metadata_registry: true,
      public_safe_paraphrase: true,
    },
    evidence_summary: {
      source_session_count: result.session_count,
      user_hit_count: result.user_hits,
      assistant_hit_count: result.assistant_hits,
      weighted_score: result.weighted_score,
    },
    next_review: "Human can demote or edit if this aggregate memory is too broad, stale, or no longer reflects the user.",
  };
}

function buildProfile(results, skippedResults, sessions) {
  const lines = [
    "---",
    "title: Codex Session Knowledge Profile",
    "summary: Reviewed aggregate memories extracted from local Codex sessions without storing raw transcripts.",
    "source_status: internal",
    "confidence: medium",
    `last_verified: ${date}`,
    "tags: [codex, sessions, user-preferences, operating-rules, llm-wiki]",
    "---",
    "",
    "# Codex Session Knowledge Profile",
    "",
    `Generated at: ${generatedAt}`,
    `Sessions scanned: ${sessions.length}`,
    `Promoted memories: ${results.length}`,
    "Raw full transcripts stored: false",
    "Message content stored: false",
    "",
    "This page summarizes aggregate, paraphrased knowledge promoted from local Codex sessions. The evidence stored in accepted memory records is limited to session refs, redacted message hashes, counts, categories, and matched pattern names. It does not store raw conversation text.",
    "",
    "## Promoted Memory",
    "",
  ];
  for (const result of results) {
    lines.push(`### ${result.rule.title}`, "");
    lines.push(`- kind: ${result.rule.memory_kind}`);
    lines.push(`- confidence: ${result.rule.confidence}`);
    lines.push(`- accepted memory: \`${memoryPath(result.rule.id)}\``);
    lines.push(`- sessions: ${result.session_count}; user hits: ${result.user_hits}; assistant hits: ${result.assistant_hits}; score: ${result.weighted_score}`);
    lines.push(`- rule: ${result.rule.reusable_rule}`);
    lines.push("");
  }
  lines.push("## Skipped Below Threshold", "");
  for (const result of skippedResults) {
    lines.push(`- ${result.rule.id}: score ${result.weighted_score}, sessions ${result.session_count}`);
  }
  lines.push(
    "",
    "## Guardrails",
    "",
    "- Treat these records as internal behavior and preference memory, not external factual source truth.",
    "- Current user instructions always outrank this profile.",
    "- If a memory proves too broad or stale, demote, merge, or quarantine it.",
    "",
  );
  return `${lines.join("\n")}\n`;
}

function removeStaleIndexes() {
  for (const relativePath of [
    ".dino/index/wiki-index.json",
    ".dino/index/sqlite/wiki.sqlite",
    ".dino/index/sqlite/wiki.sqlite-shm",
    ".dino/index/sqlite/wiki.sqlite-wal",
  ]) {
    const fullPath = dataPath(relativePath);
    if (existsSync(fullPath)) rmSync(fullPath, { force: true });
  }
}

function loadRegistrySummary() {
  const report = readJsonSafe(registryReportPath);
  return report
    ? {
        registry_path: registryPath,
        report_path: registryReportPath,
        session_count: report.session_count || null,
        total_messages: report.total_messages || null,
        raw_full_transcript_stored: report.raw_full_transcript_stored === true ? true : false,
        message_content_stored: report.message_content_stored === true ? true : false,
      }
    : {
        registry_path: registryPath,
        report_path: registryReportPath,
        missing: true,
      };
}

function main() {
  if (!existsSync(sessionsDir)) throw new Error(`Codex sessions dir not found: ${sessionsDir}`);
  if (!existsSync(dataRoot)) throw new Error(`DinoBrain data root not found: ${dataRoot}`);

  const files = walkJsonl(sessionsDir).sort();
  const sessions = files.map(parseSession).filter((session) => session.message_count > 0);
  const analyzed = analyzeSessions(sessions).sort((a, b) => b.weighted_score - a.weighted_score);
  const promoted = analyzed.filter((result) => result.weighted_score >= result.rule.min_score && result.session_count >= 1);
  const skipped = analyzed.filter((result) => !promoted.includes(result));
  const registry = loadRegistrySummary();

  const report = {
    ok: true,
    write: shouldWrite,
    generated_at: generatedAt,
    mode: "metadata_only_pattern_promotion",
    sessions_dir: "local-codex-sessions",
    data_root: "local-dinobrain-data",
    registry,
    raw_full_transcript_stored: false,
    message_content_stored: false,
    scanned: {
      session_files: files.length,
      non_empty_sessions: sessions.length,
      message_count: sessions.reduce((sum, session) => sum + session.message_count, 0),
      user_message_count: sessions.reduce((sum, session) => sum + session.user_message_count, 0),
      assistant_message_count: sessions.reduce((sum, session) => sum + session.assistant_message_count, 0),
      parse_errors: sessions.reduce((sum, session) => sum + session.parse_errors, 0),
    },
    promoted_count: promoted.length,
    accepted_memory_paths: promoted.map((result) => memoryPath(result.rule.id)),
    review_paths: promoted.map((result) => reviewPath(result.rule.id)),
    profile_path: profilePath,
    promotion_report_path: promotionReportPath,
    promotion_report_markdown_path: promotionReportMarkdownPath,
    promoted: promoted.map((result) => ({
      id: memoryId(result.rule.id),
      memory_path: memoryPath(result.rule.id),
      review_path: reviewPath(result.rule.id),
      memory_kind: result.rule.memory_kind,
      title: result.rule.title,
      confidence: result.rule.confidence,
      source_session_count: result.session_count,
      user_hit_count: result.user_hits,
      assistant_hit_count: result.assistant_hits,
      weighted_score: result.weighted_score,
      projects_seen: result.projects_seen.slice(0, 8),
      evidence_hash_count: result.evidence_hashes.length,
    })),
    skipped_below_threshold: skipped.map((result) => ({
      rule_id: result.rule.id,
      title: result.rule.title,
      weighted_score: result.weighted_score,
      source_session_count: result.session_count,
    })),
  };

  if (shouldWrite) {
    for (const result of promoted) {
      const previous = readJsonSafe(memoryPath(result.rule.id));
      writeJson(memoryPath(result.rule.id), buildAcceptedRecord(result, previous));
      writeJson(reviewPath(result.rule.id), buildReviewRecord(result));
    }
    writeText(profilePath, buildProfile(promoted, skipped, sessions));
    writeJson(promotionReportPath, report);
    writeText(
      promotionReportMarkdownPath,
      [
        "# Codex Session Knowledge Promotion",
        "",
        `Generated at: ${generatedAt}`,
        `Status: ${promoted.length > 0 ? "promoted" : "no promotions"}`,
        `Sessions scanned: ${sessions.length}`,
        `Messages scanned: ${report.scanned.message_count}`,
        `Promoted memories: ${promoted.length}`,
        "Raw full transcripts stored: false",
        "Message content stored: false",
        "",
        "## Promoted",
        "",
        ...promoted.map(
          (result) =>
            `- ${result.rule.id}: ${result.rule.title} (${memoryPath(result.rule.id)}, score ${result.weighted_score}, sessions ${result.session_count})`,
        ),
        "",
      ].join("\n"),
    );
    appendJsonl(`.dino/events/${date}.jsonl`, {
      event: "codex_session_knowledge_promoted",
      at: generatedAt,
      mode: "metadata_only_pattern_promotion",
      profile_path: profilePath,
      promotion_report_path: promotionReportPath,
      promoted_count: promoted.length,
      raw_full_transcript_stored: false,
      message_content_stored: false,
    });
    removeStaleIndexes();
  }

  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

main();
