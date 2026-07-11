import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { buildAndWriteReleaseManifestReport } = await import(
  pathToFileURL(path.join(root, "dist", "release-manifest.js")).href
);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function runGit(cwd, args) {
  execFileSync("git", args, { cwd, stdio: "ignore", windowsHide: true });
}

function initRepo(repo, remote) {
  mkdirSync(repo, { recursive: true });
  runGit(repo, ["init", "-b", "main"]);
  runGit(repo, ["config", "user.email", "verify@example.invalid"]);
  runGit(repo, ["config", "user.name", "DinoBrain Verify"]);
  if (remote) runGit(repo, ["remote", "add", "origin", remote]);
}

function commitAll(repo, message) {
  runGit(repo, ["add", "."]);
  runGit(repo, ["commit", "-m", message]);
}

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

function seedArtifacts(appRoot, content = "release zip fixture") {
  const artifacts = path.join(appRoot, "artifacts");
  mkdirSync(artifacts, { recursive: true });
  writeFileSync(path.join(artifacts, "DinoBrainSetup.exe"), "exe fixture", "utf8");
  writeFileSync(path.join(artifacts, "DinoBrainSetup.zip"), content, "utf8");
  writeFileSync(path.join(artifacts, "DinoBrainSetup.zip.sha256"), `${sha256(content)}  DinoBrainSetup.zip\n`, "utf8");
}

function githubReleaseFixture(appRoot, overrides = {}) {
  const version = JSON.parse(readFileSync(path.join(appRoot, "version.json"), "utf8")).version;
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: appRoot, encoding: "utf8" }).trim();
  const zip = readFileSync(path.join(appRoot, "artifacts", "DinoBrainSetup.zip"));
  const sha = readFileSync(path.join(appRoot, "artifacts", "DinoBrainSetup.zip.sha256"));
  const release = {
    tag_name: `v${version}`,
    target_commitish: head,
    html_url: `https://github.example.invalid/fixture/releases/tag/v${version}`,
    assets: [
      { name: "DinoBrainSetup.zip", size: zip.length, digest: `sha256:${sha256(zip)}` },
      { name: "DinoBrainSetup.zip.sha256", size: sha.length, digest: `sha256:${sha256(sha)}` },
    ],
  };
  return { ...release, ...overrides };
}

async function build(appRoot, dataRoot, githubRelease = githubReleaseFixture(appRoot)) {
  return (await buildAndWriteReleaseManifestReport(dataRoot, {
    appRoot,
    now: new Date("2026-07-07T00:00:00.000Z"),
    githubRepository: "fixture/dinobrain",
    githubRelease,
  })).report;
}

async function main() {
  const temp = mkdtempSync(path.join(tmpdir(), "dinobrain-release-manifest-"));
  try {
    const appOrigin = path.join(temp, "app-origin.git");
    const dataOrigin = path.join(temp, "data-origin.git");
    const appRoot = path.join(temp, "app");
    const dataRoot = path.join(temp, "data");
    spawnSync("git", ["init", "--bare", appOrigin], { stdio: "ignore", windowsHide: true });
    spawnSync("git", ["init", "--bare", dataOrigin], { stdio: "ignore", windowsHide: true });

    initRepo(appRoot, appOrigin);
    writeFileSync(path.join(appRoot, "package.json"), `${JSON.stringify({ version: "9.9.9" }, null, 2)}\n`, "utf8");
    writeFileSync(
      path.join(appRoot, "version.json"),
      `${JSON.stringify({ schema_version: 1, version: "9.9.9", data_contract_version: 3 }, null, 2)}\n`,
      "utf8",
    );
    commitAll(appRoot, "app release fixture");
    runGit(appRoot, ["tag", "v9.9.9"]);
    runGit(appRoot, ["push", "-u", "origin", "main"]);
    seedArtifacts(appRoot);

    initRepo(dataRoot, dataOrigin);
    mkdirSync(path.join(dataRoot, ".dino", "state"), { recursive: true });
    writeFileSync(path.join(dataRoot, "README.md"), "data fixture\n", "utf8");
    commitAll(dataRoot, "data fixture");
    runGit(dataRoot, ["push", "-u", "origin", "main"]);

    const healthy = await build(appRoot, dataRoot);
    assert(healthy.status === "healthy", `healthy fixture should pass, got ${healthy.status}: ${healthy.blockers.join(",")}`);
    assert(healthy.tag.matches_app_head === true, "healthy fixture tag did not match app head");
    assert(healthy.assets.sha256_matches === true, "healthy fixture SHA did not match");
    assert(healthy.assets.artifact_newer_than_app_head === true, "healthy fixture artifact was not fresh enough");
    assert(healthy.github_release.verified === true, "healthy fixture GitHub release was not verified");

    const digestMismatchFixture = githubReleaseFixture(appRoot);
    digestMismatchFixture.assets[0].digest = `sha256:${"0".repeat(64)}`;
    const digestMismatch = await build(appRoot, dataRoot, digestMismatchFixture);
    assert(digestMismatch.status === "needs_attention", "remote ZIP digest mismatch produced a false-green report");
    assert(
      digestMismatch.blockers.includes("github_release_zip_digest_mismatch"),
      "remote ZIP digest mismatch blocker was not reported",
    );

    const missingRemote = await build(appRoot, dataRoot, null);
    assert(missingRemote.status === "needs_attention", "missing GitHub release produced a false-green report");
    assert(missingRemote.blockers.includes("github_release_missing"), "missing GitHub release blocker was not reported");

    writeFileSync(path.join(appRoot, "package.json"), `${JSON.stringify({ version: "9.9.10" }, null, 2)}\n`, "utf8");
    writeFileSync(
      path.join(appRoot, "version.json"),
      `${JSON.stringify({ schema_version: 1, version: "9.9.10", data_contract_version: 3 }, null, 2)}\n`,
      "utf8",
    );
    commitAll(appRoot, "bump without tag");
    runGit(appRoot, ["push", "origin", "main"]);
    const missingTag = await build(appRoot, dataRoot);
    assert(missingTag.status === "needs_attention", "missing tag fixture should fail");
    assert(missingTag.blockers.includes("release_tag_missing"), "missing tag blocker was not reported");
    assert(missingTag.blockers.includes("release_zip_older_than_app_head"), "stale ZIP blocker was not reported");

    runGit(appRoot, ["tag", "v9.9.10"]);
    writeFileSync(path.join(appRoot, "artifacts", "DinoBrainSetup.zip.sha256"), `${"0".repeat(64)}  DinoBrainSetup.zip\n`, "utf8");
    const badSha = await build(appRoot, dataRoot);
    assert(badSha.blockers.includes("release_sha_mismatch"), "SHA mismatch blocker was not reported");

    console.log("release manifest verification ok");
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
