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
        status: result.report.status,
        visible_status: result.report.visible_status,
        golden_source: result.report.golden_source,
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
