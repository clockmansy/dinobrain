import { promises as fs } from "node:fs";
import path from "node:path";

import { atomicWriteJson } from "./concurrency.js";
import { dataPath, relDataPath } from "./context.js";
import { FULL_MEMORY_STATE_DIR } from "./full-memory-audit.js";

export const SOURCE_LINEAGE_VERSION = "source_lineage_v1";
export const SOURCE_LINEAGE_STATUS_RELATIVE_PATH = `${FULL_MEMORY_STATE_DIR}/source_lineage_status.json`;

export type SourceLineageStatus = "healthy" | "needs_attention";
export type SourceLineageFindingSignal =
  | "source_chunk_verification_missing"
  | "source_chunk_body_missing"
  | "source_chunk_uri_missing"
  | "provenance_missing"
  | "provenance_source_missing"
  | "dangling_claim_path"
  | "anchor_only_used_as_support"
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
};

export type SourceLineageReport = {
  version: typeof SOURCE_LINEAGE_VERSION;
  status: SourceLineageStatus;
  generated_at: string;
  latest_verified_at: string | null;
  data_root: string;
  counts: {
    source_chunks: number;
    provenance_links: number;
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
    dangling_claim_paths: number;
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

const CLAIM_ROOTS = ["20_Wiki", "40_Projects", "50_Instances/accepted"] as const;
const FACTUAL_SOURCE_STATUSES = new Set([
  "verified",
  "verified_summary",
  "verified_chunk",
  "verified_source_chunk",
  "source_verified",
  "reviewed",
  "reviewed_source_chunk",
  "mixed_verified",
  "user_supplied_anchor_summary",
]);
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
  if (!text.startsWith("---\n")) return { metadata: {}, body: text };
  const end = text.indexOf("\n---\n", 4);
  if (end < 0) return { metadata: {}, body: text };
  const metadata: JsonObject = {};
  for (const line of text.slice(4, end).split(/\r?\n/)) {
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
  return { metadata, body: text.slice(end + 5) };
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

function tagsFrom(record: JsonObject): string[] {
  return Array.isArray(record.tags) ? record.tags.map(String).map((tag) => tag.toLowerCase()) : [];
}

function isBehaviorMemory(relativePath: string, record: JsonObject): boolean {
  const tags = tagsFrom(record);
  const sourceStatus = lowerString(record.source_status);
  return (
    (sourceStatus === "internal" && !relativePath.startsWith("40_Projects/")) ||
    relativePath.startsWith("50_Instances/accepted/codex-session-knowledge-") ||
    tags.includes("codex-session-derived") ||
    tags.includes("user-preference") ||
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
    tags.includes("task-trace") ||
    tags.includes("conversation-derived") ||
    relativePath.startsWith("50_Instances/accepted/task-memory-")
  );
}

function requiresSourceTruth(relativePath: string, record: JsonObject): boolean {
  if (isBehaviorMemory(relativePath, record)) return false;
  if (isInternalSessionEvidence(relativePath, record)) return false;
  const sourceStatus = lowerString(record.source_status);
  const tags = tagsFrom(record);
  if (relativePath.startsWith("40_Projects/")) {
    return (
      Boolean(sourceStatus && sourceStatus !== "internal") ||
      tags.some((tag) => FACTUAL_TAGS.has(tag)) ||
      tags.includes("public") ||
      tags.includes("external")
    );
  }
  if (relativePath.startsWith("50_Instances/accepted/")) {
    return (
      Boolean(sourceStatus && sourceStatus !== "internal") ||
      tags.some((tag) => FACTUAL_TAGS.has(tag))
    );
  }
  return (
    relativePath.startsWith("20_Wiki/") &&
    sourceStatus !== "internal" &&
    (Boolean(sourceStatus) ||
      tags.some((tag) => FACTUAL_TAGS.has(tag)))
  );
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

function isProjectMemory(relativePath: string, record: JsonObject): boolean {
  if (!relativePath.startsWith("40_Projects/")) return false;
  const sourceStatus = lowerString(record.source_status);
  return sourceStatus === "internal" && !requiresSourceTruth(relativePath, record);
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

async function collectProvenance(dataRoot: string): Promise<Array<{ path: string; record: JsonObject }>> {
  const root = dataPath(dataRoot, ".dino", "provenance");
  const files = await walkFiles(root, new Set([".json"]));
  const links = [];
  for (const file of files) {
    const record = await readJson(file);
    if (!record) continue;
    links.push({ path: relDataPath(dataRoot, file), record });
  }
  return links;
}

async function collectClaimRecords(dataRoot: string): Promise<Array<{ path: string; record: JsonObject; title: string }>> {
  const claims = [];
  for (const root of CLAIM_ROOTS) {
    const files = await walkFiles(dataPath(dataRoot, root), new Set([".json", ".md"]));
    for (const file of files) {
      const relativePath = relDataPath(dataRoot, file);
      if (relativePath.endsWith("/README.md") || relativePath === "20_Wiki/README.md") continue;
      const ext = path.extname(file).toLowerCase();
      if (ext === ".json") {
        const record = await readJson(file);
        if (!record) continue;
        claims.push({
          path: relativePath,
          record,
          title: firstString(record.title, record.claim, path.basename(file, ext)) ?? path.basename(file, ext),
        });
      } else {
        const text = await fs.readFile(file, "utf8");
        const { metadata, body } = parseFrontmatter(text);
        claims.push({
          path: relativePath,
          record: metadata,
          title: firstString(metadata.title, firstHeading(body), path.basename(file, ext)) ?? path.basename(file, ext),
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
  const [chunks, provenance, claimRecords] = await Promise.all([
    collectSourceChunks(dataRoot),
    collectProvenance(dataRoot),
    collectClaimRecords(dataRoot),
  ]);
  const findings: SourceLineageFinding[] = [];
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
    const status = sourceVerification(chunk.record);
    const chunkId = firstString(chunk.record.source_chunk_id, path.basename(chunk.path, ".json")) ?? path.basename(chunk.path, ".json");
    const sourceUri = firstString(chunk.record.source_uri);
    const chunkText = firstString(chunk.record.chunk_text);
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

    if (!status) {
      findings.push({
        signal: "source_chunk_verification_missing",
        severity: "fail",
        path: chunk.path,
        related_path: null,
        reason: "Source chunk lacks verification_status/source_status.",
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
    if (relatedProvenance.length === 0) {
      findings.push({
        signal: "provenance_missing",
        severity: "fail",
        path: chunk.path,
        related_path: null,
        reason: "Source chunk has no provenance link.",
      });
    }
    for (const claimPath of claimPaths) {
      if (!(await pathExists(dataRoot, claimPath))) {
        findings.push({
          signal: "dangling_claim_path",
          severity: "fail",
          path: chunk.path,
          related_path: claimPath,
          reason: "Source/provenance claim_path does not exist.",
        });
      }
      const target = supportRole === "verified_source_chunk" ? verifiedSupport : anchorOnlySupport;
      target.set(claimPath, [...(target.get(claimPath) ?? []), chunk.path]);
    }
    chunkSummaries.push({
      path: chunk.path,
      source_chunk_id: chunkId,
      source_uri: sourceUri,
      verification_status: status,
      support_role: supportRole,
      claim_paths: claimPaths,
    });
  }

  for (const claim of claimRecords) {
    if (isBehaviorMemory(claim.path, claim.record) || isInternalSessionEvidence(claim.path, claim.record)) continue;
    const sourceStatus = lowerString(claim.record.source_status);
    if (isVerifiedStatus(sourceStatus) || (sourceStatus && FACTUAL_SOURCE_STATUSES.has(sourceStatus) && !isAnchorOnly(sourceStatus))) {
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
    else if (isProjectMemory(claim.path, claim.record)) itemClass = "project_memory";
    else if (requiresSourceTruth(claim.path, claim.record)) itemClass = "unsupported_factual_claim";
    else itemClass = "internal_claim";

    if (itemClass === "unsupported_factual_claim") {
      findings.push({
        signal: anchorPaths.length > 0 ? "anchor_only_used_as_support" : "unsupported_factual_claim",
        severity: "fail",
        path: claim.path,
        related_path: anchorPaths[0] ?? null,
        reason:
          anchorPaths.length > 0
            ? "Claim is linked only to anchor-only unverified source chunks."
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
    });
  }

  const blockers = findings.filter((finding) => finding.severity === "fail").length;
  const status: SourceLineageStatus = blockers === 0 ? "healthy" : "needs_attention";
  return {
    version: SOURCE_LINEAGE_VERSION,
    status,
    generated_at: generatedAt,
    latest_verified_at: blockers === 0 ? generatedAt : null,
    data_root: path.resolve(dataRoot),
    counts: {
      source_chunks: chunks.length,
      provenance_links: provenance.length,
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
      dangling_claim_paths: findings.filter((finding) => finding.signal === "dangling_claim_path").length,
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
