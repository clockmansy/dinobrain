import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import { atomicWriteJson } from "./concurrency.js";
import type { RankedRecord } from "./context.js";
import { HYBRID_RETRIEVAL_MODE, type RetrievalMode } from "./hybrid-retrieval.js";
import { getContextPackItems } from "./retrieval.js";

export const RAG_EVAL_VERSION = "rag_eval_v2";
export const RAG_GOLDEN_VERSION = 2;
export const RAG_EVAL_STATUS_RELATIVE_PATH = ".dino/state/rag_eval_status.json";

export const REQUIRED_RAG_GOLDEN_CATEGORIES = [
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

type RagGolden = {
  version: number;
  golden_id: string;
  description?: string;
  pack_limit?: number;
  target_recall?: number;
  target_required_term_recall?: number;
  target_memory_lift?: number;
  min_hybrid_ratio?: number;
  minimum_cases?: number;
  max_noise_paths?: number;
  max_p95_latency_ms?: number;
  required_categories?: string[];
  required_languages?: EvalLanguage[];
  cases: RagGoldenCase[];
};

type RagGoldenCase = {
  id: string;
  category: string;
  language: EvalLanguage;
  query: string;
  expected_paths: string[];
  forbidden_paths?: string[];
  required_terms?: string[];
  forbidden_terms?: string[];
  required_knowledge_roles?: string[];
  allowed_paths?: string[];
  allowed_prefixes?: string[];
  min_path_recall?: number;
  min_required_term_recall?: number;
  min_memory_lift?: number;
  max_noise_paths?: number;
  require_hybrid?: boolean;
};

export type RagEvalCaseResult = {
  id: string;
  category: string;
  language: EvalLanguage;
  query: string;
  retrieval_mode: RetrievalMode | string | null;
  expected_paths: string[];
  returned_paths: string[];
  missing_paths: string[];
  forbidden_paths: string[];
  forbidden_returned_paths: string[];
  noise_paths: string[];
  required_terms: string[];
  forbidden_terms: string[];
  path_recall: number;
  required_term_recall: number;
  forbidden_hit_count: number;
  provenance_coverage: number;
  required_knowledge_roles: string[];
  returned_knowledge_roles: string[];
  knowledge_role_coverage: number;
  memory_on_score: number;
  memory_off_baseline_score: number;
  memory_lift: number;
  hybrid_required: boolean;
  latency_ms: number;
  pass: boolean;
  issue_codes: string[];
};

export type RagEvalReport = {
  version: typeof RAG_EVAL_VERSION;
  status: "healthy" | "needs_attention" | "degraded";
  generated_at: string;
  data_root: string;
  golden_source: "rag_golden_v2" | "missing" | "invalid";
  golden_path: string | null;
  golden_sha256: string | null;
  pack_limit: number;
  target_recall: number;
  target_required_term_recall: number;
  target_memory_lift: number;
  min_hybrid_ratio: number;
  minimum_cases: number;
  max_noise_paths: number;
  max_p95_latency_ms: number;
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
  average_path_recall: number;
  average_required_term_recall: number;
  average_memory_lift: number;
  hybrid_ratio: number;
  p95_latency_ms: number;
  failing_cases: string[];
  results: RagEvalCaseResult[];
  generated_answer_eval: {
    status: "healthy" | "needs_attention" | "degraded";
    evaluator: "retrieval_proxy_not_answer_judge_v2";
    metrics: {
      faithfulness: number;
      answer_relevance: number;
      correctness: number;
      grounding: number;
    };
    cases: Array<{
      id: string;
      generated_answer: string;
      faithfulness: number;
      answer_relevance: number;
      correctness: number;
      grounding: number;
    }>;
  };
  caveats: string[];
  warnings: string[];
  visible_status: string;
};

type BuildOptions = {
  now?: Date;
  goldenPath?: string;
  packLimit?: number;
  minHybridRatio?: number;
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

function isAllowedPath(returnedPath: string, allowedPaths: string[], allowedPrefixes: string[]): boolean {
  return allowedPaths.includes(returnedPath) || allowedPrefixes.some((prefix) => returnedPath.startsWith(prefix));
}

function scoreMemoryOff(requiredTerms: string[], forbiddenTerms: string[], query: string): number {
  const requiredRecall = requiredTerms.length
    ? requiredTerms.filter((term) => containsTerm(query, term)).length / requiredTerms.length
    : 0;
  const forbiddenPenalty = forbiddenTerms.some((term) => containsTerm(query, term)) ? 0 : 10;
  return Number((requiredRecall * 45 + forbiddenPenalty).toFixed(3));
}

function answerFromCase(result: RagEvalCaseResult): string {
  const terms = result.required_terms.filter((term) => !result.forbidden_terms.includes(term));
  if (terms.length === 0) return `Retrieved ${result.returned_paths.length} grounded context records for ${result.query}.`;
  return `Retrieved grounded context for ${result.query}: ${terms.join("; ")}.`;
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

function sha256(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function buildGeneratedAnswerEval(results: RagEvalCaseResult[]): RagEvalReport["generated_answer_eval"] {
  const cases = results.map((result) => {
    const faithfulness = Number((result.forbidden_hit_count === 0 ? Math.min(1, 0.5 + result.provenance_coverage * 0.5) : 0).toFixed(3));
    const answerRelevance = result.required_term_recall;
    const correctness = Number((result.path_recall * 0.6 + result.required_term_recall * 0.4).toFixed(3));
    const grounding = result.provenance_coverage;
    return {
      id: result.id,
      generated_answer: answerFromCase(result),
      faithfulness,
      answer_relevance: answerRelevance,
      correctness,
      grounding,
    };
  });
  const metrics = {
    faithfulness: average(cases.map((item) => item.faithfulness)),
    answer_relevance: average(cases.map((item) => item.answer_relevance)),
    correctness: average(cases.map((item) => item.correctness)),
    grounding: average(cases.map((item) => item.grounding)),
  };
  const status =
    cases.length === 0
      ? "degraded"
      : metrics.faithfulness >= 0.7 && metrics.answer_relevance >= 0.8 && metrics.correctness >= 0.8 && metrics.grounding >= 0.5
        ? "healthy"
        : "needs_attention";
  return {
    status,
    evaluator: "retrieval_proxy_not_answer_judge_v2",
    metrics,
    cases,
  };
}

async function readJsonIfExists<T>(filePath: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function loadGolden(dataRoot: string, options: BuildOptions): Promise<{
  source: RagEvalReport["golden_source"];
  path: string | null;
  sha256: string | null;
  golden: RagGolden | null;
  errors: string[];
}> {
  const explicitPath = options.goldenPath ? path.resolve(options.goldenPath) : null;
  const ragPath = explicitPath ?? path.join(dataRoot, ".dino", "evaluations", "rag-golden.json");
  let raw: Buffer;
  try {
    raw = await fs.readFile(ragPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { source: "missing", path: null, sha256: null, golden: null, errors: ["rag_golden_missing"] };
    }
    throw error;
  }
  let rag: RagGolden;
  try {
    rag = JSON.parse(raw.toString("utf8")) as RagGolden;
  } catch {
    return { source: "invalid", path: ragPath, sha256: sha256(raw), golden: null, errors: ["rag_golden_invalid_json"] };
  }
  const errors: string[] = [];
  if (rag.version !== RAG_GOLDEN_VERSION) errors.push("rag_golden_version_invalid");
  if (!rag.golden_id?.trim()) errors.push("rag_golden_id_missing");
  if (!Array.isArray(rag.cases) || rag.cases.length === 0) errors.push("rag_golden_cases_missing");
  const ids = new Set<string>();
  for (const item of rag.cases ?? []) {
    if (!item.id?.trim() || ids.has(item.id)) errors.push("rag_golden_case_id_invalid");
    ids.add(item.id);
    if (!item.query?.trim()) errors.push(`rag_golden_query_missing:${item.id}`);
    if (!item.category?.trim()) errors.push(`rag_golden_category_missing:${item.id}`);
    if (!(["ko", "en"] as string[]).includes(item.language)) errors.push(`rag_golden_language_invalid:${item.id}`);
  }
  return {
    source: errors.length === 0 ? "rag_golden_v2" : "invalid",
    path: ragPath,
    sha256: sha256(raw),
    golden: errors.length === 0 ? rag : null,
    errors: unique(errors),
  };
}

async function evaluateCase(
  dataRoot: string,
  goldenCase: RagGoldenCase,
  packLimit: number,
  defaults: {
    targetRecall: number;
    targetRequiredTermRecall: number;
    targetMemoryLift: number;
    maxNoisePaths: number;
  },
): Promise<RagEvalCaseResult> {
  const startedAt = Date.now();
  const pack = await getContextPackItems(dataRoot, goldenCase.query, packLimit, { includeRecentTasks: false });
  const ranked = pack.ranked;
  const returnedPaths = unique(ranked.map((record) => record.path));
  const expectedPaths = unique(goldenCase.expected_paths);
  const forbiddenPaths = unique(goldenCase.forbidden_paths ?? []);
  const allowedPaths = unique(goldenCase.allowed_paths ?? []);
  const allowedPrefixes = unique(goldenCase.allowed_prefixes ?? []);
  const requiredTerms = unique(goldenCase.required_terms ?? []);
  const forbiddenTerms = unique(goldenCase.forbidden_terms ?? []);
  const requiredKnowledgeRoles = unique(goldenCase.required_knowledge_roles ?? []);
  const contextText = ranked.map(recordText).join("\n\n");

  const missingPaths = expectedPaths.filter((expectedPath) => !returnedPaths.includes(expectedPath));
  const forbiddenReturnedPaths = forbiddenPaths.filter((forbiddenPath) => returnedPaths.includes(forbiddenPath));
  const noisePaths = returnedPaths.filter(
    (returnedPath) =>
      !expectedPaths.includes(returnedPath) && !isAllowedPath(returnedPath, allowedPaths, allowedPrefixes),
  );
  const pathRecall = expectedPaths.length === 0 ? 1 : (expectedPaths.length - missingPaths.length) / expectedPaths.length;
  const requiredTermRecall = requiredTerms.length
    ? requiredTerms.filter((term) => containsTerm(contextText, term)).length / requiredTerms.length
    : 1;
  const forbiddenHitCount = forbiddenTerms.filter((term) => containsTerm(contextText, term)).length;
  const provenanceCoverage = ranked.length
    ? ranked.filter((record) => hasProvenanceSignal(record)).length / ranked.length
    : 0;
  const returnedKnowledgeRoles = unique(ranked.map((record) => record.knowledge_role));
  const knowledgeRoleCoverage = requiredKnowledgeRoles.length === 0
    ? 1
    : requiredKnowledgeRoles.filter((role) => returnedKnowledgeRoles.includes(role)).length / requiredKnowledgeRoles.length;
  const memoryOnScore = Number(
    (
      pathRecall * 45 +
      requiredTermRecall * 30 +
      (forbiddenHitCount === 0 ? 10 : 0) +
      provenanceCoverage * 10 +
      knowledgeRoleCoverage * 5 +
      (pack.stats.retrieval_mode === HYBRID_RETRIEVAL_MODE ? 5 : 0)
    ).toFixed(3),
  );
  const memoryOffScore = scoreMemoryOff(requiredTerms, forbiddenTerms, goldenCase.query);
  const memoryLift = Number((memoryOnScore - memoryOffScore).toFixed(3));
  const minPathRecall = goldenCase.min_path_recall ?? defaults.targetRecall;
  const minRequiredTermRecall = goldenCase.min_required_term_recall ?? defaults.targetRequiredTermRecall;
  const minMemoryLift = goldenCase.min_memory_lift ?? defaults.targetMemoryLift;
  const hybridRequired = goldenCase.require_hybrid !== false;
  const maxNoisePaths = goldenCase.max_noise_paths ?? defaults.maxNoisePaths;
  const issueCodes: string[] = [];
  if (pathRecall < minPathRecall) issueCodes.push("path_recall_below_target");
  if (requiredTermRecall < minRequiredTermRecall) issueCodes.push("required_term_recall_below_target");
  if (memoryLift < minMemoryLift) issueCodes.push("memory_lift_below_target");
  if (forbiddenHitCount > 0) issueCodes.push("forbidden_context_hit");
  if (forbiddenReturnedPaths.length > 0) issueCodes.push("forbidden_path_returned");
  if (noisePaths.length > maxNoisePaths) issueCodes.push("noise_budget_exceeded");
  if (knowledgeRoleCoverage < 1) issueCodes.push("required_knowledge_role_missing");
  if (hybridRequired && pack.stats.retrieval_mode !== HYBRID_RETRIEVAL_MODE) issueCodes.push("hybrid_retrieval_not_active");

  return {
    id: goldenCase.id,
    category: goldenCase.category,
    language: goldenCase.language,
    query: goldenCase.query,
    retrieval_mode: pack.stats.retrieval_mode,
    expected_paths: expectedPaths,
    returned_paths: returnedPaths,
    missing_paths: missingPaths,
    forbidden_paths: forbiddenPaths,
    forbidden_returned_paths: forbiddenReturnedPaths,
    noise_paths: noisePaths,
    required_terms: requiredTerms,
    forbidden_terms: forbiddenTerms,
    path_recall: Number(pathRecall.toFixed(3)),
    required_term_recall: Number(requiredTermRecall.toFixed(3)),
    forbidden_hit_count: forbiddenHitCount,
    provenance_coverage: Number(provenanceCoverage.toFixed(3)),
    required_knowledge_roles: requiredKnowledgeRoles,
    returned_knowledge_roles: returnedKnowledgeRoles,
    knowledge_role_coverage: Number(knowledgeRoleCoverage.toFixed(3)),
    memory_on_score: memoryOnScore,
    memory_off_baseline_score: memoryOffScore,
    memory_lift: memoryLift,
    hybrid_required: hybridRequired,
    latency_ms: Date.now() - startedAt,
    pass: issueCodes.length === 0,
    issue_codes: issueCodes,
  };
}

function visibleStatus(status: RagEvalReport["status"]): string {
  if (status === "healthy") return "RAG 평가 정상";
  if (status === "degraded") return "RAG 평가 기준 누락";
  return "RAG 평가 개선 필요";
}

export function getRagEvalStatusPath(dataRoot: string): string {
  return path.join(dataRoot, ...RAG_EVAL_STATUS_RELATIVE_PATH.split("/"));
}

export async function buildRagEvalReport(dataRoot: string, options: BuildOptions = {}): Promise<RagEvalReport> {
  const generatedAt = (options.now ?? new Date()).toISOString();
  const loaded = await loadGolden(dataRoot, options);
  if (!loaded.golden) {
    return {
      version: RAG_EVAL_VERSION,
      status: "degraded",
      generated_at: generatedAt,
      data_root: path.resolve(dataRoot),
      golden_source: loaded.source,
      golden_path: loaded.path,
      golden_sha256: loaded.sha256,
      pack_limit: options.packLimit ?? 8,
      target_recall: 0,
      target_required_term_recall: 0,
      target_memory_lift: 0,
      min_hybrid_ratio: options.minHybridRatio ?? 1,
      minimum_cases: 1,
      max_noise_paths: 0,
      max_p95_latency_ms: 0,
      coverage: {
        required_categories: [...REQUIRED_RAG_GOLDEN_CATEGORIES],
        present_categories: [],
        missing_categories: [...REQUIRED_RAG_GOLDEN_CATEGORIES],
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
      average_path_recall: 0,
      average_required_term_recall: 0,
      average_memory_lift: 0,
      hybrid_ratio: 0,
      p95_latency_ms: 0,
      failing_cases: loaded.errors,
      results: [],
      generated_answer_eval: {
        status: "degraded",
        evaluator: "retrieval_proxy_not_answer_judge_v2",
        metrics: {
          faithfulness: 0,
          answer_relevance: 0,
          correctness: 0,
          grounding: 0,
        },
        cases: [],
      },
      caveats: ["A valid explicit version-2 RAG golden is required; behavior/context fallback is forbidden."],
      warnings: loaded.errors,
      visible_status: visibleStatus("degraded"),
    };
  }

  const golden = loaded.golden;
  const packLimit = options.packLimit ?? golden.pack_limit ?? 8;
  const targetRecall = golden.target_recall ?? 0.8;
  const targetRequiredTermRecall = golden.target_required_term_recall ?? 0.8;
  const targetMemoryLift = golden.target_memory_lift ?? 35;
  const minHybridRatio = options.minHybridRatio ?? golden.min_hybrid_ratio ?? 1;
  const minimumCases = golden.minimum_cases ?? 1;
  const maxNoisePaths = golden.max_noise_paths ?? 4;
  const maxP95LatencyMs = golden.max_p95_latency_ms ?? 1500;
  const requiredCategories = unique(golden.required_categories ?? [...REQUIRED_RAG_GOLDEN_CATEGORIES]);
  const requiredLanguages = unique(golden.required_languages ?? ["ko", "en"]) as EvalLanguage[];
  const presentCategories = unique(golden.cases.map((item) => item.category));
  const presentLanguages = unique(golden.cases.map((item) => item.language)) as EvalLanguage[];
  const missingCategories = requiredCategories.filter((category) => !presentCategories.includes(category));
  const missingLanguages = requiredLanguages.filter((language) => !presentLanguages.includes(language));
  const results: RagEvalCaseResult[] = [];
  for (const goldenCase of golden.cases) {
    results.push(
      await evaluateCase(dataRoot, goldenCase, packLimit, {
        targetRecall,
        targetRequiredTermRecall,
        targetMemoryLift,
        maxNoisePaths,
      }),
    );
  }

  const cases = results.length;
  const hybrid = results.filter((result) => result.retrieval_mode === HYBRID_RETRIEVAL_MODE).length;
  const hybridRatio = cases === 0 ? 0 : hybrid / cases;
  const failingCases = results.filter((result) => !result.pass).map((result) => result.id);
  if (cases < minimumCases) failingCases.unshift("minimum_cases_not_met");
  if (hybridRatio < minHybridRatio) failingCases.unshift("hybrid_ratio_below_target");
  if (missingCategories.length > 0) failingCases.unshift("required_categories_missing");
  if (missingLanguages.length > 0) failingCases.unshift("required_languages_missing");
  const p95LatencyMs = percentile(results.map((result) => result.latency_ms), 95);
  if (p95LatencyMs > maxP95LatencyMs) failingCases.unshift("retrieval_latency_budget_exceeded");
  const generatedAnswerEval = buildGeneratedAnswerEval(results);
  const status = cases === 0 ? "degraded" : failingCases.length > 0 ? "needs_attention" : "healthy";

  return {
    version: RAG_EVAL_VERSION,
    status,
    generated_at: generatedAt,
    data_root: path.resolve(dataRoot),
    golden_source: loaded.source,
    golden_path: loaded.path,
    golden_sha256: loaded.sha256,
    pack_limit: packLimit,
    target_recall: targetRecall,
    target_required_term_recall: targetRequiredTermRecall,
    target_memory_lift: targetMemoryLift,
    min_hybrid_ratio: minHybridRatio,
    minimum_cases: minimumCases,
    max_noise_paths: maxNoisePaths,
    max_p95_latency_ms: maxP95LatencyMs,
    coverage: {
      required_categories: requiredCategories,
      present_categories: presentCategories,
      missing_categories: missingCategories,
      required_languages: requiredLanguages,
      present_languages: presentLanguages,
      missing_languages: missingLanguages,
    },
    counts: {
      cases,
      passed: results.filter((result) => result.pass).length,
      failed: results.filter((result) => !result.pass).length,
      hybrid,
      lexical_fallback: results.filter((result) => result.retrieval_mode !== HYBRID_RETRIEVAL_MODE).length,
      missing_expected_paths: results.reduce((sum, result) => sum + result.missing_paths.length, 0),
      forbidden_returned_paths: results.reduce((sum, result) => sum + result.forbidden_returned_paths.length, 0),
      noise_paths: results.reduce((sum, result) => sum + result.noise_paths.length, 0),
    },
    average_path_recall: Number((results.reduce((sum, result) => sum + result.path_recall, 0) / Math.max(1, cases)).toFixed(3)),
    average_required_term_recall: Number(
      (results.reduce((sum, result) => sum + result.required_term_recall, 0) / Math.max(1, cases)).toFixed(3),
    ),
    average_memory_lift: Number((results.reduce((sum, result) => sum + result.memory_lift, 0) / Math.max(1, cases)).toFixed(3)),
    hybrid_ratio: Number(hybridRatio.toFixed(3)),
    p95_latency_ms: p95LatencyMs,
    failing_cases: unique(failingCases),
    results,
    generated_answer_eval: generatedAnswerEval,
    caveats: [
      "generated_answer_eval is a retrieval-derived compatibility proxy and is not the completion-grade answer-quality gate.",
      "Completion-grade generated behavior and independent judge calibration are enforced by answer_quality_v2.",
      "A healthy report requires dense-vector hybrid retrieval unless the case explicitly disables hybrid requirement.",
    ],
    warnings:
      status === "healthy"
        ? []
        : unique([
            hybridRatio < minHybridRatio ? "rag_hybrid_retrieval_not_proven" : "",
            failingCases.length > 0 ? "rag_eval_cases_failed" : "",
            loaded.source !== "rag_golden_v2" ? "rag_eval_explicit_golden_missing" : "",
          ]),
    visible_status: visibleStatus(status),
  };
}

export async function buildAndWriteRagEvalReport(
  dataRoot: string,
  options: BuildOptions = {},
): Promise<{ report: RagEvalReport; statusPath: string }> {
  const report = await buildRagEvalReport(dataRoot, options);
  const statusPath = getRagEvalStatusPath(dataRoot);
  await atomicWriteJson(statusPath, report);
  return { report, statusPath };
}
