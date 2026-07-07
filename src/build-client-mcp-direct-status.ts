import path from "node:path";
import { pathToFileURL } from "node:url";

import { buildAndWriteClientMcpDirectStatus } from "./client-mcp-direct-status.js";

const dataRoot = path.resolve(process.env.DINOBRAIN_DATA_DIR ?? path.join(process.cwd(), "..", "dinobrain-data"));

async function main(): Promise<void> {
  const result = await buildAndWriteClientMcpDirectStatus(dataRoot);
  console.log(
    JSON.stringify(
      {
        ok: true,
        data_root: dataRoot,
        status: result.report.status,
        latest_verified_at: result.report.latest_verified_at,
        path: result.path,
        counts: result.report.counts,
        warnings: result.report.warnings,
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
