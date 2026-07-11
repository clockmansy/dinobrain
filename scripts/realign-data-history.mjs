import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createReadStream } from "node:fs";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { atomicWriteJsonSync } from "./lib/atomic-files-sync.mjs";

function argValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

const jsonOnly = process.argv.includes("--json");

function git(repo, args, options = {}) {
  return execFileSync("git", ["-c", `safe.directory=${repo}`, "-C", repo, ...args], {
    encoding: options.encoding ?? "utf8",
    maxBuffer: options.maxBuffer ?? 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
}

function splitZ(value) {
  return String(value).split("\0").filter(Boolean);
}

function toSlash(value) {
  return value.replace(/\\/g, "/");
}

function stamp() {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function hashFile(filePath) {
  const before = await fs.stat(filePath);
  const hash = createHash("sha256");
  await new Promise((resolve, reject) => {
    const stream = createReadStream(filePath, { highWaterMark: 1024 * 1024 });
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolve);
  });
  const after = await fs.stat(filePath);
  if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
    throw new Error(`worktree_changed_during_snapshot:${filePath}`);
  }
  return { size: after.size, sha256: hash.digest("hex") };
}

async function snapshotWorktree(dataRoot) {
  const entries = [];
  let totalBytes = 0;

  async function walk(directory, relativeDirectory = "") {
    const handle = await fs.opendir(directory);
    for await (const entry of handle) {
      if (!relativeDirectory && entry.name === ".git") continue;
      const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      const fullPath = path.join(directory, entry.name);
      const stat = await fs.lstat(fullPath);
      if (stat.isDirectory()) {
        await walk(fullPath, relativePath);
        continue;
      }
      if (stat.isSymbolicLink()) {
        const target = await fs.readlink(fullPath);
        const targetBytes = Buffer.from(target, "utf8");
        entries.push({ path: toSlash(relativePath), type: "symlink", size: targetBytes.length, sha256: sha256(targetBytes) });
        totalBytes += targetBytes.length;
        continue;
      }
      if (!stat.isFile()) {
        entries.push({ path: toSlash(relativePath), type: "other", size: 0, sha256: null });
        continue;
      }
      const hashed = await hashFile(fullPath);
      entries.push({ path: toSlash(relativePath), type: "file", ...hashed });
      totalBytes += hashed.size;
    }
  }

  await walk(dataRoot);
  entries.sort((left, right) => left.path.localeCompare(right.path));
  const aggregate = createHash("sha256");
  for (const entry of entries) {
    aggregate.update(`${entry.path}\0${entry.type}\0${entry.size}\0${entry.sha256 ?? ""}\n`);
  }
  return {
    file_count: entries.length,
    total_bytes: totalBytes,
    aggregate_sha256: aggregate.digest("hex"),
    entries,
  };
}

function snapshotSummary(snapshot) {
  return {
    file_count: snapshot.file_count,
    total_bytes: snapshot.total_bytes,
    aggregate_sha256: snapshot.aggregate_sha256,
  };
}

async function writeJsonAtomic(filePath, value) {
  atomicWriteJsonSync(filePath, value);
}

async function renameWithRetry(source, destination) {
  let lastError = null;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      await fs.rename(source, destination);
      return;
    } catch (error) {
      lastError = error;
      if (!["EACCES", "EBUSY", "EPERM"].includes(error.code)) throw error;
      await new Promise((resolve) => setTimeout(resolve, Math.min(250, 20 + attempt * 15)));
    }
  }
  throw lastError ?? new Error(`could_not_replace:${destination}`);
}

async function atomicRestoreFile(source, destination) {
  const bytes = await fs.readFile(source);
  const tempPath = path.join(path.dirname(destination), `.${path.basename(destination)}.${process.pid}.${randomUUID()}.tmp`);
  const handle = await fs.open(tempPath, "wx");
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await renameWithRetry(tempPath, destination);
  } finally {
    await fs.rm(tempPath, { force: true });
  }
}

async function withMaintenanceLock(evidenceRoot, operation) {
  await fs.mkdir(evidenceRoot, { recursive: true });
  const lockPath = path.join(evidenceRoot, ".local-history-realignment.lock");
  const handle = await fs.open(lockPath, "wx");
  try {
    await handle.writeFile(`${JSON.stringify({ pid: process.pid, acquired_at: new Date().toISOString() })}\n`);
    await handle.sync();
    return await operation();
  } finally {
    await handle.close();
    await fs.rm(lockPath, { force: true });
  }
}

function ensureOutsideDataRoot(dataRoot, evidenceRoot) {
  const relative = path.relative(dataRoot, evidenceRoot);
  if (!relative || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
    throw new Error("evidence_root_must_be_outside_data_root");
  }
}

function stagedPaths(dataRoot) {
  return splitZ(git(dataRoot, ["diff", "--cached", "--name-only", "-z"])).map(toSlash).sort();
}

function statusDigest(dataRoot) {
  return sha256(git(dataRoot, ["status", "--porcelain=v2", "-z", "--untracked-files=all"]));
}

function resolveCommit(dataRoot, ref) {
  return git(dataRoot, ["rev-parse", `${ref}^{commit}`]).trim();
}

function currentBranch(dataRoot) {
  try {
    return git(dataRoot, ["symbolic-ref", "--quiet", "--short", "HEAD"]).trim();
  } catch {
    throw new Error("detached_HEAD_not_supported_for_realignment");
  }
}

function gitDirectory(dataRoot) {
  return path.resolve(dataRoot, git(dataRoot, ["rev-parse", "--git-dir"]).trim());
}

async function assertRepositoryReady(dataRoot) {
  const gitDir = gitDirectory(dataRoot);
  const conflictMarkers = [
    "index.lock",
    "MERGE_HEAD",
    "CHERRY_PICK_HEAD",
    "REVERT_HEAD",
    "BISECT_LOG",
    "rebase-apply",
    "rebase-merge",
  ];
  for (const marker of conflictMarkers) {
    try {
      await fs.access(path.join(gitDir, marker));
      throw new Error(`git_operation_in_progress:${marker}`);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  const worktreeCount = git(dataRoot, ["worktree", "list", "--porcelain"])
    .split(/\r?\n/)
    .filter((line) => line.startsWith("worktree ")).length;
  if (worktreeCount !== 1) throw new Error(`linked_worktrees_not_supported:${worktreeCount}`);
  return gitDir;
}

function remoteHeadForTarget(dataRoot, targetRef) {
  const separator = targetRef.indexOf("/");
  if (separator <= 0) return null;
  const remote = targetRef.slice(0, separator);
  const branch = targetRef.slice(separator + 1);
  const remotes = git(dataRoot, ["remote"]).split(/\r?\n/).filter(Boolean);
  if (!remotes.includes(remote)) return null;
  const line = git(dataRoot, ["ls-remote", remote, `refs/heads/${branch}`]).trim();
  const remoteHead = line.split(/\s+/)[0] || null;
  if (!remoteHead) throw new Error(`remote_branch_not_found:${targetRef}`);
  return remoteHead;
}

async function applyRealignment({ dataRoot, targetRef, evidenceRoot, apply }) {
  ensureOutsideDataRoot(dataRoot, evidenceRoot);
  const gitDir = await assertRepositoryReady(dataRoot);
  const staged = stagedPaths(dataRoot);
  if (staged.length > 0) throw new Error(`staged_changes_present:${staged.slice(0, 20).join(",")}`);

  const beforeHead = resolveCommit(dataRoot, "HEAD");
  const targetHead = resolveCommit(dataRoot, targetRef);
  const remoteHead = remoteHeadForTarget(dataRoot, targetRef);
  if (remoteHead && remoteHead !== targetHead) throw new Error(`local_tracking_ref_stale:${targetHead}:${remoteHead}`);
  const branch = currentBranch(dataRoot);
  const statusBeforeSha256 = statusDigest(dataRoot);
  const beforeSnapshot = await snapshotWorktree(dataRoot);
  const dryRun = {
    ok: true,
    status: beforeHead === targetHead ? "already_aligned" : "ready",
    applied: false,
    data_root: dataRoot,
    branch,
    before_head: beforeHead,
    target_ref: targetRef,
    target_head: targetHead,
    remote_head: remoteHead,
    staged_count: 0,
    worktree: snapshotSummary(beforeSnapshot),
  };
  if (!apply || beforeHead === targetHead) return dryRun;

  const migrationId = `local-history-realignment-${stamp()}-${randomUUID()}`;
  const migrationDir = path.join(evidenceRoot, migrationId);
  const manifestPath = path.join(migrationDir, "manifest.json");
  const beforeSnapshotPath = path.join(migrationDir, "worktree-before.json");
  const afterSnapshotPath = path.join(migrationDir, "worktree-after.json");
  const recoveryRef = `refs/dinobrain/recovery/${migrationId}`;
  const indexPath = path.join(gitDir, "index");
  const indexBackupPath = path.join(migrationDir, "index.before");
  const manifest = {
    version: 1,
    migration_id: migrationId,
    status: "preparing",
    created_at: new Date().toISOString(),
    data_root: dataRoot,
    branch,
    before_head: beforeHead,
    target_ref: targetRef,
    target_head: targetHead,
    recovery_ref: recoveryRef,
    index_backup_path: indexBackupPath,
    worktree_before_path: beforeSnapshotPath,
    worktree_after_path: afterSnapshotPath,
    worktree_before: snapshotSummary(beforeSnapshot),
    status_before_sha256: statusBeforeSha256,
  };

  await fs.mkdir(migrationDir, { recursive: true });
  await writeJsonAtomic(beforeSnapshotPath, beforeSnapshot);
  try {
    await fs.copyFile(indexPath, indexBackupPath);
    const indexBefore = await hashFile(indexBackupPath);
    manifest.index_before_size = indexBefore.size;
    manifest.index_before_sha256 = indexBefore.sha256;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    manifest.index_backup_path = null;
  }
  await writeJsonAtomic(manifestPath, manifest);
  git(dataRoot, ["update-ref", recoveryRef, beforeHead]);
  manifest.status = "prepared";
  manifest.recovery_ref_created = true;
  await writeJsonAtomic(manifestPath, manifest);

  let resetApplied = false;
  try {
    if (stagedPaths(dataRoot).length > 0) throw new Error("staged_changes_appeared_before_reset");
    const targetHeadRechecked = resolveCommit(dataRoot, targetRef);
    const remoteHeadRechecked = remoteHeadForTarget(dataRoot, targetRef);
    if (targetHeadRechecked !== targetHead || (remoteHeadRechecked && remoteHeadRechecked !== targetHead)) {
      throw new Error("target_ref_changed_after_snapshot");
    }
    git(dataRoot, ["reset", "--mixed", "--no-refresh", targetHead]);
    resetApplied = true;
    const afterSnapshot = await snapshotWorktree(dataRoot);
    await writeJsonAtomic(afterSnapshotPath, afterSnapshot);
    if (afterSnapshot.aggregate_sha256 !== beforeSnapshot.aggregate_sha256) {
      throw new Error("worktree_byte_manifest_changed_after_mixed_reset");
    }
    const afterHead = resolveCommit(dataRoot, "HEAD");
    if (afterHead !== targetHead) throw new Error(`HEAD_realignment_mismatch:${afterHead}`);
    const stagedAfter = stagedPaths(dataRoot);
    if (stagedAfter.length > 0) throw new Error(`realignment_created_staged_changes:${stagedAfter.slice(0, 20).join(",")}`);

    Object.assign(manifest, {
      status: "applied",
      applied_at: new Date().toISOString(),
      after_head: afterHead,
      worktree_after: snapshotSummary(afterSnapshot),
      worktree_bytes_preserved: true,
      staged_after_count: 0,
      status_after_sha256: statusDigest(dataRoot),
    });
    await writeJsonAtomic(manifestPath, manifest);
    return { ok: true, applied: true, ...manifest, manifest_path: manifestPath };
  } catch (error) {
    let rollbackError = null;
    if (resetApplied) {
      try {
        git(dataRoot, ["reset", "--mixed", "--no-refresh", beforeHead]);
        if (manifest.index_backup_path) await atomicRestoreFile(indexBackupPath, indexPath);
      } catch (rollbackFailure) {
        rollbackError = rollbackFailure.message;
      }
    }
    Object.assign(manifest, {
      status: "failed",
      failed_at: new Date().toISOString(),
      error: error.message,
      automatic_head_rollback_error: rollbackError,
    });
    await writeJsonAtomic(manifestPath, manifest);
    throw new Error(`${error.message};manifest=${manifestPath}`);
  }
}

async function rollbackRealignment(manifestPath) {
  const absoluteManifestPath = path.resolve(manifestPath);
  const manifest = JSON.parse(await fs.readFile(absoluteManifestPath, "utf8"));
  if (manifest.version !== 1 || manifest.status !== "applied") throw new Error("manifest_not_in_applied_state");
  const dataRoot = path.resolve(manifest.data_root);
  const gitDir = await assertRepositoryReady(dataRoot);
  if (currentBranch(dataRoot) !== manifest.branch) throw new Error("rollback_branch_mismatch");
  if (resolveCommit(dataRoot, "HEAD") !== manifest.target_head) throw new Error("rollback_current_HEAD_mismatch");
  const staged = stagedPaths(dataRoot);
  if (staged.length > 0) throw new Error(`staged_changes_present:${staged.slice(0, 20).join(",")}`);
  const beforeRollback = await snapshotWorktree(dataRoot);
  if (beforeRollback.aggregate_sha256 !== manifest.worktree_after.aggregate_sha256) {
    throw new Error("rollback_worktree_no_longer_matches_applied_manifest");
  }
  const indexBackupPath = path.resolve(manifest.index_backup_path);
  const indexBackup = await hashFile(indexBackupPath);
  if (indexBackup.sha256 !== manifest.index_before_sha256 || indexBackup.size !== manifest.index_before_size) {
    throw new Error("rollback_index_backup_hash_mismatch");
  }
  git(dataRoot, ["reset", "--mixed", "--no-refresh", manifest.before_head]);
  await atomicRestoreFile(indexBackupPath, path.join(gitDir, "index"));
  const afterRollback = await snapshotWorktree(dataRoot);
  if (beforeRollback.aggregate_sha256 !== afterRollback.aggregate_sha256) {
    throw new Error("worktree_byte_manifest_changed_during_rollback");
  }
  Object.assign(manifest, {
    status: "rolled_back",
    rolled_back_at: new Date().toISOString(),
    rollback_from_head: manifest.after_head ?? resolveCommit(dataRoot, manifest.target_head),
    rollback_to_head: resolveCommit(dataRoot, "HEAD"),
    rollback_worktree: snapshotSummary(afterRollback),
    rollback_worktree_bytes_preserved: true,
    rollback_index_sha256: (await hashFile(path.join(gitDir, "index"))).sha256,
    rollback_status_sha256: statusDigest(dataRoot),
  });
  if (manifest.rollback_index_sha256 !== manifest.index_before_sha256) throw new Error("rollback_exact_index_restore_failed");
  if (manifest.rollback_status_sha256 !== manifest.status_before_sha256) throw new Error("rollback_status_digest_mismatch");
  await writeJsonAtomic(absoluteManifestPath, manifest);
  return { ok: true, rolled_back: true, ...manifest, manifest_path: absoluteManifestPath };
}

async function main() {
  const rollbackManifest = argValue("--rollback");
  if ((rollbackManifest || process.argv.includes("--apply")) && !process.argv.includes("--writers-quiesced")) {
    throw new Error("writers_quiesced_confirmation_required");
  }
  if (rollbackManifest) {
    const evidenceRoot = path.dirname(path.dirname(path.resolve(rollbackManifest)));
    return withMaintenanceLock(evidenceRoot, () => rollbackRealignment(rollbackManifest));
  }
  const dataRoot = path.resolve(argValue("--data-root") ?? process.env.DINOBRAIN_DATA_DIR ?? path.join(process.cwd(), "..", "dinobrain-data"));
  const targetRef = argValue("--target") ?? "origin/main";
  const evidenceRoot = path.resolve(
    argValue("--evidence-root") ??
      path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local"), "DinoBrain", "history-migrations"),
  );
  const apply = process.argv.includes("--apply");
  return apply
    ? withMaintenanceLock(evidenceRoot, () => applyRealignment({ dataRoot, targetRef, evidenceRoot, apply }))
    : applyRealignment({ dataRoot, targetRef, evidenceRoot, apply });
}

main()
  .then((result) => {
    process.stdout.write(`${JSON.stringify(result, null, jsonOnly ? 2 : 2)}\n`);
  })
  .catch((error) => {
    const failure = { ok: false, error: error.message };
    if (jsonOnly) process.stdout.write(`${JSON.stringify(failure, null, 2)}\n`);
    else console.error(error.stack || error.message);
    process.exitCode = 1;
  });
