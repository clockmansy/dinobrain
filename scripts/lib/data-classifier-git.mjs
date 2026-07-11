import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import {
  DATA_CLASSIFICATION_POLICY_VERSION,
  PUBLIC_DATA_MAX_SCAN_BYTES,
  classifyDataFile,
} from "../../dist/data-classification.js";
import {
  PUBLIC_SYNC_RECEIPT_PATH_PATTERN,
  PUBLIC_SYNC_RECEIPT_TRAILERS,
  publicSyncReceiptRelativePath,
  validatePublicSyncReceipt,
} from "../../dist/public-sync-receipt.js";
import { taskSyncScopeRelativePath } from "../../dist/task-sync-scope.js";

const ZERO_SHA = /^0+$/;

function git(repo, args, options = {}) {
  return execFileSync("git", ["-c", `safe.directory=${repo}`, "-C", repo, ...args], {
    input: options.input,
    encoding: options.encoding,
    maxBuffer: options.maxBuffer ?? 64 * 1024 * 1024,
    stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    windowsHide: true,
  });
}

function textGit(repo, args, options = {}) {
  return String(git(repo, args, { ...options, encoding: "utf8" }));
}

function splitZ(value) {
  return String(value).split("\0").filter(Boolean);
}

function normalizePath(value) {
  return value.replace(/\\/g, "/").replace(/^\/+/, "");
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function blockedResult(relativePath, id, detail = null) {
  const result = classifyDataFile({ relativePath, content: null, sizeBytes: 0, scanContent: false });
  result.classification = "blocked";
  result.policy = id;
  result.findings = [{ id, category: "decode", severity: "blocker", ...(detail ? { detail } : {}) }];
  result.reasons = Array.from(new Set([...result.reasons, id]));
  result.scan.complete = false;
  return result;
}

function summarize(surface, results, extra = {}) {
  const blockers = results.filter((entry) => entry.classification === "blocked");
  const conditional = results.filter((entry) => entry.classification === "conditional");
  const syncable = results.filter((entry) => entry.classification === "syncable");
  const findingCounts = {};
  for (const result of results) {
    for (const finding of result.findings) findingCounts[finding.id] = (findingCounts[finding.id] ?? 0) + 1;
  }
  return {
    ok: blockers.length === 0,
    policy_version: DATA_CLASSIFICATION_POLICY_VERSION,
    surface,
    scanned_file_versions: results.length,
    summary: {
      syncable: syncable.length,
      conditional: conditional.length,
      blocked: blockers.length,
      complete_scans: results.filter((entry) => entry.scan.complete).length,
      incomplete_scans: results.filter((entry) => !entry.scan.complete).length,
    },
    finding_counts: findingCounts,
    blocker_examples: blockers.slice(0, 25).map(redactedResult),
    conditional_examples: conditional.slice(0, 25).map(redactedResult),
    ...extra,
  };
}

function redactedResult(result) {
  return {
    path: result.path,
    classification: result.classification,
    policy: result.policy,
    explicit_allowlist: result.explicit_allowlist,
    findings: result.findings.map((finding) => ({
      id: finding.id,
      category: finding.category,
      severity: finding.severity,
      ...(finding.line ? { line: finding.line } : {}),
    })),
    scan: result.scan,
  };
}

function modeToFileKind(mode) {
  if (mode === "120000") return "symlink";
  if (mode === "160000") return "other";
  return mode === "100644" || mode === "100755" ? "file" : "other";
}

function gitFileKind(repo, spec, relativePath) {
  try {
    const output = spec.startsWith(":")
      ? textGit(repo, ["ls-files", "--stage", "--", relativePath]).trim()
      : textGit(repo, ["ls-tree", spec.slice(0, spec.indexOf(":")), "--", relativePath]).trim();
    return modeToFileKind(output.split(/\s+/)[0] ?? "");
  } catch {
    return "other";
  }
}

function classifyGitBlob(repo, spec, relativePath) {
  const fileKind = gitFileKind(repo, spec, relativePath);
  if (fileKind !== "file") {
    return classifyDataFile({ relativePath, content: null, sizeBytes: 0, fileKind });
  }
  let size = 0;
  try {
    size = Number(textGit(repo, ["cat-file", "-s", spec]).trim());
  } catch (error) {
    return blockedResult(relativePath, "git_blob_size_unavailable", String(error.message).slice(0, 200));
  }
  if (!Number.isFinite(size) || size < 0 || size > PUBLIC_DATA_MAX_SCAN_BYTES) {
    return classifyDataFile({ relativePath, content: null, sizeBytes: size, maxScanBytes: PUBLIC_DATA_MAX_SCAN_BYTES, fileKind });
  }
  try {
    const content = git(repo, ["show", spec], { encoding: null, maxBuffer: PUBLIC_DATA_MAX_SCAN_BYTES + 1024 * 1024 });
    return classifyDataFile({ relativePath, content, sizeBytes: size, fileKind });
  } catch (error) {
    return blockedResult(relativePath, "git_blob_unreadable", String(error.message).slice(0, 200));
  }
}

export function classifyStagedGitFiles(repo, options = {}) {
  const entries = rawDiffEntries(
    textGit(repo, ["diff", "--cached", "--raw", "--full-index", "--abbrev=40", "-z", "--no-renames", "--diff-filter=ACMD"]),
  );
  const results = classifyBlobEntries(repo, entries);
  let baseCommit = "0".repeat(40);
  try {
    baseCommit = textGit(repo, ["rev-parse", "HEAD"]).trim();
  } catch {
    // A new repository has no HEAD yet. Conditional root content still requires a receipt.
  }
  const receiptValidation = validatePublicSyncReceiptEntries(repo, entries, results, {
    baseCommit,
    requireCommitTrailers: false,
    requireLocalScope: true,
    rootBaseline: options.allowRootBaseline === true && baseCommit === "0".repeat(40),
  });
  results.push(...receiptValidation.blockers);
  return summarize("git_hook_pre_commit", results, {
    staged_paths: entries.length,
    public_sync_receipts: receiptValidation.summary,
  });
}

function revListForPush(repo, localSha, remoteSha) {
  if (!localSha || ZERO_SHA.test(localSha)) return [];
  if (remoteSha && !ZERO_SHA.test(remoteSha)) {
    return textGit(repo, ["rev-list", "--reverse", `${remoteSha}..${localSha}`]).split(/\r?\n/).filter(Boolean);
  }
  return textGit(repo, ["rev-list", "--reverse", localSha]).split(/\r?\n/).filter(Boolean);
}

export function parsePrePushLines(stdinText) {
  return String(stdinText || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [local_ref, local_sha, remote_ref, remote_sha] = line.split(/\s+/);
      return { local_ref, local_sha, remote_ref, remote_sha };
    })
    .filter((entry) => entry.local_sha && entry.remote_sha);
}

function rawDiffEntries(value) {
  const tokens = splitZ(value);
  const entries = [];
  for (let index = 0; index < tokens.length; index += 2) {
    const header = tokens[index];
    const relativePath = tokens[index + 1];
    const match = header?.match(/^:(\d{6})\s+(\d{6})\s+([0-9a-f]+)\s+([0-9a-f]+)\s+([A-Z])$/i);
    if (!match || !relativePath) throw new Error(`Unexpected raw diff entry: ${header ?? "missing"}`);
    entries.push({
      hash: match[4],
      relativePath: normalizePath(relativePath),
      fileKind: modeToFileKind(match[2]),
      status: match[5].toUpperCase(),
    });
  }
  return entries;
}

function commitParents(repo, commit) {
  const tokens = textGit(repo, ["rev-list", "--parents", "-n", "1", commit]).trim().split(/\s+/).filter(Boolean);
  if (tokens[0] !== commit) throw new Error(`Unable to resolve commit parents: ${commit}`);
  return tokens.slice(1);
}

function commitDiffEntries(repo, commit) {
  const parents = commitParents(repo, commit);
  const args = parents.length === 0
    ? ["diff-tree", "--root", "--no-commit-id"]
    : ["diff-tree", "--no-commit-id"];
  args.push("--raw", "--full-index", "--abbrev=40", "-r", "-z", "--no-renames", "--diff-filter=ACMD");
  if (parents.length === 0) args.push(commit);
  else args.push(parents[0], commit);
  return { parents, entries: rawDiffEntries(textGit(repo, args)) };
}

function blobBytes(repo, hash) {
  return git(repo, ["cat-file", "blob", hash], {
    encoding: null,
    maxBuffer: PUBLIC_DATA_MAX_SCAN_BYTES + 1024 * 1024,
  });
}

function trailerValues(message, key) {
  const pattern = new RegExp(`^${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:\\s*(.+?)\\s*$`, "gm");
  return Array.from(String(message).matchAll(pattern)).map((match) => match[1]);
}

function receiptBlocker(relativePath, id, detail = null) {
  return blockedResult(relativePath || "(public-sync-receipt)", id, detail);
}

function validateLocalScope(repo, receipt) {
  const errors = [];
  const scopeRelative = taskSyncScopeRelativePath(receipt.task_id);
  const scopePath = path.join(repo, scopeRelative);
  if (!existsSync(scopePath)) return ["public_sync_local_scope_missing"];
  let raw;
  let scope;
  try {
    raw = readFileSync(scopePath);
    scope = JSON.parse(raw.toString("utf8"));
  } catch {
    return ["public_sync_local_scope_unreadable"];
  }
  if (sha256(raw) !== receipt.scope.sha256) errors.push("public_sync_local_scope_hash_mismatch");
  if (scope.version !== receipt.scope.version) errors.push("public_sync_local_scope_version_mismatch");
  if (scope.revision !== receipt.scope.revision) errors.push("public_sync_local_scope_revision_mismatch");
  if (scope.task_id !== receipt.task_id || scope.task_path !== receipt.task_record_path) {
    errors.push("public_sync_local_scope_task_mismatch");
  }
  const scopeEntries = new Map((Array.isArray(scope.entries) ? scope.entries : []).map((entry) => [entry.path, entry]));
  for (const artifact of receipt.artifacts) {
    const entry = scopeEntries.get(artifact.path);
    if (
      !entry ||
      entry.sha256 !== artifact.sha256 ||
      entry.git_blob_oid !== artifact.git_blob_oid ||
      entry.size_bytes !== artifact.size_bytes ||
      entry.approval !== artifact.approval ||
      entry.source !== artifact.source
    ) {
      errors.push(`public_sync_local_scope_artifact_mismatch:${artifact.path}`);
    }
  }
  return errors;
}

function validatePublicSyncReceiptEntries(repo, entries, results, options) {
  const receiptEntries = entries.filter((entry) => PUBLIC_SYNC_RECEIPT_PATH_PATTERN.test(entry.relativePath));
  const artifactEntries = entries.filter((entry) => !PUBLIC_SYNC_RECEIPT_PATH_PATTERN.test(entry.relativePath));
  const resultsByPath = new Map(results.map((result) => [result.path, result]));
  const conditionalEntries = artifactEntries.filter(
    (entry) => resultsByPath.get(entry.relativePath)?.classification === "conditional",
  );
  const errors = [];

  if (conditionalEntries.length === 0) {
    if (receiptEntries.length > 0) errors.push("public_sync_receipt_without_conditional_artifact");
    return {
      blockers: errors.map((id) => receiptBlocker(receiptEntries[0]?.relativePath, id)),
      summary: {
        required: false,
        conditional_path_count: 0,
        receipt_count: receiptEntries.length,
        verified: errors.length === 0,
        root_baseline_exempt: false,
        errors,
      },
    };
  }

  if (options.rootBaseline === true) {
    return {
      blockers: [],
      summary: {
        required: false,
        conditional_path_count: conditionalEntries.length,
        receipt_count: receiptEntries.length,
        verified: true,
        root_baseline_exempt: true,
        errors: [],
      },
    };
  }

  if (receiptEntries.length !== 1) errors.push("public_sync_receipt_count_invalid");
  if (conditionalEntries.some((entry) => ZERO_SHA.test(entry.hash))) {
    errors.push("public_sync_conditional_deletion_not_supported");
  }
  let receipt = null;
  let receiptBytes = null;
  const receiptEntry = receiptEntries[0] ?? null;
  if (receiptEntry) {
    try {
      receiptBytes = blobBytes(repo, receiptEntry.hash);
      const validation = validatePublicSyncReceipt(JSON.parse(receiptBytes.toString("utf8")));
      if (!validation.ok) errors.push(...validation.errors.map((error) => `public_sync_${error}`));
      receipt = validation.receipt;
    } catch (error) {
      errors.push(`public_sync_receipt_unreadable:${String(error.message).slice(0, 120)}`);
    }
  }

  if (receipt && receiptEntry && receiptBytes) {
    const expectedReceiptPath = publicSyncReceiptRelativePath(receipt.receipt_id);
    if (receiptEntry.relativePath !== expectedReceiptPath) errors.push("public_sync_receipt_filename_mismatch");
    if (receipt.base_commit !== options.baseCommit) errors.push("public_sync_receipt_base_commit_mismatch");
    const artifactMap = new Map(receipt.artifacts.map((artifact) => [artifact.path, artifact]));
    const expectedPaths = artifactEntries.map((entry) => entry.relativePath).sort();
    const receiptedPaths = receipt.artifacts.map((artifact) => artifact.path).sort();
    if (expectedPaths.join("\n") !== receiptedPaths.join("\n")) errors.push("public_sync_receipt_artifact_set_mismatch");
    for (const entry of artifactEntries) {
      const artifact = artifactMap.get(entry.relativePath);
      const classification = resultsByPath.get(entry.relativePath);
      let bytes = null;
      try {
        bytes = blobBytes(repo, entry.hash);
      } catch {
        errors.push(`public_sync_receipt_artifact_unreadable:${entry.relativePath}`);
        continue;
      }
      if (
        !artifact ||
        artifact.git_blob_oid !== entry.hash ||
        artifact.sha256 !== sha256(bytes) ||
        artifact.size_bytes !== bytes.length ||
        artifact.classification !== classification?.classification ||
        artifact.policy !== classification?.policy
      ) {
        errors.push(`public_sync_receipt_artifact_identity_mismatch:${entry.relativePath}`);
      }
    }
    const taskEntry = artifactEntries.find((entry) => entry.relativePath === receipt.task_record_path);
    if (!taskEntry) {
      errors.push("public_sync_receipt_task_record_not_committed");
    } else {
      try {
        const taskBytes = blobBytes(repo, taskEntry.hash);
        const taskRecord = JSON.parse(taskBytes.toString("utf8"));
        if (
          taskRecord.task_id !== receipt.task_id ||
          taskRecord.request_hash !== receipt.task_request_hash ||
          sha256(taskBytes) !== receipt.task_record_sha256
        ) {
          errors.push("public_sync_receipt_task_record_binding_mismatch");
        }
      } catch {
        errors.push("public_sync_receipt_task_record_unreadable");
      }
    }
    if (options.requireLocalScope) errors.push(...validateLocalScope(repo, receipt));
    if (options.requireCommitTrailers) {
      const message = textGit(repo, ["show", "-s", "--format=%B", options.commit]);
      const expectedTrailers = [
        [PUBLIC_SYNC_RECEIPT_TRAILERS.taskId, receipt.task_id],
        [PUBLIC_SYNC_RECEIPT_TRAILERS.path, receiptEntry.relativePath],
        [PUBLIC_SYNC_RECEIPT_TRAILERS.sha256, sha256(receiptBytes)],
        [PUBLIC_SYNC_RECEIPT_TRAILERS.blobOid, receiptEntry.hash],
      ];
      for (const [key, expected] of expectedTrailers) {
        const values = trailerValues(message, key);
        if (values.length !== 1 || values[0] !== expected) errors.push(`public_sync_commit_trailer_invalid:${key}`);
      }
    }
  }

  const uniqueErrors = Array.from(new Set(errors));
  return {
    blockers: uniqueErrors.map((id) => receiptBlocker(receiptEntry?.relativePath ?? conditionalEntries[0]?.relativePath, id)),
    summary: {
      required: true,
      conditional_path_count: conditionalEntries.length,
      receipt_count: receiptEntries.length,
      verified: uniqueErrors.length === 0,
      root_baseline_exempt: false,
      receipt_path: receiptEntry?.relativePath ?? null,
      receipt_id: receipt?.receipt_id ?? null,
      errors: uniqueErrors,
    },
  };
}

function validateCommitPublicSyncReceipt(repo, commit) {
  const { parents, entries } = commitDiffEntries(repo, commit);
  const results = classifyBlobEntries(repo, entries);
  const validation = validatePublicSyncReceiptEntries(repo, entries, results, {
    baseCommit: parents[0] ?? "0".repeat(40),
    commit,
    requireCommitTrailers: parents.length > 0,
    requireLocalScope: false,
    rootBaseline: parents.length === 0,
  });
  if (parents.length > 1 && validation.summary.conditional_path_count > 0) {
    validation.summary.errors.push("public_sync_merge_commit_not_supported");
    validation.summary.verified = false;
    validation.blockers.push(receiptBlocker(validation.summary.receipt_path, "public_sync_merge_commit_not_supported"));
  }
  return { results, validation };
}

function treeEntries(value) {
  return splitZ(value).map((token) => {
    const match = token.match(/^(\d{6})\s+(\w+)\s+([0-9a-f]+)\t([\s\S]+)$/i);
    if (!match) throw new Error(`Unexpected tree entry: ${token.slice(0, 160)}`);
    return {
      hash: match[3],
      relativePath: normalizePath(match[4]),
      fileKind: modeToFileKind(match[1]),
    };
  });
}

function classifyBlobEntries(repo, entries) {
  const results = [];
  const regular = entries.filter((entry) => entry.fileKind === "file" && !ZERO_SHA.test(entry.hash));
  for (const entry of entries) {
    if (ZERO_SHA.test(entry.hash)) {
      results.push(classifyDataFile({ relativePath: entry.relativePath, content: null, sizeBytes: 0, deleted: true }));
    } else if (entry.fileKind !== "file") {
      results.push(classifyDataFile({ relativePath: entry.relativePath, content: null, sizeBytes: 0, fileKind: entry.fileKind }));
    }
  }

  const hashes = Array.from(new Set(regular.map((entry) => entry.hash)));
  const objectInfo = batchCheckObjects(repo, hashes);
  const readable = [];
  for (const hash of hashes) {
    const info = objectInfo.get(hash);
    if (!info || info.type !== "blob" || !Number.isFinite(info.size) || info.size < 0) continue;
    if (info.size <= PUBLIC_DATA_MAX_SCAN_BYTES) readable.push({ hash, size: info.size });
  }

  const contents = new Map();
  let batch = [];
  let batchBytes = 0;
  const flush = () => {
    if (batch.length === 0) return;
    for (const [hash, content] of batchReadBlobs(repo, batch.map((entry) => entry.hash), batchBytes)) contents.set(hash, content);
    batch = [];
    batchBytes = 0;
  };
  for (const entry of readable) {
    if (batch.length >= 128 || batchBytes + entry.size > 16 * 1024 * 1024) flush();
    batch.push(entry);
    batchBytes += entry.size;
  }
  flush();

  for (const entry of regular) {
    const info = objectInfo.get(entry.hash);
    if (!info || info.type !== "blob" || !Number.isFinite(info.size) || info.size < 0) {
      results.push(blockedResult(entry.relativePath, "git_blob_metadata_unavailable"));
      continue;
    }
    const content = contents.get(entry.hash) ?? null;
    results.push(
      classifyDataFile({
        relativePath: entry.relativePath,
        content,
        sizeBytes: info.size,
        maxScanBytes: PUBLIC_DATA_MAX_SCAN_BYTES,
        fileKind: "file",
      }),
    );
  }
  return results;
}

export function classifyPrePushGitHistory(repo, stdinText) {
  const updates = parsePrePushLines(stdinText);
  let fallbackParent = "0".repeat(40);
  if (updates.length === 0) {
    try {
      fallbackParent = textGit(repo, ["rev-parse", "HEAD^"]).trim();
    } catch {
      // A root commit has no parent; scan the complete local branch as a new push.
    }
  }
  const effectiveUpdates = updates.length > 0
    ? updates
    : [{ local_ref: "HEAD", local_sha: textGit(repo, ["rev-parse", "HEAD"]).trim(), remote_ref: "manual", remote_sha: fallbackParent }];
  const commits = [];
  for (const update of effectiveUpdates) commits.push(...revListForPush(repo, update.local_sha, update.remote_sha));
  const uniqueCommits = Array.from(new Set(commits));
  const entries = [];
  const receiptSummaries = [];
  const receiptBlockers = [];
  for (const commit of uniqueCommits) {
    const checked = validateCommitPublicSyncReceipt(repo, commit);
    const commitEntries = commitDiffEntries(repo, commit).entries;
    entries.push(...commitEntries);
    receiptBlockers.push(...checked.validation.blockers);
    receiptSummaries.push({ commit, ...checked.validation.summary });
  }
  const results = classifyBlobEntries(repo, entries);
  results.push(...receiptBlockers);
  return summarize("git_hook_pre_push", results, {
    update_count: effectiveUpdates.length,
    commit_count: uniqueCommits.length,
    public_sync_receipts: receiptSummaries,
  });
}

function parseObjectList(value) {
  const byHash = new Map();
  for (const line of String(value).split(/\r?\n/)) {
    if (!line) continue;
    const separator = line.indexOf(" ");
    const hash = separator < 0 ? line : line.slice(0, separator);
    const relativePath = separator < 0 ? "" : normalizePath(line.slice(separator + 1));
    if (!byHash.has(hash)) byHash.set(hash, new Set());
    if (relativePath) byHash.get(hash).add(relativePath);
  }
  return byHash;
}

function batchCheckObjects(repo, hashes) {
  if (hashes.length === 0) return new Map();
  const input = `${hashes.join("\n")}\n`;
  const output = textGit(repo, ["cat-file", "--batch-check=%(objectname) %(objecttype) %(objectsize)"], { input });
  const result = new Map();
  for (const line of output.split(/\r?\n/)) {
    const [hash, type, sizeText] = line.trim().split(/\s+/);
    if (hash) result.set(hash, { type, size: Number(sizeText) });
  }
  return result;
}

function batchReadBlobs(repo, hashes, expectedBytes) {
  if (hashes.length === 0) return new Map();
  const output = git(repo, ["cat-file", "--batch"], {
    input: Buffer.from(`${hashes.join("\n")}\n`, "utf8"),
    encoding: null,
    maxBuffer: Math.max(16 * 1024 * 1024, expectedBytes + hashes.length * 256 + 1024 * 1024),
  });
  const blobs = new Map();
  let offset = 0;
  for (const requestedHash of hashes) {
    const newline = output.indexOf(0x0a, offset);
    if (newline < 0) throw new Error(`Missing cat-file header for ${requestedHash}`);
    const header = output.subarray(offset, newline).toString("utf8");
    const [hash, type, sizeText] = header.split(/\s+/);
    const size = Number(sizeText);
    if (type !== "blob" || !Number.isFinite(size)) throw new Error(`Unexpected cat-file header: ${header}`);
    const start = newline + 1;
    const end = start + size;
    blobs.set(hash, output.subarray(start, end));
    offset = end + 1;
  }
  return blobs;
}

export function classifyCompleteGitHistory(repo, options = {}) {
  const revisions = Array.isArray(options.revisions) && options.revisions.length > 0 ? options.revisions : ["--all"];
  const objectPaths = parseObjectList(textGit(repo, ["rev-list", "--objects", ...revisions]));
  const objectInfo = batchCheckObjects(repo, Array.from(objectPaths.keys()));
  const blobEntries = Array.from(objectInfo.entries()).filter(([, info]) => info.type === "blob");
  const results = [];
  const historicalModes = textGit(repo, ["log", "--format=", "--raw", "--no-renames", ...revisions]);
  for (const line of historicalModes.split(/\r?\n/)) {
    const match = line.match(/^:\d{6}\s+(\d{6})\s+[0-9a-f]+\s+[0-9a-f]+\s+[A-Z]\s+(.+)$/i);
    if (!match) continue;
    const fileKind = modeToFileKind(match[1]);
    if (fileKind === "file" || match[1] === "000000") continue;
    results.push(classifyDataFile({ relativePath: normalizePath(match[2]), content: null, sizeBytes: 0, fileKind }));
  }
  const readable = [];
  for (const [hash, info] of blobEntries) {
    const paths = Array.from(objectPaths.get(hash) ?? []);
    if (paths.length === 0) continue;
    if (!Number.isFinite(info.size) || info.size > PUBLIC_DATA_MAX_SCAN_BYTES) {
      for (const relativePath of paths) {
        results.push(classifyDataFile({ relativePath, content: null, sizeBytes: info.size }));
      }
      continue;
    }
    readable.push({ hash, size: info.size, paths });
  }

  let batch = [];
  let batchBytes = 0;
  const flush = () => {
    if (batch.length === 0) return;
    const blobs = batchReadBlobs(repo, batch.map((entry) => entry.hash), batchBytes);
    for (const entry of batch) {
      const content = blobs.get(entry.hash);
      for (const relativePath of entry.paths) {
        results.push(classifyDataFile({ relativePath, content, sizeBytes: entry.size }));
      }
    }
    batch = [];
    batchBytes = 0;
  };

  for (const entry of readable) {
    if (batch.length >= 128 || batchBytes + entry.size > 16 * 1024 * 1024) flush();
    batch.push(entry);
    batchBytes += entry.size;
  }
  flush();

  const historyFileVersionCount = results.length;
  const commits = textGit(repo, ["rev-list", "--reverse", ...revisions]).split(/\r?\n/).filter(Boolean);
  const receiptSummaries = [];
  for (const commit of commits) {
    const checked = validateCommitPublicSyncReceipt(repo, commit);
    results.push(...checked.validation.blockers);
    receiptSummaries.push({ commit, ...checked.validation.summary });
  }
  const riskResults = results.filter((entry) => entry.findings.length > 0);
  const report = summarize("public_data_full_history", riskResults, {
    scanned_revisions: revisions,
    history_object_count: objectPaths.size,
    history_blob_count: blobEntries.length,
    history_unique_blob_paths: historyFileVersionCount,
    history_risk_blob_paths: riskResults.length,
    public_sync_receipts: {
      commits_checked: receiptSummaries.length,
      required_commits: receiptSummaries.filter((entry) => entry.required).length,
      verified_commits: receiptSummaries.filter((entry) => entry.required && entry.verified).length,
      root_baseline_exempt_commits: receiptSummaries.filter((entry) => entry.root_baseline_exempt).length,
      failures: receiptSummaries.filter((entry) => !entry.verified).slice(0, 25),
    },
  });
  report.scanned_file_versions = historyFileVersionCount;
  return report;
}

export function classifyGitTree(repo, revision = "HEAD") {
  const entries = treeEntries(textGit(repo, ["ls-tree", "-r", "-z", "--full-tree", revision]));
  const results = classifyBlobEntries(repo, entries);
  return {
    report: summarize("public_data_committed_tree", results, {
      revision,
      tree_entry_count: entries.length,
    }),
    results: results.map(redactedResult),
  };
}

export { DATA_CLASSIFICATION_POLICY_VERSION };
