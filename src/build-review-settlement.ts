import path from "node:path";

import { settleReviewQueueActions } from "./review-settlement.js";

const dataRoot = path.resolve(process.env.DINOBRAIN_DATA_DIR ?? path.join(process.cwd(), "..", "dinobrain-data"));

async function main(): Promise<void> {
  const started = Date.now();
  const apply = process.argv.includes("--apply");
  const result = await settleReviewQueueActions(dataRoot, { apply });
  const ok =
    result.review.counts.unclassified_open === 0 &&
    result.semantic.counts.unclassified_open === 0 &&
    result.actions.status === "healthy";
  console.log(
    JSON.stringify(
      {
        ok,
        apply,
        data_root: dataRoot,
        elapsed_ms: Date.now() - started,
        review_status_path: result.reviewPath,
        semantic_jobs_path: result.semanticPath,
        settlement_actions_path: result.actionsPath,
        review: {
          status: result.review.status,
          visible_status: result.review.visible_status,
          counts: result.review.counts,
          warnings: result.review.warnings,
        },
        semantic: {
          status: result.semantic.status,
          visible_status: result.semantic.visible_status,
          counts: result.semantic.counts,
          warnings: result.semantic.warnings,
        },
        actions: {
          status: result.actions.status,
          visible_status: result.actions.visible_status,
          counts: result.actions.counts,
          warnings: result.actions.warnings,
        },
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
