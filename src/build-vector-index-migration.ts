import { promises as fs } from "node:fs";
import path from "node:path";

import {
  reapplyDenseVectorMigration,
  rollbackDenseVectorMigration,
  VECTOR_INDEX_MIGRATION_STATUS_RELATIVE_PATH,
} from "./vector-index-migration.js";

const dataRoot = path.resolve(process.env.DINOBRAIN_DATA_DIR ?? path.join(process.cwd(), "..", "dinobrain-data"));

function argumentValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main(): Promise<void> {
  const rollbackId = argumentValue("--rollback");
  const reapplyId = argumentValue("--reapply");
  if (rollbackId && reapplyId) throw new Error("Use either --rollback or --reapply, not both.");
  if (process.argv.includes("--rollback") && !rollbackId) throw new Error("--rollback requires a migration id.");
  if (process.argv.includes("--reapply") && !reapplyId) throw new Error("--reapply requires a migration id.");

  const report = rollbackId
    ? await rollbackDenseVectorMigration(dataRoot, rollbackId)
    : reapplyId
      ? await reapplyDenseVectorMigration(dataRoot, reapplyId)
      : JSON.parse(
          await fs.readFile(path.resolve(dataRoot, ...VECTOR_INDEX_MIGRATION_STATUS_RELATIVE_PATH.split("/")), "utf8"),
        );
  console.log(JSON.stringify({ ok: true, data_root: dataRoot, report }, null, 2));
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
