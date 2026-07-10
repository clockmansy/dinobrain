import path from "node:path";
import { pathToFileURL } from "node:url";

import { applyColdPartitions } from "./cold-partitions.js";

const dataRoot = path.resolve(process.env.DINOBRAIN_DATA_DIR ?? path.join(process.cwd(), "..", "dinobrain-data"));

function argumentValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main(): Promise<void> {
  const started = Date.now();
  const result = await applyColdPartitions(dataRoot, {
    apply: process.argv.includes("--apply"),
    rollbackTransactionId: argumentValue("--rollback"),
  });
  console.log(
    JSON.stringify(
      {
        ok: result.report.status !== "needs_apply",
        data_root: dataRoot,
        elapsed_ms: Date.now() - started,
        status: result.report.status,
        state_path: result.statusPath,
        operations_path: result.operationsPath,
        counts: result.report.counts,
        transaction_id: result.report.transaction_id,
        recovery_ref: result.report.recovery_ref,
      },
      null,
      2,
    ),
  );
  if (result.report.status === "needs_apply") process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
}
