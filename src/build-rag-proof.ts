import path from "node:path";

import { buildAndWriteRagProof } from "./rag-proof.js";

const dataRoot = path.resolve(process.env.DINOBRAIN_DATA_DIR ?? path.join(process.cwd(), "..", "dinobrain-data"));

async function main(): Promise<void> {
  const started = Date.now();
  const result = await buildAndWriteRagProof(dataRoot);
  const ok = result.report.status === "healthy";
  console.log(
    JSON.stringify(
      {
        ok,
        data_root: dataRoot,
        elapsed_ms: Date.now() - started,
        rag_proof_status_path: result.statusPath,
        status: result.report.status,
        visible_status: result.report.visible_status,
        rag_golden_path: result.report.rag_golden_path,
        dense_vector_path: result.report.dense_vector_path,
        counts: result.report.counts,
        dense_vector: result.report.dense_vector,
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
