import { stat } from "node:fs/promises";
import path from "node:path";

import { buildAndWriteWikiIndex, getWikiIndexPath } from "./wiki-index.js";

const dataRoot = path.resolve(process.env.DINOBRAIN_DATA_DIR ?? path.join(process.cwd(), "..", "dinobrain-data"));

async function main(): Promise<void> {
  const started = Date.now();
  const index = await buildAndWriteWikiIndex(dataRoot);
  const indexPath = getWikiIndexPath(dataRoot);
  const indexStat = await stat(indexPath);
  console.log(
    JSON.stringify(
      {
        ok: true,
        data_root: dataRoot,
        index_path: indexPath,
        record_count: index.record_count,
        term_count: index.stats.term_count,
        node_count: index.stats.node_count,
        edge_count: index.stats.edge_count,
        recent_hot_records: index.hotset.recent_record_ids.length,
        cold_records: index.hotset.cold_record_ids.length,
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
