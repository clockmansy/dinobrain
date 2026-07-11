import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import { atomicWriteJson } from "./concurrency.js";
import type { RankedRecord } from "./context.js";
import { getContextPackItems } from "./retrieval.js";

export const ANSWER_QUALITY_VERSION = "answer_quality_v2";
export const ANSWER_QUALITY_GOLDEN_VERSION = 2;
export const ANSWER_QUALITY_CALIBRATION_VERSION = "answer_quality_calibration_v2";
export const ANSWER_QUALITY_STATUS_RELATIVE_PATH = ".dino/state/answer_quality_status.json";
export const ANSWER_QUALITY_GOLDEN_RELATIVE_PATH = ".dino/evaluations/answer-quality-golden.json";
export const ANSWER_QUALITY_CALIBRATION_RELATIVE_PATH = ".dino/evaluations/answer-quality-calibration.json";
export const ANSWER_QUALITY_RETRIEVAL_IDENTITY_VERSION = "answer_quality_retrieval_identity_v1";
export const ANSWER_QUALITY_RETRIEVAL_EXCLUDED_PREFIXES = [".dino/", "60_Operations/"] as const;

export const REQUIRED_ANSWER_QUALITY_CATEGORIES = [
  "exact",
  "paraphrase",
  "rare_exact",
  "negative",
  "provenance",
  "quarantine",
  "recency",
  "correction",
  "noisy_growth",
  "forbidden_memory",
  "current_instruction",
] as const;

type EvalLanguage = "ko" | "en";
type Preference = "memory_on" | "memory_off" | "tie";
type JsonObject = Record<string, unknown>;

type AnswerQualityGoldenCase = {
  id: string;
  category: string;
  language: EvalLanguage;
  request: string;
  expected_memory_paths: string[];
  forbidden_memory_paths?: string[];
  expected_actions?: string[];
  forbidden_actions?: string[];
  forbidden_answer_terms?: string[];
  allowed_paths?: string[];
  allowed_prefixes?: string[];
  min_memory_lift?: number;
  min_faithfulness?: number;
  min_answer_relevance?: number;
  min_correctness?: number;
  min_grounding?: number;
  min_source_support?: number;
  max_noise_paths?: number;
  require_hybrid?: boolean;
  calibration_required?: boolean;
};

type AnswerQualityGolden = {
  version: number;
  golden_id: string;
  description?: string;
  pack_limit?: number;
  minimum_cases?: number;
  required_categories?: string[];
  required_languages?: EvalLanguage[];
  calibration_required_categories?: string[];
  target_memory_lift?: number;
  min_faithfulness?: number;
  min_answer_relevance?: number;
  min_correctness?: number;
  min_grounding?: number;
  min_source_support?: number;
  max_noise_paths?: number;
  min_calibration_cases?: number;
  max_judge_disagreement_rate?: number;
  max_rss_delta_mb?: number;
  max_p95_latency_ms?: number;
  cases: AnswerQualityGoldenCase[];
};

type CalibrationJudgment = {
  case_id: string;
  memory_on_answer_sha256: string;
  memory_off_answer_sha256: string;
  preferred: Preference;
  forbidden_safe: boolean;
};

type AnswerQualityCalibration = {
  version: typeof ANSWER_QUALITY_CALIBRATION_VERSION;
  golden_sha256: string;
  evaluator_sha256: string;
  retrieval_index_sha256: string;
  packet_sha256: string;
  judge_kind: "independent_llm" | "ragas";
  judge_ids: string[];
  judge_model: string;
  judge_prompt_sha256: string;
  judge_parameters: {
    blinded: boolean;
    arms_randomized: boolean;
    [key: string]: unknown;
  };
  review_artifact_path: string;
  review_artifact_sha256: string;
  generated_at: string;
  judgments: CalibrationJudgment[];
};

type AnswerQualityEvidenceIdentity = {
  evaluator_sha256: string;
  runtime_components: Record<string, string>;
  retrieval_index_path: string;
  retrieval_index_sha256: string | null;
  retrieval_index_scope: typeof ANSWER_QUALITY_RETRIEVAL_IDENTITY_VERSION;
  retrieval_index_record_count: number;
  retrieval_index_excluded_prefixes: string[];
};

export type GeneratedBehavior = {
  mode: "memory_on" | "memory_off";
  answer: string;
  applied_actions: string[];
  blocked_actions: string[];
  citations: string[];
  guidance: Array<{ path: string; text: string; actions: string[] }>;
};

export type AnswerQualityMetrics = {
  faithfulness: number;
  answer_relevance: number;
  correctness: number;
  grounding: number;
  source_support: number;
  forbidden_memory_avoidance: number;
  current_instruction_compliance: number;
  noise_budget: number;
};

export type AnswerQualityCaseResult = {
  id: string;
  category: string;
  language: EvalLanguage;
  request: string;
  retrieval_mode: string | null;
  expected_memory_paths: string[];
  forbidden_memory_paths: string[];
  returned_paths: string[];
  missing_paths: string[];
  forbidden_returned_paths: string[];
  noise_paths: string[];
  expected_actions: string[];
  forbidden_actions: string[];
  forbidden_answer_terms: string[];
  memory_on: GeneratedBehavior;
  memory_off: GeneratedBehavior;
  memory_on_answer: string;
  memory_off_answer: string;
  metrics: AnswerQualityMetrics;
  memory_on_metrics: AnswerQualityMetrics;
  memory_off_metrics: AnswerQualityMetrics;
  memory_on_score: number;
  memory_off_score: number;
  memory_lift: number;
  latency_ms: number;
  calibration_required: boolean;
  pass: boolean;
  issue_codes: string[];
};

type CalibrationCaseResult = {
  case_id: string;
  category: string;
  local_preferred: Preference;
  independent_preferred: Preference | null;
  local_forbidden_safe: boolean;
  independent_forbidden_safe: boolean | null;
  answer_hashes_match: boolean;
  disagreement: boolean;
};

export type AnswerQualityReport = {
  version: typeof ANSWER_QUALITY_VERSION;
  status: "healthy" | "needs_attention" | "degraded";
  generated_at: string;
  data_root: string;
  golden_source: "answer_quality_golden_v2" | "missing" | "invalid";
  golden_path: string | null;
  golden_sha256: string | null;
  evaluator: "structured_memory_behavior_generator_v2";
  evaluator_class: "independent_calibrated_local";
  evidence_identity: AnswerQualityEvidenceIdentity;
  pack_limit: number;
  minimum_cases: number;
  thresholds: {
    target_memory_lift: number;
    min_faithfulness: number;
    min_answer_relevance: number;
    min_correctness: number;
    min_grounding: number;
    min_source_support: number;
    max_noise_paths: number;
    min_calibration_cases: number;
    max_judge_disagreement_rate: number;
    max_rss_delta_mb: number;
    max_p95_latency_ms: number;
  };
  coverage: {
    required_categories: string[];
    present_categories: string[];
    missing_categories: string[];
    required_languages: EvalLanguage[];
    present_languages: EvalLanguage[];
    missing_languages: EvalLanguage[];
  };
  counts: {
    cases: number;
    passed: number;
    failed: number;
    hybrid: number;
    lexical_fallback: number;
    missing_expected_paths: number;
    forbidden_returned_paths: number;
    noise_paths: number;
  };
  metrics: AnswerQualityMetrics & {
    average_memory_lift: number;
    p95_latency_ms: number;
  };
  calibration: {
    status: "healthy" | "needs_attention" | "missing" | "stale";
    artifact_path: string;
    artifact_sha256: string | null;
    judge_kind: string | null;
    judge_ids: string[];
    judge_model: string | null;
    review_artifact_path: string | null;
    review_artifact_sha256: string | null;
    sample_cases: number;
    disagreements: number;
    disagreement_rate: number;
    missing_required_categories: string[];
    stale_judgments: string[];
    retrieval_index_match: boolean | null;
    review_retrieval_index_match: boolean | null;
    results: CalibrationCaseResult[];
  };
  resource_usage: {
    start_rss_mb: number;
    peak_rss_mb: number;
    end_rss_mb: number;
    rss_delta_mb: number;
    budget_mb: number;
    within_budget: boolean;
  };
  calibration_packet: Array<{
    case_id: string;
    category: string;
    request: string;
    memory_on_answer: string;
    memory_off_answer: string;
    memory_on_answer_sha256: string;
    memory_off_answer_sha256: string;
    forbidden_actions: string[];
    forbidden_answer_terms: string[];
  }>;
  failing_cases: string[];
  results: AnswerQualityCaseResult[];
  caveats: string[];
  warnings: string[];
  visible_status: string;
};

type BuildOptions = {
  now?: Date;
  goldenPath?: string;
  calibrationPath?: string;
  packLimit?: number;
};

const ACTION_PATTERNS: Record<string, RegExp[]> = {
  honor_current_instruction: [/current user instructions?.*priority|follow the current instruction/i, /현재.*지시.*우선|사용자.*지시.*따/u],
  record_correction: [/record the correction|correction if durable/i, /교정.*기록|정정.*반영/u],
  require_live_evidence: [/fresh prompt event evidence|live[- ]verified|pre-response events/i, /실제.*프롬프트.*이벤트|라이브.*증거/u],
  preflight: [/os_begin_task/i, /pre[- ]response/i, /사전\s*(?:응답|컨텍스트)/u],
  load_context: [/context pack/i, /맥락|컨텍스트/u],
  finish_task: [/finish_task/i, /완료\s*기록/u],
  fail_closed: [/fail[- ]closed/i, /실질\s*작업.*막/u],
  clone_repositories: [/clone|app\/data refs/i, /레포.*(?:복제|클론)/u],
  configure_agents: [/codex and claude registration|hooks?\/mcp|configure codex|configure claude/i, /코덱스|클로드/u],
  build_indexes: [/build\/index|build indexes|index refresh/i, /인덱스.*(?:빌드|재생성)/u],
  launch_observatory: [/launch observatory/i, /observatory.*(?:launch|open)|옵저버토리.*실행/iu],
  verify_version: [/version parity|package version|local\/remote refs|github release state/i, /버전.*(?:정합|검증)/u],
  inspect_workspace: [/inspect the real workspace|local files|command\/file evidence|repository state/i, /실제.*(?:파일|작업공간)|로컬.*검증/u],
  cite_evidence: [/cite evidence|evidence paths|report command\/file evidence/i, /근거.*(?:경로|기록)|증거.*인용/u],
  plan_first: [/plan[- ]first|first summarize understanding/i, /계획.*먼저|이해한.*먼저/u],
  ask_only_needed: [/ask only necessary questions/i, /필요한.*질문/u],
  lock_scope: [/lock the plan|scope lock/i, /범위.*고정|계획.*확정/u],
  implement: [/\bimplement\b|implementation/i, /구현/u],
  edit: [/\bedit\b|modify|change code/i, /수정|변경/u],
  verify: [/\bverify\b|verification|run tests/i, /검증|테스트/u],
  commit: [/\bcommit\b/i, /커밋/u],
  push: [/\bpush\b/i, /푸시/u],
  deploy: [/\bdeploy\b|release/i, /배포|릴리즈/u],
  delete: [/\bdelete\b|remove files/i, /삭제/u],
  review_memory: [/reviewed memory|reviewed preferences|reviewed.*knowledge/i, /검토.*기억|리뷰.*메모리/u],
  lifecycle_clean: [/lifecycle[- ]clean|merge duplicates|quarantine/i, /수명주기|병합|격리/u],
  evaluate_behavior: [/evaluate.*behavior|memory[- ]on.*baseline|behavior evaluation/i, /행동.*평가|메모리.*비교/u],
  show_live_traces: [/live os traces|hook.*task.*context/i, /실시간.*(?:추적|상태)/u],
  graph_health: [/graph health/i, /그래프.*건강|그래프.*상태/u],
  audit_trust: [/audit trust|trust score/i, /감사.*신뢰|신뢰도/u],
  sync_risk: [/sync risk/i, /동기화.*위험/u],
  metadata_only: [/metadata[- ]only/i, /메타데이터만/u],
  paraphrase_memory: [/paraphrased reviewed memor/i, /정제.*기억|의역.*메모리/u],
  block_raw_transcript: [/never store raw full transcripts|raw transcripts never public/i, /원문.*(?:저장|공개).*금지/u],
  direct_link: [/direct link|direct artifact/i, /직접.*링크/u],
  plain_korean: [/plain korean|concrete cause, consequence/i, /쉬운.*한국어|원인.*결과.*다음/u],
  hybrid_retrieval: [/hybrid retrieval|bm25 plus dense/i, /하이브리드.*검색/u],
  source_provenance: [/source provenance|verified chunks|anchor[- ]only/i, /출처.*계보|검증.*청크/u],
  rank_fusion: [/rank fusion|rrf/i, /랭크.*융합/u],
  rerank: [/rerank/i, /재순위|리랭크/u],
};

const ACTION_KEYS = new Set(Object.keys(ACTION_PATTERNS));

function unique(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function jsonObject(value: unknown): JsonObject | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : null;
}

function normalized(value: string): string {
  return value.toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
}

function containsTerm(haystack: string, term: string): boolean {
  return normalized(haystack).includes(normalized(term));
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function average(values: number[]): number {
  if (values.length === 0) return 0;
  return Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(3));
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))] ?? 0;
}

function mb(bytes: number): number {
  return Number((bytes / (1024 * 1024)).toFixed(3));
}

function dataPath(dataRoot: string, relativePath: string): string {
  return path.join(dataRoot, ...relativePath.replace(/\\/g, "/").split("/"));
}

async function fileSha256(filePath: string): Promise<string | null> {
  try {
    return sha256(await fs.readFile(filePath));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function evaluationRetrievalIndexIdentity(filePath: string): Promise<{ sha256: string | null; recordCount: number }> {
  try {
    const index = jsonObject(JSON.parse(await fs.readFile(filePath, "utf8")));
    const records = jsonObject(index?.records);
    const metadata = jsonObject(index?.record_metadata) ?? {};
    if (!index || !records) return { sha256: null, recordCount: 0 };
    const paths = Object.keys(records)
      .filter(
        (recordPath) =>
          !ANSWER_QUALITY_RETRIEVAL_EXCLUDED_PREFIXES.some((prefix) => recordPath.replace(/\\/g, "/").startsWith(prefix)),
      )
      .sort();
    const identity = {
      version: ANSWER_QUALITY_RETRIEVAL_IDENTITY_VERSION,
      provider: index.provider ?? null,
      model: index.model ?? null,
      dimensions: index.dimensions ?? null,
      semantic_embedding_provider: index.semantic_embedding_provider === true,
      records: paths.map((recordPath) => ({
        path: recordPath,
        vector: records[recordPath] ?? null,
        metadata: metadata[recordPath] ?? null,
      })),
    };
    return { sha256: sha256(JSON.stringify(identity)), recordCount: paths.length };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof SyntaxError) {
      return { sha256: null, recordCount: 0 };
    }
    throw error;
  }
}

async function buildEvidenceIdentity(dataRoot: string): Promise<AnswerQualityEvidenceIdentity> {
  const retrievalIndexPath = ".dino/index/dense-vectors.json";
  const runtimeUrls: Record<string, URL> = {
    answer_quality: new URL(import.meta.url),
    retrieval: new URL("./retrieval.js", import.meta.url),
    hybrid_retrieval: new URL("./hybrid-retrieval.js", import.meta.url),
    live_semantic_query: new URL("./live-semantic-query.js", import.meta.url),
  };
  const runtimeComponents: Record<string, string> = {};
  for (const [name, url] of Object.entries(runtimeUrls)) runtimeComponents[name] = sha256(await fs.readFile(url));
  const retrievalIdentity = await evaluationRetrievalIndexIdentity(dataPath(dataRoot, retrievalIndexPath));
  return {
    evaluator_sha256: sha256(JSON.stringify(runtimeComponents)),
    runtime_components: runtimeComponents,
    retrieval_index_path: retrievalIndexPath,
    retrieval_index_sha256: retrievalIdentity.sha256,
    retrieval_index_scope: ANSWER_QUALITY_RETRIEVAL_IDENTITY_VERSION,
    retrieval_index_record_count: retrievalIdentity.recordCount,
    retrieval_index_excluded_prefixes: [...ANSWER_QUALITY_RETRIEVAL_EXCLUDED_PREFIXES],
  };
}

function resolveDataArtifact(dataRoot: string, relativePath: string): string | null {
  if (!relativePath || path.isAbsolute(relativePath)) return null;
  const root = path.resolve(dataRoot);
  const resolved = path.resolve(root, relativePath);
  return resolved.startsWith(`${root}${path.sep}`) ? resolved : null;
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function extractActions(text: string): string[] {
  return Object.entries(ACTION_PATTERNS)
    .filter(([, patterns]) => patterns.some((pattern) => pattern.test(text)))
    .map(([action]) => action);
}

function detectBlockedActions(request: string): string[] {
  const blocked = new Set<string>();
  const checks: Array<[string, RegExp]> = [
    ["commit", /(?:do not|don't|must not|without)\s+(?:a\s+)?commit|커밋(?:하지\s*마|하지\s*말|\s*금지|\s*없이)/iu],
    ["push", /(?:do not|don't|must not|without)\s+push|푸시(?:하지\s*마|하지\s*말|\s*금지|\s*없이)/iu],
    ["deploy", /(?:do not|don't|must not|without)\s+(?:deploy|release)|배포(?:하지\s*마|하지\s*말|\s*금지|\s*없이)/iu],
    ["delete", /(?:do not|don't|must not)\s+(?:delete|remove)|삭제(?:하지\s*마|하지\s*말|\s*금지)/iu],
    ["edit", /(?:do not|don't|must not|without)\s+(?:edit|modify|change)|수정(?:하지\s*마|하지\s*말|\s*금지|\s*없이)|코드\s*수정\s*없이/iu],
    ["implement", /(?:analysis|review)[- ]only|분석만|검토만|읽기\s*전용/iu],
  ];
  for (const [action, pattern] of checks) if (pattern.test(request)) blocked.add(action);
  if (/(?:analysis|review)[- ]only|분석만|검토만|읽기\s*전용/iu.test(request)) {
    for (const action of ["edit", "implement", "commit", "push", "deploy", "delete", "record_correction"]) blocked.add(action);
  }
  return [...blocked].sort();
}

function removeBlockedGuidance(text: string, blockedActions: Set<string>): string {
  if (blockedActions.size === 0) return text;
  return text
    .split(/(?<=[.!?])\s+/u)
    .filter((sentence) => !extractActions(sentence).some((action) => blockedActions.has(action)))
    .join(" ")
    .trim();
}

async function readGuidance(dataRoot: string, record: RankedRecord): Promise<string> {
  if (!record.path || record.path.startsWith(".dino/")) return record.summary || record.excerpt;
  try {
    const text = await fs.readFile(dataPath(dataRoot, record.path), "utf8");
    if (path.extname(record.path).toLowerCase() === ".json") {
      const parsed = JSON.parse(text) as JsonObject;
      const reviewedParts = unique(
        [parsed.claim, parsed.reusable_rule, parsed.rule, parsed.summary, parsed.chunk_text, parsed.text]
          .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
          .map((value) => value.trim()),
      );
      if (reviewedParts.length > 0) return reviewedParts.join(" ");
      return firstString(record.summary, record.excerpt) ?? "";
    }
  } catch {
    // The retrieval record itself remains usable when its backing file changed during evaluation.
  }
  return record.summary || record.excerpt;
}

function isGuidanceRecord(record: RankedRecord): boolean {
  return ["behavior_guidance", "accepted_memory", "verified_claim_support"].includes(record.knowledge_role);
}

const MAX_REVIEWED_GUIDANCE_ITEMS = 2;

async function generateBehavior(
  dataRoot: string,
  request: string,
  ranked: RankedRecord[],
  mode: GeneratedBehavior["mode"],
): Promise<GeneratedBehavior> {
  const blockedActions = detectBlockedActions(request);
  const blockedSet = new Set(blockedActions);
  const requestActions = extractActions(request).filter((action) => !blockedSet.has(action));
  if (mode === "memory_off") {
    const appliedActions = unique(requestActions).sort();
    return {
      mode,
      answer: `Action decision: ${appliedActions.join(", ") || "respond_to_current_request"}. No stored memory was supplied.`,
      applied_actions: appliedActions,
      blocked_actions: blockedActions,
      citations: [],
      guidance: [],
    };
  }

  const guidance: GeneratedBehavior["guidance"] = [];
  for (const record of ranked.filter(isGuidanceRecord).slice(0, MAX_REVIEWED_GUIDANCE_ITEMS)) {
    const rawText = (await readGuidance(dataRoot, record)).replace(/\s+/g, " ").trim().slice(0, 700);
    const text = removeBlockedGuidance(rawText, blockedSet);
    if (!text) continue;
    const actions = extractActions(text).filter((action) => !blockedSet.has(action));
    guidance.push({ path: record.path, text, actions });
  }
  const appliedActions = unique([...requestActions, ...guidance.flatMap((item) => item.actions)])
    .filter((action) => !blockedSet.has(action))
    .sort();
  const citations = unique(guidance.map((item) => item.path));
  const guidanceText = guidance.map((item) => item.text).join(" ");
  return {
    mode,
    answer: [
      `Action decision: ${appliedActions.join(", ") || "respond_to_current_request"}.`,
      guidanceText ? `Reviewed guidance: ${guidanceText}` : "Reviewed guidance: none retrieved.",
      `Evidence: ${citations.join(", ") || "none"}.`,
    ].join("\n"),
    applied_actions: appliedActions,
    blocked_actions: blockedActions,
    citations,
    guidance,
  };
}

function isAllowedPath(returnedPath: string, expectedPaths: string[], allowedPaths: string[], allowedPrefixes: string[]): boolean {
  return (
    expectedPaths.includes(returnedPath) ||
    allowedPaths.includes(returnedPath) ||
    allowedPrefixes.some((prefix) => returnedPath.startsWith(prefix))
  );
}

function scoreBehavior(params: {
  request: string;
  behavior: GeneratedBehavior;
  expectedActions: string[];
  forbiddenActions: string[];
  forbiddenAnswerTerms: string[];
  returnedPaths: string[];
  expectedPaths: string[];
  forbiddenMemoryPaths: string[];
  noisePaths: string[];
  maxNoisePaths: number;
}): AnswerQualityMetrics {
  const actionHits = params.expectedActions.filter((action) => params.behavior.applied_actions.includes(action)).length;
  const actionRecall = params.expectedActions.length === 0 ? 1 : actionHits / params.expectedActions.length;
  const expectedPathHits = params.expectedPaths.filter((expectedPath) => params.behavior.citations.includes(expectedPath)).length;
  const sourceSupport = params.expectedPaths.length === 0 ? 1 : expectedPathHits / params.expectedPaths.length;
  const forbiddenActionHits = params.forbiddenActions.filter((action) => params.behavior.applied_actions.includes(action));
  const forbiddenAnswerHits = params.forbiddenAnswerTerms.filter((term) => containsTerm(params.behavior.answer, term));
  const forbiddenPathHits = params.forbiddenMemoryPaths.filter(
    (forbiddenPath) => params.returnedPaths.includes(forbiddenPath) || params.behavior.citations.includes(forbiddenPath),
  );
  const forbiddenAvoidance =
    forbiddenActionHits.length === 0 && forbiddenAnswerHits.length === 0 && forbiddenPathHits.length === 0 ? 1 : 0;
  const currentInstructionCompliance = params.behavior.blocked_actions.some((action) => params.behavior.applied_actions.includes(action)) ? 0 : 1;
  const supportedActions = new Set([
    ...extractActions(params.request),
    ...params.behavior.guidance.flatMap((item) => item.actions),
  ]);
  const unsupportedActions = params.behavior.applied_actions.filter((action) => !supportedActions.has(action));
  const faithfulness = unsupportedActions.length === 0 && forbiddenAvoidance === 1 ? 1 : 0;
  const grounding = params.behavior.citations.length === 0
    ? params.expectedPaths.length === 0 ? 1 : 0
    : expectedPathHits / Math.max(1, params.behavior.citations.length);
  const noiseBudget = params.noisePaths.length <= params.maxNoisePaths ? 1 : 0;
  const correctness = sourceSupport * 0.35 + actionRecall * 0.35 + forbiddenAvoidance * 0.2 + currentInstructionCompliance * 0.1;
  return {
    faithfulness: Number(faithfulness.toFixed(3)),
    answer_relevance: Number(actionRecall.toFixed(3)),
    correctness: Number(correctness.toFixed(3)),
    grounding: Number(Math.min(1, grounding).toFixed(3)),
    source_support: Number(sourceSupport.toFixed(3)),
    forbidden_memory_avoidance: Number(forbiddenAvoidance.toFixed(3)),
    current_instruction_compliance: Number(currentInstructionCompliance.toFixed(3)),
    noise_budget: Number(noiseBudget.toFixed(3)),
  };
}

function aggregateScore(metrics: AnswerQualityMetrics): number {
  return Number(
    (
      metrics.faithfulness * 10 +
      metrics.answer_relevance * 20 +
      metrics.correctness * 25 +
      metrics.grounding * 15 +
      metrics.source_support * 15 +
      metrics.forbidden_memory_avoidance * 5 +
      metrics.current_instruction_compliance * 5 +
      metrics.noise_budget * 5
    ).toFixed(3),
  );
}

async function loadGolden(dataRoot: string, options: BuildOptions): Promise<{
  source: AnswerQualityReport["golden_source"];
  path: string | null;
  sha256: string | null;
  golden: AnswerQualityGolden | null;
  errors: string[];
}> {
  const goldenPath = options.goldenPath
    ? path.resolve(options.goldenPath)
    : dataPath(dataRoot, ANSWER_QUALITY_GOLDEN_RELATIVE_PATH);
  let raw: Buffer;
  try {
    raw = await fs.readFile(goldenPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { source: "missing", path: null, sha256: null, golden: null, errors: ["answer_quality_golden_missing"] };
    }
    throw error;
  }
  let golden: AnswerQualityGolden;
  try {
    golden = JSON.parse(raw.toString("utf8")) as AnswerQualityGolden;
  } catch {
    return { source: "invalid", path: goldenPath, sha256: sha256(raw), golden: null, errors: ["answer_quality_golden_invalid_json"] };
  }
  const errors: string[] = [];
  if (golden.version !== ANSWER_QUALITY_GOLDEN_VERSION) errors.push("answer_quality_golden_version_invalid");
  if (!golden.golden_id?.trim()) errors.push("answer_quality_golden_id_missing");
  if (!Array.isArray(golden.cases) || golden.cases.length === 0) errors.push("answer_quality_golden_cases_missing");
  const ids = new Set<string>();
  for (const item of golden.cases ?? []) {
    if (!item.id?.trim() || ids.has(item.id)) errors.push("answer_quality_golden_case_id_invalid");
    ids.add(item.id);
    if (!item.request?.trim()) errors.push(`answer_quality_request_missing:${item.id}`);
    if (!item.category?.trim()) errors.push(`answer_quality_category_missing:${item.id}`);
    if (!(["ko", "en"] as string[]).includes(item.language)) errors.push(`answer_quality_language_invalid:${item.id}`);
    for (const action of [...(item.expected_actions ?? []), ...(item.forbidden_actions ?? [])]) {
      if (!ACTION_KEYS.has(action)) errors.push(`answer_quality_unknown_action:${item.id}:${action}`);
    }
  }
  return {
    source: errors.length === 0 ? "answer_quality_golden_v2" : "invalid",
    path: goldenPath,
    sha256: sha256(raw),
    golden: errors.length === 0 ? golden : null,
    errors: unique(errors),
  };
}

async function evaluateCase(
  dataRoot: string,
  answerCase: AnswerQualityGoldenCase,
  packLimit: number,
  thresholds: AnswerQualityReport["thresholds"],
): Promise<AnswerQualityCaseResult> {
  const startedAt = Date.now();
  const pack = await getContextPackItems(dataRoot, answerCase.request, packLimit, {
    includeRecentTasks: false,
    excludedPathPrefixes: [...ANSWER_QUALITY_RETRIEVAL_EXCLUDED_PREFIXES],
  });
  const ranked = pack.ranked;
  const returnedPaths = unique(ranked.map((record) => record.path));
  const expectedPaths = unique(answerCase.expected_memory_paths ?? []);
  const forbiddenMemoryPaths = unique(answerCase.forbidden_memory_paths ?? []);
  const allowedPaths = unique(answerCase.allowed_paths ?? []);
  const allowedPrefixes = unique(answerCase.allowed_prefixes ?? []);
  const expectedActions = unique(answerCase.expected_actions ?? []);
  const forbiddenActions = unique(answerCase.forbidden_actions ?? []);
  const forbiddenAnswerTerms = unique(answerCase.forbidden_answer_terms ?? []);
  const missingPaths = expectedPaths.filter((expectedPath) => !returnedPaths.includes(expectedPath));
  const forbiddenReturnedPaths = forbiddenMemoryPaths.filter((forbiddenPath) => returnedPaths.includes(forbiddenPath));
  const noisePaths = returnedPaths.filter(
    (returnedPath) => !isAllowedPath(returnedPath, expectedPaths, allowedPaths, allowedPrefixes),
  );
  const maxNoisePaths = answerCase.max_noise_paths ?? thresholds.max_noise_paths;
  const memoryOn = await generateBehavior(dataRoot, answerCase.request, ranked, "memory_on");
  const memoryOff = await generateBehavior(dataRoot, answerCase.request, [], "memory_off");
  const common = {
    request: answerCase.request,
    expectedActions,
    forbiddenActions,
    forbiddenAnswerTerms,
    expectedPaths,
    forbiddenMemoryPaths,
    noisePaths,
    maxNoisePaths,
  };
  const memoryOnMetrics = scoreBehavior({ ...common, behavior: memoryOn, returnedPaths });
  const memoryOffMetrics = scoreBehavior({ ...common, behavior: memoryOff, returnedPaths: [] });
  const memoryOnScore = aggregateScore(memoryOnMetrics);
  const memoryOffScore = aggregateScore(memoryOffMetrics);
  const memoryLift = Number((memoryOnScore - memoryOffScore).toFixed(3));
  const minMemoryLift = answerCase.min_memory_lift ?? thresholds.target_memory_lift;
  const issueCodes: string[] = [];
  if (answerCase.require_hybrid !== false && pack.stats.retrieval_mode !== "hybrid_contextual_v2") issueCodes.push("hybrid_retrieval_not_active");
  if (memoryLift < minMemoryLift) issueCodes.push("memory_lift_below_target");
  if (memoryOnMetrics.faithfulness < (answerCase.min_faithfulness ?? thresholds.min_faithfulness)) issueCodes.push("faithfulness_below_target");
  if (memoryOnMetrics.answer_relevance < (answerCase.min_answer_relevance ?? thresholds.min_answer_relevance)) {
    issueCodes.push("answer_relevance_below_target");
  }
  if (memoryOnMetrics.correctness < (answerCase.min_correctness ?? thresholds.min_correctness)) issueCodes.push("correctness_below_target");
  if (memoryOnMetrics.grounding < (answerCase.min_grounding ?? thresholds.min_grounding)) issueCodes.push("grounding_below_target");
  if (memoryOnMetrics.source_support < (answerCase.min_source_support ?? thresholds.min_source_support)) {
    issueCodes.push("source_support_below_target");
  }
  if (memoryOnMetrics.forbidden_memory_avoidance < 1) issueCodes.push("forbidden_memory_hit");
  if (memoryOnMetrics.current_instruction_compliance < 1) issueCodes.push("current_instruction_violated");
  if (memoryOnMetrics.forbidden_memory_avoidance < memoryOffMetrics.forbidden_memory_avoidance) {
    issueCodes.push("forbidden_memory_avoidance_regressed");
  }
  if (memoryOnMetrics.noise_budget < 1) issueCodes.push("noise_budget_exceeded");
  if (missingPaths.length > 0) issueCodes.push("expected_memory_missing");
  if (forbiddenReturnedPaths.length > 0) issueCodes.push("forbidden_memory_returned");

  return {
    id: answerCase.id,
    category: answerCase.category,
    language: answerCase.language,
    request: answerCase.request,
    retrieval_mode: pack.stats.retrieval_mode,
    expected_memory_paths: expectedPaths,
    forbidden_memory_paths: forbiddenMemoryPaths,
    returned_paths: returnedPaths,
    missing_paths: missingPaths,
    forbidden_returned_paths: forbiddenReturnedPaths,
    noise_paths: noisePaths,
    expected_actions: expectedActions,
    forbidden_actions: forbiddenActions,
    forbidden_answer_terms: forbiddenAnswerTerms,
    memory_on: memoryOn,
    memory_off: memoryOff,
    memory_on_answer: memoryOn.answer,
    memory_off_answer: memoryOff.answer,
    metrics: memoryOnMetrics,
    memory_on_metrics: memoryOnMetrics,
    memory_off_metrics: memoryOffMetrics,
    memory_on_score: memoryOnScore,
    memory_off_score: memoryOffScore,
    memory_lift: memoryLift,
    latency_ms: Date.now() - startedAt,
    calibration_required: answerCase.calibration_required === true,
    pass: issueCodes.length === 0,
    issue_codes: unique(issueCodes),
  };
}

function preference(result: AnswerQualityCaseResult): Preference {
  if (result.memory_on_score > result.memory_off_score) return "memory_on";
  if (result.memory_on_score < result.memory_off_score) return "memory_off";
  return "tie";
}

async function evaluateCalibration(
  dataRoot: string,
  options: BuildOptions,
  golden: AnswerQualityGolden,
  goldenSha256: string,
  evidenceIdentity: AnswerQualityEvidenceIdentity,
  results: AnswerQualityCaseResult[],
  thresholds: AnswerQualityReport["thresholds"],
): Promise<AnswerQualityReport["calibration"]> {
  const artifactPath = options.calibrationPath
    ? path.resolve(options.calibrationPath)
    : dataPath(dataRoot, ANSWER_QUALITY_CALIBRATION_RELATIVE_PATH);
  let raw: Buffer;
  try {
    raw = await fs.readFile(artifactPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {
        status: "missing",
        artifact_path: artifactPath,
        artifact_sha256: null,
        judge_kind: null,
        judge_ids: [],
        judge_model: null,
        review_artifact_path: null,
        review_artifact_sha256: null,
        sample_cases: 0,
        disagreements: 0,
        disagreement_rate: 1,
        missing_required_categories: unique(golden.calibration_required_categories ?? []),
        stale_judgments: [],
        retrieval_index_match: null,
        review_retrieval_index_match: null,
        results: [],
      };
    }
    throw error;
  }
  let calibration: AnswerQualityCalibration;
  try {
    calibration = JSON.parse(raw.toString("utf8")) as AnswerQualityCalibration;
  } catch {
    return {
      status: "stale",
      artifact_path: artifactPath,
      artifact_sha256: sha256(raw),
      judge_kind: null,
      judge_ids: [],
      judge_model: null,
      review_artifact_path: null,
      review_artifact_sha256: null,
      sample_cases: 0,
      disagreements: 0,
      disagreement_rate: 1,
      missing_required_categories: unique(golden.calibration_required_categories ?? []),
      stale_judgments: ["calibration_invalid_json"],
      retrieval_index_match: null,
      review_retrieval_index_match: null,
      results: [],
    };
  }
  const resultById = new Map(results.map((result) => [result.id, result]));
  const caseResults: CalibrationCaseResult[] = [];
  const staleJudgments: string[] = [];
  for (const judgment of calibration.judgments ?? []) {
    const result = resultById.get(judgment.case_id);
    if (!result) {
      staleJudgments.push(judgment.case_id);
      continue;
    }
    const hashesMatch =
      sha256(result.memory_on_answer) === judgment.memory_on_answer_sha256 &&
      sha256(result.memory_off_answer) === judgment.memory_off_answer_sha256;
    if (!hashesMatch) staleJudgments.push(judgment.case_id);
    const localPreferred = preference(result);
    const localForbiddenSafe =
      result.memory_on_metrics.forbidden_memory_avoidance === 1 && result.memory_on_metrics.current_instruction_compliance === 1;
    const disagreement = !hashesMatch || localPreferred !== judgment.preferred || localForbiddenSafe !== judgment.forbidden_safe;
    caseResults.push({
      case_id: judgment.case_id,
      category: result.category,
      local_preferred: localPreferred,
      independent_preferred: judgment.preferred,
      local_forbidden_safe: localForbiddenSafe,
      independent_forbidden_safe: judgment.forbidden_safe,
      answer_hashes_match: hashesMatch,
      disagreement,
    });
  }
  if (calibration.version !== ANSWER_QUALITY_CALIBRATION_VERSION) staleJudgments.push("calibration_version_invalid");
  if (calibration.golden_sha256 !== goldenSha256) staleJudgments.push("calibration_golden_hash_mismatch");
  if (calibration.evaluator_sha256 !== evidenceIdentity.evaluator_sha256) staleJudgments.push("calibration_evaluator_hash_mismatch");
  if (!evidenceIdentity.retrieval_index_sha256) staleJudgments.push("calibration_retrieval_index_missing");
  const retrievalIndexMatch = Boolean(
    evidenceIdentity.retrieval_index_sha256 && calibration.retrieval_index_sha256 === evidenceIdentity.retrieval_index_sha256,
  );
  if (!/^[a-f0-9]{64}$/i.test(calibration.packet_sha256 ?? "")) staleJudgments.push("calibration_packet_hash_invalid");
  if (!(["independent_llm", "ragas"] as string[]).includes(calibration.judge_kind)) staleJudgments.push("calibration_judge_kind_invalid");
  if (unique(calibration.judge_ids ?? []).length < 3) staleJudgments.push("calibration_independent_judges_insufficient");
  if (!calibration.judge_model?.trim()) staleJudgments.push("calibration_judge_model_missing");
  if (!/^[a-f0-9]{64}$/i.test(calibration.judge_prompt_sha256 ?? "")) staleJudgments.push("calibration_judge_prompt_hash_invalid");
  if (calibration.judge_parameters?.blinded !== true) staleJudgments.push("calibration_not_blinded");
  if (calibration.judge_parameters?.arms_randomized !== true) staleJudgments.push("calibration_arms_not_randomized");
  const reviewArtifactPath = resolveDataArtifact(dataRoot, calibration.review_artifact_path);
  const reviewArtifactSha256 = reviewArtifactPath ? await fileSha256(reviewArtifactPath) : null;
  let reviewRetrievalIndexMatch: boolean | null = null;
  if (!reviewArtifactPath) staleJudgments.push("calibration_review_artifact_path_invalid");
  else if (!reviewArtifactSha256) staleJudgments.push("calibration_review_artifact_missing");
  else if (reviewArtifactSha256 !== calibration.review_artifact_sha256) staleJudgments.push("calibration_review_artifact_hash_mismatch");
  if (reviewArtifactPath && reviewArtifactSha256 === calibration.review_artifact_sha256) {
    try {
      const review = jsonObject(JSON.parse(await fs.readFile(reviewArtifactPath, "utf8")));
      const protocol = jsonObject(review?.protocol);
      const reviewedCases = Array.isArray(review?.cases) ? review.cases.map(jsonObject).filter((item): item is JsonObject => Boolean(item)) : [];
      const reviewedCaseById = new Map(reviewedCases.map((item) => [String(item.case_id ?? ""), item]));
      const reviewJudgeIds = unique(stringArray(review?.judge_ids)).sort();
      const calibrationJudgeIds = unique(calibration.judge_ids ?? []).sort();
      if (review?.version !== "answer_quality_independent_review_v2") staleJudgments.push("calibration_review_version_invalid");
      if (review?.golden_sha256 !== goldenSha256) staleJudgments.push("calibration_review_golden_hash_mismatch");
      if (review?.evaluator_sha256 !== evidenceIdentity.evaluator_sha256) staleJudgments.push("calibration_review_evaluator_hash_mismatch");
      reviewRetrievalIndexMatch = Boolean(
        evidenceIdentity.retrieval_index_sha256 && review?.retrieval_index_sha256 === evidenceIdentity.retrieval_index_sha256,
      );
      if (review?.packet_sha256 !== calibration.packet_sha256) staleJudgments.push("calibration_review_packet_hash_mismatch");
      if (protocol?.blinded !== true || protocol?.arms_randomized !== true) staleJudgments.push("calibration_review_protocol_invalid");
      if (protocol?.prompt_sha256 !== calibration.judge_prompt_sha256) staleJudgments.push("calibration_review_prompt_hash_mismatch");
      if (JSON.stringify(reviewJudgeIds) !== JSON.stringify(calibrationJudgeIds)) staleJudgments.push("calibration_review_judge_ids_mismatch");
      for (const judgment of calibration.judgments ?? []) {
        const reviewed = reviewedCaseById.get(judgment.case_id);
        if (!reviewed) {
          staleJudgments.push(`calibration_review_case_missing:${judgment.case_id}`);
          continue;
        }
        if (reviewed.consensus_preferred !== judgment.preferred || reviewed.forbidden_safe !== judgment.forbidden_safe) {
          staleJudgments.push(`calibration_review_consensus_mismatch:${judgment.case_id}`);
        }
        if (
          reviewed.memory_on_answer_sha256 !== judgment.memory_on_answer_sha256 ||
          reviewed.memory_off_answer_sha256 !== judgment.memory_off_answer_sha256
        ) {
          staleJudgments.push(`calibration_review_answer_hash_mismatch:${judgment.case_id}`);
        }
        const armMapping = jsonObject(reviewed.arm_mapping);
        const expectedA = armMapping?.A === "memory_on" ? judgment.memory_on_answer_sha256 : judgment.memory_off_answer_sha256;
        const expectedB = armMapping?.B === "memory_on" ? judgment.memory_on_answer_sha256 : judgment.memory_off_answer_sha256;
        if (reviewed.candidate_a_sha256 !== expectedA || reviewed.candidate_b_sha256 !== expectedB) {
          staleJudgments.push(`calibration_review_blinded_hash_mismatch:${judgment.case_id}`);
        }
        const votes = Array.isArray(reviewed.votes) ? reviewed.votes.map(jsonObject).filter((item): item is JsonObject => Boolean(item)) : [];
        if (votes.length < 3 || unique(votes.map((vote) => String(vote.judge_id ?? ""))).length < 3) {
          staleJudgments.push(`calibration_review_votes_insufficient:${judgment.case_id}`);
        }
      }
    } catch {
      staleJudgments.push("calibration_review_artifact_invalid_json");
    }
  }
  const requiredCategories = unique(golden.calibration_required_categories ?? []);
  const presentCategories = unique(caseResults.map((result) => result.category));
  const missingRequiredCategories = requiredCategories.filter((category) => !presentCategories.includes(category));
  const disagreements = caseResults.filter((result) => result.disagreement).length;
  const disagreementRate = caseResults.length === 0 ? 1 : disagreements / caseResults.length;
  const status = staleJudgments.length > 0
    ? "stale"
    : caseResults.length < thresholds.min_calibration_cases || missingRequiredCategories.length > 0 || disagreementRate > thresholds.max_judge_disagreement_rate
      ? "needs_attention"
      : "healthy";
  return {
    status,
    artifact_path: artifactPath,
    artifact_sha256: sha256(raw),
    judge_kind: calibration.judge_kind,
    judge_ids: unique(calibration.judge_ids ?? []),
    judge_model: calibration.judge_model ?? null,
    review_artifact_path: calibration.review_artifact_path ?? null,
    review_artifact_sha256: reviewArtifactSha256,
    sample_cases: caseResults.length,
    disagreements,
    disagreement_rate: Number(disagreementRate.toFixed(3)),
    missing_required_categories: missingRequiredCategories,
    stale_judgments: unique(staleJudgments),
    retrieval_index_match: retrievalIndexMatch,
    review_retrieval_index_match: reviewRetrievalIndexMatch,
    results: caseResults,
  };
}

function emptyMetrics(): AnswerQualityReport["metrics"] {
  return {
    faithfulness: 0,
    answer_relevance: 0,
    correctness: 0,
    grounding: 0,
    source_support: 0,
    forbidden_memory_avoidance: 0,
    current_instruction_compliance: 0,
    noise_budget: 0,
    average_memory_lift: 0,
    p95_latency_ms: 0,
  };
}

function visibleStatus(status: AnswerQualityReport["status"]): string {
  if (status === "healthy") return "Answer quality independently calibrated";
  if (status === "degraded") return "Answer quality evidence missing";
  return "Answer quality needs attention";
}

export function getAnswerQualityStatusPath(dataRoot: string): string {
  return dataPath(dataRoot, ANSWER_QUALITY_STATUS_RELATIVE_PATH);
}

export async function buildAnswerQualityReport(
  dataRoot: string,
  options: BuildOptions = {},
): Promise<AnswerQualityReport> {
  const generatedAt = (options.now ?? new Date()).toISOString();
  const startRss = process.memoryUsage().rss;
  let peakRss = startRss;
  const evidenceIdentity = await buildEvidenceIdentity(dataRoot);
  const loaded = await loadGolden(dataRoot, options);
  const defaultThresholds: AnswerQualityReport["thresholds"] = {
    target_memory_lift: 15,
    min_faithfulness: 0.8,
    min_answer_relevance: 0.75,
    min_correctness: 0.75,
    min_grounding: 0.5,
    min_source_support: 0.8,
    max_noise_paths: 3,
    min_calibration_cases: 5,
    max_judge_disagreement_rate: 0.15,
    max_rss_delta_mb: 256,
    max_p95_latency_ms: 1500,
  };
  if (!loaded.golden || !loaded.sha256) {
    const endRss = process.memoryUsage().rss;
    const emptyCalibration: AnswerQualityReport["calibration"] = {
      status: "missing",
      artifact_path: options.calibrationPath
        ? path.resolve(options.calibrationPath)
        : dataPath(dataRoot, ANSWER_QUALITY_CALIBRATION_RELATIVE_PATH),
      artifact_sha256: null,
      judge_kind: null,
      judge_ids: [],
      judge_model: null,
      review_artifact_path: null,
      review_artifact_sha256: null,
      sample_cases: 0,
      disagreements: 0,
      disagreement_rate: 1,
      missing_required_categories: [],
      stale_judgments: [],
      retrieval_index_match: null,
      review_retrieval_index_match: null,
      results: [],
    };
    return {
      version: ANSWER_QUALITY_VERSION,
      status: "degraded",
      generated_at: generatedAt,
      data_root: path.resolve(dataRoot),
      golden_source: loaded.source,
      golden_path: loaded.path,
      golden_sha256: loaded.sha256,
      evaluator: "structured_memory_behavior_generator_v2",
      evaluator_class: "independent_calibrated_local",
      evidence_identity: evidenceIdentity,
      pack_limit: options.packLimit ?? 8,
      minimum_cases: 1,
      thresholds: defaultThresholds,
      coverage: {
        required_categories: [...REQUIRED_ANSWER_QUALITY_CATEGORIES],
        present_categories: [],
        missing_categories: [...REQUIRED_ANSWER_QUALITY_CATEGORIES],
        required_languages: ["ko", "en"],
        present_languages: [],
        missing_languages: ["ko", "en"],
      },
      counts: {
        cases: 0,
        passed: 0,
        failed: 0,
        hybrid: 0,
        lexical_fallback: 0,
        missing_expected_paths: 0,
        forbidden_returned_paths: 0,
        noise_paths: 0,
      },
      metrics: emptyMetrics(),
      calibration: emptyCalibration,
      resource_usage: {
        start_rss_mb: mb(startRss),
        peak_rss_mb: mb(Math.max(startRss, endRss)),
        end_rss_mb: mb(endRss),
        rss_delta_mb: mb(Math.max(0, endRss - startRss)),
        budget_mb: defaultThresholds.max_rss_delta_mb,
        within_budget: true,
      },
      calibration_packet: [],
      failing_cases: loaded.errors,
      results: [],
      caveats: ["A valid version-2 answer-quality golden set is required; behavior-golden fallback is forbidden."],
      warnings: loaded.errors,
      visible_status: visibleStatus("degraded"),
    };
  }

  const golden = loaded.golden;
  const thresholds: AnswerQualityReport["thresholds"] = {
    target_memory_lift: golden.target_memory_lift ?? defaultThresholds.target_memory_lift,
    min_faithfulness: golden.min_faithfulness ?? defaultThresholds.min_faithfulness,
    min_answer_relevance: golden.min_answer_relevance ?? defaultThresholds.min_answer_relevance,
    min_correctness: golden.min_correctness ?? defaultThresholds.min_correctness,
    min_grounding: golden.min_grounding ?? defaultThresholds.min_grounding,
    min_source_support: golden.min_source_support ?? defaultThresholds.min_source_support,
    max_noise_paths: golden.max_noise_paths ?? defaultThresholds.max_noise_paths,
    min_calibration_cases: golden.min_calibration_cases ?? defaultThresholds.min_calibration_cases,
    max_judge_disagreement_rate: golden.max_judge_disagreement_rate ?? defaultThresholds.max_judge_disagreement_rate,
    max_rss_delta_mb: golden.max_rss_delta_mb ?? defaultThresholds.max_rss_delta_mb,
    max_p95_latency_ms: golden.max_p95_latency_ms ?? defaultThresholds.max_p95_latency_ms,
  };
  const packLimit = options.packLimit ?? golden.pack_limit ?? 8;
  const minimumCases = golden.minimum_cases ?? 1;
  const requiredCategories = unique(golden.required_categories ?? [...REQUIRED_ANSWER_QUALITY_CATEGORIES]);
  const requiredLanguages = unique(golden.required_languages ?? ["ko", "en"]) as EvalLanguage[];
  const presentCategories = unique(golden.cases.map((item) => item.category));
  const presentLanguages = unique(golden.cases.map((item) => item.language)) as EvalLanguage[];
  const missingCategories = requiredCategories.filter((category) => !presentCategories.includes(category));
  const missingLanguages = requiredLanguages.filter((language) => !presentLanguages.includes(language));
  const results: AnswerQualityCaseResult[] = [];
  for (const answerCase of golden.cases) {
    results.push(await evaluateCase(dataRoot, answerCase, packLimit, thresholds));
    peakRss = Math.max(peakRss, process.memoryUsage().rss);
  }
  const calibration = await evaluateCalibration(dataRoot, options, golden, loaded.sha256, evidenceIdentity, results, thresholds);
  peakRss = Math.max(peakRss, process.memoryUsage().rss);
  const endRss = process.memoryUsage().rss;
  const rssDeltaMb = mb(Math.max(0, peakRss - startRss));
  const p95Latency = percentile(results.map((result) => result.latency_ms), 95);
  const resourceWithinBudget = rssDeltaMb <= thresholds.max_rss_delta_mb;
  const failingCases = results.filter((result) => !result.pass).map((result) => result.id);
  if (results.length < minimumCases) failingCases.unshift("minimum_cases_not_met");
  if (missingCategories.length > 0) failingCases.unshift("required_categories_missing");
  if (missingLanguages.length > 0) failingCases.unshift("required_languages_missing");
  if (calibration.status !== "healthy") failingCases.unshift("independent_judge_calibration_not_healthy");
  if (!resourceWithinBudget) failingCases.unshift("evaluation_memory_budget_exceeded");
  if (p95Latency > thresholds.max_p95_latency_ms) failingCases.unshift("evaluation_latency_budget_exceeded");
  const status = results.length === 0 ? "degraded" : failingCases.length > 0 ? "needs_attention" : "healthy";
  const calibrationSample = results.filter((result) => result.calibration_required);
  const calibrationPacketSource = calibrationSample.length > 0 ? calibrationSample : results.slice(0, thresholds.min_calibration_cases);
  return {
    version: ANSWER_QUALITY_VERSION,
    status,
    generated_at: generatedAt,
    data_root: path.resolve(dataRoot),
    golden_source: loaded.source,
    golden_path: loaded.path,
    golden_sha256: loaded.sha256,
    evaluator: "structured_memory_behavior_generator_v2",
    evaluator_class: "independent_calibrated_local",
    evidence_identity: evidenceIdentity,
    pack_limit: packLimit,
    minimum_cases: minimumCases,
    thresholds,
    coverage: {
      required_categories: requiredCategories,
      present_categories: presentCategories,
      missing_categories: missingCategories,
      required_languages: requiredLanguages,
      present_languages: presentLanguages,
      missing_languages: missingLanguages,
    },
    counts: {
      cases: results.length,
      passed: results.filter((result) => result.pass).length,
      failed: results.filter((result) => !result.pass).length,
      hybrid: results.filter((result) => result.retrieval_mode === "hybrid_contextual_v2").length,
      lexical_fallback: results.filter((result) => result.retrieval_mode !== "hybrid_contextual_v2").length,
      missing_expected_paths: results.reduce((sum, result) => sum + result.missing_paths.length, 0),
      forbidden_returned_paths: results.reduce((sum, result) => sum + result.forbidden_returned_paths.length, 0),
      noise_paths: results.reduce((sum, result) => sum + result.noise_paths.length, 0),
    },
    metrics: {
      faithfulness: average(results.map((result) => result.memory_on_metrics.faithfulness)),
      answer_relevance: average(results.map((result) => result.memory_on_metrics.answer_relevance)),
      correctness: average(results.map((result) => result.memory_on_metrics.correctness)),
      grounding: average(results.map((result) => result.memory_on_metrics.grounding)),
      source_support: average(results.map((result) => result.memory_on_metrics.source_support)),
      forbidden_memory_avoidance: average(results.map((result) => result.memory_on_metrics.forbidden_memory_avoidance)),
      current_instruction_compliance: average(results.map((result) => result.memory_on_metrics.current_instruction_compliance)),
      noise_budget: average(results.map((result) => result.memory_on_metrics.noise_budget)),
      average_memory_lift: average(results.map((result) => result.memory_lift)),
      p95_latency_ms: p95Latency,
    },
    calibration,
    resource_usage: {
      start_rss_mb: mb(startRss),
      peak_rss_mb: mb(peakRss),
      end_rss_mb: mb(endRss),
      rss_delta_mb: rssDeltaMb,
      budget_mb: thresholds.max_rss_delta_mb,
      within_budget: resourceWithinBudget,
    },
    calibration_packet: calibrationPacketSource.map((result) => ({
      case_id: result.id,
      category: result.category,
      request: result.request,
      memory_on_answer: result.memory_on_answer,
      memory_off_answer: result.memory_off_answer,
      memory_on_answer_sha256: sha256(result.memory_on_answer),
      memory_off_answer_sha256: sha256(result.memory_off_answer),
      forbidden_actions: result.forbidden_actions,
      forbidden_answer_terms: result.forbidden_answer_terms,
    })),
    failing_cases: unique(failingCases),
    results,
    caveats: [
      "The default generator is deterministic and does not receive golden expected actions; it compiles behavior only from the current request and retrieved reviewed guidance.",
      "Completion requires a hash-bound independent LLM or Ragas calibration artifact over a declared sample.",
      "Behavior-golden fallback is intentionally disabled so a self-derived retrieval fixture cannot satisfy answer-quality completion.",
      "All .dino and 60_Operations records are excluded from evaluation retrieval and its index identity to prevent golden-query leakage and operational self-invalidation.",
      "Retrieval-index drift is audit metadata, not an automatic calibration failure: independent judgments remain valid only while every sampled candidate answer hash and its review evidence match exactly.",
    ],
    warnings: status === "healthy" ? [] : unique(failingCases),
    visible_status: visibleStatus(status),
  };
}

export async function buildAndWriteAnswerQualityReport(
  dataRoot: string,
  options: BuildOptions = {},
): Promise<{ report: AnswerQualityReport; statusPath: string }> {
  const report = await buildAnswerQualityReport(dataRoot, options);
  const statusPath = getAnswerQualityStatusPath(dataRoot);
  await atomicWriteJson(statusPath, report);
  return { report, statusPath };
}
