import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  migrateExistingSourceLineage,
  reapplySourceLineageTransaction,
  rollbackSourceLineageTransaction,
} from "./source-lineage-publication.js";

const dataRoot = path.resolve(process.env.DINOBRAIN_DATA_DIR ?? path.join(process.cwd(), "..", "dinobrain-data"));

function argument(name: string): string | null {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] ?? null : null;
}

async function main(): Promise<void> {
  const rollbackId = argument("--rollback");
  const reapplyId = argument("--reapply");
  if (rollbackId && reapplyId) throw new Error("Choose either --rollback or --reapply");
  if (rollbackId) {
    console.log(JSON.stringify({ ok: true, data_root: dataRoot, result: await rollbackSourceLineageTransaction(dataRoot, rollbackId) }, null, 2));
    return;
  }
  if (reapplyId) {
    console.log(JSON.stringify({ ok: true, data_root: dataRoot, result: await reapplySourceLineageTransaction(dataRoot, reapplyId) }, null, 2));
    return;
  }
  const result = await migrateExistingSourceLineage(dataRoot);
  console.log(
    JSON.stringify(
      {
        ok: true,
        data_root: dataRoot,
        migrated: result.migrated,
        idempotent: result.idempotent,
        transaction_ids: result.transactions.map((transaction) => transaction.transaction_id),
        generation_ids: result.transactions.map((transaction) => transaction.generation_id),
      },
      null,
      2,
    ),
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
}
