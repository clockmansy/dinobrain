import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import { atomicWriteJson, atomicWriteText } from "./concurrency.js";
import { dataPath, relDataPath } from "./context.js";

export const TASK_LIFECYCLE_VERSION = "task_lifecycle_v1";
export const TASK_LIFECYCLE_STATUS_RELATIVE_PATH = ".dino/state/task_sessions.json";
export const TASK_FINISH_GROUNDING_RELATIVE_PATH = ".dino/state/task_finish_grounding_classifications.jsonl";

type JsonObject = Record<string, unknown>;

export type LifecycleState = "active" | "stale_active" | "terminal" | "terminal_missing_trace" | "trace_without_task";
export type LifecycleDecisionClass =
  | "no_action_required"
  | "recent_active"
  | "auto_close_candidate"
  | "manual_stale_review_required"
  | "manual_trace_reconstruction_required"
  | "manual_trace_binding_repair_required"
  | "manual_orphan_trace_archive_required"
  | "finish_grounding_repair_required";
export type FinishGroundingClassification =
  | "grounded"
  | "partial_grounded"
  | "ungrounded"
  | "blocked_grounded"
  | "missing_trace"
  | "active";

export type TaskLifecycleSession = {
  session_id: string;
  task_id: string;
  task_path: string | null;
  trace_path: string | null;
  status: string;
  lifecycle_state: LifecycleState;
  terminal_state: string | null;
  prompt_hash: string | null;
  created_at: string | null;
  updated_at: string | null;
  finished_at: string | null;
  stale_age_ms: number | null;
  grounding_classification: FinishGroundingClassification;
  required_reads_satisfied: boolean | null;
  used_memory_count: number;
  context_pack_count: number;
  evidence_path_count: number;
  issue_codes: string[];
  decision_class: LifecycleDecisionClass;
  auto_close_safe: boolean;
  owner: string;
  next_action: string;
};

export type FinishGroundingRecord = {
  task_id: string;
  trace_path: string | null;
  classification: FinishGroundingClassification;
  outcome: string | null;
  summary_present: boolean;
  evidence_path_count: number;
  used_memory_count: number;
  context_pack_count: number;
  issue_codes: string[];
};

export type TaskLifecycleReport = {
  version: typeof TASK_LIFECYCLE_VERSION;
  status: "healthy" | "needs_attention";
  generated_at: string;
  data_root: string;
  stale_after_ms: number;
  counts: {
    tasks: number;
    traces: number;
    active: number;
    stale_active: number;
    terminal: number;
    terminal_missing_trace: number;
    trace_without_task: number;
    ungrounded_finish: number;
    partial_grounded_finish: number;
    wrong_task_mismatch: number;
    blockers: number;
    auto_close_candidates: number;
    manual_repair_required: number;
  };
  by_decision_class: Record<LifecycleDecisionClass, number>;
  sessions: TaskLifecycleSession[];
  grounding_records: FinishGroundingRecord[];
  warnings: string[];
  visible_status: string;
};

type BuildOptions = {
  now?: Date;
  staleAfterMs?: number;
};

function nowIso(date: Date): string {
  return date.toISOString();
}

function firstString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String).map((item) => item.trim()).filter(Boolean) : [];
}

function sha256Short(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function isTerminalStatus(status: string): boolean {
  return ["completed", "partial", "blocked"].includes(status.toLowerCase());
}

function parseTime(value: string | null): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

async function readJson<T>(filePath: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function readJsonDir(dataRoot: string, relativeDir: string): Promise<Array<{ path: string; record: JsonObject }>> {
  const dir = dataPath(dataRoot, relativeDir);
  let entries: Array<import("node:fs").Dirent>;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const records: Array<{ path: string; record: JsonObject }> = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const fullPath = path.join(dir, entry.name);
    const record = await readJson<JsonObject>(fullPath);
    if (record) records.push({ path: relDataPath(dataRoot, fullPath), record });
  }
  return records.sort((a, b) => a.path.localeCompare(b.path));
}

async function exists(dataRoot: string, vaultPath: string | null): Promise<boolean> {
  if (!vaultPath) return false;
  try {
    const stat = await fs.stat(dataPath(dataRoot, vaultPath));
    return stat.isFile();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await atomicWriteJson(filePath, value);
}

function taskIdFromPath(vaultPath: string): string {
  return path.basename(vaultPath.replace(/\\/g, "/"), ".json");
}

function evidencePaths(trace: JsonObject | null): string[] {
  if (!trace) return [];
  return [
    ...stringArray(trace.changed_files),
    ...stringArray(trace.used_memory_paths),
    ...stringArray(trace.context_pack_paths),
    ...stringArray(trace.session_archive_paths),
    ...stringArray(trace.candidate_paths),
  ];
}

function classifyGrounding(trace: JsonObject | null): FinishGroundingClassification {
  if (!trace) return "missing_trace";
  const outcome = firstString(trace.outcome).toLowerCase();
  const summary = firstString(trace.summary);
  const hasEvidence =
    evidencePaths(trace).length > 0 ||
    stringArray(trace.decisions).length > 0 ||
    stringArray(trace.next_steps).length > 0 ||
    stringArray(trace.search_queries).length > 0;
  if (outcome === "blocked" && summary) return "blocked_grounded";
  if (summary && hasEvidence) return "grounded";
  if (summary) return "partial_grounded";
  return "ungrounded";
}

function nextActionFor(issueCodes: string[], lifecycleState: LifecycleState): string {
  if (issueCodes.includes("trace_task_id_mismatch")) return "Repair or quarantine the trace whose task_id does not match its task record.";
  if (issueCodes.includes("terminal_task_missing_trace")) return "Reconstruct or mark the terminal task trace before using it as finish evidence.";
  if (issueCodes.includes("trace_without_task")) return "Link the trace to a task record or archive it as orphaned operational history.";
  if (issueCodes.includes("stale_active_task")) return "Auto-close with an explicit reason or finish the task with grounded terminal evidence.";
  if (issueCodes.includes("ungrounded_finish")) return "Add summary and evidence paths or reclassify the finish as partial/blocked.";
  if (issueCodes.includes("partial_grounding")) return "Add context, memory, artifact, decision, or next-step evidence before claiming strong completion.";
  if (lifecycleState === "active") return "Keep visible as active until finish_task writes a terminal trace.";
  return "No action required.";
}

function looksLikeDiagnosticProbe(task: JsonObject): boolean {
  const request = firstString(task.request).toLowerCase();
  const project = firstString(task.project).toLowerCase();
  return (
    request.includes("dinobrain live codex hook diagnostic probe") ||
    request.includes("manual hook env test") ||
    project.includes("hook-diagnose")
  );
}

function decisionClassFor(task: JsonObject | null, issueCodes: string[], lifecycleState: LifecycleState): LifecycleDecisionClass {
  if (issueCodes.includes("trace_task_id_mismatch")) return "manual_trace_binding_repair_required";
  if (issueCodes.includes("terminal_task_missing_trace")) return "manual_trace_reconstruction_required";
  if (issueCodes.includes("trace_without_task")) return "manual_orphan_trace_archive_required";
  if (issueCodes.includes("ungrounded_finish") || issueCodes.includes("partial_grounding")) {
    return "finish_grounding_repair_required";
  }
  if (issueCodes.includes("stale_active_task")) {
    return task && looksLikeDiagnosticProbe(task) ? "auto_close_candidate" : "manual_stale_review_required";
  }
  if (lifecycleState === "active") return "recent_active";
  return "no_action_required";
}

function isManualRepairDecision(decisionClass: LifecycleDecisionClass): boolean {
  return [
    "manual_stale_review_required",
    "manual_trace_reconstruction_required",
    "manual_trace_binding_repair_required",
    "manual_orphan_trace_archive_required",
    "finish_grounding_repair_required",
  ].includes(decisionClass);
}

function visibleStatus(status: TaskLifecycleReport["status"]): string {
  return status === "healthy" ? "작업 세션/완료 게이트 정상" : "작업 세션/완료 게이트 확인 필요";
}

export function getTaskLifecycleStatusPath(dataRoot: string): string {
  return dataPath(dataRoot, ...TASK_LIFECYCLE_STATUS_RELATIVE_PATH.split("/"));
}

export function getTaskFinishGroundingPath(dataRoot: string): string {
  return dataPath(dataRoot, ...TASK_FINISH_GROUNDING_RELATIVE_PATH.split("/"));
}

export async function buildTaskLifecycleReport(dataRoot: string, options: BuildOptions = {}): Promise<TaskLifecycleReport> {
  const now = options.now ?? new Date();
  const generatedAt = nowIso(now);
  const staleAfterMs = options.staleAfterMs ?? 24 * 60 * 60 * 1000;
  const [tasks, traces] = await Promise.all([readJsonDir(dataRoot, ".dino/tasks"), readJsonDir(dataRoot, ".dino/traces")]);
  const traceByTaskId = new Map(traces.map((entry) => [firstString(entry.record.task_id, taskIdFromPath(entry.path)), entry]));
  const taskIds = new Set(tasks.map((entry) => firstString(entry.record.task_id, taskIdFromPath(entry.path))));
  const sessions: TaskLifecycleSession[] = [];

  for (const task of tasks) {
    const taskId = firstString(task.record.task_id, taskIdFromPath(task.path));
    const status = firstString(task.record.status, "unknown");
    const tracePath = firstString(task.record.trace_path);
    const traceEntry = tracePath ? traces.find((entry) => entry.path === tracePath) ?? null : traceByTaskId.get(taskId) ?? null;
    const trace = traceEntry?.record ?? null;
    const createdAt = firstString(task.record.created_at) || null;
    const updatedAt = firstString(task.record.updated_at, task.record.finished_at, task.record.created_at) || null;
    const finishedAt = firstString(task.record.finished_at, trace?.finished_at) || null;
    const updatedMs = parseTime(updatedAt);
    const staleAgeMs = status === "started" && updatedMs !== null ? now.getTime() - updatedMs : null;
    const isStale = status === "started" && staleAgeMs !== null && staleAgeMs > staleAfterMs;
    const traceExists = await exists(dataRoot, tracePath || traceEntry?.path || null);
    const issueCodes: string[] = [];
    let lifecycleState: LifecycleState = isStale ? "stale_active" : status === "started" ? "active" : "terminal";
    if (isStale) issueCodes.push("stale_active_task");
    if (isTerminalStatus(status) && (!tracePath || !traceExists)) {
      lifecycleState = "terminal_missing_trace";
      issueCodes.push("terminal_task_missing_trace");
    }
    if (trace && firstString(trace.task_id, taskId) !== taskId) issueCodes.push("trace_task_id_mismatch");
    const grounding = status === "started" ? "active" : classifyGrounding(trace);
    if (grounding === "ungrounded") issueCodes.push("ungrounded_finish");
    if (grounding === "partial_grounded") issueCodes.push("partial_grounding");
    const paths = evidencePaths(trace);
    const contextPackCount = trace ? stringArray(trace.context_pack_paths).length : 0;
    const usedMemoryCount = trace ? stringArray(trace.used_memory_paths).length : 0;
    const decisionClass = decisionClassFor(task.record, issueCodes, lifecycleState);
    sessions.push({
      session_id: taskId,
      task_id: taskId,
      task_path: task.path,
      trace_path: tracePath || traceEntry?.path || null,
      status,
      lifecycle_state: lifecycleState,
      terminal_state: isTerminalStatus(status) ? status : null,
      prompt_hash: firstString(task.record.prompt_hash) || (firstString(task.record.request) ? sha256Short(firstString(task.record.request)) : null),
      created_at: createdAt,
      updated_at: updatedAt,
      finished_at: finishedAt,
      stale_age_ms: staleAgeMs,
      grounding_classification: grounding,
      required_reads_satisfied: contextPackCount > 0 ? true : null,
      used_memory_count: usedMemoryCount,
      context_pack_count: contextPackCount,
      evidence_path_count: paths.length,
      issue_codes: issueCodes,
      decision_class: decisionClass,
      auto_close_safe: decisionClass === "auto_close_candidate",
      owner: issueCodes.length > 0 ? "task-lifecycle-reviewer" : "none",
      next_action: nextActionFor(issueCodes, lifecycleState),
    });
  }

  for (const trace of traces) {
    const taskId = firstString(trace.record.task_id, taskIdFromPath(trace.path));
    if (taskIds.has(taskId)) continue;
    const grounding = classifyGrounding(trace.record);
    const issueCodes = ["trace_without_task"];
    const decisionClass = decisionClassFor(null, issueCodes, "trace_without_task");
    sessions.push({
      session_id: taskId,
      task_id: taskId,
      task_path: null,
      trace_path: trace.path,
      status: "orphan_trace",
      lifecycle_state: "trace_without_task",
      terminal_state: firstString(trace.record.outcome) || null,
      prompt_hash: null,
      created_at: null,
      updated_at: firstString(trace.record.finished_at) || null,
      finished_at: firstString(trace.record.finished_at) || null,
      stale_age_ms: null,
      grounding_classification: grounding,
      required_reads_satisfied: stringArray(trace.record.context_pack_paths).length > 0 ? true : null,
      used_memory_count: stringArray(trace.record.used_memory_paths).length,
      context_pack_count: stringArray(trace.record.context_pack_paths).length,
      evidence_path_count: evidencePaths(trace.record).length,
      issue_codes: issueCodes,
      decision_class: decisionClass,
      auto_close_safe: false,
      owner: "task-lifecycle-reviewer",
      next_action: nextActionFor(issueCodes, "trace_without_task"),
    });
  }

  const groundingRecords: FinishGroundingRecord[] = sessions
    .filter((session) => session.lifecycle_state !== "active" && session.lifecycle_state !== "stale_active")
    .map((session) => ({
      task_id: session.task_id,
      trace_path: session.trace_path,
      classification: session.grounding_classification,
      outcome: session.terminal_state,
      summary_present: !session.issue_codes.includes("ungrounded_finish"),
      evidence_path_count: session.evidence_path_count,
      used_memory_count: session.used_memory_count,
      context_pack_count: session.context_pack_count,
      issue_codes: session.issue_codes,
    }));
  const blockerSessions = sessions.filter((session) =>
    session.issue_codes.some((issue) =>
      ["stale_active_task", "terminal_task_missing_trace", "trace_task_id_mismatch", "trace_without_task", "ungrounded_finish"].includes(issue),
    ),
  );
  const status = blockerSessions.length > 0 ? "needs_attention" : "healthy";
  const decisionClasses: LifecycleDecisionClass[] = [
    "no_action_required",
    "recent_active",
    "auto_close_candidate",
    "manual_stale_review_required",
    "manual_trace_reconstruction_required",
    "manual_trace_binding_repair_required",
    "manual_orphan_trace_archive_required",
    "finish_grounding_repair_required",
  ];
  const byDecisionClass = Object.fromEntries(
    decisionClasses.map((decisionClass) => [
      decisionClass,
      sessions.filter((session) => session.decision_class === decisionClass).length,
    ]),
  ) as Record<LifecycleDecisionClass, number>;
  return {
    version: TASK_LIFECYCLE_VERSION,
    status,
    generated_at: generatedAt,
    data_root: path.resolve(dataRoot),
    stale_after_ms: staleAfterMs,
    counts: {
      tasks: tasks.length,
      traces: traces.length,
      active: sessions.filter((session) => session.lifecycle_state === "active").length,
      stale_active: sessions.filter((session) => session.lifecycle_state === "stale_active").length,
      terminal: sessions.filter((session) => session.lifecycle_state === "terminal").length,
      terminal_missing_trace: sessions.filter((session) => session.lifecycle_state === "terminal_missing_trace").length,
      trace_without_task: sessions.filter((session) => session.lifecycle_state === "trace_without_task").length,
      ungrounded_finish: sessions.filter((session) => session.grounding_classification === "ungrounded").length,
      partial_grounded_finish: sessions.filter((session) => session.grounding_classification === "partial_grounded").length,
      wrong_task_mismatch: sessions.filter((session) => session.issue_codes.includes("trace_task_id_mismatch")).length,
      blockers: blockerSessions.length,
      auto_close_candidates: byDecisionClass.auto_close_candidate,
      manual_repair_required: sessions.filter((session) => isManualRepairDecision(session.decision_class)).length,
    },
    by_decision_class: byDecisionClass,
    sessions: sessions.sort((a, b) => (b.updated_at ?? "").localeCompare(a.updated_at ?? "") || a.task_id.localeCompare(b.task_id)),
    grounding_records: groundingRecords,
    warnings: status === "healthy" ? [] : ["task_lifecycle_finish_gate_attention_required"],
    visible_status: visibleStatus(status),
  };
}

export async function buildAndWriteTaskLifecycleReport(
  dataRoot: string,
  options: BuildOptions = {},
): Promise<{ report: TaskLifecycleReport; statusPath: string; groundingPath: string }> {
  const report = await buildTaskLifecycleReport(dataRoot, options);
  const statusPath = getTaskLifecycleStatusPath(dataRoot);
  const groundingPath = getTaskFinishGroundingPath(dataRoot);
  await writeJson(statusPath, report);
  await atomicWriteText(
    groundingPath,
    `${report.grounding_records.map((record) => JSON.stringify(record)).join("\n")}\n`,
    async (candidatePath) => {
      for (const line of (await fs.readFile(candidatePath, "utf8")).split(/\r?\n/).filter(Boolean)) JSON.parse(line);
    },
  );
  return { report, statusPath, groundingPath };
}
