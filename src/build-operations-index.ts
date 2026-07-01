import { stat } from "node:fs/promises";
import path from "node:path";

import { buildAndWriteOperationsIndex, getOperationsIndexPath } from "./operations-index.js";

const dataRoot = path.resolve(process.env.DINOBRAIN_DATA_DIR ?? path.join(process.cwd(), "..", "dinobrain-data"));

async function main(): Promise<void> {
  const started = Date.now();
  const index = await buildAndWriteOperationsIndex(dataRoot);
  const indexPath = getOperationsIndexPath(dataRoot);
  const indexStat = await stat(indexPath);
  console.log(
    JSON.stringify(
      {
        ok: true,
        data_root: dataRoot,
        index_path: indexPath,
        counts: index.counts,
        active_tasks: index.active_tasks.length,
        recent_tasks: index.recent_tasks.length,
        recent_traces: index.recent_traces.length,
        recent_context_packs: index.recent_context_packs.length,
        recent_events: index.recent_events.length,
        size_bytes: indexStat.size,
        elapsed_ms: Date.now() - started,
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
