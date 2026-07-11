import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import { atomicWriteJson } from "./concurrency.js";
import { dataPath, relDataPath } from "./context.js";
import { FULL_MEMORY_STATE_DIR } from "./full-memory-audit.js";
import { getNodeLifecycleState } from "./node-lifecycle.js";
import { SOURCE_LINEAGE_MAX_VERIFICATION_AGE_DAYS } from "./source-lineage-publication.js";

export const SOURCE_LINEAGE_VERSION = "source_lineage_v2";
export const SOURCE_LINEAGE_STATUS_RELATIVE_PATH = `${FULL_MEMORY_STATE_DIR}/source_lineage_status.json`;

export type SourceLineageStatus = "healthy" | "needs_attention";
export type SourceLineageFindingSignal =
  | "source_chunk_verification_missing"
  | "source_verification_method_missing"
  | "source_chunk_body_missing"
  | "source_chunk_uri_missing"
  | "source_snapshot_missing"
  | "source_chunk_verification_stale"
  | "source_content_hash_mismatch"
  | "chunk_hash_mismatch"
  | "provenance_missing"
  | "provenance_source_missing"
  | "lineage_generation_missing"
  | "lineage_generation_mismatch"
  | "claim_binding_missing"
  | "claim_content_hash_mismatch"
  | "dangling_claim_path"
  | "anchor_only_used_as_support"
  | "internal_trace_only_used_as_support"
  | "unsupported_factual_claim";

export type SourceLineageFinding = {
  signal: SourceLineageFindingSignal;
  severity: "fail" | "warn";
  path: string;
  related_path: string | null;
  reason: string;
};

export type SourceLineageChunkSummary = {
  path: string;
  source_chunk_id: string;
  source_uri: string | null;
  verification_status: string | null;
  support_role: "verified_source_chunk" | "source_anchor_unverified" | "unverified_source_chunk";
  claim_paths: string[];
  source_snapshot_path: string | null;
  lineage_generation_path: string | null;
  source_content_sha256: string | null;
  chunk_sha256: string | null;
  last_verified: string | null;
  stale: boolean;
};

export type SourceLineageClaimSummary = {
  path: string;
  title: string;
  item_class:
    | "behavior_memory"
    | "project_memory"
    | "internal_session_evidence"
    | "source_anchor_unverified"
    | "internal_claim"
    | "verified_claim_support"
    | "unsupported_factual_claim";
  source_status: string | null;
  support_paths: string[];
  anchor_only_paths: string[];
  factual_signals: string[];
};

export type SourceLineageReport = {
  version: typeof SOURCE_LINEAGE_VERSION;
  status: SourceLineageStatus;
  generated_at: string;
  latest_verified_at: string | null;
  data_root: string;
  counts: {
    source_chunks: number;
    source_snapshots: number;
    provenance_links: number;
    lineage_generations: number;
    verified_source_chunks: number;
    anchor_only_unverified: number;
    unverified_source_chunks: number;
    claim_records: number;
    behavior_memory_records: number;
    project_memory_records: number;
    internal_session_evidence_records: number;
    source_anchor_unverified_records: number;
    verified_claim_support: number;
    unsupported_factual_claims: number;
    factual_claim_records: number;
    scanned_claim_files: number;
    dangling_claim_paths: number;
    stale_support: number;
    hash_mismatches: number;
    blockers: number;
  };
  source_chunks: SourceLineageChunkSummary[];
  claim_records: SourceLineageClaimSummary[];
  findings: SourceLineageFinding[];
  warnings: string[];
  visible_status: string;
};

type BuildOptions = {
  now?: Date;
};

type JsonObject = Record<string, unknown>;
type ClaimRecord = { path: string; record: JsonObject; title: string; body: string; factual_signals: string[] };

const CLAIM_ROOTS = ["20_Wiki", "40_Projects", "50_Instances/accepted"] as const;
const ANCHOR_SOURCE_STATUSES = new Set(["anchor_only_unverified", "anchor-only-unverified", "user_supplied_anchor_summary"]);
const FACTUAL_TAGS = new Set([
  "rag",
  "source-lineage",
  "verified-knowledge",
  "retrieval-quality",
  "provenance",
  "hybrid-search",
  "reranking",
  "evaluation",
  "graph-rag",
  "cross-os-learning",
  "external",
  "public",
  "source-backed",
]);
const VERIFIED_STATUSES = new Set([
  "verified",
  "verified_summary",
  "verified_chunk",
  "verified_source_chunk",
  "source_verified",
  "reviewed",
  "reviewed_source_chunk",
]);

function nowIso(date: Date): string {
  return date.toISOString();
}

function sha256(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function normalizeVaultPath(value: unknown, dataRoot?: string): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (dataRoot && path.isAbsolute(trimmed)) {
    const relative = path.relative(dataRoot, trimmed);
    if (relative && !relative.startsWith("..") && !path.isAbsolute(relative)) return relative.split(path.sep).join("/");
  }
  return trimmed.replace(/\\/g, "/").replace(/^\/+/, "");
}

function unique(values: Array<string | null | undefined>): string[] {
  return Array.from(new Set(values.filter((value): value is string => Boolean(value))));
}

function stringArray(value: unknown, dataRoot?: string): string[] {
  if (Array.isArray(value)) return unique(value.map((item) => normalizeVaultPath(item, dataRoot)));
  const normalized = normalizeVaultPath(value, dataRoot);
  return normalized ? [normalized] : [];
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function lowerString(...values: unknown[]): string | null {
  const value = firstString(...values);
  return value ? value.toLowerCase().trim() : null;
}

async function readJson(filePath: string): Promise<JsonObject | null> {
  try {
    const parsed = JSON.parse(await fs.readFile(filePath, "utf8")) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as JsonObject) : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function pathExists(dataRoot: string, relativePath: string): Promise<boolean> {
  try {
    await fs.stat(dataPath(dataRoot, relativePath));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function pathSha256(dataRoot: string, relativePath: string): Promise<string | null> {
  try {
    return sha256(await fs.readFile(dataPath(dataRoot, ...relativePath.split("/"))));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function walkFiles(dir: string, extensions: Set<string>, files: string[] = []): Promise<string[]> {
  let entries: Array<import("node:fs").Dirent>;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return files;
    throw error;
  }
  for (const entry of entries) {
    if (entry.name === ".git" || entry.name === "node_modules") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await walkFiles(full, extensions, files);
    else if (entry.isFile() && extensions.has(path.extname(entry.name).toLowerCase())) files.push(full);
  }
  return files;
}

function parseFrontmatter(text: string): { metadata: JsonObject; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(text);
  if (!match) return { metadata: {}, body: text };
  const metadata: JsonObject = {};
  for (const line of match[1].split(/\r?\n/)) {
    const match = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (!match) continue;
    const [, key, rawValue] = match;
    const trimmed = rawValue.trim();
    if (/^\[.*\]$/.test(trimmed)) {
      metadata[key] = trimmed
        .slice(1, -1)
        .split(",")
        .map((item) => item.trim().replace(/^["']|["']$/g, ""))
        .filter(Boolean);
    } else {
      metadata[key] = trimmed.replace(/^["']|["']$/g, "");
    }
  }
  return { metadata, body: text.slice(match[0].length) };
}

function firstHeading(body: string): string | null {
  return body.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? null;
}

function sourceVerification(record: JsonObject): string | null {
  return lowerString(record.verification_status, record.source_status);
}

function isAnchorOnly(status: string | null): boolean {
  return status === "anchor_only_unverified" || status === "anchor-only-unverified";
}

function isVerifiedStatus(status: string | null): boolean {
  return Boolean(status && (VERIFIED_STATUSES.has(status) || status.startsWith("verified_") || status.endsWith("_verified")));
}

function claimPathsFrom(record: JsonObject, dataRoot: string): string[] {
  return unique([
    ...stringArray(record.claim_paths, dataRoot),
    ...stringArray(record.claim_path, dataRoot),
    ...stringArray(record.source_paths, dataRoot),
    ...stringArray(record.source_path, dataRoot),
  ]);
}

function supportPathsFrom(record: JsonObject, dataRoot: string): string[] {
  return unique([
    ...stringArray(record.source_paths, dataRoot),
    ...stringArray(record.source_path, dataRoot),
    ...stringArray(record.provenance_paths, dataRoot),
    ...stringArray(record.provenance_path, dataRoot),
  ]);
}

function claimBindingsFrom(record: JsonObject, dataRoot: string): Map<string, string> {
  const bindings = new Map<string, string>();
  if (!Array.isArray(record.claim_bindings)) return bindings;
  for (const item of record.claim_bindings) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const binding = item as { path?: unknown; sha256?: unknown };
    const claimPath = normalizeVaultPath(binding.path, dataRoot);
    if (!claimPath || typeof binding.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(binding.sha256)) continue;
    bindings.set(claimPath, binding.sha256);
  }
  return bindings;
}

function artifactBindingsFrom(record: JsonObject, dataRoot: string): Map<string, string> {
  const bindings = new Map<string, string>();
  if (!Array.isArray(record.artifact_bindings)) return bindings;
  for (const item of record.artifact_bindings) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const binding = item as { path?: unknown; after_sha256?: unknown };
    const artifactPath = normalizeVaultPath(binding.path, dataRoot);
    if (!artifactPath || typeof binding.after_sha256 !== "string" || !/^[a-f0-9]{64}$/.test(binding.after_sha256)) continue;
    bindings.set(artifactPath, binding.after_sha256);
  }
  return bindings;
}

function tagsFrom(record: JsonObject): string[] {
  return Array.isArray(record.tags) ? record.tags.map(String).map((tag) => tag.toLowerCase()) : [];
}

function factualSignalsFrom(relativePath: string, record: JsonObject, body: string): string[] {
  const tags = tagsFrom(record);
  const sourceStatus = lowerString(record.source_status, record.verification_status);
  const signals = new Set<string>();
  if (
    (relativePath.startsWith("20_Wiki/") || relativePath.startsWith("40_Projects/") || relativePath.startsWith("50_Instances/accepted/")) &&
    sourceStatus !== "internal" &&
    sourceStatus !== "internal_session_evidence"
  ) {
    signals.add("root_requires_source_truth");
  }
  if (sourceStatus && sourceStatus !== "internal" && sourceStatus !== "internal_session_evidence") {
    signals.add("declared_source_status");
  }
  if (tags.some((tag) => FACTUAL_TAGS.has(tag))) signals.add("factual_tag");
  if (tags.includes("public") || tags.includes("external")) signals.add("public_or_external_tag");
  if (["factual", "external_fact", "public_fact", "high_risk_fact"].includes(lowerString(record.claim_type, record.knowledge_type) ?? "")) {
    signals.add("explicit_factual_claim_type");
  }
  const text = [body, firstString(record.claim, record.summary, record.description) ?? ""].join("\n");
  if (/https?:\/\//i.test(text)) signals.add("external_url_in_content");
  if (/\b(according to|research|paper|benchmark|official documentation|published|study)\b/i.test(text)) {
    signals.add("external_factual_language");
  }
  if (/(논문|연구|공식\s*문서|문서에\s*따르면|발표|벤치마크|외부\s*근거|출처)/u.test(text)) {
    signals.add("external_factual_language");
  }
  if (relativePath.startsWith("40_Projects/") && sourceStatus === "internal") {
    signals.delete("external_url_in_content");
    signals.delete("external_factual_language");
  }
  return Array.from(signals).sort((left, right) => left.localeCompare(right));
}

function isBehaviorMemory(relativePath: string, record: JsonObject): boolean {
  const tags = tagsFrom(record);
  const sourceStatus = lowerString(record.source_status);
  return (
    (sourceStatus === "internal" && !relativePath.startsWith("40_Projects/")) ||
    relativePath.startsWith("50_Instances/accepted/codex-session-knowledge-") ||
    tags.includes("codex-session-derived") ||
    tags.includes("user-preference") ||
    tags.includes("user-preferences") ||
    tags.includes("reviewed-memory") ||
    tags.includes("operating-rule") ||
    tags.includes("mistake-lesson")
  );
}

function isInternalSessionEvidence(relativePath: string, record: JsonObject): boolean {
  const tags = tagsFrom(record);
  const sourceStatus = lowerString(record.source_status);
  return (
    sourceStatus === "internal_session_evidence" ||
    tags.includes("internal-session-evidence") ||
    tags.includes("conversation-registry") ||
    tags.includes("task-trace") ||
    tags.includes("conversation-derived") ||
    relativePath.startsWith("50_Instances/accepted/task-memory-")
  );
}

function requiresSourceTruth(relativePath: string, record: JsonObject, factualSignals: string[] = []): boolean {
  if (isBehaviorMemory(relativePath, record)) return false;
  if (isInternalSessionEvidence(relativePath, record)) return false;
  const sourceStatus = lowerString(record.source_status);
  const tags = tagsFrom(record);
  if (relativePath.startsWith("40_Projects/")) {
    return sourceStatus !== "internal" || tags.includes("public") || tags.includes("external");
  }
  if (relativePath.startsWith("50_Instances/accepted/")) {
    return (
      Boolean(sourceStatus && sourceStatus !== "internal") ||
      tags.some((tag) => FACTUAL_TAGS.has(tag)) ||
      factualSignals.includes("explicit_factual_claim_type") ||
      factualSignals.includes("external_factual_language") ||
      !sourceStatus
    );
  }
  return relativePath.startsWith("20_Wiki/") && sourceStatus !== "internal";
}

function isSourceAnchorUnverified(relativePath: string, record: JsonObject): boolean {
  const sourceStatus = lowerString(record.source_status);
  const tags = tagsFrom(record);
  return (
    Boolean(sourceStatus && ANCHOR_SOURCE_STATUSES.has(sourceStatus)) ||
    tags.includes("anchor-catalog") ||
    tags.includes("source-anchor-unverified") ||
    relativePath.includes("Anchor-Catalog")
  );
}

function isProjectMemory(relativePath: string, record: JsonObject, factualSignals: string[] = []): boolean {
  if (!relativePath.startsWith("40_Projects/")) return false;
  const sourceStatus = lowerString(record.source_status);
  return sourceStatus === "internal" && !requiresSourceTruth(relativePath, record, factualSignals);
}

async function collectSourceChunks(dataRoot: string): Promise<Array<{ path: string; record: JsonObject }>> {
  const root = dataPath(dataRoot, "30_Sources", "chunks");
  const files = await walkFiles(root, new Set([".json"]));
  const chunks = [];
  for (const file of files) {
    const record = await readJson(file);
    if (!record) continue;
    chunks.push({ path: relDataPath(dataRoot, file), record });
  }
  return chunks;
}

async function collectSourceSnapshots(dataRoot: string): Promise<Array<{ path: string; record: JsonObject }>> {
  const root = dataPath(dataRoot, "30_Sources", "fetched");
  const files = await walkFiles(root, new Set([".json"]));
  const snapshots = [];
  for (const file of files) {
    const record = await readJson(file);
    if (!record) continue;
    snapshots.push({ path: relDataPath(dataRoot, file), record });
  }
  return snapshots;
}

async function collectProvenance(dataRoot: string): Promise<Array<{ path: string; record: JsonObject }>> {
  const root = dataPath(dataRoot, ".dino", "provenance");
  const files = await walkFiles(root, new Set([".json"]));
  const links = [];
  for (const file of files) {
    const record = await readJson(file);
    if (!record) continue;
    if (record.type === "lineage_generation" || relDataPath(dataRoot, file).startsWith(".dino/provenance/generations/")) continue;
    links.push({ path: relDataPath(dataRoot, file), record });
  }
  return links;
}

async function collectLineageGenerations(dataRoot: string): Promise<Array<{ path: string; record: JsonObject }>> {
  const root = dataPath(dataRoot, ".dino", "provenance", "generations");
  const files = await walkFiles(root, new Set([".json"]));
  const generations = [];
  for (const file of files) {
    const record = await readJson(file);
    if (!record) continue;
    generations.push({ path: relDataPath(dataRoot, file), record });
  }
  return generations;
}

async function collectClaimRecords(dataRoot: string): Promise<ClaimRecord[]> {
  const claims: ClaimRecord[] = [];
  for (const root of CLAIM_ROOTS) {
    const files = await walkFiles(dataPath(dataRoot, root), new Set([".json", ".md"]));
    for (const file of files) {
      const relativePath = relDataPath(dataRoot, file);
      if (relativePath.endsWith("/README.md") || relativePath === "20_Wiki/README.md") continue;
      const ext = path.extname(file).toLowerCase();
      if (ext === ".json") {
        const record = await readJson(file);
        if (!record) continue;
        if (
          relativePath.startsWith("50_Instances/accepted/") &&
          getNodeLifecycleState(record, relativePath) !== "accepted"
        ) {
          continue;
        }
        claims.push({
          path: relativePath,
          record,
          title: firstString(record.title, record.claim, path.basename(file, ext)) ?? path.basename(file, ext),
          body: firstString(record.claim, record.summary, record.description) ?? "",
          factual_signals: factualSignalsFrom(
            relativePath,
            record,
            firstString(record.claim, record.summary, record.description) ?? "",
          ),
        });
      } else {
        const text = await fs.readFile(file, "utf8");
        const { metadata, body } = parseFrontmatter(text);
        claims.push({
          path: relativePath,
          record: metadata,
          title: firstString(metadata.title, firstHeading(body), path.basename(file, ext)) ?? path.basename(file, ext),
          body,
          factual_signals: factualSignalsFrom(relativePath, metadata, body),
        });
      }
    }
  }
  return claims;
}

export async function buildSourceLineageReport(
  dataRoot: string,
  options: BuildOptions = {},
): Promise<SourceLineageReport> {
  const generatedAt = nowIso(options.now ?? new Date());
  const [chunks, snapshots, provenance, generations, claimRecords] = await Promise.all([
    collectSourceChunks(dataRoot),
    collectSourceSnapshots(dataRoot),
    collectProvenance(dataRoot),
    collectLineageGenerations(dataRoot),
    collectClaimRecords(dataRoot),
  ]);
  const findings: SourceLineageFinding[] = [];
  const snapshotByPath = new Map(snapshots.map((snapshot) => [snapshot.path, snapshot]));
  const generationByPath = new Map(generations.map((generation) => [generation.path, generation]));
  const provenanceBySourcePath = new Map<string, Array<{ path: string; record: JsonObject }>>();
  for (const link of provenance) {
    const sourcePath = normalizeVaultPath(link.record.source_chunk_path, dataRoot);
    if (sourcePath) provenanceBySourcePath.set(sourcePath, [...(provenanceBySourcePath.get(sourcePath) ?? []), link]);
    if (!sourcePath || !(await pathExists(dataRoot, sourcePath))) {
      findings.push({
        signal: "provenance_source_missing",
        severity: "fail",
        path: link.path,
        related_path: sourcePath,
        reason: "Provenance record points to a missing source chunk.",
      });
    }
  }

  const verifiedSupport = new Map<string, string[]>();
  const anchorOnlySupport = new Map<string, string[]>();
  const verifiedDurableArtifacts = new Set<string>();
  const anchorOnlyDurableArtifacts = new Set<string>();
  const chunkSummaries: SourceLineageChunkSummary[] = [];

  for (const chunk of chunks) {
    const findingStart = findings.length;
    const status = sourceVerification(chunk.record);
    const chunkId = firstString(chunk.record.source_chunk_id, path.basename(chunk.path, ".json")) ?? path.basename(chunk.path, ".json");
    const sourceUri = firstString(chunk.record.source_uri);
    const chunkText = firstString(chunk.record.chunk_text);
    const sourceSnapshotPath = normalizeVaultPath(chunk.record.source_snapshot_path, dataRoot);
    const generationPath = normalizeVaultPath(chunk.record.lineage_generation_path, dataRoot);
    const sourceContentSha256 = firstString(chunk.record.source_content_sha256);
    const chunkSha256 = firstString(chunk.record.chunk_sha256);
    const lastVerified = firstString(chunk.record.last_verified);
    const snapshot = sourceSnapshotPath ? snapshotByPath.get(sourceSnapshotPath) : null;
    const generation = generationPath ? generationByPath.get(generationPath) : null;
    const relatedProvenance = provenanceBySourcePath.get(chunk.path) ?? [];
    const claimPaths = unique([
      ...claimPathsFrom(chunk.record, dataRoot),
      ...relatedProvenance.flatMap((link) => claimPathsFrom(link.record, dataRoot)),
    ]);
    const supportRole = isAnchorOnly(status)
      ? "source_anchor_unverified"
      : isVerifiedStatus(status)
        ? "verified_source_chunk"
        : "unverified_source_chunk";
    const maxAgeDays = Number(chunk.record.verification_max_age_days ?? SOURCE_LINEAGE_MAX_VERIFICATION_AGE_DAYS);
    const verifiedAtMs = lastVerified ? Date.parse(`${lastVerified}T00:00:00.000Z`) : Number.NaN;
    const stale =
      supportRole === "verified_source_chunk" &&
      Number.isFinite(verifiedAtMs) &&
      Number.isFinite(maxAgeDays) &&
      Date.parse(generatedAt) - verifiedAtMs > Math.max(1, maxAgeDays) * 86_400_000;

    if (!status) {
      findings.push({
        signal: "source_chunk_verification_missing",
        severity: "fail",
        path: chunk.path,
        related_path: null,
        reason: "Source chunk lacks verification_status/source_status.",
      });
    }
    if (supportRole === "verified_source_chunk" && !firstString(chunk.record.verification_method, snapshot?.record.verification_method)) {
      findings.push({
        signal: "source_verification_method_missing",
        severity: "fail",
        path: chunk.path,
        related_path: sourceSnapshotPath,
        reason: "Verified source support lacks an explicit verification method.",
      });
    }
    if (!chunkText) {
      findings.push({
        signal: "source_chunk_body_missing",
        severity: "fail",
        path: chunk.path,
        related_path: null,
        reason: "Source chunk lacks bounded chunk_text.",
      });
    }
    if (!sourceUri && !["internal_doc", "conversation_excerpt"].includes(String(chunk.record.chunk_type ?? ""))) {
      findings.push({
        signal: "source_chunk_uri_missing",
        severity: "fail",
        path: chunk.path,
        related_path: null,
        reason: "External source chunk lacks source_uri.",
      });
    }
    if (!sourceSnapshotPath || !snapshot) {
      findings.push({
        signal: "source_snapshot_missing",
        severity: "fail",
        path: chunk.path,
        related_path: sourceSnapshotPath,
        reason: "Source chunk is not bound to a fetched source snapshot.",
      });
    }
    if (stale || (supportRole === "verified_source_chunk" && !Number.isFinite(verifiedAtMs))) {
      findings.push({
        signal: "source_chunk_verification_stale",
        severity: "fail",
        path: chunk.path,
        related_path: sourceSnapshotPath,
        reason: "Verified source support is missing a valid verification date or exceeds its verification age budget.",
      });
    }
    if (!chunkSha256 || (chunkText && sha256(chunkText) !== chunkSha256)) {
      findings.push({
        signal: "chunk_hash_mismatch",
        severity: "fail",
        path: chunk.path,
        related_path: null,
        reason: "Stored chunk text does not match its declared SHA-256.",
      });
    }
    if (
      !sourceContentSha256 ||
      (snapshot && firstString(snapshot.record.source_content_sha256) !== sourceContentSha256) ||
      relatedProvenance.some((link) => firstString(link.record.source_content_sha256) !== sourceContentSha256)
    ) {
      findings.push({
        signal: "source_content_hash_mismatch",
        severity: "fail",
        path: chunk.path,
        related_path: sourceSnapshotPath,
        reason: "Source snapshot, chunk, and provenance do not share one source-content SHA-256.",
      });
    }
    if (relatedProvenance.length === 0) {
      findings.push({
        signal: "provenance_missing",
        severity: "fail",
        path: chunk.path,
        related_path: null,
        reason: "Source chunk has no provenance link.",
      });
    } else if (relatedProvenance.length > 1) {
      findings.push({
        signal: "lineage_generation_mismatch",
        severity: "fail",
        path: chunk.path,
        related_path: relatedProvenance[1].path,
        reason: "Source chunk has multiple competing provenance records.",
      });
    }
    if (!generationPath || !generation) {
      findings.push({
        signal: "lineage_generation_missing",
        severity: "fail",
        path: chunk.path,
        related_path: generationPath,
        reason: "Source chunk is not bound to a published lineage generation receipt.",
      });
    } else {
      const expectedGenerationId = firstString(chunk.record.lineage_generation_id);
      const artifactBindings = artifactBindingsFrom(generation.record, dataRoot);
      if (
        firstString(generation.record.generation_id) !== expectedGenerationId ||
        firstString(generation.record.source_chunk_path) !== chunk.path ||
        firstString(generation.record.source_snapshot_path) !== sourceSnapshotPath ||
        firstString(generation.record.provenance_path) !== relatedProvenance[0]?.path
      ) {
        findings.push({
          signal: "lineage_generation_mismatch",
          severity: "fail",
          path: chunk.path,
          related_path: generationPath,
          reason: "Lineage generation receipt does not bind the same source snapshot, chunk, and provenance records.",
        });
      }
      for (const artifactPath of [sourceSnapshotPath, chunk.path, relatedProvenance[0]?.path].filter(
        (value): value is string => Boolean(value),
      )) {
        const expectedHash = artifactBindings.get(artifactPath);
        const currentHash = await pathSha256(dataRoot, artifactPath);
        if (!expectedHash || expectedHash !== currentHash) {
          findings.push({
            signal: "lineage_generation_mismatch",
            severity: "fail",
            path: chunk.path,
            related_path: generationPath,
            reason: "Lineage generation artifact hash binding does not match the published artifact.",
          });
          break;
        }
      }
    }
    const bindingMaps = [
      claimBindingsFrom(chunk.record, dataRoot),
      ...relatedProvenance.map((link) => claimBindingsFrom(link.record, dataRoot)),
      ...(generation ? [claimBindingsFrom(generation.record, dataRoot)] : []),
    ];
    for (const claimPath of claimPaths) {
      if (!(await pathExists(dataRoot, claimPath))) {
        findings.push({
          signal: "dangling_claim_path",
          severity: "fail",
          path: chunk.path,
          related_path: claimPath,
          reason: "Source/provenance claim_path does not exist.",
        });
      } else {
        const declaredHashes = unique(bindingMaps.map((bindings) => bindings.get(claimPath)));
        if (declaredHashes.length === 0) {
          findings.push({
            signal: "claim_binding_missing",
            severity: "fail",
            path: chunk.path,
            related_path: claimPath,
            reason: "Claim support lacks an exact claim-content SHA-256 binding.",
          });
        } else {
          const currentClaimHash = sha256(await fs.readFile(dataPath(dataRoot, ...claimPath.split("/"))));
          if (declaredHashes.length !== 1 || declaredHashes[0] !== currentClaimHash) {
            findings.push({
              signal: "claim_content_hash_mismatch",
              severity: "fail",
              path: chunk.path,
              related_path: claimPath,
              reason: "Claim content changed after the supporting lineage generation was published.",
            });
          }
        }
      }
    }
    const chunkHasBlocker = findings.slice(findingStart).some((finding) => finding.severity === "fail");
    const supportTarget = supportRole === "verified_source_chunk" && !chunkHasBlocker
      ? verifiedSupport
      : supportRole === "source_anchor_unverified"
        ? anchorOnlySupport
        : null;
    if (supportTarget) {
      for (const claimPath of claimPaths) {
        supportTarget.set(claimPath, [...(supportTarget.get(claimPath) ?? []), chunk.path]);
      }
    }
    chunkSummaries.push({
      path: chunk.path,
      source_chunk_id: chunkId,
      source_uri: sourceUri,
      verification_status: status,
      support_role: supportRole,
      claim_paths: claimPaths,
      source_snapshot_path: sourceSnapshotPath,
      lineage_generation_path: generationPath,
      source_content_sha256: sourceContentSha256,
      chunk_sha256: chunkSha256,
      last_verified: lastVerified,
      stale,
    });
  }

  for (const claim of claimRecords) {
    if (isBehaviorMemory(claim.path, claim.record) || isInternalSessionEvidence(claim.path, claim.record)) continue;
    if ((verifiedSupport.get(claim.path) ?? []).length > 0) {
      verifiedDurableArtifacts.add(claim.path);
    } else if (isSourceAnchorUnverified(claim.path, claim.record)) {
      anchorOnlyDurableArtifacts.add(claim.path);
    }
  }

  const claimSummaries: SourceLineageClaimSummary[] = [];
  for (const claim of claimRecords) {
    const sourceStatus = lowerString(claim.record.source_status);
    const directSupportPaths = supportPathsFrom(claim.record, dataRoot);
    const verifiedDurableSupport = directSupportPaths.filter((supportPath) => verifiedDurableArtifacts.has(supportPath));
    const anchorDurableSupport = directSupportPaths.filter((supportPath) => anchorOnlyDurableArtifacts.has(supportPath));
    const supportPaths = unique([...(verifiedSupport.get(claim.path) ?? []), ...verifiedDurableSupport]);
    const anchorPaths = unique([...(anchorOnlySupport.get(claim.path) ?? []), ...anchorDurableSupport]);
    let itemClass: SourceLineageClaimSummary["item_class"];
    if (isBehaviorMemory(claim.path, claim.record)) itemClass = "behavior_memory";
    else if (isInternalSessionEvidence(claim.path, claim.record)) itemClass = "internal_session_evidence";
    else if (isSourceAnchorUnverified(claim.path, claim.record) && supportPaths.length === 0) itemClass = "source_anchor_unverified";
    else if (supportPaths.length > 0) itemClass = "verified_claim_support";
    else if (isProjectMemory(claim.path, claim.record, claim.factual_signals)) itemClass = "project_memory";
    else if (requiresSourceTruth(claim.path, claim.record, claim.factual_signals)) itemClass = "unsupported_factual_claim";
    else itemClass = "internal_claim";

    if (itemClass === "unsupported_factual_claim") {
      const internalTracePath = directSupportPaths.find((supportPath) =>
        supportPath.startsWith(".dino/traces/") || supportPath.startsWith(".dino/tasks/") || supportPath.startsWith("60_Operations/"),
      );
      findings.push({
        signal: anchorPaths.length > 0
          ? "anchor_only_used_as_support"
          : internalTracePath
            ? "internal_trace_only_used_as_support"
            : "unsupported_factual_claim",
        severity: "fail",
        path: claim.path,
        related_path: anchorPaths[0] ?? internalTracePath ?? null,
        reason:
          anchorPaths.length > 0
            ? "Claim is linked only to anchor-only unverified source chunks."
            : internalTracePath
              ? "Internal task, trace, or operations records cannot serve as verified external source truth."
              : "Factual/source-status claim lacks verified source chunk support.",
      });
    }

    claimSummaries.push({
      path: claim.path,
      title: claim.title,
      item_class: itemClass,
      source_status: sourceStatus,
      support_paths: supportPaths,
      anchor_only_paths: anchorPaths,
      factual_signals: claim.factual_signals,
    });
  }

  const blockers = findings.filter((finding) => finding.severity === "fail").length;
  const status: SourceLineageStatus = blockers === 0 ? "healthy" : "needs_attention";
  const latestVerifiedAt = chunkSummaries
    .map((chunk) => chunk.last_verified)
    .filter((value): value is string => Boolean(value))
    .sort((left, right) => right.localeCompare(left))[0] ?? null;
  const hashSignals = new Set<SourceLineageFindingSignal>([
    "source_content_hash_mismatch",
    "chunk_hash_mismatch",
    "claim_content_hash_mismatch",
    "lineage_generation_mismatch",
  ]);
  return {
    version: SOURCE_LINEAGE_VERSION,
    status,
    generated_at: generatedAt,
    latest_verified_at: latestVerifiedAt,
    data_root: path.resolve(dataRoot),
    counts: {
      source_chunks: chunks.length,
      source_snapshots: snapshots.length,
      provenance_links: provenance.length,
      lineage_generations: generations.length,
      verified_source_chunks: chunkSummaries.filter((chunk) => chunk.support_role === "verified_source_chunk").length,
      anchor_only_unverified: chunkSummaries.filter((chunk) => chunk.support_role === "source_anchor_unverified").length,
      unverified_source_chunks: chunkSummaries.filter((chunk) => chunk.support_role === "unverified_source_chunk").length,
      claim_records: claimRecords.length,
      behavior_memory_records: claimSummaries.filter((claim) => claim.item_class === "behavior_memory").length,
      project_memory_records: claimSummaries.filter((claim) => claim.item_class === "project_memory").length,
      internal_session_evidence_records: claimSummaries.filter((claim) => claim.item_class === "internal_session_evidence").length,
      source_anchor_unverified_records: claimSummaries.filter((claim) => claim.item_class === "source_anchor_unverified").length,
      verified_claim_support: claimSummaries.filter((claim) => claim.item_class === "verified_claim_support").length,
      unsupported_factual_claims: claimSummaries.filter((claim) => claim.item_class === "unsupported_factual_claim").length,
      factual_claim_records: claimSummaries.filter((claim) =>
        ["verified_claim_support", "unsupported_factual_claim", "source_anchor_unverified"].includes(claim.item_class),
      ).length,
      scanned_claim_files: claimRecords.length,
      dangling_claim_paths: findings.filter((finding) => finding.signal === "dangling_claim_path").length,
      stale_support: findings.filter((finding) => finding.signal === "source_chunk_verification_stale").length,
      hash_mismatches: findings.filter((finding) => hashSignals.has(finding.signal)).length,
      blockers,
    },
    source_chunks: chunkSummaries,
    claim_records: claimSummaries,
    findings,
    warnings: [
      chunkSummaries.some((chunk) => chunk.support_role === "source_anchor_unverified")
        ? "anchor_only_unverified_chunks_do_not_count_as_claim_support"
        : "",
      claimSummaries.some((claim) => claim.item_class === "source_anchor_unverified")
        ? "source_anchor_unverified_claims_do_not_count_as_claim_support"
        : "",
    ].filter(Boolean),
    visible_status: status === "healthy" ? "Source lineage healthy" : "Source lineage needs attention",
  };
}

export async function buildAndWriteSourceLineageReport(
  dataRoot: string,
  options: BuildOptions = {},
): Promise<{ report: SourceLineageReport; path: string }> {
  const report = await buildSourceLineageReport(dataRoot, options);
  const statusPath = dataPath(dataRoot, ...SOURCE_LINEAGE_STATUS_RELATIVE_PATH.split("/"));
  await atomicWriteJson(statusPath, report);
  return { report, path: statusPath };
}
