import path from "node:path";
import { pathToFileURL } from "node:url";

import { applyBehaviorRecallEvidenceMigration } from "./behavior-recall-migration.js";

const dataRoot = path.resolve(process.env.DINOBRAIN_DATA_DIR ?? path.join(process.cwd(), "..", "dinobrain-data"));

function argumentValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main(): Promise<void> {
  const result = await applyBehaviorRecallEvidenceMigration(dataRoot, {
    apply: process.argv.includes("--apply"),
    rollbackTransactionId: argumentValue("--rollback"),
  });
  console.log(JSON.stringify({
    ok: result.report.status === "healthy" || result.report.status === "rolled_back",
    data_root: dataRoot,
    status: result.report.status,
    status_path: result.statusPath,
    operations_path: result.operationsPath,
    counts: result.report.counts,
    migration_id: result.report.migration_id,
    transaction_id: result.report.transaction_id,
    recovery_ref: result.report.recovery_ref,
  }, null, 2));
  if (!["healthy", "rolled_back"].includes(result.report.status)) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
}
