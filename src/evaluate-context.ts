import { promises as fs } from "node:fs";
import path from "node:path";

import { getContextPackItems } from "./retrieval.js";

type GoldenCase = {
  id: string;
  question: string;
  expected_paths: string[];
  notes?: string;
};

type GoldenSet = {
  version: number;
  description: string;
  pack_limit: number;
  target_recall: number;
  target_max_noise: number;
  cases: GoldenCase[];
};

type CaseResult = {
  id: string;
  question: string;
  expected_paths: string[];
  returned_paths: string[];
  missing_paths: string[];
  noise_paths: string[];
  operational_noise_paths: string[];
  recall: number;
  noise_count: number;
  pass: boolean;
};

const dataRoot = path.resolve(process.env.DINOBRAIN_DATA_DIR ?? path.join(process.cwd(), "..", "dinobrain-data"));
const goldenPath = path.resolve(
  process.env.DINOBRAIN_GOLDEN_FILE ?? path.join(dataRoot, ".dino", "evaluations", "context-golden.json"),
);

async function readGoldenSet(): Promise<GoldenSet> {
  return JSON.parse(await fs.readFile(goldenPath, "utf8")) as GoldenSet;
}

function unique(value: string[]): string[] {
  return Array.from(new Set(value));
}

function isOperationalNoisePath(returnedPath: string): boolean {
  return returnedPath.startsWith(".dino/tasks/") || returnedPath.startsWith(".dino/context-packs/");
}

async function evaluateCase(goldenCase: GoldenCase, packLimit: number, targetMaxNoise: number): Promise<CaseResult> {
  const { ranked } = await getContextPackItems(dataRoot, goldenCase.question, packLimit);
  const returnedPaths = unique(ranked.map((record) => record.path));
  const expectedPaths = unique(goldenCase.expected_paths);
  const missingPaths = expectedPaths.filter((expectedPath) => !returnedPaths.includes(expectedPath));
  const unexpectedPaths = returnedPaths.filter((returnedPath) => !expectedPaths.includes(returnedPath));
  const operationalNoisePaths = unexpectedPaths.filter(isOperationalNoisePath);
  const noisePaths = unexpectedPaths.filter((returnedPath) => !isOperationalNoisePath(returnedPath));
  const recall = expectedPaths.length === 0 ? 1 : (expectedPaths.length - missingPaths.length) / expectedPaths.length;
  const noiseCount = noisePaths.length;

  return {
    id: goldenCase.id,
    question: goldenCase.question,
    expected_paths: expectedPaths,
    returned_paths: returnedPaths,
    missing_paths: missingPaths,
    noise_paths: noisePaths,
    operational_noise_paths: operationalNoisePaths,
    recall,
    noise_count: noiseCount,
    pass: recall >= 1 && noiseCount <= targetMaxNoise,
  };
}

async function main(): Promise<void> {
  const goldenSet = await readGoldenSet();
  const results = [];

  for (const goldenCase of goldenSet.cases) {
    results.push(await evaluateCase(goldenCase, goldenSet.pack_limit, goldenSet.target_max_noise));
  }

  const totalExpected = results.reduce((sum, result) => sum + result.expected_paths.length, 0);
  const totalFound = results.reduce(
    (sum, result) => sum + (result.expected_paths.length - result.missing_paths.length),
    0,
  );
  const recall = totalExpected === 0 ? 1 : totalFound / totalExpected;
  const maxNoise = Math.max(0, ...results.map((result) => result.noise_count));
  const averageNoise = results.length
    ? results.reduce((sum, result) => sum + result.noise_count, 0) / results.length
    : 0;
  const failingCases = results.filter((result) => !result.pass);
  const pass = recall >= goldenSet.target_recall && maxNoise <= goldenSet.target_max_noise;

  const report = {
    ok: pass,
    data_root: dataRoot,
    golden_file: goldenPath,
    cases: results.length,
    target_recall: goldenSet.target_recall,
    target_max_noise: goldenSet.target_max_noise,
    recall,
    max_noise: maxNoise,
    average_noise: averageNoise,
    failing_cases: failingCases.map((result) => result.id),
    results,
  };

  console.log(JSON.stringify(report, null, 2));
  if (!pass) {
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
