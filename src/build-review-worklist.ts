import path from "node:path";
import { pathToFileURL } from "node:url";

import { buildReviewWorklist } from "./review-worklist.js";

const dataRoot = path.resolve(process.env.DINOBRAIN_DATA_DIR ?? path.join(process.cwd(), "..", "dinobrain-data"));

async function main(): Promise<void> {
  const started = Date.now();
  const result = await buildReviewWorklist(dataRoot);
  console.log(
    JSON.stringify(
      {
        ok: true,
        data_root: dataRoot,
        elapsed_ms: Date.now() - started,
        status: result.report.status,
        state_path: result.statePath,
        operations_path: result.operationsPath,
        counts: result.report.counts,
        by_kind: result.report.by_kind,
      },
      null,
      2,
    ),
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
}
