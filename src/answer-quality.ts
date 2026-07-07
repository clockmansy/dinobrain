import { promises as fs } from "node:fs";
import path from "node:path";

import type { RankedRecord } from "./context.js";
import { getContextPackItems } from "./retrieval.js";

export const ANSWER_QUALITY_VERSION = "answer_quality_v1";
export const ANSWER_QUALITY_STATUS_RELATIVE_PATH = ".dino/state/answer_quality_status.json";
export const ANSWER_QUALITY_GOLDEN_RELATIVE_PATH = ".dino/evaluations/answer-quality-golden.json";

type BehaviorGolden = {
  version: number;
  description?: string;
  target_memory_lift?: number;
  minimum_cases?: number;
  cases: Array<{
    id: string;
    request: string;
    expected_memory_paths: string[];
    required_context_terms?: string[];
    expected_behavior_terms?: string[];
    forbidden_context_terms?: string[];
  }>;
};

type AnswerQualityGoldenCase = {
  id: string;
  request: string;
  expected_memory_paths: string[];
  required_answer_terms?: string[];
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
};

type AnswerQualityGolden = {
  version: number;
  description?: string;
  pack_limit?: number;
  minimum_cases?: number;
  target_memory_lift?: number;
  min_faithfulness?: number;
  min_answer_relevance?: number;
  min_correctness?: number;
  min_grounding?: number;
  min_source_support?: number;
  max_noise_paths?: number;
  cases: AnswerQualityGoldenCase[];
};

export type AnswerQualityCaseResult = {
  id: string;
  request: string;
  retrieval_mode: string | null;
  expected_memory_paths: string[];
  returned_paths: string[];
  missing_paths: string[];
  noise_paths: string[];
  required_answer_terms: string[];
  forbidden_answer_terms: string[];
  memory_on_answer: string;
  memory_off_answer: string;
  metrics: {
    faithfulness: number;
    answer_relevance: number;
    correctness: number;
    grounding: number;
    source_support: number;
    forbidden_memory_avoidance: number;
    noise_budget: number;
  };
  memory_on_score: number;
  memory_off_score: number;
  memory_lift: number;
  latency_ms: number;
  pass: boolean;
  issue_codes: string[];
};

export type AnswerQualityReport = {
  version: typeof ANSWER_QUALITY_VERSION;
  status: "healthy" | "needs_attention" | "degraded";
  generated_at: string;
  data_root: string;
  golden_source: "answer_quality_golden" | "behavior_golden_fallback" | "missing";
  golden_path: string | null;
  evaluator: "local_paired_answer_quality_judge_v1";
  evaluator_class: "ragas_like_local";
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
  };
  counts: {
    cases: number;
    passed: number;
    failed: number;
    hybrid: number;
    lexical_fallback: number;
    missing_expected_paths: number;
    noise_paths: number;
  };
  metrics: {
    faithfulness: number;
    answer_relevance: number;
    correctness: number;
    grounding: number;
    source_support: number;
    forbidden_memory_avoidance: number;
    noise_budget: number;
    average_memory_lift: number;
    p95_latency_ms: number;
  };
  failing_cases: string[];
  results: AnswerQualityCaseResult[];
  caveats: string[];
  warnings: string[];
  visible_status: string;
};

type BuildOptions = {
  now?: Date;
  goldenPath?: string;
  packLimit?: number;
};

function unique(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}

function normalized(value: string): string {
  return value.toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
}

function containsTerm(haystack: string, term: string): boolean {
  return normalized(haystack).includes(normalized(term));
}

function average(values: number[]): number {
  if (values.length === 0) return 0;
  return Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(3));
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return Number((sorted[index] ?? 0).toFixed(3));
}

function dataPath(dataRoot: string, relativePath: string): string {
  return path.resolve(dataRoot, ...relativePath.split("/"));
}

async function readJsonIfExists<T>(filePath: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function recordText(record: RankedRecord): string {
  return [record.path, record.title, record.summary, record.tags.join(" "), record.excerpt, record.reasons.join(" ")].join("\n");
}

function hasProvenanceSignal(record: RankedRecord): boolean {
  const text = recordText(record).toLowerCase();
  return (
    record.path.startsWith("30_Sources/chunks/") ||
    /(source_uri|source_paths|source_status|evidence|last_verified|confidence|provenance|reviewed_by|reviewed_at|accepted_by_agent_review)/.test(
      text,
    )
  );
}

function isAllowedPath(returnedPath: string, expectedPaths: string[], allowedPaths: string[], allowedPrefixes: string[]): boolean {
  return (
    expectedPaths.includes(returnedPath) ||
    allowedPaths.includes(returnedPath) ||
    allowedPrefixes.some((prefix) => returnedPath.startsWith(prefix))
  );
}

function convertBehaviorGolden(behavior: BehaviorGolden): AnswerQualityGolden {
  return {
    version: 1,
    description: `Converted from behavior golden: ${behavior.description ?? ""}`.trim(),
    pack_limit: 8,
    minimum_cases: behavior.minimum_cases ?? 1,
    target_memory_lift: behavior.target_memory_lift ?? 35,
    min_faithfulness: 0.8,
    min_answer_relevance: 0.8,
    min_correctness: 0.8,
    min_grounding: 0.35,
    min_source_support: 0.8,
    max_noise_paths: 3,
    cases: behavior.cases.map((item) => ({
      id: item.id,
      request: item.request,
      expected_memory_paths: item.expected_memory_paths,
      required_answer_terms: unique([...(item.required_context_terms ?? []), ...(item.expected_behavior_terms ?? [])]),
      forbidden_answer_terms: item.forbidden_context_terms ?? [],
      allowed_prefixes: ["50_Instances/accepted/"],
      require_hybrid: true,
    })),
  };
}

async function loadGolden(dataRoot: string, options: BuildOptions): Promise<{
  source: AnswerQualityReport["golden_source"];
  path: string | null;
  golden: AnswerQualityGolden | null;
}> {
  const explicitPath = options.goldenPath ? path.resolve(options.goldenPath) : null;
  const answerPath = explicitPath ?? dataPath(dataRoot, ANSWER_QUALITY_GOLDEN_RELATIVE_PATH);
  const answer = await readJsonIfExists<AnswerQualityGolden>(answerPath);
  if (answer) return { source: "answer_quality_golden", path: answerPath, golden: answer };

  const behaviorPath = dataPath(dataRoot, ".dino/evaluations/behavior-golden.json");
  const behavior = await readJsonIfExists<BehaviorGolden>(behaviorPath);
  if (behavior) return { source: "behavior_golden_fallback", path: behaviorPath, golden: convertBehaviorGolden(behavior) };
  return { source: "missing", path: null, golden: null };
}

function generateMemoryOnAnswer(request: string, requiredTerms: string[], ranked: RankedRecord[]): string {
  const contextText = ranked.map(recordText).join("\n\n");
  const supportedTerms = requiredTerms.filter((term) => containsTerm(contextText, term));
  const citations = ranked.slice(0, 4).map((record) => record.path);
  const termText = supportedTerms.length > 0 ? supportedTerms.join("; ") : "no required answer terms were retrieved";
  return [`Request: ${request}`, `Memory-backed answer criteria: ${termText}.`, `Citations: ${citations.join(", ")}`].join("\n");
}

function generateMemoryOffAnswer(request: string, requiredTerms: string[]): string {
  const visibleTerms = requiredTerms.filter((term) => containsTerm(request, term));
  return [
    `Request: ${request}`,
    visibleTerms.length > 0
      ? `Without memory, the answer can only infer these request-visible criteria: ${visibleTerms.join("; ")}.`
      : "Without memory, no reviewed answer criteria are available.",
  ].join("\n");
}

function scoreAnswer(params: {
  answer: string;
  request: string;
  contextText: string;
  requiredTerms: string[];
  forbiddenTerms: string[];
  returnedPaths: string[];
  expectedPaths: string[];
  noisePaths: string[];
  maxNoisePaths: number;
  ranked: RankedRecord[];
}): AnswerQualityCaseResult["metrics"] {
  const requiredHitCount = params.requiredTerms.filter((term) => containsTerm(params.answer, term)).length;
  const requiredSupportCount = params.requiredTerms.filter((term) => containsTerm(params.contextText, term)).length;
  const forbiddenHitCount = params.forbiddenTerms.filter((term) => containsTerm(params.answer, term) || containsTerm(params.contextText, term)).length;
  const expectedHitCount = params.expectedPaths.filter((expectedPath) => params.returnedPaths.includes(expectedPath)).length;
  const citedProvenanceCount = params.ranked.filter((record) => params.answer.includes(record.path) && hasProvenanceSignal(record)).length;
  const answerRelevance = params.requiredTerms.length === 0 ? 1 : requiredHitCount / params.requiredTerms.length;
  const supportDenom = Math.max(1, requiredHitCount);
  const faithfulness = requiredHitCount === 0 ? 0 : Math.min(1, requiredSupportCount / supportDenom);
  const sourceSupport = params.expectedPaths.length === 0 ? 1 : expectedHitCount / params.expectedPaths.length;
  const grounding = params.ranked.length === 0 ? 0 : Math.min(1, (citedProvenanceCount + expectedHitCount) / Math.max(1, Math.min(4, params.ranked.length)));
  const forbiddenAvoidance = forbiddenHitCount === 0 ? 1 : 0;
  const noiseBudget = params.noisePaths.length <= params.maxNoisePaths ? 1 : 0;
  const correctness = sourceSupport * 0.45 + answerRelevance * 0.4 + forbiddenAvoidance * 0.15;
  return {
    faithfulness: Number(faithfulness.toFixed(3)),
    answer_relevance: Number(answerRelevance.toFixed(3)),
    correctness: Number(correctness.toFixed(3)),
    grounding: Number(grounding.toFixed(3)),
    source_support: Number(sourceSupport.toFixed(3)),
    forbidden_memory_avoidance: Number(forbiddenAvoidance.toFixed(3)),
    noise_budget: Number(noiseBudget.toFixed(3)),
  };
}

function aggregateScore(metrics: AnswerQualityCaseResult["metrics"]): number {
  return Number(
    (
      metrics.faithfulness * 20 +
      metrics.answer_relevance * 25 +
      metrics.correctness * 25 +
      metrics.grounding * 10 +
      metrics.source_support * 10 +
      metrics.forbidden_memory_avoidance * 5 +
      metrics.noise_budget * 5
    ).toFixed(3),
  );
}

async function evaluateCase(
  dataRoot: string,
  answerCase: AnswerQualityGoldenCase,
  packLimit: number,
  thresholds: AnswerQualityReport["thresholds"],
): Promise<AnswerQualityCaseResult> {
  const startedAt = Date.now();
  const pack = await getContextPackItems(dataRoot, answerCase.request, packLimit);
  const ranked = pack.ranked;
  const returnedPaths = unique(ranked.map((record) => record.path));
  const expectedPaths = unique(answerCase.expected_memory_paths);
  const allowedPaths = unique(answerCase.allowed_paths ?? []);
  const allowedPrefixes = unique(answerCase.allowed_prefixes ?? []);
  const requiredTerms = unique(answerCase.required_answer_terms ?? []);
  const forbiddenTerms = unique(answerCase.forbidden_answer_terms ?? []);
  const contextText = ranked.map(recordText).join("\n\n");
  const missingPaths = expectedPaths.filter((expectedPath) => !returnedPaths.includes(expectedPath));
  const noisePaths = returnedPaths.filter((returnedPath) => !isAllowedPath(returnedPath, expectedPaths, allowedPaths, allowedPrefixes));
  const maxNoisePaths = answerCase.max_noise_paths ?? thresholds.max_noise_paths;
  const memoryOnAnswer = generateMemoryOnAnswer(answerCase.request, requiredTerms, ranked);
  const memoryOffAnswer = generateMemoryOffAnswer(answerCase.request, requiredTerms);
  const memoryOnMetrics = scoreAnswer({
    answer: memoryOnAnswer,
    request: answerCase.request,
    contextText,
    requiredTerms,
    forbiddenTerms,
    returnedPaths,
    expectedPaths,
    noisePaths,
    maxNoisePaths,
    ranked,
  });
  const memoryOffMetrics = scoreAnswer({
    answer: memoryOffAnswer,
    request: answerCase.request,
    contextText: answerCase.request,
    requiredTerms,
    forbiddenTerms,
    returnedPaths: [],
    expectedPaths,
    noisePaths: [],
    maxNoisePaths,
    ranked: [],
  });
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
  if (memoryOnMetrics.noise_budget < 1) issueCodes.push("noise_budget_exceeded");

  return {
    id: answerCase.id,
    request: answerCase.request,
    retrieval_mode: pack.stats.retrieval_mode,
    expected_memory_paths: expectedPaths,
    returned_paths: returnedPaths,
    missing_paths: missingPaths,
    noise_paths: noisePaths,
    required_answer_terms: requiredTerms,
    forbidden_answer_terms: forbiddenTerms,
    memory_on_answer: memoryOnAnswer,
    memory_off_answer: memoryOffAnswer,
    metrics: memoryOnMetrics,
    memory_on_score: memoryOnScore,
    memory_off_score: memoryOffScore,
    memory_lift: memoryLift,
    latency_ms: Date.now() - startedAt,
    pass: issueCodes.length === 0,
    issue_codes: issueCodes,
  };
}

function visibleStatus(status: AnswerQualityReport["status"]): string {
  if (status === "healthy") return "Answer quality healthy";
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
  const loaded = await loadGolden(dataRoot, options);
  if (!loaded.golden) {
    return {
      version: ANSWER_QUALITY_VERSION,
      status: "degraded",
      generated_at: generatedAt,
      data_root: path.resolve(dataRoot),
      golden_source: "missing",
      golden_path: null,
      evaluator: "local_paired_answer_quality_judge_v1",
      evaluator_class: "ragas_like_local",
      pack_limit: options.packLimit ?? 8,
      minimum_cases: 1,
      thresholds: {
        target_memory_lift: 0,
        min_faithfulness: 0,
        min_answer_relevance: 0,
        min_correctness: 0,
        min_grounding: 0,
        min_source_support: 0,
        max_noise_paths: 0,
      },
      counts: {
        cases: 0,
        passed: 0,
        failed: 0,
        hybrid: 0,
        lexical_fallback: 0,
        missing_expected_paths: 0,
        noise_paths: 0,
      },
      metrics: {
        faithfulness: 0,
        answer_relevance: 0,
        correctness: 0,
        grounding: 0,
        source_support: 0,
        forbidden_memory_avoidance: 0,
        noise_budget: 0,
        average_memory_lift: 0,
        p95_latency_ms: 0,
      },
      failing_cases: ["answer_quality_golden_missing"],
      results: [],
      caveats: ["No answer-quality or behavior golden set was available."],
      warnings: ["answer_quality_golden_missing"],
      visible_status: visibleStatus("degraded"),
    };
  }

  const golden = loaded.golden;
  const packLimit = options.packLimit ?? golden.pack_limit ?? 8;
  const minimumCases = golden.minimum_cases ?? 1;
  const thresholds = {
    target_memory_lift: golden.target_memory_lift ?? 35,
    min_faithfulness: golden.min_faithfulness ?? 0.8,
    min_answer_relevance: golden.min_answer_relevance ?? 0.8,
    min_correctness: golden.min_correctness ?? 0.8,
    min_grounding: golden.min_grounding ?? 0.35,
    min_source_support: golden.min_source_support ?? 0.8,
    max_noise_paths: golden.max_noise_paths ?? 3,
  };
  const results: AnswerQualityCaseResult[] = [];
  for (const answerCase of golden.cases) {
    results.push(await evaluateCase(dataRoot, answerCase, packLimit, thresholds));
  }
  const cases = results.length;
  const failingCases = results.filter((result) => !result.pass).map((result) => result.id);
  if (cases < minimumCases) failingCases.unshift("minimum_cases_not_met");
  const status = cases === 0 ? "degraded" : failingCases.length > 0 ? "needs_attention" : "healthy";
  return {
    version: ANSWER_QUALITY_VERSION,
    status,
    generated_at: generatedAt,
    data_root: path.resolve(dataRoot),
    golden_source: loaded.source,
    golden_path: loaded.path,
    evaluator: "local_paired_answer_quality_judge_v1",
    evaluator_class: "ragas_like_local",
    pack_limit: packLimit,
    minimum_cases: minimumCases,
    thresholds,
    counts: {
      cases,
      passed: results.filter((result) => result.pass).length,
      failed: results.filter((result) => !result.pass).length,
      hybrid: results.filter((result) => result.retrieval_mode === "hybrid_contextual_v2").length,
      lexical_fallback: results.filter((result) => result.retrieval_mode !== "hybrid_contextual_v2").length,
      missing_expected_paths: results.reduce((sum, result) => sum + result.missing_paths.length, 0),
      noise_paths: results.reduce((sum, result) => sum + result.noise_paths.length, 0),
    },
    metrics: {
      faithfulness: average(results.map((result) => result.metrics.faithfulness)),
      answer_relevance: average(results.map((result) => result.metrics.answer_relevance)),
      correctness: average(results.map((result) => result.metrics.correctness)),
      grounding: average(results.map((result) => result.metrics.grounding)),
      source_support: average(results.map((result) => result.metrics.source_support)),
      forbidden_memory_avoidance: average(results.map((result) => result.metrics.forbidden_memory_avoidance)),
      noise_budget: average(results.map((result) => result.metrics.noise_budget)),
      average_memory_lift: average(results.map((result) => result.memory_lift)),
      p95_latency_ms: percentile(results.map((result) => result.latency_ms), 95),
    },
    failing_cases: unique(failingCases),
    results,
    caveats: [
      "Evaluator is a deterministic local Ragas-like paired judge over generated memory-on and memory-off answers.",
      "External Ragas or LLM-judge calibration can be added later without weakening this hard gate.",
      loaded.source === "behavior_golden_fallback"
        ? "Using behavior golden cases as the answer-quality golden set until an explicit answer-quality-golden.json is authored."
        : "",
    ].filter(Boolean),
    warnings:
      status === "healthy"
        ? []
        : unique([
            failingCases.length > 0 ? "answer_quality_cases_failed" : "",
            loaded.source !== "answer_quality_golden" ? "answer_quality_using_fallback_golden" : "",
          ]),
    visible_status: visibleStatus(status),
  };
}

export async function buildAndWriteAnswerQualityReport(
  dataRoot: string,
  options: BuildOptions = {},
): Promise<{ report: AnswerQualityReport; statusPath: string }> {
  const report = await buildAnswerQualityReport(dataRoot, options);
  const statusPath = getAnswerQualityStatusPath(dataRoot);
  await fs.mkdir(path.dirname(statusPath), { recursive: true });
  await fs.writeFile(statusPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return { report, statusPath };
}
