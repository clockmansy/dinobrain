import path from "node:path";

import { buildAndWriteEvidenceGraph } from "./evidence-graph.js";

const dataRoot = path.resolve(process.env.DINOBRAIN_DATA_DIR ?? path.join(process.cwd(), "..", "dinobrain-data"));

buildAndWriteEvidenceGraph(dataRoot)
  .then(({ status }) => {
    console.log(JSON.stringify({ ok: status.status === "healthy", data_root: dataRoot, ...status }, null, 2));
    if (status.status !== "healthy") process.exitCode = 1;
  })
  .catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
