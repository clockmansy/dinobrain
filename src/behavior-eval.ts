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
  memory_off_action?: string;
  expected_memory_on_action?: string;
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

async function behaviorActionFromMemory(
  dataRoot: string,
  returnedPaths: string[],
): Promise<{ action: string | null; source_path: string | null }> {
  for (const returnedPath of returnedPaths) {
    if (!returnedPath.startsWith("50_Instances/accepted/") || returnedPath.split("/").includes("..")) continue;
    try {
      const record = JSON.parse(await fs.readFile(path.join(dataRoot, ...returnedPath.split("/")), "utf8")) as Record<string, unknown>;
      const behaviorAction = record.behavior_action;
      if (!behaviorAction || typeof behaviorAction !== "object" || Array.isArray(behaviorAction)) continue;
      const expected = (behaviorAction as Record<string, unknown>).expected_memory_on_action;
      if (typeof expected === "string" && expected.trim()) return { action: expected.trim(), source_path: returnedPath };
    } catch {
      continue;
    }
  }
  return { action: null, source_path: null };
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
    const pack = await getContextPackItems(dataRoot, behaviorCase.request, options.packLimit ?? 8, { includeRecentTasks: false });
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
    const actionRequired = Boolean(behaviorCase.memory_off_action && behaviorCase.expected_memory_on_action);
    const recalledAction = await behaviorActionFromMemory(dataRoot, returnedPaths);
    const memoryOffAction = behaviorCase.memory_off_action?.trim() ?? null;
    const expectedMemoryOnAction = behaviorCase.expected_memory_on_action?.trim() ?? null;
    const memoryOnAction = recalledAction.action ?? memoryOffAction;
    const actionChanged = actionRequired && normalized(memoryOnAction ?? "") !== normalized(memoryOffAction ?? "");
    const actionCorrect = actionRequired && normalized(memoryOnAction ?? "") === normalized(expectedMemoryOnAction ?? "");
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
      memory_off_action: memoryOffAction,
      memory_on_action: memoryOnAction,
      expected_memory_on_action: expectedMemoryOnAction,
      action_source_path: recalledAction.source_path,
      action_changed: actionRequired ? actionChanged : null,
      action_correct: actionRequired ? actionCorrect : null,
      pass:
        lift >= golden.target_memory_lift &&
        memoryOn.pathRecall >= minPathRecall &&
        memoryOn.requiredTermRecall >= 1 &&
        memoryOn.forbiddenHitCount === 0 &&
        (!actionRequired || (actionChanged && actionCorrect)),
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
