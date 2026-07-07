import path from "node:path";

import { buildAndWriteFullMemoryAudit } from "./full-memory-audit.js";

const dataRoot = path.resolve(process.env.DINOBRAIN_DATA_DIR ?? path.join(process.cwd(), "..", "dinobrain-data"));

async function main(): Promise<void> {
  const started = Date.now();
  const result = await buildAndWriteFullMemoryAudit(dataRoot);
  const ok = !["drift_unclassified", "parse_error"].includes(result.report.status);
  console.log(
    JSON.stringify(
      {
        ok,
        data_root: dataRoot,
        elapsed_ms: Date.now() - started,
        manifest_path: result.manifestPath,
        status_path: result.statusPath,
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
