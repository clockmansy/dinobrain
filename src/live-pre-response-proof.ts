import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import { canonicalJson, sha256Text, type ClientMcpAgent } from "./client-mcp-proof.js";

export type LivePreResponseProof = {
  agent: ClientMcpAgent;
  launch_kind: "codex_desktop" | "claude_code";
  status: "verified";
  challenge_id_sha256: string;
  submitted_at: string;
  completed_at: string;
  task_id_sha256: string;
  context_item_count: number;
  memory_path_count: number;
  context_trace_sha256: string;
  submitted_event_sha256: string;
  completed_event_sha256: string;
  report_sha256: string;
  event_order: string[];
};

export type LivePreResponseProofResult =
  | { ok: true; proof: LivePreResponseProof }
  | { ok: false; reason_codes: string[] };

type JsonObject = Record<string, unknown>;
type LoadedEvent = JsonObject & { _source_path: string };
type LoadedReport = JsonObject & { _source_path: string; _raw_sha256: string };

function asObject(value: unknown): JsonObject | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : null;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asBoolean(value: unknown): boolean {
  return value === true;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0) : [];
}

function asFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function launchKind(agent: ClientMcpAgent): LivePreResponseProof["launch_kind"] {
  return agent === "codex" ? "codex_desktop" : "claude_code";
}

function recordLaunchKind(record: JsonObject): string {
  return asString(asObject(record.launch_provenance)?.launch_kind);
}

function isoMillis(value: unknown): number | null {
  const parsed = Date.parse(asString(value));
  return Number.isFinite(parsed) ? parsed : null;
}

function sha256Bytes(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function eventHash(value: LoadedEvent): string {
  const { _source_path: _ignored, ...event } = value;
  return sha256Text(canonicalJson(event));
}

async function filesUnder(root: string, suffix: string): Promise<string[]> {
  const output: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    let entries: Array<import("node:fs").Dirent>;
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(fullPath);
      else if (entry.isFile() && entry.name.endsWith(suffix)) output.push(fullPath);
    }
  };
  await visit(root);
  return output.sort();
}

async function loadEvents(dataRoot: string, sinceMs: number): Promise<LoadedEvent[]> {
  const events: LoadedEvent[] = [];
  for (const filePath of await filesUnder(path.join(dataRoot, ".dino", "events"), ".jsonl")) {
    const text = await fs.readFile(filePath, "utf8");
    for (const line of text.split(/\r?\n/).filter(Boolean)) {
      try {
        const parsed = asObject(JSON.parse(line));
        const at = isoMillis(parsed?.at);
        if (parsed && at !== null && at >= sinceMs) events.push({ ...parsed, _source_path: filePath });
      } catch {
        // An unrelated malformed historical row does not replace a complete proof.
      }
    }
  }
  return events.sort((left, right) => asString(left.at).localeCompare(asString(right.at)));
}

async function loadReports(appRoot: string, sinceMs: number): Promise<LoadedReport[]> {
  const reports: LoadedReport[] = [];
  const configured = process.env.DINOBRAIN_HOOK_REPORT_DIR?.trim();
  const reportRoot = path.resolve(configured || path.join(appRoot, "reports", "live-hooks"));
  for (const filePath of await filesUnder(reportRoot, ".json")) {
    try {
      const raw = await fs.readFile(filePath);
      const parsed = asObject(JSON.parse(raw.toString("utf8")));
      const at = isoMillis(parsed?.at);
      if (parsed && at !== null && at >= sinceMs) {
        reports.push({ ...parsed, _source_path: filePath, _raw_sha256: sha256Bytes(raw) });
      }
    } catch {
      // Ignore unrelated invalid report files and require a complete matching report below.
    }
  }
  return reports.sort((left, right) => asString(left.at).localeCompare(asString(right.at)));
}

function resolveInside(root: string, relativePath: string): string | null {
  if (!relativePath || path.isAbsolute(relativePath)) return null;
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, ...relativePath.replace(/\\/g, "/").split("/"));
  const relative = path.relative(resolvedRoot, resolved);
  if (!relative || relative === "." || relative.startsWith("..") || path.isAbsolute(relative)) return null;
  return resolved;
}

function orderedDelivery(
  events: LoadedEvent[],
  submitted: LoadedEvent,
  completed: LoadedEvent,
  report: LoadedReport,
): { ok: boolean; reasons: string[]; event_order: string[] } {
  const reasons: string[] = [];
  const taskId = asString(completed.task_id) || asString(report.task_id);
  const hookRunId = asString(submitted.hook_run_id);
  const promptHash = asString(submitted.prompt_hash);
  const predicates: Array<(event: LoadedEvent) => boolean> = [
    (event) => event === submitted,
    (event) => event.event === "task_started" && event.task_id === taskId && event.hook_run_id === hookRunId,
    (event) => event.event === "context_pack_created" && event.task_id === taskId && event.hook_run_id === hookRunId,
    (event) => event.event === "os_begin_task_completed" && event.task_id === taskId && event.hook_run_id === hookRunId,
    (event) => event === completed,
  ];
  const indexes = predicates.map((predicate) => events.findIndex(predicate));
  if (!indexes.every((index) => index >= 0)) reasons.push("ordered_preflight_event_missing");
  if (!indexes.every((index, position) => position === 0 || index > indexes[position - 1]!)) {
    reasons.push("preflight_event_order_invalid");
  }
  if (!asBoolean(completed.preflight_event_order_verified) || !asBoolean(report.preflight_event_order_verified)) {
    reasons.push("preflight_event_order_not_verified");
  }
  if (completed.context_delivery_status !== "ready_for_model" || report.context_delivery_status !== "ready_for_model") {
    reasons.push("model_context_delivery_not_ready");
  }
  if (!completed.context_delivery_nonce || completed.context_delivery_nonce !== report.context_delivery_nonce) {
    reasons.push("context_delivery_nonce_mismatch");
  }
  if (!completed.context_delivery_sha256 || completed.context_delivery_sha256 !== report.context_delivery_sha256) {
    reasons.push("context_delivery_hash_mismatch");
  }
  if (!asBoolean(report.context_trace_verified) || !asBoolean(report.context_trace_fresh)) {
    reasons.push("context_trace_not_verified_fresh");
  }
  if (completed.action_decision === "block" || report.action_decision === "block" || asBoolean(completed.fail_closed)) {
    reasons.push("live_preflight_action_blocked");
  }
  if (completed.prompt_hash !== promptHash || report.prompt_hash !== promptHash) reasons.push("live_prompt_hash_mismatch");
  return {
    ok: reasons.length === 0,
    reasons,
    event_order: [
      "codex_prompt_submitted",
      "task_started",
      "context_pack_created",
      "os_begin_task_completed",
      "codex_preflight_completed",
    ],
  };
}

export async function findClientLivePreResponseProof(options: {
  appRoot: string;
  dataRoot: string;
  agent: ClientMcpAgent;
  since: string;
  challengeId: string;
}): Promise<LivePreResponseProofResult> {
  const appRoot = path.resolve(options.appRoot);
  const dataRoot = path.resolve(options.dataRoot);
  const sinceMs = Date.parse(options.since);
  if (!Number.isFinite(sinceMs)) return { ok: false, reason_codes: ["live_proof_since_invalid"] };
  if (!options.challengeId.trim()) return { ok: false, reason_codes: ["live_proof_challenge_missing"] };

  const expectedLaunch = launchKind(options.agent);
  const [events, reports] = await Promise.all([loadEvents(dataRoot, sinceMs), loadReports(appRoot, sinceMs)]);
  const submittedEvents = events
    .filter(
      (event) =>
        event.event === "codex_prompt_submitted" &&
        event.source === "codex_hook" &&
        recordLaunchKind(event) === expectedLaunch &&
        asString(event.prompt_preview).toLowerCase().includes(options.challengeId.toLowerCase()),
    )
    .sort((left, right) => asString(right.at).localeCompare(asString(left.at)));

  const attemptedReasons = new Set<string>();
  for (const submitted of submittedEvents) {
    const completed = events.find(
      (event) =>
        event.event === "codex_preflight_completed" &&
        event.source === "codex_hook" &&
        event.hook_run_id === submitted.hook_run_id &&
        event.prompt_hash === submitted.prompt_hash &&
        recordLaunchKind(event) === expectedLaunch &&
        asString(event.at) >= asString(submitted.at),
    );
    if (!completed) {
      attemptedReasons.add("matching_preflight_completed_event_missing");
      continue;
    }
    const report = reports.find(
      (candidate) =>
        candidate.event === "codex_preflight_completed" &&
        candidate.hook_run_id === completed.hook_run_id &&
        candidate.prompt_hash === completed.prompt_hash &&
        recordLaunchKind(candidate) === expectedLaunch &&
        asString(candidate.at) >= asString(submitted.at),
    );
    if (!report) {
      attemptedReasons.add("matching_live_hook_report_missing");
      continue;
    }
    if (asString(report.data_root) && path.resolve(asString(report.data_root)) !== dataRoot) {
      attemptedReasons.add("live_report_data_root_mismatch");
      continue;
    }
    const contextPaths = asStringArray(report.context_paths);
    const contextItemCount = asFiniteNumber(report.context_item_count) ?? 0;
    if (contextPaths.length === 0 || contextItemCount <= 0) {
      attemptedReasons.add("live_context_empty");
      continue;
    }
    const delivery = orderedDelivery(events, submitted, completed, report);
    for (const reason of delivery.reasons) attemptedReasons.add(reason);
    if (!delivery.ok) continue;

    const traceRelativePath = asString(report.context_pack_trace);
    const tracePath = resolveInside(dataRoot, traceRelativePath);
    if (!tracePath) {
      attemptedReasons.add("context_trace_path_invalid");
      continue;
    }
    let traceSha256 = "";
    try {
      traceSha256 = sha256Bytes(await fs.readFile(tracePath));
    } catch {
      attemptedReasons.add("context_trace_missing");
      continue;
    }
    if (traceSha256 !== completed.context_trace_sha256 || traceSha256 !== report.context_trace_sha256) {
      attemptedReasons.add("context_trace_hash_mismatch");
      continue;
    }
    const submittedAt = asString(submitted.at);
    const completedAt = asString(completed.at);
    if ((isoMillis(submittedAt) ?? 0) < sinceMs || (isoMillis(completedAt) ?? 0) < sinceMs) {
      attemptedReasons.add("live_proof_outside_run_window");
      continue;
    }
    const taskId = asString(completed.task_id) || asString(report.task_id);
    if (!taskId) {
      attemptedReasons.add("live_task_binding_missing");
      continue;
    }
    return {
      ok: true,
      proof: {
        agent: options.agent,
        launch_kind: expectedLaunch,
        status: "verified",
        challenge_id_sha256: sha256Text(options.challengeId),
        submitted_at: submittedAt,
        completed_at: completedAt,
        task_id_sha256: sha256Text(taskId),
        context_item_count: contextItemCount,
        memory_path_count: contextPaths.length,
        context_trace_sha256: traceSha256,
        submitted_event_sha256: eventHash(submitted),
        completed_event_sha256: eventHash(completed),
        report_sha256: report._raw_sha256,
        event_order: delivery.event_order,
      },
    };
  }

  return {
    ok: false,
    reason_codes: submittedEvents.length === 0
      ? [`${options.agent}_live_prompt_not_observed`]
      : [...attemptedReasons].sort(),
  };
}
