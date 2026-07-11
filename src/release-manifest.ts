import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

import { atomicWriteJson } from "./concurrency.js";

export const RELEASE_MANIFEST_VERSION = "release_manifest_v2";
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
  sha_size_bytes: number;
  sha_file_sha256_actual: string | null;
  sha256_actual: string | null;
  sha256_recorded: string | null;
  sha256_matches: boolean | null;
  exe_path: string;
  exe_exists: boolean;
  exe_size_bytes: number;
  exe_mtime: string | null;
  artifact_newer_than_app_head: boolean | null;
};

export type GitHubReleaseAssetSnapshot = {
  name: string;
  count: number;
  exists: boolean;
  size_bytes: number | null;
  size_matches_local: boolean | null;
  digest: string | null;
  digest_sha256: string | null;
  digest_matches_local: boolean | null;
  download_url: string | null;
  verified: boolean;
};

export type GitHubReleaseSnapshot = {
  status: "verified" | "needs_attention" | "missing" | "unavailable";
  repository: string | null;
  tag: string | null;
  url: string | null;
  target_commitish: string | null;
  target_matches_app_head: boolean | null;
  zip_asset: GitHubReleaseAssetSnapshot;
  sha_asset: GitHubReleaseAssetSnapshot;
  verified: boolean;
  authenticated: boolean;
  reason: string | null;
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
  github_release: GitHubReleaseSnapshot;
  blockers: string[];
  warnings: string[];
  visible_status: string;
};

type BuildOptions = {
  appRoot?: string;
  now?: Date;
  githubRepository?: string | null;
  githubToken?: string | null;
  githubRelease?: GitHubReleaseApi | null;
};

type PackageJson = {
  version?: unknown;
};

type VersionManifestJson = {
  version?: unknown;
};

type GitHubReleaseApiAsset = {
  name?: unknown;
  size?: unknown;
  digest?: unknown;
  browser_download_url?: unknown;
};

type GitHubReleaseApi = {
  tag_name?: unknown;
  target_commitish?: unknown;
  html_url?: unknown;
  assets?: unknown;
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
  const [zip, sha, exe, actualSha, recordedSha, shaFileSha] = await Promise.all([
    fileSnapshot(zipPath),
    fileSnapshot(shaPath),
    fileSnapshot(exePath),
    sha256IfExists(zipPath),
    recordedShaIfExists(shaPath),
    sha256IfExists(shaPath),
  ]);
  return {
    zip_path: zipPath,
    zip_exists: zip.exists,
    zip_size_bytes: zip.size,
    zip_mtime: zip.mtime,
    sha_path: shaPath,
    sha_exists: sha.exists,
    sha_size_bytes: sha.size,
    sha_file_sha256_actual: shaFileSha,
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

function parseGitHubRepository(remote: string | null): string | null {
  if (!remote) return null;
  const normalized = remote.trim().replace(/\\/g, "/").replace(/\.git$/i, "").replace(/\/+$/, "");
  const match = normalized.match(/github\.com[:/]([^/]+)\/([^/]+)$/i);
  return match ? `${match[1]}/${match[2]}` : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function digestSha256(value: string | null): string | null {
  const match = value?.match(/^sha256:([a-f0-9]{64})$/i);
  return match ? match[1].toLowerCase() : null;
}

function emptyGitHubAsset(name: string): GitHubReleaseAssetSnapshot {
  return {
    name,
    count: 0,
    exists: false,
    size_bytes: null,
    size_matches_local: null,
    digest: null,
    digest_sha256: null,
    digest_matches_local: null,
    download_url: null,
    verified: false,
  };
}

function githubAssetSnapshot(
  release: GitHubReleaseApi,
  name: string,
  expectedSize: number,
  expectedSha256: string | null,
): GitHubReleaseAssetSnapshot {
  const assets = Array.isArray(release.assets) ? release.assets.filter((value): value is GitHubReleaseApiAsset => Boolean(value && typeof value === "object")) : [];
  const matches = assets.filter((asset) => stringValue(asset.name) === name);
  const asset = matches[0];
  if (!asset) return emptyGitHubAsset(name);
  const size = numberValue(asset.size);
  const digest = stringValue(asset.digest);
  const parsedDigest = digestSha256(digest);
  const sizeMatches = size === expectedSize;
  const digestMatches = Boolean(expectedSha256 && parsedDigest && expectedSha256 === parsedDigest);
  return {
    name,
    count: matches.length,
    exists: true,
    size_bytes: size,
    size_matches_local: sizeMatches,
    digest,
    digest_sha256: parsedDigest,
    digest_matches_local: digestMatches,
    download_url: stringValue(asset.browser_download_url),
    verified: matches.length === 1 && sizeMatches && digestMatches,
  };
}

async function fetchGitHubRelease(
  repository: string,
  tag: string,
  token: string | null,
): Promise<{ status: "found" | "missing" | "unavailable"; release: GitHubReleaseApi | null; reason: string | null }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const headers: Record<string, string> = {
      Accept: "application/vnd.github+json",
      "User-Agent": "DinoBrainReleaseManifest",
      "X-GitHub-Api-Version": "2022-11-28",
    };
    if (token) headers.Authorization = `Bearer ${token}`;
    const response = await fetch(`https://api.github.com/repos/${repository}/releases/tags/${encodeURIComponent(tag)}`, {
      headers,
      signal: controller.signal,
    });
    if (response.status === 404) return { status: "missing", release: null, reason: "github_release_not_found" };
    if (!response.ok) return { status: "unavailable", release: null, reason: `github_api_http_${response.status}` };
    const release = (await response.json()) as GitHubReleaseApi;
    return { status: "found", release, reason: null };
  } catch (error) {
    const reason = error instanceof Error && error.name === "AbortError" ? "github_api_timeout" : "github_api_request_failed";
    return { status: "unavailable", release: null, reason };
  } finally {
    clearTimeout(timeout);
  }
}

async function githubReleaseSnapshot(
  appRoot: string,
  expectedTag: string | null,
  appHead: string | null,
  assets: ReleaseAssetSnapshot,
  options: BuildOptions,
): Promise<GitHubReleaseSnapshot> {
  const remote = await gitRequired(appRoot, ["config", "--get", "remote.origin.url"]);
  const repository = options.githubRepository === undefined ? parseGitHubRepository(remote) : options.githubRepository;
  const token = options.githubToken === undefined
    ? stringValue(process.env.GITHUB_TOKEN) ?? stringValue(process.env.GH_TOKEN)
    : options.githubToken;
  const blank = {
    repository,
    tag: expectedTag,
    url: null,
    target_commitish: null,
    target_matches_app_head: null,
    zip_asset: emptyGitHubAsset("DinoBrainSetup.zip"),
    sha_asset: emptyGitHubAsset("DinoBrainSetup.zip.sha256"),
    verified: false,
    authenticated: Boolean(token),
  };
  if (!repository || !expectedTag) {
    return { ...blank, status: "unavailable", reason: !repository ? "github_repository_unresolved" : "release_tag_missing" };
  }
  const lookup = options.githubRelease === undefined
    ? await fetchGitHubRelease(repository, expectedTag, token)
    : options.githubRelease === null
      ? { status: "missing" as const, release: null, reason: "github_release_not_found" }
      : { status: "found" as const, release: options.githubRelease, reason: null };
  if (!lookup.release) {
    return { ...blank, status: lookup.status === "missing" ? "missing" : "unavailable", reason: lookup.reason };
  }
  const release = lookup.release;
  const tag = stringValue(release.tag_name);
  const target = stringValue(release.target_commitish);
  const targetMatches = Boolean(appHead && target && appHead === target);
  const zipAsset = githubAssetSnapshot(release, "DinoBrainSetup.zip", assets.zip_size_bytes, assets.sha256_actual);
  const shaAsset = githubAssetSnapshot(release, "DinoBrainSetup.zip.sha256", assets.sha_size_bytes, assets.sha_file_sha256_actual);
  const verified = tag === expectedTag && targetMatches && zipAsset.verified && shaAsset.verified;
  return {
    status: verified ? "verified" : "needs_attention",
    repository,
    tag,
    url: stringValue(release.html_url),
    target_commitish: target,
    target_matches_app_head: targetMatches,
    zip_asset: zipAsset,
    sha_asset: shaAsset,
    verified,
    authenticated: Boolean(token),
    reason: verified ? null : "github_release_parity_mismatch",
  };
}

function appendGitHubReleaseBlockers(snapshot: GitHubReleaseSnapshot, blockers: string[]): void {
  if (snapshot.status === "unavailable") blockers.push(snapshot.reason ?? "github_release_unavailable");
  if (snapshot.status === "missing") blockers.push("github_release_missing");
  if (snapshot.status === "needs_attention") {
    if (snapshot.target_matches_app_head !== true) blockers.push("github_release_target_mismatch");
    if (!snapshot.zip_asset.exists) blockers.push("github_release_zip_missing");
    else {
      if (snapshot.zip_asset.count !== 1) blockers.push("github_release_zip_duplicate");
      if (!snapshot.zip_asset.digest_sha256) blockers.push("github_release_zip_digest_missing");
      else if (snapshot.zip_asset.digest_matches_local !== true) blockers.push("github_release_zip_digest_mismatch");
      if (snapshot.zip_asset.size_matches_local !== true) blockers.push("github_release_zip_size_mismatch");
    }
    if (!snapshot.sha_asset.exists) blockers.push("github_release_sha_missing");
    else {
      if (snapshot.sha_asset.count !== 1) blockers.push("github_release_sha_duplicate");
      if (!snapshot.sha_asset.digest_sha256) blockers.push("github_release_sha_digest_missing");
      else if (snapshot.sha_asset.digest_matches_local !== true) blockers.push("github_release_sha_digest_mismatch");
      if (snapshot.sha_asset.size_matches_local !== true) blockers.push("github_release_sha_size_mismatch");
    }
  }
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
  const githubRelease = await githubReleaseSnapshot(appRoot, expectedTag, appGit.head, assets, options);
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
  appendGitHubReleaseBlockers(githubRelease, blockers);

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
    github_release: githubRelease,
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
