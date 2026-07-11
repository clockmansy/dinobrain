import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { classifyCompleteGitHistory } from "./lib/data-classifier-git.mjs";
import {
  applyPublicDataHistoryMigration,
  preparePublicDataHistoryMigration,
  rollbackPublicDataHistoryMigration,
} from "./lib/public-data-history-migration.mjs";

function git(repo, args) {
  return execFileSync("git", ["-c", `safe.directory=${repo}`, "-C", repo, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  }).trim();
}

function write(repo, relativePath, value) {
  const target = path.join(repo, relativePath);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, value, "utf8");
}

const root = mkdtempSync(path.join(tmpdir(), "dinobrain-public-history-"));
const seed = path.join(root, "seed");
const remote = path.join(root, "remote.git");
const source = path.join(root, "source");
const output = path.join(root, "migrations");
const verifyClone = path.join(root, "verify-clone");

try {
  mkdirSync(seed, { recursive: true });
  execFileSync("git", ["init", "--bare", remote], { stdio: "pipe", windowsHide: true });
  git(seed, ["init", "-b", "main"]);
  git(seed, ["config", "user.name", "Public History Verifier"]);
  git(seed, ["config", "user.email", "public-history@example.invalid"]);
  write(seed, ".gitignore", ".dino/index/\n");
  write(seed, ".gitattributes", "*.json text eol=lf\n");
  write(seed, "20_Wiki/history.md", "github_pat_SAFE01_abcdefghijklmnopqrstuvwxyz0123456789\n");
  write(
    seed,
    ".dino/evaluations/rag-golden.json",
    `${JSON.stringify({ forbidden_terms: ["message_content_stored: true"] }, null, 2)}\n`,
  );
  write(
    seed,
    ".dino/context-packs/nested-prompt.json",
    `${JSON.stringify({ question: JSON.stringify({ cwd: "C:\\Users\\sample-user\\Documents\\dinobrain" }) }, null, 2)}\n`,
  );
  write(
    seed,
    "50_Instances/accepted/reviewed.json",
    `${JSON.stringify({ status: "accepted", auto_generated: true, reviewed_by: "history-verifier" }, null, 2)}\n`,
  );
  write(
    seed,
    `60_Operations/${"deep-history-segment/".repeat(10)}long-path-regression.md`,
    "Long Windows paths must survive the isolated checkout.\n",
  );
  for (let index = 0; index < 260; index += 1) {
    write(seed, `20_Wiki/batch/record-${String(index).padStart(3, "0")}.md`, `Reviewed batch record ${index}.\n`);
  }
  git(seed, ["add", "-A"]);
  git(seed, ["commit", "-m", "unsafe historical token"]);
  write(seed, "20_Wiki/history.md", "Workspace was C:\\Users\\sample-user\\Documents\\dinobrain-data\\20_Wiki\\history.md\n");
  git(seed, ["add", "20_Wiki/history.md"]);
  git(seed, ["commit", "-m", "replace token with machine path"]);
  const originalHead = git(seed, ["rev-parse", "HEAD"]);
  git(seed, ["remote", "add", "origin", remote]);
  git(seed, ["push", "-u", "origin", "main"]);
  execFileSync("git", ["clone", "--no-local", remote, source], { stdio: "pipe", windowsHide: true });

  const prepared = preparePublicDataHistoryMigration({ sourceRepo: source, sourceRef: "origin/main", outputRoot: output });
  const manifest = prepared.manifest;
  assert.equal(manifest.status, "prepared");
  assert.equal(manifest.source.head, originalHead);
  assert(manifest.source.history.summary.blocked > 0);
  assert.equal(manifest.sanitized.snapshot.blocker_count, 0);
  assert.equal(manifest.sanitized.history.summary.blocked, 0);
  assert.equal(manifest.sanitized.pre_push.summary.blocked, 0);
  assert.equal(git(manifest.sanitized.repository, ["rev-list", "--count", "HEAD"]), "1");
  assert.equal(git(source, ["rev-parse", "HEAD"]), originalHead);
  assert(!readFileSync(path.join(manifest.sanitized.repository, "20_Wiki", "history.md"), "utf8").includes("C:\\"));
  const nestedPrompt = JSON.parse(
    readFileSync(path.join(manifest.sanitized.repository, ".dino", "context-packs", "nested-prompt.json"), "utf8"),
  );
  assert(JSON.parse(nestedPrompt.question).cwd.includes("<machine-local-path>"));
  assert(readFileSync(path.join(manifest.sanitized.repository, ".gitignore"), "utf8").includes(".dino/generations/"));
  assert.throws(
    () => applyPublicDataHistoryMigration(prepared.manifestPath, "0".repeat(40)),
    /source_head_confirmation_mismatch/,
  );

  const applied = applyPublicDataHistoryMigration(prepared.manifestPath, originalHead);
  assert.equal(applied.manifest.status, "applied");
  assert.equal(git(remote, ["rev-parse", "refs/heads/main"]), manifest.sanitized.head);
  execFileSync("git", ["clone", "--no-local", remote, verifyClone], { stdio: "pipe", windowsHide: true });
  assert.equal(git(verifyClone, ["rev-list", "--count", "HEAD"]), "1");
  assert.equal(classifyCompleteGitHistory(verifyClone).ok, true);
  assert.throws(
    () => rollbackPublicDataHistoryMigration(prepared.manifestPath, "0".repeat(40)),
    /sanitized_head_confirmation_mismatch/,
  );

  const rolledBack = rollbackPublicDataHistoryMigration(prepared.manifestPath, manifest.sanitized.head);
  assert.equal(rolledBack.manifest.status, "rolled_back");
  assert.equal(git(remote, ["rev-parse", "refs/heads/main"]), originalHead);
  git(manifest.backup.repository, ["bundle", "verify", manifest.backup.bundle_path]);

  console.log(
    JSON.stringify(
      {
        ok: true,
        original_head: originalHead,
        sanitized_head: manifest.sanitized.head,
        source_history_blockers: manifest.source.history.summary.blocked,
        sanitized_history_blockers: manifest.sanitized.history.summary.blocked,
        changed_files: manifest.mutation.changed_file_count,
        force_with_lease_apply: true,
        exact_remote_rollback: true,
        source_worktree_untouched: true,
      },
      null,
      2,
    ),
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}
