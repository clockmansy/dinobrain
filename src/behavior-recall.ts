import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import { appendFileWithLock, atomicWriteJson } from "./concurrency.js";
import {
  loadAppliedBehaviorRecallRepairs,
  validateBehaviorRecallEvidenceRepair,
} from "./behavior-recall-migration.js";
import { dataPath, relDataPath } from "./context.js";
import { FULL_MEMORY_STATE_DIR } from "./full-memory-audit.js";

export const BEHAVIOR_RECALL_VERSION = "behavior_recall_v1";
export const BEHAVIOR_RECALL_LEDGER_RELATIVE_PATH = `${FULL_MEMORY_STATE_DIR}/behavior_recall_audit.jsonl`;
export const BEHAVIOR_RECALL_STATUS_RELATIVE_PATH = `${FULL_MEMORY_STATE_DIR}/behavior_recall_status.json`;

export type BehaviorRecallTrigger = "completion" | "handoff" | "error" | "direction_change" | "correction";
export type BehaviorRecallDecisionStatus = "performed" | "skipped" | "not_applicable";
export type BehaviorRecallStatus = "healthy" | "needs_attention";

export type BehaviorRecallEntry = {
  version: typeof BEHAVIOR_RECALL_VERSION;
  recall_id: string;
  trigger_type: BehaviorRecallTrigger;
  task_id: string | null;
  recalled_memory_paths: string[];
  decision_status: BehaviorRecallDecisionStatus;
  reason: string;
  evidence_path: string;
  conflicting_memory_paths: string[];
  conflict_resolution?: "hold_superseded" | "demote_superseded" | "no_conflict" | null;
  followup_action: string;
  created_at: string;
};

export type BehaviorRecallFinding = {
  signal:
    | "ledger_missing"
    | "ledger_entry_malformed"
    | "evidence_path_missing"
    | "evidence_migration_invalid"
    | "correction_conflict_not_quarantined"
    | "correction_missing_recall_entry";
  severity: "fail" | "warn";
  path: string;
  reason: string;
};

export type BehaviorRecallReport = {
  version: typeof BEHAVIOR_RECALL_VERSION;
  status: BehaviorRecallStatus;
  generated_at: string;
  latest_verified_at: string | null;
  data_root: string;
  ledger_path: string;
  counts: {
    entries: number;
    malformed_entries: number;
    completion: number;
    handoff: number;
    error: number;
    direction_change: number;
    correction: number;
    performed: number;
    skipped: number;
    not_applicable: number;
    correction_conflicts: number;
    correction_records: number;
    correction_records_without_recall: number;
    evidence_migrations_applied: number;
    evidence_migrations_invalid: number;
    blockers: number;
  };
  latest_entries: BehaviorRecallEntry[];
  findings: BehaviorRecallFinding[];
  warnings: string[];
  visible_status: string;
};

type JsonObject = Record<string, unknown>;

type FinishRecallInput = {
  taskId: string;
  outcome: "completed" | "partial" | "blocked";
  summary: string;
  decisions: string[];
  nextSteps: string[];
  usedMemoryPaths: string[];
  contextPackPaths: string[];
  tracePath: string;
  finishedAt: string;
};

type FeedbackRecallInput = {
  feedbackId: string;
  correction: string;
  appliesTo: string;
  taskId?: string | null;
  acceptedPath: string;
  createdAt: string;
  conflictingMemoryPaths?: string[];
  conflictResolution?: "hold_superseded" | "demote_superseded" | "no_conflict" | null;
};

function nowIso(date: Date): string {
  return date.toISOString();
}

function hashShort(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
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

function unique(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)));
}

function normalizeVaultPath(value: string): string {
  return value.trim().replace(/\\/g, "/").replace(/^\/+/, "");
}

function normalizeVaultPaths(values: string[]): string[] {
  return unique(values.map(normalizeVaultPath));
}

async function readJson<T>(filePath: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await atomicWriteJson(filePath, value);
}

async function appendJsonLine(filePath: string, value: unknown): Promise<void> {
  await appendFileWithLock(filePath, `${JSON.stringify(value)}\n`);
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

function textOf(record: JsonObject): string {
  return [
    record.title,
    record.claim,
    record.behavior_rule,
    record.reusable_rule,
    record.summary,
    record.applies_to,
    stringArray(record.tags).join(" "),
  ]
    .map((value) => String(value ?? ""))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokens(value: string): Set<string> {
  return new Set(
    value
      .toLowerCase()
      .split(/[^\p{L}\p{N}_-]+/u)
      .map((term) => term.trim())
      .filter((term) => term.length >= 3),
  );
}

function overlapCount(left: string, right: string): number {
  const leftTerms = tokens(left);
  const rightTerms = tokens(right);
  let count = 0;
  for (const term of leftTerms) {
    if (rightTerms.has(term)) count += 1;
  }
  return count;
}

function hasCorrectionConflictCue(value: string): boolean {
  return /\b(do\s+not|don't|never|instead|wrong|not\s+what|avoid|rather\s+than)\b|아니야|하지\s*말|원한\s*건|대신|교정|정정/i.test(
    value,
  );
}

function isBehaviorRecord(pathValue: string, record: JsonObject): boolean {
  const tags = stringArray(record.tags).map((tag) => tag.toLowerCase());
  const type = firstString(record.type).toLowerCase();
  const status = firstString(record.status).toLowerCase().replace(/_/g, "-");
  const lifecycleState = firstString(record.lifecycle_state).toLowerCase().replace(/_/g, "-");
  const excludedStates = ["hold", "held", "quarantined", "archived", "archived-merged", "archived-rejected", "demoted"];
  return (
    pathValue.startsWith("50_Instances/accepted/") &&
    !excludedStates.includes(status) &&
    !excludedStates.includes(lifecycleState) &&
    (type.includes("feedback") ||
      type.includes("behavior") ||
      tags.some((tag) => ["behavior", "correction", "operating-rule", "user-preference", "memory-priority"].includes(tag)) ||
      Boolean(firstString(record.behavior_rule, record.reusable_rule)))
  );
}

export async function findPotentialBehaviorConflicts(
  dataRoot: string,
  correction: string,
  acceptedPath: string,
  appliesTo: string,
): Promise<string[]> {
  if (!hasCorrectionConflictCue(correction)) return [];
  const accepted = await readJsonDir(dataRoot, "50_Instances/accepted");
  const conflicts: string[] = [];
  for (const entry of accepted) {
    if (entry.path === acceptedPath) continue;
    if (!isBehaviorRecord(entry.path, entry.record)) continue;
    const recordAppliesTo = firstString(entry.record.applies_to);
    const sameDomain = !recordAppliesTo || !appliesTo || recordAppliesTo === appliesTo;
    if (!sameDomain) continue;
    if (overlapCount(correction, textOf(entry.record)) >= 2) conflicts.push(entry.path);
  }
  return conflicts.slice(0, 12);
}

function triggerFromFinish(input: FinishRecallInput): BehaviorRecallTrigger {
  const text = [input.summary, ...input.decisions, ...input.nextSteps].join("\n");
  if (input.outcome === "blocked" || /\b(error|failed|failure|blocked|exception)\b|오류|실패|막힘/i.test(text)) return "error";
  if (/\b(handoff|handover|delegate|resume|transfer)\b|인계|이어받|넘겨/i.test(text)) return "handoff";
  if (/\b(direction\s*change|pivot|changed\s*direction|correction)\b|방향\s*전환|방향전환|전환/i.test(text)) {
    return "direction_change";
  }
  return "completion";
}

function decisionStatusFrom(input: FinishRecallInput): BehaviorRecallDecisionStatus {
  if (input.usedMemoryPaths.length > 0) return "performed";
  if (input.contextPackPaths.length > 0) return "skipped";
  return "not_applicable";
}

function decisionReason(input: FinishRecallInput, status: BehaviorRecallDecisionStatus): string {
  if (status === "performed") return "finish_task declared recalled memory paths that informed the work.";
  if (status === "skipped") return "Context Pack existed, but finish_task did not declare specific recalled memory paths.";
  return "No behavior memory or Context Pack path was declared for this finish.";
}

export function buildFinishBehaviorRecallEntry(input: FinishRecallInput): BehaviorRecallEntry {
  const triggerType = triggerFromFinish(input);
  const recalledMemoryPaths = normalizeVaultPaths(input.usedMemoryPaths);
  const contextPackPaths = normalizeVaultPaths(input.contextPackPaths);
  const decisionStatus = decisionStatusFrom({ ...input, usedMemoryPaths: recalledMemoryPaths, contextPackPaths });
  return {
    version: BEHAVIOR_RECALL_VERSION,
    recall_id: `behavior-recall-${input.finishedAt.replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "-")}-${hashShort(
      `${input.taskId}:${triggerType}:${input.tracePath}`,
    )}`,
    trigger_type: triggerType,
    task_id: input.taskId,
    recalled_memory_paths: recalledMemoryPaths,
    decision_status: decisionStatus,
    reason: decisionReason({ ...input, usedMemoryPaths: recalledMemoryPaths, contextPackPaths }, decisionStatus),
    evidence_path: normalizeVaultPath(input.tracePath),
    conflicting_memory_paths: [],
    followup_action:
      decisionStatus === "performed" ? "behavior_memory_recalled_for_task_finish" : "review_finish_trace_if_behavior_memory_was_expected",
    created_at: input.finishedAt,
  };
}

export async function appendBehaviorRecallEntry(
  dataRoot: string,
  entry: BehaviorRecallEntry,
): Promise<{ ledger_path: string; entry: BehaviorRecallEntry }> {
  const ledgerPath = dataPath(dataRoot, ...BEHAVIOR_RECALL_LEDGER_RELATIVE_PATH.split("/"));
  await appendJsonLine(ledgerPath, entry);
  return { ledger_path: relDataPath(dataRoot, ledgerPath), entry };
}

export async function recordFeedbackCorrectionRecall(
  dataRoot: string,
  input: FeedbackRecallInput,
): Promise<{
  ledger_path: string;
  entry: BehaviorRecallEntry;
  conflicting_memory_paths: string[];
  quarantine_paths: string[];
  review_path: string | null;
}> {
  const acceptedPath = normalizeVaultPath(input.acceptedPath);
  const conflicts = input.conflictingMemoryPaths === undefined
    ? await findPotentialBehaviorConflicts(dataRoot, input.correction, acceptedPath, input.appliesTo)
    : normalizeVaultPaths(input.conflictingMemoryPaths);
  const entry: BehaviorRecallEntry = {
    version: BEHAVIOR_RECALL_VERSION,
    recall_id: `behavior-recall-${input.createdAt.replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "-")}-${hashShort(
      input.feedbackId,
    )}`,
    trigger_type: "correction",
    task_id: input.taskId ?? null,
    recalled_memory_paths: [acceptedPath],
    decision_status: "performed",
    reason: "Direct user correction was written back as accepted behavior memory for future Context Packs.",
    evidence_path: acceptedPath,
    conflicting_memory_paths: conflicts,
    conflict_resolution: input.conflictResolution ?? (conflicts.length > 0 ? null : "no_conflict"),
    followup_action:
      conflicts.length > 0
        ? input.conflictResolution === "demote_superseded"
          ? "superseded_memory_demoted"
          : "superseded_memory_held"
        : "retrieve_correction_in_next_context_pack",
    created_at: input.createdAt,
  };
  const ledger = await appendBehaviorRecallEntry(dataRoot, entry);
  return {
    ...ledger,
    conflicting_memory_paths: conflicts,
    quarantine_paths: [],
    review_path: null,
  };
}

function isBehaviorRecallEntry(value: unknown): value is BehaviorRecallEntry {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Partial<BehaviorRecallEntry>;
  return (
    record.version === BEHAVIOR_RECALL_VERSION &&
    ["completion", "handoff", "error", "direction_change", "correction"].includes(String(record.trigger_type ?? "")) &&
    (typeof record.task_id === "string" || record.task_id === null) &&
    Array.isArray(record.recalled_memory_paths) &&
    ["performed", "skipped", "not_applicable"].includes(String(record.decision_status ?? "")) &&
    typeof record.reason === "string" &&
    record.reason.trim().length > 0 &&
    typeof record.evidence_path === "string" &&
    record.evidence_path.trim().length > 0 &&
    Array.isArray(record.conflicting_memory_paths) &&
    typeof record.followup_action === "string" &&
    record.followup_action.trim().length > 0 &&
    typeof record.created_at === "string" &&
    record.created_at.trim().length > 0
  );
}

async function readLedger(
  dataRoot: string,
): Promise<{ entries: BehaviorRecallEntry[]; malformed: Array<{ line: number; reason: string }>; exists: boolean; path: string }> {
  const ledgerPath = dataPath(dataRoot, ...BEHAVIOR_RECALL_LEDGER_RELATIVE_PATH.split("/"));
  let text: string;
  try {
    text = await fs.readFile(ledgerPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { entries: [], malformed: [], exists: false, path: relDataPath(dataRoot, ledgerPath) };
    }
    throw error;
  }
  const entries: BehaviorRecallEntry[] = [];
  const malformed: Array<{ line: number; reason: string }> = [];
  text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .forEach((line, index) => {
      if (!line) return;
      try {
        const parsed = JSON.parse(line) as unknown;
        if (isBehaviorRecallEntry(parsed)) entries.push(parsed);
        else malformed.push({ line: index + 1, reason: "required_fields_missing_or_invalid" });
      } catch {
        malformed.push({ line: index + 1, reason: "json_parse_failed" });
      }
    });
  return { entries, malformed, exists: true, path: relDataPath(dataRoot, ledgerPath) };
}

async function correctionRecords(dataRoot: string): Promise<Array<{ path: string; record: JsonObject }>> {
  const accepted = await readJsonDir(dataRoot, "50_Instances/accepted");
  return accepted.filter((entry) => firstString(entry.record.type) === "feedback_correction");
}

async function hasQuarantineFor(dataRoot: string, targetPath: string): Promise<boolean> {
  const quarantines = await readJsonDir(dataRoot, ".dino/quarantine");
  return quarantines.some(
    (entry) =>
      firstString(entry.record.type) === "behavior_conflict_quarantine" &&
      firstString(entry.record.status).toLowerCase() === "quarantined" &&
      firstString(entry.record.target_path) === targetPath,
  );
}

async function hasResolvedCorrectionConflict(dataRoot: string, targetPath: string, successorPath: string): Promise<boolean> {
  const record = await readJson<JsonObject>(dataPath(dataRoot, normalizeVaultPath(targetPath)));
  const status = firstString(record?.lifecycle_state, record?.status).toLowerCase().replace(/_/g, "-");
  const successors = stringArray(record?.successor_paths).map(normalizeVaultPath);
  if (["held", "hold", "demoted", "quarantined", "quarantine"].includes(status) && successors.includes(successorPath)) {
    return true;
  }
  return hasQuarantineFor(dataRoot, targetPath);
}

async function pathExists(dataRoot: string, relativePath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(dataPath(dataRoot, normalizeVaultPath(relativePath)));
    return stat.isFile();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export async function buildBehaviorRecallReport(
  dataRoot: string,
  options: { now?: Date } = {},
): Promise<BehaviorRecallReport> {
  const generatedAt = nowIso(options.now ?? new Date());
  const ledger = await readLedger(dataRoot);
  const corrections = await correctionRecords(dataRoot);
  const evidenceRepairs = await loadAppliedBehaviorRecallRepairs(dataRoot);
  const findings: BehaviorRecallFinding[] = [];
  let appliedEvidenceMigrations = 0;
  let invalidEvidenceMigrations = 0;

  if (!ledger.exists) {
    findings.push({
      signal: "ledger_missing",
      severity: "fail",
      path: ledger.path,
      reason: "Behavior recall ledger has not been created.",
    });
  }
  for (const item of ledger.malformed) {
    findings.push({
      signal: "ledger_entry_malformed",
      severity: "fail",
      path: `${ledger.path}:${item.line}`,
      reason: item.reason,
    });
  }

  const recalledPaths = new Set(ledger.entries.flatMap((entry) => entry.recalled_memory_paths));
  const correctionRecordsWithoutRecall = corrections.filter((entry) => !recalledPaths.has(entry.path));
  if (ledger.exists && ledger.entries.some((entry) => entry.trigger_type === "correction")) {
    for (const entry of ledger.entries.filter((item) => item.trigger_type === "correction")) {
      for (const conflictPath of entry.conflicting_memory_paths) {
        if (!(await hasResolvedCorrectionConflict(dataRoot, conflictPath, entry.evidence_path))) {
          findings.push({
            signal: "correction_conflict_not_quarantined",
            severity: "fail",
            path: entry.evidence_path,
            reason: `Conflicting memory is not held, demoted, or quarantined with the correction as successor: ${conflictPath}`,
          });
        }
      }
    }
  }
  for (const entry of ledger.entries) {
    if (await pathExists(dataRoot, entry.evidence_path)) continue;
    const migrated = evidenceRepairs.get(entry.recall_id);
    if (migrated) {
      const validation = await validateBehaviorRecallEvidenceRepair(dataRoot, entry as unknown as JsonObject, migrated.repair);
      if (validation.ok) {
        appliedEvidenceMigrations += 1;
        continue;
      }
      invalidEvidenceMigrations += 1;
      findings.push({
        signal: "evidence_migration_invalid",
        severity: "fail",
        path: migrated.migration_path,
        reason: `Behavior recall evidence migration is invalid for ${entry.recall_id}: ${validation.issues.join(", ")}.`,
      });
      continue;
    }
    findings.push({
      signal: "evidence_path_missing",
      severity: "fail",
      path: entry.evidence_path,
      reason: `Behavior recall evidence path does not exist for ${entry.recall_id}.`,
    });
  }

  if (ledger.exists && ledger.entries.length > 0 && correctionRecordsWithoutRecall.length > 0) {
    findings.push({
      signal: "correction_missing_recall_entry",
      severity: "warn",
      path: correctionRecordsWithoutRecall[0]?.path ?? "50_Instances/accepted",
      reason: "Legacy feedback corrections exist without behavior recall ledger entries.",
    });
  }

  const blockers = findings.filter((finding) => finding.severity === "fail").length;
  const status: BehaviorRecallStatus = blockers === 0 ? "healthy" : "needs_attention";
  const byTrigger = (trigger: BehaviorRecallTrigger) => ledger.entries.filter((entry) => entry.trigger_type === trigger).length;
  const byDecision = (decision: BehaviorRecallDecisionStatus) =>
    ledger.entries.filter((entry) => entry.decision_status === decision).length;

  return {
    version: BEHAVIOR_RECALL_VERSION,
    status,
    generated_at: generatedAt,
    latest_verified_at: status === "healthy" ? generatedAt : null,
    data_root: path.resolve(dataRoot),
    ledger_path: ledger.path,
    counts: {
      entries: ledger.entries.length,
      malformed_entries: ledger.malformed.length,
      completion: byTrigger("completion"),
      handoff: byTrigger("handoff"),
      error: byTrigger("error"),
      direction_change: byTrigger("direction_change"),
      correction: byTrigger("correction"),
      performed: byDecision("performed"),
      skipped: byDecision("skipped"),
      not_applicable: byDecision("not_applicable"),
      correction_conflicts: ledger.entries.reduce((total, entry) => total + entry.conflicting_memory_paths.length, 0),
      correction_records: corrections.length,
      correction_records_without_recall: correctionRecordsWithoutRecall.length,
      evidence_migrations_applied: appliedEvidenceMigrations,
      evidence_migrations_invalid: invalidEvidenceMigrations,
      blockers,
    },
    latest_entries: ledger.entries
      .slice()
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .slice(0, 20),
    findings,
    warnings: [
      correctionRecordsWithoutRecall.length > 0 ? "legacy_feedback_corrections_without_behavior_recall_entries" : "",
      ledger.entries.length > 0 && byTrigger("completion") === 0 ? "no_completion_recall_entry_yet" : "",
    ].filter(Boolean),
    visible_status: status === "healthy" ? "Behavior recall ledger healthy" : "Behavior recall ledger needs attention",
  };
}

export async function buildAndWriteBehaviorRecallReport(
  dataRoot: string,
  options: { now?: Date } = {},
): Promise<{ report: BehaviorRecallReport; path: string }> {
  const report = await buildBehaviorRecallReport(dataRoot, options);
  const statusPath = dataPath(dataRoot, ...BEHAVIOR_RECALL_STATUS_RELATIVE_PATH.split("/"));
  await writeJson(statusPath, report);
  return { report, path: statusPath };
}
