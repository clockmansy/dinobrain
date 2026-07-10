import path from "node:path";

import { rollbackTaskLifecycleMigration, settleTaskLifecycle } from "./task-lifecycle-settlement.js";

const dataRoot = path.resolve(process.env.DINOBRAIN_DATA_DIR ?? path.join(process.cwd(), "..", "dinobrain-data"));
const apply = process.argv.includes("--apply");
const rollbackIndex = process.argv.indexOf("--rollback");
const rollbackMigrationId = rollbackIndex >= 0 ? process.argv[rollbackIndex + 1] : null;

async function main(): Promise<void> {
  const started = Date.now();
  if (apply && rollbackMigrationId) throw new Error("Use either --apply or --rollback <migration-id>, not both.");
  if (rollbackIndex >= 0 && !rollbackMigrationId) throw new Error("--rollback requires a migration id.");
  if (rollbackMigrationId) {
    const result = await rollbackTaskLifecycleMigration(dataRoot, rollbackMigrationId);
    console.log(
      JSON.stringify(
        {
          ok: result.manifest.status === "rolled_back",
          data_root: dataRoot,
          elapsed_ms: Date.now() - started,
          migration_id: result.manifest.migration_id,
          migration_status: result.manifest.status,
          migration_manifest_path: result.manifestPath,
          task_lifecycle_settlement_path: result.settlementPath,
          rollback: result.manifest.rollback,
        },
        null,
        2,
      ),
    );
    return;
  }
  const result = await settleTaskLifecycle(dataRoot, { apply });
  const ok = result.report.status === "healthy";
  console.log(
    JSON.stringify(
      {
        ok,
        data_root: dataRoot,
        elapsed_ms: Date.now() - started,
        task_lifecycle_settlement_path: result.statusPath,
        status: result.report.status,
        visible_status: result.report.visible_status,
        apply: result.report.apply,
        counts: result.report.counts,
        warnings: result.report.warnings,
        migration: result.report.migration,
        latest_migration: result.report.latest_migration,
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
