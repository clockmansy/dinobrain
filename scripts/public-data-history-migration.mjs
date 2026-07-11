import path from "node:path";

import {
  applyPublicDataHistoryMigration,
  preparePublicDataHistoryMigration,
  rollbackPublicDataHistoryMigration,
} from "./lib/public-data-history-migration.mjs";

function value(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

try {
  const applyManifest = value("--apply");
  const rollbackManifest = value("--rollback");
  if (applyManifest && rollbackManifest) throw new Error("choose_apply_or_rollback");

  let result;
  if (applyManifest) {
    const confirmation = value("--confirm-source-head");
    if (!confirmation) throw new Error("--apply requires --confirm-source-head <sha>");
    result = applyPublicDataHistoryMigration(path.resolve(applyManifest), confirmation);
  } else if (rollbackManifest) {
    const confirmation = value("--confirm-sanitized-head");
    if (!confirmation) throw new Error("--rollback requires --confirm-sanitized-head <sha>");
    result = rollbackPublicDataHistoryMigration(path.resolve(rollbackManifest), confirmation);
  } else {
    result = preparePublicDataHistoryMigration({
      sourceRepo: value("--source-repo") ?? undefined,
      sourceRef: value("--source-ref") ?? undefined,
      outputRoot: value("--output-root") ?? undefined,
      branch: value("--branch") ?? undefined,
    });
  }

  const manifest = result.manifest;
  console.log(
    JSON.stringify(
      {
        ok: true,
        status: manifest.status,
        migration_id: manifest.migration_id,
        manifest_path: result.manifestPath,
        source_head: manifest.source.head,
        sanitized_head: manifest.sanitized.head,
        source_history_blockers: manifest.source.history.summary.blocked,
        sanitized_history_blockers: manifest.sanitized.history.summary.blocked,
        changed_file_count: manifest.mutation.changed_file_count,
        backup_bundle: manifest.backup.bundle_path,
        backup_bundle_sha256: manifest.backup.bundle_sha256,
        force_push_performed: manifest.status === "applied",
      },
      null,
      2,
    ),
  );
} catch (error) {
  console.error(
    JSON.stringify(
      { ok: false, error: error instanceof Error ? error.message : String(error) },
      null,
      2,
    ),
  );
  process.exitCode = 1;
}
