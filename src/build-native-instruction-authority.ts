import path from "node:path";
import { pathToFileURL } from "node:url";

import { buildAndWriteNativeInstructionAuthorityReport } from "./native-instruction-authority.js";

const dataRoot = path.resolve(process.env.DINOBRAIN_DATA_DIR ?? path.join(process.cwd(), "..", "dinobrain-data"));

async function main(): Promise<void> {
  const started = Date.now();
  const result = await buildAndWriteNativeInstructionAuthorityReport(dataRoot);
  console.log(
    JSON.stringify(
      {
        ok: result.report.status === "healthy",
        data_root: dataRoot,
        elapsed_ms: Date.now() - started,
        path: result.path,
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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
}
