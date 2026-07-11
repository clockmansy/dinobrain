import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import { atomicWriteJson } from "./concurrency.js";
import {
  getNodeLifecycleState,
  type NodeLifecycleState,
} from "./node-lifecycle.js";
import {
  currentNodeRecord,
  rollbackNodeLifecycleTransaction,
  transitionLifecycleWrite,
  writeNodeLifecycleBatch,
  type LifecycleBatchWrite,
} from "./node-lifecycle-store.js";
import { writeReviewGatedBatch, type ReviewGatedWriteItem } from "./review-backpressure.js";

export const CONTROLLED_COMPOUNDING_VERSION = "controlled_compounding_v2";
export const CONTROLLED_COMPOUNDING_PROPOSAL_VERSION = "controlled_compounding_proposal_v2";
export const CONTROLLED_COMPOUNDING_STATUS_RELATIVE_PATH = ".dino/state/controlled_compounding_status.json";
export const CONTROLLED_COMPOUNDING_ROOT = ".dino/compounding";
export const CONTROLLED_COMPOUNDING_PUBLIC_DIR = "60_Operations/controlled-compounding";

export const DEFAULT_CONTROLLED_COMPOUNDING_POLICY = {
  min_distinct_tasks: 2,
  max_signals_per_trace: 3,
  max_new_proposals_per_cycle: 20,
  max_active_proposals_per_topic: 8,
  max_hot_rules_total: 32,
  max_hot_rules_per_topic: 4,
  max_hot_rule_tokens: 4096,
  max_usage_records_per_source: 1000,
  demote_after_unused_days: 90,
  archive_after_unused_days: 365,
} as const;

type JsonObject = Record<string, unknown>;
type Confidence = "low" | "medium" | "high";

export type ControlledCompoundingPolicy = {
  min_distinct_tasks: number;
  max_signals_per_trace: number;
  max_new_proposals_per_cycle: number;
  max_active_proposals_per_topic: number;
  max_hot_rules_total: number;
  max_hot_rules_per_topic: number;
  max_hot_rule_tokens: number;
  max_usage_records_per_source: number;
  demote_after_unused_days: number;
  archive_after_unused_days: number;
};

export type CompoundingCycleOptions = {
  apply?: boolean;
  reviewer?: string;
  traceLimit?: number;
  now?: Date;
  policy?: Partial<ControlledCompoundingPolicy>;
  rollbackCyclePath?: string;
  reapplyCyclePath?: string;
  faultAfterProposalWriteIndexForTest?: number;
  faultAfterCleanupWriteIndexForTest?: number;
};

type VaultRecord = {
  path: string;
  record: JsonObject;
  mtimeMs: number;
  sha256: string;
};

type BehaviorEvidenceSource = {
  trace_path: string;
  trace_sha256: string;
  task_id: string;
  task_path: string;
  prompt_hash: string;
  signal_kind: "decision" | "next_step";
  snippet: string;
  outcome: string;
  observed_at: string;
};

type BehaviorSignal = {
  task_id: string;
  behavior_rule: string;
  normalized_rule: string;
  scope_key: string;
  topic_key: string;
  topic_label: string;
  source: BehaviorEvidenceSource;
};

type SignalGroup = {
  behavior_rule: string;
  normalized_rule: string;
  scope_key: string;
  topic_key: string;
  topic_label: string;
  signals: BehaviorSignal[];
};

type ProposalResult = {
  behavior_rule_id: string;
  behavior_rule: string;
  path: string | null;
  review_path: string | null;
  action: "created" | "updated" | "unchanged" | "planned" | "suppressed" | "already_accepted";
  reason_code: string;
  support_count: number;
  distinct_task_count: number;
  scope_key: string;
  topic_key: string;
  confidence: Confidence;
  contradiction_count: number;
};

type UsageObservation = {
  retrieval_count: number;
  use_count: number;
  last_retrieved_at: string | null;
  last_used_at: string | null;
};

type CleanupAction = {
  type: "merge_duplicate" | "hold_invalid" | "hold_contradicted" | "demote_low_use" | "archive_stale_low_use";
  target_path: string;
  kept_path?: string;
  reason: string;
  retrieval_count: number;
  use_count: number;
  applied: boolean;
};

export type ControlledCompoundingPromotionGate = {
  version: typeof CONTROLLED_COMPOUNDING_VERSION;
  eligible: boolean;
  issues: string[];
  checked_at: string;
  metrics: {
    support_count: number;
    distinct_task_count: number;
    verified_source_count: number;
    contradiction_count: number;
    hot_rule_count: number;
    hot_topic_count: number;
    projected_hot_rule_tokens: number;
  };
};

const NODE_LIFECYCLE_FIELDS = [
  "node_id",
  "lifecycle_version",
  "lifecycle_state",
  "lifecycle_state_entered_at",
  "lifecycle_last_transition_id",
  "lifecycle_history",
  "predecessor_paths",
  "successor_paths",
] as const;

function mergePreservingNodeLifecycle(existing: JsonObject | null, next: JsonObject): JsonObject {
  if (!existing) return next;
  const merged = { ...existing, ...next };
  for (const field of NODE_LIFECYCLE_FIELDS) if (existing[field] !== undefined) merged[field] = existing[field];
  if (typeof existing.created_at === "string") merged.created_at = existing.created_at;
  return merged;
}

function policyWith(input: Partial<ControlledCompoundingPolicy> | undefined): ControlledCompoundingPolicy {
  return { ...DEFAULT_CONTROLLED_COMPOUNDING_POLICY, ...(input ?? {}) };
}

function nowIso(now = new Date()): string {
  return now.toISOString();
}

function dateStamp(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function shortHash(value: string, length = 16): string {
  return sha256(value).slice(0, length);
}

function safeSlug(value: string): string {
  return value.trim().replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 96) || "node";
}

function isInside(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!!relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}

function dataPath(dataRoot: string, ...parts: string[]): string {
  const target = path.resolve(dataRoot, ...parts);
  if (!isInside(target, dataRoot)) throw new Error(`Path escapes data root: ${parts.join("/")}`);
  return target;
}

function normalizeVaultPath(value: string): string {
  const normalized = value.replace(/\\/g, "/").replace(/^\/+/, "").trim();
  if (!normalized || normalized.split("/").includes("..") || path.isAbsolute(normalized)) {
    throw new Error(`Invalid compounding vault path: ${value}`);
  }
  return normalized;
}

function relDataPath(dataRoot: string, filePath: string): string {
  return path.relative(dataRoot, filePath).split(path.sep).join("/");
}

function firstString(...values: unknown[]): string {
  for (const value of values) if (typeof value === "string" && value.trim()) return value.trim();
  return "";
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String).map((item) => item.trim()).filter(Boolean) : [];
}

function unique<T>(values: T[]): T[] {
  return Array.from(new Set(values));
}

function compact(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function normalizeRule(value: string): string {
  return compact(value).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").replace(/\s+/g, " ").trim();
}

function tags(record: JsonObject): string[] {
  return strings(record.tags).map((tag) => tag.toLowerCase());
}

function isBehaviorRecord(record: JsonObject): boolean {
  return record.type === "behavior_rule" || record.type === "feedback_correction" || typeof record.behavior_rule === "string" || tags(record).includes("behavior-rule");
}

function isControlledRecord(record: JsonObject): boolean {
  return record.proposal_version === CONTROLLED_COMPOUNDING_PROPOSAL_VERSION;
}

function lifecycleState(record: JsonObject, targetPath: string): NodeLifecycleState {
  return getNodeLifecycleState(record, targetPath);
}

async function readJson<T>(filePath: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function listJsonRecords(dataRoot: string, relativeDir: string): Promise<VaultRecord[]> {
  const dir = dataPath(dataRoot, relativeDir);
  let entries: Array<import("node:fs").Dirent>;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const records: VaultRecord[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const filePath = path.join(dir, entry.name);
    const bytes = await fs.readFile(filePath);
    try {
      const record = JSON.parse(bytes.toString("utf8")) as JsonObject;
      const stat = await fs.stat(filePath);
      records.push({ path: relDataPath(dataRoot, filePath), record, mtimeMs: stat.mtimeMs, sha256: sha256(bytes) });
    } catch {
      continue;
    }
  }
  return records.sort((a, b) => b.mtimeMs - a.mtimeMs || a.path.localeCompare(b.path));
}

function sensitiveHits(value: string): string[] {
  const patterns: Array<[string, RegExp]> = [
    ["credential_assignment", /\b(api[_-]?key|secret|token|password)\s*[:=]/i],
    ["private_key", /BEGIN [A-Z ]*PRIVATE KEY/],
    ["openai_key", /\bsk-[A-Za-z0-9_-]{20,}\b/],
    ["github_token", /\b(?:github_pat_[A-Za-z0-9_]{20,}|(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{20,})\b/],
    ["jwt", /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/],
  ];
  return patterns.filter(([, pattern]) => pattern.test(value)).map(([id]) => id);
}

const TERM_STOPWORDS = new Set([
  "about", "after", "again", "also", "always", "before", "being", "complete", "continue", "from", "have", "into", "must", "only", "should", "similar", "that", "their", "then", "this", "when", "with", "work", "future", "apply", "decision",
  "그리고", "그러면", "다시", "대한", "반드시", "사용", "작업", "진행", "확인", "해야", "한다", "한다면", "해당",
]);

function meaningfulTerms(value: string): string[] {
  return normalizeRule(value).split(" ").filter((term) => term.length >= 3 && !TERM_STOPWORDS.has(term));
}

function hasBehaviorCue(value: string): boolean {
  return /\b(always|never|must|should|do not|don't|prefer|verify|check|avoid|require|use|keep|preserve|treat|block|record)\b|무조건|항상|반드시|해야|하지\s*말|선호|검증|확인|기준|보존|차단|기록/i.test(value);
}

function toBehaviorRule(value: string): string {
  const text = compact(value);
  if (hasBehaviorCue(text)) return text;
  return `In similar future work, apply this decision: ${text}`;
}

function broadRuleReason(value: string): string | null {
  const terms = meaningfulTerms(value);
  if (terms.length < 4) return "rule_has_too_few_specific_terms";
  if (value.length > 420) return "rule_exceeds_420_char_limit";
  if (/^(done|completed|continue|looks good|important|fix it|next step)\b/i.test(compact(value))) return "rule_is_status_or_generic_instruction";
  if (/^(완료|계속|중요|다음|진행)/.test(compact(value)) && terms.length < 7) return "rule_is_status_or_generic_instruction";
  return null;
}

function topicLabel(value: string): string {
  const normalized = normalizeRule(value);
  const topics: Array<[string, RegExp]> = [
    ["release", /release|version|github|push|deploy|배포|버전|깃허브/],
    ["verification", /verify|test|proof|audit|evidence|검증|테스트|증거|감사/],
    ["memory", /memory|context|wiki|compounding|recall|기억|위키|복리/],
    ["retrieval", /retrieval|search|rag|embedding|rerank|검색|임베딩/],
    ["status", /status|report|progress|상태|보고|진행상황/],
    ["safety", /safe|safety|secret|sensitive|privacy|안전|보안|민감/],
    ["installer", /install|setup|uninstall|recovery|설치|복구|삭제/],
    ["interface", /observatory|graph|ui|design|화면|그래프|디자인/],
  ];
  const matched = topics.find(([, pattern]) => pattern.test(normalized));
  if (matched) return matched[0];
  return meaningfulTerms(value).slice(0, 3).join("-") || "general";
}

function negativePolarity(value: string): boolean {
  return /\b(do not|don't|never|avoid|must not|instead of|wrong)\b|하지\s*말|아니야|금지|대신/i.test(value);
}

function overlapCount(left: string, right: string): number {
  const rightTerms = new Set(meaningfulTerms(right));
  return unique(meaningfulTerms(left)).filter((term) => rightTerms.has(term)).length;
}

function confidenceFor(sources: BehaviorEvidenceSource[]): Confidence {
  const distinctTasks = new Set(sources.map((source) => source.task_id)).size;
  const decisionCount = sources.filter((source) => source.signal_kind === "decision").length;
  if (distinctTasks >= 3 && decisionCount >= 2) return "high";
  if (distinctTasks >= 2) return "medium";
  return "low";
}

function behaviorRuleId(scopeKey: string, rule: string): string {
  return `behavior-rule-v2-${shortHash(`${scopeKey}|${normalizeRule(rule)}`)}`;
}

function estimateTokens(value: string): number {
  return Math.max(1, Math.ceil(value.length / 4));
}

function mergeEvidenceSources(values: unknown[]): BehaviorEvidenceSource[] {
  const result: BehaviorEvidenceSource[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const source = value as Partial<BehaviorEvidenceSource>;
    const key = `${firstString(source.trace_path)}#${firstString(source.task_id)}#${firstString(source.signal_kind)}`;
    if (!firstString(source.trace_path) || !firstString(source.task_id) || seen.has(key)) continue;
    seen.add(key);
    result.push(source as BehaviorEvidenceSource);
  }
  return result.sort((a, b) => a.task_id.localeCompare(b.task_id) || a.trace_path.localeCompare(b.trace_path));
}

function extractSignals(
  trace: VaultRecord,
  task: VaultRecord,
  policy: ControlledCompoundingPolicy,
): { signals: BehaviorSignal[]; suppressed: Array<{ reason_code: string; task_id: string }> } {
  const taskId = firstString(trace.record.task_id);
  const taskPath = task.path;
  const promptHash = firstString(task.record.prompt_hash);
  const taskRequest = firstString(task.record.request);
  const outcome = firstString(trace.record.outcome);
  if (!taskId || task.record.task_id !== taskId || !promptHash || sha256(taskRequest) !== promptHash || outcome === "blocked") {
    return { signals: [], suppressed: [{ reason_code: "trace_task_provenance_unverified", task_id: taskId || "unknown" }] };
  }
  const project = safeSlug(firstString(task.record.project, "unknown")).toLowerCase();
  const scopeKey = `project:${project}`;
  const finishedAt = firstString(trace.record.finished_at, new Date(trace.mtimeMs).toISOString());
  const candidates: Array<{ kind: BehaviorEvidenceSource["signal_kind"]; value: string }> = [
    ...strings(trace.record.decisions).map((value) => ({ kind: "decision" as const, value })),
    ...strings(trace.record.next_steps).filter(hasBehaviorCue).map((value) => ({ kind: "next_step" as const, value })),
  ];
  const signals: BehaviorSignal[] = [];
  const suppressed: Array<{ reason_code: string; task_id: string }> = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    const rule = toBehaviorRule(candidate.value);
    const normalized = normalizeRule(rule);
    const qualityIssue = broadRuleReason(rule);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    if (sensitiveHits(rule).length > 0) {
      suppressed.push({ reason_code: "sensitive_signal", task_id: taskId });
      continue;
    }
    if (qualityIssue) {
      suppressed.push({ reason_code: qualityIssue, task_id: taskId });
      continue;
    }
    const label = topicLabel(rule);
    signals.push({
      task_id: taskId,
      behavior_rule: rule,
      normalized_rule: normalized,
      scope_key: scopeKey,
      topic_key: `${scopeKey}|topic:${label}`,
      topic_label: label,
      source: {
        trace_path: trace.path,
        trace_sha256: trace.sha256,
        task_id: taskId,
        task_path: taskPath,
        prompt_hash: promptHash,
        signal_kind: candidate.kind,
        snippet: compact(candidate.value).slice(0, 420),
        outcome,
        observed_at: finishedAt,
      },
    });
    if (signals.length >= policy.max_signals_per_trace) {
      if (candidates.length > signals.length) suppressed.push({ reason_code: "per_trace_signal_cap", task_id: taskId });
      break;
    }
  }
  return { signals, suppressed };
}

function groupSignals(signals: BehaviorSignal[]): SignalGroup[] {
  const groups = new Map<string, SignalGroup>();
  for (const signal of signals) {
    const key = `${signal.scope_key}|${signal.normalized_rule}`;
    const current = groups.get(key) ?? {
      behavior_rule: signal.behavior_rule,
      normalized_rule: signal.normalized_rule,
      scope_key: signal.scope_key,
      topic_key: signal.topic_key,
      topic_label: signal.topic_label,
      signals: [],
    };
    if (!current.signals.some((entry) => entry.task_id === signal.task_id)) current.signals.push(signal);
    groups.set(key, current);
  }
  return Array.from(groups.values()).sort((a, b) => b.signals.length - a.signals.length || a.normalized_rule.localeCompare(b.normalized_rule));
}

async function acceptedBehaviorRecords(dataRoot: string): Promise<VaultRecord[]> {
  return (await listJsonRecords(dataRoot, "50_Instances/accepted")).filter(
    (entry) => isBehaviorRecord(entry.record) && lifecycleState(entry.record, entry.path) === "accepted",
  );
}

function acceptedRuleRelations(
  group: Pick<SignalGroup, "behavior_rule" | "normalized_rule" | "scope_key">,
  accepted: VaultRecord[],
): { exact_path: string | null; contradiction_paths: string[] } {
  let exactPath: string | null = null;
  const contradictionPaths: string[] = [];
  for (const entry of accepted) {
    const acceptedRule = firstString(entry.record.behavior_rule, entry.record.reusable_rule, entry.record.claim, entry.record.summary);
    if (!acceptedRule) continue;
    const rawAcceptedScope = firstString(entry.record.scope_key, entry.record.applies_to, "project:unknown");
    const acceptedScope = rawAcceptedScope.startsWith("project:") ? rawAcceptedScope : "project:unknown";
    if (acceptedScope !== group.scope_key && acceptedScope !== "project:unknown" && group.scope_key !== "project:unknown") continue;
    const normalizedAccepted = normalizeRule(acceptedRule.replace(/^behavior rule\s*/i, ""));
    if (normalizedAccepted === group.normalized_rule || normalizeRule(acceptedRule) === group.normalized_rule) {
      exactPath = entry.path;
      continue;
    }
    if (negativePolarity(group.behavior_rule) !== negativePolarity(acceptedRule) && overlapCount(group.behavior_rule, acceptedRule) >= 3) {
      contradictionPaths.push(entry.path);
    }
  }
  return { exact_path: exactPath, contradiction_paths: unique(contradictionPaths).sort() };
}

async function validateEvidenceSources(
  dataRoot: string,
  sources: BehaviorEvidenceSource[],
): Promise<{ verified: number; issues: string[] }> {
  let verified = 0;
  const issues: string[] = [];
  for (const source of sources) {
    try {
      const tracePath = dataPath(dataRoot, normalizeVaultPath(source.trace_path));
      const traceBytes = await fs.readFile(tracePath);
      const trace = JSON.parse(traceBytes.toString("utf8")) as JsonObject;
      const task = await readJson<JsonObject>(dataPath(dataRoot, normalizeVaultPath(source.task_path)));
      if (sha256(traceBytes) !== source.trace_sha256) issues.push(`trace_hash_mismatch:${source.trace_path}`);
      else if (firstString(trace.task_id) !== source.task_id) issues.push(`trace_task_mismatch:${source.trace_path}`);
      else if (!task || firstString(task.task_id) !== source.task_id) issues.push(`task_binding_missing:${source.task_path}`);
      else if (firstString(task.prompt_hash) !== source.prompt_hash || sha256(firstString(task.request)) !== source.prompt_hash) {
        issues.push(`task_prompt_hash_mismatch:${source.task_path}`);
      } else if (firstString(trace.outcome) === "blocked") issues.push(`blocked_trace_not_eligible:${source.trace_path}`);
      else verified += 1;
    } catch {
      issues.push(`source_unreadable:${source.trace_path}`);
    }
  }
  return { verified, issues };
}

export async function evaluateControlledCompoundingPromotion(
  dataRoot: string,
  candidate: JsonObject,
  options: {
    reviewer: string;
    scopeApproved: boolean;
    now?: Date;
    policy?: Partial<ControlledCompoundingPolicy>;
  },
): Promise<ControlledCompoundingPromotionGate> {
  const policy = policyWith(options.policy);
  const checkedAt = nowIso(options.now ?? new Date());
  const sources = mergeEvidenceSources(Array.isArray(candidate.evidence_sources) ? candidate.evidence_sources : []);
  const distinctTasks = new Set(sources.map((source) => source.task_id)).size;
  const supportCount = Number(candidate.support_count ?? sources.length);
  const confidence = firstString(candidate.confidence).toLowerCase();
  const rule = firstString(candidate.behavior_rule);
  const topicKey = firstString(candidate.topic_key);
  const scopeKey = firstString(candidate.scope_key);
  const contradictions = strings(candidate.contradicted_memory_paths);
  const sourceValidation = await validateEvidenceSources(dataRoot, sources);
  const accepted = await acceptedBehaviorRecords(dataRoot);
  const controlledAccepted = accepted.filter((entry) => isControlledRecord(entry.record));
  const sameTopic = controlledAccepted.filter((entry) => firstString(entry.record.topic_key) === topicKey);
  const projectedTokens = controlledAccepted.reduce(
    (total, entry) => total + estimateTokens(firstString(entry.record.behavior_rule, entry.record.claim)),
    estimateTokens(rule),
  );
  const relations = acceptedRuleRelations(
    { behavior_rule: rule, normalized_rule: normalizeRule(rule), scope_key: scopeKey || "project:unknown" },
    accepted,
  );
  const issues = [
    candidate.proposal_version !== CONTROLLED_COMPOUNDING_PROPOSAL_VERSION ? "not_controlled_compounding_proposal_v2" : "",
    candidate.auto_generated !== true ? "proposal_not_marked_auto_generated" : "",
    !options.scopeApproved ? "compounding_scope_review_required" : "",
    !options.reviewer.trim() ? "independent_reviewer_missing" : "",
    options.reviewer.trim() === firstString(candidate.proposal_generated_by) ? "reviewer_not_independent_from_generator" : "",
    !rule ? "behavior_rule_missing" : "",
    broadRuleReason(rule) ? `broad_rule_blocked:${broadRuleReason(rule)}` : "",
    !scopeKey ? "scope_key_missing" : "",
    !topicKey ? "topic_key_missing" : "",
    supportCount < policy.min_distinct_tasks ? "recurrence_threshold_not_met" : "",
    distinctTasks < policy.min_distinct_tasks ? "distinct_task_threshold_not_met" : "",
    !["medium", "high"].includes(confidence) ? "confidence_below_medium" : "",
    sources.length !== supportCount ? "support_count_source_count_mismatch" : "",
    sourceValidation.verified !== sources.length ? "durable_provenance_not_verified" : "",
    ...sourceValidation.issues,
    contradictions.length > 0 || relations.contradiction_paths.length > 0 ? "unresolved_contradiction" : "",
    relations.exact_path ? "equivalent_reviewed_rule_already_exists" : "",
    controlledAccepted.length >= policy.max_hot_rules_total ? "hot_rule_total_cap_reached" : "",
    sameTopic.length >= policy.max_hot_rules_per_topic ? "hot_rule_topic_cap_reached" : "",
    projectedTokens > policy.max_hot_rule_tokens ? "hot_rule_token_budget_exceeded" : "",
  ].filter(Boolean);
  return {
    version: CONTROLLED_COMPOUNDING_VERSION,
    eligible: issues.length === 0,
    issues: unique(issues),
    checked_at: checkedAt,
    metrics: {
      support_count: supportCount,
      distinct_task_count: distinctTasks,
      verified_source_count: sourceValidation.verified,
      contradiction_count: unique([...contradictions, ...relations.contradiction_paths]).length,
      hot_rule_count: controlledAccepted.length,
      hot_topic_count: sameTopic.length,
      projected_hot_rule_tokens: projectedTokens,
    },
  };
}

async function buildProposalPlan(
  dataRoot: string,
  groups: SignalGroup[],
  accepted: VaultRecord[],
  options: {
    apply: boolean;
    reviewer: string;
    at: string;
    lastVerified: string;
    policy: ControlledCompoundingPolicy;
  },
): Promise<{ results: ProposalResult[]; items: ReviewGatedWriteItem[]; suppressed: Array<{ reason_code: string; count: number }> }> {
  const [candidates, reviews] = await Promise.all([
    listJsonRecords(dataRoot, "50_Instances/candidates"),
    listJsonRecords(dataRoot, "80_Review_Queue/promotion"),
  ]);
  const candidateByPath = new Map(candidates.map((entry) => [entry.path, entry]));
  const reviewByPath = new Map(reviews.map((entry) => [entry.path, entry]));
  const activeTopicCounts = new Map<string, number>();
  for (const entry of candidates) {
    if (!isControlledRecord(entry.record) || ["archived", "deleted-tombstone"].includes(lifecycleState(entry.record, entry.path))) continue;
    const topicKey = firstString(entry.record.topic_key);
    if (topicKey) activeTopicCounts.set(topicKey, (activeTopicCounts.get(topicKey) ?? 0) + 1);
  }

  const results: ProposalResult[] = [];
  const items: ReviewGatedWriteItem[] = [];
  const suppressedCounts = new Map<string, number>();
  let newProposalCount = 0;
  const suppress = (group: SignalGroup, reasonCode: string, supportCount: number, confidence: Confidence): void => {
    suppressedCounts.set(reasonCode, (suppressedCounts.get(reasonCode) ?? 0) + 1);
    results.push({
      behavior_rule_id: behaviorRuleId(group.scope_key, group.behavior_rule),
      behavior_rule: group.behavior_rule,
      path: null,
      review_path: null,
      action: "suppressed",
      reason_code: reasonCode,
      support_count: supportCount,
      distinct_task_count: supportCount,
      scope_key: group.scope_key,
      topic_key: group.topic_key,
      confidence,
      contradiction_count: 0,
    });
  };

  for (const group of groups) {
    const id = behaviorRuleId(group.scope_key, group.behavior_rule);
    const candidateRelativePath = `50_Instances/candidates/${id}.json`;
    const reviewRelativePath = `80_Review_Queue/promotion/${id}.json`;
    const existingCandidate = candidateByPath.get(candidateRelativePath);
    const existingReview = reviewByPath.get(reviewRelativePath);
    const sources = mergeEvidenceSources([
      ...(Array.isArray(existingCandidate?.record.evidence_sources) ? existingCandidate.record.evidence_sources : []),
      ...group.signals.map((signal) => signal.source),
    ]);
    const distinctTasks = new Set(sources.map((source) => source.task_id)).size;
    const confidence = confidenceFor(sources);
    if (distinctTasks < options.policy.min_distinct_tasks) {
      suppress(group, "single_occurrence_suppressed", distinctTasks, confidence);
      continue;
    }
    const relations = acceptedRuleRelations(group, accepted);
    if (relations.exact_path) {
      results.push({
        behavior_rule_id: id,
        behavior_rule: group.behavior_rule,
        path: relations.exact_path,
        review_path: null,
        action: "already_accepted",
        reason_code: "equivalent_reviewed_rule_already_exists",
        support_count: distinctTasks,
        distinct_task_count: distinctTasks,
        scope_key: group.scope_key,
        topic_key: group.topic_key,
        confidence,
        contradiction_count: relations.contradiction_paths.length,
      });
      continue;
    }
    const isNew = !existingCandidate;
    if (isNew && newProposalCount >= options.policy.max_new_proposals_per_cycle) {
      suppress(group, "cycle_new_proposal_cap", distinctTasks, confidence);
      continue;
    }
    if (isNew && (activeTopicCounts.get(group.topic_key) ?? 0) >= options.policy.max_active_proposals_per_topic) {
      suppress(group, "topic_proposal_cap", distinctTasks, confidence);
      continue;
    }
    if (isNew) {
      newProposalCount += 1;
      activeTopicCounts.set(group.topic_key, (activeTopicCounts.get(group.topic_key) ?? 0) + 1);
    }
    const sourceFingerprint = sha256(JSON.stringify(sources.map((source) => ({
      trace_path: source.trace_path,
      trace_sha256: source.trace_sha256,
      task_id: source.task_id,
      signal_kind: source.signal_kind,
    }))));
    const existingFingerprint = firstString(existingCandidate?.record.source_fingerprint);
    const action: ProposalResult["action"] = isNew ? "created" : existingFingerprint === sourceFingerprint ? "unchanged" : "updated";
    const promotionBlockers = [
      "manual_review_required",
      "independent_review_required",
      "compounding_scope_review_required",
      ...(relations.contradiction_paths.length > 0 ? ["contradiction_resolution_required"] : []),
    ];
    const firstSource = sources[0];
    if (!firstSource) {
      suppress(group, "durable_sources_missing", distinctTasks, confidence);
      continue;
    }
    const candidateBase = mergePreservingNodeLifecycle(existingCandidate?.record ?? null, {
      candidate_id: id,
      behavior_rule_id: id,
      type: "behavior_rule_proposal",
      proposal_version: CONTROLLED_COMPOUNDING_PROPOSAL_VERSION,
      status: firstString(existingCandidate?.record.status, "pending_review"),
      claim: `Behavior rule proposal: ${group.behavior_rule}`,
      behavior_rule: group.behavior_rule,
      category: "agent_behavior",
      scope_key: group.scope_key,
      topic_key: group.topic_key,
      topic_label: group.topic_label,
      evidence: { source: firstSource.trace_path, snippet: firstSource.snippet },
      evidence_sources: sources,
      source_fingerprint: sourceFingerprint,
      task_ids: unique(sources.map((source) => source.task_id)),
      source_status: "internal",
      confidence,
      last_verified: options.lastVerified,
      support_count: sources.length,
      distinct_task_count: distinctTasks,
      recurrence_threshold: options.policy.min_distinct_tasks,
      contradicted_memory_paths: relations.contradiction_paths,
      contradiction_count: relations.contradiction_paths.length,
      behavior_action: {
        memory_off_action: "continue without this recurring reviewed rule",
        expected_memory_on_action: group.behavior_rule,
      },
      tags: unique(["behavior-rule", "controlled-compounding", "auto-compounded", `confidence:${confidence}`, `topic:${group.topic_label}`]),
      auto_generated: true,
      auto_promote: false,
      proposal_generated_by: options.reviewer,
      promotion_blockers: promotionBlockers,
      created_at: firstString(existingCandidate?.record.created_at, options.at),
      updated_at: options.at,
      last_seen_at: options.at,
    });
    const reviewBase = mergePreservingNodeLifecycle(existingReview?.record ?? null, {
      review_id: id,
      type: "controlled_compounding_promotion",
      status: firstString(existingReview?.record.status, "pending"),
      candidate_path: candidateRelativePath,
      scope_key: group.scope_key,
      topic_key: group.topic_key,
      support_count: sources.length,
      distinct_task_count: distinctTasks,
      contradiction_count: relations.contradiction_paths.length,
      required_checks: ["independent_review", "recurrence", "confidence", "scope", "durable_provenance", "contradiction", "hot_rule_budget"],
      promotion_blockers: promotionBlockers,
      created_at: firstString(existingReview?.record.created_at, options.at),
      updated_at: options.at,
    });
    const candidateRecord = candidateBase;
    const reviewRecord = reviewBase;
    results.push({
      behavior_rule_id: id,
      behavior_rule: group.behavior_rule,
      path: candidateRelativePath,
      review_path: reviewRelativePath,
      action: options.apply ? action : action === "unchanged" ? "unchanged" : "planned",
      reason_code: action === "unchanged" ? "proposal_evidence_unchanged" : "recurrence_gate_satisfied",
      support_count: sources.length,
      distinct_task_count: distinctTasks,
      scope_key: group.scope_key,
      topic_key: group.topic_key,
      confidence,
      contradiction_count: relations.contradiction_paths.length,
    });
    if (action !== "unchanged") {
      items.push({
        idempotency_key: `controlled-compounding|${id}|${sourceFingerprint}`,
        lane: "manual_semantic",
        candidate_path: candidateRelativePath,
        candidate_record: candidateRecord,
        review_path: reviewRelativePath,
        review_record: reviewRecord,
        candidate_evidence_paths: sources.map((source) => source.trace_path),
        review_evidence_paths: [candidateRelativePath, ...sources.map((source) => source.trace_path)],
        predecessor_paths: sources.flatMap((source) => [source.trace_path, source.task_path]),
        candidate_transition_id: `node-transition-controlled-queue-${shortHash(`${id}|${sourceFingerprint}|candidate`, 24)}`,
        review_transition_id: `node-transition-controlled-queue-${shortHash(`${id}|${sourceFingerprint}|review`, 24)}`,
        at: options.at,
      });
    }
  }
  return {
    results,
    items,
    suppressed: Array.from(suppressedCounts.entries()).map(([reason_code, count]) => ({ reason_code, count })),
  };
}

async function collectUsageObservations(
  dataRoot: string,
  policy: ControlledCompoundingPolicy,
): Promise<{ observations: Map<string, UsageObservation>; context_pack_count: number; trace_count: number }> {
  const [packs, traces] = await Promise.all([
    listJsonRecords(dataRoot, ".dino/context-packs"),
    listJsonRecords(dataRoot, ".dino/traces"),
  ]);
  const observations = new Map<string, UsageObservation>();
  const get = (targetPath: string): UsageObservation => observations.get(targetPath) ?? {
    retrieval_count: 0,
    use_count: 0,
    last_retrieved_at: null,
    last_used_at: null,
  };
  const limitedPacks = packs.slice(0, policy.max_usage_records_per_source);
  for (const pack of limitedPacks) {
    const at = firstString(pack.record.generated_at, new Date(pack.mtimeMs).toISOString());
    for (const item of Array.isArray(pack.record.items) ? pack.record.items : []) {
      if (!item || typeof item !== "object" || Array.isArray(item)) continue;
      const targetPath = firstString((item as JsonObject).path);
      if (!targetPath) continue;
      const current = get(targetPath);
      current.retrieval_count += 1;
      if (!current.last_retrieved_at || at > current.last_retrieved_at) current.last_retrieved_at = at;
      observations.set(targetPath, current);
    }
  }
  const limitedTraces = traces.slice(0, policy.max_usage_records_per_source);
  for (const trace of limitedTraces) {
    const at = firstString(trace.record.finished_at, new Date(trace.mtimeMs).toISOString());
    for (const targetPath of strings(trace.record.used_memory_paths)) {
      const current = get(targetPath);
      current.use_count += 1;
      if (!current.last_used_at || at > current.last_used_at) current.last_used_at = at;
      observations.set(targetPath, current);
    }
  }
  return { observations, context_pack_count: limitedPacks.length, trace_count: limitedTraces.length };
}

function ageDays(record: JsonObject, now: Date): number | null {
  const value = firstString(record.accepted_at, record.reviewed_at, record.created_at, record.updated_at);
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? Math.max(0, (now.getTime() - parsed) / 86_400_000) : null;
}

function usageFor(observations: Map<string, UsageObservation>, targetPath: string): UsageObservation {
  return observations.get(targetPath) ?? { retrieval_count: 0, use_count: 0, last_retrieved_at: null, last_used_at: null };
}

async function cleanupPlan(
  dataRoot: string,
  accepted: VaultRecord[],
  observations: Map<string, UsageObservation>,
  policy: ControlledCompoundingPolicy,
  now: Date,
): Promise<CleanupAction[]> {
  const controlled = accepted.filter((entry) => isControlledRecord(entry.record));
  const actions = new Map<string, CleanupAction>();
  const add = (entry: VaultRecord, type: CleanupAction["type"], reason: string, keptPath?: string): void => {
    if (actions.has(entry.path)) return;
    const usage = usageFor(observations, entry.path);
    actions.set(entry.path, {
      type,
      target_path: entry.path,
      ...(keptPath ? { kept_path: keptPath } : {}),
      reason,
      retrieval_count: usage.retrieval_count,
      use_count: usage.use_count,
      applied: false,
    });
  };

  for (const entry of controlled) {
    const sources = mergeEvidenceSources(Array.isArray(entry.record.evidence_sources) ? entry.record.evidence_sources : []);
    const gate = entry.record.controlled_compounding_gate as JsonObject | undefined;
    const sourceValidation = await validateEvidenceSources(dataRoot, sources);
    if (
      sources.length < policy.min_distinct_tasks ||
      entry.record.independently_reviewed !== true ||
      gate?.eligible !== true ||
      sourceValidation.verified !== sources.length
    ) {
      add(entry, "hold_invalid", "controlled behavior rule lacks independently reviewed recurrence/provenance gate evidence");
      continue;
    }
    const relations = acceptedRuleRelations(
      {
        behavior_rule: firstString(entry.record.behavior_rule, entry.record.claim),
        normalized_rule: normalizeRule(firstString(entry.record.behavior_rule, entry.record.claim)),
        scope_key: firstString(entry.record.scope_key, "project:unknown"),
      },
      accepted.filter((candidate) => candidate.path !== entry.path),
    );
    if (relations.contradiction_paths.length > 0) {
      add(entry, "hold_contradicted", `observed ${relations.contradiction_paths.length} unresolved reviewed contradictions`);
    }
  }

  const byRule = new Map<string, VaultRecord[]>();
  for (const entry of controlled.filter((item) => !actions.has(item.path))) {
    const key = `${firstString(entry.record.scope_key)}|${normalizeRule(firstString(entry.record.behavior_rule, entry.record.claim))}`;
    if (!key.endsWith("|")) byRule.set(key, [...(byRule.get(key) ?? []), entry]);
  }
  for (const duplicates of byRule.values()) {
    if (duplicates.length < 2) continue;
    const [keeper, ...rest] = duplicates.sort((left, right) => {
      const leftUsage = usageFor(observations, left.path);
      const rightUsage = usageFor(observations, right.path);
      const useDelta = rightUsage.use_count + rightUsage.retrieval_count - leftUsage.use_count - leftUsage.retrieval_count;
      if (useDelta !== 0) return useDelta;
      const supportDelta = Number(right.record.support_count ?? 0) - Number(left.record.support_count ?? 0);
      return supportDelta || left.path.localeCompare(right.path);
    });
    if (!keeper) continue;
    for (const duplicate of rest) add(duplicate, "merge_duplicate", "duplicate controlled behavior rule in the same scope", keeper.path);
  }

  for (const entry of controlled.filter((item) => !actions.has(item.path))) {
    const usage = usageFor(observations, entry.path);
    if (usage.retrieval_count > 0 || usage.use_count > 0) continue;
    const age = ageDays(entry.record, now);
    if (age !== null && age >= policy.archive_after_unused_days) {
      add(entry, "archive_stale_low_use", `unused controlled rule is ${Math.floor(age)} days old`);
    } else if (age !== null && age >= policy.demote_after_unused_days) {
      add(entry, "demote_low_use", `unused controlled rule is ${Math.floor(age)} days old`);
    }
  }
  return Array.from(actions.values()).sort((a, b) => a.target_path.localeCompare(b.target_path));
}

async function applyCleanupPlan(
  dataRoot: string,
  actions: CleanupAction[],
  observations: Map<string, UsageObservation>,
  options: { reviewer: string; at: string; cycleId: string; faultAfterWriteIndexForTest?: number },
): Promise<{ transaction_id: string | null; transaction_path: string | null; usage_snapshot_path: string | null }> {
  if (actions.length === 0) return { transaction_id: null, transaction_path: null, usage_snapshot_path: null };
  const usageSnapshotPath = `${CONTROLLED_COMPOUNDING_ROOT}/${options.cycleId}-usage.json`;
  const writes: LifecycleBatchWrite[] = [{
    target_path: usageSnapshotPath,
    record: {
      version: CONTROLLED_COMPOUNDING_VERSION,
      cycle_id: options.cycleId,
      generated_at: options.at,
      observations: actions.map((action) => ({
        target_path_hash: sha256(action.target_path),
        retrieval_count: action.retrieval_count,
        use_count: action.use_count,
        last_retrieved_at: usageFor(observations, action.target_path).last_retrieved_at,
        last_used_at: usageFor(observations, action.target_path).last_used_at,
      })),
    },
    expected_before_sha256: null,
  }];

  const mergeGroups = new Map<string, CleanupAction[]>();
  for (const action of actions.filter((item) => item.type === "merge_duplicate" && item.kept_path)) {
    mergeGroups.set(action.kept_path!, [...(mergeGroups.get(action.kept_path!) ?? []), action]);
  }
  for (const [keeperPath, group] of mergeGroups) {
    const keeperState = await currentNodeRecord(dataRoot, keeperPath);
    const duplicateStates = await Promise.all(group.map((action) => currentNodeRecord(dataRoot, action.target_path)));
    const sources = mergeEvidenceSources([
      ...(Array.isArray(keeperState.record.evidence_sources) ? keeperState.record.evidence_sources : []),
      ...duplicateStates.flatMap((state) => Array.isArray(state.record.evidence_sources) ? state.record.evidence_sources : []),
    ]);
    writes.push({
      target_path: keeperPath,
      record: {
        ...keeperState.record,
        evidence_sources: sources,
        support_count: sources.length,
        merged_from: unique([
          ...strings(keeperState.record.merged_from),
          ...group.map((action) => action.target_path),
        ]),
        observed_usage: usageFor(observations, keeperPath),
        updated_at: options.at,
      },
      transitions: [],
      expected_before_sha256: keeperState.sha256,
    });
  }

  for (const action of actions) {
    const state = await currentNodeRecord(dataRoot, action.target_path);
    const targetState: NodeLifecycleState = action.type === "merge_duplicate" || action.type === "archive_stale_low_use"
      ? "archived"
      : action.type === "demote_low_use"
        ? "demoted"
        : "held";
    const updatedRecord = {
      ...state.record,
      observed_usage: usageFor(observations, action.target_path),
      lifecycle_action: action.type,
      lifecycle_reason: action.reason,
      ...(targetState === "held" ? {
        quarantine: true,
        temperature: "cold",
        hold_reason: action.reason,
        held_by: options.reviewer,
        held_at: options.at,
      } : {}),
      ...(targetState === "demoted" ? { temperature: "cold", demoted_at: options.at } : {}),
      ...(targetState === "archived" ? { temperature: "cold", archived_at: options.at } : {}),
      ...(action.kept_path ? { merged_into: action.kept_path } : {}),
      updated_at: options.at,
    };
    const transition = transitionLifecycleWrite(action.target_path, updatedRecord, {
      to_state: targetState,
      reason_code: `controlled_compounding_${action.type}`,
      reason: action.reason,
      actor: options.reviewer,
      evidence_paths: [usageSnapshotPath],
      ...(action.kept_path ? { successor_paths: [action.kept_path] } : {}),
      at: options.at,
      transition_id: `node-transition-controlled-cleanup-${shortHash(`${action.type}|${action.target_path}|${options.at}`, 24)}`,
      idempotency_key: `${options.cycleId}|${action.type}|${action.target_path}`,
    });
    transition.write.expected_before_sha256 = state.sha256;
    writes.push(transition.write);
  }
  const transaction = await writeNodeLifecycleBatch(dataRoot, writes, {
    actor: options.reviewer,
    reason: `Apply ${actions.length} controlled compounding lifecycle actions.`,
    fault_after_write_index_for_test: options.faultAfterWriteIndexForTest,
  });
  for (const action of actions) action.applied = true;
  return {
    transaction_id: transaction.transaction_id,
    transaction_path: transaction.transaction_path,
    usage_snapshot_path: usageSnapshotPath,
  };
}

type JsonFileState = {
  record: JsonObject | null;
  sha256: string | null;
};

type ControlledCompoundingStatus = {
  version: typeof CONTROLLED_COMPOUNDING_VERSION;
  status: "healthy" | "needs_attention";
  generated_at: string;
  latest_verified_at: string | null;
  data_root: string;
  policy: ControlledCompoundingPolicy;
  counts: {
    controlled_candidates: number;
    recurring_controlled_candidates: number;
    controlled_accepted_rules: number;
    legacy_generated_candidates_excluded: number;
    hot_rule_tokens: number;
    retrieved_controlled_rules: number;
    used_controlled_rules: number;
    max_active_proposals_in_topic: number;
  };
  checks: Array<{ id: string; ok: boolean; observed: number; limit: number | null; reason: string | null }>;
  blockers: string[];
  warnings: string[];
  latest_cycle_path: string | null;
  visible_status: string;
};

async function readJsonFileState(dataRoot: string, relativePath: string): Promise<JsonFileState> {
  const filePath = dataPath(dataRoot, normalizeVaultPath(relativePath));
  try {
    const bytes = await fs.readFile(filePath);
    return { record: JSON.parse(bytes.toString("utf8")) as JsonObject, sha256: sha256(bytes) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { record: null, sha256: null };
    throw error;
  }
}

function withoutVolatileFields(record: JsonObject, fields: string[]): JsonObject {
  const next = { ...record };
  for (const field of fields) delete next[field];
  return next;
}

function stableGeneratedRecord(existing: JsonObject | null, next: JsonObject, volatileFields: string[]): JsonObject {
  if (!existing) return next;
  if (JSON.stringify(withoutVolatileFields(existing, volatileFields)) === JSON.stringify(withoutVolatileFields(next, volatileFields))) {
    return existing;
  }
  return next;
}

function behaviorRuleIndexRecord(
  accepted: VaultRecord[],
  observations: Map<string, UsageObservation>,
  generatedAt: string,
): JsonObject {
  const records = accepted
    .map((entry) => {
      const observed = usageFor(observations, entry.path);
      return {
        path: entry.path,
        behavior_rule: firstString(entry.record.behavior_rule, entry.record.claim),
        status: firstString(entry.record.status, "accepted"),
        controlled_compounding: isControlledRecord(entry.record),
        independently_reviewed: entry.record.independently_reviewed === true,
        support_count: Number(entry.record.support_count ?? 0),
        distinct_task_count: Number(entry.record.distinct_task_count ?? 0),
        confidence: firstString(entry.record.confidence, "unknown"),
        scope_key: firstString(entry.record.scope_key) || null,
        topic_key: firstString(entry.record.topic_key) || null,
        retrieval_count: observed.retrieval_count,
        use_count: observed.use_count,
        last_retrieved_at: observed.last_retrieved_at,
        last_used_at: observed.last_used_at,
        last_verified: firstString(entry.record.last_verified) || null,
      };
    })
    .sort((left, right) => left.path.localeCompare(right.path));
  return {
    version: CONTROLLED_COMPOUNDING_VERSION,
    generated_at: generatedAt,
    record_count: records.length,
    controlled_record_count: records.filter((entry) => entry.controlled_compounding).length,
    records,
  };
}

async function buildControlledCompoundingStatusRecord(
  dataRoot: string,
  input: {
    generatedAt: string;
    policy: ControlledCompoundingPolicy;
    observations: Map<string, UsageObservation>;
    latestCyclePath: string | null;
  },
): Promise<ControlledCompoundingStatus> {
  const [allCandidates, accepted] = await Promise.all([
    listJsonRecords(dataRoot, "50_Instances/candidates"),
    acceptedBehaviorRecords(dataRoot),
  ]);
  const controlledCandidates = allCandidates.filter(
    (entry) => isControlledRecord(entry.record) && !["archived", "deleted-tombstone"].includes(lifecycleState(entry.record, entry.path)),
  );
  const legacyGeneratedCandidates = allCandidates.filter(
    (entry) => entry.record.auto_generated === true && !isControlledRecord(entry.record),
  );
  const controlledAccepted = accepted.filter((entry) => isControlledRecord(entry.record));
  const topicCounts = new Map<string, number>();
  for (const entry of controlledCandidates) {
    const topicKey = firstString(entry.record.topic_key, "topic:missing");
    topicCounts.set(topicKey, (topicCounts.get(topicKey) ?? 0) + 1);
  }
  const maxActiveInTopic = Math.max(0, ...topicCounts.values());
  const hotTokens = controlledAccepted.reduce(
    (total, entry) => total + estimateTokens(firstString(entry.record.behavior_rule, entry.record.claim)),
    0,
  );
  const invalidAccepted = (await Promise.all(controlledAccepted.map(async (entry) => {
    const sources = mergeEvidenceSources(Array.isArray(entry.record.evidence_sources) ? entry.record.evidence_sources : []);
    const gate = entry.record.controlled_compounding_gate as JsonObject | undefined;
    const validation = await validateEvidenceSources(dataRoot, sources);
    const invalid = entry.record.independently_reviewed !== true ||
      gate?.eligible !== true ||
      new Set(sources.map((source) => source.task_id)).size < input.policy.min_distinct_tasks ||
      strings(entry.record.contradicted_memory_paths).length > 0 ||
      validation.verified !== sources.length;
    return invalid ? entry : null;
  }))).filter((entry): entry is VaultRecord => entry !== null);
  const underSupportedCandidates = controlledCandidates.filter(
    (entry) => Number(entry.record.distinct_task_count ?? 0) < input.policy.min_distinct_tasks,
  );
  const checks = [
    {
      id: "reviewed_knowledge_separated_from_generated_proposals",
      ok: invalidAccepted.length === 0,
      observed: invalidAccepted.length,
      limit: 0,
      reason: invalidAccepted.length === 0 ? null : "controlled accepted rules failed independent review or promotion gate",
    },
    {
      id: "recurrence_gate_applied_to_persisted_proposals",
      ok: underSupportedCandidates.length === 0,
      observed: underSupportedCandidates.length,
      limit: 0,
      reason: underSupportedCandidates.length === 0 ? null : "persisted controlled proposals are below recurrence threshold",
    },
    {
      id: "active_proposal_topic_cap",
      ok: maxActiveInTopic <= input.policy.max_active_proposals_per_topic,
      observed: maxActiveInTopic,
      limit: input.policy.max_active_proposals_per_topic,
      reason: maxActiveInTopic <= input.policy.max_active_proposals_per_topic ? null : "active proposal topic cap exceeded",
    },
    {
      id: "hot_rule_total_cap",
      ok: controlledAccepted.length <= input.policy.max_hot_rules_total,
      observed: controlledAccepted.length,
      limit: input.policy.max_hot_rules_total,
      reason: controlledAccepted.length <= input.policy.max_hot_rules_total ? null : "hot controlled rule cap exceeded",
    },
    {
      id: "hot_rule_token_cap",
      ok: hotTokens <= input.policy.max_hot_rule_tokens,
      observed: hotTokens,
      limit: input.policy.max_hot_rule_tokens,
      reason: hotTokens <= input.policy.max_hot_rule_tokens ? null : "hot controlled rule token budget exceeded",
    },
  ];
  const blockers = checks.filter((check) => !check.ok).map((check) => check.id);
  const status = blockers.length === 0 ? "healthy" : "needs_attention";
  return {
    version: CONTROLLED_COMPOUNDING_VERSION,
    status,
    generated_at: input.generatedAt,
    latest_verified_at: status === "healthy" ? input.generatedAt : null,
    data_root: path.resolve(dataRoot),
    policy: input.policy,
    counts: {
      controlled_candidates: controlledCandidates.length,
      recurring_controlled_candidates: controlledCandidates.length - underSupportedCandidates.length,
      controlled_accepted_rules: controlledAccepted.length,
      legacy_generated_candidates_excluded: legacyGeneratedCandidates.length,
      hot_rule_tokens: hotTokens,
      retrieved_controlled_rules: controlledAccepted.filter((entry) => usageFor(input.observations, entry.path).retrieval_count > 0).length,
      used_controlled_rules: controlledAccepted.filter((entry) => usageFor(input.observations, entry.path).use_count > 0).length,
      max_active_proposals_in_topic: maxActiveInTopic,
    },
    checks,
    blockers,
    warnings: legacyGeneratedCandidates.length > 0 ? ["legacy_generated_candidates_excluded_from_controlled_hot_set"] : [],
    latest_cycle_path: input.latestCyclePath,
    visible_status: status === "healthy"
      ? "Controlled compounding bounded and review-gated"
      : "Controlled compounding needs attention",
  };
}

export async function buildControlledCompoundingStatus(
  dataRoot: string,
  options: { now?: Date; policy?: Partial<ControlledCompoundingPolicy>; latestCyclePath?: string | null } = {},
): Promise<ControlledCompoundingStatus> {
  const policy = policyWith(options.policy);
  const usage = await collectUsageObservations(dataRoot, policy);
  const latestCyclePath = options.latestCyclePath !== undefined
    ? options.latestCyclePath
    : (await listJsonRecords(dataRoot, CONTROLLED_COMPOUNDING_ROOT)).find(
        (entry) => entry.record.version === CONTROLLED_COMPOUNDING_VERSION && entry.record.cycle_status === "applied",
      )?.path ?? null;
  return buildControlledCompoundingStatusRecord(dataRoot, {
    generatedAt: nowIso(options.now ?? new Date()),
    policy,
    observations: usage.observations,
    latestCyclePath,
  });
}

export async function buildAndWriteControlledCompoundingStatus(
  dataRoot: string,
  options: { now?: Date; policy?: Partial<ControlledCompoundingPolicy>; latestCyclePath?: string | null } = {},
): Promise<{ report: ControlledCompoundingStatus; path: string }> {
  const report = await buildControlledCompoundingStatus(dataRoot, options);
  const filePath = dataPath(dataRoot, ...CONTROLLED_COMPOUNDING_STATUS_RELATIVE_PATH.split("/"));
  await atomicWriteJson(filePath, report);
  return { report, path: CONTROLLED_COMPOUNDING_STATUS_RELATIVE_PATH };
}

async function rollbackCycle(dataRoot: string, cycleRelativePath: string): Promise<Record<string, unknown>> {
  const normalized = normalizeVaultPath(cycleRelativePath);
  const cyclePath = dataPath(dataRoot, normalized);
  const report = await readJson<JsonObject>(cyclePath);
  if (!report || report.version !== CONTROLLED_COMPOUNDING_VERSION) {
    throw new Error(`Controlled compounding cycle report is missing or incompatible: ${normalized}`);
  }
  const transactionIds = strings(report.transaction_ids);
  const restoredPaths: string[] = [];
  for (const transactionId of [...transactionIds].reverse()) {
    const rolledBack = await rollbackNodeLifecycleTransaction(dataRoot, transactionId);
    restoredPaths.push(...rolledBack.restored_paths);
  }
  const rolledBackAt = nowIso();
  const next = {
    ...report,
    cycle_status: "rolled_back",
    rolled_back_at: rolledBackAt,
    rollback_restored_paths: unique(restoredPaths).sort(),
  };
  await atomicWriteJson(cyclePath, next);
  return {
    ok: true,
    version: CONTROLLED_COMPOUNDING_VERSION,
    action: "rollback",
    cycle_status: "rolled_back",
    cycle_id: firstString(report.cycle_id),
    cycle_path: normalized,
    changed: restoredPaths.length > 0,
    restored_paths: unique(restoredPaths).sort(),
    transaction_ids: transactionIds,
    reapply_supported: true,
  };
}

async function compensateTransactions(dataRoot: string, transactionIds: string[]): Promise<string[]> {
  const errors: string[] = [];
  for (const transactionId of [...transactionIds].reverse()) {
    try {
      await rollbackNodeLifecycleTransaction(dataRoot, transactionId);
    } catch (error) {
      errors.push(`${transactionId}:${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return errors;
}

export async function runCompoundingCycle(
  dataRoot: string,
  options: CompoundingCycleOptions = {},
): Promise<Record<string, unknown>> {
  if (options.rollbackCyclePath && options.reapplyCyclePath) {
    throw new Error("rollbackCyclePath and reapplyCyclePath are mutually exclusive");
  }
  if (options.rollbackCyclePath) return rollbackCycle(dataRoot, options.rollbackCyclePath);

  let replayReport: JsonObject | null = null;
  if (options.reapplyCyclePath) {
    replayReport = await readJson<JsonObject>(dataPath(dataRoot, normalizeVaultPath(options.reapplyCyclePath)));
    if (!replayReport || replayReport.version !== CONTROLLED_COMPOUNDING_VERSION || replayReport.cycle_status !== "rolled_back") {
      throw new Error("Controlled compounding reapply requires a rolled-back v2 cycle report");
    }
  }

  const policy = policyWith(options.policy ?? (replayReport?.policy as Partial<ControlledCompoundingPolicy> | undefined));
  const atDate = replayReport ? new Date(firstString(replayReport.generated_at)) : options.now ?? new Date();
  if (!Number.isFinite(atDate.getTime())) throw new Error("Controlled compounding cycle time is invalid");
  const at = nowIso(atDate);
  const apply = options.apply ?? true;
  const reviewer = options.reviewer ?? firstString(replayReport?.reviewer, "controlled-compounding-generator");
  const traceLimit = Math.max(1, Math.min(200, options.traceLimit ?? Number(replayReport?.trace_limit ?? 50)));
  const cycleId = replayReport
    ? firstString(replayReport.cycle_id)
    : `controlled-compounding-cycle-${at.replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "-")}-${randomUUID()}`;
  if (!/^controlled-compounding-cycle-[A-Za-z0-9-]+$/.test(cycleId)) throw new Error("Controlled compounding cycle id is invalid");
  const cycleRelativePath = `${CONTROLLED_COMPOUNDING_ROOT}/${cycleId}.json`;
  const cycleAbsolutePath = dataPath(dataRoot, cycleRelativePath);

  const [traces, tasks, acceptedBefore] = await Promise.all([
    listJsonRecords(dataRoot, ".dino/traces"),
    listJsonRecords(dataRoot, ".dino/tasks"),
    acceptedBehaviorRecords(dataRoot),
  ]);
  const selectedTraces = traces.slice(0, traceLimit);
  const tasksById = new Map(tasks.map((entry) => [firstString(entry.record.task_id), entry]));
  const signals: BehaviorSignal[] = [];
  const extractionSuppressed = new Map<string, number>();
  for (const trace of selectedTraces) {
    const taskId = firstString(trace.record.task_id);
    const task = tasksById.get(taskId);
    if (!task) {
      extractionSuppressed.set("trace_task_missing", (extractionSuppressed.get("trace_task_missing") ?? 0) + 1);
      continue;
    }
    const extracted = extractSignals(trace, task, policy);
    signals.push(...extracted.signals);
    for (const suppressed of extracted.suppressed) {
      extractionSuppressed.set(suppressed.reason_code, (extractionSuppressed.get(suppressed.reason_code) ?? 0) + 1);
    }
  }
  const groups = groupSignals(signals);
  const proposalPlan = await buildProposalPlan(dataRoot, groups, acceptedBefore, {
    apply,
    reviewer,
    at,
    lastVerified: dateStamp(atDate),
    policy,
  });
  const usage = await collectUsageObservations(dataRoot, policy);
  const cleanupActions = await cleanupPlan(dataRoot, acceptedBefore, usage.observations, policy, atDate);
  const proposedChange = proposalPlan.results.some((entry) => ["created", "updated", "planned"].includes(entry.action));
  const cleanupChange = cleanupActions.length > 0;
  const dryRunReport = {
    ok: true,
    version: CONTROLLED_COMPOUNDING_VERSION,
    cycle_status: "planned",
    cycle_id: cycleId,
    generated_at: at,
    apply: false,
    reviewer,
    trace_limit: traceLimit,
    trace_count: selectedTraces.length,
    signal_count: signals.length,
    recurring_group_count: groups.filter((group) => group.signals.length >= policy.min_distinct_tasks).length,
    promoted_count: proposalPlan.results.filter((entry) => entry.action === "planned").length,
    updated_count: 0,
    unchanged_count: proposalPlan.results.filter((entry) => entry.action === "unchanged").length,
    suppressed_count: proposalPlan.results.filter((entry) => entry.action === "suppressed").length,
    cleanup_count: cleanupActions.length,
    applied_cleanup_count: 0,
    changed: false,
    would_change: proposedChange || cleanupChange,
    policy,
    promotions: proposalPlan.results,
    cleanup_actions: cleanupActions,
    suppressed: [
      ...Array.from(extractionSuppressed.entries()).map(([reason_code, count]) => ({ reason_code, count })),
      ...proposalPlan.suppressed,
    ],
    usage_scan: { context_pack_count: usage.context_pack_count, trace_count: usage.trace_count },
    cycle_path: null,
    behavior_rule_index_path: null,
    controlled_compounding_status_path: null,
    public_summary_path: null,
    transaction_ids: [],
  };
  if (!apply) return dryRunReport;

  const transactionIds: string[] = [];
  let proposalTransaction: { transaction_id: string | null; transaction_path: string | null } | null = null;
  let cleanupTransaction: { transaction_id: string | null; transaction_path: string | null; usage_snapshot_path: string | null } | null = null;
  let artifactTransaction: { transaction_id: string | null; transaction_path: string | null } | null = null;
  try {
    if (proposalPlan.items.length > 0) {
      const admission = await writeReviewGatedBatch(dataRoot, {
        items: proposalPlan.items,
        actor: reviewer,
        reason: `Persist ${proposalPlan.items.length} recurring controlled compounding proposals for independent review.`,
        fault_after_write_index_for_test: options.faultAfterProposalWriteIndexForTest,
      });
      proposalTransaction = admission.lifecycle_transaction;
      if (proposalTransaction.transaction_id) transactionIds.push(proposalTransaction.transaction_id);
    }

    cleanupTransaction = await applyCleanupPlan(dataRoot, cleanupActions, usage.observations, {
      reviewer,
      at,
      cycleId,
      faultAfterWriteIndexForTest: options.faultAfterCleanupWriteIndexForTest,
    });
    if (cleanupTransaction.transaction_id) transactionIds.push(cleanupTransaction.transaction_id);

    const acceptedAfter = await acceptedBehaviorRecords(dataRoot);
    const indexRelativePath = "60_Operations/behavior-rules/behavior-rule-index.json";
    const [indexState, statusState] = await Promise.all([
      readJsonFileState(dataRoot, indexRelativePath),
      readJsonFileState(dataRoot, CONTROLLED_COMPOUNDING_STATUS_RELATIVE_PATH),
    ]);
    const indexRecord = stableGeneratedRecord(
      indexState.record,
      behaviorRuleIndexRecord(acceptedAfter, usage.observations, at),
      ["generated_at"],
    );
    const statusRecord = stableGeneratedRecord(
      statusState.record,
      await buildControlledCompoundingStatusRecord(dataRoot, {
        generatedAt: at,
        policy,
        observations: usage.observations,
        latestCyclePath: cycleRelativePath,
      }) as unknown as JsonObject,
      ["generated_at", "latest_verified_at", "latest_cycle_path"],
    );
    const memoryChanged =
      proposalPlan.results.some((entry) => entry.action === "created" || entry.action === "updated") ||
      cleanupActions.some((entry) => entry.applied);
    const publicSummaryRelativePath = memoryChanged ? `${CONTROLLED_COMPOUNDING_PUBLIC_DIR}/${cycleId}.json` : null;
    const artifactWrites: LifecycleBatchWrite[] = [
      { target_path: indexRelativePath, record: indexRecord, expected_before_sha256: indexState.sha256 },
      { target_path: CONTROLLED_COMPOUNDING_STATUS_RELATIVE_PATH, record: statusRecord, expected_before_sha256: statusState.sha256 },
    ];
    if (publicSummaryRelativePath) {
      artifactWrites.push({
        target_path: publicSummaryRelativePath,
        record: {
          version: CONTROLLED_COMPOUNDING_VERSION,
          cycle_id: cycleId,
          generated_at: at,
          trace_count: selectedTraces.length,
          recurring_group_count: groups.filter((group) => group.signals.length >= policy.min_distinct_tasks).length,
          proposal_created_count: proposalPlan.results.filter((entry) => entry.action === "created").length,
          proposal_updated_count: proposalPlan.results.filter((entry) => entry.action === "updated").length,
          cleanup_applied_count: cleanupActions.filter((entry) => entry.applied).length,
          raw_behavior_rules_included: false,
          raw_trace_content_included: false,
          public_safe: true,
        },
        expected_before_sha256: (await readJsonFileState(dataRoot, publicSummaryRelativePath)).sha256,
      });
    }
    const artifactBatch = await writeNodeLifecycleBatch(dataRoot, artifactWrites, {
      actor: reviewer,
      reason: "Publish bounded controlled compounding index, status, and hash-safe operation evidence.",
    });
    artifactTransaction = artifactBatch;
    if (artifactBatch.transaction_id) transactionIds.push(artifactBatch.transaction_id);

    const report = {
      ...dryRunReport,
      cycle_status: "applied",
      apply: true,
      promoted_count: proposalPlan.results.filter((entry) => entry.action === "created").length,
      updated_count: proposalPlan.results.filter((entry) => entry.action === "updated").length,
      applied_cleanup_count: cleanupActions.filter((entry) => entry.applied).length,
      changed: memoryChanged,
      would_change: memoryChanged,
      behavior_rule_index_path: indexRelativePath,
      controlled_compounding_status_path: CONTROLLED_COMPOUNDING_STATUS_RELATIVE_PATH,
      public_summary_path: publicSummaryRelativePath,
      cycle_path: cycleRelativePath,
      proposal_transaction_id: proposalTransaction?.transaction_id ?? null,
      proposal_transaction_path: proposalTransaction?.transaction_path ?? null,
      cleanup_transaction_id: cleanupTransaction?.transaction_id ?? null,
      cleanup_transaction_path: cleanupTransaction?.transaction_path ?? null,
      usage_snapshot_path: cleanupTransaction?.usage_snapshot_path ?? null,
      artifact_transaction_id: artifactTransaction?.transaction_id ?? null,
      artifact_transaction_path: artifactTransaction?.transaction_path ?? null,
      transaction_ids: transactionIds,
      rollback_available: transactionIds.length > 0,
      reapplied_from: options.reapplyCyclePath ?? null,
      reapplied_from_rollback_at: firstString(replayReport?.rolled_back_at) || null,
    };
    await atomicWriteJson(cycleAbsolutePath, report);
    return report;
  } catch (error) {
    const compensationErrors = await compensateTransactions(dataRoot, transactionIds);
    const suffix = compensationErrors.length > 0 ? `; compensation_failed=${compensationErrors.join("|")}` : "; prior writes compensated";
    throw new Error(`Controlled compounding cycle failed: ${error instanceof Error ? error.message : String(error)}${suffix}`);
  }
}
