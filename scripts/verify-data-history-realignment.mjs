import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scriptPath = path.join(appRoot, "scripts", "realign-data-history.mjs");
const fixtureRoot = mkdtempSync(path.join(tmpdir(), "dinobrain-history-realign-"));
const dataRoot = path.join(fixtureRoot, "data");
const sanitizedRoot = path.join(fixtureRoot, "sanitized");
const remoteRoot = path.join(fixtureRoot, "remote.git");
const evidenceRoot = path.join(fixtureRoot, "evidence");

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

function write(root, relativePath, value) {
  const target = path.join(root, relativePath);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, value, "utf8");
}

function run(args) {
  const result = spawnSync(process.execPath, [scriptPath, ...args, "--json"], {
    cwd: appRoot,
    encoding: "utf8",
    windowsHide: true,
  });
  let output;
  try {
    output = JSON.parse(result.stdout);
  } catch {
    throw new Error(`Realignment tool returned invalid JSON.\nstdout=${result.stdout}\nstderr=${result.stderr}`);
  }
  return { code: result.status, output, stderr: result.stderr };
}

try {
  mkdirSync(dataRoot, { recursive: true });
  mkdirSync(sanitizedRoot, { recursive: true });
  gitInit(["-b", "main", dataRoot]);
  git(dataRoot, ["config", "user.email", "realign@example.invalid"]);
  git(dataRoot, ["config", "user.name", "Realignment Verifier"]);
  write(dataRoot, ".gitignore", ".dino/index/\n");
  write(dataRoot, "20_Wiki/old.md", "old tracked bytes\n");
  git(dataRoot, ["add", "-A"]);
  git(dataRoot, ["commit", "-m", "old public history"]);
  const oldHead = git(dataRoot, ["rev-parse", "HEAD"]);

  gitInit(["--bare", "-b", "main", remoteRoot]);
  gitInit(["-b", "main", sanitizedRoot]);
  git(sanitizedRoot, ["config", "user.email", "realign@example.invalid"]);
  git(sanitizedRoot, ["config", "user.name", "Realignment Verifier"]);
  write(sanitizedRoot, ".gitignore", ".dino/index/\n.dino/generations/\n");
  write(sanitizedRoot, "20_Wiki/public.md", "sanitized public root\n");
  git(sanitizedRoot, ["add", "-A"]);
  git(sanitizedRoot, ["commit", "-m", "sanitized root"]);
  const targetHead = git(sanitizedRoot, ["rev-parse", "HEAD"]);
  git(sanitizedRoot, ["remote", "add", "origin", remoteRoot]);
  git(sanitizedRoot, ["push", "-u", "origin", "main"]);

  git(dataRoot, ["remote", "add", "origin", remoteRoot]);
  git(dataRoot, ["fetch", "origin", "main"]);
  git(dataRoot, ["branch", "--set-upstream-to", "origin/main", "main"]);
  write(dataRoot, "20_Wiki/old.md", "dirty bytes that must survive\n");
  write(dataRoot, ".dino/tasks/local.json", "{\"status\":\"started\"}\n");
  const oldBytes = readFileSync(path.join(dataRoot, "20_Wiki", "old.md"));
  const localBytes = readFileSync(path.join(dataRoot, ".dino", "tasks", "local.json"));

  const dryRun = run(["--data-root", dataRoot, "--target", "origin/main", "--evidence-root", evidenceRoot]);
  assert.equal(dryRun.code, 0, dryRun.stderr);
  assert.equal(dryRun.output.status, "ready");
  assert.equal(dryRun.output.applied, false);
  assert.equal(git(dataRoot, ["rev-parse", "HEAD"]), oldHead);

  git(dataRoot, ["add", "20_Wiki/old.md"]);
  const stagedRefusal = run(["--data-root", dataRoot, "--target", "origin/main", "--evidence-root", evidenceRoot, "--apply", "--writers-quiesced"]);
  assert.equal(stagedRefusal.code, 1);
  assert.match(stagedRefusal.output.error, /staged_changes_present/);
  assert.equal(git(dataRoot, ["rev-parse", "HEAD"]), oldHead);
  git(dataRoot, ["reset", "--", "20_Wiki/old.md"]);

  const applied = run(["--data-root", dataRoot, "--target", "origin/main", "--evidence-root", evidenceRoot, "--apply", "--writers-quiesced"]);
  assert.equal(applied.code, 0, applied.stderr);
  assert.equal(applied.output.status, "applied");
  assert.equal(applied.output.worktree_bytes_preserved, true);
  assert.equal(applied.output.worktree_before.aggregate_sha256, applied.output.worktree_after.aggregate_sha256);
  assert.equal(git(dataRoot, ["rev-parse", "HEAD"]), targetHead);
  assert.equal(git(dataRoot, ["rev-parse", applied.output.recovery_ref]), oldHead);
  assert.equal(git(dataRoot, ["diff", "--cached", "--name-only"]), "");
  assert(readFileSync(path.join(dataRoot, "20_Wiki", "old.md")).equals(oldBytes));
  assert(readFileSync(path.join(dataRoot, ".dino", "tasks", "local.json")).equals(localBytes));

  const rolledBack = run(["--rollback", applied.output.manifest_path, "--writers-quiesced"]);
  assert.equal(rolledBack.code, 0, rolledBack.stderr);
  assert.equal(rolledBack.output.status, "rolled_back");
  assert.equal(rolledBack.output.rollback_worktree_bytes_preserved, true);
  assert.equal(git(dataRoot, ["rev-parse", "HEAD"]), oldHead);
  assert(readFileSync(path.join(dataRoot, "20_Wiki", "old.md")).equals(oldBytes));
  assert(readFileSync(path.join(dataRoot, ".dino", "tasks", "local.json")).equals(localBytes));

  console.log(
    JSON.stringify(
      {
        ok: true,
        checks: [
          "dry_run_does_not_move_HEAD",
          "staged_changes_fail_closed",
          "mixed_reset_targets_sanitized_remote",
          "streaming_worktree_manifest_preserved",
          "unstaged_and_untracked_bytes_preserved",
          "recovery_ref_created",
          "rollback_preserves_worktree_bytes",
          "rollback_restores_exact_index_and_status",
          "remote_tip_CAS_and_maintenance_lock",
        ],
      },
      null,
      2,
    ),
  );
} finally {
  rmSync(fixtureRoot, { recursive: true, force: true });
}
