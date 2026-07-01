import path from "node:path";

import { buildAndWriteSqliteShards } from "./sqlite-shards.js";

const dataRoot = path.resolve(process.env.DINOBRAIN_DATA_DIR ?? path.join(process.cwd(), "..", "dinobrain-data"));

async function main(): Promise<void> {
  const started = Date.now();
  const manifest = await buildAndWriteSqliteShards(dataRoot);
  console.log(
    JSON.stringify(
      {
        ok: true,
        data_root: dataRoot,
        elapsed_ms: Date.now() - started,
        manifest,
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
