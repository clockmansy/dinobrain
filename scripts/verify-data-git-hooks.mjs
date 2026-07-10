import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataRoot = path.resolve(process.env.DINOBRAIN_DATA_DIR || path.join(appRoot, "..", "dinobrain-data"));

function run(cmd, args, options = {}) {
  return spawnSync(cmd, args, {
    cwd: options.cwd,
    env: { ...process.env, ...(options.env || {}) },
    encoding: "utf8",
    stdio: options.stdio || "pipe",
  });
}

function runGit(args, options = {}) {
  const safeDirectory = options.safeDirectory ?? options.cwd;
  const safeArgs = safeDirectory ? ["-c", `safe.directory=${safeDirectory}`, ...args] : args;
  return run("git", safeArgs, options);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function copyHookFiles(targetRoot) {
  const sourceHookRoot = path.join(dataRoot, ".githooks");
  const targetHookRoot = path.join(targetRoot, ".githooks");
  mkdirSync(targetHookRoot, { recursive: true });
  for (const file of ["pre-commit", "pre-push", "verify-public-data-guard.ps1"]) {
    const source = path.join(sourceHookRoot, file);
    assert(existsSync(source), `Missing data hook source file: ${source}`);
    copyFileSync(source, path.join(targetHookRoot, file));
  }
}

function initRepo(name) {
  const dir = mkdtempSync(path.join(tmpdir(), `dinobrain-${name}-`));
  assert(runGit(["init"], { cwd: dir }).status === 0, "git init failed");
  assert(runGit(["config", "user.email", "dinobrain-hooks@example.local"], { cwd: dir }).status === 0, "git config email failed");
  assert(runGit(["config", "user.name", "DinoBrain Hook Verify"], { cwd: dir }).status === 0, "git config name failed");
  copyHookFiles(dir);
  assert(runGit(["config", "core.hooksPath", ".githooks"], { cwd: dir }).status === 0, "git hooksPath config failed");
  return dir;
}

function writeJson(filePath, value) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function commitAll(repo, message) {
  assert(runGit(["add", "-A"], { cwd: repo }).status === 0, "git add failed");
  return runGit(["commit", "-m", message], { cwd: repo });
}

function verifyConfiguredDataRepo() {
  assert(existsSync(path.join(dataRoot, ".git")), `Data root is not a git repo: ${dataRoot}`);
  for (const file of [".githooks/pre-commit", ".githooks/pre-push", ".githooks/verify-public-data-guard.ps1"]) {
    assert(existsSync(path.join(dataRoot, file)), `Missing tracked hook file in data repo: ${file}`);
  }
  const configured = runGit(["config", "--get", "core.hooksPath"], { cwd: dataRoot });
  assert(configured.status === 0, `Data repo core.hooksPath is not configured:\n${configured.stderr}`);
  assert(configured.stdout.trim() === ".githooks", `Data repo core.hooksPath must be .githooks, got: ${configured.stdout.trim()}`);
}

function verifyBadAcceptedBlocked() {
  const repo = initRepo("bad-accepted");
  try {
    writeJson(path.join(repo, "50_Instances", "accepted", "bad.json"), {
      status: "accepted",
      auto_generated: true,
      claim: "Generated memory must not bypass review.",
    });
    const commit = commitAll(repo, "bad accepted");
    assert(commit.status !== 0, "pre-commit allowed auto-generated accepted memory without review lineage");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

function verifyAcceptedAtOnlyBlocked() {
  const repo = initRepo("accepted-at-only");
  try {
    writeJson(path.join(repo, "50_Instances", "accepted", "accepted-at-only.json"), {
      status: "accepted",
      auto_generated: true,
      accepted_at: "2026-07-07T00:00:00.000Z",
      claim: "accepted_at alone is not review lineage.",
    });
    const commit = commitAll(repo, "accepted at only");
    assert(commit.status !== 0, "pre-commit allowed auto-generated accepted memory with only accepted_at");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

function verifyLocalOnlyBlocked() {
  const repo = initRepo("local-only");
  try {
    mkdirSync(path.join(repo, ".dino", "events"), { recursive: true });
    writeFileSync(path.join(repo, ".dino", "events", "2026-07-07.jsonl"), "{}\n", "utf8");
    const commit = commitAll(repo, "local event");
    assert(commit.status !== 0, "pre-commit allowed local-only event log path");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

function verifyLocalLifecycleBackupBlocked() {
  const repo = initRepo("local-lifecycle-backup");
  try {
    mkdirSync(path.join(repo, ".dino", "local-backups", "node-lifecycle", "tx"), { recursive: true });
    writeFileSync(path.join(repo, ".dino", "local-backups", "node-lifecycle", "tx", "before.bin"), "private-before-bytes", "utf8");
    const commit = commitAll(repo, "local lifecycle backup");
    assert(commit.status !== 0, "pre-commit allowed local lifecycle backup path");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

function verifyLocalAdmissionReceiptBlocked() {
  const repo = initRepo("local-review-admission");
  try {
    mkdirSync(path.join(repo, ".dino", "review-admissions", "2026-07"), { recursive: true });
    writeFileSync(
      path.join(repo, ".dino", "review-admissions", "2026-07", "decision.json"),
      '{"idempotency_key":"local-review-decision"}\n',
      "utf8",
    );
    const commit = commitAll(repo, "local review admission");
    assert(commit.status !== 0, "pre-commit allowed local review admission receipt path");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

function verifyUnsafeReviewWorklistSummaryBlocked() {
  const repo = initRepo("unsafe-review-worklist-summary");
  try {
    writeJson(path.join(repo, "60_Operations", "review-worklists", "unsafe.json"), {
      status: "needs_review",
      clusters: [{ representative_claim: "private user preference", candidate_paths: ["private-candidate.json"] }],
    });
    const commit = commitAll(repo, "unsafe review worklist summary");
    assert(commit.status !== 0, "pre-commit allowed a review worklist summary with private fields");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

function verifyReviewedAcceptedAllowedAndPrePushChecked() {
  const repo = initRepo("reviewed-accepted");
  try {
    writeJson(path.join(repo, "50_Instances", "accepted", "reviewed.json"), {
      status: "accepted",
      auto_generated: true,
      reviewed_by: "verify-data-git-hooks",
      accepted_at: "2026-07-07T00:00:00.000Z",
      claim: "Reviewed generated memory may be accepted.",
    });
    const commit = commitAll(repo, "reviewed accepted");
    assert(commit.status === 0, `pre-commit blocked reviewed accepted memory:\n${commit.stderr}\n${commit.stdout}`);
    const guard = run("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", ".githooks/verify-public-data-guard.ps1", "-Mode", "pre-push"], { cwd: repo });
    assert(guard.status === 0, `pre-push guard blocked clean HEAD:\n${guard.stderr}\n${guard.stdout}`);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

verifyConfiguredDataRepo();
verifyBadAcceptedBlocked();
verifyAcceptedAtOnlyBlocked();
verifyLocalOnlyBlocked();
verifyLocalLifecycleBackupBlocked();
verifyLocalAdmissionReceiptBlocked();
verifyUnsafeReviewWorklistSummaryBlocked();
verifyReviewedAcceptedAllowedAndPrePushChecked();

console.log(
  JSON.stringify(
    {
      ok: true,
      data_root: dataRoot,
      hooks_path: ".githooks",
      checks: [
        "configured_data_repo",
        "bad_accepted_blocked",
        "accepted_at_only_blocked",
        "local_only_blocked",
        "local_lifecycle_backup_blocked",
        "local_review_admission_blocked",
        "unsafe_review_worklist_summary_blocked",
        "reviewed_accepted_allowed",
        "pre_push_clean_head",
      ],
    },
    null,
    2,
  ),
);
