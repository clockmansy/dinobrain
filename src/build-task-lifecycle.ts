import path from "node:path";

import { buildAndWriteTaskLifecycleReport } from "./task-lifecycle.js";

const dataRoot = path.resolve(process.env.DINOBRAIN_DATA_DIR ?? path.join(process.cwd(), "..", "dinobrain-data"));

async function main(): Promise<void> {
  const started = Date.now();
  const result = await buildAndWriteTaskLifecycleReport(dataRoot);
  const ok = result.report.status === "healthy";
  console.log(
    JSON.stringify(
      {
        ok,
        data_root: dataRoot,
        elapsed_ms: Date.now() - started,
        task_lifecycle_path: result.statusPath,
        finish_grounding_path: result.groundingPath,
        status: result.report.status,
        visible_status: result.report.visible_status,
        counts: result.report.counts,
        warnings: result.report.warnings,
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
