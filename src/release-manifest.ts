import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

import { atomicWriteJson } from "./concurrency.js";

export const RELEASE_MANIFEST_VERSION = "release_manifest_v1";
export const RELEASE_MANIFEST_STATUS_RELATIVE_PATH = ".dino/state/release_manifest_status.json";

const execFileAsync = promisify(execFile);

export type GitSnapshot = {
  root: string;
  head: string | null;
  branch: string | null;
  upstream: string | null;
  upstream_head: string | null;
  head_matches_upstream: boolean | null;
  tracked_dirty_count: number;
  untracked_count: number;
  commit_date: string | null;
};

export type ReleaseAssetSnapshot = {
  zip_path: string;
  zip_exists: boolean;
  zip_size_bytes: number;
  zip_mtime: string | null;
  sha_path: string;
  sha_exists: boolean;
  sha256_actual: string | null;
  sha256_recorded: string | null;
  sha256_matches: boolean | null;
  exe_path: string;
  exe_exists: boolean;
  exe_size_bytes: number;
  exe_mtime: string | null;
  artifact_newer_than_app_head: boolean | null;
};

export type ReleaseManifestReport = {
  version: typeof RELEASE_MANIFEST_VERSION;
  status: "healthy" | "needs_attention" | "degraded";
  generated_at: string;
  data_root: string;
  app_root: string;
  package_version: string | null;
  authoritative_version: string | null;
  version_aligned: boolean;
  expected_tag: string | null;
  app_git: GitSnapshot;
  data_git: GitSnapshot;
  tag: {
    exists: boolean;
    target: string | null;
    matches_app_head: boolean | null;
  };
  assets: ReleaseAssetSnapshot;
  github_release: {
    status: "not_checked";
    reason: string;
  };
  blockers: string[];
  warnings: string[];
  visible_status: string;
};

type BuildOptions = {
  appRoot?: string;
  now?: Date;
};

type PackageJson = {
  version?: unknown;
};

type VersionManifestJson = {
  version?: unknown;
};

function dataPath(dataRoot: string, relativePath: string): string {
  return path.resolve(dataRoot, ...relativePath.split("/"));
}

async function readJsonIfExists<T>(filePath: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function git(root: string, args: string[]): Promise<string | null> {
  try {
    const result = await execFileAsync("git", ["-C", root, ...args], {
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024,
    });
    return result.stdout.trim();
  } catch {
    return null;
  }
}

async function gitRequired(root: string, args: string[]): Promise<string | null> {
  const value = await git(root, args);
  return value && value.length > 0 ? value : null;
}

function parseStatus(text: string | null): { trackedDirty: number; untracked: number } {
  if (!text) return { trackedDirty: 0, untracked: 0 };
  const lines = text.split(/\r?\n/).filter(Boolean);
  return {
    trackedDirty: lines.filter((line) => !line.startsWith("?? ")).length,
    untracked: lines.filter((line) => line.startsWith("?? ")).length,
  };
}

async function gitSnapshot(root: string): Promise<GitSnapshot> {
  const [head, branch, upstream, upstreamHead, commitDate, statusText] = await Promise.all([
    gitRequired(root, ["rev-parse", "HEAD"]),
    gitRequired(root, ["rev-parse", "--abbrev-ref", "HEAD"]),
    gitRequired(root, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]),
    gitRequired(root, ["rev-parse", "@{u}"]),
    gitRequired(root, ["show", "-s", "--format=%cI", "HEAD"]),
    git(root, ["status", "--porcelain"]),
  ]);
  const status = parseStatus(statusText);
  return {
    root: path.resolve(root),
    head,
    branch,
    upstream,
    upstream_head: upstreamHead,
    head_matches_upstream: head && upstreamHead ? head === upstreamHead : null,
    tracked_dirty_count: status.trackedDirty,
    untracked_count: status.untracked,
    commit_date: commitDate,
  };
}

async function fileSnapshot(filePath: string): Promise<{ exists: boolean; size: number; mtime: string | null }> {
  try {
    const stat = await fs.stat(filePath);
    return { exists: stat.isFile(), size: stat.isFile() ? stat.size : 0, mtime: stat.isFile() ? stat.mtime.toISOString() : null };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { exists: false, size: 0, mtime: null };
    throw error;
  }
}

async function sha256IfExists(filePath: string): Promise<string | null> {
  try {
    const buffer = await fs.readFile(filePath);
    return createHash("sha256").update(buffer).digest("hex");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function recordedShaIfExists(filePath: string): Promise<string | null> {
  try {
    const text = await fs.readFile(filePath, "utf8");
    const match = text.match(/[a-fA-F0-9]{64}/);
    return match ? match[0].toLowerCase() : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function newerThan(candidateIso: string | null, baselineIso: string | null): boolean | null {
  if (!candidateIso || !baselineIso) return null;
  const candidate = Date.parse(candidateIso);
  const baseline = Date.parse(baselineIso);
  if (!Number.isFinite(candidate) || !Number.isFinite(baseline)) return null;
  return candidate >= baseline;
}

async function releaseAssets(appRoot: string, appCommitDate: string | null): Promise<ReleaseAssetSnapshot> {
  const zipPath = path.join(appRoot, "artifacts", "DinoBrainSetup.zip");
  const shaPath = path.join(appRoot, "artifacts", "DinoBrainSetup.zip.sha256");
  const exePath = path.join(appRoot, "artifacts", "DinoBrainSetup.exe");
  const [zip, sha, exe, actualSha, recordedSha] = await Promise.all([
    fileSnapshot(zipPath),
    fileSnapshot(shaPath),
    fileSnapshot(exePath),
    sha256IfExists(zipPath),
    recordedShaIfExists(shaPath),
  ]);
  return {
    zip_path: zipPath,
    zip_exists: zip.exists,
    zip_size_bytes: zip.size,
    zip_mtime: zip.mtime,
    sha_path: shaPath,
    sha_exists: sha.exists,
    sha256_actual: actualSha,
    sha256_recorded: recordedSha,
    sha256_matches: actualSha && recordedSha ? actualSha === recordedSha : null,
    exe_path: exePath,
    exe_exists: exe.exists,
    exe_size_bytes: exe.size,
    exe_mtime: exe.mtime,
    artifact_newer_than_app_head: newerThan(zip.mtime, appCommitDate),
  };
}

function visibleStatus(status: ReleaseManifestReport["status"]): string {
  if (status === "healthy") return "Release manifest healthy";
  if (status === "degraded") return "Release manifest unavailable";
  return "Release manifest needs attention";
}

export function getReleaseManifestStatusPath(dataRoot: string): string {
  return dataPath(dataRoot, RELEASE_MANIFEST_STATUS_RELATIVE_PATH);
}

export async function buildReleaseManifestReport(
  dataRoot: string,
  options: BuildOptions = {},
): Promise<ReleaseManifestReport> {
  const appRoot = path.resolve(options.appRoot ?? process.cwd());
  const packageJson = await readJsonIfExists<PackageJson>(path.join(appRoot, "package.json"));
  const versionManifest = await readJsonIfExists<VersionManifestJson>(path.join(appRoot, "version.json"));
  const packageVersion = typeof packageJson?.version === "string" && packageJson.version.trim() ? packageJson.version.trim() : null;
  const authoritativeVersion =
    typeof versionManifest?.version === "string" && versionManifest.version.trim() ? versionManifest.version.trim() : null;
  const versionAligned = Boolean(packageVersion && authoritativeVersion && packageVersion === authoritativeVersion);
  const expectedTag = authoritativeVersion ? `v${authoritativeVersion}` : null;
  const [appGit, dataGit] = await Promise.all([gitSnapshot(appRoot), gitSnapshot(dataRoot)]);
  const tagTarget = expectedTag ? await gitRequired(appRoot, ["rev-parse", expectedTag]) : null;
  const assets = await releaseAssets(appRoot, appGit.commit_date);
  const blockers: string[] = [];
  const warnings: string[] = [];

  if (!authoritativeVersion) blockers.push("version_manifest_missing");
  if (!packageVersion) blockers.push("package_version_missing");
  if (packageVersion && authoritativeVersion && !versionAligned) blockers.push("package_version_manifest_mismatch");
  if (!appGit.head) blockers.push("app_head_missing");
  if (!dataGit.head) blockers.push("data_head_missing");
  if (appGit.head_matches_upstream === false) blockers.push("app_head_not_pushed_to_upstream");
  if (dataGit.head_matches_upstream === false) blockers.push("data_head_not_pushed_to_upstream");
  if (appGit.tracked_dirty_count > 0) blockers.push("app_tracked_worktree_dirty");
  if (dataGit.tracked_dirty_count > 0) warnings.push("data_tracked_worktree_dirty");
  if (!expectedTag) blockers.push("release_tag_missing");
  else if (!tagTarget) blockers.push("release_tag_missing");
  else if (appGit.head && tagTarget !== appGit.head) blockers.push("release_tag_target_mismatch");
  if (!assets.exe_exists) blockers.push("installer_exe_missing");
  if (!assets.zip_exists) blockers.push("release_zip_missing");
  if (!assets.sha_exists) blockers.push("release_sha_missing");
  if (assets.sha256_matches === false) blockers.push("release_sha_mismatch");
  if (assets.artifact_newer_than_app_head === false) blockers.push("release_zip_older_than_app_head");
  if (dataGit.untracked_count > 0) warnings.push("data_untracked_backlog_present");
  if (appGit.untracked_count > 0) warnings.push("app_untracked_files_present");
  warnings.push("github_release_asset_not_checked_without_token");

  const status: ReleaseManifestReport["status"] = blockers.length === 0 ? "healthy" : packageVersion ? "needs_attention" : "degraded";
  return {
    version: RELEASE_MANIFEST_VERSION,
    status,
    generated_at: (options.now ?? new Date()).toISOString(),
    data_root: path.resolve(dataRoot),
    app_root: appRoot,
    package_version: packageVersion,
    authoritative_version: authoritativeVersion,
    version_aligned: versionAligned,
    expected_tag: expectedTag,
    app_git: appGit,
    data_git: dataGit,
    tag: {
      exists: Boolean(tagTarget),
      target: tagTarget,
      matches_app_head: tagTarget && appGit.head ? tagTarget === appGit.head : null,
    },
    assets,
    github_release: {
      status: "not_checked",
      reason: "GitHub release asset verification requires an authenticated release upload/check path; local ZIP/SHA/tag parity is verified here.",
    },
    blockers,
    warnings,
    visible_status: visibleStatus(status),
  };
}

export async function buildAndWriteReleaseManifestReport(
  dataRoot: string,
  options: BuildOptions = {},
): Promise<{ report: ReleaseManifestReport; statusPath: string }> {
  const report = await buildReleaseManifestReport(dataRoot, options);
  const statusPath = getReleaseManifestStatusPath(dataRoot);
  await atomicWriteJson(statusPath, report);
  return { report, statusPath };
}
