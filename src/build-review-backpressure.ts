import path from "node:path";
import { pathToFileURL } from "node:url";

import { buildReviewQueueBackpressure } from "./review-backpressure.js";

const dataRoot = path.resolve(process.env.DINOBRAIN_DATA_DIR ?? path.join(process.cwd(), "..", "dinobrain-data"));

async function main(): Promise<void> {
  const started = Date.now();
  const result = await buildReviewQueueBackpressure(dataRoot, { reconcileAdmission: true });
  console.log(
    JSON.stringify(
      {
        ok: result.report.status === "healthy",
        data_root: dataRoot,
        elapsed_ms: Date.now() - started,
        status: result.report.status,
        state_path: result.statePath,
        counts: result.report.counts,
        lanes: result.report.lanes,
        growth_mode: result.report.growth_mode,
      },
      null,
      2,
    ),
  );
  if (result.report.status !== "healthy") process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
}
