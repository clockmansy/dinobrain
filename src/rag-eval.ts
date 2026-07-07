import { promises as fs } from "node:fs";
import path from "node:path";

import type { RankedRecord } from "./context.js";
import { HYBRID_RETRIEVAL_MODE, type RetrievalMode } from "./hybrid-retrieval.js";
import { getContextPackItems } from "./retrieval.js";

export const RAG_EVAL_VERSION = "rag_eval_v1";
export const RAG_EVAL_STATUS_RELATIVE_PATH = ".dino/state/rag_eval_status.json";

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

type ContextGolden = {
  version: number;
  description?: string;
  pack_limit?: number;
  target_recall?: number;
  target_max_noise?: number;
  cases: Array<{
    id: string;
    question: string;
    expected_paths: string[];
    allowed_paths?: string[];
    allowed_prefixes?: string[];
  }>;
};

type RagGolden = {
  version: number;
  description?: string;
  pack_limit?: number;
  target_recall?: number;
  target_required_term_recall?: number;
  target_memory_lift?: number;
  min_hybrid_ratio?: number;
  minimum_cases?: number;
  cases: RagGoldenCase[];
};

type RagGoldenCase = {
  id: string;
  query: string;
  expected_paths: string[];
  required_terms?: string[];
  forbidden_terms?: string[];
  allowed_paths?: string[];
  allowed_prefixes?: string[];
  min_path_recall?: number;
  min_required_term_recall?: number;
  min_memory_lift?: number;
  require_hybrid?: boolean;
};

export type RagEvalCaseResult = {
  id: string;
  query: string;
  retrieval_mode: RetrievalMode | string | null;
  expected_paths: string[];
  returned_paths: string[];
  missing_paths: string[];
  noise_paths: string[];
  required_terms: string[];
  forbidden_terms: string[];
  path_recall: number;
  required_term_recall: number;
  forbidden_hit_count: number;
  provenance_coverage: number;
  memory_on_score: number;
  memory_off_baseline_score: number;
  memory_lift: number;
  hybrid_required: boolean;
  pass: boolean;
  issue_codes: string[];
};

export type RagEvalReport = {
  version: typeof RAG_EVAL_VERSION;
  status: "healthy" | "needs_attention" | "degraded";
  generated_at: string;
  data_root: string;
  golden_source: "rag_golden" | "behavior_golden_fallback" | "context_golden_fallback" | "missing";
  golden_path: string | null;
  pack_limit: number;
  target_recall: number;
  target_required_term_recall: number;
  target_memory_lift: number;
  min_hybrid_ratio: number;
  minimum_cases: number;
  counts: {
    cases: number;
    passed: number;
    failed: number;
    hybrid: number;
    lexical_fallback: number;
    missing_expected_paths: number;
    noise_paths: number;
  };
  average_path_recall: number;
  average_required_term_recall: number;
  average_memory_lift: number;
  hybrid_ratio: number;
  failing_cases: string[];
  results: RagEvalCaseResult[];
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
  golden: RagGolden | null;
}> {
  const explicitPath = options.goldenPath ? path.resolve(options.goldenPath) : null;
  const ragPath = explicitPath ?? path.join(dataRoot, ".dino", "evaluations", "rag-golden.json");
  const rag = await readJsonIfExists<RagGolden>(ragPath);
  if (rag) return { source: "rag_golden", path: ragPath, golden: rag };

  const behaviorPath = path.join(dataRoot, ".dino", "evaluations", "behavior-golden.json");
  const behavior = await readJsonIfExists<BehaviorGolden>(behaviorPath);
  if (behavior) {
    return {
      source: "behavior_golden_fallback",
      path: behaviorPath,
      golden: {
        version: 1,
        description: `Converted from behavior golden: ${behavior.description ?? ""}`.trim(),
        pack_limit: 8,
        target_recall: 0.8,
        target_required_term_recall: 0.8,
        target_memory_lift: behavior.target_memory_lift ?? 35,
        min_hybrid_ratio: 1,
        minimum_cases: behavior.minimum_cases ?? 1,
        cases: behavior.cases.map((item) => ({
          id: item.id,
          query: item.request,
          expected_paths: item.expected_memory_paths,
          required_terms: unique([...(item.required_context_terms ?? []), ...(item.expected_behavior_terms ?? [])]),
          forbidden_terms: item.forbidden_context_terms ?? [],
          allowed_prefixes: ["50_Instances/accepted/"],
          require_hybrid: true,
        })),
      },
    };
  }

  const contextPath = path.join(dataRoot, ".dino", "evaluations", "context-golden.json");
  const context = await readJsonIfExists<ContextGolden>(contextPath);
  if (context) {
    return {
      source: "context_golden_fallback",
      path: contextPath,
      golden: {
        version: 1,
        description: `Converted from context golden: ${context.description ?? ""}`.trim(),
        pack_limit: context.pack_limit ?? 7,
        target_recall: context.target_recall ?? 0.8,
        target_required_term_recall: 0,
        target_memory_lift: 0,
        min_hybrid_ratio: 1,
        minimum_cases: 1,
        cases: context.cases.map((item) => ({
          id: item.id,
          query: item.question,
          expected_paths: item.expected_paths,
          allowed_paths: item.allowed_paths ?? [],
          allowed_prefixes: item.allowed_prefixes ?? [],
          require_hybrid: true,
        })),
      },
    };
  }

  return { source: "missing", path: null, golden: null };
}

async function evaluateCase(
  dataRoot: string,
  goldenCase: RagGoldenCase,
  packLimit: number,
  defaults: {
    targetRecall: number;
    targetRequiredTermRecall: number;
    targetMemoryLift: number;
  },
): Promise<RagEvalCaseResult> {
  const pack = await getContextPackItems(dataRoot, goldenCase.query, packLimit);
  const ranked = pack.ranked;
  const returnedPaths = unique(ranked.map((record) => record.path));
  const expectedPaths = unique(goldenCase.expected_paths);
  const allowedPaths = unique(goldenCase.allowed_paths ?? []);
  const allowedPrefixes = unique(goldenCase.allowed_prefixes ?? []);
  const requiredTerms = unique(goldenCase.required_terms ?? []);
  const forbiddenTerms = unique(goldenCase.forbidden_terms ?? []);
  const contextText = ranked.map(recordText).join("\n\n");

  const missingPaths = expectedPaths.filter((expectedPath) => !returnedPaths.includes(expectedPath));
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
  const memoryOnScore = Number(
    (
      pathRecall * 45 +
      requiredTermRecall * 30 +
      (forbiddenHitCount === 0 ? 10 : 0) +
      provenanceCoverage * 10 +
      (pack.stats.retrieval_mode === HYBRID_RETRIEVAL_MODE ? 5 : 0)
    ).toFixed(3),
  );
  const memoryOffScore = scoreMemoryOff(requiredTerms, forbiddenTerms, goldenCase.query);
  const memoryLift = Number((memoryOnScore - memoryOffScore).toFixed(3));
  const minPathRecall = goldenCase.min_path_recall ?? defaults.targetRecall;
  const minRequiredTermRecall = goldenCase.min_required_term_recall ?? defaults.targetRequiredTermRecall;
  const minMemoryLift = goldenCase.min_memory_lift ?? defaults.targetMemoryLift;
  const hybridRequired = goldenCase.require_hybrid !== false;
  const issueCodes: string[] = [];
  if (pathRecall < minPathRecall) issueCodes.push("path_recall_below_target");
  if (requiredTermRecall < minRequiredTermRecall) issueCodes.push("required_term_recall_below_target");
  if (memoryLift < minMemoryLift) issueCodes.push("memory_lift_below_target");
  if (forbiddenHitCount > 0) issueCodes.push("forbidden_context_hit");
  if (hybridRequired && pack.stats.retrieval_mode !== HYBRID_RETRIEVAL_MODE) issueCodes.push("hybrid_retrieval_not_active");

  return {
    id: goldenCase.id,
    query: goldenCase.query,
    retrieval_mode: pack.stats.retrieval_mode,
    expected_paths: expectedPaths,
    returned_paths: returnedPaths,
    missing_paths: missingPaths,
    noise_paths: noisePaths,
    required_terms: requiredTerms,
    forbidden_terms: forbiddenTerms,
    path_recall: Number(pathRecall.toFixed(3)),
    required_term_recall: Number(requiredTermRecall.toFixed(3)),
    forbidden_hit_count: forbiddenHitCount,
    provenance_coverage: Number(provenanceCoverage.toFixed(3)),
    memory_on_score: memoryOnScore,
    memory_off_baseline_score: memoryOffScore,
    memory_lift: memoryLift,
    hybrid_required: hybridRequired,
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
      golden_source: "missing",
      golden_path: null,
      pack_limit: options.packLimit ?? 8,
      target_recall: 0,
      target_required_term_recall: 0,
      target_memory_lift: 0,
      min_hybrid_ratio: options.minHybridRatio ?? 1,
      minimum_cases: 1,
      counts: {
        cases: 0,
        passed: 0,
        failed: 0,
        hybrid: 0,
        lexical_fallback: 0,
        missing_expected_paths: 0,
        noise_paths: 0,
      },
      average_path_recall: 0,
      average_required_term_recall: 0,
      average_memory_lift: 0,
      hybrid_ratio: 0,
      failing_cases: ["rag_golden_missing"],
      results: [],
      caveats: ["No RAG golden set, behavior golden set, or context golden set was available."],
      warnings: ["rag_eval_golden_missing"],
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
  const results: RagEvalCaseResult[] = [];
  for (const goldenCase of golden.cases) {
    results.push(
      await evaluateCase(dataRoot, goldenCase, packLimit, {
        targetRecall,
        targetRequiredTermRecall,
        targetMemoryLift,
      }),
    );
  }

  const cases = results.length;
  const hybrid = results.filter((result) => result.retrieval_mode === HYBRID_RETRIEVAL_MODE).length;
  const hybridRatio = cases === 0 ? 0 : hybrid / cases;
  const failingCases = results.filter((result) => !result.pass).map((result) => result.id);
  if (cases < minimumCases) failingCases.unshift("minimum_cases_not_met");
  if (hybridRatio < minHybridRatio) failingCases.unshift("hybrid_ratio_below_target");
  const status = cases === 0 ? "degraded" : failingCases.length > 0 ? "needs_attention" : "healthy";

  return {
    version: RAG_EVAL_VERSION,
    status,
    generated_at: generatedAt,
    data_root: path.resolve(dataRoot),
    golden_source: loaded.source,
    golden_path: loaded.path,
    pack_limit: packLimit,
    target_recall: targetRecall,
    target_required_term_recall: targetRequiredTermRecall,
    target_memory_lift: targetMemoryLift,
    min_hybrid_ratio: minHybridRatio,
    minimum_cases: minimumCases,
    counts: {
      cases,
      passed: results.filter((result) => result.pass).length,
      failed: results.filter((result) => !result.pass).length,
      hybrid,
      lexical_fallback: results.filter((result) => result.retrieval_mode !== HYBRID_RETRIEVAL_MODE).length,
      missing_expected_paths: results.reduce((sum, result) => sum + result.missing_paths.length, 0),
      noise_paths: results.reduce((sum, result) => sum + result.noise_paths.length, 0),
    },
    average_path_recall: Number((results.reduce((sum, result) => sum + result.path_recall, 0) / Math.max(1, cases)).toFixed(3)),
    average_required_term_recall: Number(
      (results.reduce((sum, result) => sum + result.required_term_recall, 0) / Math.max(1, cases)).toFixed(3),
    ),
    average_memory_lift: Number((results.reduce((sum, result) => sum + result.memory_lift, 0) / Math.max(1, cases)).toFixed(3)),
    hybrid_ratio: Number(hybridRatio.toFixed(3)),
    failing_cases: unique(failingCases),
    results,
    caveats: [
      "This is a deterministic RAG canary, not a full Ragas/LLM-judge answer-quality evaluation yet.",
      "A healthy report requires dense-vector hybrid retrieval unless the case explicitly disables hybrid requirement.",
      loaded.source === "behavior_golden_fallback"
        ? "Using behavior golden cases as the RAG golden set until an explicit rag-golden.json is authored."
        : "",
    ].filter(Boolean),
    warnings:
      status === "healthy"
        ? []
        : unique([
            hybridRatio < minHybridRatio ? "rag_hybrid_retrieval_not_proven" : "",
            failingCases.length > 0 ? "rag_eval_cases_failed" : "",
            loaded.source !== "rag_golden" ? "rag_eval_using_fallback_golden" : "",
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
  await fs.mkdir(path.dirname(statusPath), { recursive: true });
  await fs.writeFile(statusPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return { report, statusPath };
}
