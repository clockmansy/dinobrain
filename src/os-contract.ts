export const DINOBRAIN_OS_VERSION = "2.0.1";
export const DINOBRAIN_OS_CONTRACT = "dinobrain_os_v2";

export type GateLevel = "pass" | "warn" | "block";

export type ActionGate = {
  id: string;
  level: GateLevel;
  reason: string;
  safe_action: string;
};

export type ActionGateInput = {
  request: string;
  hasContextPack: boolean;
  contextItemCount: number;
  sensitivity: "normal" | "sensitive" | "unknown";
  exposedTools: string[];
  backupRisk?: boolean;
};

export const REQUIRED_OS_TOOLS = [
  "audit_memory_use",
  "apply_node_lifecycle",
  "create_candidate_instance",
  "create_source_chunk",
  "evaluate_behavior",
  "finish_task",
  "get_context_pack",
  "git_sync",
  "import_session",
  "os_begin_task",
  "os_gate",
  "quarantine_record",
  "record_feedback_correction",
  "review_candidate",
  "start_task",
  "wiki_search",
] as const;

function includesAny(value: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(value));
}

export function evaluateActionGates(input: ActionGateInput): {
  status: GateLevel;
  fail_closed: boolean;
  gates: ActionGate[];
} {
  const request = input.request.toLowerCase();
  const gates: ActionGate[] = [];

  if (!input.hasContextPack) {
    gates.push({
      id: "pre_response_os_context_required",
      level: "block",
      reason: "No OS Context Pack is available before work begins.",
      safe_action: "Stop substantial work and ask the user to restore DinoBrain OS preflight.",
    });
  }

  if (input.contextItemCount === 0) {
    gates.push({
      id: "evidence_sparse",
      level: "warn",
      reason: "The OS returned no relevant memory for this request.",
      safe_action: "Proceed only with current-turn evidence and search narrowly before relying on memory.",
    });
  }

  if (input.sensitivity !== "normal") {
    gates.push({
      id: "sensitive_prompt",
      level: "warn",
      reason: "The request or hook input was marked sensitive.",
      safe_action: "Do not store secrets or raw full transcripts; keep sync blocked until review.",
    });
  }

  if (
    includesAny(request, [
      /\breset\s+--hard\b/,
      /\bremove-item\b.*\b-recurse\b/,
      /\brm\s+-rf\b/,
      /\bdelete\b.*\b(all|repo|data|memory|vault)\b/,
      /\buninstall\b/,
      /\uC0AD\uC81C/, // delete
      /\uC81C\uAC70/, // remove
      /\uCD08\uAE30\uD654/, // reset/initialize
      /\uC5B8\uC778\uC2A4\uD1A8/, // uninstall
    ])
  ) {
    gates.push({
      id: "destructive_action_risk",
      level: "block",
      reason: "The request may delete or reset durable data.",
      safe_action: "Require explicit confirmation and a backup/sync risk check before destructive execution.",
    });
  }

  if (
    input.backupRisk === true ||
    includesAny(request, [
      /\bpush\b/,
      /\brelease\b/,
      /\bdeploy\b/,
      /\bsync\b/,
      /\uAE43\uD5D9/, // GitHub
      /\uBC30\uD3EC/, // deploy/release
      /\uD478\uC26C/, // push
      /\uBC31\uC5C5/, // backup
      /\uC2F1\uD06C/, // sync
      /\uB3D9\uAE30\uD654/, // synchronize
    ])
  ) {
    gates.push({
      id: "backup_sync_risk",
      level: "warn",
      reason: "The request touches sync, release, deployment, or backup behavior.",
      safe_action: "Run git_sync dry-run or installer/version alignment checks before publishing.",
    });
  }

  for (const tool of REQUIRED_OS_TOOLS) {
    if (!input.exposedTools.includes(tool)) {
      gates.push({
        id: `required_tool_missing:${tool}`,
        level: "block",
        reason: `Required OS tool is not exposed: ${tool}.`,
        safe_action: "Fail closed until the MCP server exposes the required OS tool.",
      });
    }
  }

  gates.push({
    id: "finish_task_required",
    level: "warn",
    reason: "Every started OS task must be closed with finish_task.",
    safe_action: "Keep the task visible as active/pending until finish_task writes a trace.",
  });

  const hasBlock = gates.some((gate) => gate.level === "block");
  const hasWarn = gates.some((gate) => gate.level === "warn");
  return {
    status: hasBlock ? "block" : hasWarn ? "warn" : "pass",
    fail_closed: hasBlock,
    gates,
  };
}
