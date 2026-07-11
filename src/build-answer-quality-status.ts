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
        version: result.report.version,
        status: result.report.status,
        visible_status: result.report.visible_status,
        golden_source: result.report.golden_source,
        golden_path: result.report.golden_path,
        golden_sha256: result.report.golden_sha256,
        evaluator: result.report.evaluator,
        evaluator_class: result.report.evaluator_class,
        evidence_identity: result.report.evidence_identity,
        minimum_cases: result.report.minimum_cases,
        thresholds: result.report.thresholds,
        coverage: result.report.coverage,
        counts: result.report.counts,
        metrics: result.report.metrics,
        calibration: result.report.calibration,
        resource_usage: result.report.resource_usage,
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
