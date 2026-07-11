import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  DATA_CLASSIFICATION_POLICY_VERSION,
  PUBLIC_DATA_MAX_SCAN_BYTES,
  classifyDataFile,
} from "../../dist/data-classification.js";
import {
  classifyCompleteGitHistory,
  classifyPrePushGitHistory,
  classifyStagedGitFiles,
} from "./data-classifier-git.mjs";

const SCHEMA = "public_data_history_migration_v1";
const ZERO_SHA = "0".repeat(40);
const TEXT_NAMES = new Set([".gitattributes", ".gitignore", "pre-commit", "pre-push"]);
const TEXT_EXTENSIONS = new Set([".csv", ".json", ".jsonl", ".md", ".ps1", ".sh", ".toml", ".tsv", ".txt", ".yaml", ".yml"]);

function git(repo, args, options = {}) {
  return execFileSync("git", ["-c", "core.longpaths=true", "-c", `safe.directory=${repo}`, "-C", repo, ...args], {
    encoding: options.encoding ?? "utf8",
    input: options.input,
    maxBuffer: options.maxBuffer ?? 128 * 1024 * 1024,
    stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    windowsHide: true,
  });
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function normalize(value) {
  return value.replace(/\\/g, "/").replace(/^\/+/, "");
}

function inside(root, candidate) {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(candidate);
  if (resolved !== resolvedRoot && !resolved.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error(`path_outside_migration_root:${resolved}`);
  }
  return resolved;
}

function atomicJson(target, value) {
  mkdirSync(path.dirname(target), { recursive: true });
  const temporary = `${target}.tmp-${process.pid}-${randomUUID()}`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  renameSync(temporary, target);
}

function filesUnder(root, current = root, result = []) {
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    const full = path.join(current, entry.name);
    if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile())) {
      throw new Error(`unsupported_snapshot_entry:${normalize(path.relative(root, full))}`);
    }
    if (entry.isDirectory()) filesUnder(root, full, result);
    else result.push(full);
  }
  return result;
}

function countReplacement(stats, key) {
  stats[key] = (stats[key] ?? 0) + 1;
  return "<machine-local-path>";
}

function sanitizeMachinePaths(text, stats) {
  let result = text.replace(
    /\b[A-Z]:\\+(?:Users\\+)(?:(?!\\+["'])[^"'\s])+/g,
    () => countReplacement(stats, "windows_user_path"),
  );
  result = result.replace(
    /\b[A-Z]:\\+(?:(?!\\+["'])[^"'\s])+/g,
    () => countReplacement(stats, "windows_drive_path"),
  );
  result = result.replace(/(^|[\s"'])\/(?:Users|home)\/[^"'\s]+/gm, (_match, prefix) => {
    stats.posix_user_path = (stats.posix_user_path ?? 0) + 1;
    return `${prefix}<machine-local-path>`;
  });
  return result;
}

function redactReviewWorklistValue(value, stats) {
  if (Array.isArray(value)) return value.map((entry) => redactReviewWorklistValue(entry, stats));
  if (!value || typeof value !== "object") return value;
  const source = value;
  const output = {};
  for (const [key, child] of Object.entries(source)) {
    if (key === "representative_claim") {
      output.representative_claim_sha256 = sha256(String(child));
      stats.review_claim_redacted = (stats.review_claim_redacted ?? 0) + 1;
      continue;
    }
    if (key === "candidate_paths" || key === "review_paths") {
      const entries = Array.isArray(child) ? child.map(String).sort() : [];
      const prefix = key === "candidate_paths" ? "candidate_paths" : "review_paths";
      output[`${prefix}_count`] = entries.length;
      output[`${prefix}_sha256`] = sha256(entries.join("\n"));
      stats[`${prefix}_redacted`] = (stats[`${prefix}_redacted`] ?? 0) + 1;
      continue;
    }
    output[key] = redactReviewWorklistValue(child, stats);
  }
  return output;
}

function sanitizeFile(relativePath, bytes) {
  const base = path.posix.basename(relativePath);
  const extension = path.posix.extname(relativePath).toLowerCase();
  if (!TEXT_NAMES.has(base) && !TEXT_EXTENSIONS.has(extension)) return { bytes, changed: false, reasons: {} };
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const reasons = {};
  let next = sanitizeMachinePaths(text, reasons);
  if (/^60_Operations\/review-worklists\/.+\.json$/.test(relativePath)) {
    const parsed = JSON.parse(next);
    next = `${JSON.stringify(redactReviewWorklistValue(parsed, reasons), null, 2)}\n`;
  }
  if (relativePath === ".gitignore" && !next.split(/\r?\n/).includes(".dino/generations/")) {
    next = `${next.replace(/\s*$/, "")}\n.dino/generations/\n`;
    reasons.ignore_runtime_generations = 1;
  }
  const output = Buffer.from(next, "utf8");
  return { bytes: output, changed: !output.equals(bytes), reasons };
}

function classifySnapshot(repo) {
  const blockers = [];
  let scanned = 0;
  for (const full of filesUnder(repo)) {
    if (normalize(path.relative(repo, full)).startsWith(".git/")) continue;
    const relativePath = normalize(path.relative(repo, full));
    const stat = lstatSync(full);
    const content = stat.size <= PUBLIC_DATA_MAX_SCAN_BYTES ? readFileSync(full) : null;
    const result = classifyDataFile({ relativePath, content, sizeBytes: stat.size, fileKind: "file" });
    scanned += 1;
    if (result.classification === "blocked") blockers.push(result);
  }
  return {
    ok: blockers.length === 0,
    scanned,
    blocker_count: blockers.length,
    blocker_examples: blockers.slice(0, 25).map((entry) => ({
      path: entry.path,
      policy: entry.policy,
      findings: entry.findings.map((finding) => finding.id),
    })),
  };
}

function readManifest(manifestPath) {
  const resolved = path.resolve(manifestPath);
  const manifest = JSON.parse(readFileSync(resolved, "utf8"));
  if (manifest.schema !== SCHEMA) throw new Error("unsupported_public_history_manifest");
  return { manifest, manifestPath: resolved };
}

function remoteHead(remote, branch) {
  const output = execFileSync("git", ["ls-remote", remote, `refs/heads/${branch}`], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  }).trim();
  return output ? output.split(/\s+/)[0] : null;
}

export function preparePublicDataHistoryMigration(options = {}) {
  const sourceRepo = path.resolve(options.sourceRepo ?? process.env.DINOBRAIN_DATA_DIR ?? path.resolve("..", "dinobrain-data"));
  const sourceRef = options.sourceRef ?? "origin/main";
  const branch = options.branch ?? "main";
  const outputRoot = path.resolve(
    options.outputRoot ?? path.join(process.env.LOCALAPPDATA ?? os.tmpdir(), "DinoBrain", "history-migrations"),
  );
  if (!existsSync(path.join(sourceRepo, ".git"))) throw new Error(`source_repo_not_found:${sourceRepo}`);
  mkdirSync(outputRoot, { recursive: true });

  const sourceHead = String(git(sourceRepo, ["rev-parse", `${sourceRef}^{commit}`])).trim();
  const sourceTree = String(git(sourceRepo, ["rev-parse", `${sourceHead}^{tree}`])).trim();
  const sourceStatusSha256 = sha256(git(sourceRepo, ["status", "--porcelain=v1", "-z"], { encoding: null }));
  const remote = String(git(sourceRepo, ["config", "--get", "remote.origin.url"])).trim();
  const id = `public-history-${new Date().toISOString().replace(/[-:.TZ]/g, "")}-${randomUUID()}`;
  const migrationRoot = inside(outputRoot, path.join(outputRoot, id));
  const backupRepo = inside(migrationRoot, path.join(migrationRoot, "backup.git"));
  const bundlePath = inside(migrationRoot, path.join(migrationRoot, "before-rewrite.bundle"));
  const sanitizedRepo = inside(migrationRoot, path.join(migrationRoot, "sanitized-repo"));
  mkdirSync(migrationRoot, { recursive: false });

  execFileSync("git", ["-c", "core.longpaths=true", "clone", "--mirror", "--no-local", sourceRepo, backupRepo], {
    stdio: "pipe",
    windowsHide: true,
  });
  git(backupRepo, ["bundle", "create", bundlePath, "--all"]);
  git(backupRepo, ["bundle", "verify", bundlePath]);
  execFileSync("git", ["-c", "core.longpaths=true", "clone", "--no-local", sourceRepo, sanitizedRepo], {
    stdio: "pipe",
    windowsHide: true,
  });
  git(sanitizedRepo, ["checkout", "--detach", sourceHead]);
  const sourceHistory = classifyCompleteGitHistory(sanitizedRepo);

  const oldGit = inside(migrationRoot, path.join(sanitizedRepo, ".git"));
  rmSync(oldGit, { recursive: true, force: false });

  const changes = [];
  const reasonCounts = {};
  for (const full of filesUnder(sanitizedRepo)) {
    const relativePath = normalize(path.relative(sanitizedRepo, full));
    const before = readFileSync(full);
    const result = sanitizeFile(relativePath, before);
    if (!result.changed) continue;
    writeFileSync(full, result.bytes);
    for (const [reason, count] of Object.entries(result.reasons)) reasonCounts[reason] = (reasonCounts[reason] ?? 0) + count;
    changes.push({
      path: relativePath,
      before_sha256: sha256(before),
      after_sha256: sha256(result.bytes),
      before_bytes: before.length,
      after_bytes: result.bytes.length,
      reasons: result.reasons,
    });
  }

  const snapshot = classifySnapshot(sanitizedRepo);
  if (!snapshot.ok) throw new Error(`sanitized_snapshot_blocked:${JSON.stringify(snapshot.blocker_examples)}`);
  git(sanitizedRepo, ["init", "-b", branch]);
  git(sanitizedRepo, ["config", "user.name", "DinoBrain Public Data Migration"]);
  git(sanitizedRepo, ["config", "user.email", "dinobrain-migration@example.invalid"]);
  git(sanitizedRepo, ["add", "-A"]);
  const staged = classifyStagedGitFiles(sanitizedRepo);
  if (!staged.ok) throw new Error(`sanitized_staged_tree_blocked:${JSON.stringify(staged.blocker_examples)}`);
  git(sanitizedRepo, ["commit", "-m", `chore: establish public-safe data baseline from ${sourceHead.slice(0, 12)}`]);
  const sanitizedHead = String(git(sanitizedRepo, ["rev-parse", "HEAD"])).trim();
  const sanitizedTree = String(git(sanitizedRepo, ["rev-parse", "HEAD^{tree}"])).trim();
  if (remote) git(sanitizedRepo, ["remote", "add", "origin", remote]);
  const history = classifyCompleteGitHistory(sanitizedRepo);
  const prePush = classifyPrePushGitHistory(
    sanitizedRepo,
    `refs/heads/${branch} ${sanitizedHead} refs/heads/${branch} ${ZERO_SHA}\n`,
  );
  if (!history.ok || !prePush.ok) {
    throw new Error(`sanitized_history_blocked:${JSON.stringify({ history, prePush })}`);
  }

  const manifestPath = inside(migrationRoot, path.join(migrationRoot, "manifest.json"));
  const manifest = {
    schema: SCHEMA,
    policy_version: DATA_CLASSIFICATION_POLICY_VERSION,
    migration_id: id,
    status: "prepared",
    generated_at: new Date().toISOString(),
    source: {
      repository: sourceRepo,
      ref: sourceRef,
      branch,
      remote,
      head: sourceHead,
      tree: sourceTree,
      worktree_status_sha256: sourceStatusSha256,
      history: sourceHistory,
    },
    sanitized: {
      repository: sanitizedRepo,
      head: sanitizedHead,
      tree: sanitizedTree,
      snapshot,
      staged,
      history,
      pre_push: prePush,
    },
    backup: {
      repository: backupRepo,
      bundle_path: bundlePath,
      bundle_sha256: sha256(readFileSync(bundlePath)),
      original_branch_ref: `refs/heads/${branch}`,
    },
    mutation: {
      changed_file_count: changes.length,
      reason_counts: reasonCounts,
      files: changes,
    },
    apply: null,
    rollback: null,
  };
  atomicJson(manifestPath, manifest);
  return { manifest, manifestPath };
}

export function applyPublicDataHistoryMigration(manifestPath, confirmSourceHead) {
  const loaded = readManifest(manifestPath);
  const manifest = loaded.manifest;
  if (manifest.status !== "prepared" && manifest.status !== "rolled_back") throw new Error(`migration_not_prepared:${manifest.status}`);
  if (confirmSourceHead !== manifest.source.head) throw new Error("source_head_confirmation_mismatch");
  const sanitizedRepo = path.resolve(manifest.sanitized.repository);
  if (String(git(sanitizedRepo, ["rev-parse", "HEAD"])).trim() !== manifest.sanitized.head) {
    throw new Error("sanitized_head_drift");
  }
  if (String(git(sanitizedRepo, ["status", "--porcelain=v1"])).trim()) throw new Error("sanitized_repo_dirty");
  if (!classifyCompleteGitHistory(sanitizedRepo).ok) throw new Error("sanitized_history_recheck_failed");
  const branch = manifest.source.branch;
  const before = remoteHead(manifest.source.remote, branch);
  if (before !== manifest.source.head) throw new Error(`remote_source_head_drift:${before ?? "missing"}`);
  git(sanitizedRepo, [
    "push",
    `--force-with-lease=refs/heads/${branch}:${manifest.source.head}`,
    "origin",
    `HEAD:refs/heads/${branch}`,
  ]);
  const after = remoteHead(manifest.source.remote, branch);
  if (after !== manifest.sanitized.head) throw new Error(`remote_sanitized_head_mismatch:${after ?? "missing"}`);
  manifest.status = "applied";
  manifest.apply = { applied_at: new Date().toISOString(), remote_before: before, remote_after: after, force_with_lease: true };
  atomicJson(loaded.manifestPath, manifest);
  return { manifest, manifestPath: loaded.manifestPath };
}

export function rollbackPublicDataHistoryMigration(manifestPath, confirmSanitizedHead) {
  const loaded = readManifest(manifestPath);
  const manifest = loaded.manifest;
  if (manifest.status !== "applied") throw new Error(`migration_not_applied:${manifest.status}`);
  if (confirmSanitizedHead !== manifest.sanitized.head) throw new Error("sanitized_head_confirmation_mismatch");
  const branch = manifest.source.branch;
  const before = remoteHead(manifest.source.remote, branch);
  if (before !== manifest.sanitized.head) throw new Error(`remote_sanitized_head_drift:${before ?? "missing"}`);
  git(path.resolve(manifest.backup.repository), [
    "push",
    `--force-with-lease=refs/heads/${branch}:${manifest.sanitized.head}`,
    manifest.source.remote,
    `refs/heads/${branch}:refs/heads/${branch}`,
  ]);
  const after = remoteHead(manifest.source.remote, branch);
  if (after !== manifest.source.head) throw new Error(`remote_rollback_head_mismatch:${after ?? "missing"}`);
  manifest.status = "rolled_back";
  manifest.rollback = { rolled_back_at: new Date().toISOString(), remote_before: before, remote_after: after, force_with_lease: true };
  atomicJson(loaded.manifestPath, manifest);
  return { manifest, manifestPath: loaded.manifestPath };
}

export { SCHEMA as PUBLIC_DATA_HISTORY_MIGRATION_SCHEMA };
