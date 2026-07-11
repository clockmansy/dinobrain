import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const [{ COMPLETION_COMMANDS, COMPLETION_EXTERNAL_EVIDENCE }, { runCompletionAudit }, soak] = await Promise.all([
  import(pathToFileURL(path.join(root, "dist", "completion-registry.js")).href),
  import(pathToFileURL(path.join(root, "dist", "completion-evidence.js")).href),
  import(pathToFileURL(path.join(root, "dist", "task-lifecycle-soak.js")).href),
]);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function git(repo, args) {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", windowsHide: true }).trim();
}

function initRepo(repo, name) {
  mkdirSync(repo, { recursive: true });
  git(repo, ["init", "-b", "main"]);
  git(repo, ["config", "user.email", "lifecycle-soak@example.invalid"]);
  git(repo, ["config", "user.name", "Lifecycle Soak Verifier"]);
  writeFileSync(path.join(repo, "README.md"), `${name}\n`, "utf8");
  git(repo, ["add", "README.md"]);
  git(repo, ["commit", "-m", "fixture baseline"]);
}

function writeJson(filePath, value) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function clientReport(agent, generatedAt, proofPath, proofSha256) {
  return {
    agent,
    status: "verified",
    required_tools: [],
    verified_tools: [],
    missing_tools: [],
    exact_single_name_discovery: true,
    latest_verified_at: generatedAt,
    proof_path: proofPath,
    proof_sha256: proofSha256,
    proof_version: "client_mcp_direct_proof_v2",
    challenge_id: `challenge-${agent}`,
    server_instance_id: `server-${agent}`,
    local_identity_fingerprint: "1".repeat(64),
    client_name: agent === "codex" ? "codex-mcp-client" : "claude-code",
    client_version: "fixture-1",
    client_process_chain: [],
    stale_after_ms: soak.TASK_LIFECYCLE_SOAK_MINIMUM_MS,
    last_computed_at: generatedAt,
    authority_rank: 100,
    reason: "fixture_verified",
    proof_source: `${agent}_fixture`,
    client_surface: agent,
    not_configured_reason: null,
    invalid_proof_paths: [],
  };
}

async function expectReject(action, pattern, message) {
  try {
    await action();
  } catch (error) {
    assert(pattern.test(String(error?.message ?? error)), message);
    return;
  }
  throw new Error(message);
}

async function main() {
  assert(
    COMPLETION_COMMANDS.some((entry) => entry.npm_script === "soak:lifecycle:verify"),
    "completion registry is missing lifecycle soak regression",
  );
  assert(
    COMPLETION_EXTERNAL_EVIDENCE.some((entry) => entry.id === "task_lifecycle_soak"),
    "completion registry is missing lifecycle soak external evidence",
  );
  const malformedValidation = await soak.validateTaskLifecycleSoakEvidence({ status: "complete" });
  assert(!malformedValidation.ok, "malformed soak evidence was accepted");

  const fixtureRoot = mkdtempSync(path.join(tmpdir(), "dinobrain-lifecycle-soak-"));
  const appRoot = path.join(fixtureRoot, "app");
  const dataRoot = path.join(fixtureRoot, "data");
  const localStateRoot = path.join(fixtureRoot, "local-state");
  try {
    initRepo(appRoot, "app");
    initRepo(dataRoot, "data");
    const startedAt = new Date("2026-07-01T00:00:00.000Z");
    const begun = await soak.beginTaskLifecycleSoak({ appRoot, dataRoot, localStateRoot, now: startedAt });
    assert(begun.descriptor.status === "running", "soak did not start");
    assert(begun.descriptor.baseline.counts.blockers === 0, "fixture baseline was not healthy");
    if (process.platform === "win32") {
      const keyAcl = execFileSync("icacls", [path.join(localStateRoot, "attestation-ed25519-private.pem")], {
        encoding: "utf8",
        windowsHide: true,
      });
      assert(!/\(I\)/i.test(keyAcl), "lifecycle soak private key retained inherited Windows ACL entries");
    }

    const originalDescriptor = readFileSync(begun.descriptorPath, "utf8");
    const tamperedDescriptor = JSON.parse(originalDescriptor);
    tamperedDescriptor.started_at = new Date(startedAt.getTime() - soak.TASK_LIFECYCLE_SOAK_MINIMUM_MS).toISOString();
    writeJson(begun.descriptorPath, tamperedDescriptor);
    await expectReject(
      () => soak.finalizeTaskLifecycleSoak({
        appRoot,
        dataRoot,
        localStateRoot,
        runId: begun.descriptor.run_id,
        now: startedAt,
      }),
      /start attestation invalid/i,
      "tampered start timestamp was not blocked",
    );
    writeFileSync(begun.descriptorPath, originalDescriptor, "utf8");

    await expectReject(
      () => soak.finalizeTaskLifecycleSoak({
        appRoot,
        dataRoot,
        localStateRoot,
        runId: begun.descriptor.run_id,
        now: new Date(startedAt.getTime() + 60 * 60 * 1000),
      }),
      /requires 86400000 ms/i,
      "early finalization was not blocked",
    );

    const finishedAt = new Date(startedAt.getTime() + soak.TASK_LIFECYCLE_SOAK_MINIMUM_MS + 60_000);
    const proofAt = new Date(finishedAt.getTime() - 30_000).toISOString();
    const agents = ["codex", "claude"];
    const reports = [];
    for (const agent of agents) {
      const taskId = `task-soak-${agent}`;
      const taskPath = `.dino/tasks/${taskId}.json`;
      const tracePath = `.dino/traces/${taskId}.json`;
      const proofPath = `.dino/proofs/client-mcp/${agent}-soak-proof.json`;
      const proofSha256 = agent === "codex" ? "a".repeat(64) : "b".repeat(64);
      writeJson(path.join(dataRoot, ...taskPath.split("/")), {
        task_id: taskId,
        status: "completed",
        request: `Complete ${agent} lifecycle soak proof`,
        launch_kind: "direct_mcp",
        launch_source: "server_observed_client_mcp_challenge",
        prompt_surface: "client_mcp_proof",
        created_at: proofAt,
        finished_at: proofAt,
        trace_path: tracePath,
      });
      writeJson(path.join(dataRoot, ...tracePath.split("/")), {
        task_id: taskId,
        outcome: "completed",
        summary: `${agent} lifecycle soak proof completed`,
        finished_at: proofAt,
        context_pack_paths: [`.dino/context-packs/${taskId}.json`],
        used_memory_paths: ["40_Projects/DinoBrain-Project-State.md"],
      });
      writeJson(path.join(dataRoot, ...proofPath.split("/")), {
        version: "client_mcp_direct_proof_v2",
        agent,
        status: "verified",
        generated_at: proofAt,
        task_id: taskId,
        proof_sha256: proofSha256,
      });
      reports.push(clientReport(agent, proofAt, proofPath, proofSha256));
    }
    const completeStatus = {
      version: "client_mcp_direct_status_v2",
      status: "verified",
      release_parity_verified: true,
      generated_at: finishedAt.toISOString(),
      latest_verified_at: proofAt,
      data_root: dataRoot,
      local_identity_fingerprint: "1".repeat(64),
      required_tools: [],
      agents: reports,
      counts: { agents: 2, verified: 2, not_configured: 0, needs_recheck: 0, missing_tools: 0, invalid_proofs: 0 },
      warnings: [],
      visible_status: "verified",
    };

    await expectReject(
      () => soak.finalizeTaskLifecycleSoak({
        appRoot,
        dataRoot,
        localStateRoot,
        runId: begun.descriptor.run_id,
        now: finishedAt,
        clientStatusOverride: { ...completeStatus, release_parity_verified: false, agents: reports.slice(0, 1) },
      }),
      /fresh_codex_and_claude_proofs_required_inside_soak_window/i,
      "missing Claude proof was not blocked",
    );

    const finalized = await soak.finalizeTaskLifecycleSoak({
      appRoot,
      dataRoot,
      localStateRoot,
      runId: begun.descriptor.run_id,
      now: finishedAt,
      clientStatusOverride: completeStatus,
    });
    assert(finalized.validation.ok, `generated evidence failed: ${finalized.validation.errors.join(",")}`);
    assert(finalized.evidence.duration_ms >= soak.TASK_LIFECYCLE_SOAK_MINIMUM_MS, "24-hour duration was not recorded");
    assert(finalized.evidence.window.counts.durable_tasks === 2, "durable task window count mismatch");
    assert(finalized.evidence.client_proofs.length === 2, "both client proofs were not bound");

    const fileValidation = await soak.validateTaskLifecycleSoakEvidenceFile(finalized.outputPath, { dataRoot, now: finishedAt });
    assert(fileValidation.ok, `persisted evidence failed: ${fileValidation.errors.join(",")}`);

    const audit = await runCompletionAudit({
      appRoot,
      dataRoot,
      auditor: "lifecycle-soak-verifier",
      selectedCommandIds: [],
      externalEvidencePaths: { task_lifecycle_soak: finalized.outputPath },
      now: () => finishedAt,
    });
    const manifest = JSON.parse(readFileSync(audit.artifact_manifest_path, "utf8"));
    const imported = manifest.entries.find((entry) => entry.artifact_id === "task_lifecycle_soak");
    assert(imported?.status === "PASS", `completion audit rejected valid soak evidence: ${imported?.reason}`);

    const tampered = JSON.parse(readFileSync(finalized.outputPath, "utf8"));
    tampered.duration_ms += 1;
    const tamperValidation = await soak.validateTaskLifecycleSoakEvidence(tampered, { dataRoot, now: finishedAt });
    assert(!tamperValidation.ok && tamperValidation.errors.includes("attestation_payload_hash_mismatch"), "tamper was not detected");

    const proofPath = path.join(dataRoot, ".dino", "proofs", "client-mcp", "codex-soak-proof.json");
    const originalProof = readFileSync(proofPath, "utf8");
    writeFileSync(proofPath, `${originalProof.trim()} `, "utf8");
    const hashValidation = await soak.validateTaskLifecycleSoakEvidenceFile(finalized.outputPath, { dataRoot, now: finishedAt });
    assert(
      !hashValidation.ok && hashValidation.errors.includes("client_proof_file_hash_mismatch:codex"),
      "referenced proof hash tamper was not detected",
    );
    writeFileSync(proofPath, originalProof, "utf8");

    console.log(JSON.stringify({
      ok: true,
      run_id: finalized.evidence.run_id,
      duration_ms: finalized.evidence.duration_ms,
      window_counts: finalized.evidence.window.counts,
      checks: [
        "minimum_24_hour_duration_enforced",
        "signed_start_timestamp_tamper_blocked",
        "private_key_acl_hardened",
        "clean_app_and_immutable_refs_bound",
        "blocker_free_baseline_and_final_bound",
        "fresh_codex_and_claude_proofs_required",
        "proof_tasks_created_inside_window",
        "ed25519_attestation_verified",
        "payload_tamper_detected",
        "referenced_proof_hash_tamper_detected",
        "completion_registry_binding_present",
        "completion_audit_import_verified",
        "malformed_evidence_fails_closed",
      ],
    }, null, 2));
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
