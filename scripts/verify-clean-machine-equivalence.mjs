import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const [{
  CLEAN_MACHINE_EQUIVALENCE_VERSION,
  CLEAN_MACHINE_REQUIRED_CAPABILITIES,
  CLEAN_MACHINE_REQUIRED_COMMANDS,
  CLEAN_MACHINE_REQUIRED_SCENARIOS,
  beginCleanMachineEquivalenceRun,
  classifyCleanMachineTrackedPaths,
  signCleanMachineEquivalenceEvidence,
  validateCleanMachineEquivalenceEvidence,
}, { runCompletionAudit }, { DINOBRAIN_DATA_CONTRACT_VERSION, DINOBRAIN_VERSION }] = await Promise.all([
  import(pathToFileURL(path.join(root, "dist", "clean-machine-equivalence.js")).href),
  import(pathToFileURL(path.join(root, "dist", "completion-evidence.js")).href),
  import(pathToFileURL(path.join(root, "dist", "version.js")).href),
]);

const hash = (character) => character.repeat(64);
const commit = (character) => character.repeat(40);
const start = "2026-07-11T00:00:00.000Z";
const finish = "2026-07-11T00:10:00.000Z";

const runtimeDirty = classifyCleanMachineTrackedPaths("data", [
  ".dino/state/client_mcp_direct_status.json",
  ".dino/index/sqlite/wiki.sqlite",
  ".dino/tasks/task-proof.json",
  "50_Instances/accepted/changed-memory.json",
]);
assert.deepEqual(runtimeDirty.runtimeGenerated, [
  ".dino/index/sqlite/wiki.sqlite",
  ".dino/state/client_mcp_direct_status.json",
  ".dino/tasks/task-proof.json",
]);
assert.deepEqual(runtimeDirty.authorizedRestore, []);
assert.deepEqual(runtimeDirty.unexpected, ["50_Instances/accepted/changed-memory.json"]);
const restoredPrivateDirty = classifyCleanMachineTrackedPaths("data", [
  "10_Conversations/raw/session.json",
  "30_Sources/private/source.txt",
  "README.md",
], { allowPrivateRestore: true });
assert.deepEqual(restoredPrivateDirty.authorizedRestore, [
  "10_Conversations/raw/session.json",
  "30_Sources/private/source.txt",
]);
assert.deepEqual(restoredPrivateDirty.unexpected, ["README.md"]);
assert.deepEqual(
  classifyCleanMachineTrackedPaths("app", [".dino/state/runtime.json", "src/index.ts"]).unexpected,
  [".dino/state/runtime.json", "src/index.ts"],
);

function live(agent, character) {
  return {
    agent,
    launch_kind: agent === "codex" ? "codex_desktop" : "claude_code",
    status: "verified",
    challenge_id_sha256: hash(character),
    submitted_at: "2026-07-11T00:02:00.000Z",
    completed_at: "2026-07-11T00:02:02.000Z",
    task_id_sha256: hash("7"),
    context_item_count: 4,
    memory_path_count: 4,
    context_trace_sha256: hash("8"),
    submitted_event_sha256: hash("9"),
    completed_event_sha256: hash("a"),
    report_sha256: hash("b"),
    event_order: [
      "codex_prompt_submitted",
      "task_started",
      "context_pack_created",
      "os_begin_task_completed",
      "codex_preflight_completed",
    ],
  };
}

function client(agent, character) {
  return {
    agent,
    status: "PASS",
    client_name: agent === "codex" ? "codex" : "claude-code",
    client_version: "fixture-1",
    local_identity_fingerprint: hash("1"),
    challenge_id_sha256: hash(character),
    direct_proof_sha256: hash(agent === "codex" ? "2" : "3"),
    direct_verified_at: "2026-07-11T00:03:00.000Z",
    live_pre_response: live(agent, character),
    reason_codes: [],
  };
}

function commandReceipt(commandId, index) {
  return {
    command_id: commandId,
    status: "PASS",
    started_at: `2026-07-11T00:0${Math.min(index + 1, 8)}:00.000Z`,
    finished_at: `2026-07-11T00:0${Math.min(index + 1, 8)}:05.000Z`,
    elapsed_ms: 5000,
    exit_code: 0,
    signal: null,
    stdout_sha256: hash("4"),
    stderr_sha256: hash("5"),
    stdout_bytes: 64,
    stderr_bytes: 0,
    peak_process_tree_working_set_bytes: 128 * 1024 * 1024,
    memory_measurement: "windows_process_tree_sampled",
  };
}

function completePayload() {
  return {
    version: CLEAN_MACHINE_EQUIVALENCE_VERSION,
    status: "complete",
    generated_at: finish,
    run_id: "clean-machine-11111111-1111-4111-8111-111111111111",
    mode: "both_clients",
    run_started_at: start,
    run_finished_at: finish,
    os_version: DINOBRAIN_VERSION,
    data_contract_version: DINOBRAIN_DATA_CONTRACT_VERSION,
    machine: {
      platform: "win32",
      architecture: "x64",
      attestation_public_key_sha256: hash("0"),
      local_proof_identity_fingerprint: hash("1"),
    },
    install: {
      status: "PASS",
      transaction_id_sha256: hash("6"),
      result_sha256: hash("7"),
      stage_verified: true,
      verification_skipped: false,
      full_equivalence: true,
      app_resolution: "git_fetch",
      data_resolution: "git_fetch",
      snapshot_count: 6,
      reason_codes: [],
    },
    repositories: {
      app: {
        repository: "clockmansy/dinobrain",
        installed_commit: commit("1"),
        final_commit: commit("1"),
        upstream_commit: commit("1"),
        head_matches_upstream: true,
        installed_commit_is_ancestor: true,
        tracked_dirty_count: 0,
        runtime_generated_tracked_dirty_count: 0,
        unexpected_tracked_dirty_count: 0,
      },
      data: {
        repository: "clockmansy/dinobrain-data",
        installed_commit: commit("2"),
        final_commit: commit("3"),
        upstream_commit: commit("3"),
        head_matches_upstream: true,
        installed_commit_is_ancestor: true,
        tracked_dirty_count: 0,
        runtime_generated_tracked_dirty_count: 0,
        unexpected_tracked_dirty_count: 0,
      },
    },
    recovery: {
      status: "PASS",
      receipt_sha256: hash("8"),
      backup_id_sha256: hash("9"),
      archive_sha256: hash("a"),
      inventory_sha256: hash("b"),
      restored_entry_count: 12,
      source_app_commit: commit("1"),
      source_data_commit: commit("2"),
      source_identity_matches_install: true,
      reason_codes: [],
    },
    clients: {
      codex: client("codex", "c"),
      claude: client("claude", "d"),
    },
    capabilities: CLEAN_MACHINE_REQUIRED_CAPABILITIES.map((id) => ({
      id,
      status: "PASS",
      artifact_sha256s: id === "scoped_sync" ? [] : [hash("e")],
      command_ids: [],
      reason_codes: [],
      metrics: {},
    })),
    scenarios: CLEAN_MACHINE_REQUIRED_SCENARIOS.map((id) => ({ id, status: "PASS", reason_codes: [] })),
    commands: CLEAN_MACHINE_REQUIRED_COMMANDS.map(commandReceipt),
    resource_usage: {
      peak_process_tree_working_set_bytes: 128 * 1024 * 1024,
      peak_process_tree_working_set_mib: 128,
      commands_measured: CLEAN_MACHINE_REQUIRED_COMMANDS.length,
    },
    warnings: [],
    blockers: [],
  };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function execution() {
  return {
    exit_code: 0,
    signal: null,
    stdout_sha256: hash("0"),
    stderr_sha256: hash("0"),
    stdout_bytes: 0,
    stderr_bytes: 0,
    timed_out: false,
  };
}

function git(cwd, args) {
  return execFileSync("git", ["-c", `safe.directory=${cwd}`, "-C", cwd, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  }).trim();
}

function createRepositoryFixture(base, name, githubRepository) {
  const repo = path.join(base, name);
  const remote = path.join(base, `${name}-upstream.git`);
  mkdirSync(repo, { recursive: true });
  execFileSync("git", ["init", "-b", "main", repo], { stdio: "ignore", windowsHide: true });
  execFileSync("git", ["init", "--bare", "-b", "main", remote], { stdio: "ignore", windowsHide: true });
  git(repo, ["config", "user.email", "clean-machine@example.invalid"]);
  git(repo, ["config", "user.name", "Clean Machine Verifier"]);
  writeFileSync(path.join(repo, "README.md"), `# ${name}\n`, "utf8");
  git(repo, ["add", "README.md"]);
  git(repo, ["commit", "-m", "fixture baseline"]);
  git(repo, ["remote", "add", "upstream", remote]);
  git(repo, ["push", "-u", "upstream", "main"]);
  git(repo, ["remote", "add", "origin", `https://github.com/${githubRepository}.git`]);
  return { repo, commit: git(repo, ["rev-parse", "HEAD"]) };
}

const fixtureRoot = mkdtempSync(path.join(tmpdir(), "dinobrain-clean-machine-evidence-"));
try {
  const localStateRoot = path.join(fixtureRoot, "local-state");
  const appFixture = createRepositoryFixture(fixtureRoot, "app", "clockmansy/dinobrain");
  const dataFixture = createRepositoryFixture(fixtureRoot, "data-repo", "clockmansy/dinobrain-data");
  mkdirSync(path.join(dataFixture.repo, "10_Conversations", "raw"), { recursive: true });
  const restoredPrivatePath = path.join(dataFixture.repo, "10_Conversations", "raw", "session.json");
  writeFileSync(restoredPrivatePath, '{"value":"public-baseline"}\n', "utf8");
  git(dataFixture.repo, ["add", "10_Conversations/raw/session.json"]);
  git(dataFixture.repo, ["commit", "-m", "add private restore fixture"]);
  git(dataFixture.repo, ["push"]);
  dataFixture.commit = git(dataFixture.repo, ["rev-parse", "HEAD"]);
  const installResultPath = path.join(fixtureRoot, "dinobrain-install-result.json");
  const restoreReceiptPath = path.join(fixtureRoot, "restore-receipt.json");
  writeFileSync(installResultPath, `${JSON.stringify({
    version: "dinobrain_install_transaction_v1",
    transaction_id: "install-fixture",
    status: "complete",
    started_at: "2026-07-11T00:00:00.000Z",
    finished_at: "2026-07-11T00:00:10.000Z",
    app: { requested_ref: "main", resolved_commit: appFixture.commit, resolution: "git_fetch", target_path: appFixture.repo },
    data: { requested_ref: "main", resolved_commit: dataFixture.commit, resolution: "git_fetch", target_path: dataFixture.repo },
    stage_verified: true,
    verification_skipped: false,
    full_equivalence: true,
    snapshot_count: 4,
  }, null, 2)}\n`, "utf8");
  writeFileSync(restoreReceiptPath, `${JSON.stringify({
    ok: true,
    status: "restored",
    version: "dinobrain_private_backup_v1",
    inventory_policy_version: "private_inventory_20260711_v1",
    archive_sha256: hash("1"),
    inventory_sha256: hash("2"),
    restored_entry_count: 1,
    source_identity: {
      app_commit: appFixture.commit,
      data_commit: dataFixture.commit,
      data_contract_version: DINOBRAIN_DATA_CONTRACT_VERSION,
    },
  })}\n`, "utf8");
  writeFileSync(restoredPrivatePath, '{"value":"private-restored"}\n', "utf8");
  const fixtureStatus = git(dataFixture.repo, ["status", "--porcelain=v1"]);
  assert.match(fixtureStatus, /10_Conversations\/raw\/session\.json/, `private restore fixture is missing: ${fixtureStatus}`);
  assert(!fixtureStatus.split(/\r?\n/).some((line) => !line.includes("10_Conversations/raw/session.json")), `unexpected fixture dirt: ${fixtureStatus}`);
  const begun = await beginCleanMachineEquivalenceRun({
    appRoot: appFixture.repo,
    dataRoot: dataFixture.repo,
    mode: "both_clients",
    installResultPath,
    restoreReceiptPath,
    localStateRoot,
    now: new Date("2026-07-11T00:01:00.000Z"),
  });
  assert.equal(begun.descriptor.installed_app_commit, appFixture.commit);
  assert.equal(begun.descriptor.installed_data_commit, dataFixture.commit);
  assert.equal(begun.descriptor.app_repository, "clockmansy/dinobrain");
  assert.equal(begun.descriptor.data_repository, "clockmansy/dinobrain-data");

  git(appFixture.repo, ["update-ref", "refs/remotes/origin/main", appFixture.commit]);
  git(dataFixture.repo, ["update-ref", "refs/remotes/origin/main", dataFixture.commit]);
  git(appFixture.repo, ["checkout", "--detach", appFixture.commit]);
  git(dataFixture.repo, ["checkout", "--detach", dataFixture.commit]);
  writeFileSync(restoredPrivatePath, '{"value":"private-restored"}\n', "utf8");
  const detachedRun = await beginCleanMachineEquivalenceRun({
    appRoot: appFixture.repo,
    dataRoot: dataFixture.repo,
    mode: "both_clients",
    installResultPath,
    restoreReceiptPath,
    localStateRoot,
  });
  assert.equal(detachedRun.descriptor.app_upstream_commit, appFixture.commit);
  assert.equal(detachedRun.descriptor.data_upstream_commit, dataFixture.commit);

  const validRestoreReceipt = readFileSync(restoreReceiptPath, "utf8");
  const invalidRestoreReceipt = JSON.parse(validRestoreReceipt);
  invalidRestoreReceipt.ok = false;
  writeFileSync(restoreReceiptPath, `${JSON.stringify(invalidRestoreReceipt)}\n`, "utf8");
  await assert.rejects(
    () => beginCleanMachineEquivalenceRun({
      appRoot: appFixture.repo,
      dataRoot: dataFixture.repo,
      mode: "both_clients",
      installResultPath,
      restoreReceiptPath,
      localStateRoot,
    }),
    /data_tracked_dirty.*restore_not_verified/,
  );
  writeFileSync(restoreReceiptPath, validRestoreReceipt, "utf8");

  writeFileSync(path.join(appFixture.repo, "README.md"), "unexpected source drift\n", "utf8");
  await assert.rejects(
    () => beginCleanMachineEquivalenceRun({
      appRoot: appFixture.repo,
      dataRoot: dataFixture.repo,
      mode: "both_clients",
      installResultPath,
      restoreReceiptPath,
      localStateRoot,
    }),
    /app_tracked_dirty/,
  );
  git(appFixture.repo, ["checkout", "--", "README.md"]);

  const degradedInstall = JSON.parse(readFileSync(installResultPath, "utf8"));
  degradedInstall.full_equivalence = false;
  degradedInstall.app.resolution = "github_api_archive";
  writeFileSync(installResultPath, `${JSON.stringify(degradedInstall, null, 2)}\n`, "utf8");
  await assert.rejects(
    () => beginCleanMachineEquivalenceRun({
      appRoot: appFixture.repo,
      dataRoot: dataFixture.repo,
      mode: "both_clients",
      installResultPath,
      restoreReceiptPath,
      localStateRoot,
    }),
    /full immutable GitHub install/,
  );
  const diagnosticRun = await beginCleanMachineEquivalenceRun({
    appRoot: appFixture.repo,
    dataRoot: dataFixture.repo,
    mode: "codex_only",
    installResultPath: null,
    restoreReceiptPath: null,
    localStateRoot,
  });
  assert(diagnosticRun.descriptor.initial_reason_codes.includes("install_result_missing"));

  const payload = completePayload();
  const signed = await signCleanMachineEquivalenceEvidence(payload, localStateRoot);
  payload.machine.attestation_public_key_sha256 = signed.attestation.public_key_sha256;
  const evidence = await signCleanMachineEquivalenceEvidence(payload, localStateRoot);
  let validation = validateCleanMachineEquivalenceEvidence(evidence);
  assert(validation.ok, `valid signed evidence failed: ${validation.errors.join(",")}`);

  const expectedRuntimeDirtyPayload = completePayload();
  expectedRuntimeDirtyPayload.machine.attestation_public_key_sha256 = evidence.attestation.public_key_sha256;
  expectedRuntimeDirtyPayload.repositories.data.tracked_dirty_count = 3;
  expectedRuntimeDirtyPayload.repositories.data.runtime_generated_tracked_dirty_count = 3;
  const expectedRuntimeDirty = await signCleanMachineEquivalenceEvidence(expectedRuntimeDirtyPayload, localStateRoot);
  assert(
    validateCleanMachineEquivalenceEvidence(expectedRuntimeDirty).ok,
    "runtime-generated tracked state incorrectly invalidated clean-machine evidence",
  );

  const unexpectedDirtyPayload = completePayload();
  unexpectedDirtyPayload.machine.attestation_public_key_sha256 = evidence.attestation.public_key_sha256;
  unexpectedDirtyPayload.repositories.data.tracked_dirty_count = 1;
  unexpectedDirtyPayload.repositories.data.unexpected_tracked_dirty_count = 1;
  const unexpectedDirty = await signCleanMachineEquivalenceEvidence(unexpectedDirtyPayload, localStateRoot);
  validation = validateCleanMachineEquivalenceEvidence(unexpectedDirty);
  assert(!validation.ok && validation.errors.includes("tracked_repository_dirty"), "unexpected source drift passed");

  const tampered = clone(evidence);
  tampered.repositories.app.final_commit = commit("f");
  validation = validateCleanMachineEquivalenceEvidence(tampered);
  assert(!validation.ok && validation.errors.includes("attestation_payload_hash_mismatch"), "tamper was not detected");

  const missingClaudePayload = completePayload();
  missingClaudePayload.machine.attestation_public_key_sha256 = evidence.attestation.public_key_sha256;
  missingClaudePayload.clients.claude.status = "FAIL";
  missingClaudePayload.clients.claude.live_pre_response = null;
  const missingClaude = await signCleanMachineEquivalenceEvidence(missingClaudePayload, localStateRoot);
  validation = validateCleanMachineEquivalenceEvidence(missingClaude);
  assert(!validation.ok && validation.errors.includes("claude_direct_live_proof_missing"), "missing Claude proof passed");

  const noGitPayload = completePayload();
  noGitPayload.machine.attestation_public_key_sha256 = evidence.attestation.public_key_sha256;
  noGitPayload.install.full_equivalence = false;
  noGitPayload.install.app_resolution = "github_api_archive";
  const noGit = await signCleanMachineEquivalenceEvidence(noGitPayload, localStateRoot);
  validation = validateCleanMachineEquivalenceEvidence(noGit);
  assert(!validation.ok && validation.errors.includes("full_install_equivalence_missing"), "no-Git degraded evidence passed");

  const foreignRestorePayload = completePayload();
  foreignRestorePayload.machine.attestation_public_key_sha256 = evidence.attestation.public_key_sha256;
  foreignRestorePayload.recovery.source_data_commit = commit("f");
  const foreignRestore = await signCleanMachineEquivalenceEvidence(foreignRestorePayload, localStateRoot);
  validation = validateCleanMachineEquivalenceEvidence(foreignRestore);
  assert(!validation.ok && validation.errors.includes("restore_data_commit_mismatch"), "foreign restore identity passed");

  const leakedPathPayload = completePayload();
  leakedPathPayload.machine.attestation_public_key_sha256 = evidence.attestation.public_key_sha256;
  leakedPathPayload.blockers = ["C:\\Users\\fixture\\secret.txt"];
  const leaked = await signCleanMachineEquivalenceEvidence(leakedPathPayload, localStateRoot);
  validation = validateCleanMachineEquivalenceEvidence(leaked);
  assert(!validation.ok && validation.errors.includes("public_evidence_contains_local_path"), "local path leak passed");

  const diagnosticPayload = completePayload();
  diagnosticPayload.machine.attestation_public_key_sha256 = evidence.attestation.public_key_sha256;
  diagnosticPayload.status = "diagnostic_only";
  diagnosticPayload.mode = "codex_only";
  diagnosticPayload.blockers = ["both_real_clients_required_for_release_equivalence"];
  const diagnostic = await signCleanMachineEquivalenceEvidence(diagnosticPayload, localStateRoot);
  assert(validateCleanMachineEquivalenceEvidence(diagnostic, { requireComplete: false }).ok, "signed diagnostic integrity failed");
  assert(!validateCleanMachineEquivalenceEvidence(diagnostic).ok, "diagnostic evidence counted as complete");

  const dataRoot = path.join(fixtureRoot, "data");
  const evidenceDir = path.join(dataRoot, "60_Operations", "clean-machine");
  mkdirSync(evidenceDir, { recursive: true });
  const evidencePath = path.join(evidenceDir, "valid.json");
  writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  const audit = await runCompletionAudit({
    appRoot: root,
    dataRoot,
    auditor: "clean-machine-evidence-verifier",
    selectedCommandIds: ["npm:build"],
    externalEvidencePaths: { clean_machine_equivalence: evidencePath },
    commandRunner: async () => execution(),
  });
  const manifest = JSON.parse(readFileSync(audit.artifact_manifest_path, "utf8"));
  assert(manifest.entries.find((entry) => entry.artifact_id === "clean_machine_equivalence")?.status === "PASS");

  const fakePath = path.join(evidenceDir, "self-reported-fake.json");
  writeFileSync(fakePath, `${JSON.stringify({ status: "complete", generated_at: finish })}\n`, "utf8");
  const fakeAudit = await runCompletionAudit({
    appRoot: root,
    dataRoot,
    auditor: "clean-machine-evidence-verifier",
    selectedCommandIds: ["npm:build"],
    externalEvidencePaths: { clean_machine_equivalence: fakePath },
    commandRunner: async () => execution(),
  });
  const fakeManifest = JSON.parse(readFileSync(fakeAudit.artifact_manifest_path, "utf8"));
  const fakeEntry = fakeManifest.entries.find((entry) => entry.artifact_id === "clean_machine_equivalence");
  assert(fakeEntry?.status === "FAIL" && String(fakeEntry.reason).startsWith("clean_machine_evidence_invalid:"));

  console.log(JSON.stringify({
    ok: true,
    version: CLEAN_MACHINE_EQUIVALENCE_VERSION,
    required_commands: CLEAN_MACHINE_REQUIRED_COMMANDS.length,
    required_capabilities: CLEAN_MACHINE_REQUIRED_CAPABILITIES.length,
    required_scenarios: CLEAN_MACHINE_REQUIRED_SCENARIOS.length,
    checks: [
      "ed25519_attestation_verified",
      "real_git_begin_contract_verified",
      "detached_origin_main_install_verified",
      "authenticated_private_restore_dirty_accepted",
      "invalid_restore_cannot_authorize_dirty",
      "porcelain_leading_space_preserved",
      "degraded_begin_rejected",
      "tamper_rejected",
      "missing_claude_rejected",
      "no_git_degraded_rejected",
      "foreign_restore_identity_rejected",
      "public_path_leak_rejected",
      "diagnostic_not_counted_complete",
      "completion_audit_rejects_self_reported_fake",
      "runtime_generated_dirty_is_separated_from_source_drift",
      "runtime_generated_dirty_evidence_accepted",
      "unexpected_source_drift_rejected",
    ],
  }, null, 2));
} finally {
  rmSync(fixtureRoot, { recursive: true, force: true });
}
