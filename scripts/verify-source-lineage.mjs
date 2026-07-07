import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const {
  buildSourceLineageReport,
  buildAndWriteSourceLineageReport,
  SOURCE_LINEAGE_STATUS_RELATIVE_PATH,
} = await import(pathToFileURL(path.join(root, "dist", "source-lineage.js")).href);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function write(filePath, value) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function withFixture(fn) {
  const dataRoot = mkdtempSync(path.join(tmpdir(), "dinobrain-source-lineage-"));
  try {
    return await fn(dataRoot);
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
}

function seedWikiClaim(dataRoot, sourceStatus = "verified_summary") {
  write(
    path.join(dataRoot, "20_Wiki", "RAG-Knowledge.md"),
    `---
title: RAG Knowledge
source_status: ${sourceStatus}
tags: [rag, verified-knowledge]
---
# RAG Knowledge

Verified RAG claim.
`,
  );
}

function seedBehaviorMemory(dataRoot) {
  write(path.join(dataRoot, "50_Instances", "accepted", "codex-session-knowledge-user-rule.json"), {
    title: "Current instruction outranks memory",
    source_status: "internal",
    tags: ["codex-session-derived", "operating-rule"],
    summary: "Current user instructions outrank stored memory.",
  });
}

function seedSourceChunk(
  dataRoot,
  {
    id = "rag-source",
    claimPath = "20_Wiki/RAG-Knowledge.md",
    verificationStatus = "verified_summary",
    includeVerification = true,
    includeProvenance = true,
    includeChunkText = true,
    includeUri = true,
  } = {},
) {
  const chunk = {
    source_chunk_id: id,
    type: "source_chunk",
    status: "active",
    title: "RAG source",
    chunk_type: "external_doc",
    claim_paths: [claimPath],
  };
  if (includeUri) chunk.source_uri = "https://example.com/rag";
  if (includeChunkText) chunk.chunk_text = "Verified source summary for the claim.";
  if (includeVerification) chunk.verification_status = verificationStatus;
  write(path.join(dataRoot, "30_Sources", "chunks", `${id}.json`), chunk);

  if (includeProvenance) {
    write(path.join(dataRoot, ".dino", "provenance", `${id}.json`), {
      provenance_id: id,
      source_chunk_path: `30_Sources/chunks/${id}.json`,
      claim_paths: [claimPath],
      source_uri: "https://example.com/rag",
      verification_status: verificationStatus,
    });
  }
}

async function expectSignal(seed, signal) {
  await withFixture(async (dataRoot) => {
    seed(dataRoot);
    const report = await buildSourceLineageReport(dataRoot, { now: new Date("2026-07-07T00:00:00.000Z") });
    assert(report.status === "needs_attention", `expected needs_attention for ${signal}, got ${report.status}`);
    assert(report.findings.some((finding) => finding.signal === signal), `missing finding ${signal}`);
  });
}

await withFixture(async (dataRoot) => {
  seedWikiClaim(dataRoot);
  seedBehaviorMemory(dataRoot);
  seedSourceChunk(dataRoot);
  const report = await buildSourceLineageReport(dataRoot, { now: new Date("2026-07-07T00:00:00.000Z") });
  assert(report.status === "healthy", `clean fixture should be healthy, got ${report.status}`);
  assert(report.counts.verified_source_chunks === 1, "clean fixture should count verified source chunk");
  assert(report.counts.behavior_memory_records === 1, "behavior memory without external source should be allowed");
  assert(report.claim_records.some((claim) => claim.item_class === "verified_claim_support"), "wiki claim was not supported");
  const written = await buildAndWriteSourceLineageReport(dataRoot, {
    now: new Date("2026-07-07T00:00:00.000Z"),
  });
  assert(written.report.status === "healthy", "written report should be healthy");
  assert(written.path.replace(/\\/g, "/").endsWith(SOURCE_LINEAGE_STATUS_RELATIVE_PATH), "status path mismatch");
});

await expectSignal((dataRoot) => {
  seedWikiClaim(dataRoot);
  seedSourceChunk(dataRoot, { verificationStatus: "anchor_only_unverified" });
}, "anchor_only_used_as_support");

await expectSignal((dataRoot) => {
  seedWikiClaim(dataRoot);
  seedSourceChunk(dataRoot, { includeProvenance: false });
}, "provenance_missing");

await expectSignal((dataRoot) => {
  seedWikiClaim(dataRoot);
  seedSourceChunk(dataRoot, { claimPath: "20_Wiki/Missing.md" });
}, "dangling_claim_path");

await expectSignal((dataRoot) => {
  seedWikiClaim(dataRoot);
  seedSourceChunk(dataRoot, { includeVerification: false });
}, "source_chunk_verification_missing");

await expectSignal((dataRoot) => {
  seedWikiClaim(dataRoot);
  seedSourceChunk(dataRoot, { includeChunkText: false });
}, "source_chunk_body_missing");

await expectSignal((dataRoot) => {
  seedWikiClaim(dataRoot);
  seedSourceChunk(dataRoot, { includeUri: false });
}, "source_chunk_uri_missing");

console.log("source lineage verification ok");
