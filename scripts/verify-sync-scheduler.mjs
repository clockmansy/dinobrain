import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distRoot = path.resolve(process.env.DINOBRAIN_SYNC_DIST || path.join(root, "dist"));
const taskScope = await import(pathToFileURL(path.join(distRoot, "task-sync-scope.js")).href);
const scheduler = await import(pathToFileURL(path.join(distRoot, "observatory-sync-state.js")).href);
const receipts = await import(pathToFileURL(path.join(distRoot, "public-sync-receipt.js")).href);

const evidenceRoot = mkdtempSync(path.join(tmpdir(), "dinobrain-sync-scheduler-"));

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

function write(dataRoot, relativePath, value) {
  const target = path.join(dataRoot, ...relativePath.split("/"));
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, value, "utf8");
}

function makeFixture(label) {
  const fixtureRoot = path.join(evidenceRoot, label);
  const dataRoot = path.join(fixtureRoot, "data");
  const originRoot = path.join(fixtureRoot, "origin.git");
  const productionSentinelRoot = path.join(fixtureRoot, "production-sentinel.git");
  mkdirSync(dataRoot, { recursive: true });
  write(dataRoot, ".gitignore", ".dino/sync-scopes/\n.dino/sync-scheduler/\n.dino/locks/\n");
  write(dataRoot, "20_Wiki/baseline.md", "# Baseline\n");
  write(dataRoot, "20_Wiki/neighbor.md", "# Neighbor\n\nCommitted fixture neighbor.\n");
  gitInit(["-b", "main", dataRoot]);
  gitInit(["--bare", "-b", "main", originRoot]);
  gitInit(["--bare", "-b", "main", productionSentinelRoot]);
  git(dataRoot, ["config", "user.email", "scheduler@example.invalid"]);
  git(dataRoot, ["config", "user.name", "LC-08 Verifier"]);
  mkdirSync(path.join(dataRoot, ".git", "hooks-disabled"), { recursive: true });
  git(dataRoot, ["config", "core.hooksPath", ".git/hooks-disabled"]);
  git(dataRoot, ["add", ".gitignore", "20_Wiki/baseline.md", "20_Wiki/neighbor.md"]);
  git(dataRoot, ["commit", "-m", "fixture baseline"]);
  git(dataRoot, ["remote", "add", "origin", originRoot]);
  git(dataRoot, ["remote", "add", "production", productionSentinelRoot]);
  git(dataRoot, ["push", "-u", "origin", "main"]);
  git(dataRoot, ["push", "production", "main"]);
  const taskId = `task-${label}`;
  write(
    dataRoot,
    `.dino/tasks/${taskId}.json`,
    `${JSON.stringify({ task_id: taskId, request_hash: "a".repeat(64) }, null, 2)}\n`,
  );
  return {
    fixtureRoot,
    dataRoot,
    originRoot,
    productionSentinelRoot,
    productionHead: readFileSync(path.join(productionSentinelRoot, "refs", "heads", "main"), "utf8").trim(),
    taskId,
  };
}

function exactExecutor(fixture, counter = null, delayMs = 0) {
  return async (batch) => {
    assert.equal(batch.remote, "origin", "scheduler selected a non-fixture remote");
    assert(batch.items.length > 0);
    if (counter) counter.calls += 1;
    if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
    const paths = batch.items.map((item) => item.path).sort();
    git(fixture.dataRoot, ["add", "--", ...paths]);
    const staged = git(fixture.dataRoot, ["diff", "--cached", "--name-only"])
      .split(/\r?\n/)
      .filter(Boolean)
      .sort();
    assert.deepEqual(staged, paths, "executor staged files outside the scheduler batch");
    git(fixture.dataRoot, ["commit", "-m", `data: lc08 ${batch.attempt_id.slice(0, 12)}`]);
    const commit = git(fixture.dataRoot, ["rev-parse", "HEAD"]);
    git(fixture.dataRoot, ["push", "origin", "HEAD:main"]);
    return {
      outcome: "pushed",
      reason: "fixture_local_remote_pushed",
      pushed: true,
      commit,
      branch: "main",
      remote_ref: "refs/heads/main",
    };
  };
}

function commitBatch(fixture, batch, additionalPaths = [], push = true) {
  const paths = [...batch.items.map((item) => item.path), ...additionalPaths];
  git(fixture.dataRoot, ["add", "--", ...paths]);
  git(fixture.dataRoot, ["commit", "-m", `data: proof fixture ${batch.attempt_id.slice(0, 12)}`]);
  const commit = git(fixture.dataRoot, ["rev-parse", "HEAD"]);
  if (push) git(fixture.dataRoot, ["push", "origin", "HEAD:main"]);
  return { outcome: "pushed", reason: "untrusted_executor_claim", pushed: true, commit, branch: "main", remote_ref: "refs/heads/main" };
}

async function register(fixture, paths, approval = "reviewed") {
  await taskScope.registerTaskSyncPaths({
    dataRoot: fixture.dataRoot,
    taskId: fixture.taskId,
    paths,
    source: "lc08-deterministic-verifier",
    approval,
  });
}

const hour = 60 * 60 * 1_000;
const minute = 60 * 1_000;
const base = Date.UTC(2026, 6, 13, 0, 0, 0);
const checks = [];

async function runRejectedExecutionProof(label, executorFactory) {
  const fixture = makeFixture(label);
  const relativePath = `20_Wiki/${label}.md`;
  write(fixture.dataRoot, relativePath, `# ${label}\n`);
  await register(fixture, [relativePath]);
  await scheduler.enqueueTaskScopedSync({
    dataRoot: fixture.dataRoot,
    taskId: fixture.taskId,
    requestedPaths: [relativePath],
    now: base,
  });
  const result = await scheduler.runAutomaticSyncScheduler({
    dataRoot: fixture.dataRoot,
    lastActivityAt: base,
    now: base + 6 * hour,
    execute: executorFactory(fixture),
  });
  assert.equal(result.executed, true);
  assert.equal(result.outcome, "retry_required");
  assert.equal(result.state.queue.length, 1, `${label} removed queue without independent proof`);
  assert.equal(result.state.automatic_push_history.length, 0);
  assert.match(result.reason_codes[0], /^execution_proof_/);
  assert.equal(
    readFileSync(path.join(fixture.productionSentinelRoot, "refs", "heads", "main"), "utf8").trim(),
    fixture.productionHead,
  );
}

// Durable hash-bound queue, independent classifier, cadence, idle, dirty index,
// process lock, exact staging, and production-remote isolation.
{
  const fixture = makeFixture("core");
  write(fixture.dataRoot, "20_Wiki/safe.md", "# Safe\n\nReviewed scheduler artifact.\n");
  const fakeToken = ["github", "pat", "LC08", "abcdefghijklmnopqrstuvwxyz0123456789"].join("_");
  write(fixture.dataRoot, "20_Wiki/sensitive.md", `# Sensitive\n\n${fakeToken}\n`);
  await register(fixture, ["20_Wiki/safe.md", "20_Wiki/sensitive.md"]);
  const queued = await scheduler.enqueueTaskScopedSync({
    dataRoot: fixture.dataRoot,
    taskId: fixture.taskId,
    requestedPaths: ["20_Wiki/safe.md", "20_Wiki/sensitive.md"],
    now: base,
  });
  assert.deepEqual(queued.queued.map((item) => item.path), ["20_Wiki/safe.md"]);
  assert(queued.resolution.reason_codes.includes("task_sync_candidate_classifier_blocked"));
  assert.match(queued.queued[0].queue_id, /^[a-f0-9]{64}$/);
  assert.match(queued.queued[0].artifact_binding_sha256, /^[a-f0-9]{64}$/);
  assert(existsSync(path.join(fixture.dataRoot, ...scheduler.SYNC_SCHEDULER_STATE_PATH.split("/"))));
  assert.equal((await scheduler.readSyncSchedulerState({ dataRoot: fixture.dataRoot })).queue.length, 1);

  const counter = { calls: 0 };
  const executor = exactExecutor(fixture, counter, 40);
  const coalescing = await scheduler.runAutomaticSyncScheduler({
    dataRoot: fixture.dataRoot,
    lastActivityAt: base - hour,
    now: base + 6 * hour - 1,
    execute: executor,
  });
  assert.equal(coalescing.executed, false);
  assert(coalescing.reason_codes.includes("coalescing"));

  const active = await scheduler.runAutomaticSyncScheduler({
    dataRoot: fixture.dataRoot,
    lastActivityAt: base + 6 * hour - 5 * minute,
    now: base + 6 * hour,
    execute: executor,
  });
  assert.equal(active.executed, false);
  assert(active.reason_codes.includes("user_not_idle"));

  write(fixture.dataRoot, "20_Wiki/neighbor.md", "# Neighbor\n\nDirty user backlog.\n");
  git(fixture.dataRoot, ["add", "20_Wiki/neighbor.md"]);
  const staged = await scheduler.runAutomaticSyncScheduler({
    dataRoot: fixture.dataRoot,
    lastActivityAt: base,
    now: base + 6 * hour + 10 * minute,
    execute: executor,
  });
  assert.equal(staged.executed, false);
  assert(staged.reason_codes.includes("staged_changes_present"));
  git(fixture.dataRoot, ["reset", "--", "20_Wiki/neighbor.md"]);

  const [first, second] = await Promise.all([
    scheduler.runAutomaticSyncScheduler({
      dataRoot: fixture.dataRoot,
      lastActivityAt: base,
      now: base + 6 * hour + 11 * minute,
      execute: executor,
    }),
    scheduler.runAutomaticSyncScheduler({
      dataRoot: fixture.dataRoot,
      lastActivityAt: base,
      now: base + 6 * hour + 11 * minute,
      execute: executor,
    }),
  ]);
  assert.equal(counter.calls, 1, "concurrent scheduler processes executed more than one push");
  assert.equal([first, second].filter((result) => result.executed).length, 1);
  const pushed = [first, second].find((result) => result.executed);
  assert.equal(pushed?.outcome, "pushed");
  const commitPaths = git(fixture.dataRoot, ["diff-tree", "--no-commit-id", "--name-only", "-r", pushed.attempt.commit])
    .split(/\r?\n/)
    .filter(Boolean);
  assert.deepEqual(commitPaths, ["20_Wiki/safe.md"]);
  assert.equal(git(fixture.dataRoot, ["diff", "--name-only", "--", "20_Wiki/neighbor.md"]), "20_Wiki/neighbor.md");
  assert.equal(
    readFileSync(path.join(fixture.productionSentinelRoot, "refs", "heads", "main"), "utf8").trim(),
    fixture.productionHead,
    "production sentinel remote changed",
  );
  const dto = await scheduler.readObservatorySyncState({ dataRoot: fixture.dataRoot, now: base + 7 * hour });
  assert.equal(dto.last_attempt?.outcome, "pushed");
  assert.equal(dto.queued_safe_file_count, 0);
  assert.equal(dto.blocked_count >= 1, true);
  assert.equal(dto.manual_sync.broad_recovery_separate, true);
  checks.push("hash_bound_queue_classifier_cadence_idle_lock_exact_push_observatory_dto");
}

// Executor success claims are untrusted. Missing/false commits, expanded
// commits, unpushed local commits, invalid receipts, and unproved no-ops all
// retain the queue and enter retry state.
await runRejectedExecutionProof("false-pushed", () => async () => ({
  outcome: "pushed",
  reason: "self_report_only",
  pushed: true,
}));
await runRejectedExecutionProof("false-commit", () => async () => ({
  outcome: "pushed",
  reason: "invented_commit",
  pushed: true,
  commit: "d".repeat(40),
  branch: "main",
  remote_ref: "refs/heads/main",
}));
await runRejectedExecutionProof("extra-path", (fixture) => async (batch) => {
  write(fixture.dataRoot, "20_Wiki/not-selected.md", "# Not selected\n");
  return commitBatch(fixture, batch, ["20_Wiki/not-selected.md"], true);
});
await runRejectedExecutionProof("remote-not-updated", (fixture) => async (batch) => commitBatch(fixture, batch, [], false));
await runRejectedExecutionProof("invalid-receipt", (fixture) => async (batch) => {
  const receiptPath = `60_Operations/task-sync-receipts/task-sync-receipt-${"e".repeat(64)}.json`;
  write(fixture.dataRoot, receiptPath, `${JSON.stringify({ version: "invalid" })}\n`);
  return commitBatch(fixture, batch, [receiptPath], true);
});
await runRejectedExecutionProof("false-no-op", () => async () => ({
  outcome: "no_op",
  reason: "unproved_no_op",
  pushed: false,
}));
checks.push("executor_success_claims_independently_rejected");

// A real no-op removes the queue only when the selected blob is already at the
// local branch tip and the exact remote ref is at the same commit.
{
  const fixture = makeFixture("verified-no-op");
  const relativePath = "20_Wiki/already-synced.md";
  write(fixture.dataRoot, relativePath, "# Already synced\n");
  git(fixture.dataRoot, ["add", relativePath]);
  git(fixture.dataRoot, ["commit", "-m", "data: already synced fixture"]);
  git(fixture.dataRoot, ["push", "origin", "HEAD:main"]);
  await register(fixture, [relativePath]);
  await scheduler.enqueueTaskScopedSync({
    dataRoot: fixture.dataRoot,
    taskId: fixture.taskId,
    requestedPaths: [relativePath],
    now: base,
  });
  const commit = git(fixture.dataRoot, ["rev-parse", "HEAD"]);
  const result = await scheduler.runAutomaticSyncScheduler({
    dataRoot: fixture.dataRoot,
    lastActivityAt: base,
    now: base + 6 * hour,
    execute: async () => ({
      outcome: "no_op",
      reason: "already_at_remote_tip",
      pushed: false,
      commit,
      branch: "main",
      remote_ref: "refs/heads/main",
    }),
  });
  assert.equal(result.outcome, "no_op");
  assert.equal(result.state.queue.length, 0);
  checks.push("no_op_requires_local_blob_and_remote_parity_proof");
}

// Multiple mature tasks are serialized: the oldest task is one attempt/one
// executor call/one push, while the other task remains durable in the queue.
{
  const fixture = makeFixture("multi-task");
  const secondTaskId = "task-multi-task-second";
  write(
    fixture.dataRoot,
    `.dino/tasks/${secondTaskId}.json`,
    `${JSON.stringify({ task_id: secondTaskId, request_hash: "f".repeat(64) }, null, 2)}\n`,
  );
  write(fixture.dataRoot, "20_Wiki/oldest-task.md", "# Oldest task\n");
  write(fixture.dataRoot, "20_Wiki/second-task.md", "# Second task\n");
  await register(fixture, ["20_Wiki/oldest-task.md"]);
  await taskScope.registerTaskSyncPaths({
    dataRoot: fixture.dataRoot,
    taskId: secondTaskId,
    paths: ["20_Wiki/second-task.md"],
    source: "lc08-deterministic-verifier",
    approval: "reviewed",
  });
  await scheduler.enqueueTaskScopedSync({
    dataRoot: fixture.dataRoot,
    taskId: fixture.taskId,
    requestedPaths: ["20_Wiki/oldest-task.md"],
    now: base,
  });
  await scheduler.enqueueTaskScopedSync({
    dataRoot: fixture.dataRoot,
    taskId: secondTaskId,
    requestedPaths: ["20_Wiki/second-task.md"],
    now: base + minute,
  });
  const counter = { calls: 0 };
  const result = await scheduler.runAutomaticSyncScheduler({
    dataRoot: fixture.dataRoot,
    lastActivityAt: base,
    now: base + 6 * hour + minute,
    execute: exactExecutor(fixture, counter),
  });
  assert.equal(result.outcome, "pushed");
  assert.equal(counter.calls, 1);
  assert.equal(result.attempt.item_count, 1);
  assert.deepEqual(result.state.queue.map((item) => item.path), ["20_Wiki/second-task.md"]);
  assert.deepEqual(
    git(fixture.dataRoot, ["diff-tree", "--no-commit-id", "--name-only", "-r", result.attempt.commit])
      .split(/\r?\n/)
      .filter(Boolean),
    ["20_Wiki/oldest-task.md"],
  );
  checks.push("one_attempt_selects_oldest_task_and_pushes_at_most_once");
}

// Revalidation rejects bytes changed after queue admission.
{
  const fixture = makeFixture("tamper");
  write(fixture.dataRoot, "20_Wiki/tamper.md", "# Original\n");
  await register(fixture, ["20_Wiki/tamper.md"]);
  await scheduler.enqueueTaskScopedSync({
    dataRoot: fixture.dataRoot,
    taskId: fixture.taskId,
    requestedPaths: ["20_Wiki/tamper.md"],
    now: base,
  });
  write(fixture.dataRoot, "20_Wiki/tamper.md", "# Changed after queue\n");
  const counter = { calls: 0 };
  const result = await scheduler.runAutomaticSyncScheduler({
    dataRoot: fixture.dataRoot,
    lastActivityAt: base,
    now: base + 6 * hour,
    execute: exactExecutor(fixture, counter),
  });
  assert.equal(result.executed, false);
  assert.equal(counter.calls, 0);
  assert.equal(result.state.queue.length, 0);
  assert(result.state.rejected.some((entry) => entry.policy === "scheduler_revalidation"));
  checks.push("post_queue_hash_tamper_blocked");
}

// Four automatic pushes in a rolling day are allowed; the fifth is held.
{
  const fixture = makeFixture("daily-cap");
  const paths = Array.from({ length: 5 }, (_, index) => `20_Wiki/cap-${index + 1}.md`);
  for (const [index, relativePath] of paths.entries()) write(fixture.dataRoot, relativePath, `# Cap ${index + 1}\n`);
  await register(fixture, paths);
  for (const [index, relativePath] of paths.entries()) {
    await scheduler.enqueueTaskScopedSync({
      dataRoot: fixture.dataRoot,
      taskId: fixture.taskId,
      requestedPaths: [relativePath],
      now: base + index * minute,
    });
  }
  const counter = { calls: 0 };
  const executor = exactExecutor(fixture, counter);
  for (let index = 0; index < 4; index += 1) {
    const result = await scheduler.runAutomaticSyncScheduler({
      dataRoot: fixture.dataRoot,
      lastActivityAt: base,
      now: base + 6 * hour + index * minute + 1,
      execute: executor,
    });
    assert.equal(result.outcome, "pushed");
  }
  const fifth = await scheduler.runAutomaticSyncScheduler({
    dataRoot: fixture.dataRoot,
    lastActivityAt: base,
    now: base + 6 * hour + 4 * minute + 1,
    execute: executor,
  });
  assert.equal(fifth.executed, false);
  assert(fifth.reason_codes.includes("automatic_push_rate_limited"));
  assert.equal(counter.calls, 4);
  assert.equal(fifth.state.automatic_push_history.length, 4);
  checks.push("rolling_24h_automatic_push_cap");
}

// Retry is 15 minutes, one hour, then six hours.
{
  const fixture = makeFixture("retry");
  write(fixture.dataRoot, "20_Wiki/retry.md", "# Retry\n");
  await register(fixture, ["20_Wiki/retry.md"]);
  await scheduler.enqueueTaskScopedSync({
    dataRoot: fixture.dataRoot,
    taskId: fixture.taskId,
    requestedPaths: ["20_Wiki/retry.md"],
    now: base,
  });
  const fail = async () => ({ outcome: "retry_required", reason: "fixture_retry", pushed: false });
  const first = await scheduler.runAutomaticSyncScheduler({ dataRoot: fixture.dataRoot, lastActivityAt: base, now: base + 6 * hour, execute: fail });
  assert.equal(first.state.retry?.next_retry_at, new Date(base + 6 * hour + 15 * minute).toISOString());
  const held = await scheduler.runAutomaticSyncScheduler({ dataRoot: fixture.dataRoot, lastActivityAt: base, now: base + 6 * hour + 14 * minute, execute: fail });
  assert(held.reason_codes.includes("retry_backoff"));
  const second = await scheduler.runAutomaticSyncScheduler({ dataRoot: fixture.dataRoot, lastActivityAt: base, now: base + 6 * hour + 15 * minute, execute: fail });
  assert.equal(second.state.retry?.next_retry_at, new Date(base + 7 * hour + 15 * minute).toISOString());
  const third = await scheduler.runAutomaticSyncScheduler({ dataRoot: fixture.dataRoot, lastActivityAt: base, now: base + 7 * hour + 15 * minute, execute: fail });
  assert.equal(third.state.retry?.next_retry_at, new Date(base + 13 * hour + 15 * minute).toISOString());
  checks.push("retry_backoff_15m_1h_6h");
}

// Manual safe-scoped sync bypasses cadence/auto-enable only; its push does not
// consume the automatic rolling cap and broad/release paths stay separate.
{
  const fixture = makeFixture("manual");
  write(fixture.dataRoot, "20_Wiki/manual.md", "# Manual safe scope\n");
  await register(fixture, ["20_Wiki/manual.md"]);
  await scheduler.enqueueTaskScopedSync({
    dataRoot: fixture.dataRoot,
    taskId: fixture.taskId,
    requestedPaths: ["20_Wiki/manual.md"],
    now: base,
  });
  await scheduler.setSyncSchedulerAutomaticEnabled({ dataRoot: fixture.dataRoot, enabled: false, now: base + minute });
  const automatic = await scheduler.runAutomaticSyncScheduler({
    dataRoot: fixture.dataRoot,
    lastActivityAt: base,
    now: base + 2 * minute,
    execute: exactExecutor(fixture),
  });
  assert(automatic.reason_codes.includes("automatic_sync_disabled"));
  const manual = await scheduler.runManualSafeScopedSync({
    dataRoot: fixture.dataRoot,
    now: base + 2 * minute,
    execute: exactExecutor(fixture),
  });
  assert.equal(manual.outcome, "pushed");
  assert.equal(manual.state.automatic_push_history.length, 0);
  checks.push("manual_safe_scope_separate_from_automatic_and_release");
}

assert.equal(scheduler.classifySyncRemoteFailure("fatal: Authentication failed"), "auth_unavailable");
assert.equal(scheduler.classifySyncRemoteFailure("Could not resolve host"), "offline");
assert.equal(receipts.PUBLIC_SYNC_RECEIPT_VERSION, "task_sync_public_receipt_20260712_v1");
assert.match(
  receipts.publicSyncArtifactBindingSha256({
    path: "20_Wiki/example.md",
    sha256: "b".repeat(64),
    git_blob_oid: "c".repeat(40),
    size_bytes: 1,
    classification: "syncable",
    policy: "wiki_path",
    approval: "reviewed",
    source: "verifier",
  }),
  /^[a-f0-9]{64}$/,
);
checks.push("offline_auth_skip_classification_and_receipt_contract_preserved");

const tempArtifacts = readdirSync(evidenceRoot, { recursive: true })
  .filter((entry) => String(entry).includes(".tmp"));
assert.deepEqual(tempArtifacts, [], "atomic scheduler writes leaked temporary files");
const report = {
  ok: true,
  scheduler_version: scheduler.SYNC_SCHEDULER_VERSION,
  receipt_version: receipts.PUBLIC_SYNC_RECEIPT_VERSION,
  evidence_root: evidenceRoot,
  production_pushes: 0,
  checks,
};
writeFileSync(path.join(evidenceRoot, "verification-report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(JSON.stringify(report, null, 2));
