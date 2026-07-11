import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
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

function seedConversationRegistry(dataRoot) {
  write(
    path.join(dataRoot, "20_Wiki", "Conversation-Registry.md"),
    `---
title: Conversation Registry
tags: [chatgpt, sessions, conversation-registry, llm-wiki, provenance]
---
# Conversation Registry

This is a privacy-preserving internal catalog of supplied session evidence.
`,
  );
}

function seedFactualProject(dataRoot, sourceStatus = "verified_summary") {
  write(
    path.join(dataRoot, "40_Projects", "Factual-Project.md"),
    `---
title: Factual Project Claim
source_status: ${sourceStatus}
tags: [rag, source-lineage, public]
---
# Factual Project Claim

This project note makes a source-backed public RAG claim.
`,
  );
}

function seedFactualAcceptedInstance(dataRoot, extra = {}) {
  write(path.join(dataRoot, "50_Instances", "accepted", "rag-factual-instance.json"), {
    title: "Accepted factual RAG instance",
    source_status: "verified_summary",
    tags: ["rag", "verified-knowledge", "source-lineage"],
    summary: "Accepted factual RAG knowledge should be source-backed.",
    ...extra,
  });
}

function seedAnchorCatalog(dataRoot) {
  write(
    path.join(dataRoot, "20_Wiki", "Anchor-Catalog.md"),
    `---
title: Anchor Catalog
source_status: anchor_only_unverified
tags: [rag, anchor-catalog]
---
# Anchor Catalog

This is only an anchor catalog.
`,
  );
}

function seedBareFactualWiki(dataRoot) {
  write(
    path.join(dataRoot, "20_Wiki", "Bare-Factual-Claim.md"),
    `# Bare factual claim

This unmarked Wiki sentence asserts that a public benchmark result is established.
`,
  );
}

function seedInternalTraceOnlyClaim(dataRoot) {
  write(
    path.join(dataRoot, "20_Wiki", "Trace-Only-Claim.md"),
    `---
title: Trace-only factual claim
source_status: verified_summary
source_paths: [.dino/traces/internal-trace.json]
tags: [external, public]
---
# Trace-only factual claim

This external factual claim cites only an internal execution trace.
`,
  );
  write(path.join(dataRoot, ".dino", "traces", "internal-trace.json"), { summary: "Internal execution evidence only." });
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
  const chunkText = includeChunkText ? "Verified source summary for the claim." : "";
  const sourceContentSha256 = sha256(chunkText);
  const chunkSha256 = sha256(chunkText);
  const claimFile = path.join(dataRoot, ...claimPath.split("/"));
  let claimSha256 = sha256(`missing:${claimPath}`);
  try {
    claimSha256 = sha256(readFileSync(claimFile));
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const generationId = `lineage-${id}`;
  const snapshotPath = `30_Sources/fetched/${id}.json`;
  const chunkPath = `30_Sources/chunks/${id}.json`;
  const provenancePath = `.dino/provenance/${id}.json`;
  const generationPath = `.dino/provenance/generations/${generationId}.json`;
  if (includeUri) chunk.source_uri = "https://example.com/rag";
  if (includeChunkText) chunk.chunk_text = chunkText;
  if (includeVerification) {
    chunk.verification_status = verificationStatus;
    chunk.last_verified = "2026-07-07";
    chunk.verification_method = "fixture_direct_review";
  }
  chunk.source_snapshot_path = snapshotPath;
  chunk.source_content_sha256 = sourceContentSha256;
  chunk.chunk_sha256 = chunkSha256;
  chunk.claim_bindings = [{ path: claimPath, sha256: claimSha256 }];
  chunk.lineage_generation_id = generationId;
  chunk.lineage_generation_path = generationPath;
  write(path.join(dataRoot, ...snapshotPath.split("/")), {
    version: "source_snapshot_v1",
    type: "source_snapshot",
    source_id: id,
    source_uri: includeUri ? "https://example.com/rag" : null,
    source_content_sha256: sourceContentSha256,
    verification_status: includeVerification ? verificationStatus : null,
    last_verified: includeVerification ? "2026-07-07" : null,
    verification_method: includeVerification ? "fixture_direct_review" : null,
  });
  write(path.join(dataRoot, ...chunkPath.split("/")), chunk);

  if (includeProvenance) {
    write(path.join(dataRoot, ...provenancePath.split("/")), {
      provenance_id: id,
      source_snapshot_path: snapshotPath,
      source_chunk_path: chunkPath,
      claim_paths: [claimPath],
      claim_bindings: [{ path: claimPath, sha256: claimSha256 }],
      source_uri: "https://example.com/rag",
      verification_status: verificationStatus,
      verification_method: "fixture_direct_review",
      source_content_sha256: sourceContentSha256,
      chunk_sha256: chunkSha256,
      lineage_generation_id: generationId,
      lineage_generation_path: generationPath,
    });
  }
  const artifactPaths = [snapshotPath, chunkPath, ...(includeProvenance ? [provenancePath] : [])];
  write(path.join(dataRoot, ...generationPath.split("/")), {
    version: "source_lineage_generation_v1",
    type: "lineage_generation",
    generation_id: generationId,
    source_snapshot_path: snapshotPath,
    source_chunk_path: chunkPath,
    provenance_path: provenancePath,
    source_content_sha256: sourceContentSha256,
    chunk_sha256: chunkSha256,
    verification_status: verificationStatus,
    claim_bindings: [{ path: claimPath, sha256: claimSha256 }],
    artifact_bindings: artifactPaths.map((artifactPath) => ({
      path: artifactPath,
      after_sha256: sha256(readFileSync(path.join(dataRoot, ...artifactPath.split("/")))),
    })),
  });
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
  seedConversationRegistry(dataRoot);
  seedSourceChunk(dataRoot);
  seedFactualAcceptedInstance(dataRoot, {
    source_paths: ["20_Wiki/RAG-Knowledge.md"],
  });
  const report = await buildSourceLineageReport(dataRoot, { now: new Date("2026-07-07T00:00:00.000Z") });
  assert(report.status === "healthy", `clean fixture should be healthy, got ${report.status}`);
  assert(report.counts.verified_source_chunks === 1, "clean fixture should count verified source chunk");
  assert(report.counts.behavior_memory_records === 1, "behavior memory without external source should be allowed");
  assert(report.counts.internal_session_evidence_records === 1, "conversation registry was not classified as internal session evidence");
  assert(report.claim_records.some((claim) => claim.item_class === "verified_claim_support"), "wiki claim was not supported");
  assert(
    report.claim_records.some(
      (claim) => claim.path === "50_Instances/accepted/rag-factual-instance.json" && claim.item_class === "verified_claim_support",
    ),
    "accepted factual instance with verified durable source path was not supported",
  );
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

await expectSignal((dataRoot) => {
  seedWikiClaim(dataRoot);
  seedSourceChunk(dataRoot);
  rmSync(path.join(dataRoot, "30_Sources", "fetched", "rag-source.json"), { force: true });
}, "source_snapshot_missing");

await expectSignal((dataRoot) => {
  seedWikiClaim(dataRoot);
  seedSourceChunk(dataRoot);
  rmSync(path.join(dataRoot, ".dino", "provenance", "generations", "lineage-rag-source.json"), { force: true });
}, "lineage_generation_missing");

await expectSignal((dataRoot) => {
  seedFactualProject(dataRoot);
}, "unsupported_factual_claim");

await expectSignal((dataRoot) => {
  seedFactualAcceptedInstance(dataRoot);
}, "unsupported_factual_claim");

await expectSignal((dataRoot) => {
  seedFactualAcceptedInstance(dataRoot, {
    source_paths: ["20_Wiki/Anchor-Catalog.md"],
  });
  seedAnchorCatalog(dataRoot);
}, "anchor_only_used_as_support");

await expectSignal((dataRoot) => {
  seedBareFactualWiki(dataRoot);
}, "unsupported_factual_claim");

await expectSignal((dataRoot) => {
  seedInternalTraceOnlyClaim(dataRoot);
}, "internal_trace_only_used_as_support");

console.log("source lineage verification ok");
