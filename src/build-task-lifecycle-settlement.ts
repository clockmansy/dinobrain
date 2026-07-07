import path from "node:path";

import { settleTaskLifecycle } from "./task-lifecycle-settlement.js";

const dataRoot = path.resolve(process.env.DINOBRAIN_DATA_DIR ?? path.join(process.cwd(), "..", "dinobrain-data"));
const apply = process.argv.includes("--apply");

async function main(): Promise<void> {
  const started = Date.now();
  const result = await settleTaskLifecycle(dataRoot, { apply });
  const ok = result.report.status === "healthy";
  console.log(
    JSON.stringify(
      {
        ok,
        data_root: dataRoot,
        elapsed_ms: Date.now() - started,
        task_lifecycle_settlement_path: result.statusPath,
        status: result.report.status,
        visible_status: result.report.visible_status,
        apply: result.report.apply,
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
