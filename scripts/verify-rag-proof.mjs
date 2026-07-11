import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { buildAndWriteRagProof, RAG_GOLDEN_RELATIVE_PATH, RAG_PROOF_STATUS_RELATIVE_PATH } = await import(
  pathToFileURL(path.join(root, "dist", "rag-proof.js")).href
);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function json(filePath, value) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function text(filePath, value) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, value, "utf8");
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function acceptedRecord(query) {
  const at = "2026-07-11T00:00:00.000Z";
  const transitionId = "node-transition-rag-quality";
  return {
    memory_id: "rag-quality",
    node_id: "rag-quality",
    knowledge_role: "behavior_guidance",
    title: "RAG quality proof",
    aliases: [query],
    claim: "Use verified chunks, honest retrieval modes, hybrid retrieval, and behavior evaluation.",
    reusable_rule: "Cite reviewed evidence and do not treat URL anchors as verified chunks.",
    tags: ["rag", "retrieval", "evaluation"],
    status: "accepted",
    lifecycle_version: "node_lifecycle_v3",
    lifecycle_state: "accepted",
    lifecycle_state_entered_at: at,
    lifecycle_last_transition_id: transitionId,
    lifecycle_history: [{
      transition_id: transitionId,
      idempotency_key: "verify-rag-proof|rag-quality|accepted",
      from_state: null,
      to_state: "accepted",
      reason_code: "verified_fixture",
      reason: "Seed a reviewed accepted memory for RAG proof verification.",
      actor: "verify-rag-proof",
      evidence_paths: ["30_Sources/chunks/rag-method.json"],
      predecessor_paths: [],
      successor_paths: [],
      at,
    }],
    predecessor_paths: [],
    successor_paths: [],
    review_status: "accepted_by_agent_review",
    reviewed_by: "verify-rag-proof",
    reviewed_at: at,
    updated_at: at,
    source_candidate_path: "50_Instances/candidates/rag-quality.json",
    source_review_path: "50_Instances/reviews/rag-quality.json",
    source_paths: ["30_Sources/chunks/rag-method.json"],
    evidence: { source: "30_Sources/chunks/rag-method.json" },
  };
}

function seedVault(dataRoot) {
  const query = "How should DinoBrain prove RAG quality?";
  text(path.join(dataRoot, "20_Wiki", "README.md"), "# Wiki\n\nCurated reusable notes.\n");
  json(path.join(dataRoot, "30_Sources", "chunks", "rag-method.json"), {
    title: "RAG quality source chunk",
    source_uri: "https://example.invalid/rag-method",
    source_status: "verified_chunk",
    chunk_text: "RAG quality separates verified chunks from anchor-only source records.",
    last_verified: "2026-07-11",
  });
  json(path.join(dataRoot, "50_Instances", "candidates", "rag-quality.json"), {
    candidate_id: "rag-quality",
    status: "reviewed",
  });
  json(path.join(dataRoot, "50_Instances", "reviews", "rag-quality.json"), {
    status: "approved",
    candidate_path: "50_Instances/candidates/rag-quality.json",
    accepted_path: "50_Instances/accepted/rag-quality.json",
  });
  json(path.join(dataRoot, "50_Instances", "accepted", "rag-quality.json"), acceptedRecord(query));
  json(path.join(dataRoot, ".dino", "evaluations", "behavior-golden.json"), {
    version: 1,
    cases: [{ id: "poison-fallback", request: "This fallback must never replace the RAG golden.", expected_memory_paths: [] }],
  });
  const golden = {
    version: 2,
    golden_id: "rag-proof-explicit-v2-fixture",
    description: "Explicit immutable RAG proof fixture.",
    cases: [{
      id: "rag-proof-explicit",
      category: "exact",
      language: "en",
      query,
      expected_paths: ["50_Instances/accepted/rag-quality.json"],
      required_terms: ["verified chunks", "hybrid retrieval"],
      required_knowledge_roles: ["behavior_guidance"],
      max_noise_paths: 4,
      require_hybrid: true,
    }],
  };
  json(path.join(dataRoot, RAG_GOLDEN_RELATIVE_PATH), golden);
}

async function main() {
  const goodRoot = mkdtempSync(path.join(tmpdir(), "dinobrain-rag-proof-v2-"));
  const missingRoot = mkdtempSync(path.join(tmpdir(), "dinobrain-rag-proof-missing-"));
  try {
    seedVault(goodRoot);
    const goldenPath = path.join(goodRoot, RAG_GOLDEN_RELATIVE_PATH);
    const before = readFileSync(goldenPath);
    const proof = await buildAndWriteRagProof(goodRoot, { now: new Date("2026-07-11T00:00:00.000Z") });
    const after = readFileSync(goldenPath);

    assert(proof.report.status === "healthy", `proof should be healthy, got ${proof.report.status}`);
    assert(proof.report.rag_golden_source === "explicit_v2", "proof did not require explicit v2 golden data");
    assert(proof.report.rag_golden_version === 2, "proof lost the golden version");
    assert(proof.report.rag_golden_sha256 === sha256(before), "proof reported the wrong golden hash");
    assert(before.equals(after), "rag:proof overwrote or normalized the explicit golden file");
    assert(proof.report.source_behavior_golden_path === null, "behavior-golden fallback leaked into proof evidence");
    assert(proof.report.counts.golden_cases === 1, "explicit golden case count mismatch");
    assert(proof.report.counts.missing_expected_paths === 0, "expected memory was not indexed");
    assert(existsSync(path.join(goodRoot, ".dino", "index", "dense-vectors.json")), "dense vector proof missing");
    assert(existsSync(path.join(goodRoot, RAG_PROOF_STATUS_RELATIVE_PATH)), "RAG proof status missing");

    text(path.join(missingRoot, "20_Wiki", "README.md"), "# Empty fixture\n");
    const missing = await buildAndWriteRagProof(missingRoot, { now: new Date("2026-07-11T00:01:00.000Z") });
    assert(missing.report.status !== "healthy", "missing explicit golden produced a false-green proof");
    assert(missing.report.rag_golden_source === "missing_or_invalid", "missing golden was not reported honestly");
    assert(!existsSync(path.join(missingRoot, RAG_GOLDEN_RELATIVE_PATH)), "proof synthesized a missing golden file");

    console.log("rag proof v2 verification ok");
  } finally {
    rmSync(goodRoot, { recursive: true, force: true });
    rmSync(missingRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  console.error(`cwd=${root}`);
  process.exit(1);
});
