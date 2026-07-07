import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

async function build(appRoot, dataRoot) {
  return (await buildAndWriteReleaseManifestReport(dataRoot, { appRoot, now: new Date("2026-07-07T00:00:00.000Z") })).report;
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
    seedArtifacts(appRoot);
    commitAll(appRoot, "app release fixture");
    runGit(appRoot, ["tag", "v9.9.9"]);
    runGit(appRoot, ["push", "-u", "origin", "main"]);

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

    writeFileSync(path.join(appRoot, "package.json"), `${JSON.stringify({ version: "9.9.10" }, null, 2)}\n`, "utf8");
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
