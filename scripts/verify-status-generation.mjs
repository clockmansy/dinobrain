import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const {
  loadCurrentStatusGeneration,
  publishStatusGeneration,
  resolveStatusGenerationArtifactPath,
  STATUS_GENERATION_POINTER_RELATIVE_PATH,
} = await import(pathToFileURL(path.join(root, "dist", "status-generation.js")).href);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function json(dataRoot, relativePath, value) {
  const fullPath = path.join(dataRoot, ...relativePath.split("/"));
  mkdirSync(path.dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function expectPublishRejected(dataRoot, options, message) {
  let rejected = false;
  try {
    await publishStatusGeneration(dataRoot, options);
  } catch {
    rejected = true;
  }
  assert(rejected, message);
}

async function main() {
  const dataRoot = mkdtempSync(path.join(tmpdir(), "dinobrain-status-generation-"));
  const artifactPaths = [".dino/state/health_status.json", ".dino/state/monitoring_status.json"];
  try {
    json(dataRoot, artifactPaths[0], { status: "healthy", generation: 1, generated_at: "2026-07-10T00:00:00.000Z" });
    json(dataRoot, artifactPaths[1], { status: "healthy", generation: 1, generated_at: "2026-07-10T00:00:00.000Z" });
    const first = await publishStatusGeneration(dataRoot, {
      artifactPaths,
      generationId: "status-20260710-000000000-first",
      now: new Date("2026-07-10T00:00:00.000Z"),
    });
    let loaded = await loadCurrentStatusGeneration(dataRoot, { verifyEntries: true, verifySourceCoherence: true });
    assert(loaded.status === "healthy", `first generation was not healthy: ${loaded.errors.join(",")}`);
    assert(loaded.pointer?.generation_id === first.pointer.generation_id, "first generation pointer mismatch");

    const invalidUtf8Path = ".dino/state/invalid-utf8.json";
    const invalidUtf8FullPath = path.join(dataRoot, ...invalidUtf8Path.split("/"));
    mkdirSync(path.dirname(invalidUtf8FullPath), { recursive: true });
    writeFileSync(invalidUtf8FullPath, Buffer.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0xff, 0x7d, 0x0a]));
    await expectPublishRejected(
      dataRoot,
      { artifactPaths: [invalidUtf8Path], generationId: "status-20260710-000010000-invalid-utf8" },
      "invalid UTF-8 status artifact was accepted",
    );

    const bareCrPath = ".dino/state/bare-cr.json";
    const bareCrFullPath = path.join(dataRoot, ...bareCrPath.split("/"));
    writeFileSync(bareCrFullPath, '{\r"status":"healthy"\n}\n', "utf8");
    await expectPublishRejected(
      dataRoot,
      { artifactPaths: [bareCrPath], generationId: "status-20260710-000020000-bare-cr" },
      "bare carriage return status artifact was accepted",
    );

    const fakeSqlitePath = ".dino/index/sqlite/fake.sqlite";
    const fakeSqliteFullPath = path.join(dataRoot, ...fakeSqlitePath.split("/"));
    mkdirSync(path.dirname(fakeSqliteFullPath), { recursive: true });
    const fakeSqlite = Buffer.alloc(4096);
    Buffer.from("SQLite format 3\0", "ascii").copy(fakeSqlite, 0);
    fakeSqlite.writeUInt16BE(4096, 16);
    fakeSqlite.writeUInt32BE(1, 28);
    writeFileSync(fakeSqliteFullPath, fakeSqlite);
    await expectPublishRejected(
      dataRoot,
      { artifactPaths: [fakeSqlitePath], generationId: "status-20260710-000030000-fake-sqlite" },
      "header-only fake SQLite artifact was accepted",
    );

    await expectPublishRejected(
      dataRoot,
      { artifactPaths: ["../outside.json"], generationId: "status-20260710-000040000-path-traversal" },
      "status artifact path traversal was accepted",
    );
    loaded = await loadCurrentStatusGeneration(dataRoot, { verifyEntries: true });
    assert(loaded.pointer?.generation_id === first.pointer.generation_id, "rejected artifacts replaced the pointer");

    json(dataRoot, artifactPaths[0], { status: "needs_attention", generation: 2, generated_at: "2026-07-10T00:01:00.000Z" });
    let interrupted = false;
    try {
      await publishStatusGeneration(dataRoot, {
        artifactPaths,
        generationId: "status-20260710-000100000-interrupted",
        now: new Date("2026-07-10T00:01:00.000Z"),
        beforePointerPublish: () => {
          throw new Error("simulated crash before pointer publication");
        },
      });
    } catch {
      interrupted = true;
    }
    assert(interrupted, "simulated pre-pointer crash did not interrupt publication");
    loaded = await loadCurrentStatusGeneration(dataRoot, { verifyEntries: true });
    assert(loaded.status === "healthy", `old generation became unreadable after interruption: ${loaded.errors.join(",")}`);
    assert(loaded.pointer?.generation_id === first.pointer.generation_id, "interrupted generation replaced the pointer");
    const oldHealthPath = resolveStatusGenerationArtifactPath(loaded, artifactPaths[0]);
    assert(oldHealthPath, "old generation health artifact could not be resolved");
    assert(JSON.parse(readFileSync(oldHealthPath, "utf8")).generation === 1, "reader observed interrupted generation data");

    let sourceRaceRejected = false;
    try {
      await publishStatusGeneration(dataRoot, {
        artifactPaths,
        generationId: "status-20260710-000100000-source-race",
        now: new Date("2026-07-10T00:01:00.000Z"),
        beforePointerPublish: () => {
          json(dataRoot, artifactPaths[0], {
            status: "needs_attention",
            generation: 3,
            generated_at: "2026-07-10T00:01:30.000Z",
          });
        },
      });
    } catch {
      sourceRaceRejected = true;
    }
    assert(sourceRaceRejected, "source mutation before pointer publication was accepted");
    loaded = await loadCurrentStatusGeneration(dataRoot, { verifyEntries: true });
    assert(loaded.pointer?.generation_id === first.pointer.generation_id, "source race replaced the prior pointer");

    json(dataRoot, artifactPaths[0], { status: "needs_attention", generation: 2, generated_at: "2026-07-10T00:01:00.000Z" });
    json(dataRoot, artifactPaths[1], { status: "needs_attention", generation: 2, generated_at: "2026-07-10T00:01:00.000Z" });
    const second = await publishStatusGeneration(dataRoot, {
      artifactPaths,
      generationId: "status-20260710-000100000-second",
      now: new Date("2026-07-10T00:01:00.000Z"),
    });
    loaded = await loadCurrentStatusGeneration(dataRoot, { verifyEntries: true, verifySourceCoherence: true });
    assert(loaded.status === "healthy", `second generation was not healthy: ${loaded.errors.join(",")}`);
    assert(loaded.pointer?.generation_id === second.pointer.generation_id, "second generation pointer mismatch");
    for (const artifactPath of artifactPaths) {
      const resolved = resolveStatusGenerationArtifactPath(loaded, artifactPath);
      assert(resolved, `second generation artifact missing: ${artifactPath}`);
      assert(JSON.parse(readFileSync(resolved, "utf8")).generation === 2, `mixed generation observed for ${artifactPath}`);
    }

    const pointerPath = path.join(dataRoot, ...STATUS_GENERATION_POINTER_RELATIVE_PATH.split("/"));
    const validPointerText = readFileSync(pointerPath, "utf8");
    writeFileSync(pointerPath, '{\r"status":"published"\n}\n', "utf8");
    loaded = await loadCurrentStatusGeneration(dataRoot, { verifyEntries: true });
    assert(loaded.status === "invalid", "bare-CR generation pointer was accepted");
    writeFileSync(pointerPath, validPointerText, "utf8");

    json(dataRoot, artifactPaths[0], { status: "healthy", generation: 3, generated_at: "2026-07-10T00:02:00.000Z" });
    loaded = await loadCurrentStatusGeneration(dataRoot, { verifyEntries: true, verifySourceCoherence: true });
    assert(loaded.status === "invalid", "canonical source drift did not invalidate generation coherence");
    assert(
      loaded.errors.includes(`source_generation_mismatch:${artifactPaths[0]}`),
      `source mismatch reason missing: ${loaded.errors.join(",")}`,
    );

    const snapshotPath = path.join(
      dataRoot,
      ".dino",
      "generations",
      "status",
      second.pointer.generation_id,
      "files",
      ...artifactPaths[1].split("/"),
    );
    writeFileSync(snapshotPath, "{tampered}\n", "utf8");
    loaded = await loadCurrentStatusGeneration(dataRoot, { verifyEntries: true });
    assert(loaded.status === "invalid", "snapshot tamper did not invalidate the generation");
    assert(
      loaded.errors.some((entry) => entry.includes(`snapshot_hash_mismatch:${artifactPaths[1]}`)),
      `snapshot tamper reason missing: ${loaded.errors.join(",")}`,
    );

    const pointer = JSON.parse(
      readFileSync(path.join(dataRoot, ...STATUS_GENERATION_POINTER_RELATIVE_PATH.split("/")), "utf8"),
    );
    assert(!JSON.stringify(pointer).includes(dataRoot), "generation pointer leaked a local root path");

    const largeSqlitePath = ".dino/index/sqlite/streaming-proof.sqlite";
    const largeSqliteFullPath = path.join(dataRoot, ...largeSqlitePath.split("/"));
    mkdirSync(path.dirname(largeSqliteFullPath), { recursive: true });
    const largeDatabase = new DatabaseSync(largeSqliteFullPath);
    try {
      largeDatabase.exec("PRAGMA journal_mode=DELETE; CREATE TABLE payload (id INTEGER PRIMARY KEY, body BLOB NOT NULL);");
      largeDatabase.exec("INSERT INTO payload (body) VALUES (zeroblob(67108864));");
    } finally {
      largeDatabase.close();
    }
    const rssBefore = process.memoryUsage().rss;
    await publishStatusGeneration(dataRoot, {
      artifactPaths: [largeSqlitePath],
      generationId: "status-20260710-000300000-streaming-sqlite",
      now: new Date("2026-07-10T00:03:00.000Z"),
    });
    const rssDelta = Math.max(0, process.memoryUsage().rss - rssBefore);
    assert(rssDelta < 96 * 1024 * 1024, `SQLite generation exceeded streaming RSS budget: ${rssDelta}`);
    console.log(
      JSON.stringify(
        {
          ok: true,
          first_generation: first.pointer.generation_id,
          interrupted_generation_hidden: true,
          source_change_before_pointer_rejected: true,
          second_generation: second.pointer.generation_id,
          mixed_generation_observed: false,
          invalid_utf8_rejected: true,
          bare_cr_rejected: true,
          sqlite_integrity_checked: true,
          path_traversal_rejected: true,
          source_drift_detected: true,
          snapshot_tamper_detected: true,
          sqlite_streaming_rss_delta_bytes: rssDelta,
          sqlite_streaming_rss_budget_bytes: 96 * 1024 * 1024,
          local_path_leak: false,
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
