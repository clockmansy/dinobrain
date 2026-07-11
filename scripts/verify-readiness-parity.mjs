import { createHash } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const [{ COMPLETION_ARTIFACTS, COMPLETION_CONTRACT_VERSION, COMPLETION_GATES }, readinessModule, generationModule, healthModule] =
  await Promise.all([
    import(pathToFileURL(path.join(root, "dist", "completion-registry.js")).href),
    import(pathToFileURL(path.join(root, "dist", "readiness.js")).href),
    import(pathToFileURL(path.join(root, "dist", "status-generation.js")).href),
    import(pathToFileURL(path.join(root, "dist", "health-status.js")).href),
  ]);
const {
  CURRENT_COMPLETION_AUDIT_POINTER_RELATIVE_PATH,
  CURRENT_COMPLETION_AUDIT_POINTER_VERSION,
  buildReadiness,
  readinessParityProjection,
} = readinessModule;
const { publishStatusGeneration } = generationModule;
const { buildHealthStatus } = healthModule;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function fullPath(dataRoot, relativePath) {
  return path.join(dataRoot, ...relativePath.split("/"));
}

function writeJson(dataRoot, relativePath, value) {
  const target = fullPath(dataRoot, relativePath);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function createSqlite(dataRoot, relativePath) {
  const target = fullPath(dataRoot, relativePath);
  mkdirSync(path.dirname(target), { recursive: true });
  const database = new DatabaseSync(target);
  try {
    if (relativePath.endsWith("operations.sqlite")) {
      database.exec(`
        PRAGMA journal_mode=DELETE;
        CREATE TABLE tasks (path TEXT PRIMARY KEY, status TEXT, updated_at TEXT);
        CREATE TABLE traces (path TEXT PRIMARY KEY, finished_at TEXT);
        CREATE TABLE context_packs (path TEXT PRIMARY KEY, created_at TEXT);
        CREATE TABLE context_pack_items (
          pack_path TEXT, path TEXT, kind TEXT, title TEXT, summary TEXT, score REAL, ordinal INTEGER
        );
        CREATE TABLE events (event_key TEXT PRIMARY KEY, at TEXT, payload_json TEXT);
      `);
    } else {
      database.exec("PRAGMA journal_mode=DELETE; CREATE TABLE readiness_fixture (id INTEGER PRIMARY KEY, value TEXT NOT NULL);");
      database.prepare("INSERT INTO readiness_fixture (value) VALUES (?)").run("verified");
    }
  } finally {
    database.close();
  }
}

function artifactPaths() {
  return COMPLETION_ARTIFACTS.filter((entry) => !["current_status_generation", "health_status"].includes(entry.id)).map(
    (entry) => entry.relative_path,
  );
}

function seedArtifacts(dataRoot, generatedAt) {
  for (const spec of COMPLETION_ARTIFACTS) {
    if (["current_status_generation", "health_status"].includes(spec.id)) continue;
    if (spec.kind === "sqlite") {
      createSqlite(dataRoot, spec.relative_path);
      continue;
    }
    if (spec.kind === "jsonl") {
      const target = fullPath(dataRoot, spec.relative_path);
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, `${JSON.stringify({ status: "PASS", generated_at: generatedAt })}\n`, "utf8");
      continue;
    }
    const status = spec.accepted_statuses?.[0] ?? "healthy";
    writeJson(dataRoot, spec.relative_path, {
      version: "readiness_fixture_v1",
      status,
      generated_at: generatedAt,
      latest_verified_at: generatedAt,
      warnings: [],
      blockers: [],
      qualifying: true,
      release_parity_verified: true,
      agents: [],
      counts: {},
    });
  }
}

function writeCompletionProof(dataRoot, generation, generatedAt) {
  const auditRunId = `completion-readiness-${generation.pointer.generation_id.replace(/^status-/, "")}`;
  const verdictPath = `.dino/audits/completion/${auditRunId}/completion-verdict.json`;
  const verdict = {
    version: "completion_audit_v1",
    contract_version: COMPLETION_CONTRACT_VERSION,
    audit_run_id: auditRunId,
    auditor: "readiness-parity-verifier",
    started_at: generatedAt,
    finished_at: generatedAt,
    status: "COMPLETE",
    identity: {},
    command_results_path: `.dino/audits/completion/${auditRunId}/command-results.jsonl`,
    artifact_manifest_path: `.dino/audits/completion/${auditRunId}/artifact-manifest.json`,
    artifact_manifest_sha256: "0".repeat(64),
    gate_results: COMPLETION_GATES.map((gate) => ({
      gate_id: gate.id,
      title: gate.title,
      status: "PASS",
      reasons: [],
      command_ids: gate.command_ids,
      artifact_ids: gate.artifact_ids,
      external_evidence_ids: gate.external_evidence_ids,
    })),
    automatic_disqualifiers: [],
    failing_predicates: [],
  };
  writeJson(dataRoot, verdictPath, verdict);
  const verdictRaw = readFileSync(fullPath(dataRoot, verdictPath));
  writeJson(dataRoot, CURRENT_COMPLETION_AUDIT_POINTER_RELATIVE_PATH, {
    version: CURRENT_COMPLETION_AUDIT_POINTER_VERSION,
    status: "published",
    audit_run_id: auditRunId,
    generated_at: generatedAt,
    status_generation_id: generation.pointer.generation_id,
    status_generation_manifest_sha256: generation.pointer.manifest_sha256,
    verdict_path: verdictPath,
    verdict_sha256: sha256(verdictRaw),
    verdict_status: "COMPLETE",
    contract_version: COMPLETION_CONTRACT_VERSION,
  });
}

async function publishFixture(dataRoot, name, now, paths = artifactPaths(), updateProof = true) {
  const generation = await publishStatusGeneration(dataRoot, {
    artifactPaths: paths,
    generationId: `status-${name}`,
    now,
    retainGenerations: 8,
    producerCommand: "npm run readiness:verify",
  });
  if (updateProof) writeCompletionProof(dataRoot, generation, now.toISOString());
  return generation;
}

function cliReadiness(dataRoot) {
  const stdout = execFileSync(process.execPath, [path.join(root, "dist", "run-readiness.js"), "--data-root", dataRoot, "--allow-not-ready"], {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 8 * 1024 * 1024,
  });
  return JSON.parse(stdout);
}

async function waitForServer(baseUrl) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return;
    } catch {
      // Server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Observatory did not start in time");
}

async function apiReadiness(baseUrl, delay = 150) {
  await new Promise((resolve) => setTimeout(resolve, delay));
  const response = await fetch(`${baseUrl}/api/readiness`, { cache: "no-store" });
  assert(response.ok, `readiness endpoint returned ${response.status}`);
  return response.json();
}

function assertParity(cli, api, label) {
  assert(cli.parity_hash === api.parity_hash, `${label}: CLI/API parity hash mismatch`);
  assert(
    JSON.stringify(readinessParityProjection(cli)) === JSON.stringify(readinessParityProjection(api)),
    `${label}: CLI/API structured projection mismatch`,
  );
}

function gate(report, gateId) {
  return report.gates.find((entry) => entry.gate_id === gateId);
}

async function main() {
  const dataRoot = mkdtempSync(path.join(tmpdir(), "dinobrain-readiness-parity-"));
  const now = new Date();
  const port = 41_000 + Math.floor(Math.random() * 2_000);
  const baseUrl = `http://127.0.0.1:${port}`;
  let server = null;
  try {
    seedArtifacts(dataRoot, now.toISOString());
    await publishFixture(dataRoot, "readiness-baseline", now);
    const directBaseline = await buildReadiness(dataRoot, { now: new Date(now.getTime() + 1_000) });
    assert(directBaseline.ok, `healthy fixture was not ready: ${directBaseline.warnings.slice(0, 5).join(",")}`);
    assert(directBaseline.gates.length === 12, "readiness did not expose all 12 hard gates");
    const healthRollup = await buildHealthStatus(dataRoot, { now: new Date(now.getTime() + 1_000) });
    assert(healthRollup.readiness_parity_hash === directBaseline.parity_hash, "persisted health rollup did not use readiness parity");
    assert(healthRollup.checks.length === 12 && healthRollup.status === "healthy", "health rollup did not project all operational gates");

    server = spawn(process.execPath, [path.join(root, "scripts", "dinobrain-observatory.mjs"), `--port=${port}`], {
      cwd: root,
      env: {
        ...process.env,
        DINOBRAIN_DATA_DIR: dataRoot,
        DINOBRAIN_OBSERVATORY_PORT: String(port),
        DINOBRAIN_OBSERVATORY_CACHE_TTL_MS: "100",
        DINOBRAIN_OBSERVATORY_GENERATION_VERIFY_TTL_MS: "1000",
      },
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: true,
    });
    let serverError = "";
    server.stderr.on("data", (chunk) => {
      serverError += chunk.toString();
    });
    try {
      await waitForServer(baseUrl);
    } catch (error) {
      throw new Error(`${error instanceof Error ? error.message : String(error)}\n${serverError}`);
    }

    let cli = cliReadiness(dataRoot);
    let api = await apiReadiness(baseUrl, 0);
    assertParity(cli, api, "baseline");
    assert(api.ok === true && api.status === "ready", "baseline API readiness was not green");

    const health = await fetch(`${baseUrl}/api/health`).then((response) => response.json());
    const graph = await fetch(`${baseUrl}/api/graph`).then((response) => response.json());
    const graphHealth = await fetch(`${baseUrl}/api/graph-health`).then((response) => response.json());
    assert(health.readiness?.parity_hash === api.parity_hash, "health/readiness parity hash mismatch");
    assert(graph.readiness?.parity_hash === api.parity_hash, "graph/readiness parity hash mismatch");
    assert(graphHealth.readiness?.parity_hash === api.parity_hash, "graph-health/readiness parity hash mismatch");
    assert(health.resources?.process_memory?.rss < 256 * 1024 * 1024, "fixture Observatory RSS exceeded 256 MiB");

    const html = await fetch(baseUrl).then((response) => response.text());
    assert(html.includes("readiness.parity_hash"), "UI does not render the canonical parity hash");
    assert(html.includes("item.next_safe_action"), "UI does not render the next safe action");
    assert(html.includes('fetch("/api/snapshot"'), "UI does not consume the canonical snapshot endpoint");

    const nativeSpec = COMPLETION_ARTIFACTS.find((entry) => entry.id === "native_instruction_authority");
    writeJson(dataRoot, nativeSpec.relative_path, {
      status: nativeSpec.accepted_statuses[0],
      generated_at: now.toISOString(),
      warnings: ["injected_readiness_warning"],
      blockers: [],
    });
    await publishFixture(dataRoot, "readiness-warning", new Date(now.getTime() + 2_000));
    cli = cliReadiness(dataRoot);
    api = await apiReadiness(baseUrl);
    assertParity(cli, api, "warning");
    assert(
      gate(api, "HG-02")?.reason_codes.includes("artifact_warning_present:native_instruction_authority"),
      "warning blocker was not identical or specific",
    );
    assert(gate(api, "HG-02")?.next_safe_action.includes("status:native-authority"), "warning next action was not actionable");

    writeJson(dataRoot, nativeSpec.relative_path, {
      status: nativeSpec.accepted_statuses[0],
      generated_at: now.toISOString(),
      warnings: [],
      blockers: [],
    });
    const missingPaths = artifactPaths().filter(
      (entry) => entry !== COMPLETION_ARTIFACTS.find((candidate) => candidate.id === "answer_quality").relative_path,
    );
    await publishFixture(dataRoot, "readiness-missing", new Date(now.getTime() + 4_000), missingPaths);
    cli = cliReadiness(dataRoot);
    api = await apiReadiness(baseUrl);
    assertParity(cli, api, "missing");
    assert(gate(api, "HG-04")?.reason_codes.includes("artifact_missing:answer_quality"), "missing evidence was not blocked");

    await publishFixture(dataRoot, "readiness-stale", new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000));
    cli = cliReadiness(dataRoot);
    api = await apiReadiness(baseUrl);
    assertParity(cli, api, "stale");
    assert(api.status_generation.freshness === "stale", "stale generation was not identified");
    assert(api.gates.every((entry) => entry.status !== "PASS"), "stale generation allowed a green gate");

    const fresh = await publishFixture(dataRoot, "readiness-tamper", new Date(now.getTime() + 6_000));
    const nativeEntry = fresh.manifest.entries.find((entry) => entry.source_path === nativeSpec.relative_path);
    writeFileSync(path.join(dataRoot, ".dino", "generations", "status", fresh.pointer.generation_id, ...nativeEntry.snapshot_path.split("/")), "{broken}\n", "utf8");
    cli = cliReadiness(dataRoot);
    api = await apiReadiness(baseUrl, 1_100);
    assertParity(cli, api, "malformed");
    assert(api.status_generation.status === "invalid", "tampered snapshot did not invalidate readiness");
    assert(api.status_generation.errors.some((entry) => entry.includes("snapshot_hash_mismatch")), "tamper reason was not exposed");

    const rebound = await publishFixture(dataRoot, "readiness-mixed", new Date(now.getTime() + 8_000), artifactPaths(), false);
    assert(rebound.pointer.generation_id !== fresh.pointer.generation_id, "mixed-generation fixture did not advance generation");
    cli = cliReadiness(dataRoot);
    api = await apiReadiness(baseUrl);
    assertParity(cli, api, "mixed-generation");
    assert(api.completion_audit.status === "generation_mismatch", "mixed completion/readiness generation was not blocked");
    assert(api.gates.every((entry) => entry.status !== "PASS"), "mixed generation allowed a green gate");

    const beforeBurst = await fetch(`${baseUrl}/api/health`).then((response) => response.json());
    const burst = await Promise.all(Array.from({ length: 12 }, () => fetch(`${baseUrl}/api/snapshot`).then((response) => response.json())));
    assert(burst.every((entry) => entry.readiness?.parity_hash), "bounded polling burst returned incomplete readiness");
    assert(
      burst.every((entry) => entry.payload?.within_budget === true && entry.payload.serialized_bytes < 256 * 1024),
      "snapshot projection exceeded the 256 KiB payload budget",
    );
    const afterBurst = await fetch(`${baseUrl}/api/health`).then((response) => response.json());
    const coalescedDelta =
      (afterBurst.cache.resources.snapshot.coalesced - beforeBurst.cache.resources.snapshot.coalesced) +
      (afterBurst.cache.resources.snapshot.hits - beforeBurst.cache.resources.snapshot.hits);
    assert(coalescedDelta >= 10, "snapshot polling was not cached/coalesced");

    console.log(
      JSON.stringify(
        {
          ok: true,
          version: directBaseline.version,
          gates: directBaseline.gates.length,
          checks: [
            "healthy_baseline",
            "cli_api_structured_parity",
            "health_graph_parity",
            "health_rollup_projection",
            "warning_blocks_green",
            "missing_blocks_green",
            "stale_blocks_green",
            "malformed_blocks_green",
            "mixed_generation_blocks_green",
            "ui_consumes_canonical_snapshot",
            "bounded_polling_cache",
            "snapshot_payload_budget",
            "observatory_rss_below_256_mib",
          ],
          baseline_parity_hash: directBaseline.parity_hash,
          observatory_rss_bytes: health.resources.process_memory.rss,
          coalesced_or_cached_requests: coalescedDelta,
        },
        null,
        2,
      ),
    );
    if (server.exitCode !== null && server.exitCode !== 0) throw new Error(`Observatory exited early: ${serverError}`);
  } finally {
    if (server && server.exitCode === null) {
      server.kill();
      await new Promise((resolve) => server.once("exit", resolve));
    }
    rmSync(dataRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
