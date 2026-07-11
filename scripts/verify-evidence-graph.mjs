import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  buildAndWriteEvidenceGraph,
  EVIDENCE_GRAPH_LANES,
  EVIDENCE_GRAPH_REQUIRED_EDGE_TYPES,
  EVIDENCE_GRAPH_SQLITE_RELATIVE_PATH,
  readEvidenceGraphWindow,
} from "../dist/evidence-graph.js";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function removeFixtureRoot(root) {
  let lastError = null;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      rmSync(root, { recursive: true, force: true });
      return;
    } catch (error) {
      lastError = error;
      if (!['EPERM', 'EBUSY', 'EACCES'].includes(error?.code)) throw error;
      await new Promise((resolve) => setTimeout(resolve, 100 + attempt * 25));
    }
  }
  throw lastError;
}

function writeJson(root, relativePath, value) {
  const target = path.join(root, ...relativePath.split("/"));
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  return target;
}

function writeText(root, relativePath, value) {
  const target = path.join(root, ...relativePath.split("/"));
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, value, "utf8");
  return target;
}

function fixture(root) {
  const now = "2026-07-11T10:00:00.000Z";
  const old = "2026-01-01T00:00:00.000Z";
  const memoryPath = "50_Instances/accepted/correction-1.json";
  const candidatePath = "50_Instances/candidates/correction-1.json";
  const reviewPath = "80_Review_Queue/promotion/correction-1.json";
  const chunkPath = "30_Sources/chunks/source-1.json";
  const snapshotPath = "30_Sources/fetched/source-1.json";
  const claimPath = "20_Wiki/Claim.md";
  const taskPath = ".dino/tasks/task-1.json";
  const staleTaskPath = ".dino/tasks/task-stale.json";
  const packPath = ".dino/context-packs/pack-1.json";
  const tracePath = ".dino/traces/task-1.json";

  writeJson(root, ".dino/index/wiki-index.json", {
    version: 1,
    generated_at: now,
    record_count: 2,
    records: [
      { path: claimPath, kind: "curated_record", title: "Verified Claim", tags: ["claim"], root: "20_Wiki", size_bytes: 120, links: [] },
      { path: memoryPath, kind: "curated_record", title: "Corrected Rule", tags: ["behavior"], root: "50_Instances", size_bytes: 180, links: [] },
    ],
  });
  writeText(root, claimPath, "# Verified Claim\n");
  writeJson(root, snapshotPath, { type: "source_snapshot", status: "verified", title: "Fetched Source", source_uri: "https://example.test/source", updated_at: now });
  writeJson(root, chunkPath, {
    source_chunk_id: "source-1",
    type: "source_chunk",
    status: "active",
    title: "Bounded Source Chunk",
    source_snapshot_path: snapshotPath,
    source_uri: "https://example.test/source",
    claim_paths: [claimPath],
    verification_status: "verified_summary",
    updated_at: now,
  });
  writeJson(root, candidatePath, {
    candidate_id: "correction-1",
    type: "feedback_correction",
    status: "pending_review",
    claim: "Use the corrected behavior.",
    evidence: { source: chunkPath },
    successor_paths: [memoryPath],
    updated_at: now,
  });
  writeJson(root, reviewPath, {
    review_id: "correction-1",
    type: "correction_promotion",
    status: "pending",
    candidate_path: candidatePath,
    predecessor_paths: [candidatePath],
    successor_paths: [memoryPath],
    updated_at: now,
  });
  writeJson(root, memoryPath, {
    memory_id: "correction-1",
    type: "feedback_correction",
    status: "accepted",
    title: "Corrected Rule",
    source_candidate_path: candidatePath,
    source_review_path: reviewPath,
    predecessor_paths: [candidatePath, reviewPath],
    evidence: { source: chunkPath },
    verification_status: "accepted_by_agent_review",
    updated_at: now,
  });
  writeJson(root, taskPath, { task_id: "task-1", status: "started", request: "Use the corrected rule", updated_at: now });
  writeJson(root, staleTaskPath, { task_id: "task-stale", status: "started", request: "Old unfinished work", updated_at: old });
  writeJson(root, packPath, { pack_id: "pack-1", task_id: "task-1", status: "created", question: "Use memory", items: [{ path: memoryPath, score: 9 }], created_at: now });
  writeJson(root, tracePath, { task_id: "task-1", outcome: "completed", context_pack_paths: [packPath], used_memory_paths: [memoryPath], finished_at: now });
  writeJson(root, ".dino/audits/audit-1.json", {
    audit_id: "audit-1",
    type: "memory_use_audit",
    status: "verified",
    task_id: "task-1",
    declared_used_memory_paths: [memoryPath],
    observed_used_memory_paths: [memoryPath],
    trust_score: 100,
    audited_at: now,
  });
  writeText(root, ".dino/events/2026-07-11.jsonl", `${JSON.stringify({
    event: "task_sync_completed",
    at: now,
    task_id: "task-1",
    auto_sync: { committed: true, pushed: true, commit: "0123456789abcdef0123456789abcdef01234567", allowed_paths: [memoryPath] },
  })}\n`);
  writeJson(root, ".dino/state/blocked_status.json", { status: "blocked", title: "Blocked gate", generated_at: now });
  writeJson(root, ".dino/state/client_mcp_direct_status.json", { status: "needs_recheck", title: "Verifier pending", generated_at: now });
  writeJson(root, ".dino/state/release_manifest_status.json", { status: "needs_attention", title: "Main pending", generated_at: now });
  return { memoryPath, candidatePath, reviewPath, chunkPath, snapshotPath, claimPath, taskPath, packPath, tracePath };
}

function edgeCounts(databasePath) {
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    return Object.fromEntries(db.prepare("SELECT type, COUNT(*) AS count FROM edges GROUP BY type").all().map((row) => [row.type, Number(row.count)]));
  } finally {
    db.close();
  }
}

function nodeIdForPath(databasePath, targetPath) {
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    return db.prepare("SELECT id FROM nodes WHERE path = ? ORDER BY priority DESC LIMIT 1").get(targetPath)?.id ?? null;
  } finally {
    db.close();
  }
}

const root = mkdtempSync(path.join(tmpdir(), "dinobrain-evidence-graph-"));
try {
  const paths = fixture(root);
  const first = await buildAndWriteEvidenceGraph(root);
  assert(first.status.status === "healthy", `initial graph status was not healthy: ${JSON.stringify(first.status.blockers)}`);
  assert(first.status.parity.status === "healthy", "initial graph count parity failed");
  assert(first.status.counts.parse_errors === 0, "initial graph reported parse errors");
  assert(first.status.memory.rss_delta_bytes < 192 * 1024 * 1024, "initial graph retained more than 192 MiB RSS");
  const databasePath = path.join(root, ...EVIDENCE_GRAPH_SQLITE_RELATIVE_PATH.split("/"));
  const relations = edgeCounts(databasePath);
  for (const type of EVIDENCE_GRAPH_REQUIRED_EDGE_TYPES) {
    assert(Number(relations[type] ?? 0) > 0, `required evidence relation was not materialized: ${type}`);
  }
  for (const lane of EVIDENCE_GRAPH_LANES) {
    assert(Number(first.status.counts.by_lane[lane] ?? 0) > 0, `required operational lane was not materialized: ${lane}`);
  }

  const memoryId = nodeIdForPath(databasePath, paths.memoryPath);
  assert(memoryId, "accepted memory did not receive a stable graph node id");
  const focus = await readEvidenceGraphWindow(root, { focusId: memoryId, focusDepth: 4, nodeLimit: 220, edgeLimit: 400 });
  assert(focus.ok === true, "focus graph query failed");
  const focusPaths = new Set(focus.nodes.map((node) => node.path).filter(Boolean));
  for (const requiredPath of [paths.taskPath, paths.reviewPath, paths.chunkPath, paths.snapshotPath]) {
    assert(focusPaths.has(requiredPath), `focused memory lineage did not reach ${requiredPath}`);
  }
  const focusRelations = new Set(focus.edges.map((edge) => edge.type));
  for (const requiredType of ["task_to_trace", "memory_observed_used", "correction_to_rule", "source_to_chunk"]) {
    assert(focusRelations.has(requiredType), `focused memory lineage omitted ${requiredType}`);
  }

  const reviewWindow = await readEvidenceGraphWindow(root, { lane: "reviewer_pending", nodeLimit: 120, edgeLimit: 180 });
  assert(reviewWindow.nodes.some((node) => node.path === paths.candidatePath), "review lane omitted candidate");
  assert(reviewWindow.nodes.some((node) => node.path === paths.reviewPath), "review lane omitted review");
  assert(reviewWindow.nodes.filter((node) => node.type !== "lane").every((node) => node.lane === "reviewer_pending"), "review lane leaked unrelated nodes");

  const relationWindow = await readEvidenceGraphWindow(root, { edgeTypes: ["candidate_to_review"], nodeLimit: 80, edgeLimit: 80 });
  assert(relationWindow.edges.length > 0, "relation filter returned no candidate-to-review edge");
  assert(relationWindow.edges.every((edge) => edge.type === "candidate_to_review"), "relation filter leaked another edge type");

  const second = await buildAndWriteEvidenceGraph(root);
  assert(second.status.incremental.rebuilt_sources === 0, "unchanged rebuild reparsed a source");
  assert(second.status.incremental.reused_sources === second.status.counts.sources, "unchanged rebuild did not reuse every source");
  assert(second.status.incremental.removed_sources === 0, "unchanged rebuild reported removed sources");
  assert(nodeIdForPath(databasePath, paths.memoryPath) === memoryId, "stable memory node id changed across rebuild");

  process.env.DINOBRAIN_EVIDENCE_GRAPH_VERIFY_HASHES = "1";
  const fullHash = await buildAndWriteEvidenceGraph(root);
  delete process.env.DINOBRAIN_EVIDENCE_GRAPH_VERIFY_HASHES;
  assert(fullHash.status.incremental.fingerprint_mode === "full_sha256_v1", "completion-mode full hashing was not reported");
  assert(fullHash.status.incremental.hash_verified_sources === fullHash.status.counts.sources, "completion-mode hashing did not verify every source");
  assert(fullHash.status.incremental.rebuilt_sources === 0, "full hash verification reparsed unchanged sources");

  const trace = JSON.parse(readFileSync(path.join(root, ...paths.tracePath.split("/")), "utf8"));
  trace.used_memory_paths.push(paths.claimPath);
  writeJson(root, paths.tracePath, trace);
  const third = await buildAndWriteEvidenceGraph(root);
  assert(third.status.status === "healthy", "one-source incremental rebuild became unhealthy");
  assert(third.status.incremental.rebuilt_sources === 1, `expected one rebuilt source, got ${third.status.incremental.rebuilt_sources}`);
  assert(third.status.incremental.removed_sources === 0, "changed source was misclassified as removed");
  assert(nodeIdForPath(databasePath, paths.memoryPath) === memoryId, "stable memory node id changed after incremental update");

  writeText(root, "50_Instances/candidates/malformed.json", "{not-json\n");
  const malformed = await buildAndWriteEvidenceGraph(root);
  assert(malformed.status.status === "needs_attention", "malformed source did not fail graph health");
  assert(malformed.status.counts.parse_errors === 1, "malformed source parse error count was not exact");
  assert(malformed.status.blockers.some((blocker) => blocker.includes("malformed.json")), "malformed source blocker omitted exact evidence path");

  const corruptRoot = mkdtempSync(path.join(tmpdir(), "dinobrain-evidence-graph-corrupt-"));
  try {
    fixture(corruptRoot);
    const corruptDatabasePath = path.join(corruptRoot, ...EVIDENCE_GRAPH_SQLITE_RELATIVE_PATH.split("/"));
    mkdirSync(path.dirname(corruptDatabasePath), { recursive: true });
    writeFileSync(corruptDatabasePath, "corrupt graph index", "utf8");
    const recovered = await buildAndWriteEvidenceGraph(corruptRoot);
    assert(recovered.status.status === "healthy", "corrupted prior graph did not rebuild from source evidence");
    assert(recovered.status.incremental.previous_index_available === false, "corrupted prior graph was treated as reusable");
    assert(recovered.status.incremental.rebuilt_sources === recovered.status.counts.sources, "corrupted prior graph did not rebuild every source");
  } finally {
    await removeFixtureRoot(corruptRoot);
  }

  console.log(JSON.stringify({
    ok: true,
    version: first.status.version,
    counts: first.status.counts,
    required_relations: EVIDENCE_GRAPH_REQUIRED_EDGE_TYPES,
    lanes: EVIDENCE_GRAPH_LANES,
    focused_node_id: memoryId,
    focused_node_count: focus.nodes.length,
    focused_edge_count: focus.edges.length,
    incremental: {
      unchanged: second.status.incremental,
      full_hash: fullHash.status.incremental,
      one_changed_source: third.status.incremental,
    },
    malformed_fail_closed: true,
    corrupt_index_rebuilt: true,
  }, null, 2));
} finally {
  await removeFixtureRoot(root);
}
