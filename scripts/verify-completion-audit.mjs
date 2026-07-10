import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const [{ COMPLETION_ARTIFACTS, COMPLETION_COMMANDS, COMPLETION_GATES, HARD_GATE_IDS }, { runCompletionAudit, verifyCompletionEvidencePack }] =
  await Promise.all([
    import(pathToFileURL(path.join(root, "dist", "completion-registry.js")).href),
    import(pathToFileURL(path.join(root, "dist", "completion-evidence.js")).href),
  ]);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function execution(exitCode = 0) {
  return {
    exit_code: exitCode,
    signal: null,
    stdout_sha256: "0".repeat(64),
    stderr_sha256: "0".repeat(64),
    stdout_bytes: 0,
    stderr_bytes: 0,
    timed_out: false,
  };
}

async function main() {
  assert(HARD_GATE_IDS.length === 12, `expected 12 hard gates, got ${HARD_GATE_IDS.length}`);
  assert(COMPLETION_GATES.length === 12, `expected 12 gate registry rows, got ${COMPLETION_GATES.length}`);
  const concurrencyStart = COMPLETION_COMMANDS.findIndex((entry) => entry.id === "npm:index:verify:concurrency:1");
  assert(concurrencyStart > 0, "completion registry is missing the first concurrency run");
  assert(COMPLETION_COMMANDS.length === concurrencyStart + 5, "completion registry must end with three concurrency runs, status refresh, and final goal verification");
  assert(COMPLETION_GATES.every((gate) => gate.command_ids.length > 0), "gate without commands found");
  assert(COMPLETION_GATES.every((gate) => gate.artifact_ids.length > 0), "gate without artifacts found");
  const fullMemoryArtifact = COMPLETION_ARTIFACTS.find((entry) => entry.id === "full_memory_audit");
  assert(
    JSON.stringify(fullMemoryArtifact?.accepted_statuses) === JSON.stringify(["healthy", "drift_classified"]),
    "completion registry must accept classified OS drift while rejecting unclassified drift and parse errors",
  );
  const nativeAuthorityArtifact = COMPLETION_ARTIFACTS.find((entry) => entry.id === "native_instruction_authority");
  assert(
    JSON.stringify(nativeAuthorityArtifact?.accepted_statuses) === JSON.stringify(["healthy"]),
    "native instruction authority must not accept drift-classified status",
  );
  const packageJson = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
  for (const entry of COMPLETION_COMMANDS) {
    assert(packageJson.scripts?.[entry.npm_script], `registry references missing npm script: ${entry.npm_script}`);
  }
  const contract = readFileSync(path.join(root, "docs", "OS_COMPLETION_CONDITIONS.md"), "utf8");
  const runnerBody = contract.match(/\$commands = @\(([\s\S]*?)\r?\n\)/)?.[1] ?? "";
  const documentedScripts = [...runnerBody.matchAll(/npm run ([A-Za-z0-9:_-]+)/g)].map((match) => match[1]);
  const registryBaseScripts = COMPLETION_COMMANDS.slice(0, concurrencyStart).map((entry) => entry.npm_script);
  assert(
    documentedScripts.length === concurrencyStart,
    `normative runner should list ${concurrencyStart} base commands, got ${documentedScripts.length}`,
  );
  assert(
    JSON.stringify(documentedScripts) === JSON.stringify(registryBaseScripts),
    "typed completion registry drifted from the normative PowerShell runner",
  );
  assert(
    COMPLETION_COMMANDS.slice(concurrencyStart, concurrencyStart + 3).every(
      (entry) => entry.npm_script === "index:verify:concurrency",
    ),
    "registry must run the concurrency command exactly three times after the base suite",
  );
  assert(
    COMPLETION_COMMANDS[concurrencyStart + 3]?.npm_script === "status:refresh",
    "status:refresh must publish the final evidence generation",
  );
  assert(COMPLETION_COMMANDS.at(-1)?.npm_script === "verify:goal", "verify:goal must be the last mandatory command");

  const dataRoot = mkdtempSync(path.join(tmpdir(), "dinobrain-completion-audit-"));
  try {
    const partial = await runCompletionAudit({
      appRoot: root,
      dataRoot,
      auditor: "completion-audit-verifier",
      selectedCommandIds: ["npm:build"],
      commandRunner: async () => execution(0),
    });
    assert(partial.verdict.status === "NOT_COMPLETE", "partial command run was allowed to become COMPLETE");
    assert(partial.verdict.gate_results.length === 12, "verdict did not include every hard gate");
    const persistedVerdict = readFileSync(partial.completion_verdict_path, "utf8");
    assert(!persistedVerdict.includes(root), "completion verdict leaked the local app root");
    assert(!persistedVerdict.includes(dataRoot), "completion verdict leaked the local data root");
    const ledger = readFileSync(partial.command_results_path, "utf8")
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    assert(
      ledger.length === COMPLETION_COMMANDS.length,
      `partial ledger should still contain ${COMPLETION_COMMANDS.length} rows, got ${ledger.length}`,
    );
    assert(ledger.find((entry) => entry.command_id === "npm:build")?.status === "PASS", "selected command did not pass");
    assert(
      ledger.filter((entry) => entry.command_id !== "npm:build").every((entry) => entry.status === "BLOCKED"),
      "unselected mandatory commands were not blocked",
    );
    let verification = await verifyCompletionEvidencePack(dataRoot, partial.audit_run_id);
    assert(verification.ok, `fresh evidence pack failed integrity verification: ${verification.errors.join(",")}`);

    const firstSummary = path.join(partial.audit_dir, "commands", "npm-build.json");
    writeFileSync(firstSummary, `${JSON.stringify({ tampered: true })}\n`, "utf8");
    verification = await verifyCompletionEvidencePack(dataRoot, partial.audit_run_id);
    assert(!verification.ok, "tampered command summary was not detected");
    assert(
      verification.errors.some((entry) => entry.startsWith("artifact_hash_mismatch:command_summary:npm:build")),
      `tamper error was not specific: ${verification.errors.join(",")}`,
    );

    const failed = await runCompletionAudit({
      appRoot: root,
      dataRoot,
      auditor: "completion-audit-verifier",
      selectedCommandIds: ["npm:build"],
      commandRunner: async () => execution(17),
    });
    assert(failed.verdict.status === "NOT_COMPLETE", "failed command run was allowed to become COMPLETE");
    assert(
      failed.verdict.gate_results.every((gate) => gate.status !== "PASS"),
      "build failure did not fail or block every hard gate",
    );
    assert(failed.verdict.automatic_disqualifiers.includes("mandatory_command_not_passed"), "command disqualifier missing");

    console.log(
      JSON.stringify(
        {
          ok: true,
          gates: COMPLETION_GATES.length,
          commands: COMPLETION_COMMANDS.length,
          partial_audit_run_id: partial.audit_run_id,
          failed_audit_run_id: failed.audit_run_id,
          checks: [
            "partial_run_is_not_complete",
            "all_mandatory_commands_are_ledgered",
            "evidence_pack_integrity_verifies",
            "tamper_is_detected",
            "failed_build_blocks_all_gates",
            "registry_matches_normative_runner",
            "registry_scripts_exist_in_package",
            "local_repo_paths_are_not_persisted",
            "classified_full_memory_drift_is_accepted",
          ],
        },
        null,
        2,
      ),
    );
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
