import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scaleModule = await import(pathToFileURL(path.join(root, "dist", "scale-proof.js")).href);
const retrievalModule = await import(pathToFileURL(path.join(root, "dist", "hybrid-retrieval.js")).href);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const tempRoot = await mkdtemp(path.join(os.tmpdir(), "dinobrain-scale-verify-"));
try {
  const common = {
    recordCount: 300,
    sessionCount: 30,
    sampleCount: 4,
    graphSampleCount: 2,
    qualifying: false,
    fixtureSemantic: true,
  };
  const first = await scaleModule.runScaleProof({
    ...common,
    fixtureRoot: path.join(tempRoot, "fixture-a"),
    outputPath: path.join(tempRoot, "report-a.json"),
  });
  const second = await scaleModule.runScaleProof({
    ...common,
    fixtureRoot: path.join(tempRoot, "fixture-b"),
    outputPath: path.join(tempRoot, "report-b.json"),
  });
  assert(first.status === "healthy_fixture", `first fixture must be healthy: ${first.warnings.join(",")}`);
  assert(second.status === "healthy_fixture", `second fixture must be healthy: ${second.warnings.join(",")}`);
  assert(scaleModule.verifyScaleProofReport(first, false).ok, "healthy fixture integrity must verify");
  assert((await scaleModule.verifyScaleProofBindings(first)).ok, "healthy fixture code and environment bindings must verify");
  assert(first.corpus.manifest_sha256 === second.corpus.manifest_sha256, "curated corpus generation must be deterministic");
  assert(first.corpus.session_manifest_sha256 === second.corpus.session_manifest_sha256, "session growth generation must be deterministic");
  assert(first.bounded_work.sqlite_term_query_uses_index === true, "SQLite term lookup must use an index range");
  assert(first.bounded_work.sqlite_graph_query_uses_index === true, "SQLite graph window must use node and edge indexes");
  assert(first.bounded_work.dense_search_bounded === true, "partitioned dense search must be bounded");
  assert(first.bounded_work.max_dense_vectors_scanned <= first.thresholds.max_dense_vectors_scanned, "dense scan budget exceeded");
  assert(first.bounded_work.dense_index_cache.parses === 1, "dense index should parse exactly once per process cache lifecycle");
  assert(first.observatory.snapshot_payload_max_bytes <= first.thresholds.max_observatory_payload_bytes, "Observatory payload must be bounded");
  assert(first.observatory.graph_shown_nodes <= 450 && first.observatory.graph_shown_edges <= 900, "Observatory graph window must be bounded");
  assert(first.observatory.status_generation_verifications <= 1, "Observatory must not rehash the same status generation per poll");

  const tampered = structuredClone(first);
  tampered.measurements.wiki_search.p95_ms += 1;
  assert(!scaleModule.verifyScaleProofReport(tampered, false).ok, "tampered report must fail hash verification");
  const staleBinding = structuredClone(first);
  staleBinding.hashes.code_sha256 = "0".repeat(64);
  assert(!(await scaleModule.verifyScaleProofBindings(staleBinding)).ok, "stale code binding must fail verification");

  const breached = await scaleModule.runScaleProof({
    ...common,
    recordCount: 100,
    sessionCount: 10,
    sampleCount: 3,
    fixtureRoot: path.join(tempRoot, "fixture-breach"),
    outputPath: path.join(tempRoot, "report-breach.json"),
    thresholds: { max_wiki_search_p95_ms: 0.001 },
  });
  assert(breached.status === "needs_attention", "latency breach must fail the report");
  assert(breached.assertions.some((entry) => entry.id === "wiki_search_p95_budget" && !entry.ok), "latency breach assertion missing");
  assert(!scaleModule.verifyScaleProofReport(breached, false).ok, "breached report must not verify");

  const records = Object.fromEntries(Array.from({ length: 5_000 }, (_, index) => [`record-${index}`, [1, index % 2 ? 0.1 : 0.2]]));
  const unpartitioned = {
    provider: "semantic-fixture",
    model: "semantic-fixture",
    dimensions: 2,
    record_count: 5_000,
    semantic_embedding_provider: true,
    records,
    queries: { query: [1, 0] },
  };
  const rejected = retrievalModule.denseVectorCandidatesDetailed(unpartitioned, "query", 64);
  assert(rejected.candidates.length === 0, "unpartitioned oversized dense index must fail closed");
  assert(rejected.stats.bounded === false && rejected.stats.vectors_scanned === 0, "unpartitioned oversized index must expose bounded-work failure");
  const forgedCount = { ...unpartitioned, record_count: 1, record_count_verified: false };
  const forgedRejected = retrievalModule.denseVectorCandidatesDetailed(forgedCount, "query", 64);
  assert(forgedRejected.candidates.length === 0 && forgedRejected.stats.bounded === false, "unverified declared vector count must not bypass bounded search");

  console.log("50k scale proof regression verification ok");
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}
