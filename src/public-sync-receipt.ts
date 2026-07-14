import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

import { atomicWriteJson } from "./concurrency.js";
import type { DataPathClassification } from "./data-classification.js";
import type { TaskSyncApproval, TaskSyncScopeEntry } from "./task-sync-scope.js";

export const PUBLIC_SYNC_RECEIPT_VERSION = "task_sync_public_receipt_20260712_v1";
export const PUBLIC_SYNC_RECEIPT_ROOT = "60_Operations/task-sync-receipts";
export const PUBLIC_SYNC_RECEIPT_PATH_PATTERN =
  /^60_Operations\/task-sync-receipts\/task-sync-receipt-([a-f0-9]{64})\.json$/;

export const PUBLIC_SYNC_RECEIPT_TRAILERS = {
  taskId: "DinoBrain-Task-Id",
  path: "DinoBrain-Sync-Receipt",
  sha256: "DinoBrain-Sync-Receipt-SHA256",
  blobOid: "DinoBrain-Sync-Receipt-Blob",
} as const;

const execFileAsync = promisify(execFile);
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const GIT_OID_PATTERN = /^[a-f0-9]{40,64}$/;

export type PublicSyncReceiptArtifact = {
  path: string;
  sha256: string;
  git_blob_oid: string;
  size_bytes: number;
  classification: Exclude<DataPathClassification, "blocked">;
  policy: string;
  approval: Exclude<TaskSyncApproval, "pending_review">;
  source: string;
};

export type PublicSyncReceiptPayload = {
  version: typeof PUBLIC_SYNC_RECEIPT_VERSION;
  created_at: string;
  task_id: string;
  task_request_hash: string;
  task_record_path: string;
  task_record_sha256: string;
  base_commit: string;
  classifier_policy_version: string;
  scope: {
    version: string;
    revision: number;
    sha256: string;
  };
  artifacts: PublicSyncReceiptArtifact[];
  conditional_paths: string[];
};

export type PublicSyncReceipt = PublicSyncReceiptPayload & {
  receipt_id: string;
};

export type PublicSyncReceiptValidation = {
  ok: boolean;
  errors: string[];
  receipt: PublicSyncReceipt | null;
};

function sha256Bytes(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function normalizedRelativePath(value: string): string {
  const normalized = value.replace(/\\/g, "/").replace(/^\.\//, "");
  if (
    !normalized ||
    path.posix.isAbsolute(normalized) ||
    path.win32.isAbsolute(value) ||
    /^[A-Za-z]:[\\/]/.test(value) ||
    normalized.split("/").some((segment) => !segment || segment === "..")
  ) {
    throw new Error(`Public sync receipt path must be repository-relative: ${value}`);
  }
  return normalized;
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value as Record<string, unknown>)
      .sort()
      .map((key) => [key, canonicalValue((value as Record<string, unknown>)[key])]),
  );
}

export function canonicalPublicSyncReceipt(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

export function publicSyncReceiptId(payload: PublicSyncReceiptPayload): string {
  return sha256Bytes(canonicalPublicSyncReceipt(payload));
}

export function publicSyncArtifactBindingSha256(
  artifact: Pick<
    PublicSyncReceiptArtifact,
    "path" | "sha256" | "git_blob_oid" | "size_bytes" | "classification" | "policy" | "approval" | "source"
  >,
): string {
  return sha256Bytes(
    canonicalPublicSyncReceipt({
      path: normalizedRelativePath(artifact.path),
      sha256: artifact.sha256,
      git_blob_oid: artifact.git_blob_oid,
      size_bytes: artifact.size_bytes,
      classification: artifact.classification,
      policy: artifact.policy,
      approval: artifact.approval,
      source: artifact.source,
    }),
  );
}

export function publicSyncReceiptRelativePath(receiptId: string): string {
  if (!SHA256_PATTERN.test(receiptId)) throw new Error("Public sync receipt id must be SHA-256");
  return `${PUBLIC_SYNC_RECEIPT_ROOT}/task-sync-receipt-${receiptId}.json`;
}

function payloadFromReceipt(receipt: PublicSyncReceipt): PublicSyncReceiptPayload {
  const { receipt_id: _receiptId, ...payload } = receipt;
  return payload;
}

function sameStringSet(left: string[], right: string[]): boolean {
  const a = Array.from(new Set(left)).sort();
  const b = Array.from(new Set(right)).sort();
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function exactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

export function validatePublicSyncReceipt(value: unknown): PublicSyncReceiptValidation {
  const errors: string[] = [];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, errors: ["receipt_not_an_object"], receipt: null };
  }
  const receipt = value as PublicSyncReceipt;
  if (
    !exactKeys(receipt as unknown as Record<string, unknown>, [
      "version",
      "receipt_id",
      "created_at",
      "task_id",
      "task_request_hash",
      "task_record_path",
      "task_record_sha256",
      "base_commit",
      "classifier_policy_version",
      "scope",
      "artifacts",
      "conditional_paths",
    ])
  ) {
    errors.push("receipt_schema_keys_invalid");
  }
  if (receipt.version !== PUBLIC_SYNC_RECEIPT_VERSION) errors.push("receipt_version_invalid");
  if (!SHA256_PATTERN.test(String(receipt.receipt_id ?? ""))) errors.push("receipt_id_invalid");
  if (!Number.isFinite(Date.parse(String(receipt.created_at ?? "")))) errors.push("receipt_created_at_invalid");
  if (!String(receipt.task_id ?? "").trim()) errors.push("receipt_task_id_missing");
  if (!SHA256_PATTERN.test(String(receipt.task_request_hash ?? ""))) errors.push("receipt_task_request_hash_invalid");
  if (!SHA256_PATTERN.test(String(receipt.task_record_sha256 ?? ""))) errors.push("receipt_task_record_sha256_invalid");
  if (!GIT_OID_PATTERN.test(String(receipt.base_commit ?? ""))) errors.push("receipt_base_commit_invalid");
  if (!String(receipt.classifier_policy_version ?? "").trim()) errors.push("receipt_classifier_policy_missing");
  try {
    if (!/^\.dino\/tasks\/.+\.json$/.test(normalizedRelativePath(receipt.task_record_path))) {
      errors.push("receipt_task_record_path_invalid");
    }
  } catch {
    errors.push("receipt_task_record_path_invalid");
  }
  if (!receipt.scope || typeof receipt.scope !== "object" || Array.isArray(receipt.scope)) {
    errors.push("receipt_scope_invalid");
  } else {
    if (!exactKeys(receipt.scope as unknown as Record<string, unknown>, ["version", "revision", "sha256"])) {
      errors.push("receipt_scope_keys_invalid");
    }
    if (!String(receipt.scope.version ?? "").trim()) errors.push("receipt_scope_version_invalid");
    if (!Number.isInteger(receipt.scope.revision) || receipt.scope.revision < 1) errors.push("receipt_scope_revision_invalid");
    if (!SHA256_PATTERN.test(String(receipt.scope.sha256 ?? ""))) errors.push("receipt_scope_sha256_invalid");
  }

  if (!Array.isArray(receipt.artifacts) || receipt.artifacts.length === 0) {
    errors.push("receipt_artifacts_missing");
  } else {
    const paths: string[] = [];
    for (const artifact of receipt.artifacts) {
      if (!artifact || typeof artifact !== "object" || Array.isArray(artifact)) {
        errors.push("receipt_artifact_invalid");
        continue;
      }
      if (
        !exactKeys(artifact as unknown as Record<string, unknown>, [
          "path",
          "sha256",
          "git_blob_oid",
          "size_bytes",
          "classification",
          "policy",
          "approval",
          "source",
        ])
      ) {
        errors.push("receipt_artifact_keys_invalid");
      }
      try {
        paths.push(normalizedRelativePath(artifact.path));
      } catch {
        errors.push("receipt_artifact_path_invalid");
      }
      if (!SHA256_PATTERN.test(String(artifact.sha256 ?? ""))) errors.push("receipt_artifact_sha256_invalid");
      if (!GIT_OID_PATTERN.test(String(artifact.git_blob_oid ?? ""))) errors.push("receipt_artifact_blob_oid_invalid");
      if (!Number.isInteger(artifact.size_bytes) || artifact.size_bytes < 0) errors.push("receipt_artifact_size_invalid");
      if (!(["syncable", "conditional"] as unknown[]).includes(artifact.classification)) {
        errors.push("receipt_artifact_classification_invalid");
      }
      if (!(["system_verified", "reviewed"] as unknown[]).includes(artifact.approval)) {
        errors.push("receipt_artifact_approval_invalid");
      }
      if (!String(artifact.policy ?? "").trim()) errors.push("receipt_artifact_policy_missing");
      if (!String(artifact.source ?? "").trim()) errors.push("receipt_artifact_source_missing");
    }
    if (new Set(paths).size !== paths.length) errors.push("receipt_artifact_path_duplicate");
    if (paths.join("\n") !== [...paths].sort().join("\n")) errors.push("receipt_artifacts_not_sorted");
    const taskArtifact = receipt.artifacts.find((artifact) => artifact.path === receipt.task_record_path);
    if (!taskArtifact || taskArtifact.sha256 !== receipt.task_record_sha256) errors.push("receipt_task_record_artifact_mismatch");
  }

  if (!Array.isArray(receipt.conditional_paths) || receipt.conditional_paths.length === 0) {
    errors.push("receipt_conditional_paths_missing");
  } else {
    const expectedConditional = Array.isArray(receipt.artifacts)
      ? receipt.artifacts.filter((artifact) => artifact.classification === "conditional").map((artifact) => artifact.path)
      : [];
    if (!sameStringSet(receipt.conditional_paths, expectedConditional)) errors.push("receipt_conditional_paths_mismatch");
    if (receipt.conditional_paths.join("\n") !== [...receipt.conditional_paths].sort().join("\n")) {
      errors.push("receipt_conditional_paths_not_sorted");
    }
  }

  if (errors.length === 0 && publicSyncReceiptId(payloadFromReceipt(receipt)) !== receipt.receipt_id) {
    errors.push("receipt_id_payload_mismatch");
  }
  return { ok: errors.length === 0, errors: Array.from(new Set(errors)), receipt: errors.length === 0 ? receipt : null };
}

async function fileIdentity(dataRoot: string, relativePath: string): Promise<{
  sha256: string;
  git_blob_oid: string;
  size_bytes: number;
}> {
  const fullPath = path.join(dataRoot, normalizedRelativePath(relativePath));
  const bytes = await fs.readFile(fullPath);
  const result = await execFileAsync(
    "git",
    ["-c", `safe.directory=${path.resolve(dataRoot)}`, "-C", dataRoot, "hash-object", `--path=${relativePath}`, fullPath],
    { encoding: "utf8", windowsHide: true, maxBuffer: 1024 * 1024 },
  );
  const gitBlobOid = result.stdout.trim().toLowerCase();
  if (!GIT_OID_PATTERN.test(gitBlobOid)) throw new Error(`Unable to bind Git blob identity: ${relativePath}`);
  return { sha256: sha256Bytes(bytes), git_blob_oid: gitBlobOid, size_bytes: bytes.length };
}

export async function writePublicSyncReceipt(input: {
  dataRoot: string;
  taskId: string;
  taskPath: string;
  baseCommit: string;
  classifierPolicyVersion: string;
  scopeVersion: string;
  scopeRevision: number;
  scopeSha256: string;
  entries: Array<{
    scope: TaskSyncScopeEntry;
    classification: Exclude<DataPathClassification, "blocked">;
    policy: string;
  }>;
}): Promise<{
  receipt: PublicSyncReceipt;
  receipt_path: string;
  receipt_sha256: string;
  receipt_git_blob_oid: string;
  receipt_size_bytes: number;
}> {
  const taskPath = normalizedRelativePath(input.taskPath);
  const taskBytes = await fs.readFile(path.join(input.dataRoot, taskPath));
  const taskRecord = JSON.parse(taskBytes.toString("utf8")) as { task_id?: string; request_hash?: string };
  if (taskRecord.task_id !== input.taskId) throw new Error("Public sync receipt task record binding mismatch");
  if (!SHA256_PATTERN.test(String(taskRecord.request_hash ?? ""))) throw new Error("Public sync receipt task request hash missing");
  if (!GIT_OID_PATTERN.test(input.baseCommit)) throw new Error("Public sync receipt base commit is invalid");
  if (!SHA256_PATTERN.test(input.scopeSha256)) throw new Error("Public sync receipt scope hash is invalid");

  const artifacts: PublicSyncReceiptArtifact[] = input.entries
    .map(({ scope, classification, policy }) => {
      if (!scope.git_blob_oid || !GIT_OID_PATTERN.test(scope.git_blob_oid)) {
        throw new Error(`Public sync receipt artifact lacks Git identity: ${scope.path}`);
      }
      if (scope.approval === "pending_review") {
        throw new Error(`Public sync receipt artifact is still pending review: ${scope.path}`);
      }
      return {
        path: normalizedRelativePath(scope.path),
        sha256: scope.sha256,
        git_blob_oid: scope.git_blob_oid,
        size_bytes: scope.size_bytes,
        classification,
        policy,
        approval: scope.approval,
        source: scope.source,
      };
    })
    .sort((left, right) => left.path.localeCompare(right.path));
  const conditionalPaths = artifacts
    .filter((artifact) => artifact.classification === "conditional")
    .map((artifact) => artifact.path)
    .sort();
  if (conditionalPaths.length === 0) throw new Error("Public sync receipt requires at least one conditional artifact");
  const taskArtifact = artifacts.find((artifact) => artifact.path === taskPath);
  const taskRecordSha256 = sha256Bytes(taskBytes);
  if (!taskArtifact || taskArtifact.sha256 !== taskRecordSha256) {
    throw new Error("Conditional sync must include the exact task record in its explicit allowlist");
  }

  const payload: PublicSyncReceiptPayload = {
    version: PUBLIC_SYNC_RECEIPT_VERSION,
    created_at: new Date().toISOString(),
    task_id: input.taskId,
    task_request_hash: String(taskRecord.request_hash),
    task_record_path: taskPath,
    task_record_sha256: taskRecordSha256,
    base_commit: input.baseCommit.toLowerCase(),
    classifier_policy_version: input.classifierPolicyVersion,
    scope: {
      version: input.scopeVersion,
      revision: input.scopeRevision,
      sha256: input.scopeSha256,
    },
    artifacts,
    conditional_paths: conditionalPaths,
  };
  const receiptId = publicSyncReceiptId(payload);
  const receipt: PublicSyncReceipt = { ...payload, receipt_id: receiptId };
  const receiptPath = publicSyncReceiptRelativePath(receiptId);
  const absoluteReceiptPath = path.join(input.dataRoot, receiptPath);
  try {
    await atomicWriteJson(absoluteReceiptPath, receipt);
    const identity = await fileIdentity(input.dataRoot, receiptPath);
    return {
      receipt,
      receipt_path: receiptPath,
      receipt_sha256: identity.sha256,
      receipt_git_blob_oid: identity.git_blob_oid,
      receipt_size_bytes: identity.size_bytes,
    };
  } catch (error) {
    await fs.rm(absoluteReceiptPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

export function publicSyncReceiptCommitMessage(input: {
  message: string;
  taskId: string;
  receiptPath: string;
  receiptSha256: string;
  receiptGitBlobOid: string;
}): string {
  const subject = input.message.trim();
  if (!subject) throw new Error("Public sync commit message is required");
  return [
    subject,
    "",
    `${PUBLIC_SYNC_RECEIPT_TRAILERS.taskId}: ${input.taskId}`,
    `${PUBLIC_SYNC_RECEIPT_TRAILERS.path}: ${normalizedRelativePath(input.receiptPath)}`,
    `${PUBLIC_SYNC_RECEIPT_TRAILERS.sha256}: ${input.receiptSha256}`,
    `${PUBLIC_SYNC_RECEIPT_TRAILERS.blobOid}: ${input.receiptGitBlobOid}`,
  ].join("\n");
}
