import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import { dataPath, relDataPath } from "./context.js";
import {
  reapplySourceLineageTransaction,
  rollbackSourceLineageTransaction,
  type SourceLineageClaimBinding,
  type SourceLineageTransactionResult,
  writeSourceLineageGeneration,
} from "./source-lineage-store.js";

type JsonObject = Record<string, unknown>;

export const SOURCE_LINEAGE_MAX_VERIFICATION_AGE_DAYS = 180;
export const VERIFIED_LINEAGE_STATUSES = new Set([
  "verified",
  "verified_chunk",
  "verified_summary",
  "verified_source_chunk",
  "source_verified",
  "reviewed_source_chunk",
]);

export type SourceLineageVerificationStatus =
  | "anchor_only_unverified"
  | "fetched_unverified"
  | "verified_chunk"
  | "verified_summary"
  | "reviewed_source_chunk";

export type PublishSourceLineageInput = {
  source_chunk_id: string;
  source_title: string;
  source_uri: string;
  chunk_type: "external_doc" | "paper" | "community" | "internal_doc" | "conversation_excerpt";
  chunk_text: string;
  claim_paths: string[];
  evidence_paths?: string[];
  tags?: string[];
  verification_status: SourceLineageVerificationStatus;
  last_verified?: string;
  fetched_at?: string;
  verification_method?: string;
  verification_actor?: string;
  source_content_sha256?: string;
  source_content_length?: number;
  source_content_scope?: "full_response" | "bounded_excerpt" | "verified_summary";
  chunk_text_redactions?: string[];
  chunk_text_truncated?: boolean;
  chunk_text_original_length?: number;
  chunk_text_stored_length?: number;
  actor?: string;
  fault_after_write_index_for_test?: number;
};

export type PublishSourceLineageResult = SourceLineageTransactionResult & {
  source_snapshot_path: string;
  source_chunk_path: string;
  provenance_path: string;
  claim_bindings: SourceLineageClaimBinding[];
  source_content_sha256: string;
  chunk_sha256: string;
  content_changed: boolean;
  support_bindings_changed: boolean;
};

function sha256(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function normalizeId(value: string): string {
  const normalized = value.trim();
  if (!/^[A-Za-z0-9._-]+$/.test(normalized)) throw new Error(`Invalid source chunk id: ${value}`);
  return normalized;
}

function normalizeVaultPath(value: string): string {
  const normalized = value.replace(/\\/g, "/").replace(/^\/+/, "");
  if (!normalized || normalized.split("/").some((part) => part === "..")) {
    throw new Error(`Invalid source lineage path: ${value}`);
  }
  return normalized;
}

function normalizeDate(value: string | undefined, label: string): string | null {
  if (!value) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(`${value}T00:00:00.000Z`))) {
    throw new Error(`${label} must be YYYY-MM-DD`);
  }
  return value;
}

function normalizeTimestamp(value: string | undefined, fallbackDate: string | null): string {
  if (value) {
    const parsed = Date.parse(value);
    if (!Number.isFinite(parsed)) throw new Error("fetched_at must be an ISO timestamp");
    return new Date(parsed).toISOString();
  }
  return fallbackDate ? `${fallbackDate}T00:00:00.000Z` : new Date().toISOString();
}

async function readJsonWithHash(filePath: string): Promise<{ record: JsonObject | null; sha256: string | null }> {
  try {
    const bytes = await fs.readFile(filePath);
    const parsed = JSON.parse(bytes.toString("utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`Expected JSON object: ${filePath}`);
    return { record: parsed as JsonObject, sha256: sha256(bytes) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { record: null, sha256: null };
    throw error;
  }
}

async function claimBinding(dataRoot: string, claimPath: string): Promise<SourceLineageClaimBinding> {
  const normalized = normalizeVaultPath(claimPath);
  if (!normalized.startsWith("20_Wiki/") && !normalized.startsWith("40_Projects/") && !normalized.startsWith("50_Instances/accepted/")) {
    throw new Error(`Claim path must be under Wiki, Projects, or accepted memory: ${normalized}`);
  }
  let bytes: Buffer;
  try {
    bytes = await fs.readFile(dataPath(dataRoot, ...normalized.split("/")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error(`Claim path does not exist: ${normalized}`);
    throw error;
  }
  return { path: normalized, sha256: sha256(bytes) };
}

async function evidenceBinding(dataRoot: string, evidencePath: string): Promise<SourceLineageClaimBinding> {
  const normalized = normalizeVaultPath(evidencePath);
  if (normalized.startsWith("10_Conversations/") || normalized.startsWith("30_Sources/private/") || normalized.startsWith("attachments/private/")) {
    throw new Error(`Private paths cannot be published as source-lineage evidence: ${normalized}`);
  }
  let bytes: Buffer;
  try {
    bytes = await fs.readFile(dataPath(dataRoot, ...normalized.split("/")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error(`Evidence path does not exist: ${normalized}`);
    throw error;
  }
  return { path: normalized, sha256: sha256(bytes) };
}

function generationId(
  sourceChunkId: string,
  sourceContentSha256: string,
  chunkSha256: string,
  verificationStatus: string,
  verifiedAt: string | null,
  claimBindings: SourceLineageClaimBinding[],
  evidenceBindings: SourceLineageClaimBinding[],
): string {
  const digest = sha256(
    JSON.stringify({
      source_chunk_id: sourceChunkId,
      source_content_sha256: sourceContentSha256,
      chunk_sha256: chunkSha256,
      verification_status: verificationStatus,
      verified_at: verifiedAt,
      claim_bindings: [...claimBindings].sort((left, right) => left.path.localeCompare(right.path)),
      evidence_bindings: [...evidenceBindings].sort((left, right) => left.path.localeCompare(right.path)),
    }),
  ).slice(0, 20);
  return `lineage-${sourceChunkId.slice(0, 48)}-${digest}`;
}

export async function publishSourceLineage(
  dataRoot: string,
  input: PublishSourceLineageInput,
): Promise<PublishSourceLineageResult> {
  const sourceChunkId = normalizeId(input.source_chunk_id);
  const verificationStatus = input.verification_status;
  const verified = VERIFIED_LINEAGE_STATUSES.has(verificationStatus);
  const lastVerified = normalizeDate(input.last_verified, "last_verified");
  if (verified && !lastVerified) throw new Error("Verified source lineage requires last_verified");
  if (input.claim_paths.length > 0 && !verified) {
    throw new Error("Claim support requires a verified source chunk; anchor-only and fetched-unverified sources cannot support claims");
  }
  if (verified && !firstString(input.verification_method)) {
    throw new Error("Verified source lineage requires verification_method");
  }

  const uniqueClaimPaths = Array.from(new Set(input.claim_paths.map(normalizeVaultPath))).sort((a, b) => a.localeCompare(b));
  const claimBindings = await Promise.all(uniqueClaimPaths.map((claimPath) => claimBinding(dataRoot, claimPath)));
  const uniqueEvidencePaths = Array.from(new Set((input.evidence_paths ?? []).map(normalizeVaultPath))).sort((a, b) => a.localeCompare(b));
  const evidenceBindings = await Promise.all(uniqueEvidencePaths.map((evidencePath) => evidenceBinding(dataRoot, evidencePath)));
  const sourceSnapshotPath = `30_Sources/fetched/${sourceChunkId}.json`;
  const sourceChunkPath = `30_Sources/chunks/${sourceChunkId}.json`;
  const provenancePath = `.dino/provenance/${sourceChunkId}.json`;
  const [existingSnapshot, existingChunk, existingProvenance] = await Promise.all([
    readJsonWithHash(dataPath(dataRoot, ...sourceSnapshotPath.split("/"))),
    readJsonWithHash(dataPath(dataRoot, ...sourceChunkPath.split("/"))),
    readJsonWithHash(dataPath(dataRoot, ...provenancePath.split("/"))),
  ]);

  const chunkSha256 = sha256(input.chunk_text);
  const sourceContentSha256 = input.source_content_sha256 ?? sha256(input.chunk_text);
  if (!/^[a-f0-9]{64}$/.test(sourceContentSha256)) throw new Error("source_content_sha256 must be a lowercase SHA-256");
  const previousContentSha256 = firstString(
    existingSnapshot.record?.source_content_sha256,
    existingChunk.record?.source_content_sha256,
    typeof existingChunk.record?.chunk_text === "string" ? sha256(existingChunk.record.chunk_text) : null,
  );
  const contentChanged = Boolean(previousContentSha256 && previousContentSha256 !== sourceContentSha256);
  const previousClaimBindings = Array.isArray(existingProvenance.record?.claim_bindings)
    ? existingProvenance.record.claim_bindings
    : [];
  const previousEvidenceBindings = Array.isArray(existingProvenance.record?.evidence_bindings)
    ? existingProvenance.record.evidence_bindings
    : [];
  const bindingFingerprint = (bindings: unknown[]): string =>
    sha256(
      JSON.stringify(
        bindings
          .filter((binding): binding is { path: unknown; sha256: unknown } => Boolean(binding && typeof binding === "object"))
          .map((binding) => ({ path: String(binding.path ?? ""), sha256: String(binding.sha256 ?? "") }))
          .sort((left, right) => left.path.localeCompare(right.path)),
      ),
    );
  const supportBindingsChanged =
    (previousClaimBindings.length > 0 || previousEvidenceBindings.length > 0) &&
    bindingFingerprint([...previousClaimBindings, ...previousEvidenceBindings]) !==
      bindingFingerprint([...claimBindings, ...evidenceBindings]);
  const previousVerified = normalizeDate(
    firstString(existingSnapshot.record?.last_verified, existingChunk.record?.last_verified) ?? undefined,
    "existing last_verified",
  );
  if ((contentChanged || supportBindingsChanged) && verified && previousVerified && lastVerified && lastVerified <= previousVerified) {
    throw new Error("Changed source content or claim/evidence bindings require a newer last_verified date");
  }

  const now = new Date().toISOString();
  const fetchedAt = normalizeTimestamp(input.fetched_at, lastVerified);
  const createdAt = firstString(existingChunk.record?.created_at, existingSnapshot.record?.created_at) ?? now;
  const stage = verified ? "verified_source" : verificationStatus === "anchor_only_unverified" ? "url_anchor" : "fetched_source";
  const lineageRole = verified ? "verified_chunk" : verificationStatus === "anchor_only_unverified" ? "source_anchor" : "fetched_source";
  const generation = generationId(
    sourceChunkId,
    sourceContentSha256,
    chunkSha256,
    verificationStatus,
    lastVerified,
    claimBindings,
    evidenceBindings,
  );
  const generationReceiptPath = `.dino/provenance/generations/${generation}.json`;

  const sourceSnapshot: JsonObject = {
    version: "source_snapshot_v1",
    type: "source_snapshot",
    source_id: sourceChunkId,
    stage,
    source_title: input.source_title,
    source_uri: input.source_uri,
    source_content_sha256: sourceContentSha256,
    source_content_length: input.source_content_length ?? input.chunk_text_original_length ?? input.chunk_text.length,
    source_content_scope: input.source_content_scope ?? "bounded_excerpt",
    content_retention: "hash_and_bounded_chunk_only",
    fetched_at: fetchedAt,
    verification_status: verificationStatus,
    last_verified: lastVerified,
    verification_method: firstString(input.verification_method),
    verification_actor: firstString(input.verification_actor, input.actor),
    previous_source_content_sha256: contentChanged ? previousContentSha256 : null,
    content_changed: contentChanged,
    support_bindings_changed: supportBindingsChanged,
    lineage_generation_id: generation,
    evidence_paths: uniqueEvidencePaths,
    evidence_bindings: evidenceBindings,
    created_at: firstString(existingSnapshot.record?.created_at) ?? createdAt,
    updated_at: now,
  };
  const sourceChunk: JsonObject = {
    ...(existingChunk.record ?? {}),
    source_chunk_id: sourceChunkId,
    type: "source_chunk",
    status: "active",
    lineage_role: lineageRole,
    title: input.source_title,
    source_uri: input.source_uri,
    source_snapshot_path: sourceSnapshotPath,
    chunk_type: input.chunk_type,
    chunk_text: input.chunk_text,
    chunk_text_redactions: input.chunk_text_redactions ?? [],
    chunk_text_truncated: input.chunk_text_truncated ?? false,
    chunk_text_original_length: input.chunk_text_original_length ?? input.chunk_text.length,
    chunk_text_stored_length: input.chunk_text_stored_length ?? input.chunk_text.length,
    source_content_sha256: sourceContentSha256,
    chunk_sha256: chunkSha256,
    claim_paths: uniqueClaimPaths,
    claim_bindings: claimBindings,
    evidence_paths: uniqueEvidencePaths,
    evidence_bindings: evidenceBindings,
    tags: input.tags ?? [],
    verification_status: verificationStatus,
    last_verified: lastVerified,
    verification_method: firstString(input.verification_method),
    verification_actor: firstString(input.verification_actor, input.actor),
    verification_max_age_days: SOURCE_LINEAGE_MAX_VERIFICATION_AGE_DAYS,
    lineage_generation_id: generation,
    lineage_generation_path: generationReceiptPath,
    previous_source_content_sha256: contentChanged ? previousContentSha256 : null,
    content_changed: contentChanged,
    support_bindings_changed: supportBindingsChanged,
    created_at: firstString(existingChunk.record?.created_at) ?? createdAt,
    updated_at: now,
  };
  const provenance: JsonObject = {
    ...(existingProvenance.record ?? {}),
    version: "claim_provenance_v2",
    type: "claim_support",
    provenance_id: sourceChunkId,
    lineage_role: "claim_support",
    source_snapshot_path: sourceSnapshotPath,
    source_chunk_path: sourceChunkPath,
    claim_paths: uniqueClaimPaths,
    claim_bindings: claimBindings,
    evidence_paths: uniqueEvidencePaths,
    evidence_bindings: evidenceBindings,
    source_uri: input.source_uri,
    source_content_sha256: sourceContentSha256,
    chunk_sha256: chunkSha256,
    verification_status: verificationStatus,
    last_verified: lastVerified,
    verification_method: firstString(input.verification_method),
    lineage_generation_id: generation,
    lineage_generation_path: generationReceiptPath,
    created_at: firstString(existingProvenance.record?.created_at) ?? createdAt,
    updated_at: now,
  };

  const transaction = await writeSourceLineageGeneration(
    dataRoot,
    [
      { target_path: sourceSnapshotPath, record: sourceSnapshot, expected_before_sha256: existingSnapshot.sha256 },
      { target_path: sourceChunkPath, record: sourceChunk, expected_before_sha256: existingChunk.sha256 },
      { target_path: provenancePath, record: provenance, expected_before_sha256: existingProvenance.sha256 },
    ],
    {
      generation_id: generation,
      source_snapshot_path: sourceSnapshotPath,
      source_chunk_path: sourceChunkPath,
      provenance_path: provenancePath,
      source_content_sha256: sourceContentSha256,
      chunk_sha256: chunkSha256,
      verification_status: verificationStatus,
      verified_at: lastVerified,
      claim_bindings: claimBindings,
      evidence_bindings: evidenceBindings,
    },
    {
      actor: input.actor ?? "create_source_chunk",
      reason: contentChanged || supportBindingsChanged
        ? "reverify_changed_source_or_support_bindings"
        : "publish_source_chunk_claim_lineage",
      fault_after_write_index_for_test: input.fault_after_write_index_for_test,
    },
  );
  return {
    ...transaction,
    source_snapshot_path: sourceSnapshotPath,
    source_chunk_path: sourceChunkPath,
    provenance_path: provenancePath,
    claim_bindings: claimBindings,
    source_content_sha256: sourceContentSha256,
    chunk_sha256: chunkSha256,
    content_changed: contentChanged,
    support_bindings_changed: supportBindingsChanged,
  };
}

export async function migrateExistingSourceLineage(dataRoot: string): Promise<{
  migrated: number;
  idempotent: number;
  transactions: PublishSourceLineageResult[];
}> {
  const sourceRoot = dataPath(dataRoot, "30_Sources", "chunks");
  let entries: Array<import("node:fs").Dirent>;
  try {
    entries = await fs.readdir(sourceRoot, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { migrated: 0, idempotent: 0, transactions: [] };
    throw error;
  }
  const transactions: PublishSourceLineageResult[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const record = JSON.parse(await fs.readFile(path.join(sourceRoot, entry.name), "utf8")) as JsonObject;
    const sourceChunkId = firstString(record.source_chunk_id, path.basename(entry.name, ".json"));
    const sourceTitle = firstString(record.title, sourceChunkId);
    const sourceUri = firstString(record.source_uri);
    const chunkText = firstString(record.chunk_text);
    const verificationStatus = firstString(record.verification_status, record.source_status) as SourceLineageVerificationStatus | null;
    if (!sourceChunkId || !sourceTitle || !sourceUri || !chunkText || !verificationStatus) continue;
    const lastVerified = firstString(record.last_verified) ?? undefined;
    const result = await publishSourceLineage(dataRoot, {
      source_chunk_id: sourceChunkId,
      source_title: sourceTitle,
      source_uri: sourceUri,
      chunk_type: (firstString(record.chunk_type) as PublishSourceLineageInput["chunk_type"] | null) ?? "external_doc",
      chunk_text: chunkText,
      claim_paths: Array.isArray(record.claim_paths)
        ? record.claim_paths.map(String).filter((claimPath) => /^(20_Wiki|40_Projects|50_Instances\/accepted)\//.test(claimPath.replace(/\\/g, "/")))
        : [],
      evidence_paths: [
        ...(Array.isArray(record.evidence_paths) ? record.evidence_paths.map(String) : []),
        ...(Array.isArray(record.claim_paths)
          ? record.claim_paths.map(String).filter((claimPath) => !/^(20_Wiki|40_Projects|50_Instances\/accepted)\//.test(claimPath.replace(/\\/g, "/")))
          : []),
      ],
      tags: Array.isArray(record.tags) ? record.tags.map(String) : [],
      verification_status: verificationStatus,
      last_verified: lastVerified,
      fetched_at: firstString(record.fetched_at) ?? (lastVerified ? `${lastVerified}T00:00:00.000Z` : undefined),
      verification_method: firstString(record.verification_method) ?? "legacy_direct_source_review",
      verification_actor: firstString(record.verification_actor) ?? "rag02-current-vault-migration",
      source_content_sha256: firstString(record.source_content_sha256) ?? sha256(chunkText),
      source_content_length: Number(record.source_content_length ?? record.chunk_text_original_length ?? chunkText.length),
      source_content_scope: "verified_summary",
      chunk_text_redactions: Array.isArray(record.chunk_text_redactions) ? record.chunk_text_redactions.map(String) : [],
      chunk_text_truncated: record.chunk_text_truncated === true,
      chunk_text_original_length: Number(record.chunk_text_original_length ?? chunkText.length),
      chunk_text_stored_length: Number(record.chunk_text_stored_length ?? chunkText.length),
      actor: "rag02-current-vault-migration",
    });
    transactions.push(result);
  }
  return {
    migrated: transactions.filter((transaction) => !transaction.idempotent).length,
    idempotent: transactions.filter((transaction) => transaction.idempotent).length,
    transactions,
  };
}

export { reapplySourceLineageTransaction, rollbackSourceLineageTransaction };

export async function sourceLineageFileHash(dataRoot: string, relativePath: string): Promise<string | null> {
  try {
    return sha256(await fs.readFile(dataPath(dataRoot, ...normalizeVaultPath(relativePath).split("/"))));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export function sourceLineageRelativePath(dataRoot: string, filePath: string): string {
  return relDataPath(dataRoot, filePath);
}
