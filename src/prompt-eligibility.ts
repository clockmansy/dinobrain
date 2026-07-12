import { createHash } from "node:crypto";

export const PROMPT_ELIGIBILITY_VERSION = "prompt_eligibility_v1";

export const PROMPT_LAUNCH_CLASSES = [
  "user_interactive",
  "internal_codex_service",
  "ambient_suggestion",
  "title_generation",
  "diagnostic_probe",
  "unknown",
] as const;

export type PromptLaunchClass = (typeof PROMPT_LAUNCH_CLASSES)[number];

export type PromptEligibilityInput = {
  request: string;
  launchKind?: string | null;
  surface?: string | null;
  taskType?: string | null;
  source?: string | null;
  promptPresent?: boolean;
};

export type PromptEligibility = {
  version: typeof PROMPT_ELIGIBILITY_VERSION;
  classification: PromptLaunchClass;
  durable_task_eligible: boolean;
  confidence: "high" | "medium" | "low";
  reason_codes: string[];
};

const DIAGNOSTIC_LAUNCH_KINDS = new Set([
  "diagnostic_probe",
  "installer_handshake",
  "manual_probe",
  "health_probe",
  "hook_diagnose",
]);

const USER_LAUNCH_KINDS = new Set([
  "codex_desktop",
  "claude_code",
  "user_interactive",
  "verification_fixture",
  "direct_mcp",
  "client_mcp_proof",
]);

const TITLE_PATTERNS = [
  /provide a short title for a task that will be created from that prompt/i,
  /generate a concise ui title \(up to \d+ characters\)/i,
  /fill the structured title field with plain text/i,
  /generate a clear, informative task title based solely on the prompt/i,
];

const DIAGNOSTIC_PATTERNS = [
  /dinobrain live codex hook diagnostic probe/i,
  /manual hook env test/i,
  /diagnose (?:the )?dinobrain (?:codex )?hook/i,
];

const AMBIENT_PATTERNS = [
  /generate\s+(?:0\s*(?:to|-)\s*3|0-3)\s+hyperpersonalized suggestions/i,
  /generate hyperpersonalized codex suggestions for work to do next/i,
  /codex ambient suggestions/i,
  /list of ambient suggestion candidates/i,
  /optimize for relief: choose suggestions that make the user's life easier/i,
  /grounded in recent repo activity and connected-app signals/i,
];

const INTERNAL_SERVICE_PATTERNS = [
  /<codex_delegation>\s*<source_thread_id>/i,
  /memory writing agent:\s*phase\s*2/i,
  /consolidate raw memories and rollout summaries/i,
  /overview:\s*generate\s+0\s*(?:to|-)\s*3\s+hypotheses/i,
  /you are one of \d+ independent (?:reviewer|subagent|agent)/i,
  /independent read-only .*review/i,
  /\bcompletion reviewer \d+/i,
  /\brag verification subagent \d+/i,
  /\byou are reviewer r\d+/i,
  /\bread-only review\.\s*you are reviewer/i,
  /return\s+reviewer_lens/i,
];

function normalized(value: string | null | undefined): string {
  return String(value ?? "").trim().toLowerCase();
}

function matchesAny(value: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(value));
}

function matchCount(value: string, patterns: RegExp[]): number {
  return patterns.filter((pattern) => pattern.test(value)).length;
}

function metadataText(input: PromptEligibilityInput): string {
  return [input.launchKind, input.surface, input.taskType, input.source].map(normalized).filter(Boolean).join(" ");
}

export function classifyPromptLaunch(input: PromptEligibilityInput): PromptEligibility {
  const request = String(input.request ?? "").trim();
  const launchKind = normalized(input.launchKind);
  const metadata = metadataText(input);
  const promptPresent = input.promptPresent ?? request.length > 0;

  if (!promptPresent || !request) {
    return {
      version: PROMPT_ELIGIBILITY_VERSION,
      classification: "unknown",
      durable_task_eligible: false,
      confidence: "high",
      reason_codes: ["prompt_text_missing"],
    };
  }

  if (
    DIAGNOSTIC_LAUNCH_KINDS.has(launchKind) ||
    /\b(diagnostic|installer)[_-]?(probe|handshake)\b/.test(metadata) ||
    matchesAny(request, DIAGNOSTIC_PATTERNS)
  ) {
    return {
      version: PROMPT_ELIGIBILITY_VERSION,
      classification: "diagnostic_probe",
      durable_task_eligible: false,
      confidence: "high",
      reason_codes: ["diagnostic_launch_provenance"],
    };
  }

  if (/\b(title_generation|task_title|thread_title)\b/.test(metadata) || matchCount(request, TITLE_PATTERNS) >= 2) {
    return {
      version: PROMPT_ELIGIBILITY_VERSION,
      classification: "title_generation",
      durable_task_eligible: false,
      confidence: "high",
      reason_codes: ["title_generation_signature"],
    };
  }

  if (
    /\b(ambient_suggestion|suggestion_generation|suggestion_safety)\b/.test(metadata) ||
    matchCount(request, AMBIENT_PATTERNS) >= 2
  ) {
    return {
      version: PROMPT_ELIGIBILITY_VERSION,
      classification: "ambient_suggestion",
      durable_task_eligible: false,
      confidence: "high",
      reason_codes: ["ambient_suggestion_signature"],
    };
  }

  if (/\b(internal_codex_service|memory_writer|subagent|reviewer_worker)\b/.test(metadata) || matchesAny(request, INTERNAL_SERVICE_PATTERNS)) {
    return {
      version: PROMPT_ELIGIBILITY_VERSION,
      classification: "internal_codex_service",
      durable_task_eligible: false,
      confidence: "high",
      reason_codes: ["internal_service_signature"],
    };
  }

  if (USER_LAUNCH_KINDS.has(launchKind) || /\b(user_interactive|user_prompt|chat_turn)\b/.test(metadata)) {
    return {
      version: PROMPT_ELIGIBILITY_VERSION,
      classification: "user_interactive",
      durable_task_eligible: true,
      confidence: launchKind === "direct_mcp" ? "medium" : "high",
      reason_codes: [launchKind === "direct_mcp" ? "direct_mcp_without_internal_signature" : "interactive_launch_provenance"],
    };
  }

  return {
    version: PROMPT_ELIGIBILITY_VERSION,
    classification: "unknown",
    durable_task_eligible: false,
    confidence: "low",
    reason_codes: ["launch_provenance_unresolved"],
  };
}

export function makePromptIdentityHash(parts: {
  hookRunId: string;
  promptHash: string;
  clientSessionId: string;
}): string {
  const canonical = JSON.stringify({
    hook_run_id: parts.hookRunId.trim(),
    prompt_hash: parts.promptHash.trim().toLowerCase(),
    client_session_id: parts.clientSessionId.trim(),
  });
  return createHash("sha256").update(canonical).digest("hex");
}
