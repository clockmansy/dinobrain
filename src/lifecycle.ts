import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

import { atomicWriteJson } from "./concurrency.js";
import { dataPath, relDataPath } from "./context.js";
import {
  evaluateAcceptedEligibility,
  getNodeLifecycleState,
  normalizeLifecyclePath,
  scoreNodeLifecyclePressure,
  validateNodeLifecycleRecord,
  type AcceptedEligibility,
  type LifecyclePressureScore,
  type NodeLifecycleState,
} from "./node-lifecycle.js";
import {
  currentNodeRecord,
  initializeLifecycleWrite,
  rollbackNodeLifecycleTransaction,
  transitionLifecycleWrite,
  writeNodeLifecycleBatch,
  type LifecycleBatchWrite,
  type NodeLifecycleBatchResult,
} from "./node-lifecycle-store.js";

const execFileAsync = promisify(execFile);

export const NODE_LIFECYCLE_REPORT_VERSION = "node_lifecycle_report_v3";
export const NODE_LIFECYCLE_STATUS_PATH = ".dino/state/node_lifecycle.json";

export type LifecycleActionType =
  | "initialize_accepted"
  | "hold_unsupported"
  | "quarantine_excluded"
  | "repair_invalid_lifecycle";

export type LifecycleAction = {
  type: LifecycleActionType;
  target_path: string;
  from_state: NodeLifecycleState | "legacy";
  to_state: NodeLifecycleState;
  review_path: string;
  reason_codes: string[];
  pressure: LifecyclePressureScore;
  applied: boolean;
  transition_ids: string[];
};

type JsonObject = Record<string, unknown>;

type VaultRecord = {
  path: string;
  record: JsonObject;
  sha256: string;
};

type PlannedMutation = {
  action: LifecycleAction;
  writes: LifecycleBatchWrite[];
};

type GitSnapshot = {
  repository: boolean;
  head: string | null;
  dirty_count: number;
  dirty_status_sha256: string | null;
  recovery_ref: string | null;
};

function nowIso(): string {
  return new Date().toISOString();
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function safeSlug(value: string): string {
  const slug = value
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 96);
  return slug || "node";
}

function migrationId(date = new Date()): string {
  const stamp = date.toISOString().replace(/[-:]/g, "").replace("T", "-").replace(/[.Z]/g, "");
  return `node-lifecycle-${stamp}-${randomUUID()}`;
}

function firstString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)));
}

function withoutLifecycle(record: JsonObject): JsonObject {
  const result = { ...record };
  for (const key of [
    "node_id",
    "lifecycle_version",
    "lifecycle_state",
    "lifecycle_state_entered_at",
    "lifecycle_last_transition_id",
    "lifecycle_history",
    "predecessor_paths",
    "successor_paths",
  ]) {
    delete result[key];
  }
  return result;
}

async function readJsonDir(dataRoot: string, relativeDir: string): Promise<VaultRecord[]> {
  const directory = dataPath(dataRoot, ...relativeDir.split("/"));
  let entries: Array<import("node:fs").Dirent>;
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const records: VaultRecord[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const absolutePath = path.join(directory, entry.name);
    const bytes = await fs.readFile(absolutePath);
    const parsed = JSON.parse(bytes.toString("utf8")) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error(`Lifecycle record is not a JSON object: ${relDataPath(dataRoot, absolutePath)}`);
    }
    records.push({ path: relDataPath(dataRoot, absolutePath), record: parsed as JsonObject, sha256: sha256(bytes) });
  }
  return records;
}

function claimKey(record: JsonObject): string {
  return firstString(record.claim, record.behavior_rule, record.title, record.summary)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function contradictionCount(record: JsonObject): number {
  return unique([
    ...stringArray(record.contradicts),
    ...stringArray(record.conflicting_memory_paths),
    ...stringArray(record.supersedes),
  ]).length;
}

function evidencePathCandidates(record: JsonObject): string[] {
  const evidence = record.evidence && typeof record.evidence === "object" && !Array.isArray(record.evidence)
    ? record.evidence as JsonObject
    : {};
  const source = record.source && typeof record.source === "object" && !Array.isArray(record.source)
    ? record.source as JsonObject
    : {};
  return unique([
    firstString(record.source_candidate_path),
    firstString(record.source_path),
    firstString(record.evidence_source),
    ...stringArray(record.source_paths),
    ...stringArray(record.provenance_paths),
    firstString(record.provenance_path),
    firstString(evidence.source),
    firstString(evidence.source_report),
    firstString(source.trace_path),
    firstString(source.task_path),
  ]);
}

async function existingEvidencePaths(dataRoot: string, record: JsonObject): Promise<string[]> {
  const result: string[] = [];
  for (const raw of evidencePathCandidates(record)) {
    if (/^[a-z]+:\/\//i.test(raw)) continue;
    const candidate = raw.split("#", 1)[0]?.trim() ?? "";
    if (!candidate) continue;
    let normalized: string;
    try {
      normalized = normalizeLifecyclePath(candidate);
    } catch {
      continue;
    }
    try {
      const stat = await fs.stat(dataPath(dataRoot, ...normalized.split("/")));
      if (stat.isFile()) result.push(normalized);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return unique(result);
}

function reviewedAt(record: JsonObject, fallback: string): string {
  const value = firstString(record.reviewed_at, record.accepted_at, record.updated_at, record.created_at);
  return Number.isFinite(Date.parse(value)) ? value : fallback;
}

function reviewAttestationPath(targetPath: string): string {
  return `80_Review_Queue/lifecycle-migration/${safeSlug(path.basename(targetPath, ".json"))}.json`;
}

function combineStages(
  stages: Array<{ write: LifecycleBatchWrite; mutation: { record: JsonObject } }>,
  expectedBeforeSha256: string,
): LifecycleBatchWrite {
  const last = stages.at(-1);
  if (!last) throw new Error("Lifecycle migration requires at least one stage");
  return {
    target_path: last.write.target_path,
    record: last.mutation.record,
    transitions: stages.flatMap((stage) => stage.write.transitions ?? []),
    expected_before_sha256: expectedBeforeSha256,
  };
}

async function gitSnapshot(dataRoot: string, id: string, createRecoveryRef: boolean): Promise<GitSnapshot> {
  let headOutput: string;
  let statusOutput: string;
  try {
    const [headResult, statusResult] = await Promise.all([
      execFileAsync("git", ["-C", dataRoot, "rev-parse", "HEAD"], { windowsHide: true }),
      execFileAsync("git", ["-C", dataRoot, "status", "--porcelain=v1", "--untracked-files=all"], { windowsHide: true }),
    ]);
    headOutput = headResult.stdout;
    statusOutput = statusResult.stdout;
  } catch (error) {
    if (createRecoveryRef) {
      throw new Error(`Node lifecycle apply requires a Git-backed data root: ${String((error as Error).message ?? error)}`);
    }
    return { repository: false, head: null, dirty_count: 0, dirty_status_sha256: null, recovery_ref: null };
  }
  const head = headOutput.trim();
  const normalizedStatus = statusOutput.replace(/\r\n/g, "\n");
  const recoveryRef = createRecoveryRef ? `refs/dinobrain-recovery/node-lifecycle/${id}` : null;
  if (recoveryRef) {
    try {
      await execFileAsync("git", ["-C", dataRoot, "update-ref", recoveryRef, head], { windowsHide: true });
    } catch (error) {
      throw new Error(`Node lifecycle recovery ref creation failed: ${String((error as Error).message ?? error)}`);
    }
  }
  return {
    repository: true,
    head,
    dirty_count: normalizedStatus.split("\n").filter(Boolean).length,
    dirty_status_sha256: sha256(Buffer.from(normalizedStatus, "utf8")),
    recovery_ref: recoveryRef,
  };
}

async function planAcceptedMutation(
  dataRoot: string,
  entry: VaultRecord,
  reviewer: string,
  generatedAt: string,
  duplicateCount: number,
  hasQuarantineRecord: boolean,
): Promise<PlannedMutation | null> {
  const currentState = getNodeLifecycleState(entry.record, entry.path);
  const validation = validateNodeLifecycleRecord(entry.record, entry.path);
  const reviewPath = reviewAttestationPath(entry.path);
  const sourceCandidatePath = firstString(entry.record.source_candidate_path) || (await existingEvidencePaths(dataRoot, entry.record))[0] || "";
  const base = {
    ...(validation.ok ? entry.record : withoutLifecycle(entry.record)),
    source_candidate_path: sourceCandidatePath || null,
    source_review_path: reviewPath,
    review_status: "accepted_by_agent_review",
    reviewed_by: firstString(entry.record.reviewed_by, reviewer),
    reviewed_at: reviewedAt(entry.record, generatedAt),
    updated_at: generatedAt,
  };
  const reviewRecord = {
    review_id: `lifecycle-migration-${safeSlug(path.basename(entry.path, ".json"))}`,
    type: "lifecycle_migration_attestation",
    status: "approved",
    candidate_path: sourceCandidatePath || null,
    accepted_path: entry.path,
    target_path: entry.path,
    decision: "approve_existing_accepted",
    reviewer,
    evidence_paths: await existingEvidencePaths(dataRoot, base),
    created_at: generatedAt,
    updated_at: generatedAt,
  };
  let acceptedStage;
  if (!validation.ok || !Array.isArray(entry.record.lifecycle_history)) {
    acceptedStage = initializeLifecycleWrite(entry.path, base, {
      to_state: "accepted",
      reason_code: validation.ok ? "legacy_accepted_initialized" : "invalid_lifecycle_rebuilt",
      reason: validation.ok
        ? "Initialize legacy accepted memory with explicit lifecycle and review lineage."
        : `Rebuild malformed lifecycle before classification: ${validation.issues.join(",")}`,
      actor: reviewer,
      evidence_paths: [reviewPath, ...reviewRecord.evidence_paths],
      predecessor_paths: sourceCandidatePath ? [sourceCandidatePath, reviewPath] : [reviewPath],
      at: generatedAt,
      idempotency_key: `accepted-migration|${entry.path}`,
    });
  } else if (currentState === "accepted") {
    acceptedStage = { write: { target_path: entry.path, record: base, transitions: [] }, mutation: { record: base } };
  } else {
    return null;
  }
  const staged = { [reviewPath]: reviewRecord };
  const eligibility = await evaluateAcceptedEligibility(dataRoot, entry.path, acceptedStage.mutation.record, {
    staged_records: staged,
  });
  const pressure = scoreNodeLifecyclePressure(acceptedStage.mutation.record, {
    duplicate_count: duplicateCount,
    contradiction_count: contradictionCount(entry.record),
    accepted_eligibility: eligibility,
  });
  let desiredState: NodeLifecycleState = "accepted";
  let actionType: LifecycleActionType = validation.ok ? "initialize_accepted" : "repair_invalid_lifecycle";
  const reasonCodes = [...eligibility.issues, ...pressure.factors.map((factor) => factor.id)];
  if (hasQuarantineRecord) {
    desiredState = "quarantined";
    actionType = "quarantine_excluded";
    reasonCodes.push("existing_quarantine_record");
    reviewRecord.status = "quarantined";
    reviewRecord.decision = "quarantine_existing_accepted";
  } else if (!eligibility.eligible) {
    desiredState = pressure.recommended_action === "quarantine" ? "quarantined" : "held";
    actionType = desiredState === "quarantined" ? "quarantine_excluded" : "hold_unsupported";
    reviewRecord.status = desiredState;
    reviewRecord.decision = desiredState === "held" ? "hold_existing_accepted" : "quarantine_existing_accepted";
  }

  let targetWrite: LifecycleBatchWrite;
  if (desiredState === "accepted") {
    targetWrite = {
      ...acceptedStage.write,
      expected_before_sha256: entry.sha256,
    };
  } else {
    const heldBase = {
      ...acceptedStage.mutation.record,
      status: desiredState,
      quarantine: desiredState === "quarantined",
      hold_reason: reasonCodes.join(","),
      held_by: reviewer,
      held_at: generatedAt,
      updated_at: generatedAt,
    };
    if (getNodeLifecycleState(acceptedStage.mutation.record, entry.path) === desiredState) {
      targetWrite = { target_path: entry.path, record: heldBase, transitions: [], expected_before_sha256: entry.sha256 };
    } else {
      const heldStage = transitionLifecycleWrite(entry.path, heldBase, {
        to_state: desiredState,
        reason_code: desiredState === "quarantined" ? "accepted_quarantined" : "accepted_held",
        reason: `Accepted memory failed lifecycle gate: ${reasonCodes.join(", ")}`,
        actor: reviewer,
        evidence_paths: [reviewPath, ...reviewRecord.evidence_paths],
        predecessor_paths: sourceCandidatePath ? [sourceCandidatePath, reviewPath] : [reviewPath],
        at: generatedAt,
        idempotency_key: `accepted-gate-failed|${entry.path}|${desiredState}`,
      });
      targetWrite = combineStages([acceptedStage, heldStage], entry.sha256);
    }
  }

  const existingReview = await (async () => {
    try {
      return await currentNodeRecord(dataRoot, reviewPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  })();
  const reviewBase = existingReview ? { ...existingReview.record, ...reviewRecord } : reviewRecord;
  const reviewStage = initializeLifecycleWrite(reviewPath, reviewBase, {
    to_state: desiredState === "accepted" ? "archived" : desiredState,
    reason_code: desiredState === "accepted" ? "accepted_review_attested" : "accepted_review_blocked",
    reason: desiredState === "accepted"
      ? "Existing accepted memory received a durable migration review attestation."
      : `Existing accepted memory was removed from hot retrieval: ${reasonCodes.join(", ")}`,
    actor: reviewer,
    evidence_paths: [entry.path, ...reviewRecord.evidence_paths],
    predecessor_paths: sourceCandidatePath ? [sourceCandidatePath] : [],
    successor_paths: desiredState === "accepted" ? [entry.path] : [],
    at: generatedAt,
    idempotency_key: `accepted-review-attestation|${entry.path}|${desiredState}`,
    sync_status: false,
  });
  if (existingReview) reviewStage.write.expected_before_sha256 = existingReview.sha256;
  else reviewStage.write.expected_before_sha256 = null;

  return {
    action: {
      type: actionType,
      target_path: entry.path,
      from_state: validation.ok ? currentState : "legacy",
      to_state: desiredState,
      review_path: reviewPath,
      reason_codes: unique(reasonCodes),
      pressure,
      applied: false,
      transition_ids: [...(targetWrite.transitions ?? []), ...(reviewStage.write.transitions ?? [])].map(
        (transition) => transition.transition_id,
      ),
    },
    writes: [targetWrite, reviewStage.write],
  };
}

async function auditAcceptedLifecycle(dataRoot: string): Promise<{
  accepted_files: number;
  retrievable: number;
  held_or_excluded: number;
  invalid: Array<{ path: string; issues: string[] }>;
}> {
  const accepted = await readJsonDir(dataRoot, "50_Instances/accepted");
  const invalid: Array<{ path: string; issues: string[] }> = [];
  let retrievable = 0;
  let heldOrExcluded = 0;
  for (const entry of accepted) {
    const validation = validateNodeLifecycleRecord(entry.record, entry.path);
    if (!validation.ok) {
      invalid.push({ path: entry.path, issues: validation.issues });
      continue;
    }
    const state = getNodeLifecycleState(entry.record, entry.path);
    if (state === "accepted") {
      const eligibility = await evaluateAcceptedEligibility(dataRoot, entry.path, entry.record);
      if (!eligibility.eligible) invalid.push({ path: entry.path, issues: eligibility.issues });
      else retrievable += 1;
    } else {
      heldOrExcluded += 1;
    }
  }
  return { accepted_files: accepted.length, retrievable, held_or_excluded: heldOrExcluded, invalid };
}

async function writeReport(dataRoot: string, id: string, report: JsonObject): Promise<string> {
  const reportPath = dataPath(dataRoot, ".dino", "lifecycle", `${id}.json`);
  await atomicWriteJson(reportPath, report);
  await atomicWriteJson(dataPath(dataRoot, ...NODE_LIFECYCLE_STATUS_PATH.split("/")), report);
  return relDataPath(dataRoot, reportPath);
}

async function readCurrentLifecycleStatus(dataRoot: string): Promise<JsonObject | null> {
  try {
    const parsed = JSON.parse(
      await fs.readFile(dataPath(dataRoot, ...NODE_LIFECYCLE_STATUS_PATH.split("/")), "utf8"),
    ) as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed as JsonObject : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof SyntaxError) return null;
    throw error;
  }
}

export async function rollbackNodeLifecycleMigration(
  dataRoot: string,
  transactionId: string,
  reviewer = "node-lifecycle-rollback",
): Promise<Record<string, unknown>> {
  const rolledBackAt = nowIso();
  const result = await rollbackNodeLifecycleTransaction(dataRoot, transactionId);
  const audit = await auditAcceptedLifecycle(dataRoot);
  const id = migrationId();
  const report = {
    version: NODE_LIFECYCLE_REPORT_VERSION,
    lifecycle_id: id,
    status: "rolled_back",
    operation: "rollback",
    reviewer,
    generated_at: rolledBackAt,
    rollback_transaction_id: transactionId,
    restored_paths: result.restored_paths,
    post_rollback_audit: audit,
  };
  const lifecyclePath = await writeReport(dataRoot, id, report);
  return { ok: true, lifecycle_path: lifecyclePath, ...report };
}

export async function applyNodeLifecycle(
  dataRoot: string,
  options: { apply: boolean; reviewer: string; rollbackTransactionId?: string | null },
): Promise<Record<string, unknown>> {
  if (options.rollbackTransactionId) {
    return rollbackNodeLifecycleMigration(dataRoot, options.rollbackTransactionId, options.reviewer);
  }
  const generatedAt = nowIso();
  const id = migrationId(new Date(generatedAt));
  const previousStatus = await readCurrentLifecycleStatus(dataRoot);
  const [accepted, candidates, promotionReviews, quarantines] = await Promise.all([
    readJsonDir(dataRoot, "50_Instances/accepted"),
    readJsonDir(dataRoot, "50_Instances/candidates"),
    readJsonDir(dataRoot, "80_Review_Queue/promotion"),
    readJsonDir(dataRoot, ".dino/quarantine"),
  ]);
  const byClaim = new Map<string, number>();
  const quarantinedTargets = new Set(
    quarantines.map((entry) => firstString(entry.record.target_path)).filter(Boolean),
  );
  for (const entry of accepted) {
    const key = claimKey(entry.record);
    if (key) byClaim.set(key, (byClaim.get(key) ?? 0) + 1);
  }
  const planned: PlannedMutation[] = [];
  for (const entry of accepted) {
    const currentState = getNodeLifecycleState(entry.record, entry.path);
    const validation = validateNodeLifecycleRecord(entry.record, entry.path);
    if (validation.ok && currentState !== "accepted") continue;
    if (validation.ok && currentState === "accepted") {
      const eligibility = await evaluateAcceptedEligibility(dataRoot, entry.path, entry.record);
      if (eligibility.eligible) continue;
    }
    const key = claimKey(entry.record);
    const mutation = await planAcceptedMutation(
      dataRoot,
      entry,
      options.reviewer,
      generatedAt,
      Math.max(0, (byClaim.get(key) ?? 1) - 1),
      quarantinedTargets.has(entry.path),
    );
    if (mutation) planned.push(mutation);
  }
  const git = await gitSnapshot(dataRoot, id, options.apply && planned.length > 0);
  const actions = planned.map((entry) => entry.action);
  let transaction: NodeLifecycleBatchResult | null = null;
  let postAudit = await auditAcceptedLifecycle(dataRoot);
  let automaticRollback: Record<string, unknown> | null = null;
  let applyError: string | null = null;

  if (options.apply && planned.length > 0) {
    try {
      transaction = await writeNodeLifecycleBatch(
        dataRoot,
        planned.flatMap((entry) => entry.writes),
        { actor: options.reviewer, reason: `Apply accepted memory lifecycle migration ${id}.` },
      );
      for (const action of actions) action.applied = true;
      postAudit = await auditAcceptedLifecycle(dataRoot);
      if (postAudit.invalid.length > 0 && transaction.transaction_id) {
        const invalidPaths = postAudit.invalid.map((entry) => entry.path).join(",");
        try {
          automaticRollback = await rollbackNodeLifecycleTransaction(dataRoot, transaction.transaction_id);
          applyError = `post_migration_audit_failed_and_rolled_back:${invalidPaths}`;
        } catch (error) {
          automaticRollback = { ok: false, error: String((error as Error).message ?? error) };
          applyError = `post_migration_audit_failed_and_rollback_blocked:${invalidPaths}`;
        }
        for (const action of actions) action.applied = false;
        postAudit = await auditAcceptedLifecycle(dataRoot);
      }
    } catch (error) {
      applyError = `transaction_failed:${String((error as Error).message ?? error)}`;
      for (const action of actions) action.applied = false;
      postAudit = await auditAcceptedLifecycle(dataRoot);
    }
  }

  const remainingBlockers = options.apply
    ? Math.max(postAudit.invalid.length, applyError ? 1 : 0)
    : Math.max(postAudit.invalid.length, actions.length);
  const status = applyError
    ? automaticRollback && automaticRollback.ok !== false ? "rolled_back" : "failed"
    : remainingBlockers === 0
      ? "healthy"
      : options.apply
        ? "blocked"
        : "review_required";
  const previousLastAppliedTransaction = previousStatus?.last_applied_transaction ??
    (previousStatus?.operation === "apply" && previousStatus?.status === "healthy" ? previousStatus.transaction : null);
  const previousLastRecoveryRef = previousStatus?.last_recovery_ref ??
    (previousStatus?.operation === "apply" && previousStatus?.status === "healthy"
      ? (previousStatus.git as JsonObject | undefined)?.recovery_ref ?? null
      : null);
  const previousLastAppliedAt = previousStatus?.last_applied_at ??
    (previousStatus?.operation === "apply" && previousStatus?.status === "healthy" ? previousStatus.generated_at : null);
  const appliedSuccessfully = options.apply && status === "healthy" && Boolean(transaction?.transaction_id);
  const report = {
    version: NODE_LIFECYCLE_REPORT_VERSION,
    lifecycle_id: id,
    status,
    operation: options.apply ? "apply" : "dry_run",
    apply: options.apply,
    reviewer: options.reviewer,
    generated_at: generatedAt,
    git,
    transaction,
    last_applied_transaction: appliedSuccessfully ? transaction : previousLastAppliedTransaction,
    last_recovery_ref: appliedSuccessfully ? git.recovery_ref : previousLastRecoveryRef,
    last_applied_at: appliedSuccessfully ? generatedAt : previousLastAppliedAt,
    automatic_rollback: automaticRollback,
    apply_error: applyError,
    counts: {
      accepted: accepted.length,
      candidates: candidates.length,
      promotion_reviews: promotionReviews.length,
      quarantined: quarantines.length,
      actions: actions.length,
      applied_actions: actions.filter((action) => action.applied).length,
      initialize_accepted: actions.filter((action) => action.type === "initialize_accepted").length,
      held_unsupported: actions.filter((action) => action.type === "hold_unsupported").length,
      quarantined_excluded: actions.filter((action) => action.type === "quarantine_excluded").length,
      repaired_invalid: actions.filter((action) => action.type === "repair_invalid_lifecycle").length,
      retrievable_accepted: postAudit.retrievable,
      held_or_excluded: postAudit.held_or_excluded,
      lifecycle_blockers: remainingBlockers,
      deferred_candidate_backlog: candidates.length,
      merge_candidates: actions.filter((action) => action.pressure.recommended_action === "merge").length,
      provenance_repairs: actions.filter((action) => action.reason_codes.some((reason) => reason.includes("provenance") || reason.includes("source"))).length,
      delete_candidates: actions.filter((action) => action.pressure.recommended_action === "deletion-review").length,
      hold_or_exclude: actions.filter((action) => ["held", "quarantined"].includes(action.to_state)).length,
    },
    post_audit: postAudit,
    actions,
    deferred_scope: {
      package: "MEM-02",
      candidate_backlog: candidates.length,
      policy: "No bulk candidate acceptance or rejection is performed by MEM-01.",
    },
  };
  const lifecyclePath = await writeReport(dataRoot, id, report);
  return { ok: remainingBlockers === 0 || !options.apply, lifecycle_path: lifecyclePath, ...report };
}
