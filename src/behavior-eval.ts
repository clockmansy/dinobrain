import { promises as fs } from "node:fs";
import path from "node:path";

import { getContextPackItems } from "./retrieval.js";

type BehaviorCase = {
  id: string;
  request: string;
  expected_memory_paths: string[];
  required_context_terms?: string[];
  expected_behavior_terms?: string[];
  forbidden_context_terms?: string[];
  min_path_recall?: number;
};

type BehaviorGolden = {
  version: number;
  description?: string;
  target_memory_lift: number;
  minimum_cases?: number;
  cases: BehaviorCase[];
};

function unique(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)));
}

function normalized(value: string): string {
  return value.toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
}

function containsTerm(haystack: string, term: string): boolean {
  return normalized(haystack).includes(normalized(term));
}

function scoreMemoryOn(
  returnedPaths: string[],
  expectedPaths: string[],
  requiredTerms: string[],
  forbiddenTerms: string[],
  contextText: string,
): { score: number; pathRecall: number; requiredTermRecall: number; forbiddenHitCount: number } {
  const pathHits = expectedPaths.length
    ? expectedPaths.filter((expectedPath) => returnedPaths.includes(expectedPath)).length / expectedPaths.length
    : 1;
  const requiredTermHits = requiredTerms.length
    ? requiredTerms.filter((term) => containsTerm(contextText, term)).length / requiredTerms.length
    : 1;
  const forbiddenHitCount = forbiddenTerms.filter((term) => containsTerm(contextText, term)).length;
  const forbiddenScore = forbiddenTerms.length === 0 ? 1 : forbiddenHitCount === 0 ? 1 : 0;
  return {
    score: Number((pathHits * 45 + requiredTermHits * 45 + forbiddenScore * 10).toFixed(3)),
    pathRecall: Number(pathHits.toFixed(3)),
    requiredTermRecall: Number(requiredTermHits.toFixed(3)),
    forbiddenHitCount,
  };
}

function scoreMemoryOff(requiredTerms: string[], forbiddenTerms: string[], request: string): number {
  const requiredTermHits = requiredTerms.length
    ? requiredTerms.filter((term) => containsTerm(request, term)).length / requiredTerms.length
    : 0;
  const forbiddenPenalty = forbiddenTerms.some((term) => containsTerm(request, term)) ? 0 : 10;
  return Number((requiredTermHits * 45 + forbiddenPenalty).toFixed(3));
}

export async function evaluateBehaviorMemoryLift(
  dataRoot: string,
  options: { allowMissingGolden?: boolean; goldenPath?: string; packLimit?: number } = {},
): Promise<Record<string, unknown>> {
  const goldenPath = path.resolve(
    options.goldenPath ?? path.join(dataRoot, ".dino", "evaluations", "behavior-golden.json"),
  );
  let golden: BehaviorGolden;
  try {
    golden = JSON.parse(await fs.readFile(goldenPath, "utf8")) as BehaviorGolden;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return {
      ok: options.allowMissingGolden === true,
      skipped: true,
      reason: "behavior_golden_missing",
      golden_path: goldenPath,
      target_memory_lift: 0,
      average_memory_lift: 0,
      cases: 0,
      results: [],
    };
  }

  const results = [];
  for (const behaviorCase of golden.cases) {
    const pack = await getContextPackItems(dataRoot, behaviorCase.request, options.packLimit ?? 8);
    const returnedPaths = unique(pack.ranked.map((record) => record.path));
    const expectedPaths = unique(behaviorCase.expected_memory_paths);
    const requiredTerms = unique([...(behaviorCase.required_context_terms ?? []), ...(behaviorCase.expected_behavior_terms ?? [])]);
    const forbiddenTerms = unique(behaviorCase.forbidden_context_terms ?? []);
    const contextText = pack.ranked
      .map((record) => [record.path, record.title, record.summary, record.tags.join(" "), record.excerpt].join("\n"))
      .join("\n\n");
    const memoryOn = scoreMemoryOn(returnedPaths, expectedPaths, requiredTerms, forbiddenTerms, contextText);
    const memoryOnScore = memoryOn.score;
    const memoryOffScore = scoreMemoryOff(requiredTerms, forbiddenTerms, behaviorCase.request);
    const lift = Number((memoryOnScore - memoryOffScore).toFixed(3));
    const minPathRecall = behaviorCase.min_path_recall ?? 1;
    results.push({
      id: behaviorCase.id,
      request: behaviorCase.request,
      returned_paths: returnedPaths,
      expected_memory_paths: expectedPaths,
      required_context_terms: requiredTerms,
      forbidden_context_terms: forbiddenTerms,
      path_recall: memoryOn.pathRecall,
      required_context_term_recall: memoryOn.requiredTermRecall,
      forbidden_context_hit_count: memoryOn.forbiddenHitCount,
      memory_on_score: memoryOnScore,
      memory_off_baseline_score: memoryOffScore,
      memory_lift: lift,
      pass:
        lift >= golden.target_memory_lift &&
        memoryOn.pathRecall >= minPathRecall &&
        memoryOn.requiredTermRecall >= 1 &&
        memoryOn.forbiddenHitCount === 0,
    });
  }

  const averageLift = results.length
    ? Number((results.reduce((sum, result) => sum + result.memory_lift, 0) / results.length).toFixed(3))
    : 0;
  const failing = results.filter((result) => !result.pass).map((result) => result.id);
  const minimumCases = golden.minimum_cases ?? 1;
  const enoughCases = results.length >= minimumCases;
  return {
    ok: enoughCases && failing.length === 0,
    skipped: false,
    golden_path: goldenPath,
    target_memory_lift: golden.target_memory_lift,
    minimum_cases: minimumCases,
    average_memory_lift: averageLift,
    cases: results.length,
    failing_cases: enoughCases ? failing : ["minimum_cases_not_met", ...failing],
    results,
  };
}
