import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  DATA_CLASSIFICATION_POLICY_VERSION,
  PUBLIC_DATA_MAX_SCAN_BYTES,
  classifyDataFile,
} from "../dist/data-classification.js";
import {
  classifyCompleteGitHistory,
  classifyPrePushGitHistory,
  classifyStagedGitFiles,
} from "./lib/data-classifier-git.mjs";

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
  writeFileSync(target, value);
}

function classify(relativePath, value, options = {}) {
  const content = value == null ? null : Buffer.isBuffer(value) ? value : Buffer.from(value, "utf8");
  return classifyDataFile({ relativePath, content, sizeBytes: options.sizeBytes ?? content?.length ?? 0 });
}

function hasFinding(result, id) {
  return result.findings.some((finding) => finding.id === id);
}

const fakeToken = ["github", "pat", "SAFE01", "abcdefghijklmnopqrstuvwxyz0123456789"].join("_");
const localPath = ["C:", "Users", "sample-user", "private", "notes.md"].join("\\");
const rawTranscript = JSON.stringify({ response_item: { content: "raw conversation material" } });

const indexSource = readFileSync(path.resolve("src/index.ts"), "utf8");
const publicSafetySource = readFileSync(path.resolve("scripts/verify-public-data-safety.mjs"), "utf8");
const installerSource = readFileSync(path.resolve("scripts/install-data-git-hooks.ps1"), "utf8");
assert(indexSource.includes('from "./data-classification.js"'));
assert(!indexSource.includes("function classifyPath("));
assert(publicSafetySource.includes('from "../dist/data-classification.js"'));
assert(!publicSafetySource.includes("const blockedPathRules"));
assert(installerSource.includes("dinobrain-classifier.json"));

const clean = classify("20_Wiki/clean.md", "Reviewed public-safe knowledge.\n");
assert.equal(clean.classification, "syncable");
assert.equal(clean.scan.complete, true);
assert.equal(clean.policy_version, DATA_CLASSIFICATION_POLICY_VERSION);

const disabledScan = classifyDataFile({
  relativePath: "20_Wiki/scan-disabled.md",
  content: null,
  sizeBytes: 32,
  scanContent: false,
});
assert.equal(disabledScan.classification, "blocked");
assert(hasFinding(disabledScan, "content_scan_required"));

const conditional = classify(".dino/evaluations/report.json", '{"status":"healthy"}\n');
assert.equal(conditional.classification, "conditional");
assert.equal(conditional.explicit_allowlist, true);

assert.equal(classify("10_Conversations/raw/session.json", "{}\n").classification, "blocked");
assert.equal(classify(".dino/restore-receipts/restore.json", "{}\n").classification, "blocked");
assert.equal(classify(".dino/restore-staging/private.bin", Buffer.from([0x00])).classification, "blocked");
const unclassified = classify("misc/unclassified.md", "unknown root\n");
assert.equal(unclassified.classification, "blocked");
assert.equal(unclassified.explicit_allowlist, false);

const secret = classify("20_Wiki/secret.md", `${fakeToken}\n`);
assert.equal(secret.classification, "blocked");
assert(hasFinding(secret, "github_token_shape"));

const machineLocal = classify("20_Wiki/local.md", `${localPath}\n`);
assert.equal(machineLocal.classification, "blocked");
assert(hasFinding(machineLocal, "windows_user_path"));

const transcript = classify("20_Wiki/transcript.json", rawTranscript);
assert.equal(transcript.classification, "blocked");
assert(hasFinding(transcript, "codex_rollout_item"));

const oversized = classifyDataFile({
  relativePath: "20_Wiki/oversized.md",
  content: null,
  sizeBytes: PUBLIC_DATA_MAX_SCAN_BYTES + 1,
});
assert.equal(oversized.classification, "blocked");
assert(hasFinding(oversized, "file_exceeds_complete_scan_limit"));
assert.equal(oversized.scan.complete, false);

const undecodable = classify("20_Wiki/undecodable.md", Buffer.from([0xc3, 0x28]));
assert.equal(undecodable.classification, "blocked");
assert(hasFinding(undecodable, "content_not_strict_utf8"));

const binary = classify("20_Wiki/attachment.bin", Buffer.from([0x00, 0x01, 0x02]));
assert.equal(binary.classification, "blocked");
assert(hasFinding(binary, "unsupported_or_binary_file_type"));

const symlink = classifyDataFile({
  relativePath: "20_Wiki/link.md",
  content: Buffer.from("../private/file.md", "utf8"),
  sizeBytes: 18,
  fileKind: "symlink",
});
assert.equal(symlink.classification, "blocked");
assert(hasFinding(symlink, "unsupported_file_kind"));

const invalidJson = classify("40_Projects/invalid.json", "{not-json}\n");
assert.equal(invalidJson.classification, "blocked");
assert(hasFinding(invalidJson, "invalid_json"));

const unreviewed = classify(
  "50_Instances/accepted/unreviewed.json",
  JSON.stringify({ status: "accepted", auto_generated: true, claim: "missing review" }),
);
assert.equal(unreviewed.classification, "blocked");
assert(hasFinding(unreviewed, "auto_generated_accepted_without_review_lineage"));

const reviewed = classify(
  "50_Instances/accepted/reviewed.json",
  JSON.stringify({ status: "accepted", auto_generated: true, reviewed_by: "safe01-verifier", claim: "reviewed" }),
);
assert.equal(reviewed.classification, "syncable");

const repo = mkdtempSync(path.join(tmpdir(), "dinobrain-unified-classifier-"));
try {
  git(repo, ["init"]);
  git(repo, ["config", "user.email", "safe01@example.invalid"]);
  git(repo, ["config", "user.name", "SAFE-01 Verifier"]);

  write(repo, "20_Wiki/history.md", "clean baseline\n");
  git(repo, ["add", "20_Wiki/history.md"]);
  const stagedClean = classifyStagedGitFiles(repo);
  assert.equal(stagedClean.ok, true);
  assert.equal(stagedClean.policy_version, DATA_CLASSIFICATION_POLICY_VERSION);
  assert.equal(stagedClean.summary.syncable, 1);
  git(repo, ["commit", "-m", "base"]);
  const base = git(repo, ["rev-parse", "HEAD"]);

  write(repo, "20_Wiki/history.md", `${fakeToken}\n`);
  git(repo, ["add", "20_Wiki/history.md"]);
  const stagedSecret = classifyStagedGitFiles(repo);
  assert.equal(stagedSecret.ok, false);
  assert.equal(stagedSecret.summary.blocked, 1);
  assert(stagedSecret.blocker_examples[0].findings.some((finding) => finding.id === "github_token_shape"));
  git(repo, ["commit", "--no-verify", "-m", "inject secret"]);

  write(repo, "20_Wiki/history.md", "clean again\n");
  git(repo, ["add", "20_Wiki/history.md"]);
  git(repo, ["commit", "--no-verify", "-m", "remove secret"]);
  const head = git(repo, ["rev-parse", "HEAD"]);
  const pushLine = `refs/heads/main ${head} refs/heads/main ${base}\n`;
  const pushReport = classifyPrePushGitHistory(repo, pushLine);
  assert.equal(pushReport.ok, false);
  assert.equal(pushReport.commit_count, 2);
  assert(pushReport.blocker_examples.some((entry) => entry.findings.some((finding) => finding.id === "github_token_shape")));

  const fullHistory = classifyCompleteGitHistory(repo);
  assert.equal(fullHistory.ok, false);
  assert(fullHistory.blocker_examples.some((entry) => entry.findings.some((finding) => finding.id === "github_token_shape")));
} finally {
  rmSync(repo, { recursive: true, force: true });
}

console.log(
  JSON.stringify(
    {
      ok: true,
      policy_version: DATA_CLASSIFICATION_POLICY_VERSION,
      checks: [
        "explicit_path_allowlist",
        "single_engine_source_wiring",
        "mandatory_content_scan",
        "conditional_path_consistency",
        "secret_detection",
        "machine_local_detection",
        "raw_transcript_detection",
        "private_restore_runtime_paths_blocked",
        "large_file_fail_closed",
        "unsupported_binary_fail_closed",
        "symlink_fail_closed",
        "strict_utf8_fail_closed",
        "structured_parse_fail_closed",
        "review_lineage",
        "staged_surface_parity",
        "history_injected_secret_after_removal",
        "complete_history_scan",
      ],
    },
    null,
    2,
  ),
);
