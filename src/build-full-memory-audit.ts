import path from "node:path";

import { buildAndWriteFullMemoryAudit } from "./full-memory-audit.js";

const dataRoot = path.resolve(process.env.DINOBRAIN_DATA_DIR ?? path.join(process.cwd(), "..", "dinobrain-data"));

async function main(): Promise<void> {
  const started = Date.now();
  const result = await buildAndWriteFullMemoryAudit(dataRoot);
  console.log(
    JSON.stringify(
      {
        ok: true,
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
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
