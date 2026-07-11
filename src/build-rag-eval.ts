import path from "node:path";

import { buildAndWriteRagEvalReport } from "./rag-eval.js";

const dataRoot = path.resolve(process.env.DINOBRAIN_DATA_DIR ?? path.join(process.cwd(), "..", "dinobrain-data"));

async function main(): Promise<void> {
  const started = Date.now();
  const result = await buildAndWriteRagEvalReport(dataRoot);
  const ok = result.report.status === "healthy";
  console.log(
    JSON.stringify(
      {
        ok,
        data_root: dataRoot,
        elapsed_ms: Date.now() - started,
        rag_eval_status_path: result.statusPath,
        version: result.report.version,
        status: result.report.status,
        visible_status: result.report.visible_status,
        golden_source: result.report.golden_source,
        golden_path: result.report.golden_path,
        golden_sha256: result.report.golden_sha256,
        minimum_cases: result.report.minimum_cases,
        min_hybrid_ratio: result.report.min_hybrid_ratio,
        coverage: result.report.coverage,
        counts: result.report.counts,
        average_path_recall: result.report.average_path_recall,
        average_required_term_recall: result.report.average_required_term_recall,
        average_memory_lift: result.report.average_memory_lift,
        hybrid_ratio: result.report.hybrid_ratio,
        generated_answer_eval: result.report.generated_answer_eval,
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
