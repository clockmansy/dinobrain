import { createHash } from "node:crypto";

export type SessionRole = "user" | "assistant" | "system" | "tool" | "unknown";
export type SessionSensitivity = "normal" | "sensitive" | "unknown";
export type SessionRawRetention = "metadata_only" | "redacted_excerpt";
export type MemoryTemperature = "hot" | "warm" | "cold";
export type CandidateCategory =
  | "user_preference"
  | "project_decision"
  | "project_state"
  | "how_to"
  | "error_fix"
  | "idea";

export type SessionMessageInput = {
  role?: SessionRole;
  content: string;
  at?: string;
};

export type SessionImportInput = {
  source: string;
  project?: string;
  title?: string;
  transcript?: string;
  messages?: SessionMessageInput[];
  sensitivity: SessionSensitivity;
  maxCandidates: number;
  rawRetention: SessionRawRetention;
  now?: Date;
};

type RedactionHit = {
  pattern: string;
  count: number;
};

type NormalizedMessage = {
  message_id: string;
  role: SessionRole;
  at: string | null;
  content: string;
};

type CandidateDraft = {
  category: CandidateCategory;
  temperature: MemoryTemperature;
  claim: string;
  evidenceSnippet: string;
  messageId: string;
  role: SessionRole;
  confidence: "low" | "medium" | "high";
};

export type SessionCandidateRecord = {
  candidateId: string;
  candidatePath: string;
  reviewPath: string;
  candidate: Record<string, unknown>;
  review: Record<string, unknown>;
};

export type SessionImportPlan = {
  sessionId: string;
  archivePath: string;
  archive: Record<string, unknown>;
  candidates: SessionCandidateRecord[];
  stats: {
    message_count: number;
    stored_message_count: number;
    raw_retention: SessionRawRetention;
    raw_full_transcript_stored: false;
    candidates_created: number;
    redaction_hits: RedactionHit[];
    temperature_counts: Record<MemoryTemperature, number>;
    category_counts: Record<CandidateCategory, number>;
  };
};

const MAX_MESSAGE_PREVIEW_CHARS = 360;
const MAX_TOTAL_PREVIEW_CHARS = 12_000;
const MAX_MESSAGE_COUNT = 120;
const MAX_CANDIDATE_SNIPPET_CHARS = 420;

const CATEGORY_CUES: Record<CandidateCategory, string[]> = {
  user_preference: [
    "i prefer",
    "i want",
    "i need",
    "do not",
    "don't",
    "always",
    "never",
    "\ub098\ub294",
    "\uc120\ud638",
    "\uc6d0\ud574",
    "\ud574\uc57c",
    "\ud558\uc9c0\ub9c8",
    "\uacc4\ud68d\uc11c",
  ],
  project_decision: [
    "decision",
    "decide",
    "decided",
    "adopt",
    "use sqlite",
    "architecture",
    "structure",
    "\uacb0\uc815",
    "\uad6c\uc870",
    "\uc544\ud0a4\ud14d\ucc98",
    "\ud558\uae30\ub85c",
    "\uc0e4\ub529",
  ],
  project_state: [
    "current",
    "currently",
    "implemented",
    "working",
    "ready",
    "verified",
    "\ud604\uc7ac",
    "\uc9c0\uae08",
    "\uad6c\ucd95",
    "\uc791\ub3d9",
    "\uac80\uc99d",
    "\ud478\uc26c",
  ],
  how_to: [
    "how to",
    "setup",
    "install",
    "run",
    "verify",
    "steps",
    "\ubc29\ubc95",
    "\uc808\ucc28",
    "\uc124\uce58",
    "\uc2e4\ud589",
    "\uc138\ud305",
    "\uac80\uc99d",
  ],
  error_fix: [
    "error",
    "bug",
    "failed",
    "failure",
    "fix",
    "root cause",
    "\uc624\ub958",
    "\ubc84\uadf8",
    "\uc2e4\ud328",
    "\uace0\uce68",
    "\uc6d0\uc778",
  ],
  idea: [
    "idea",
    "proposal",
    "maybe",
    "later",
    "could",
    "\uc544\uc774\ub514\uc5b4",
    "\uc81c\uc548",
    "\ub098\uc911",
    "\uc5b8\uc820\uac00",
  ],
};

function dateStamp(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function safeSlug(value: string): string {
  const slug = value
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 72);
  return slug || "session";
}

function shortHash(value: string, length = 10): string {
  return createHash("sha256").update(value).digest("hex").slice(0, length);
}

function normalizeRole(value: unknown): SessionRole {
  if (value === "user" || value === "assistant" || value === "system" || value === "tool") return value;
  return "unknown";
}

function mergeRedactionHits(target: Map<string, number>, hits: RedactionHit[]): void {
  for (const hit of hits) {
    target.set(hit.pattern, (target.get(hit.pattern) ?? 0) + hit.count);
  }
}

export function redactSensitiveText(input: string): { text: string; hits: RedactionHit[] } {
  const counts = new Map<string, number>();
  let text = input;

  const apply = (patternName: string, pattern: RegExp, replacement: string | ((match: string, ...args: string[]) => string)) => {
    let count = 0;
    text = text.replace(pattern, (...args: string[]) => {
      count += 1;
      if (typeof replacement === "function") return replacement(args[0], ...args.slice(1));
      return replacement;
    });
    if (count > 0) counts.set(patternName, (counts.get(patternName) ?? 0) + count);
  };

  apply(
    "private_key_block",
    /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    "[REDACTED_PRIVATE_KEY]",
  );
  apply("openai_key_shape", /\bsk-[A-Za-z0-9_-]{20,}\b/g, "[REDACTED_OPENAI_KEY]");
  apply(
    "github_token_shape",
    /\b(?:github_pat_[A-Za-z0-9_]{20,}|(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{20,})\b/g,
    "[REDACTED_GITHUB_TOKEN]",
  );
  apply("aws_access_key_shape", /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, "[REDACTED_AWS_ACCESS_KEY]");
  apply("jwt_shape", /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, "[REDACTED_JWT]");
  apply("bearer_token", /\bBearer\s+[A-Za-z0-9._-]{12,}\b/gi, "Bearer [REDACTED_TOKEN]");
  apply(
    "secret_assignment",
    /\b(api[_-]?key|secret|token|password|session[_-]?id|session[_-]?token|cookie)\s*[:=]\s*["']?[^"'\s,;}]+/gi,
    (_match, name: string) => `${name}=[REDACTED_SECRET]`,
  );

  return {
    text,
    hits: Array.from(counts, ([pattern, count]) => ({ pattern, count })),
  };
}

function normalizeMessages(input: SessionImportInput): NormalizedMessage[] {
  const rawMessages =
    input.messages && input.messages.length > 0
      ? input.messages
      : input.transcript
        ? [{ role: "unknown" as const, content: input.transcript }]
        : [];

  return rawMessages
    .filter((message) => typeof message.content === "string" && message.content.trim().length > 0)
    .slice(0, MAX_MESSAGE_COUNT)
    .map((message, index) => ({
      message_id: `m${String(index + 1).padStart(4, "0")}`,
      role: normalizeRole(message.role),
      at: typeof message.at === "string" && message.at.trim().length > 0 ? message.at.trim() : null,
      content: message.content.trim(),
    }));
}

function truncate(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars - 24).trimEnd()} [TRUNCATED]`;
}

function splitSignals(text: string): string[] {
  return text
    .split(/(?:\r?\n)+|(?<=[.!?])\s+/)
    .map((part) => part.replace(/\s+/g, " ").trim())
    .filter((part) => part.length >= 12)
    .slice(0, 20);
}

function categoryForSignal(signal: string, role: SessionRole): CandidateCategory | null {
  const lower = signal.toLowerCase();
  const ordered: CandidateCategory[] =
    role === "user"
      ? ["user_preference", "project_decision", "project_state", "error_fix", "how_to", "idea"]
      : ["error_fix", "how_to", "project_decision", "project_state", "idea", "user_preference"];

  for (const category of ordered) {
    if (CATEGORY_CUES[category].some((cue) => lower.includes(cue.toLowerCase()))) return category;
  }
  return null;
}

function temperatureForCategory(category: CandidateCategory, role: SessionRole): MemoryTemperature {
  if (category === "user_preference" || category === "project_state") return "hot";
  if (category === "idea") return "cold";
  if (category === "project_decision" && role === "user") return "hot";
  return "warm";
}

function confidenceForCategory(category: CandidateCategory, role: SessionRole): "low" | "medium" | "high" {
  if (category === "idea") return "low";
  if (role === "user" && (category === "user_preference" || category === "project_decision")) return "high";
  return "medium";
}

function claimPrefix(category: CandidateCategory): string {
  switch (category) {
    case "user_preference":
      return "User preference";
    case "project_decision":
      return "Project decision";
    case "project_state":
      return "Project state";
    case "how_to":
      return "How-to note";
    case "error_fix":
      return "Error or fix note";
    case "idea":
      return "Idea";
  }
}

function extractCandidates(messages: NormalizedMessage[], maxCandidates: number): CandidateDraft[] {
  const seen = new Set<string>();
  const drafts: CandidateDraft[] = [];

  for (const message of messages) {
    const redacted = redactSensitiveText(message.content).text;
    for (const signal of splitSignals(redacted)) {
      const category = categoryForSignal(signal, message.role);
      if (!category) continue;
      const snippet = truncate(signal, MAX_CANDIDATE_SNIPPET_CHARS);
      const dedupeKey = `${category}:${snippet.toLowerCase().replace(/[^a-z0-9\u3131-\ud7a3]+/g, "")}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      drafts.push({
        category,
        temperature: temperatureForCategory(category, message.role),
        claim: `${claimPrefix(category)}: ${snippet}`,
        evidenceSnippet: snippet,
        messageId: message.message_id,
        role: message.role,
        confidence: confidenceForCategory(category, message.role),
      });
      if (drafts.length >= maxCandidates) return drafts;
    }
  }

  return drafts;
}

function buildArchiveMessages(
  messages: NormalizedMessage[],
  rawRetention: SessionRawRetention,
): { records: Array<Record<string, unknown>>; hits: RedactionHit[] } {
  const hitCounts = new Map<string, number>();
  let remaining = MAX_TOTAL_PREVIEW_CHARS;
  const records: Array<Record<string, unknown>> = [];

  for (const message of messages) {
    const redacted = redactSensitiveText(message.content);
    mergeRedactionHits(hitCounts, redacted.hits);
    const preview =
      rawRetention === "redacted_excerpt" && remaining > 0
        ? truncate(redacted.text, Math.min(MAX_MESSAGE_PREVIEW_CHARS, remaining))
        : null;
    if (preview) remaining -= preview.length;

    records.push({
      message_id: message.message_id,
      role: message.role,
      at: message.at,
      original_char_count: message.content.length,
      redacted_sha256: shortHash(redacted.text, 64),
      preview,
      preview_truncated: preview !== null && redacted.text.length > preview.length,
    });
  }

  return {
    records,
    hits: Array.from(hitCounts, ([pattern, count]) => ({ pattern, count })),
  };
}

function countByTemperature(candidates: CandidateDraft[]): Record<MemoryTemperature, number> {
  return {
    hot: candidates.filter((candidate) => candidate.temperature === "hot").length,
    warm: candidates.filter((candidate) => candidate.temperature === "warm").length,
    cold: candidates.filter((candidate) => candidate.temperature === "cold").length,
  };
}

function countByCategory(candidates: CandidateDraft[]): Record<CandidateCategory, number> {
  return {
    user_preference: candidates.filter((candidate) => candidate.category === "user_preference").length,
    project_decision: candidates.filter((candidate) => candidate.category === "project_decision").length,
    project_state: candidates.filter((candidate) => candidate.category === "project_state").length,
    how_to: candidates.filter((candidate) => candidate.category === "how_to").length,
    error_fix: candidates.filter((candidate) => candidate.category === "error_fix").length,
    idea: candidates.filter((candidate) => candidate.category === "idea").length,
  };
}

export function buildSessionImportPlan(input: SessionImportInput): SessionImportPlan {
  const now = input.now ?? new Date();
  const messages = normalizeMessages(input);
  if (messages.length === 0) {
    throw new Error("session_import_requires_messages_or_transcript");
  }

  const maxCandidates = Math.max(1, Math.min(50, input.maxCandidates));
  const sessionKey = `${input.source}\n${input.project ?? ""}\n${input.title ?? ""}\n${messages
    .map((message) => `${message.role}:${message.content}`)
    .join("\n")}`;
  const sessionId = `session-${safeSlug(input.title ?? input.source).slice(0, 36)}-${shortHash(sessionKey, 12)}`;
  const archivePath = `10_Conversations/raw/${sessionId}.json`;
  const archiveMessages = buildArchiveMessages(messages, input.rawRetention);
  const drafts = extractCandidates(messages, maxCandidates);
  const createdAt = now.toISOString();
  const lastVerified = dateStamp(now);
  const projectTag = input.project ? `project:${safeSlug(input.project).toLowerCase()}` : null;

  const candidates = drafts.map((draft, index) => {
    const candidateId = `candidate-${safeSlug(draft.claim).slice(0, 36)}-${shortHash(
      `${sessionId}:${index}:${draft.claim}`,
      12,
    )}`;
    const candidatePath = `50_Instances/candidates/${candidateId}.json`;
    const reviewPath = `80_Review_Queue/promotion/${candidateId}.json`;
    const tags = [
      "session-import",
      draft.category,
      `temperature:${draft.temperature}`,
      projectTag,
    ].filter((tag): tag is string => typeof tag === "string");
    const candidate = {
      candidate_id: candidateId,
      status: "pending_review",
      claim: draft.claim,
      category: draft.category,
      temperature: draft.temperature,
      evidence: {
        snippet: draft.evidenceSnippet,
        source: `${archivePath}#${draft.messageId}`,
        source_session_id: sessionId,
        message_id: draft.messageId,
        message_role: draft.role,
      },
      confidence: draft.confidence,
      last_verified: lastVerified,
      source_status: "internal",
      tags,
      task_id: null,
      session_id: sessionId,
      sensitivity: input.sensitivity,
      auto_promote: false,
      promotion_blockers: ["manual_review_required", "session_extraction_v0"],
      created_at: createdAt,
      updated_at: createdAt,
    };
    const review = {
      review_id: candidateId,
      type: "session_extract_promotion",
      status: "pending",
      candidate_path: candidatePath,
      source_session_path: archivePath,
      required_checks: [
        "evidence_snippet",
        "confidence",
        "last_verified",
        "sensitivity",
        "manual_meaning_review",
      ],
      created_at: createdAt,
      updated_at: createdAt,
    };
    return {
      candidateId,
      candidatePath,
      reviewPath,
      candidate,
      review,
    };
  });

  const archive = {
    session_id: sessionId,
    status: "raw_imported",
    source: input.source,
    project: input.project ?? null,
    title: input.title ?? null,
    sensitivity: input.sensitivity,
    temperature: "cold",
    sync_policy: "local_only",
    storage_policy: {
      raw_full_transcript_stored: false,
      raw_retention: input.rawRetention,
      max_message_preview_chars: input.rawRetention === "redacted_excerpt" ? MAX_MESSAGE_PREVIEW_CHARS : 0,
      max_total_preview_chars: input.rawRetention === "redacted_excerpt" ? MAX_TOTAL_PREVIEW_CHARS : 0,
      candidate_promotion_requires_review: true,
    },
    imported_at: createdAt,
    message_count: messages.length,
    stored_message_count: archiveMessages.records.length,
    messages: archiveMessages.records,
    extraction: {
      version: "session_extract_v0",
      max_candidates: maxCandidates,
      candidate_count: candidates.length,
      candidate_paths: candidates.map((candidate) => candidate.candidatePath),
      review_paths: candidates.map((candidate) => candidate.reviewPath),
      temperature_counts: countByTemperature(drafts),
      category_counts: countByCategory(drafts),
    },
    redactions: archiveMessages.hits,
  };

  return {
    sessionId,
    archivePath,
    archive,
    candidates,
    stats: {
      message_count: messages.length,
      stored_message_count: archiveMessages.records.length,
      raw_retention: input.rawRetention,
      raw_full_transcript_stored: false,
      candidates_created: candidates.length,
      redaction_hits: archiveMessages.hits,
      temperature_counts: countByTemperature(drafts),
      category_counts: countByCategory(drafts),
    },
  };
}
