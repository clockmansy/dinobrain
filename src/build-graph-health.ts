import path from "node:path";

import { buildAndWriteGraphHealth } from "./graph-health.js";

const dataRoot = path.resolve(process.env.DINOBRAIN_DATA_DIR ?? path.join(process.cwd(), "..", "dinobrain-data"));

async function main(): Promise<void> {
  const started = Date.now();
  const { health, path: healthPath } = await buildAndWriteGraphHealth(dataRoot);
  console.log(
    JSON.stringify(
      {
        ok: true,
        data_root: dataRoot,
        elapsed_ms: Date.now() - started,
        graph_health_path: healthPath,
        status: health.status,
        score: health.score,
        warnings: health.warnings,
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
