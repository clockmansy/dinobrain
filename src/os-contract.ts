import { DINOBRAIN_VERSION } from "./version.js";

export const DINOBRAIN_OS_VERSION = DINOBRAIN_VERSION;
export const DINOBRAIN_OS_CONTRACT = "dinobrain_os_v2";

export type GateLevel = "pass" | "warn" | "block";
export type ActionDecision = "allow" | "constrained_action" | "block";
export type ActionScope = "all" | "memory" | "persistence" | "sync" | "destructive";

export type ActionGate = {
  id: string;
  level: GateLevel;
  reason: string;
  safe_action: string;
  scope: ActionScope;
  constrains_action: boolean;
};

export type Sensitivity = "normal" | "sensitive" | "unknown";

export type ActionGateInput = {
  request: string;
  hasContextPack: boolean;
  contextItemCount: number;
  contextTraceVerified: boolean;
  contextTraceFresh: boolean;
  preflightEventOrderVerified: boolean;
  sensitivity: Sensitivity;
  exposedTools: string[];
  syncObservation?: SyncRiskObservation;
};

export type SyncRiskObservation = {
  status: "not_requested" | "clean" | "review_required" | "blocked" | "unavailable";
  changed_file_count: number;
  syncable_count: number;
  conditional_count: number;
  blocked_count: number;
  reason_codes: string[];
};

export type RequestActionIntent = {
  destructive: boolean;
  persistence: boolean;
  sync: boolean;
  data_sync: boolean;
};

export const REQUIRED_OS_TOOLS = [
  "auto_sync",
  "audit_memory_use",
  "apply_node_lifecycle",
  "create_candidate_instance",
  "create_source_chunk",
  "evaluate_behavior",
  "finish_task",
  "get_context_pack",
  "git_sync",
  "heartbeat_task",
  "import_session",
  "os_begin_task",
  "os_gate",
  "quarantine_record",
  "record_feedback_correction",
  "review_candidate",
  "run_compounding_cycle",
  "search_memory",
  "start_task",
  "wiki_search",
] as const;

function includesAny(value: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(value));
}

const DESTRUCTIVE_PATTERNS = [
  /\breset\s+--hard\b/,
  /\bremove-item\b.*\b-recurse\b/,
  /\brm\s+-rf\b/,
  /\bdelete\b.*\b(all|repo|data|memory|vault)\b/,
  /\buninstall\b/,
  /\uC0AD\uC81C/,
  /\uC81C\uAC70/,
  /\uCD08\uAE30\uD654/,
  /\uC5B8\uC778\uC2A4\uD1A8/,
];

const SYNC_PATTERNS = [
  /\bpush\b/,
  /\brelease\b/,
  /\bdeploy\b/,
  /\bsync\b/,
  /\bupload\b/,
  /\bbackup\b/,
  /\uAE43\uD5D9/,
  /\uBC30\uD3EC/,
  /\uD478\uC26C/,
  /\uBC31\uC5C5/,
  /\uC2F1\uD06C/,
  /\uB3D9\uAE30\uD654/,
];

const PERSISTENCE_PATTERNS = [
  /\b(store|save|persist|record|remember|write|commit|publish|upload|push|sync|backup)\b/,
  /\uC800\uC7A5/,
  /\uAE30\uB85D/,
  /\uAE30\uC5B5/,
  /\uCEE4\uBC0B/,
  /\uD478\uC26C/,
  /\uB3D9\uAE30\uD654/,
];

const DATA_SYNC_SCOPE_PATTERNS = [
  /\bdinobrain-data\b/,
  /\bdata\s+(repo|repository|vault)\b/,
  /\b(secondbrain|memory\s+vault|knowledge\s+vault)\b/,
  /\uB370\uC774\uD130\s*\uB808\uD3EC/,
  /\uC138\uCEE8\uB4DC\uBE0C\uB808\uC778/,
  /\uAE30\uC5B5\s*\uC800\uC7A5\uC18C/,
];

export function detectRequestActionIntent(request: string): RequestActionIntent {
  const normalized = request.toLowerCase();
  const sync = includesAny(normalized, SYNC_PATTERNS);
  return {
    destructive: includesAny(normalized, DESTRUCTIVE_PATTERNS),
    persistence: includesAny(normalized, PERSISTENCE_PATTERNS),
    sync,
    data_sync: sync && includesAny(normalized, DATA_SYNC_SCOPE_PATTERNS),
  };
}

const SENSITIVITY_PATTERNS: Array<[string, RegExp]> = [
  ["api_key_assignment", /api[_-]?key\s*[:=]/i],
  ["secret_assignment", /secret\s*[:=]/i],
  ["token_assignment", /token\s*[:=]/i],
  ["password_assignment", /password\s*[:=]/i],
  ["private_key_block", /BEGIN [A-Z ]*PRIVATE KEY/],
  ["openai_key_shape", /sk-[A-Za-z0-9_-]{20,}/],
  ["github_token_shape", /(?:github_pat_[A-Za-z0-9_]{20,}|(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{20,})/],
  ["aws_access_key_shape", /(?:AKIA|ASIA)[A-Z0-9]{16}/],
  ["jwt_shape", /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/],
  ["cookie_assignment", /(session[_-]?id|session[_-]?token|cookie)\s*[:=]/i],
  ["korean_password", /\uBE44\uBC00\uBC88\uD638/],
  ["korean_token", /\uD1A0\uD070/],
  ["korean_secret", /\uC2DC\uD06C\uB9BF/],
];

function sensitivityRank(value: Sensitivity): number {
  if (value === "sensitive") return 2;
  if (value === "unknown") return 1;
  return 0;
}

export function detectSensitivity(request: string): { sensitivity: Sensitivity; hits: string[] } {
  const hits = SENSITIVITY_PATTERNS.filter(([, pattern]) => pattern.test(request)).map(([name]) => name);
  return {
    sensitivity: hits.length > 0 ? "sensitive" : "normal",
    hits,
  };
}

export function effectiveSensitivity(reported: Sensitivity, request: string): {
  sensitivity: Sensitivity;
  reported: Sensitivity;
  detected: Sensitivity;
  hits: string[];
  escalated: boolean;
} {
  const detected = detectSensitivity(request);
  const sensitivity = sensitivityRank(detected.sensitivity) > sensitivityRank(reported) ? detected.sensitivity : reported;
  return {
    sensitivity,
    reported,
    detected: detected.sensitivity,
    hits: detected.hits,
    escalated: sensitivity !== reported,
  };
}

export function evaluateActionGates(input: ActionGateInput): {
  status: GateLevel;
  action_decision: ActionDecision;
  fail_closed: boolean;
  gates: ActionGate[];
  reason_codes: string[];
  request_intent: RequestActionIntent;
  persistence_policy: "normal" | "metadata_only_no_growth" | "blocked";
  sync_policy: "not_requested" | "scoped_dry_run_required" | "blocked";
  effective_sensitivity: Sensitivity;
  reported_sensitivity: Sensitivity;
  detected_sensitivity: Sensitivity;
  sensitivity_hits: string[];
} {
  const requestIntent = detectRequestActionIntent(input.request);
  const sensitivity = effectiveSensitivity(input.sensitivity, input.request);
  const gates: ActionGate[] = [];

  if (!input.hasContextPack) {
    gates.push({
      id: "pre_response_os_context_required",
      level: "block",
      reason: "No OS Context Pack is available before work begins.",
      safe_action: "Stop substantial work and ask the user to restore DinoBrain OS preflight.",
      scope: "all",
      constrains_action: true,
    });
  } else if (!input.contextTraceVerified) {
    gates.push({
      id: "context_trace_unverified",
      level: "block",
      reason: "The Context Pack trace could not be verified against OS-owned bytes and events.",
      safe_action: "Regenerate the Context Pack through os_begin_task before performing work.",
      scope: "all",
      constrains_action: true,
    });
  } else if (!input.contextTraceFresh) {
    gates.push({
      id: "context_trace_stale",
      level: "block",
      reason: "The verified Context Pack trace is older than the pre-response freshness window.",
      safe_action: "Run os_begin_task again to obtain a fresh trace and gate report.",
      scope: "all",
      constrains_action: true,
    });
  }

  if (!input.preflightEventOrderVerified) {
    gates.push({
      id: "pre_response_event_order_unverified",
      level: "block",
      reason: "OS events do not prove the required task-start and Context Pack ordering.",
      safe_action: "Stop and rerun preflight through the trusted hook or direct MCP entrypoint.",
      scope: "all",
      constrains_action: true,
    });
  }

  if (input.contextItemCount === 0) {
    gates.push({
      id: "evidence_sparse",
      level: "warn",
      reason: "The OS returned no relevant memory for this request.",
      safe_action: "Proceed only with current-turn evidence and search narrowly before relying on memory.",
      scope: "memory",
      constrains_action: true,
    });
  }

  if (sensitivity.escalated) {
    gates.push({
      id: "sensitivity_auto_escalated",
      level: "warn",
      reason: "The request matched sensitive-content rules despite a lower reported sensitivity.",
      safe_action: "Treat the task as sensitive and avoid storing raw credentials, tokens, or private identifiers.",
      scope: "persistence",
      constrains_action: true,
    });
  }

  if (sensitivity.sensitivity === "sensitive") {
    gates.push({
      id: "sensitive_prompt",
      level: "warn",
      reason: "The request or hook input was marked sensitive.",
      safe_action: "Provide safe assistance from redacted metadata only; do not grow memory or sync sensitive material.",
      scope: "persistence",
      constrains_action: true,
    });
  } else if (sensitivity.sensitivity === "unknown") {
    gates.push({
      id: "sensitivity_unknown",
      level: "warn",
      reason: "The request sensitivity could not be established by a trusted caller or the local detector.",
      safe_action: "Proceed with redacted metadata only and avoid memory growth or sync until sensitivity is known.",
      scope: "persistence",
      constrains_action: true,
    });
  }

  if (sensitivity.sensitivity === "sensitive" && (requestIntent.persistence || requestIntent.sync)) {
    gates.push({
      id: "sensitive_persistence_blocked",
      level: "block",
      reason: "The request combines sensitive content with persistence or sync intent.",
      safe_action: "Assist with rotation or remediation without storing, committing, uploading, or syncing the sensitive value.",
      scope: requestIntent.sync ? "sync" : "persistence",
      constrains_action: true,
    });
  }

  if (requestIntent.destructive) {
    gates.push({
      id: "destructive_action_risk",
      level: "block",
      reason: "The request may delete or reset durable data.",
      safe_action: "Require explicit confirmation and a backup/sync risk check before destructive execution.",
      scope: "destructive",
      constrains_action: true,
    });
  }

  if (requestIntent.data_sync) {
    const observation = input.syncObservation;
    if (!observation || observation.status === "unavailable" || observation.status === "not_requested") {
      gates.push({
        id: "sync_state_unverified",
        level: "block",
        reason: "The OS could not independently verify the DinoBrain data sync state.",
        safe_action: "Run a scoped git_sync dry-run and sensitivity scan before any commit or push.",
        scope: "sync",
        constrains_action: true,
      });
    } else if (observation.status === "blocked") {
      gates.push({
        id: "sync_policy_blocked",
        level: "block",
        reason: `The observed data sync plan contains ${observation.blocked_count} blocked path(s).`,
        safe_action: "Do not sync; restrict the operation to reviewed allowlisted paths and rerun the policy check.",
        scope: "sync",
        constrains_action: true,
      });
    } else if (observation.status === "review_required") {
      gates.push({
        id: "sync_review_required",
        level: "warn",
        reason: `The observed data sync plan contains ${observation.conditional_count} review-required path(s).`,
        safe_action: "Continue local work, but do not sync until the exact paths pass review.",
        scope: "sync",
        constrains_action: true,
      });
    }
  } else if (requestIntent.sync) {
    gates.push({
      id: "backup_sync_risk",
      level: "warn",
      reason: "The request touches sync, release, deployment, or backup behavior.",
      safe_action: "Run git_sync dry-run or installer/version alignment checks before publishing.",
      scope: "sync",
      constrains_action: true,
    });
  }

  for (const tool of REQUIRED_OS_TOOLS) {
    if (!input.exposedTools.includes(tool)) {
      gates.push({
        id: `required_tool_missing:${tool}`,
        level: "block",
        reason: `Required OS tool is not exposed: ${tool}.`,
        safe_action: "Fail closed until the MCP server exposes the required OS tool.",
        scope: "all",
        constrains_action: true,
      });
    }
  }

  gates.push({
    id: "finish_task_required",
    level: "warn",
    reason: "Every started OS task must be closed with finish_task.",
    safe_action: "Keep the task visible as active/pending until finish_task writes a trace.",
    scope: "all",
    constrains_action: false,
  });

  const hasBlock = gates.some((gate) => gate.level === "block");
  const hasWarn = gates.some((gate) => gate.level === "warn");
  const hasConstraint = gates.some((gate) => gate.level === "warn" && gate.constrains_action);
  const actionDecision: ActionDecision = hasBlock ? "block" : hasConstraint ? "constrained_action" : "allow";
  const persistencePolicy = hasBlock && sensitivity.sensitivity === "sensitive" && requestIntent.persistence
    ? "blocked"
    : sensitivity.sensitivity !== "normal"
      ? "metadata_only_no_growth"
      : "normal";
  const syncPolicy = gates.some((gate) => gate.scope === "sync" && gate.level === "block")
    ? "blocked"
    : requestIntent.sync
      ? "scoped_dry_run_required"
      : "not_requested";
  return {
    status: hasBlock ? "block" : hasWarn ? "warn" : "pass",
    action_decision: actionDecision,
    fail_closed: actionDecision === "block",
    gates,
    reason_codes: gates.map((gate) => gate.id),
    request_intent: requestIntent,
    persistence_policy: persistencePolicy,
    sync_policy: syncPolicy,
    effective_sensitivity: sensitivity.sensitivity,
    reported_sensitivity: sensitivity.reported,
    detected_sensitivity: sensitivity.detected,
    sensitivity_hits: sensitivity.hits,
  };
}
