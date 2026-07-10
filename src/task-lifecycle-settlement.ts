import { promises as fs } from "node:fs";
import path from "node:path";

import { atomicWriteJson } from "./concurrency.js";
import { dataPath } from "./context.js";
import {
  buildAndWriteTaskLifecycleReport,
  buildTaskLifecycleReport,
  type TaskLifecycleReport,
  type TaskLifecycleSession,
} from "./task-lifecycle.js";

export const TASK_LIFECYCLE_SETTLEMENT_VERSION = "task_lifecycle_settlement_v1";
export const TASK_LIFECYCLE_SETTLEMENT_RELATIVE_PATH = ".dino/state/task_lifecycle_settlement.json";

type JsonObject = Record<string, unknown>;

export type TaskLifecycleSettlementAction = {
  task_id: string;
  task_path: string | null;
  trace_path: string | null;
  decision_class: string;
  action:
    | "auto_close_stale_diagnostic"
    | "repair_started_from_grounded_trace"
    | "reconstruct_blocked_missing_trace"
    | "block_stale_without_trace"
    | "skip_manual_repair"
    | "skip_recent_active";
  applied: boolean;
  reason_code: string;
  previous_status: string;
  previous_updated_at: string | null;
};

export type TaskLifecycleSettlementReport = {
  version: typeof TASK_LIFECYCLE_SETTLEMENT_VERSION;
  status: "healthy" | "needs_attention";
  generated_at: string;
  data_root: string;
  apply: boolean;
  lifecycle_before: {
    generated_at: string;
    status: TaskLifecycleReport["status"];
    counts: TaskLifecycleReport["counts"];
    by_decision_class: TaskLifecycleReport["by_decision_class"];
  };
  lifecycle_after: {
    generated_at: string;
    status: TaskLifecycleReport["status"];
    counts: TaskLifecycleReport["counts"];
    by_decision_class: TaskLifecycleReport["by_decision_class"];
  } | null;
  counts: {
    auto_close_candidates_before: number;
    auto_close_applied: number;
    auto_close_candidates_after: number | null;
    finish_gate_repairs_before: number;
    finish_gate_repairs_applied: number;
    finish_gate_repairs_after: number | null;
    manual_repair_required_before: number;
    manual_repair_required_after: number | null;
    skipped_manual_repair: number;
  };
  actions: TaskLifecycleSettlementAction[];
  warnings: string[];
  visible_status: string;
};

type SettlementOptions = {
  apply?: boolean;
  now?: Date;
  staleAfterMs?: number;
};

function nowIso(date: Date): string {
  return date.toISOString();
}

async function readJson<T>(filePath: string): Promise<T> {
  return JSON.parse(await fs.readFile(filePath, "utf8")) as T;
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await atomicWriteJson(filePath, value);
}

function tracePathFor(session: TaskLifecycleSession): string {
  return session.trace_path ?? `.dino/traces/${session.task_id}.json`;
}

function outcomeToTaskStatus(outcome: string): string {
  if (["completed", "partial", "blocked"].includes(outcome)) return outcome;
  return "completed";
}

function hasGroundedTrace(trace: JsonObject): boolean {
  const summary = typeof trace.summary === "string" && trace.summary.trim().length > 0;
  const hasEvidence = ["changed_files", "decisions", "next_steps", "used_memory_paths", "context_pack_paths", "candidate_paths"].some(
    (key) => Array.isArray(trace[key]) && (trace[key] as unknown[]).length > 0,
  );
  const outcome = typeof trace.outcome === "string" && trace.outcome.trim().length > 0;
  return outcome && summary && hasEvidence;
}

function isRepairableManualSession(session: TaskLifecycleSession): boolean {
  if (session.auto_close_safe) return false;
  if (session.decision_class === "manual_stale_review_required") return true;
  if (session.decision_class === "manual_trace_reconstruction_required" && session.status === "blocked") return true;
  return false;
}

function actionFor(session: TaskLifecycleSession): TaskLifecycleSettlementAction {
  if (session.auto_close_safe) {
    return {
      task_id: session.task_id,
      task_path: session.task_path,
      trace_path: tracePathFor(session),
      decision_class: session.decision_class,
      action: "auto_close_stale_diagnostic",
      applied: false,
      reason_code: "stale_diagnostic_auto_close_candidate",
      previous_status: session.status,
      previous_updated_at: session.updated_at,
    };
  }
  if (session.decision_class === "manual_stale_review_required" && session.trace_path) {
    return {
      task_id: session.task_id,
      task_path: session.task_path,
      trace_path: session.trace_path,
      decision_class: session.decision_class,
      action: "repair_started_from_grounded_trace",
      applied: false,
      reason_code: "stale_started_task_has_grounded_trace",
      previous_status: session.status,
      previous_updated_at: session.updated_at,
    };
  }
  if (session.decision_class === "manual_trace_reconstruction_required" && session.status === "blocked") {
    return {
      task_id: session.task_id,
      task_path: session.task_path,
      trace_path: tracePathFor(session),
      decision_class: session.decision_class,
      action: "reconstruct_blocked_missing_trace",
      applied: false,
      reason_code: "blocked_task_missing_trace_reconstructable_from_task_error",
      previous_status: session.status,
      previous_updated_at: session.updated_at,
    };
  }
  if (session.decision_class === "manual_stale_review_required" && !session.trace_path) {
    return {
      task_id: session.task_id,
      task_path: session.task_path,
      trace_path: tracePathFor(session),
      decision_class: session.decision_class,
      action: "block_stale_without_trace",
      applied: false,
      reason_code: "stale_task_without_terminal_evidence",
      previous_status: session.status,
      previous_updated_at: session.updated_at,
    };
  }
  if (session.issue_codes.length > 0) {
    return {
      task_id: session.task_id,
      task_path: session.task_path,
      trace_path: session.trace_path,
      decision_class: session.decision_class,
      action: "skip_manual_repair",
      applied: false,
      reason_code: "manual_repair_required",
      previous_status: session.status,
      previous_updated_at: session.updated_at,
    };
  }
  return {
    task_id: session.task_id,
    task_path: session.task_path,
    trace_path: session.trace_path,
    decision_class: session.decision_class,
    action: "skip_recent_active",
    applied: false,
    reason_code: "not_a_settlement_target",
    previous_status: session.status,
    previous_updated_at: session.updated_at,
  };
}

async function applyStartedFromGroundedTrace(
  dataRoot: string,
  session: TaskLifecycleSession,
  repairedAt: string,
): Promise<TaskLifecycleSettlementAction> {
  const action = actionFor(session);
  if (!session.task_path || !session.trace_path) return action;
  const taskFile = dataPath(dataRoot, session.task_path);
  const traceFile = dataPath(dataRoot, session.trace_path);
  const task = await readJson<JsonObject>(taskFile);
  const trace = await readJson<JsonObject>(traceFile);
  if (String(task.status ?? "") !== "started") {
    return { ...action, reason_code: "task_status_changed_before_repair" };
  }
  if (!hasGroundedTrace(trace)) {
    return { ...action, reason_code: "trace_not_grounded_enough_for_started_task_repair" };
  }
  const outcome = String(trace.outcome ?? "completed");
  await writeJson(taskFile, {
    ...task,
    status: outcomeToTaskStatus(outcome),
    updated_at: repairedAt,
    finished_at: String(trace.finished_at ?? repairedAt),
    trace_path: session.trace_path,
    lifecycle_settlement: {
      version: TASK_LIFECYCLE_SETTLEMENT_VERSION,
      reason_code: "started_task_repaired_from_grounded_trace",
      settled_at: repairedAt,
      trace_path: session.trace_path,
    },
  });
  return { ...action, applied: true, reason_code: "started_task_repaired_from_grounded_trace" };
}

async function applyBlockedMissingTrace(
  dataRoot: string,
  session: TaskLifecycleSession,
  repairedAt: string,
): Promise<TaskLifecycleSettlementAction> {
  const action = actionFor(session);
  if (!session.task_path) return action;
  const taskFile = dataPath(dataRoot, session.task_path);
  const task = await readJson<JsonObject>(taskFile);
  if (String(task.status ?? "") !== "blocked") {
    return { ...action, reason_code: "task_status_changed_before_repair" };
  }
  const tracePath = tracePathFor(session);
  const traceFile = dataPath(dataRoot, tracePath);
  const error = String(task.error ?? task.block_reason ?? "unknown_error").slice(0, 1000);
  await writeJson(traceFile, {
    task_id: session.task_id,
    outcome: "blocked",
    summary: "Reconstructed blocked trace for a task that failed before finish_task could write terminal evidence.",
    changed_files: [],
    decisions: ["The task record was already blocked before lifecycle repair.", `Blocked reason: ${String(task.block_reason ?? "unknown")}`],
    next_steps: ["Inspect the original task error before using this task as successful completion evidence."],
    used_memory_paths: [],
    context_pack_paths: [],
    search_queries: [],
    finished_at: repairedAt,
    reconstruction: {
      version: TASK_LIFECYCLE_SETTLEMENT_VERSION,
      reason_code: "blocked_task_missing_trace_reconstructed",
      previous_status: session.status,
      previous_updated_at: session.updated_at,
      error,
    },
  });
  await writeJson(taskFile, {
    ...task,
    updated_at: repairedAt,
    finished_at: repairedAt,
    trace_path: tracePath,
    lifecycle_settlement: {
      version: TASK_LIFECYCLE_SETTLEMENT_VERSION,
      reason_code: "blocked_task_missing_trace_reconstructed",
      settled_at: repairedAt,
      trace_path: tracePath,
    },
  });
  return { ...action, applied: true, reason_code: "blocked_task_missing_trace_reconstructed" };
}

async function applyBlockStaleWithoutTrace(
  dataRoot: string,
  session: TaskLifecycleSession,
  repairedAt: string,
): Promise<TaskLifecycleSettlementAction> {
  const action = actionFor(session);
  if (!session.task_path) return action;
  const taskFile = dataPath(dataRoot, session.task_path);
  const task = await readJson<JsonObject>(taskFile);
  if (String(task.status ?? "") !== "started") {
    return { ...action, reason_code: "task_status_changed_before_repair" };
  }
  const tracePath = tracePathFor(session);
  const traceFile = dataPath(dataRoot, tracePath);
  await writeJson(traceFile, {
    task_id: session.task_id,
    outcome: "blocked",
    summary:
      "Closed stale started task as abandoned because no terminal trace or grounded completion evidence was found.",
    changed_files: [],
    decisions: [
      "No existing trace was found for this stale task.",
      "Lifecycle settlement records this as blocked/abandoned, not as successful completion evidence.",
    ],
    next_steps: ["Re-run or reconstruct the original work if this task's result is still needed."],
    used_memory_paths: [],
    context_pack_paths: [],
    search_queries: [],
    finished_at: repairedAt,
    settlement: {
      version: TASK_LIFECYCLE_SETTLEMENT_VERSION,
      reason_code: "stale_task_without_trace_blocked",
      previous_status: session.status,
      previous_updated_at: session.updated_at,
    },
  });
  await writeJson(taskFile, {
    ...task,
    status: "blocked",
    updated_at: repairedAt,
    finished_at: repairedAt,
    trace_path: tracePath,
    lifecycle_settlement: {
      version: TASK_LIFECYCLE_SETTLEMENT_VERSION,
      reason_code: "stale_task_without_trace_blocked",
      settled_at: repairedAt,
      trace_path: tracePath,
    },
  });
  return { ...action, applied: true, reason_code: "stale_task_without_trace_blocked" };
}

async function applyAutoClose(
  dataRoot: string,
  session: TaskLifecycleSession,
  lifecycleBefore: TaskLifecycleReport,
  finishedAt: string,
): Promise<TaskLifecycleSettlementAction> {
  const action = actionFor(session);
  if (!session.task_path || !session.auto_close_safe) return action;
  const taskFile = dataPath(dataRoot, session.task_path);
  const task = await readJson<JsonObject>(taskFile);
  if (String(task.status ?? "") !== "started") {
    return {
      ...action,
      reason_code: "task_status_changed_before_settlement",
    };
  }
  const tracePath = tracePathFor(session);
  const traceFile = dataPath(dataRoot, tracePath);
  const trace = {
    task_id: session.task_id,
    outcome: "blocked",
    summary:
      "Auto-closed stale DinoBrain diagnostic task after lifecycle settlement. The task was a hook/env probe with no terminal trace and no current active owner.",
    changed_files: [],
    decisions: [
      "Classified as auto_close_candidate by task lifecycle report.",
      "Closed only because the request/project matched DinoBrain hook diagnostic or manual hook env test patterns.",
    ],
    next_steps: ["Manual repair is still required for non-diagnostic stale tasks."],
    used_memory_paths: [],
    context_pack_paths: [],
    search_queries: [],
    finished_at: finishedAt,
    settlement: {
      version: TASK_LIFECYCLE_SETTLEMENT_VERSION,
      reason_code: "stale_diagnostic_auto_closed",
      previous_status: session.status,
      previous_updated_at: session.updated_at,
      source_task_lifecycle_generated_at: lifecycleBefore.generated_at,
    },
  };
  await writeJson(traceFile, trace);
  await writeJson(taskFile, {
    ...task,
    status: "blocked",
    updated_at: finishedAt,
    finished_at: finishedAt,
    trace_path: tracePath,
    lifecycle_settlement: {
      version: TASK_LIFECYCLE_SETTLEMENT_VERSION,
      reason_code: "stale_diagnostic_auto_closed",
      settled_at: finishedAt,
      trace_path: tracePath,
    },
  });
  return {
    ...action,
    applied: true,
    reason_code: "stale_diagnostic_auto_closed",
  };
}

function visibleStatus(status: TaskLifecycleSettlementReport["status"], apply: boolean): string {
  if (status === "healthy") return apply ? "작업 세션 자동정리 적용 완료" : "작업 세션 자동정리 대상 없음";
  return apply ? "작업 세션 자동정리 후 수동 확인 필요" : "작업 세션 자동정리 적용 필요";
}

export function getTaskLifecycleSettlementPath(dataRoot: string): string {
  return dataPath(dataRoot, ...TASK_LIFECYCLE_SETTLEMENT_RELATIVE_PATH.split("/"));
}

export async function settleTaskLifecycle(
  dataRoot: string,
  options: SettlementOptions = {},
): Promise<{ report: TaskLifecycleSettlementReport; statusPath: string }> {
  const now = options.now ?? new Date();
  const generatedAt = nowIso(now);
  const apply = options.apply === true;
  const lifecycleBefore = await buildTaskLifecycleReport(dataRoot, {
    now,
    staleAfterMs: options.staleAfterMs,
  });
  const targetSessions = lifecycleBefore.sessions.filter((session) => session.auto_close_safe);
  const repairableManualSessions = lifecycleBefore.sessions.filter(isRepairableManualSession);
  const manualSessions = lifecycleBefore.sessions.filter(
    (session) => session.issue_codes.length > 0 && !session.auto_close_safe && !isRepairableManualSession(session),
  );
  const actions: TaskLifecycleSettlementAction[] = [];
  for (const session of targetSessions) {
    actions.push(apply ? await applyAutoClose(dataRoot, session, lifecycleBefore, generatedAt) : actionFor(session));
  }
  for (const session of repairableManualSessions) {
    if (!apply) {
      actions.push(actionFor(session));
    } else if (session.decision_class === "manual_stale_review_required" && session.trace_path) {
      actions.push(await applyStartedFromGroundedTrace(dataRoot, session, generatedAt));
    } else if (session.decision_class === "manual_trace_reconstruction_required" && session.status === "blocked") {
      actions.push(await applyBlockedMissingTrace(dataRoot, session, generatedAt));
    } else if (session.decision_class === "manual_stale_review_required" && !session.trace_path) {
      actions.push(await applyBlockStaleWithoutTrace(dataRoot, session, generatedAt));
    } else {
      actions.push(actionFor(session));
    }
  }
  for (const session of manualSessions) {
    actions.push(actionFor(session));
  }

  const lifecycleAfter = apply
    ? (
        await buildAndWriteTaskLifecycleReport(dataRoot, {
          now,
          staleAfterMs: options.staleAfterMs,
        })
      ).report
    : null;
  const autoCloseCandidatesAfter = lifecycleAfter?.counts.auto_close_candidates ?? null;
  const manualRepairAfter = lifecycleAfter?.counts.manual_repair_required ?? null;
  const finishGateRepairsAfter = lifecycleAfter
    ? lifecycleAfter.sessions.filter(isRepairableManualSession).length
    : null;
  const status =
    apply
      ? autoCloseCandidatesAfter === 0 && finishGateRepairsAfter === 0
        ? "healthy"
        : "needs_attention"
      : targetSessions.length === 0 && repairableManualSessions.length === 0
        ? "healthy"
        : "needs_attention";
  const report: TaskLifecycleSettlementReport = {
    version: TASK_LIFECYCLE_SETTLEMENT_VERSION,
    status,
    generated_at: generatedAt,
    data_root: path.resolve(dataRoot),
    apply,
    lifecycle_before: {
      generated_at: lifecycleBefore.generated_at,
      status: lifecycleBefore.status,
      counts: lifecycleBefore.counts,
      by_decision_class: lifecycleBefore.by_decision_class,
    },
    lifecycle_after: lifecycleAfter
      ? {
          generated_at: lifecycleAfter.generated_at,
          status: lifecycleAfter.status,
          counts: lifecycleAfter.counts,
          by_decision_class: lifecycleAfter.by_decision_class,
        }
      : null,
    counts: {
      auto_close_candidates_before: targetSessions.length,
      auto_close_applied: actions.filter((action) => action.applied && action.action === "auto_close_stale_diagnostic").length,
      auto_close_candidates_after: autoCloseCandidatesAfter,
      finish_gate_repairs_before: repairableManualSessions.length,
      finish_gate_repairs_applied: actions.filter(
        (action) =>
          action.applied &&
          [
            "repair_started_from_grounded_trace",
            "reconstruct_blocked_missing_trace",
            "block_stale_without_trace",
          ].includes(action.action),
      ).length,
      finish_gate_repairs_after: finishGateRepairsAfter,
      manual_repair_required_before: manualSessions.length,
      manual_repair_required_after: manualRepairAfter,
      skipped_manual_repair: actions.filter((action) => action.action === "skip_manual_repair").length,
    },
    actions,
    warnings: status === "healthy" ? [] : ["task_lifecycle_settlement_actions_remain"],
    visible_status: visibleStatus(status, apply),
  };
  const statusPath = getTaskLifecycleSettlementPath(dataRoot);
  await writeJson(statusPath, report);
  return { report, statusPath };
}
