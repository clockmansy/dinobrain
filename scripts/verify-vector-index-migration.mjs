import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const migration = await import(pathToFileURL(path.join(root, "dist", "vector-index-migration.js")).href);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function index(provider, model, dimensions, vector) {
  return {
    version: 2,
    provider,
    model,
    dimensions,
    semantic_embedding_provider: provider !== "local_text_hashing_v1",
    records: { "20_Wiki/example.md": vector },
    queries: { query: vector },
    record_metadata: {
      "20_Wiki/example.md": {
        contextual_chunk: "bounded contextual row",
        source_sha256: "a".repeat(64),
        parent_record_path: null,
        language: "en",
        lifecycle_state: "active",
        verification_status: "verified",
        retrieval_lane: "wiki",
      },
    },
  };
}

async function main() {
  const dataRoot = mkdtempSync(path.join(tmpdir(), "dinobrain-vector-migration-"));
  try {
    const first = index("provider-a", "model-a", 2, [1, 0]);
    const initialized = await migration.writeDenseVectorIndexControlled(dataRoot, first, {
      now: new Date("2026-07-11T00:00:00.000Z"),
    });
    assert(initialized.status === "initialized" && initialized.migration_required === false, "initial build became migration");

    const sameIdentity = await migration.writeDenseVectorIndexControlled(
      dataRoot,
      { ...first, records: { "20_Wiki/example.md": [0.9, 0.1] } },
      { now: new Date("2026-07-11T00:01:00.000Z") },
    );
    assert(sameIdentity.status === "same_identity_updated", "same identity did not update in place");

    const next = index("provider-b", "model-b", 3, [1, 0, 0]);
    const applied = await migration.writeDenseVectorIndexControlled(dataRoot, next, {
      now: new Date("2026-07-11T00:02:00.000Z"),
    });
    assert(applied.status === "applied" && applied.migration_required === true, "identity change was not migrated");
    assert(applied.migration_id && applied.manifest_path, "migration identity or manifest missing");
    const manifest = JSON.parse(readFileSync(path.join(dataRoot, ...applied.manifest_path.split("/")), "utf8"));
    assert(manifest.before_sha256 && manifest.after_sha256, "migration hashes missing");
    assert(existsSync(path.join(dataRoot, ...manifest.before_path.split("/"))), "rollback index missing");
    assert(existsSync(path.join(dataRoot, ...manifest.after_path.split("/"))), "reapply index missing");

    const rolledBack = await migration.rollbackDenseVectorMigration(dataRoot, applied.migration_id);
    assert(rolledBack.status === "rolled_back", "rollback status mismatch");
    const activeAfterRollback = JSON.parse(readFileSync(path.join(dataRoot, ".dino", "index", "dense-vectors.json"), "utf8"));
    assert(activeAfterRollback.provider === "provider-a" && activeAfterRollback.dimensions === 2, "rollback index mismatch");

    const reapplied = await migration.reapplyDenseVectorMigration(dataRoot, applied.migration_id);
    assert(reapplied.status === "applied", "reapply status mismatch");
    const activeAfterReapply = JSON.parse(readFileSync(path.join(dataRoot, ".dino", "index", "dense-vectors.json"), "utf8"));
    assert(activeAfterReapply.provider === "provider-b" && activeAfterReapply.dimensions === 3, "reapply index mismatch");

    await Promise.all([
      migration.writeDenseVectorIndexControlled(dataRoot, index("provider-c", "model-c", 2, [1, 0])),
      migration.writeDenseVectorIndexControlled(dataRoot, index("provider-d", "model-d", 2, [0, 1])),
    ]);
    const activeAfterConcurrent = JSON.parse(readFileSync(path.join(dataRoot, ".dino", "index", "dense-vectors.json"), "utf8"));
    assert(["provider-c", "provider-d"].includes(activeAfterConcurrent.provider), "concurrent migration produced invalid active index");
    assert(!existsSync(path.join(dataRoot, ".dino", "locks", "vector-index-migration.lock")), "vector migration lock leaked");
    const stableRefresh = await migration.writeDenseVectorIndexControlled(dataRoot, activeAfterConcurrent);
    assert(stableRefresh.status === "same_identity_updated", "stable refresh status mismatch");
    assert(stableRefresh.latest_migration?.migration_id, "stable refresh discarded latest migration evidence");

    writeFileSync(path.join(dataRoot, ...manifest.after_path.split("/")), "{}\n", "utf8");
    let rejectedTamper = false;
    try {
      await migration.reapplyDenseVectorMigration(dataRoot, applied.migration_id);
    } catch (error) {
      rejectedTamper = String(error).includes("vector_migration_after_hash_mismatch");
    }
    assert(rejectedTamper, "tampered migration artifact was accepted");

    console.log("vector index migration verification ok");
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
