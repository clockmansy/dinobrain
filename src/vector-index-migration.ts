import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import { atomicWriteJson, withFileLock } from "./concurrency.js";
import { DENSE_VECTOR_INDEX_RELATIVE_PATH, type DenseVectorIndex } from "./hybrid-retrieval.js";

export const VECTOR_INDEX_MIGRATION_VERSION = "vector_index_migration_v1";
export const VECTOR_INDEX_MIGRATION_ROOT = ".dino/index/vector-migrations";
export const VECTOR_INDEX_MIGRATION_STATUS_RELATIVE_PATH = ".dino/state/vector_index_migration.json";
const VECTOR_INDEX_MIGRATION_LOCK_RELATIVE_PATH = ".dino/locks/vector-index-migration.lock";

type MigrationStatus = "initialized" | "same_identity_updated" | "applied" | "rolled_back";

export type VectorIndexIdentity = {
  schema_version: number;
  provider: string | null;
  model: string | null;
  dimensions: number;
  semantic_embedding_provider: boolean;
};

export type VectorIndexMigrationManifest = {
  version: typeof VECTOR_INDEX_MIGRATION_VERSION;
  migration_id: string;
  created_at: string;
  updated_at: string;
  status: "prepared" | "applied" | "rolled_back";
  from: VectorIndexIdentity | null;
  to: VectorIndexIdentity;
  before_sha256: string | null;
  after_sha256: string;
  active_path: typeof DENSE_VECTOR_INDEX_RELATIVE_PATH;
  before_path: string | null;
  after_path: string;
  rollback_count: number;
  reapply_count: number;
};

export type VectorIndexMigrationReport = {
  version: typeof VECTOR_INDEX_MIGRATION_VERSION;
  status: MigrationStatus;
  generated_at: string;
  migration_required: boolean;
  migration_id: string | null;
  manifest_path: string | null;
  active_path: typeof DENSE_VECTOR_INDEX_RELATIVE_PATH;
  from: VectorIndexIdentity | null;
  to: VectorIndexIdentity;
  before_sha256: string | null;
  after_sha256: string;
  latest_migration: {
    migration_id: string;
    manifest_path: string;
    status: "applied" | "rolled_back";
    from: VectorIndexIdentity | null;
    to: VectorIndexIdentity;
    before_sha256: string | null;
    after_sha256: string;
  } | null;
  warnings: string[];
  visible_status: string;
};

function dataPath(dataRoot: string, relativePath: string): string {
  const root = path.resolve(dataRoot);
  const target = path.resolve(root, ...relativePath.split("/"));
  const relative = path.relative(root, target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(`Path escapes data root: ${relativePath}`);
  return target;
}

function sha256Json(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

async function readJson<T>(filePath: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function latestMigrationSummary(
  dataRoot: string,
): Promise<NonNullable<VectorIndexMigrationReport["latest_migration"]> | null> {
  const root = dataPath(dataRoot, VECTOR_INDEX_MIGRATION_ROOT);
  let entries: Array<import("node:fs").Dirent>;
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const manifests: VectorIndexMigrationManifest[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const manifest = await readJson<VectorIndexMigrationManifest>(path.join(root, entry.name, "manifest.json"));
    if (manifest && ["applied", "rolled_back"].includes(manifest.status)) manifests.push(manifest);
  }
  const latest = manifests.sort((a, b) => b.updated_at.localeCompare(a.updated_at))[0];
  if (!latest || latest.status === "prepared") return null;
  return {
    migration_id: latest.migration_id,
    manifest_path: `${VECTOR_INDEX_MIGRATION_ROOT}/${latest.migration_id}/manifest.json`,
    status: latest.status,
    from: latest.from,
    to: latest.to,
    before_sha256: latest.before_sha256,
    after_sha256: latest.after_sha256,
  };
}

export function vectorIndexIdentity(index: DenseVectorIndex): VectorIndexIdentity {
  return {
    schema_version: Number(index.version ?? 0),
    provider: typeof index.provider === "string" ? index.provider : null,
    model: typeof index.model === "string" ? index.model : null,
    dimensions: Number(index.dimensions ?? 0),
    semantic_embedding_provider: index.semantic_embedding_provider === true,
  };
}

function sameIdentity(left: VectorIndexIdentity | null, right: VectorIndexIdentity): boolean {
  return Boolean(
    left &&
      left.schema_version === right.schema_version &&
      left.provider === right.provider &&
      left.model === right.model &&
      left.dimensions === right.dimensions &&
      left.semantic_embedding_provider === right.semantic_embedding_provider,
  );
}

function migrationId(now: Date, from: VectorIndexIdentity | null, to: VectorIndexIdentity, afterSha256: string): string {
  const stamp = now.toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  const identityHash = createHash("sha256").update(JSON.stringify({ from, to, afterSha256 })).digest("hex").slice(0, 12);
  return `vector-index-${stamp}-${identityHash}`;
}

async function writeStatus(dataRoot: string, report: VectorIndexMigrationReport): Promise<void> {
  await atomicWriteJson(dataPath(dataRoot, VECTOR_INDEX_MIGRATION_STATUS_RELATIVE_PATH), report);
}

async function writeDenseVectorIndexControlledUnlocked(
  dataRoot: string,
  nextIndex: DenseVectorIndex,
  options: { now?: Date } = {},
): Promise<VectorIndexMigrationReport> {
  const now = options.now ?? new Date();
  const generatedAt = now.toISOString();
  const activePath = dataPath(dataRoot, DENSE_VECTOR_INDEX_RELATIVE_PATH);
  const previousStatus = await readJson<VectorIndexMigrationReport>(
    dataPath(dataRoot, VECTOR_INDEX_MIGRATION_STATUS_RELATIVE_PATH),
  );
  const current = await readJson<DenseVectorIndex>(activePath);
  const from = current ? vectorIndexIdentity(current) : null;
  const to = vectorIndexIdentity(nextIndex);
  const beforeSha256 = current ? sha256Json(current) : null;
  const afterSha256 = sha256Json(nextIndex);

  if (!current || sameIdentity(from, to)) {
    await atomicWriteJson(activePath, nextIndex);
    const status: MigrationStatus = current ? "same_identity_updated" : "initialized";
    const report: VectorIndexMigrationReport = {
      version: VECTOR_INDEX_MIGRATION_VERSION,
      status,
      generated_at: generatedAt,
      migration_required: false,
      migration_id: null,
      manifest_path: null,
      active_path: DENSE_VECTOR_INDEX_RELATIVE_PATH,
      from,
      to,
      before_sha256: beforeSha256,
      after_sha256: afterSha256,
      latest_migration: previousStatus?.latest_migration ?? await latestMigrationSummary(dataRoot),
      warnings: [],
      visible_status: status === "initialized" ? "Dense vector index initialized" : "Dense vector index updated with stable identity",
    };
    await writeStatus(dataRoot, report);
    return report;
  }

  const id = migrationId(now, from, to, afterSha256);
  const migrationDir = `${VECTOR_INDEX_MIGRATION_ROOT}/${id}`;
  const beforeRelative = `${migrationDir}/before.json`;
  const afterRelative = `${migrationDir}/after.json`;
  const manifestRelative = `${migrationDir}/manifest.json`;
  await atomicWriteJson(dataPath(dataRoot, beforeRelative), current);
  await atomicWriteJson(dataPath(dataRoot, afterRelative), nextIndex);
  const manifest: VectorIndexMigrationManifest = {
    version: VECTOR_INDEX_MIGRATION_VERSION,
    migration_id: id,
    created_at: generatedAt,
    updated_at: generatedAt,
    status: "prepared",
    from,
    to,
    before_sha256: beforeSha256,
    after_sha256: afterSha256,
    active_path: DENSE_VECTOR_INDEX_RELATIVE_PATH,
    before_path: beforeRelative,
    after_path: afterRelative,
    rollback_count: 0,
    reapply_count: 0,
  };
  await atomicWriteJson(dataPath(dataRoot, manifestRelative), manifest);
  await atomicWriteJson(activePath, nextIndex);
  manifest.status = "applied";
  manifest.updated_at = new Date().toISOString();
  await atomicWriteJson(dataPath(dataRoot, manifestRelative), manifest);

  const report: VectorIndexMigrationReport = {
    version: VECTOR_INDEX_MIGRATION_VERSION,
    status: "applied",
    generated_at: manifest.updated_at,
    migration_required: true,
    migration_id: id,
    manifest_path: manifestRelative,
    active_path: DENSE_VECTOR_INDEX_RELATIVE_PATH,
    from,
    to,
    before_sha256: beforeSha256,
    after_sha256: afterSha256,
    latest_migration: {
      migration_id: id,
      manifest_path: manifestRelative,
      status: "applied",
      from,
      to,
      before_sha256: beforeSha256,
      after_sha256: afterSha256,
    },
    warnings: [],
    visible_status: "Dense vector identity migration applied with rollback artifacts",
  };
  await writeStatus(dataRoot, report);
  return report;
}

export async function writeDenseVectorIndexControlled(
  dataRoot: string,
  nextIndex: DenseVectorIndex,
  options: { now?: Date } = {},
): Promise<VectorIndexMigrationReport> {
  return await withFileLock(dataPath(dataRoot, VECTOR_INDEX_MIGRATION_LOCK_RELATIVE_PATH), async () =>
    await writeDenseVectorIndexControlledUnlocked(dataRoot, nextIndex, options));
}

async function readVerifiedMigration(
  dataRoot: string,
  migrationIdValue: string,
): Promise<{ manifest: VectorIndexMigrationManifest; manifestPath: string; before: DenseVectorIndex | null; after: DenseVectorIndex }> {
  if (!/^vector-index-[A-Za-z0-9-]+$/.test(migrationIdValue)) throw new Error("invalid_vector_migration_id");
  const manifestPath = `${VECTOR_INDEX_MIGRATION_ROOT}/${migrationIdValue}/manifest.json`;
  const manifest = await readJson<VectorIndexMigrationManifest>(dataPath(dataRoot, manifestPath));
  if (!manifest || manifest.migration_id !== migrationIdValue) throw new Error("vector_migration_manifest_missing");
  const before = manifest.before_path ? await readJson<DenseVectorIndex>(dataPath(dataRoot, manifest.before_path)) : null;
  const after = await readJson<DenseVectorIndex>(dataPath(dataRoot, manifest.after_path));
  if (!after || sha256Json(after) !== manifest.after_sha256) throw new Error("vector_migration_after_hash_mismatch");
  if (manifest.before_sha256 && (!before || sha256Json(before) !== manifest.before_sha256)) {
    throw new Error("vector_migration_before_hash_mismatch");
  }
  return { manifest, manifestPath, before, after };
}

async function rollbackDenseVectorMigrationUnlocked(
  dataRoot: string,
  migrationIdValue: string,
): Promise<VectorIndexMigrationReport> {
  const { manifest, manifestPath, before } = await readVerifiedMigration(dataRoot, migrationIdValue);
  if (!before) throw new Error("vector_migration_has_no_rollback_index");
  await atomicWriteJson(dataPath(dataRoot, DENSE_VECTOR_INDEX_RELATIVE_PATH), before);
  manifest.status = "rolled_back";
  manifest.rollback_count += 1;
  manifest.updated_at = new Date().toISOString();
  await atomicWriteJson(dataPath(dataRoot, manifestPath), manifest);
  const report: VectorIndexMigrationReport = {
    version: VECTOR_INDEX_MIGRATION_VERSION,
    status: "rolled_back",
    generated_at: manifest.updated_at,
    migration_required: true,
    migration_id: manifest.migration_id,
    manifest_path: manifestPath,
    active_path: DENSE_VECTOR_INDEX_RELATIVE_PATH,
    from: manifest.to,
    to: manifest.from ?? vectorIndexIdentity(before),
    before_sha256: manifest.after_sha256,
    after_sha256: manifest.before_sha256 ?? sha256Json(before),
    latest_migration: {
      migration_id: manifest.migration_id,
      manifest_path: manifestPath,
      status: "rolled_back",
      from: manifest.from,
      to: manifest.to,
      before_sha256: manifest.before_sha256,
      after_sha256: manifest.after_sha256,
    },
    warnings: [],
    visible_status: "Dense vector identity migration rolled back",
  };
  await writeStatus(dataRoot, report);
  return report;
}

export async function rollbackDenseVectorMigration(
  dataRoot: string,
  migrationIdValue: string,
): Promise<VectorIndexMigrationReport> {
  return await withFileLock(dataPath(dataRoot, VECTOR_INDEX_MIGRATION_LOCK_RELATIVE_PATH), async () =>
    await rollbackDenseVectorMigrationUnlocked(dataRoot, migrationIdValue));
}

async function reapplyDenseVectorMigrationUnlocked(
  dataRoot: string,
  migrationIdValue: string,
): Promise<VectorIndexMigrationReport> {
  const { manifest, manifestPath, after } = await readVerifiedMigration(dataRoot, migrationIdValue);
  await atomicWriteJson(dataPath(dataRoot, DENSE_VECTOR_INDEX_RELATIVE_PATH), after);
  manifest.status = "applied";
  manifest.reapply_count += 1;
  manifest.updated_at = new Date().toISOString();
  await atomicWriteJson(dataPath(dataRoot, manifestPath), manifest);
  const report: VectorIndexMigrationReport = {
    version: VECTOR_INDEX_MIGRATION_VERSION,
    status: "applied",
    generated_at: manifest.updated_at,
    migration_required: true,
    migration_id: manifest.migration_id,
    manifest_path: manifestPath,
    active_path: DENSE_VECTOR_INDEX_RELATIVE_PATH,
    from: manifest.from,
    to: manifest.to,
    before_sha256: manifest.before_sha256,
    after_sha256: manifest.after_sha256,
    latest_migration: {
      migration_id: manifest.migration_id,
      manifest_path: manifestPath,
      status: "applied",
      from: manifest.from,
      to: manifest.to,
      before_sha256: manifest.before_sha256,
      after_sha256: manifest.after_sha256,
    },
    warnings: [],
    visible_status: "Dense vector identity migration reapplied",
  };
  await writeStatus(dataRoot, report);
  return report;
}

export async function reapplyDenseVectorMigration(
  dataRoot: string,
  migrationIdValue: string,
): Promise<VectorIndexMigrationReport> {
  return await withFileLock(dataPath(dataRoot, VECTOR_INDEX_MIGRATION_LOCK_RELATIVE_PATH), async () =>
    await reapplyDenseVectorMigrationUnlocked(dataRoot, migrationIdValue));
}
