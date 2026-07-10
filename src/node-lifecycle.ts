import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import { dataPath } from "./context.js";

export const NODE_LIFECYCLE_VERSION = "node_lifecycle_v3";
export const NODE_LIFECYCLE_STATES = [
  "candidate",
  "review",
  "accepted",
  "held",
  "quarantined",
  "demoted",
  "archived",
  "deletion-proposed",
  "deleted-tombstone",
] as const;

export type NodeLifecycleState = (typeof NODE_LIFECYCLE_STATES)[number];

export type NodeLifecycleHistoryEntry = {
  transition_id: string;
  idempotency_key: string;
  from_state: NodeLifecycleState | null;
  to_state: NodeLifecycleState;
  reason_code: string;
  reason: string;
  actor: string;
  evidence_paths: string[];
  predecessor_paths: string[];
  successor_paths: string[];
  at: string;
};

export type NodeLifecycleRecord = Record<string, unknown> & {
  lifecycle_version: typeof NODE_LIFECYCLE_VERSION;
  lifecycle_state: NodeLifecycleState;
  lifecycle_state_entered_at: string;
  lifecycle_last_transition_id: string;
  lifecycle_history: NodeLifecycleHistoryEntry[];
  predecessor_paths: string[];
  successor_paths: string[];
};

export type LifecycleMutationInput = {
  target_path: string;
  to_state: NodeLifecycleState;
  reason_code: string;
  reason: string;
  actor: string;
  evidence_paths?: string[];
  predecessor_paths?: string[];
  successor_paths?: string[];
  at?: string;
  transition_id?: string;
  idempotency_key?: string;
  sync_status?: boolean;
  allow_deleted_restore?: boolean;
};

export type LifecycleMutationResult = {
  record: NodeLifecycleRecord;
  transition: NodeLifecycleHistoryEntry;
  changed: boolean;
  idempotent: boolean;
};

export type LifecycleValidation = {
  ok: boolean;
  issues: string[];
};

export type AcceptedEligibility = {
  eligible: boolean;
  issues: string[];
  durable_source_paths: string[];
  durable_external_support_paths: string[];
};

export type AcceptedEligibilityOptions = {
  staged_records?: Record<string, JsonObject>;
};

export type LifecyclePressureInput = {
  duplicate_count?: number;
  contradiction_count?: number;
  retrieval_count?: number;
  last_retrieved_at?: string | null;
  now?: Date;
  accepted_eligibility?: AcceptedEligibility | null;
};

export type LifecyclePressureScore = {
  score: number;
  factors: Array<{ id: string; score: number; reason: string }>;
  recommended_action: "keep" | "merge" | "hold" | "quarantine" | "archive" | "deletion-review";
};

type JsonObject = Record<string, unknown>;

const ALLOWED_TRANSITIONS: Record<NodeLifecycleState, ReadonlySet<NodeLifecycleState>> = {
  candidate: new Set(["review", "held", "quarantined", "archived", "deletion-proposed"]),
  review: new Set(["candidate", "accepted", "held", "quarantined", "archived", "deletion-proposed"]),
  accepted: new Set(["held", "quarantined", "demoted", "archived", "deletion-proposed"]),
  held: new Set(["review", "accepted", "quarantined", "demoted", "archived", "deletion-proposed"]),
  quarantined: new Set(["review", "held", "demoted", "archived", "deletion-proposed"]),
  demoted: new Set(["review", "held", "archived", "deletion-proposed"]),
  archived: new Set(["review", "held", "deletion-proposed"]),
  "deletion-proposed": new Set(["held", "archived", "deleted-tombstone"]),
  "deleted-tombstone": new Set(),
};

export function isNodeLifecycleTransitionAllowed(
  fromState: NodeLifecycleState,
  toState: NodeLifecycleState,
  reasonCode = "",
): boolean {
  return (
    ALLOWED_TRANSITIONS[fromState].has(toState) ||
    (fromState === "deleted-tombstone" && toState === "deletion-proposed" && reasonCode === "tombstone_restored")
  );
}

function firstString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean);
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values));
}

export function normalizeLifecyclePath(value: string): string {
  const normalized = value.replace(/\\/g, "/").replace(/^\/+/, "").trim();
  if (!normalized || normalized.split("/").includes("..") || path.isAbsolute(normalized)) {
    throw new Error(`Invalid lifecycle vault path: ${value}`);
  }
  return normalized;
}

function normalizePaths(values: string[] | undefined): string[] {
  return unique((values ?? []).map((value) => normalizeLifecyclePath(value)));
}

function isState(value: unknown): value is NodeLifecycleState {
  return NODE_LIFECYCLE_STATES.includes(value as NodeLifecycleState);
}

function legacyStatusState(record: JsonObject, targetPath: string): NodeLifecycleState {
  const explicit = record.lifecycle_state;
  if (isState(explicit)) return explicit;
  const status = firstString(record.status).toLowerCase().replace(/_/g, "-");
  if (["held", "hold", "settled-hold"].includes(status)) return "held";
  if (["quarantined", "quarantine"].includes(status) || record.quarantine === true) return "quarantined";
  if (["demoted", "demotion"].includes(status)) return "demoted";
  if (["deletion-proposed", "delete-candidate"].includes(status)) return "deletion-proposed";
  if (["deleted-tombstone", "deleted"].includes(status)) return "deleted-tombstone";
  if (["archived", "archived-merged", "archived-rejected", "rejected", "closed", "settled"].includes(status)) {
    return "archived";
  }
  if (["accepted", "approved", "promoted"].includes(status)) return "accepted";
  if (["pending-review", "candidate"].includes(status)) return "candidate";
  if (["pending", "blocked", "review"].includes(status)) return "review";
  const normalizedPath = normalizeLifecyclePath(targetPath);
  if (normalizedPath.startsWith("50_Instances/accepted/")) return "accepted";
  if (normalizedPath.startsWith("50_Instances/candidates/")) return "candidate";
  if (normalizedPath.startsWith("50_Instances/archive/")) return "archived";
  if (normalizedPath.startsWith("80_Review_Queue/")) return "review";
  if (normalizedPath.startsWith(".dino/quarantine/")) return "quarantined";
  return "candidate";
}

export function getNodeLifecycleState(record: JsonObject, targetPath: string): NodeLifecycleState {
  return legacyStatusState(record, targetPath);
}

function statusForState(state: NodeLifecycleState): string {
  if (state === "candidate") return "pending_review";
  if (state === "review") return "pending";
  if (state === "deletion-proposed") return "deletion_proposed";
  if (state === "deleted-tombstone") return "deleted_tombstone";
  return state;
}

function lifecycleNodeId(record: JsonObject, targetPath: string): string {
  return firstString(
    record.node_id,
    record.memory_id,
    record.candidate_id,
    record.behavior_rule_id,
    record.review_id,
    record.quarantine_id,
    path.basename(targetPath, path.extname(targetPath)),
  );
}

function transitionEntry(
  fromState: NodeLifecycleState | null,
  input: LifecycleMutationInput,
): NodeLifecycleHistoryEntry {
  const at = input.at ?? new Date().toISOString();
  const targetPath = normalizeLifecyclePath(input.target_path);
  const transitionId = input.transition_id ?? `node-transition-${Date.now()}-${randomUUID()}`;
  const idempotencyKey =
    input.idempotency_key ??
    [targetPath, fromState ?? "none", input.to_state, input.reason_code, input.actor].join("|");
  if (!input.reason_code.trim() || !input.reason.trim() || !input.actor.trim()) {
    throw new Error("Lifecycle transition requires reason_code, reason, and actor");
  }
  return {
    transition_id: transitionId,
    idempotency_key: idempotencyKey,
    from_state: fromState,
    to_state: input.to_state,
    reason_code: input.reason_code.trim(),
    reason: input.reason.trim(),
    actor: input.actor.trim(),
    evidence_paths: normalizePaths(input.evidence_paths),
    predecessor_paths: normalizePaths(input.predecessor_paths),
    successor_paths: normalizePaths(input.successor_paths),
    at,
  };
}

function lifecycleFields(
  record: JsonObject,
  state: NodeLifecycleState,
  history: NodeLifecycleHistoryEntry[],
  input: LifecycleMutationInput,
): NodeLifecycleRecord {
  const latest = history[history.length - 1];
  if (!latest) throw new Error("Lifecycle history cannot be empty");
  const syncStatus = input.sync_status ?? !normalizeLifecyclePath(input.target_path).startsWith("80_Review_Queue/");
  return {
    ...record,
    ...(syncStatus ? { status: statusForState(state) } : {}),
    node_id: lifecycleNodeId(record, input.target_path),
    lifecycle_version: NODE_LIFECYCLE_VERSION,
    lifecycle_state: state,
    lifecycle_state_entered_at: latest.at,
    lifecycle_last_transition_id: latest.transition_id,
    lifecycle_history: history,
    predecessor_paths: unique([
      ...stringArray(record.predecessor_paths),
      ...history.flatMap((entry) => entry.predecessor_paths),
    ]),
    successor_paths: unique([
      ...stringArray(record.successor_paths),
      ...history.flatMap((entry) => entry.successor_paths),
    ]),
    updated_at: latest.at,
  };
}

export function initializeNodeLifecycle(
  record: JsonObject,
  input: LifecycleMutationInput,
): LifecycleMutationResult {
  if (isState(record.lifecycle_state) && Array.isArray(record.lifecycle_history)) {
    const validation = validateNodeLifecycleRecord(record, input.target_path);
    if (!validation.ok) throw new Error(`Invalid existing lifecycle: ${validation.issues.join(",")}`);
    const existing = record as NodeLifecycleRecord;
    if (existing.lifecycle_state !== input.to_state) return transitionNodeLifecycle(existing, input);
    const last = existing.lifecycle_history[existing.lifecycle_history.length - 1];
    return { record: existing, transition: last, changed: false, idempotent: true };
  }
  const entry = transitionEntry(null, input);
  const initialized = lifecycleFields(record, input.to_state, [entry], input);
  return { record: initialized, transition: entry, changed: true, idempotent: false };
}

export function transitionNodeLifecycle(
  record: JsonObject,
  input: LifecycleMutationInput,
): LifecycleMutationResult {
  if (!isState(record.lifecycle_state) || !Array.isArray(record.lifecycle_history)) {
    const initialState = getNodeLifecycleState(record, input.target_path);
    const initialized = initializeNodeLifecycle(record, {
      ...input,
      to_state: initialState,
      reason_code: `legacy_${input.reason_code}`,
      reason: `Initialized legacy lifecycle before transition: ${input.reason}`,
      idempotency_key: `legacy-init|${normalizeLifecyclePath(input.target_path)}|${initialState}`,
    });
    if (initialState === input.to_state) return initialized;
    return transitionNodeLifecycle(initialized.record, input);
  }
  const validation = validateNodeLifecycleRecord(record, input.target_path);
  if (!validation.ok) throw new Error(`Invalid lifecycle before transition: ${validation.issues.join(",")}`);
  const current = record.lifecycle_state as NodeLifecycleState;
  const history = record.lifecycle_history as NodeLifecycleHistoryEntry[];
  const requested = transitionEntry(current, input);
  const replay = history.find((entry) => entry.idempotency_key === requested.idempotency_key);
  if (replay) {
    if (replay.to_state !== input.to_state) throw new Error("Lifecycle idempotency key collision");
    if (current !== replay.to_state) {
      throw new Error("Lifecycle idempotency replay no longer matches the current state");
    }
    return { record: record as NodeLifecycleRecord, transition: replay, changed: false, idempotent: true };
  }
  if (current === input.to_state) {
    return {
      record: record as NodeLifecycleRecord,
      transition: history[history.length - 1],
      changed: false,
      idempotent: true,
    };
  }
  const allowed =
    ALLOWED_TRANSITIONS[current].has(input.to_state) ||
    (current === "deleted-tombstone" &&
      input.allow_deleted_restore === true &&
      input.to_state === "deletion-proposed" &&
      input.reason_code === "tombstone_restored");
  if (!allowed) throw new Error(`Lifecycle transition not allowed: ${current} -> ${input.to_state}`);
  const nextHistory = [...history, requested];
  const updated = lifecycleFields(record, input.to_state, nextHistory, input);
  return { record: updated, transition: requested, changed: true, idempotent: false };
}

export function validateNodeLifecycleRecord(record: JsonObject, targetPath: string): LifecycleValidation {
  const issues: string[] = [];
  if (record.lifecycle_version !== NODE_LIFECYCLE_VERSION) issues.push("lifecycle_version_invalid");
  if (!isState(record.lifecycle_state)) issues.push("lifecycle_state_invalid");
  const history = Array.isArray(record.lifecycle_history) ? record.lifecycle_history as NodeLifecycleHistoryEntry[] : [];
  if (history.length === 0) issues.push("lifecycle_history_missing");
  const transitionIds = new Set<string>();
  const idempotencyKeys = new Set<string>();
  let previous: NodeLifecycleState | null = null;
  let previousAt = Number.NEGATIVE_INFINITY;
  for (let index = 0; index < history.length; index += 1) {
    const entry = history[index];
    if (!entry || typeof entry !== "object") {
      issues.push(`lifecycle_history_invalid:${index}`);
      continue;
    }
    if (!entry.transition_id || transitionIds.has(entry.transition_id)) issues.push(`transition_id_invalid:${index}`);
    else transitionIds.add(entry.transition_id);
    if (!entry.idempotency_key || idempotencyKeys.has(entry.idempotency_key)) issues.push(`idempotency_key_invalid:${index}`);
    else idempotencyKeys.add(entry.idempotency_key);
    if (!isState(entry.to_state)) issues.push(`transition_to_state_invalid:${index}`);
    if (entry.from_state !== null && !isState(entry.from_state)) issues.push(`transition_from_state_invalid:${index}`);
    if (index === 0 && entry.from_state !== null) issues.push("first_transition_must_start_from_null");
    if (index > 0 && entry.from_state !== previous) issues.push(`transition_chain_broken:${index}`);
    if (
      index > 0 &&
      isState(entry.from_state) &&
      isState(entry.to_state) &&
      !isNodeLifecycleTransitionAllowed(entry.from_state, entry.to_state, entry.reason_code)
    ) {
      issues.push(`transition_not_allowed:${index}`);
    }
    if (!entry.reason_code || !entry.reason || !entry.actor || !Number.isFinite(Date.parse(entry.at))) {
      issues.push(`transition_evidence_invalid:${index}`);
    }
    const at = Date.parse(entry.at);
    if (Number.isFinite(at) && at < previousAt) issues.push(`transition_time_regressed:${index}`);
    if (Number.isFinite(at)) previousAt = at;
    for (const field of ["evidence_paths", "predecessor_paths", "successor_paths"] as const) {
      if (!Array.isArray(entry[field])) issues.push(`transition_${field}_invalid:${index}`);
    }
    const transitionPaths = [entry.evidence_paths, entry.predecessor_paths, entry.successor_paths]
      .filter(Array.isArray)
      .flat() as string[];
    for (const value of transitionPaths) {
      try {
        normalizeLifecyclePath(value);
      } catch {
        issues.push(`transition_path_invalid:${index}`);
      }
    }
    previous = entry.to_state;
  }
  if (isState(record.lifecycle_state) && previous !== record.lifecycle_state) issues.push("lifecycle_state_history_mismatch");
  if (history.length > 0 && record.lifecycle_last_transition_id !== history[history.length - 1]?.transition_id) {
    issues.push("lifecycle_last_transition_mismatch");
  }
  if (!Number.isFinite(Date.parse(firstString(record.lifecycle_state_entered_at)))) issues.push("lifecycle_state_entered_at_invalid");
  if (history.length > 0 && record.lifecycle_state_entered_at !== history[history.length - 1]?.at) {
    issues.push("lifecycle_state_entered_at_mismatch");
  }
  if (!firstString(record.node_id)) issues.push("lifecycle_node_id_missing");
  if (!Array.isArray(record.predecessor_paths)) issues.push("predecessor_paths_invalid");
  if (!Array.isArray(record.successor_paths)) issues.push("successor_paths_invalid");
  try {
    normalizeLifecyclePath(targetPath);
  } catch {
    issues.push("target_path_invalid");
  }
  return { ok: issues.length === 0, issues: unique(issues) };
}

function allSourceCandidates(record: JsonObject): string[] {
  const evidence = record.evidence && typeof record.evidence === "object" && !Array.isArray(record.evidence)
    ? record.evidence as JsonObject
    : {};
  const source = record.source && typeof record.source === "object" && !Array.isArray(record.source)
    ? record.source as JsonObject
    : {};
  return unique([
    firstString(record.source_candidate_path),
    firstString(record.source_review_path),
    firstString(record.review_path),
    firstString(record.source_path),
    firstString(record.evidence_source),
    ...stringArray(record.source_paths),
    ...stringArray(record.provenance_paths),
    firstString(record.provenance_path),
    firstString(evidence.source),
    firstString(evidence.source_report),
    firstString(evidence.extraction_report),
    firstString(source.trace_path),
    firstString(source.task_path),
  ].filter(Boolean));
}

function looksLikeVaultPath(value: string): boolean {
  if (/^[a-z]+:\/\//i.test(value)) return false;
  try {
    normalizeLifecyclePath(value);
    return value.includes("/") || value.includes("\\");
  } catch {
    return false;
  }
}

async function existingVaultPaths(dataRoot: string, values: string[]): Promise<string[]> {
  const existing: string[] = [];
  for (const value of values) {
    const withoutFragment = value.split("#", 1)[0]?.trim() ?? "";
    if (!looksLikeVaultPath(withoutFragment)) continue;
    const normalized = normalizeLifecyclePath(withoutFragment);
    try {
      const stat = await fs.stat(dataPath(dataRoot, ...normalized.split("/")));
      if (stat.isFile()) existing.push(normalized);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return unique(existing);
}

function normalizedReferencePath(value: string): string | null {
  const withoutFragment = value.split("#", 1)[0]?.trim() ?? "";
  if (!looksLikeVaultPath(withoutFragment)) return null;
  return normalizeLifecyclePath(withoutFragment);
}

async function readVaultRecord(
  dataRoot: string,
  relativePath: string,
  options: AcceptedEligibilityOptions,
): Promise<JsonObject | null> {
  if (options.staged_records?.[relativePath]) return options.staged_records[relativePath] ?? null;
  try {
    const parsed = JSON.parse(await fs.readFile(dataPath(dataRoot, ...relativePath.split("/")), "utf8")) as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed as JsonObject : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function reviewLineageValid(record: JsonObject): boolean {
  const reviewStatus = firstString(record.review_status).toLowerCase();
  return Boolean(
    (reviewStatus.includes("accepted") || reviewStatus === "approved") &&
      firstString(record.source_candidate_path) &&
      firstString(record.source_review_path, record.review_path) &&
      firstString(record.reviewed_by) &&
      Number.isFinite(Date.parse(firstString(record.reviewed_at, record.accepted_at))),
  );
}

function externalTruthRequired(record: JsonObject): boolean {
  const sourceStatus = firstString(record.source_status).toLowerCase();
  if (["external", "mixed", "verified", "verified_summary", "user_supplied_anchor_summary"].includes(sourceStatus)) return true;
  const type = firstString(record.type).toLowerCase();
  return type.includes("verified_knowledge") || type.includes("factual") || type.includes("source_claim");
}

export async function evaluateAcceptedEligibility(
  dataRoot: string,
  targetPath: string,
  record: JsonObject,
  options: AcceptedEligibilityOptions = {},
): Promise<AcceptedEligibility> {
  const issues: string[] = [];
  const normalizedPath = normalizeLifecyclePath(targetPath);
  const validation = validateNodeLifecycleRecord(record, normalizedPath);
  if (!validation.ok) issues.push(...validation.issues);
  if (record.lifecycle_state !== "accepted") issues.push(`lifecycle_not_accepted:${String(record.lifecycle_state ?? "missing")}`);
  if (!reviewLineageValid(record)) issues.push("accepted_review_lineage_missing");
  const reviewPath = normalizedReferencePath(firstString(record.source_review_path, record.review_path));
  if (reviewPath) {
    const review = await readVaultRecord(dataRoot, reviewPath, options);
    if (!review) {
      issues.push("accepted_review_record_missing");
    } else {
      const reviewStatus = firstString(review.status).toLowerCase();
      if (!["approved", "accepted", "applied"].includes(reviewStatus)) issues.push("accepted_review_not_approved");
      const candidatePath = normalizedReferencePath(firstString(record.source_candidate_path));
      const reviewCandidatePath = normalizedReferencePath(firstString(review.candidate_path, review.source_candidate_path));
      if (candidatePath && reviewCandidatePath !== candidatePath) issues.push("accepted_review_candidate_binding_mismatch");
      const reviewAcceptedPath = normalizedReferencePath(firstString(review.accepted_path));
      if (reviewAcceptedPath && reviewAcceptedPath !== normalizedPath) issues.push("accepted_review_target_binding_mismatch");
    }
  }
  if (record.quarantine === true) issues.push("accepted_record_quarantined");
  if (firstString(record.sensitivity).toLowerCase() === "sensitive") issues.push("accepted_record_sensitive");
  const sourceCandidates = allSourceCandidates(record);
  const durableSourcePaths = await existingVaultPaths(dataRoot, sourceCandidates);
  if (durableSourcePaths.length === 0) issues.push("durable_source_path_missing");
  const durableExternalSupportPaths = durableSourcePaths.filter(
    (value) => value.startsWith("30_Sources/chunks/") || value.startsWith(".dino/provenance/"),
  );
  if (externalTruthRequired(record) && durableExternalSupportPaths.length === 0) {
    issues.push("durable_external_provenance_missing");
  }
  return {
    eligible: issues.length === 0,
    issues: unique(issues),
    durable_source_paths: durableSourcePaths,
    durable_external_support_paths: durableExternalSupportPaths,
  };
}

export async function isAcceptedMemoryRetrievable(
  dataRoot: string,
  targetPath: string,
  record: JsonObject,
): Promise<boolean> {
  if (!normalizeLifecyclePath(targetPath).startsWith("50_Instances/accepted/")) return true;
  return (await evaluateAcceptedEligibility(dataRoot, targetPath, record)).eligible;
}

function recordAgeDays(record: JsonObject, now: Date): number | null {
  const date = Date.parse(firstString(record.updated_at, record.created_at, record.last_verified));
  return Number.isFinite(date) ? Math.max(0, (now.getTime() - date) / 86_400_000) : null;
}

function broadBehaviorRule(record: JsonObject): boolean {
  const rule = firstString(record.behavior_rule, record.reusable_rule, record.rule, record.claim).toLowerCase();
  if (!rule) return false;
  const scope = firstString(record.scope, record.applies_to);
  return !scope && /\b(always|never|every|all tasks|must)\b/.test(rule);
}

export function scoreNodeLifecyclePressure(
  record: JsonObject,
  input: LifecyclePressureInput = {},
): LifecyclePressureScore {
  const factors: LifecyclePressureScore["factors"] = [];
  const add = (id: string, score: number, reason: string) => factors.push({ id, score, reason });
  const duplicateCount = Math.max(0, input.duplicate_count ?? 0);
  const contradictionCount = Math.max(0, input.contradiction_count ?? 0);
  const retrievalCount = Math.max(0, input.retrieval_count ?? Number(record.retrieval_count ?? 0));
  const ageDays = recordAgeDays(record, input.now ?? new Date());
  if (duplicateCount > 0) add("duplicate_pressure", Math.min(30, 15 + duplicateCount * 5), `${duplicateCount} duplicate peers`);
  if (contradictionCount > 0) add("contradiction_pressure", Math.min(40, 25 + contradictionCount * 5), `${contradictionCount} contradictions`);
  if (input.accepted_eligibility && !input.accepted_eligibility.eligible) {
    add("unsupported_pressure", 30, input.accepted_eligibility.issues.join(","));
  }
  if (firstString(record.sensitivity).toLowerCase() === "sensitive") add("sensitivity_pressure", 35, "sensitive memory cannot remain hot");
  if (broadBehaviorRule(record)) add("broad_rule_pressure", 20, "broad behavior rule has no explicit scope");
  if (ageDays !== null && ageDays >= 90 && retrievalCount === 0) add("low_use_pressure", 15, `unused for ${Math.floor(ageDays)} days`);
  if (ageDays !== null && ageDays >= 180) add("age_pressure", 10, `record age ${Math.floor(ageDays)} days`);
  if (ageDays !== null && ageDays >= 365 && retrievalCount === 0) {
    add("deep_stale_pressure", 45, `unused record is ${Math.floor(ageDays)} days old`);
  }
  const score = Math.min(100, factors.reduce((sum, factor) => sum + factor.score, 0));
  const ids = new Set(factors.map((factor) => factor.id));
  const recommendedAction: LifecyclePressureScore["recommended_action"] = ids.has("sensitivity_pressure") || ids.has("contradiction_pressure")
    ? "quarantine"
    : ids.has("duplicate_pressure")
      ? "merge"
      : ids.has("unsupported_pressure") || ids.has("broad_rule_pressure")
        ? "hold"
        : score >= 70
          ? "deletion-review"
          : score >= 25
            ? "archive"
            : "keep";
  return { score, factors, recommended_action: recommendedAction };
}
