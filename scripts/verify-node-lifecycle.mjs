import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(__dirname, "..");
const lifecycle = await import(pathToFileURL(path.join(appRoot, "dist", "node-lifecycle.js")).href);
const store = await import(pathToFileURL(path.join(appRoot, "dist", "node-lifecycle-store.js")).href);
const migration = await import(pathToFileURL(path.join(appRoot, "dist", "lifecycle.js")).href);

const {
  evaluateAcceptedEligibility,
  initializeNodeLifecycle,
  scoreNodeLifecyclePressure,
  transitionNodeLifecycle,
  validateNodeLifecycleRecord,
} = lifecycle;
const {
  currentNodeRecord,
  initializeLifecycleWrite,
  restoreDeletedNode,
  rollbackNodeLifecycleTransaction,
  transitionNodeLifecycleFile,
  writeNodeLifecycleBatch,
} = store;

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function absolute(dataRoot, relativePath) {
  return path.join(dataRoot, ...relativePath.split("/"));
}

function writeBytes(dataRoot, relativePath, value) {
  const file = absolute(dataRoot, relativePath);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, value);
  return file;
}

function writeJson(dataRoot, relativePath, value) {
  writeBytes(dataRoot, relativePath, `${JSON.stringify(value, null, 2)}\n`);
}

function readJson(dataRoot, relativePath) {
  return JSON.parse(readFileSync(absolute(dataRoot, relativePath), "utf8"));
}

function mutationInput(targetPath, toState, index, extras = {}) {
  return {
    target_path: targetPath,
    to_state: toState,
    reason_code: extras.reason_code ?? `verify_${toState}`,
    reason: extras.reason ?? `Verify lifecycle transition to ${toState}`,
    actor: extras.actor ?? "node-lifecycle-verifier",
    at: extras.at ?? new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
    transition_id: extras.transition_id ?? `node-transition-verify-${String(index).padStart(3, "0")}`,
    idempotency_key: extras.idempotency_key ?? `verify-key-${String(index).padStart(3, "0")}`,
    evidence_paths: extras.evidence_paths ?? [],
    predecessor_paths: extras.predecessor_paths ?? [],
    successor_paths: extras.successor_paths ?? [],
    allow_deleted_restore: extras.allow_deleted_restore,
  };
}

function assertThrowsMessage(fn, pattern) {
  assert.throws(fn, pattern);
}

async function verifyPureStateMachine(dataRoot) {
  const target = "50_Instances/candidates/pure-state.json";
  let result = initializeNodeLifecycle(
    { memory_id: "pure-state", claim: "pure state verification" },
    mutationInput(target, "candidate", 0),
  );
  assert.equal(result.record.lifecycle_state, "candidate");
  assert.equal(validateNodeLifecycleRecord(result.record, target).ok, true);

  const states = ["review", "accepted", "held", "review", "quarantined", "demoted", "archived", "deletion-proposed", "deleted-tombstone"];
  for (let index = 0; index < states.length; index += 1) {
    result = transitionNodeLifecycle(
      result.record,
      mutationInput(target, states[index], index + 1, {
        evidence_paths: ["80_Review_Queue/lifecycle/pure-state.json"],
      }),
    );
    assert.equal(result.record.lifecycle_state, states[index]);
    assert.equal(validateNodeLifecycleRecord(result.record, target).ok, true);
  }
  assert.equal(result.record.lifecycle_history.length, 10);
  assertThrowsMessage(
    () => transitionNodeLifecycle(result.record, mutationInput(target, "accepted", 20)),
    /not allowed/,
  );

  const replayBase = initializeNodeLifecycle(
    { memory_id: "idempotency" },
    mutationInput("50_Instances/candidates/idempotency.json", "candidate", 30),
  );
  const first = transitionNodeLifecycle(
    replayBase.record,
    mutationInput("50_Instances/candidates/idempotency.json", "review", 31, { idempotency_key: "stable-replay" }),
  );
  const replay = transitionNodeLifecycle(
    first.record,
    mutationInput("50_Instances/candidates/idempotency.json", "review", 32, { idempotency_key: "stable-replay" }),
  );
  assert.equal(replay.changed, false);
  assert.equal(replay.idempotent, true);
  assert.equal(replay.record.lifecycle_history.length, first.record.lifecycle_history.length);
  const advanced = transitionNodeLifecycle(
    first.record,
    mutationInput("50_Instances/candidates/idempotency.json", "held", 33),
  );
  assertThrowsMessage(
    () =>
      transitionNodeLifecycle(
        advanced.record,
        mutationInput("50_Instances/candidates/idempotency.json", "review", 34, { idempotency_key: "stable-replay" }),
      ),
    /no longer matches/,
  );

  const malformed = structuredClone(first.record);
  malformed.lifecycle_history.push({
    ...malformed.lifecycle_history.at(-1),
    transition_id: "node-transition-illegal",
    idempotency_key: "illegal",
    from_state: "review",
    to_state: "deleted-tombstone",
    at: "2026-01-01T00:01:00.000Z",
  });
  malformed.lifecycle_state = "deleted-tombstone";
  malformed.lifecycle_last_transition_id = "node-transition-illegal";
  malformed.lifecycle_state_entered_at = "2026-01-01T00:01:00.000Z";
  const validation = validateNodeLifecycleRecord(malformed, "50_Instances/candidates/idempotency.json");
  assert.equal(validation.ok, false);
  assert(validation.issues.includes("transition_not_allowed:2"));

  writeJson(dataRoot, "50_Instances/candidates/reviewed-source.json", { status: "accepted" });
  writeJson(dataRoot, "80_Review_Queue/promotion/reviewed-source.json", {
    status: "approved",
    candidate_path: "50_Instances/candidates/reviewed-source.json",
    accepted_path: "50_Instances/accepted/eligible.json",
  });
  let accepted = initializeNodeLifecycle(
    {
      memory_id: "eligible",
      status: "accepted",
      source_candidate_path: "50_Instances/candidates/reviewed-source.json",
      source_review_path: "80_Review_Queue/promotion/reviewed-source.json",
      reviewed_by: "verifier",
      reviewed_at: "2026-01-01T00:00:00.000Z",
      review_status: "accepted_by_agent_review",
    },
    mutationInput("50_Instances/accepted/eligible.json", "accepted", 40, {
      evidence_paths: ["80_Review_Queue/promotion/reviewed-source.json"],
    }),
  ).record;
  let eligibility = await evaluateAcceptedEligibility(dataRoot, "50_Instances/accepted/eligible.json", accepted);
  assert.equal(eligibility.eligible, true);

  accepted = { ...accepted, source_status: "external" };
  eligibility = await evaluateAcceptedEligibility(dataRoot, "50_Instances/accepted/eligible.json", accepted);
  assert.equal(eligibility.eligible, false);
  assert(eligibility.issues.includes("durable_external_provenance_missing"));
  writeJson(dataRoot, "30_Sources/chunks/eligible.json", { type: "source_chunk", status: "active" });
  accepted = { ...accepted, provenance_paths: ["30_Sources/chunks/eligible.json"] };
  eligibility = await evaluateAcceptedEligibility(dataRoot, "50_Instances/accepted/eligible.json", accepted);
  assert.equal(eligibility.eligible, true);
  eligibility = await evaluateAcceptedEligibility(
    dataRoot,
    "50_Instances/accepted/eligible.json",
    { ...accepted, sensitivity: "sensitive" },
  );
  assert.equal(eligibility.eligible, false);
  assert(eligibility.issues.includes("accepted_record_sensitive"));

  assert.equal(scoreNodeLifecyclePressure({}, { duplicate_count: 2 }).recommended_action, "merge");
  assert.equal(scoreNodeLifecyclePressure({}, { contradiction_count: 1 }).recommended_action, "quarantine");
  assert.equal(
    scoreNodeLifecyclePressure({}, { accepted_eligibility: { eligible: false, issues: ["missing"], durable_source_paths: [], durable_external_support_paths: [] } }).recommended_action,
    "hold",
  );
  assert.equal(
    scoreNodeLifecyclePressure(
      { updated_at: "2025-01-01T00:00:00.000Z" },
      { now: new Date("2026-01-01T00:00:00.000Z"), retrieval_count: 0 },
    ).recommended_action,
    "deletion-review",
  );
  assert.equal(
    scoreNodeLifecyclePressure(
      { updated_at: "2025-07-01T00:00:00.000Z" },
      { now: new Date("2026-01-01T00:00:00.000Z"), retrieval_count: 0 },
    ).recommended_action,
    "archive",
  );
}

async function verifyStoreAndRecovery(dataRoot) {
  const candidatePath = "50_Instances/candidates/store.json";
  const initialized = initializeLifecycleWrite(
    candidatePath,
    { candidate_id: "store", status: "pending_review", claim: "store verification" },
    mutationInput(candidatePath, "candidate", 100),
  );
  const initialBatch = await writeNodeLifecycleBatch(dataRoot, [initialized.write], {
    actor: "node-lifecycle-verifier",
    reason: "initialize store verification",
  });
  assert.equal(initialBatch.changed_paths.length, 1);
  assert.equal(initialBatch.transition_paths.length, 1);
  const transitioned = await transitionNodeLifecycleFile(
    dataRoot,
    mutationInput(candidatePath, "review", 101),
  );
  assert.equal(transitioned.state, "review");
  assert.equal(readJson(dataRoot, candidatePath).lifecycle_history.length, 2);

  const legacyPath = "50_Instances/candidates/legacy.json";
  writeJson(dataRoot, legacyPath, { candidate_id: "legacy", status: "pending_review", claim: "legacy" });
  const legacyTransition = await transitionNodeLifecycleFile(dataRoot, mutationInput(legacyPath, "review", 102));
  assert.equal(legacyTransition.transition_paths.length, 2, "legacy initialization transition artifact was lost");
  assert.equal(readJson(dataRoot, legacyPath).lifecycle_history.length, 2);

  const faultA = "50_Instances/candidates/fault-a.json";
  const faultB = "50_Instances/candidates/fault-b.json";
  const beforeA = Buffer.from('{"candidate_id":"fault-a","status":"pending_review"}\r\n', "utf8");
  const beforeB = Buffer.from('{"candidate_id":"fault-b","status":"pending_review"}\n', "utf8");
  writeBytes(dataRoot, faultA, beforeA);
  writeBytes(dataRoot, faultB, beforeB);
  const faultWriteA = initializeLifecycleWrite(
    faultA,
    JSON.parse(beforeA.toString("utf8")),
    mutationInput(faultA, "candidate", 110),
  ).write;
  const faultWriteB = initializeLifecycleWrite(
    faultB,
    JSON.parse(beforeB.toString("utf8")),
    mutationInput(faultB, "candidate", 111),
  ).write;
  await assert.rejects(
    writeNodeLifecycleBatch(dataRoot, [faultWriteA, faultWriteB], {
      actor: "node-lifecycle-verifier",
      reason: "fault injection",
      fault_after_write_index_for_test: 2,
    }),
    /Injected node lifecycle batch fault/,
  );
  assert.deepEqual(readFileSync(absolute(dataRoot, faultA)), beforeA);
  assert.deepEqual(readFileSync(absolute(dataRoot, faultB)), beforeB);
  assert.equal(existsSync(absolute(dataRoot, faultWriteA.transitions[0] ? `.dino/lifecycle/transitions/${faultWriteA.transitions[0].transition_id}.json` : "missing")), false);

  const rollbackPath = "50_Instances/candidates/rollback.json";
  const rollbackBefore = Buffer.from('{"candidate_id":"rollback","status":"pending_review","format":"exact"}\r\n', "utf8");
  writeBytes(dataRoot, rollbackPath, rollbackBefore);
  const rollbackWrite = initializeLifecycleWrite(
    rollbackPath,
    JSON.parse(rollbackBefore.toString("utf8")),
    mutationInput(rollbackPath, "candidate", 120),
  ).write;
  rollbackWrite.expected_before_sha256 = sha256(rollbackBefore);
  const rollbackBatch = await writeNodeLifecycleBatch(dataRoot, [rollbackWrite], {
    actor: "node-lifecycle-verifier",
    reason: "verify explicit rollback",
  });
  assert(rollbackBatch.transaction_id);
  await rollbackNodeLifecycleTransaction(dataRoot, rollbackBatch.transaction_id);
  assert.deepEqual(readFileSync(absolute(dataRoot, rollbackPath)), rollbackBefore);
  assert.equal(existsSync(absolute(dataRoot, rollbackBatch.transition_paths[0])), false);

  const tamperPath = "50_Instances/candidates/tamper.json";
  const tamperBefore = Buffer.from('{"candidate_id":"tamper","status":"pending_review"}\n', "utf8");
  writeBytes(dataRoot, tamperPath, tamperBefore);
  const tamperWrite = initializeLifecycleWrite(
    tamperPath,
    JSON.parse(tamperBefore.toString("utf8")),
    mutationInput(tamperPath, "candidate", 130),
  ).write;
  const tamperBatch = await writeNodeLifecycleBatch(dataRoot, [tamperWrite], {
    actor: "node-lifecycle-verifier",
    reason: "verify tamper refusal",
  });
  writeJson(dataRoot, tamperPath, { externally_changed: true });
  await assert.rejects(
    rollbackNodeLifecycleTransaction(dataRoot, tamperBatch.transaction_id),
    /rollback blocked by external changes/,
  );
  assert.equal(readJson(dataRoot, tamperPath).externally_changed, true);

  const evidencePath = "80_Review_Queue/lifecycle/delete-proof.json";
  writeJson(dataRoot, evidencePath, { status: "approved", reason: "deletion verifier" });
  const deletePath = "50_Instances/candidates/delete-me.json";
  const deleteInit = initializeLifecycleWrite(
    deletePath,
    { candidate_id: "delete-me", status: "pending_review", payload: "must-return" },
    mutationInput(deletePath, "candidate", 140),
  );
  await writeNodeLifecycleBatch(dataRoot, [deleteInit.write], {
    actor: "node-lifecycle-verifier",
    reason: "initialize deletion verifier",
  });
  await transitionNodeLifecycleFile(
    dataRoot,
    mutationInput(deletePath, "deletion-proposed", 141, { evidence_paths: [evidencePath] }),
  );
  const deleted = await transitionNodeLifecycleFile(
    dataRoot,
    mutationInput(deletePath, "deleted-tombstone", 142, { evidence_paths: [evidencePath] }),
  );
  const tombstone = readJson(dataRoot, deletePath);
  assert.equal(tombstone.type, "memory_tombstone");
  assert.equal(tombstone.payload, undefined);
  const restored = await restoreDeletedNode(dataRoot, {
    target_path: deletePath,
    deletion_transition_id: deleted.transition_id,
    actor: "node-lifecycle-verifier",
    reason: "restore deletion verifier",
    evidence_paths: [evidencePath],
  });
  assert.equal(restored.state, "deletion-proposed");
  const restoredRecord = readJson(dataRoot, deletePath);
  assert.equal(restoredRecord.payload, "must-return");
  assert.equal(restoredRecord.lifecycle_state, "deletion-proposed");
  assert.equal(restoredRecord.lifecycle_history.at(-1).reason_code, "tombstone_restored");
  assert.equal(validateNodeLifecycleRecord(restoredRecord, deletePath).ok, true);

  const sourcePath = "50_Instances/candidates/accepted-source.json";
  const reviewPath = "80_Review_Queue/promotion/accepted-source.json";
  const acceptedPath = "50_Instances/accepted/accepted-source.json";
  writeJson(dataRoot, sourcePath, { status: "accepted", reviewed_by: "verifier" });
  writeJson(dataRoot, reviewPath, {
    status: "approved",
    candidate_path: sourcePath,
    accepted_path: acceptedPath,
  });
  const acceptedInit = initializeLifecycleWrite(
    acceptedPath,
    {
      candidate_id: "accepted-source",
      status: "pending_review",
      source_candidate_path: sourcePath,
      source_review_path: reviewPath,
      review_status: "accepted_by_agent_review",
      reviewed_by: "verifier",
      reviewed_at: "2026-01-01T00:00:00.000Z",
    },
    mutationInput(acceptedPath, "review", 150),
  );
  await writeNodeLifecycleBatch(dataRoot, [acceptedInit.write], {
    actor: "node-lifecycle-verifier",
    reason: "initialize accepted gate verifier",
  });
  await transitionNodeLifecycleFile(
    dataRoot,
    mutationInput(acceptedPath, "accepted", 151, { evidence_paths: [reviewPath] }),
  );
  assert.equal((await currentNodeRecord(dataRoot, acceptedPath)).state, "accepted");

  const blockedPath = "50_Instances/accepted/blocked-source.json";
  const blockedInit = initializeLifecycleWrite(
    blockedPath,
    { candidate_id: "blocked-source", status: "pending_review" },
    mutationInput(blockedPath, "review", 160),
  );
  await writeNodeLifecycleBatch(dataRoot, [blockedInit.write], {
    actor: "node-lifecycle-verifier",
    reason: "initialize blocked accepted verifier",
  });
  await assert.rejects(
    transitionNodeLifecycleFile(
      dataRoot,
      mutationInput(blockedPath, "accepted", 161, { evidence_paths: [reviewPath] }),
    ),
    /Accepted lifecycle gate blocked/,
  );
  assert.equal(readJson(dataRoot, blockedPath).lifecycle_state, "review");

  const hashState = await currentNodeRecord(dataRoot, candidatePath);
  await assert.rejects(
    transitionNodeLifecycleFile(dataRoot, {
      ...mutationInput(candidatePath, "held", 170),
      expected_before_sha256: "0".repeat(64),
    }),
    /source hash mismatch/,
  );
  assert.equal((await currentNodeRecord(dataRoot, candidatePath)).sha256, hashState.sha256);

  const parallelWrites = Array.from({ length: 12 }, (_, index) => {
    const relativePath = `50_Instances/candidates/parallel-${index}.json`;
    return initializeLifecycleWrite(
      relativePath,
      { candidate_id: `parallel-${index}`, status: "pending_review" },
      mutationInput(relativePath, "candidate", 200 + index),
    ).write;
  });
  const parallelResults = await Promise.all(
    parallelWrites.map((write, index) =>
      writeNodeLifecycleBatch(dataRoot, [write], {
        actor: `parallel-verifier-${index}`,
        reason: "parallel lifecycle verification",
      }),
    ),
  );
  assert.equal(new Set(parallelResults.map((result) => result.transaction_id)).size, parallelResults.length);
  for (let index = 0; index < parallelWrites.length; index += 1) {
    assert.equal(readJson(dataRoot, `50_Instances/candidates/parallel-${index}.json`).lifecycle_state, "candidate");
  }
}

function git(dataRoot, args) {
  return execFileSync("git", ["-C", dataRoot, ...args], { encoding: "utf8", windowsHide: true }).trim();
}

async function verifyLifecycleMigration() {
  const dataRoot = mkdtempSync(path.join(tmpdir(), "dinobrain-node-lifecycle-migration-"));
  try {
    const supportedSource = "50_Instances/candidates/legacy-supported-source.json";
    const supportedPath = "50_Instances/accepted/legacy-supported.json";
    const unsupportedPath = "50_Instances/accepted/legacy-unsupported.json";
    const sensitiveSource = "50_Instances/candidates/legacy-sensitive-source.json";
    const sensitivePath = "50_Instances/accepted/legacy-sensitive.json";
    writeJson(dataRoot, supportedSource, { status: "accepted", source: "verified fixture" });
    writeJson(dataRoot, supportedPath, {
      memory_id: "legacy-supported",
      status: "accepted",
      claim: "A legacy internal memory with a durable source remains retrievable after migration.",
      source_candidate_path: supportedSource,
      accepted_at: "2026-01-01T00:00:00.000Z",
      source_status: "internal",
    });
    writeJson(dataRoot, unsupportedPath, {
      memory_id: "legacy-unsupported",
      status: "accepted",
      claim: "A legacy memory without durable provenance is held.",
      accepted_at: "2026-01-01T00:00:00.000Z",
      source_status: "internal",
    });
    writeJson(dataRoot, sensitiveSource, { status: "accepted", source: "sensitive fixture" });
    writeJson(dataRoot, sensitivePath, {
      memory_id: "legacy-sensitive",
      status: "accepted",
      claim: "Sensitive accepted memory is quarantined.",
      source_candidate_path: sensitiveSource,
      accepted_at: "2026-01-01T00:00:00.000Z",
      source_status: "internal",
      sensitivity: "sensitive",
    });
    git(dataRoot, ["init"]);
    git(dataRoot, ["config", "user.email", "lifecycle@example.local"]);
    git(dataRoot, ["config", "user.name", "Lifecycle Verifier"]);
    git(dataRoot, ["add", "-A"]);
    git(dataRoot, ["commit", "-m", "lifecycle migration fixture"]);
    const originalHead = git(dataRoot, ["rev-parse", "HEAD"]);
    const exactBefore = new Map(
      [supportedPath, unsupportedPath, sensitivePath].map((relativePath) => [
        relativePath,
        readFileSync(absolute(dataRoot, relativePath)),
      ]),
    );

    const dryRun = await migration.applyNodeLifecycle(dataRoot, {
      apply: false,
      reviewer: "migration-verifier",
    });
    assert.equal(dryRun.ok, true);
    assert.equal(dryRun.status, "review_required");
    assert.equal(dryRun.counts.actions, 3);
    assert.equal(dryRun.git.head, originalHead);
    assert.equal(dryRun.git.recovery_ref, null);
    assert.match(dryRun.git.dirty_status_sha256, /^[a-f0-9]{64}$/);
    assert.equal(readJson(dataRoot, supportedPath).lifecycle_state, undefined, "dry-run mutated accepted memory");

    const applied = await migration.applyNodeLifecycle(dataRoot, {
      apply: true,
      reviewer: "migration-verifier",
    });
    assert.equal(applied.ok, true);
    assert.equal(applied.status, "healthy");
    assert.equal(applied.counts.retrievable_accepted, 1);
    assert.equal(applied.counts.held_or_excluded, 2);
    assert(applied.transaction.transaction_id);
    assert.equal(git(dataRoot, ["rev-parse", applied.git.recovery_ref]), originalHead);
    assert.equal(readJson(dataRoot, supportedPath).lifecycle_state, "accepted");
    assert.equal(readJson(dataRoot, unsupportedPath).lifecycle_state, "held");
    assert.equal(readJson(dataRoot, sensitivePath).lifecycle_state, "quarantined");
    assert.equal(
      (await evaluateAcceptedEligibility(dataRoot, supportedPath, readJson(dataRoot, supportedPath))).eligible,
      true,
    );
    assert(existsSync(absolute(dataRoot, applied.actions[0].review_path)));

    const rolledBack = await migration.rollbackNodeLifecycleMigration(
      dataRoot,
      applied.transaction.transaction_id,
      "migration-verifier",
    );
    assert.equal(rolledBack.ok, true);
    assert.equal(rolledBack.status, "rolled_back");
    for (const [relativePath, before] of exactBefore) {
      assert.deepEqual(readFileSync(absolute(dataRoot, relativePath)), before, `rollback changed exact bytes: ${relativePath}`);
    }
    for (const action of applied.actions) assert.equal(existsSync(absolute(dataRoot, action.review_path)), false);
    for (const transitionPath of applied.transaction.transition_paths) {
      assert.equal(existsSync(absolute(dataRoot, transitionPath)), false);
    }

    const reapplied = await migration.applyNodeLifecycle(dataRoot, {
      apply: true,
      reviewer: "migration-verifier",
    });
    assert.equal(reapplied.ok, true);
    assert.equal(reapplied.status, "healthy");
    assert.equal(reapplied.counts.retrievable_accepted, 1);

    const cliOutput = execFileSync(process.execPath, [path.join(appRoot, "dist", "build-node-lifecycle.js")], {
      encoding: "utf8",
      env: { ...process.env, DINOBRAIN_DATA_DIR: dataRoot },
      windowsHide: true,
    });
    const cliReport = JSON.parse(cliOutput);
    assert.equal(cliReport.ok, true);
    assert.equal(cliReport.status, "healthy");
    assert.equal(cliReport.counts.actions, 0);
    assert.equal(
      cliReport.last_applied_transaction.transaction_id,
      reapplied.transaction.transaction_id,
      "healthy dry-run lost the last applied transaction",
    );
    assert.equal(cliReport.last_recovery_ref, reapplied.git.recovery_ref, "healthy dry-run lost the Git recovery ref");
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }

  const nonGitRoot = mkdtempSync(path.join(tmpdir(), "dinobrain-node-lifecycle-no-git-"));
  try {
    writeJson(nonGitRoot, "50_Instances/accepted/non-git.json", {
      status: "accepted",
      claim: "Apply must fail closed without a Git recovery anchor.",
    });
    await assert.rejects(
      migration.applyNodeLifecycle(nonGitRoot, { apply: true, reviewer: "migration-verifier" }),
      /requires a Git-backed data root/,
    );
  } finally {
    rmSync(nonGitRoot, { recursive: true, force: true });
  }
}

const dataRoot = mkdtempSync(path.join(tmpdir(), "dinobrain-node-lifecycle-"));
try {
  await verifyPureStateMachine(dataRoot);
  await verifyStoreAndRecovery(dataRoot);
  await verifyLifecycleMigration();
  const transitionDir = absolute(dataRoot, ".dino/lifecycle/transitions");
  const transactionDir = absolute(dataRoot, ".dino/local-backups/node-lifecycle");
  const transitionCount = existsSync(transitionDir) ? readdirSync(transitionDir).filter((name) => name.endsWith(".json")).length : 0;
  const transactionCount = existsSync(transactionDir) ? readdirSync(transactionDir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).length : 0;
  assert(transitionCount > 0);
  assert(transactionCount > 0);
  console.log(
    JSON.stringify(
      {
        ok: true,
        lifecycle_states: lifecycle.NODE_LIFECYCLE_STATES,
        transition_artifacts: transitionCount,
        transaction_journals: transactionCount,
        verified: [
          "legal_and_illegal_transitions",
          "idempotent_replay_and_collision",
          "accepted_review_and_provenance_gate",
          "lifecycle_pressure_actions",
          "legacy_transition_artifacts",
          "fault_injection_exact_rollback",
          "explicit_rollback",
          "external_tamper_refusal",
          "tombstone_restore",
          "source_hash_guard",
          "parallel_unique_transactions",
          "migration_dry_run_apply_and_reapply",
          "migration_git_recovery_ref",
          "migration_exact_rollback",
          "migration_cli_contract",
          "migration_non_git_fail_closed",
        ],
      },
      null,
      2,
    ),
  );
} finally {
  rmSync(dataRoot, { recursive: true, force: true });
}
