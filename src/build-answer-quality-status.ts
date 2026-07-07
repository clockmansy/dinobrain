import path from "node:path";

import { buildAndWriteAnswerQualityReport } from "./answer-quality.js";

const dataRoot = path.resolve(process.env.DINOBRAIN_DATA_DIR ?? path.join(process.cwd(), "..", "dinobrain-data"));

async function main(): Promise<void> {
  const started = Date.now();
  const result = await buildAndWriteAnswerQualityReport(dataRoot);
  const ok = result.report.status === "healthy";
  console.log(
    JSON.stringify(
      {
        ok,
        data_root: dataRoot,
        elapsed_ms: Date.now() - started,
        answer_quality_status_path: result.statusPath,
        status: result.report.status,
        visible_status: result.report.visible_status,
        golden_source: result.report.golden_source,
        evaluator: result.report.evaluator,
        evaluator_class: result.report.evaluator_class,
        counts: result.report.counts,
        metrics: result.report.metrics,
        failing_cases: result.report.failing_cases,
        warnings: result.report.warnings,
        caveats: result.report.caveats,
      },
      null,
      2,
    ),
  );
  if (!ok) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
