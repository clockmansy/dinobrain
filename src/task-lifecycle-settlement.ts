import { promises as fs } from "node:fs";
import path from "node:path";

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
  action: "auto_close_stale_diagnostic" | "skip_manual_repair" | "skip_recent_active";
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
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function tracePathFor(session: TaskLifecycleSession): string {
  return session.trace_path ?? `.dino/traces/${session.task_id}.json`;
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
  const manualSessions = lifecycleBefore.sessions.filter(
    (session) => session.issue_codes.length > 0 && !session.auto_close_safe,
  );
  const actions: TaskLifecycleSettlementAction[] = [];
  for (const session of targetSessions) {
    actions.push(apply ? await applyAutoClose(dataRoot, session, lifecycleBefore, generatedAt) : actionFor(session));
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
  const status =
    (apply ? autoCloseCandidatesAfter === 0 : targetSessions.length === 0) ? "healthy" : "needs_attention";
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
      auto_close_applied: actions.filter((action) => action.applied).length,
      auto_close_candidates_after: autoCloseCandidatesAfter,
      manual_repair_required_before: manualSessions.length,
      manual_repair_required_after: manualRepairAfter,
      skipped_manual_repair: actions.filter((action) => action.action === "skip_manual_repair").length,
    },
    actions,
    warnings: status === "healthy" ? [] : ["task_lifecycle_auto_close_candidates_remain"],
    visible_status: visibleStatus(status, apply),
  };
  const statusPath = getTaskLifecycleSettlementPath(dataRoot);
  await writeJson(statusPath, report);
  return { report, statusPath };
}
