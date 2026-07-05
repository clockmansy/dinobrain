import { promises as fs } from "node:fs";
import path from "node:path";

import { getContextPackItems } from "./retrieval.js";

type BehaviorCase = {
  id: string;
  request: string;
  expected_memory_paths: string[];
  expected_behavior_terms?: string[];
};

type BehaviorGolden = {
  version: number;
  description?: string;
  target_memory_lift: number;
  cases: BehaviorCase[];
};

function unique(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)));
}

function scoreMemoryOn(returnedPaths: string[], expectedPaths: string[], terms: string[], request: string): number {
  const pathHits = expectedPaths.length
    ? expectedPaths.filter((expectedPath) => returnedPaths.includes(expectedPath)).length / expectedPaths.length
    : 1;
  const lowerRequest = request.toLowerCase();
  const termHits = terms.length ? terms.filter((term) => lowerRequest.includes(term.toLowerCase())).length / terms.length : 0.5;
  return Number((pathHits * 70 + termHits * 30).toFixed(3));
}

function scoreMemoryOff(terms: string[], request: string): number {
  const lowerRequest = request.toLowerCase();
  const termHits = terms.length ? terms.filter((term) => lowerRequest.includes(term.toLowerCase())).length / terms.length : 0;
  return Number((termHits * 30).toFixed(3));
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
    const terms = unique(behaviorCase.expected_behavior_terms ?? []);
    const memoryOnScore = scoreMemoryOn(returnedPaths, expectedPaths, terms, behaviorCase.request);
    const memoryOffScore = scoreMemoryOff(terms, behaviorCase.request);
    const lift = Number((memoryOnScore - memoryOffScore).toFixed(3));
    results.push({
      id: behaviorCase.id,
      request: behaviorCase.request,
      returned_paths: returnedPaths,
      expected_memory_paths: expectedPaths,
      memory_on_score: memoryOnScore,
      memory_off_baseline_score: memoryOffScore,
      memory_lift: lift,
      pass: lift >= golden.target_memory_lift,
    });
  }

  const averageLift = results.length
    ? Number((results.reduce((sum, result) => sum + result.memory_lift, 0) / results.length).toFixed(3))
    : 0;
  const failing = results.filter((result) => !result.pass).map((result) => result.id);
  return {
    ok: failing.length === 0,
    skipped: false,
    golden_path: goldenPath,
    target_memory_lift: golden.target_memory_lift,
    average_memory_lift: averageLift,
    cases: results.length,
    failing_cases: failing,
    results,
  };
}
