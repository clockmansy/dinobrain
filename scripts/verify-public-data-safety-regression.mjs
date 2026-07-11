import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const verifierPath = path.join(appRoot, "scripts", "verify-public-data-safety.mjs");
const fixtureRoot = mkdtempSync(path.join(tmpdir(), "dinobrain-public-safety-"));
const dataRoot = path.join(fixtureRoot, "data");
const remoteRoot = path.join(fixtureRoot, "remote.git");

function git(cwd, args) {
  return execFileSync("git", ["-c", `safe.directory=${cwd}`, "-C", cwd, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  }).trim();
}

function gitInit(args) {
  return execFileSync("git", ["init", ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  }).trim();
}

function write(relativePath, value) {
  const target = path.join(dataRoot, relativePath);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, value, "utf8");
}

function runVerifier() {
  const result = spawnSync(process.execPath, [verifierPath, "--json", "--fail-on-warnings"], {
    cwd: appRoot,
    env: {
      ...process.env,
      DINOBRAIN_DATA_DIR: dataRoot,
      DINOBRAIN_PUBLIC_SAFETY_LEDGER_DIR: path.join(fixtureRoot, "local-ledgers"),
    },
    encoding: "utf8",
    windowsHide: true,
  });
  let report;
  try {
    report = JSON.parse(result.stdout);
  } catch {
    throw new Error(`Public safety verifier returned invalid JSON.\nstdout=${result.stdout}\nstderr=${result.stderr}`);
  }
  return { code: result.status, report, stderr: result.stderr };
}

try {
  mkdirSync(dataRoot, { recursive: true });
  gitInit(["-b", "main", dataRoot]);
  gitInit(["--bare", "-b", "main", remoteRoot]);
  git(dataRoot, ["config", "user.email", "public-safety@example.invalid"]);
  git(dataRoot, ["config", "user.name", "Public Safety Verifier"]);
  write(".gitignore", ".dino/index/\n.dino/events/\n.dino/sync-scopes/\n");
  write(".gitattributes", "*.json text eol=lf\n*.md text eol=lf\n");
  write("README.md", "# Public-safe fixture\n");
  write("20_Wiki/safe.md", "# Safe\n\nCommitted reviewed knowledge.\n");
  git(dataRoot, ["add", "-A"]);
  git(dataRoot, ["commit", "-m", "safe public root"]);
  git(dataRoot, ["remote", "add", "origin", remoteRoot]);
  git(dataRoot, ["push", "-u", "origin", "main"]);

  const baseline = runVerifier();
  assert.equal(baseline.code, 0, baseline.stderr);
  assert.equal(baseline.report.status, "pass");
  assert.equal(baseline.report.result.warning_count, 0);
  assert.equal(baseline.report.scanned.index_exclusion.status, "not_present_local_only");
  assert.equal(baseline.report.data_repo.head_matches_upstream, true);

  write(
    ".dino/tasks/local-only.json",
    `${JSON.stringify({ request: "Read C:\\Users\\sample-user\\private\\notes.md", status: "started" }, null, 2)}\n`,
  );
  write("20_Wiki/safe.md", "# Safe\n\nUncommitted local revision from C:\\Users\\sample-user\\private\\draft.md.\n");
  const excludedDirty = runVerifier();
  assert.equal(excludedDirty.code, 0, excludedDirty.stderr);
  assert.equal(excludedDirty.report.status, "pass");
  assert.equal(excludedDirty.report.result.warning_count, 0);
  assert.equal(excludedDirty.report.scanned.local_exclusions.dirty_count, 2);
  assert.equal(excludedDirty.report.scanned.local_exclusions.all_paths_explicitly_classified, true);
  assert.equal(excludedDirty.report.scanned.local_exclusions.content_finding_counts.windows_user_path, 2);
  assert.equal(excludedDirty.report.scanned.local_exclusions.raw_paths_in_public_report, false);
  assert.equal(JSON.stringify(excludedDirty.report).includes("sample-user"), false);
  assert.equal(excludedDirty.report.scanned.local_exclusions.ledger_persisted, true);

  write("misc/unclassified.md", "This root is not governed.\n");
  const unclassified = runVerifier();
  assert.equal(unclassified.code, 1);
  assert(unclassified.report.findings.some((finding) => finding.id === "unclassified_local_dirty_path"));
  rmSync(path.join(dataRoot, "misc"), { recursive: true, force: true });

  git(dataRoot, ["add", "20_Wiki/safe.md"]);
  const staged = runVerifier();
  assert.equal(staged.code, 1);
  assert(staged.report.findings.some((finding) => finding.id === "staged_local_change_present"));
  git(dataRoot, ["reset", "--", "20_Wiki/safe.md"]);

  write("20_Wiki/unsafe-history.md", "C:\\Users\\sample-user\\private\\history.md\n");
  git(dataRoot, ["add", "20_Wiki/unsafe-history.md"]);
  git(dataRoot, ["commit", "--no-verify", "-m", "inject unsafe public history"]);
  const unsafeHistory = runVerifier();
  assert.equal(unsafeHistory.code, 1);
  assert(unsafeHistory.report.findings.some((finding) => finding.id === "windows_user_path"));
  assert(unsafeHistory.report.findings.some((finding) => finding.id === "git_history_risk_detected"));

  console.log(
    JSON.stringify(
      {
        ok: true,
        checks: [
          "committed_HEAD_tree_scanned_instead_of_worktree_overlay",
          "published_HEAD_history_scoped",
          "missing_local_index_is_not_warning",
          "explicit_unstaged_local_dirty_excluded",
          "conditional_machine_local_content_stays_excluded",
          "unclassified_dirty_path_blocks",
          "staged_change_blocks",
          "unsafe_committed_history_blocks",
        ],
      },
      null,
      2,
    ),
  );
} finally {
  rmSync(fixtureRoot, { recursive: true, force: true });
}
