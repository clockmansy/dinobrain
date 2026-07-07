import path from "node:path";

import { buildAndWriteStatusFreshness } from "./status-freshness.js";

const dataRoot = path.resolve(process.env.DINOBRAIN_DATA_DIR ?? path.join(process.cwd(), "..", "dinobrain-data"));

async function main(): Promise<void> {
  const started = Date.now();
  const result = await buildAndWriteStatusFreshness(dataRoot);
  console.log(
    JSON.stringify(
      {
        ok: result.report.status === "healthy",
        data_root: dataRoot,
        elapsed_ms: Date.now() - started,
        monitoring_status_path: result.path,
        status: result.report.status,
        visible_status: result.report.visible_status,
        counts: result.report.counts,
        warnings: result.report.warnings,
      },
      null,
      2,
    ),
  );
  if (result.report.status !== "healthy") process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
