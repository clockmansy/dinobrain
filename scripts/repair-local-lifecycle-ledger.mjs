import { createHash } from "node:crypto";
import { existsSync, promises as fs } from "node:fs";
import path from "node:path";

const dataRoot = path.resolve(process.env.DINOBRAIN_DATA_DIR ?? path.join(process.cwd(), "..", "dinobrain-data"));
const migrationRoot = path.join(dataRoot, ".dino", "migrations", "task-lifecycle");
const apply = process.argv.includes("--apply");

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function digestEntry(entry) {
  const { entry_sha256: _ignored, ...base } = entry;
  return sha256(Buffer.from(JSON.stringify(base), "utf8"));
}

async function atomicJson(filePath, value) {
  const temporary = `${filePath}.${process.pid}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
  await fs.rename(temporary, filePath);
}

async function inspectMigration(directoryName) {
  const directory = path.join(migrationRoot, directoryName);
  const ledgerRoot = path.join(directory, "ledger");
  const manifestPath = path.join(directory, "manifest.json");
  const names = (await fs.readdir(ledgerRoot)).filter((name) => name.endsWith(".json")).sort();
  const manifestBytes = await fs.readFile(manifestPath);
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  let previousStored = null;
  const entries = [];
  const mismatches = [];
  const treeHash = createHash("sha256");
  for (let index = 0; index < names.length; index += 1) {
    const filePath = path.join(ledgerRoot, names[index]);
    const bytes = await fs.readFile(filePath);
    const entry = JSON.parse(bytes.toString("utf8"));
    treeHash.update(names[index]).update("\0").update(sha256(bytes)).update("\n");
    if (entry.sequence !== index + 1 || entry.migration_id !== manifest.migration_id) {
      throw new Error(`Ledger identity mismatch: ${directoryName}/${names[index]}`);
    }
    if (entry.previous_entry_sha256 !== previousStored) {
      throw new Error(`Ledger chain mismatch is not repairable: ${directoryName}/${names[index]}`);
    }
    const calculated = digestEntry(entry);
    if (calculated !== entry.entry_sha256) {
      if (!/^task-redacted-[a-f0-9]{40}$/i.test(String(entry.payload?.task_id ?? ""))) {
        throw new Error(`Non-redaction ledger mismatch is not repairable: ${directoryName}/${names[index]}`);
      }
      mismatches.push({ file: names[index], sequence: entry.sequence, stored: entry.entry_sha256, calculated });
    }
    previousStored = entry.entry_sha256;
    entries.push({ filePath, entry });
  }
  return {
    directoryName,
    manifestPath,
    manifest,
    manifestSha256: sha256(manifestBytes),
    originalLedgerTreeSha256: treeHash.digest("hex"),
    originalHeadSha256: manifest.ledger_head_sha256,
    entries,
    mismatches,
  };
}

async function main() {
  if (!existsSync(migrationRoot)) throw new Error(`Task lifecycle migration root not found: ${migrationRoot}`);
  const directories = (await fs.readdir(migrationRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  const migrations = [];
  for (const directory of directories) migrations.push(await inspectMigration(directory));
  const mismatchCount = migrations.reduce((sum, migration) => sum + migration.mismatches.length, 0);
  const report = {
    version: "local_lifecycle_ledger_repair_v1",
    status: mismatchCount === 0 ? "clean" : apply ? "repaired" : "repair_required",
    generated_at: new Date().toISOString(),
    apply,
    reason: "public_safety_redaction_changed_authenticated_payload_without_rehashing",
    mismatch_count: mismatchCount,
    migrations: [],
  };

  for (const migration of migrations) {
    let previous = null;
    let rewritten = 0;
    if (apply && migration.mismatches.length > 0) {
      for (const item of migration.entries) {
        const base = { ...item.entry, previous_entry_sha256: previous };
        delete base.entry_sha256;
        const repaired = { ...base, entry_sha256: sha256(Buffer.from(JSON.stringify(base), "utf8")) };
        if (repaired.entry_sha256 !== item.entry.entry_sha256 || repaired.previous_entry_sha256 !== item.entry.previous_entry_sha256) {
          await atomicJson(item.filePath, repaired);
          rewritten += 1;
        }
        previous = repaired.entry_sha256;
      }
      migration.manifest.ledger_entry_count = migration.entries.length;
      migration.manifest.ledger_head_sha256 = previous;
      migration.manifest.updated_at = report.generated_at;
      await atomicJson(migration.manifestPath, migration.manifest);
    } else {
      previous = migration.originalHeadSha256;
    }
    report.migrations.push({
      migration_id: migration.manifest.migration_id,
      entry_count: migration.entries.length,
      mismatch_count: migration.mismatches.length,
      mismatch_files: migration.mismatches.map((item) => item.file),
      original_manifest_sha256: migration.manifestSha256,
      original_ledger_tree_sha256: migration.originalLedgerTreeSha256,
      original_head_sha256: migration.originalHeadSha256,
      repaired_head_sha256: previous,
      rewritten_entry_count: rewritten,
    });
  }

  if (apply) {
    const statusPath = path.join(dataRoot, ".dino", "state", "task-lifecycle-ledger-repair.json");
    await fs.mkdir(path.dirname(statusPath), { recursive: true });
    await atomicJson(statusPath, report);
  }
  console.log(JSON.stringify(report, null, 2));
  if (!apply && mismatchCount > 0) process.exitCode = 2;
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }, null, 2));
  process.exit(1);
});
