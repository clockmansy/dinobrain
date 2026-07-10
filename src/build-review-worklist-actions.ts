import path from "node:path";
import { pathToFileURL } from "node:url";

import { buildReviewWorklistActions } from "./review-worklist-actions.js";

const dataRoot = path.resolve(process.env.DINOBRAIN_DATA_DIR ?? path.join(process.cwd(), "..", "dinobrain-data"));

async function main(): Promise<void> {
  const started = Date.now();
  const applyAll = process.argv.includes("--apply-all");
  const applyHolds = applyAll || process.argv.includes("--apply-holds");
  const applyMergeReviews = applyAll || process.argv.includes("--apply-merge-reviews");
  const rollbackIndex = process.argv.indexOf("--rollback");
  const rollbackTransactionId = rollbackIndex >= 0 ? process.argv[rollbackIndex + 1] : undefined;
  const result = await buildReviewWorklistActions(dataRoot, { applyHolds, applyMergeReviews, rollbackTransactionId });
  console.log(
    JSON.stringify(
      {
        ok: result.report.counts.skipped === 0,
        data_root: dataRoot,
        elapsed_ms: Date.now() - started,
        status: result.report.status,
        state_path: result.statePath,
        operations_path: result.operationsPath,
        apply: result.report.apply,
        before_counts: result.report.before_counts,
        after_counts: result.report.after_counts,
        counts: result.report.counts,
      },
      null,
      2,
    ),
  );
  if (result.report.counts.skipped > 0) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
}
