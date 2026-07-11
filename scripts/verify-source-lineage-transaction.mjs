import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const publication = await import(pathToFileURL(path.join(root, "dist", "source-lineage-publication.js")).href);
const lineage = await import(pathToFileURL(path.join(root, "dist", "source-lineage.js")).href);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function write(filePath, value) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function claimText(title = "Transactional source claim") {
  return `---
title: ${title}
source_status: verified_summary
tags: [source-lineage, verified-knowledge, external]
---
# ${title}

According to the verified external source, transactional lineage prevents partial claim support.
`;
}

function input(overrides = {}) {
  return {
    source_chunk_id: "transactional-source",
    source_title: "Transactional source",
    source_uri: "https://example.com/transactional-source",
    chunk_type: "external_doc",
    chunk_text: "Verified source text supporting a transactional claim.",
    claim_paths: ["20_Wiki/Transactional-Claim.md"],
    tags: ["source-lineage", "verified-knowledge"],
    verification_status: "verified_chunk",
    last_verified: "2026-07-11",
    fetched_at: "2026-07-11T00:00:00.000Z",
    verification_method: "fixture_direct_review",
    verification_actor: "source-lineage-transaction-verifier",
    actor: "source-lineage-transaction-verifier",
    ...overrides,
  };
}

async function withFixture(run) {
  const dataRoot = mkdtempSync(path.join(tmpdir(), "dinobrain-source-lineage-tx-"));
  write(path.join(dataRoot, "20_Wiki", "Transactional-Claim.md"), claimText());
  try {
    return await run(dataRoot);
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
}

await withFixture(async (dataRoot) => {
  const first = await publication.publishSourceLineage(dataRoot, input());
  assert(first.status === "committed" && !first.idempotent, "first lineage publication did not commit");
  for (const relativePath of [
    first.source_snapshot_path,
    first.source_chunk_path,
    first.provenance_path,
    first.generation_receipt_path,
    first.transaction_path,
  ]) {
    assert(existsSync(path.join(dataRoot, ...relativePath.split("/"))), `missing lineage artifact ${relativePath}`);
  }
  const report = await lineage.buildSourceLineageReport(dataRoot, { now: new Date("2026-07-11T12:00:00.000Z") });
  assert(report.status === "healthy", `published lineage should be healthy: ${JSON.stringify(report.findings)}`);
  assert(report.counts.source_snapshots === 1, "source snapshot was not counted");
  assert(report.counts.lineage_generations === 1, "lineage generation was not counted");
  assert(report.counts.verified_claim_support === 1, "claim support was not verified");

  const repeated = await publication.publishSourceLineage(dataRoot, input());
  assert(repeated.idempotent === true && repeated.transaction_id === first.transaction_id, "same generation was not idempotent");

  const parallel = await Promise.all(Array.from({ length: 16 }, () => publication.publishSourceLineage(dataRoot, input())));
  assert(parallel.every((result) => result.idempotent && result.transaction_id === first.transaction_id), "parallel idempotency failed");

  const rolledBack = await publication.rollbackSourceLineageTransaction(dataRoot, first.transaction_id);
  assert(rolledBack.status === "rolled_back", "lineage rollback did not complete");
  assert(!existsSync(path.join(dataRoot, ...first.source_chunk_path.split("/"))), "rollback left source chunk published");
  const reapplied = await publication.reapplySourceLineageTransaction(dataRoot, first.transaction_id);
  assert(reapplied.status === "committed", "lineage reapply did not commit");
  const restored = await lineage.buildSourceLineageReport(dataRoot, { now: new Date("2026-07-11T12:00:00.000Z") });
  assert(restored.status === "healthy", "reapplied lineage is not healthy");

  let staleDateRejected = false;
  try {
    await publication.publishSourceLineage(
      dataRoot,
      input({ chunk_text: "Changed source body.", last_verified: "2026-07-11", fetched_at: "2026-07-11T01:00:00.000Z" }),
    );
  } catch (error) {
    staleDateRejected = /newer last_verified/.test(String(error));
  }
  assert(staleDateRejected, "changed source content reused an old verification date");

  const changed = await publication.publishSourceLineage(
    dataRoot,
    input({ chunk_text: "Changed and reverified source body.", last_verified: "2026-07-12", fetched_at: "2026-07-12T00:00:00.000Z" }),
  );
  assert(changed.content_changed === true && !changed.idempotent, "changed source did not create a new verified generation");
  const changedChunk = JSON.parse(readFileSync(path.join(dataRoot, ...changed.source_chunk_path.split("/")), "utf8"));
  assert(changedChunk.previous_source_content_sha256, "changed source lost previous content hash");
});

await withFixture(async (dataRoot) => {
  let interrupted = false;
  try {
    await publication.publishSourceLineage(dataRoot, input({ fault_after_write_index_for_test: 1 }));
  } catch (error) {
    interrupted = /Injected source lineage transaction fault/.test(String(error));
  }
  assert(interrupted, "fault injection did not interrupt lineage publication");
  assert(!existsSync(path.join(dataRoot, "30_Sources", "fetched", "transactional-source.json")), "fault left source snapshot");
  assert(!existsSync(path.join(dataRoot, "30_Sources", "chunks", "transactional-source.json")), "fault left source chunk");
  assert(!existsSync(path.join(dataRoot, ".dino", "provenance", "transactional-source.json")), "fault left provenance");
});

await withFixture(async (dataRoot) => {
  const published = await publication.publishSourceLineage(dataRoot, input());
  write(path.join(dataRoot, "20_Wiki", "Transactional-Claim.md"), claimText("Mutated claim"));
  const report = await lineage.buildSourceLineageReport(dataRoot, { now: new Date("2026-07-11T12:00:00.000Z") });
  assert(report.status === "needs_attention", "claim mutation did not invalidate lineage");
  assert(report.findings.some((finding) => finding.signal === "claim_content_hash_mismatch"), "claim hash mismatch signal missing");
  let staleClaimReviewRejected = false;
  try {
    await publication.publishSourceLineage(dataRoot, input());
  } catch (error) {
    staleClaimReviewRejected = /newer last_verified/.test(String(error));
  }
  assert(staleClaimReviewRejected, "changed claim support reused an old verification date");

  let rollbackBlocked = false;
  const chunkPath = path.join(dataRoot, ...published.source_chunk_path.split("/"));
  const chunk = JSON.parse(readFileSync(chunkPath, "utf8"));
  chunk.chunk_text = "tampered";
  write(chunkPath, chunk);
  try {
    await publication.rollbackSourceLineageTransaction(dataRoot, published.transaction_id);
  } catch (error) {
    rollbackBlocked = /blocked by external changes/.test(String(error));
  }
  assert(rollbackBlocked, "tampered lineage allowed destructive rollback");
});

await withFixture(async (dataRoot) => {
  await publication.publishSourceLineage(dataRoot, input({ last_verified: "2026-01-01", fetched_at: "2026-01-01T00:00:00.000Z" }));
  const report = await lineage.buildSourceLineageReport(dataRoot, { now: new Date("2026-07-11T12:00:00.000Z") });
  assert(report.status === "needs_attention", "stale source support passed lineage gate");
  assert(report.findings.some((finding) => finding.signal === "source_chunk_verification_stale"), "stale support signal missing");
});

await withFixture(async (dataRoot) => {
  let unverifiedRejected = false;
  try {
    await publication.publishSourceLineage(dataRoot, input({ verification_status: "fetched_unverified", last_verified: undefined }));
  } catch (error) {
    unverifiedRejected = /cannot support claims/.test(String(error));
  }
  assert(unverifiedRejected, "unverified source was allowed to support a claim");
});

console.log("source lineage transaction verification ok");
