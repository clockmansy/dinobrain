import path from "node:path";

import { buildAndWriteLiveSemanticQueryReport } from "./live-semantic-query-status.js";

const dataRoot = path.resolve(process.env.DINOBRAIN_DATA_DIR ?? path.join(process.cwd(), "..", "dinobrain-data"));

async function main(): Promise<void> {
  const started = Date.now();
  const result = await buildAndWriteLiveSemanticQueryReport(dataRoot);
  const ok = result.report.status === "healthy";
  console.log(
    JSON.stringify(
      {
        ok,
        data_root: dataRoot,
        elapsed_ms: Date.now() - started,
        live_semantic_query_status_path: result.statusPath,
        status: result.report.status,
        visible_status: result.report.visible_status,
        proof: result.report.proof,
        retrieval: result.report.retrieval,
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
