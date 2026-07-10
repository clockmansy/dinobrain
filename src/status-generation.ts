import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { TextDecoder } from "node:util";

import { atomicWriteJson, withFileLock } from "./concurrency.js";

export const STATUS_GENERATION_VERSION = "status_generation_v1";
export const STATUS_GENERATION_ROOT_RELATIVE_PATH = ".dino/generations/status";
export const STATUS_GENERATION_POINTER_RELATIVE_PATH = ".dino/state/current-status-generation.json";

const SQLITE_HEADER = Buffer.from("SQLite format 3\0", "ascii");
const STRICT_UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

export const STATUS_GENERATION_ARTIFACT_PATHS = [
  ".dino/index/wiki-index.json",
  ".dino/index/operations-index.json",
  ".dino/index/sqlite/manifest.json",
  ".dino/index/sqlite/wiki.sqlite",
  ".dino/index/sqlite/operations.sqlite",
  ".dino/index/graph-health.json",
  ".dino/index/dense-vectors.json",
  ".dino/evaluations/rag-golden.json",
  ".dino/state/wiki-review-queue.json",
  ".dino/state/semantic_jobs.json",
  ".dino/state/review_queue_settlement_actions.json",
  ".dino/state/review_worklist.json",
  ".dino/state/review_worklist_actions.json",
  ".dino/state/task_sessions.json",
  ".dino/state/task_finish_grounding_classifications.jsonl",
  ".dino/state/task_lifecycle_settlement.json",
  ".dino/state/rag_proof_status.json",
  ".dino/state/rag_eval_status.json",
  ".dino/state/live_semantic_query_status.json",
  ".dino/state/answer_quality_status.json",
  ".dino/state/release_manifest_status.json",
  ".dino/state/source_lineage_status.json",
  ".dino/state/behavior_recall_status.json",
  ".dino/state/full_memory_manifest.json",
  ".dino/state/full_memory_audit_status.json",
  ".dino/state/client_mcp_direct_status.json",
  ".dino/state/native_instruction_authority.json",
  ".dino/state/health_status.json",
  ".dino/state/monitoring_status.json",
] as const;

export type StatusGenerationEntry = {
  source_path: string;
  snapshot_path: string;
  kind: "json" | "jsonl" | "sqlite";
  size_bytes: number;
  sha256: string;
  source_mtime: string;
  generated_at: string | null;
  reported_status: string | null;
};

export type StatusGenerationManifest = {
  version: typeof STATUS_GENERATION_VERSION;
  generation_id: string;
  generated_at: string;
  producer_command: string;
  source_watermark: {
    latest_mtime: string | null;
    aggregate_sha256: string;
  };
  entry_count: number;
  entries: StatusGenerationEntry[];
};

export type StatusGenerationPointer = {
  version: typeof STATUS_GENERATION_VERSION;
  status: "published";
  generation_id: string;
  generated_at: string;
  manifest_path: string;
  manifest_sha256: string;
  entry_count: number;
};

export type LoadedStatusGeneration = {
  status: "healthy" | "missing" | "invalid";
  reason: string | null;
  pointer: StatusGenerationPointer | null;
  manifest: StatusGenerationManifest | null;
  generation_root: string | null;
  errors: string[];
};

export type PublishStatusGenerationOptions = {
  artifactPaths?: readonly string[];
  generationId?: string;
  now?: Date;
  retainGenerations?: number;
  producerCommand?: string;
  beforePointerPublish?: (generation: {
    generation_id: string;
    generation_root: string;
    manifest: StatusGenerationManifest;
  }) => Promise<void> | void;
};

function dataPath(dataRoot: string, relativePath: string): string {
  return path.resolve(dataRoot, ...relativePath.split("/"));
}

function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function compactTimestamp(date: Date): string {
  return date.toISOString().replace(/[-:]/g, "").replace("T", "-").replace(/[.Z]/g, "");
}

export function createStatusGenerationId(now = new Date()): string {
  return `status-${compactTimestamp(now)}-${randomUUID()}`;
}

function validateGenerationId(generationId: string): void {
  if (!/^status-[A-Za-z0-9._-]+$/.test(generationId)) throw new Error("Invalid status generation id");
}

function artifactKind(relativePath: string): StatusGenerationEntry["kind"] {
  if (relativePath.endsWith(".jsonl")) return "jsonl";
  if (relativePath.endsWith(".sqlite")) return "sqlite";
  return "json";
}

function validateRelativePath(relativePath: string): void {
  const normalized = path.posix.normalize(relativePath);
  if (
    !relativePath ||
    relativePath.includes("\\") ||
    path.posix.isAbsolute(relativePath) ||
    normalized !== relativePath ||
    normalized === ".." ||
    normalized.startsWith("../")
  ) {
    throw new Error(`Unsafe status artifact path: ${relativePath}`);
  }
}

function decodeStrictUtf8(relativePath: string, raw: Buffer): string {
  for (let index = 0; index < raw.length; index += 1) {
    if (raw[index] === 0x0d && raw[index + 1] !== 0x0a) {
      throw new Error(`Bare carriage return: ${relativePath}`);
    }
  }
  try {
    return STRICT_UTF8_DECODER.decode(raw);
  } catch {
    throw new Error(`Invalid UTF-8: ${relativePath}`);
  }
}

function validateSqliteBytes(relativePath: string, raw: Buffer): void {
  if (raw.length < 100 || !raw.subarray(0, SQLITE_HEADER.length).equals(SQLITE_HEADER)) {
    throw new Error(`Invalid SQLite header: ${relativePath}`);
  }
  const encodedPageSize = raw.readUInt16BE(16);
  const pageSize = encodedPageSize === 1 ? 65_536 : encodedPageSize;
  if (pageSize < 512 || pageSize > 65_536 || (pageSize & (pageSize - 1)) !== 0) {
    throw new Error(`Invalid SQLite page size: ${relativePath}`);
  }
  if (raw.length % pageSize !== 0) throw new Error(`Truncated SQLite pages: ${relativePath}`);
  const headerPageCount = raw.readUInt32BE(28);
  const actualPageCount = raw.length / pageSize;
  if (headerPageCount !== 0 && headerPageCount !== actualPageCount) {
    throw new Error(`SQLite page count mismatch: ${relativePath}`);
  }
}

function pragmaValue(row: unknown): unknown {
  if (!row || typeof row !== "object") return null;
  return Object.values(row as Record<string, unknown>)[0] ?? null;
}

function validateSqliteFile(relativePath: string, filePath: string): void {
  let database: DatabaseSync | null = null;
  try {
    database = new DatabaseSync(filePath, { readOnly: true, timeout: 5_000 });
    const quickCheck = database.prepare("PRAGMA quick_check").all();
    if (quickCheck.length !== 1 || pragmaValue(quickCheck[0]) !== "ok") {
      throw new Error(`SQLite quick_check failed: ${relativePath}`);
    }
    const integrityCheck = database.prepare("PRAGMA integrity_check").all();
    if (integrityCheck.length !== 1 || pragmaValue(integrityCheck[0]) !== "ok") {
      throw new Error(`SQLite integrity_check failed: ${relativePath}`);
    }
    const foreignKeyFailures = database.prepare("PRAGMA foreign_key_check").all();
    if (foreignKeyFailures.length > 0) throw new Error(`SQLite foreign_key_check failed: ${relativePath}`);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("SQLite ")) throw error;
    throw new Error(`SQLite validation failed: ${relativePath}: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    database?.close();
  }
}

function validateArtifact(relativePath: string, raw: Buffer): {
  generated_at: string | null;
  reported_status: string | null;
} {
  validateRelativePath(relativePath);
  const kind = artifactKind(relativePath);
  if (kind === "sqlite") {
    validateSqliteBytes(relativePath, raw);
    return { generated_at: null, reported_status: null };
  }
  const text = decodeStrictUtf8(relativePath, raw);
  if (kind === "jsonl") {
    for (const line of text.split(/\r?\n/).filter(Boolean)) JSON.parse(line);
    return { generated_at: null, reported_status: null };
  }
  const value = JSON.parse(text) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`JSON artifact root must be an object: ${relativePath}`);
  }
  const record = value as Record<string, unknown>;
  return {
    generated_at: typeof record.generated_at === "string" ? record.generated_at : null,
    reported_status: typeof record.status === "string" ? record.status : null,
  };
}

async function copyArtifactToStage(params: {
  dataRoot: string;
  stageRoot: string;
  relativePath: string;
}): Promise<StatusGenerationEntry> {
  validateRelativePath(params.relativePath);
  const sourcePath = dataPath(params.dataRoot, params.relativePath);
  const snapshotPath = path.join(params.stageRoot, "files", ...params.relativePath.split("/"));
  const [raw, stat] = await Promise.all([fs.readFile(sourcePath), fs.stat(sourcePath)]);
  const metadata = validateArtifact(params.relativePath, raw);
  await fs.mkdir(path.dirname(snapshotPath), { recursive: true });
  const handle = await fs.open(snapshotPath, "wx");
  try {
    await handle.writeFile(raw);
    await handle.sync();
  } finally {
    await handle.close();
  }
  const copied = await fs.readFile(snapshotPath);
  if (sha256(copied) !== sha256(raw)) throw new Error(`Snapshot copy hash mismatch: ${params.relativePath}`);
  validateArtifact(params.relativePath, copied);
  if (artifactKind(params.relativePath) === "sqlite") validateSqliteFile(params.relativePath, snapshotPath);
  return {
    source_path: params.relativePath,
    snapshot_path: `files/${params.relativePath}`,
    kind: artifactKind(params.relativePath),
    size_bytes: stat.size,
    sha256: sha256(raw),
    source_mtime: stat.mtime.toISOString(),
    generated_at: metadata.generated_at,
    reported_status: metadata.reported_status,
  };
}

async function assertSourceCoherence(dataRoot: string, entries: StatusGenerationEntry[]): Promise<void> {
  for (const entry of entries) {
    validateRelativePath(entry.source_path);
    const raw = await fs.readFile(dataPath(dataRoot, entry.source_path));
    if (sha256(raw) !== entry.sha256) {
      throw new Error(`Source changed during status generation: ${entry.source_path}`);
    }
  }
}

async function renameDirectoryWithRetry(source: string, destination: string): Promise<void> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      await fs.rename(source, destination);
      return;
    } catch (error) {
      lastError = error;
      const code = (error as NodeJS.ErrnoException).code;
      if (!["EACCES", "EBUSY", "EPERM"].includes(code ?? "")) throw error;
      await new Promise((resolve) => setTimeout(resolve, Math.min(250, 20 + attempt * 15)));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(`Could not publish status generation ${destination}`);
}

async function cleanupOldGenerations(root: string, currentGenerationId: string, retain: number): Promise<void> {
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
  const generations = entries
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("status-") && !entry.name.startsWith(".staging-"))
    .map((entry) => entry.name)
    .sort((a, b) => b.localeCompare(a));
  const keep = new Set([currentGenerationId]);
  for (const generationId of generations) {
    if (keep.size >= Math.max(1, retain)) break;
    keep.add(generationId);
  }
  for (const generationId of generations) {
    if (keep.has(generationId)) continue;
    await fs.rm(path.join(root, generationId), { recursive: true, force: true });
  }
  for (const entry of entries.filter((item) => item.isDirectory() && item.name.startsWith(".staging-"))) {
    const fullPath = path.join(root, entry.name);
    const stat = await fs.stat(fullPath).catch(() => null);
    if (stat && Date.now() - stat.mtimeMs > 60 * 60 * 1000) {
      await fs.rm(fullPath, { recursive: true, force: true });
    }
  }
}

export async function publishStatusGeneration(
  dataRoot: string,
  options: PublishStatusGenerationOptions = {},
): Promise<{ pointer: StatusGenerationPointer; manifest: StatusGenerationManifest; pointer_path: string }> {
  const resolvedRoot = path.resolve(dataRoot);
  const generationRoot = dataPath(resolvedRoot, STATUS_GENERATION_ROOT_RELATIVE_PATH);
  const pointerPath = dataPath(resolvedRoot, STATUS_GENERATION_POINTER_RELATIVE_PATH);
  const lockPath = `${generationRoot}.publish.lock`;
  return await withFileLock(lockPath, async () => {
    const now = options.now ?? new Date();
    const generationId = options.generationId ?? createStatusGenerationId(now);
    validateGenerationId(generationId);
    const stageRoot = path.join(generationRoot, `.staging-${generationId}-${randomUUID()}`);
    const finalRoot = path.join(generationRoot, generationId);
    await fs.mkdir(generationRoot, { recursive: true });
    await fs.mkdir(stageRoot, { recursive: false });
    let promoted = false;
    let published = false;
    try {
      const artifactPaths = [...new Set(options.artifactPaths ?? STATUS_GENERATION_ARTIFACT_PATHS)];
      const entries: StatusGenerationEntry[] = [];
      for (const relativePath of artifactPaths) {
        entries.push(await copyArtifactToStage({ dataRoot: resolvedRoot, stageRoot, relativePath }));
      }
      entries.sort((a, b) => a.source_path.localeCompare(b.source_path));
      const manifest: StatusGenerationManifest = {
        version: STATUS_GENERATION_VERSION,
        generation_id: generationId,
        generated_at: now.toISOString(),
        producer_command: options.producerCommand ?? "npm run status:refresh",
        source_watermark: {
          latest_mtime:
            entries.length > 0
              ? entries.map((entry) => entry.source_mtime).sort((a, b) => b.localeCompare(a))[0] ?? null
              : null,
          aggregate_sha256: sha256(entries.map((entry) => `${entry.source_path}:${entry.sha256}`).join("\n")),
        },
        entry_count: entries.length,
        entries,
      };
      const stageManifestPath = path.join(stageRoot, "manifest.json");
      await atomicWriteJson(stageManifestPath, manifest);
      const manifestRaw = await fs.readFile(stageManifestPath);
      await assertSourceCoherence(resolvedRoot, entries);
      await renameDirectoryWithRetry(stageRoot, finalRoot);
      promoted = true;
      await assertSourceCoherence(resolvedRoot, entries);
      await options.beforePointerPublish?.({ generation_id: generationId, generation_root: finalRoot, manifest });
      await assertSourceCoherence(resolvedRoot, entries);
      const manifestRelativePath = `${STATUS_GENERATION_ROOT_RELATIVE_PATH}/${generationId}/manifest.json`;
      const pointer: StatusGenerationPointer = {
        version: STATUS_GENERATION_VERSION,
        status: "published",
        generation_id: generationId,
        generated_at: now.toISOString(),
        manifest_path: manifestRelativePath,
        manifest_sha256: sha256(manifestRaw),
        entry_count: entries.length,
      };
      await atomicWriteJson(pointerPath, pointer);
      published = true;
      await cleanupOldGenerations(generationRoot, generationId, options.retainGenerations ?? 3);
      return { pointer, manifest, pointer_path: pointerPath };
    } finally {
      if (!promoted) await fs.rm(stageRoot, { recursive: true, force: true }).catch(() => undefined);
      if (promoted && !published) await fs.rm(finalRoot, { recursive: true, force: true }).catch(() => undefined);
    }
  });
}

function pathWithin(parent: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export async function loadCurrentStatusGeneration(
  dataRoot: string,
  options: { verifyEntries?: boolean; verifySourceCoherence?: boolean } = {},
): Promise<LoadedStatusGeneration> {
  const resolvedRoot = path.resolve(dataRoot);
  const pointerPath = dataPath(resolvedRoot, STATUS_GENERATION_POINTER_RELATIVE_PATH);
  let pointer: StatusGenerationPointer;
  try {
    const raw = await fs.readFile(pointerPath);
    pointer = JSON.parse(decodeStrictUtf8(STATUS_GENERATION_POINTER_RELATIVE_PATH, raw)) as StatusGenerationPointer;
  } catch (error) {
    return {
      status: (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "invalid",
      reason: (error as NodeJS.ErrnoException).code === "ENOENT" ? "generation_pointer_missing" : "generation_pointer_invalid",
      pointer: null,
      manifest: null,
      generation_root: null,
      errors: [],
    };
  }
  const errors: string[] = [];
  if (
    !pointer ||
    typeof pointer !== "object" ||
    pointer.version !== STATUS_GENERATION_VERSION ||
    pointer.status !== "published" ||
    typeof pointer.generation_id !== "string" ||
    typeof pointer.manifest_path !== "string" ||
    typeof pointer.manifest_sha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(pointer.manifest_sha256) ||
    typeof pointer.entry_count !== "number"
  ) {
    errors.push("pointer_schema_invalid");
  }
  try {
    validateGenerationId(typeof pointer.generation_id === "string" ? pointer.generation_id : "");
  } catch {
    errors.push("pointer_generation_id_invalid");
  }
  const generationId = typeof pointer.generation_id === "string" ? pointer.generation_id : "invalid";
  const generationRoot = dataPath(resolvedRoot, `${STATUS_GENERATION_ROOT_RELATIVE_PATH}/${generationId}`);
  const expectedManifestPath = `${STATUS_GENERATION_ROOT_RELATIVE_PATH}/${generationId}/manifest.json`;
  const pointerManifestPath = typeof pointer.manifest_path === "string" ? pointer.manifest_path : "";
  const manifestPath = dataPath(resolvedRoot, expectedManifestPath);
  if (
    pointerManifestPath !== expectedManifestPath ||
    !pathWithin(generationRoot, manifestPath) ||
    path.basename(manifestPath) !== "manifest.json"
  ) {
    errors.push("pointer_manifest_path_invalid");
  }
  let manifest: StatusGenerationManifest | null = null;
  try {
    const raw = await fs.readFile(manifestPath);
    if (sha256(raw) !== pointer.manifest_sha256) errors.push("manifest_hash_mismatch");
    manifest = JSON.parse(decodeStrictUtf8(expectedManifestPath, raw)) as StatusGenerationManifest;
    if (
      !manifest ||
      typeof manifest !== "object" ||
      manifest.version !== STATUS_GENERATION_VERSION ||
      !Array.isArray(manifest.entries) ||
      typeof manifest.producer_command !== "string" ||
      !manifest.source_watermark ||
      typeof manifest.source_watermark.aggregate_sha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(manifest.source_watermark.aggregate_sha256)
    ) {
      errors.push("manifest_schema_invalid");
    }
    if (manifest.generation_id !== pointer.generation_id) errors.push("manifest_generation_id_mismatch");
    if (manifest.entry_count !== manifest.entries?.length || manifest.entry_count !== pointer.entry_count) {
      errors.push("manifest_entry_count_mismatch");
    }
    if (
      Array.isArray(manifest.entries) &&
      manifest.source_watermark?.aggregate_sha256 !==
        sha256(manifest.entries.map((entry) => `${entry.source_path}:${entry.sha256}`).join("\n"))
    ) {
      errors.push("manifest_source_watermark_mismatch");
    }
  } catch {
    errors.push("manifest_missing_or_invalid");
  }
  if (manifest && Array.isArray(manifest.entries) && (options.verifyEntries ?? true)) {
    for (const entry of manifest.entries) {
      if (
        !entry ||
        typeof entry.source_path !== "string" ||
        typeof entry.snapshot_path !== "string" ||
        typeof entry.size_bytes !== "number" ||
        typeof entry.sha256 !== "string" ||
        !/^[a-f0-9]{64}$/.test(entry.sha256) ||
        entry.snapshot_path !== `files/${entry.source_path}`
      ) {
        errors.push("manifest_entry_schema_invalid");
        continue;
      }
      try {
        validateRelativePath(entry.source_path);
        validateRelativePath(entry.snapshot_path);
      } catch {
        errors.push(`manifest_entry_path_invalid:${entry.source_path}`);
        continue;
      }
      if (entry.kind !== artifactKind(entry.source_path)) {
        errors.push(`manifest_entry_kind_mismatch:${entry.source_path}`);
        continue;
      }
      const snapshotPath = path.join(generationRoot, ...entry.snapshot_path.split("/"));
      if (!pathWithin(generationRoot, snapshotPath)) {
        errors.push(`snapshot_path_invalid:${entry.source_path}`);
        continue;
      }
      try {
        const raw = await fs.readFile(snapshotPath);
        if (raw.length !== entry.size_bytes) errors.push(`snapshot_size_mismatch:${entry.source_path}`);
        if (sha256(raw) !== entry.sha256) errors.push(`snapshot_hash_mismatch:${entry.source_path}`);
        validateArtifact(entry.source_path, raw);
        if (entry.kind === "sqlite") validateSqliteFile(entry.source_path, snapshotPath);
      } catch {
        errors.push(`snapshot_missing_or_invalid:${entry.source_path}`);
      }
      if (options.verifySourceCoherence) {
        try {
          const sourceRaw = await fs.readFile(dataPath(resolvedRoot, entry.source_path));
          if (sha256(sourceRaw) !== entry.sha256) errors.push(`source_generation_mismatch:${entry.source_path}`);
        } catch {
          errors.push(`source_missing:${entry.source_path}`);
        }
      }
    }
  }
  return {
    status: errors.length === 0 ? "healthy" : "invalid",
    reason: errors[0] ?? null,
    pointer,
    manifest,
    generation_root: generationRoot,
    errors,
  };
}

export function resolveStatusGenerationArtifactPath(
  generation: LoadedStatusGeneration,
  sourceRelativePath: string,
): string | null {
  if (generation.status !== "healthy" || !generation.manifest || !generation.generation_root) return null;
  try {
    validateRelativePath(sourceRelativePath);
  } catch {
    return null;
  }
  const entry = generation.manifest.entries.find((candidate) => candidate.source_path === sourceRelativePath);
  if (!entry) return null;
  const resolved = path.join(generation.generation_root, ...entry.snapshot_path.split("/"));
  return pathWithin(generation.generation_root, resolved) ? resolved : null;
}
