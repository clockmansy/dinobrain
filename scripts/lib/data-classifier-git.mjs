import { execFileSync } from "node:child_process";

import {
  DATA_CLASSIFICATION_POLICY_VERSION,
  PUBLIC_DATA_MAX_SCAN_BYTES,
  classifyDataFile,
} from "../../dist/data-classification.js";

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

export function classifyStagedGitFiles(repo) {
  const entries = rawDiffEntries(
    textGit(repo, ["diff", "--cached", "--raw", "--full-index", "--abbrev=40", "-z", "--no-renames", "--diff-filter=ACM"]),
  );
  const results = classifyBlobEntries(repo, entries);
  return summarize("git_hook_pre_commit", results, { staged_paths: entries.length });
}

function revListForPush(repo, localSha, remoteSha) {
  if (!localSha || ZERO_SHA.test(localSha)) return [];
  if (remoteSha && !ZERO_SHA.test(remoteSha)) {
    return textGit(repo, ["rev-list", "--reverse", `${remoteSha}..${localSha}`]).split(/\r?\n/).filter(Boolean);
  }
  try {
    return textGit(repo, ["rev-list", "--reverse", localSha, "--not", "--remotes"]).split(/\r?\n/).filter(Boolean);
  } catch {
    return textGit(repo, ["rev-list", "--reverse", localSha]).split(/\r?\n/).filter(Boolean);
  }
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
    });
  }
  return entries;
}

function classifyBlobEntries(repo, entries) {
  const results = [];
  const regular = entries.filter((entry) => entry.fileKind === "file" && !ZERO_SHA.test(entry.hash));
  for (const entry of entries) {
    if (entry.fileKind !== "file") {
      results.push(classifyDataFile({ relativePath: entry.relativePath, content: null, sizeBytes: 0, fileKind: entry.fileKind }));
    } else if (ZERO_SHA.test(entry.hash)) {
      results.push(blockedResult(entry.relativePath, "git_blob_hash_unavailable"));
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
  for (const commit of uniqueCommits) {
    entries.push(
      ...rawDiffEntries(
        textGit(repo, [
          "diff-tree",
          "-m",
          "--root",
          "--no-commit-id",
          "--raw",
          "--full-index",
          "--abbrev=40",
          "-r",
          "-z",
          "--no-renames",
          "--diff-filter=ACM",
          commit,
        ]),
      ),
    );
  }
  const results = classifyBlobEntries(repo, entries);
  return summarize("git_hook_pre_push", results, {
    update_count: effectiveUpdates.length,
    commit_count: uniqueCommits.length,
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

export function classifyCompleteGitHistory(repo) {
  const objectPaths = parseObjectList(textGit(repo, ["rev-list", "--objects", "--all"]));
  const objectInfo = batchCheckObjects(repo, Array.from(objectPaths.keys()));
  const blobEntries = Array.from(objectInfo.entries()).filter(([, info]) => info.type === "blob");
  const results = [];
  const historicalModes = textGit(repo, ["log", "--all", "--format=", "--raw", "--no-renames"]);
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

  const riskResults = results.filter((entry) => entry.findings.length > 0);
  const report = summarize("public_data_full_history", riskResults, {
    history_object_count: objectPaths.size,
    history_blob_count: blobEntries.length,
    history_unique_blob_paths: results.length,
    history_risk_blob_paths: riskResults.length,
  });
  report.scanned_file_versions = results.length;
  return report;
}

export { DATA_CLASSIFICATION_POLICY_VERSION };
