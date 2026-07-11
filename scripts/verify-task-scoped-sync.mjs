import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { scanDataText } from "../dist/data-classification.js";
import { validatePublicSyncReceipt } from "../dist/public-sync-receipt.js";
import {
  TASK_SYNC_SCOPE_VERSION,
  registerTaskSyncPaths,
  taskSyncScopeRelativePath,
} from "../dist/task-sync-scope.js";
import { classifyPrePushGitHistory } from "./lib/data-classifier-git.mjs";
import { DINOBRAIN_VERSION } from "./lib/version-manifest.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const serverPath = path.join(root, "dist", "index.js");
const fixtureRoot = mkdtempSync(path.join(tmpdir(), "dinobrain-task-sync-"));
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

function gitWithInput(cwd, args, input) {
  return execFileSync("git", ["-c", `safe.directory=${cwd}`, "-C", cwd, ...args], {
    input,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  }).trim();
}

function write(relativePath, value) {
  const target = path.join(dataRoot, relativePath);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, value, "utf8");
}

function parseTool(result) {
  const text = result.content?.find((part) => part.type === "text")?.text;
  if (!text) throw new Error("MCP tool did not return JSON text");
  return JSON.parse(text);
}

function assertNoMachineLocalPath(relativePath) {
  const text = readFileSync(path.join(dataRoot, relativePath), "utf8");
  const findings = scanDataText(text).filter((finding) => finding.category === "machine_local");
  assert.deepEqual(findings, [], `${relativePath} retained machine-local path material`);
  assert.equal(text.includes("sample-user"), false, `${relativePath} retained the fixture user name`);
}

async function callAutoSync(client, taskId, allowedPaths, options = {}) {
  return parseTool(
    await client.callTool({
      name: "auto_sync",
      arguments: {
        task_id: taskId,
        allowed_paths: allowedPaths,
        include_sensitive_scan: true,
        allow_conditional: true,
        push: options.push ?? false,
        commit_message: options.message ?? "data: task-scoped sync verifier",
      },
    }),
  );
}

for (const dir of [
  "00_Home",
  "20_Wiki",
  "30_Sources",
  "40_Projects",
  "50_Instances/accepted",
  "60_Operations",
  "70_Error_Book",
  "80_Review_Queue",
  ".dino",
]) {
  mkdirSync(path.join(dataRoot, dir), { recursive: true });
}

write(".gitignore", ".dino/sync-scopes/\n.dino/index/\n.dino/locks/\n.dino/tmp/\n");
write("20_Wiki/baseline.md", "# Baseline\n\nCommitted fixture content.\n");
write("20_Wiki/neighbor.md", "# Neighbor\n\nCommitted neighboring content.\n");

gitInit(["-b", "main", dataRoot]);
gitInit(["--bare", "-b", "main", remoteRoot]);
git(dataRoot, ["config", "user.email", "safe02@example.invalid"]);
git(dataRoot, ["config", "user.name", "SAFE-02 Verifier"]);
mkdirSync(path.join(dataRoot, ".git", "hooks-disabled"), { recursive: true });
git(dataRoot, ["config", "core.hooksPath", ".git/hooks-disabled"]);
git(dataRoot, ["add", ".gitignore", "20_Wiki/baseline.md", "20_Wiki/neighbor.md"]);
git(dataRoot, ["commit", "-m", "fixture baseline"]);
git(dataRoot, ["remote", "add", "origin", remoteRoot]);
git(dataRoot, ["push", "-u", "origin", "main"]);

const client = new Client({ name: "dinobrain-task-sync-verifier", version: DINOBRAIN_VERSION });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [serverPath],
  cwd: root,
  env: {
    ...process.env,
    DINOBRAIN_DATA_DIR: dataRoot,
    DINOBRAIN_AUTO_SYNC: "0",
    DINOBRAIN_AUTO_COMPOUND: "0",
  },
  stderr: "pipe",
});

try {
  await client.connect(transport);
  const machineLocalPath = "C:\\Users\\sample-user\\private\\notes.md";
  const task = parseTool(
    await client.callTool({
      name: "os_begin_task",
      arguments: {
        request: `Verify SAFE-02 task-scoped automatic synchronization using ${machineLocalPath}`,
        project: machineLocalPath,
        mode: "standard",
        sensitivity: "normal",
        launch_kind: "verification_fixture",
        prompt_surface: machineLocalPath,
        task_type: machineLocalPath,
        launch_source: machineLocalPath,
        owner_id: machineLocalPath,
      },
    }),
  );
  assert(task.task_id, "os_begin_task did not return a task id");
  assert.equal(task.task_id.includes("sample-user"), false, "task id leaked request path material");
  assert.equal(task.context_pack.pack_id.includes("sample-user"), false, "Context Pack id leaked question path material");
  assertNoMachineLocalPath(task.task_path);
  assertNoMachineLocalPath(task.context_pack.trace_path);
  assertNoMachineLocalPath(task.gate_report_path);
  const scopePath = taskSyncScopeRelativePath(task.task_id);
  assert(existsSync(path.join(dataRoot, scopePath)), "start_task did not create an authoritative task scope");
  assert.equal(git(dataRoot, ["check-ignore", scopePath]), scopePath, "task scope is not local-only/ignored");

  let missingAllowlistRejected = false;
  try {
    const result = await client.callTool({
      name: "auto_sync",
      arguments: { task_id: task.task_id, push: false },
    });
    missingAllowlistRejected = result.isError === true;
  } catch {
    missingAllowlistRejected = true;
  }
  assert(missingAllowlistRejected, "auto_sync accepted a missing/empty allowlist");

  write("20_Wiki/pending.md", "# Pending\n\nThis artifact has not passed review.\n");
  await registerTaskSyncPaths({
    dataRoot,
    taskId: task.task_id,
    paths: ["20_Wiki/pending.md"],
    source: "safe02-verifier:pending",
    approval: "pending_review",
  });
  const pending = await callAutoSync(client, task.task_id, ["20_Wiki/pending.md"]);
  assert.equal(pending.state, "blocked");
  assert(pending.scope?.reason_codes?.includes("requested_path_review_pending"));

  write("20_Wiki/unscoped.md", "# Unscoped\n\nThis file was never registered by the task.\n");
  const unscoped = await callAutoSync(client, task.task_id, ["20_Wiki/unscoped.md"]);
  assert.equal(unscoped.state, "blocked");
  assert(unscoped.scope?.reason_codes?.includes("requested_path_outside_task_scope"));

  write("20_Wiki/tampered.md", "# Tamper target\n\nOriginal reviewed bytes.\n");
  await registerTaskSyncPaths({
    dataRoot,
    taskId: task.task_id,
    paths: ["20_Wiki/tampered.md"],
    source: "safe02-verifier:reviewed",
    approval: "reviewed",
  });
  write("20_Wiki/tampered.md", "# Tamper target\n\nBytes changed after review.\n");
  const tampered = await callAutoSync(client, task.task_id, ["20_Wiki/tampered.md"]);
  assert.equal(tampered.state, "blocked");
  assert(tampered.scope?.reason_codes?.includes("task_scope_hash_mismatch"));

  write("20_Wiki/downgraded.md", "# Downgrade target\n\nOriginally reviewed bytes.\n");
  await registerTaskSyncPaths({
    dataRoot,
    taskId: task.task_id,
    paths: ["20_Wiki/downgraded.md"],
    source: "safe02-verifier:reviewed",
    approval: "reviewed",
  });
  write("20_Wiki/downgraded.md", "# Downgrade target\n\nChanged bytes require another review.\n");
  await registerTaskSyncPaths({
    dataRoot,
    taskId: task.task_id,
    paths: ["20_Wiki/downgraded.md"],
    source: "safe02-verifier:changed-pending",
    approval: "pending_review",
  });
  const downgraded = await callAutoSync(client, task.task_id, ["20_Wiki/downgraded.md"]);
  assert.equal(downgraded.state, "blocked");
  assert(downgraded.scope?.reason_codes?.includes("requested_path_review_pending"));

  const fakeToken = ["github", "pat", "SAFE02", "abcdefghijklmnopqrstuvwxyz0123456789"].join("_");
  write("20_Wiki/sensitive.md", `# Sensitive\n\n${fakeToken}\n`);
  await registerTaskSyncPaths({
    dataRoot,
    taskId: task.task_id,
    paths: ["20_Wiki/sensitive.md"],
    source: "safe02-verifier:compromised-reviewed-input",
    approval: "reviewed",
  });
  const sensitive = await callAutoSync(client, task.task_id, ["20_Wiki/sensitive.md"]);
  assert.equal(sensitive.state, "blocked");
  assert.equal(sensitive.unresolved_paths?.[0]?.classification, "blocked");

  write("20_Wiki/success.md", "# Success\n\nOnly this reviewed artifact may be committed.\n");
  await registerTaskSyncPaths({
    dataRoot,
    taskId: task.task_id,
    paths: ["20_Wiki/success.md"],
    source: "safe02-verifier:reviewed",
    approval: "reviewed",
  });
  const currentScope = JSON.parse(readFileSync(path.join(dataRoot, scopePath), "utf8"));
  const successScopeEntry = currentScope.entries.find((entry) => entry.path === "20_Wiki/success.md");
  assert.match(successScopeEntry?.git_blob_oid ?? "", /^[a-f0-9]{40,64}$/);
  write("20_Wiki/neighbor.md", "# Neighbor\n\nDirty neighboring backlog must remain untouched.\n");
  git(dataRoot, ["add", "20_Wiki/neighbor.md"]);
  const stagedConflict = await callAutoSync(client, task.task_id, ["20_Wiki/success.md"]);
  assert.equal(stagedConflict.state, "blocked");
  assert.equal(stagedConflict.reason, "disallowed_files_already_staged");
  assert(stagedConflict.disallowed_staged_paths?.includes("20_Wiki/neighbor.md"));
  git(dataRoot, ["reset", "--", "20_Wiki/neighbor.md"]);

  const pushed = await callAutoSync(client, task.task_id, ["20_Wiki/success.md"], {
    push: true,
    message: "data: verify scoped success",
  });
  assert.equal(pushed.ok, true);
  assert.equal(pushed.state, "pushed");
  assert.equal(pushed.committed, true);
  assert.equal(pushed.pushed, true);
  assert.equal(pushed.sync_scope, "task_scope");
  assert.deepEqual(pushed.allowed_paths, ["20_Wiki/success.md"]);
  assert(Number(pushed.out_of_scope_changed_count) > 0, "neighboring backlog was not observed as out of scope");
  const committedPaths = git(dataRoot, ["diff-tree", "--no-commit-id", "--name-only", "-r", pushed.commit])
    .split(/\r?\n/)
    .filter(Boolean);
  assert.deepEqual(committedPaths, ["20_Wiki/success.md"]);
  assert(readFileSync(path.join(remoteRoot, "refs", "heads", "main"), "utf8").trim() === pushed.commit);
  assert(git(remoteRoot, ["show", "main:20_Wiki/success.md"]).includes("Only this reviewed artifact"));
  assert(git(dataRoot, ["status", "--short", "--", "20_Wiki/neighbor.md"]).startsWith("M "));

  const conditionalPath = ".dino/proofs/task-scoped-public-receipt.json";
  write(conditionalPath, `${JSON.stringify({ status: "verified", proof: "conditional artifact receipt" }, null, 2)}\n`);
  await registerTaskSyncPaths({
    dataRoot,
    taskId: task.task_id,
    paths: [conditionalPath],
    source: "safe02-verifier:system-proof",
    approval: "system_verified",
  });
  const receipted = await callAutoSync(client, task.task_id, [task.task_path, conditionalPath], {
    push: true,
    message: "data: verify conditional receipt",
  });
  assert.equal(receipted.ok, true, JSON.stringify(receipted));
  assert.equal(receipted.state, "pushed");
  assert.equal(receipted.public_sync_receipt?.conditional_path_count, 2);
  const receiptPath = receipted.public_sync_receipt?.path;
  assert.match(receiptPath ?? "", /^60_Operations\/task-sync-receipts\/task-sync-receipt-[a-f0-9]{64}\.json$/);
  const receiptText = git(remoteRoot, ["show", `main:${receiptPath}`]);
  const receiptValidation = validatePublicSyncReceipt(JSON.parse(receiptText));
  assert.equal(receiptValidation.ok, true, receiptValidation.errors.join(","));
  assert.deepEqual(receiptValidation.receipt.conditional_paths, [conditionalPath, task.task_path].sort());
  const receiptedCommitPaths = git(dataRoot, ["diff-tree", "--no-commit-id", "--name-only", "-r", receipted.commit])
    .split(/\r?\n/)
    .filter(Boolean)
    .sort();
  assert.deepEqual(receiptedCommitPaths, [conditionalPath, task.task_path, receiptPath].sort());
  const receiptedMessage = git(dataRoot, ["show", "-s", "--format=%B", receipted.commit]);
  assert(receiptedMessage.includes(`DinoBrain-Task-Id: ${task.task_id}`));
  assert(receiptedMessage.includes(`DinoBrain-Sync-Receipt: ${receiptPath}`));
  const prePushReceiptProof = classifyPrePushGitHistory(
    dataRoot,
    `refs/heads/main ${receipted.commit} refs/heads/main ${pushed.commit}\n`,
  );
  assert.equal(prePushReceiptProof.ok, true, JSON.stringify(prePushReceiptProof.blocker_examples));
  assert.equal(prePushReceiptProof.public_sync_receipts[0]?.verified, true);
  const receiptedTree = git(dataRoot, ["rev-parse", `${receipted.commit}^{tree}`]);
  const receiptedParent = git(dataRoot, ["rev-parse", `${receipted.commit}^`]);
  const missingTrailerCommit = gitWithInput(
    dataRoot,
    ["commit-tree", receiptedTree, "-p", receiptedParent],
    "data: tampered commit without receipt trailers\n",
  );
  const missingTrailerProof = classifyPrePushGitHistory(
    dataRoot,
    `refs/heads/tampered ${missingTrailerCommit} refs/heads/tampered ${receiptedParent}\n`,
  );
  assert.equal(missingTrailerProof.ok, false);
  assert(
    missingTrailerProof.blocker_examples.some((entry) =>
      entry.findings.some((finding) => finding.id.startsWith("public_sync_commit_trailer_invalid")),
    ),
  );

  const rejectedAbsoluteVaultPath = await client.callTool({
    name: "finish_task",
    arguments: {
      task_id: task.task_id,
      lease_id: task.lease.lease_id,
      summary: "Reject absolute vault path input before terminal persistence.",
      outcome: "completed",
      growth_policy: "trace_only",
      used_memory_paths: ["/home/sample-user/private/memory.json"],
    },
  });
  assert.equal(rejectedAbsoluteVaultPath.isError, true, "absolute vault path was normalized into a relative trace path");

  const finish = parseTool(
    await client.callTool({
      name: "finish_task",
      arguments: {
        task_id: task.task_id,
        lease_id: task.lease.lease_id,
        terminal_owner_id: machineLocalPath,
        summary: `Verified scoped sync from ${machineLocalPath}`,
        outcome: "completed",
        growth_policy: "trace_only",
        changed_files: [machineLocalPath],
        decisions: [`Do not publish ${machineLocalPath}`],
        next_steps: ["Keep /home/sample-user/private/next.md local."],
        context_pack_paths: [task.context_pack.trace_path],
        used_memory_paths: [],
        search_queries: [`Find ${machineLocalPath}`],
      },
    }),
  );
  assert.equal(finish.ok, true);
  assertNoMachineLocalPath(finish.trace_path);
  const finishTrace = JSON.parse(readFileSync(path.join(dataRoot, finish.trace_path), "utf8"));
  assert(finishTrace.output_redactions.includes("windows_user_path"));
  assert(finishTrace.output_redactions.includes("posix_user_path"));

  const noOp = await callAutoSync(client, task.task_id, ["20_Wiki/success.md"], { push: true });
  assert.equal(noOp.ok, true);
  assert.equal(noOp.state, "no_op");
  assert.equal(noOp.committed, false);

  write("20_Wiki/retry.md", "# Retry\n\nThe commit must survive an unavailable remote.\n");
  await registerTaskSyncPaths({
    dataRoot,
    taskId: task.task_id,
    paths: ["20_Wiki/retry.md"],
    source: "safe02-verifier:reviewed",
    approval: "reviewed",
  });
  git(dataRoot, ["remote", "remove", "origin"]);
  const retry = await callAutoSync(client, task.task_id, ["20_Wiki/retry.md"], {
    push: true,
    message: "data: verify retry state",
  });
  assert.equal(retry.ok, false);
  assert.equal(retry.state, "retry_required");
  assert.equal(retry.reason, "push_failed_after_commit");
  assert.equal(retry.retry_stage, "push");
  assert.equal(retry.committed, true);
  assert.match(retry.commit, /^[a-f0-9]{40}$/);
  assert.deepEqual(
    git(dataRoot, ["diff-tree", "--no-commit-id", "--name-only", "-r", retry.commit])
      .split(/\r?\n/)
      .filter(Boolean),
    ["20_Wiki/retry.md"],
  );
  assert(git(dataRoot, ["status", "--short", "--", "20_Wiki/neighbor.md"]).startsWith("M "));

  console.log(
    JSON.stringify(
      {
        ok: true,
        scope_version: TASK_SYNC_SCOPE_VERSION,
        pushed_commit: pushed.commit,
        retry_commit: retry.commit,
        checks: [
          "nonempty_allowlist_required",
          "local_only_task_scope",
          "pending_review_blocked",
          "out_of_scope_blocked",
          "post_review_tamper_blocked",
          "changed_content_downgrades_prior_approval",
          "git_filtered_blob_identity_bound",
          "sensitive_content_blocked",
          "preexisting_staged_file_blocked",
          "single_scoped_file_committed_and_pushed",
          "conditional_artifacts_bound_to_public_receipt",
          "task_record_committed_with_conditional_artifacts",
          "receipt_commit_trailers_verified",
          "pre_push_receipt_reverification",
          "missing_receipt_trailers_blocked",
          "neighboring_backlog_preserved",
          "no_op_state",
          "push_failure_returns_retry_with_commit",
          "task_context_gate_machine_paths_redacted",
          "finish_trace_machine_paths_redacted",
        ],
      },
      null,
      2,
    ),
  );
} finally {
  await client.close().catch(() => undefined);
  rmSync(fixtureRoot, { recursive: true, force: true });
}
