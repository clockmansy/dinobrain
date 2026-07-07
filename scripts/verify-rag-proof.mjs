import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const [{ buildAndWriteRagProof, RAG_GOLDEN_RELATIVE_PATH, RAG_PROOF_STATUS_RELATIVE_PATH }, { buildAndWriteRagEvalReport }] =
  await Promise.all([
    import(pathToFileURL(path.join(root, "dist", "rag-proof.js")).href),
    import(pathToFileURL(path.join(root, "dist", "rag-eval.js")).href),
  ]);

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

async function seedVault(dataRoot) {
  const query = "How should DinoBrain prove RAG quality?";
  text(
    path.join(dataRoot, "20_Wiki", "README.md"),
    `---
title: Wiki
summary: Curated reusable notes.
tags: [wiki]
---

# Wiki
`,
  );
  json(path.join(dataRoot, "30_Sources", "chunks", "rag-method.json"), {
    title: "RAG quality source chunk",
    source_uri: "https://example.invalid/rag-method",
    source_status: "verified_chunk",
    chunk_text: "RAG quality should separate verified chunks from anchor-only source records.",
    last_verified: "2026-07-07",
  });
  json(path.join(dataRoot, "50_Instances", "accepted", "rag-quality.json"), {
    candidate_id: "rag-quality",
    title: "RAG quality proof requires grounded evaluation",
    claim:
      "DinoBrain RAG quality must use verified chunks, retrieval mode honest reporting, memory-on behavior comparison, and source evidence.",
    summary:
      "Use verified chunks, retrieval mode honest reporting, memory-on behavior comparison, and source evidence before claiming RAG quality.",
    tags: ["rag", "retrieval", "evaluation", "provenance"],
    source_paths: ["30_Sources/chunks/rag-method.json"],
    evidence: {
      snippet:
        "Use verified chunks, retrieval mode honest reporting, memory-on behavior comparison, and source evidence.",
    },
    confidence: "high",
    reviewed_by: "verify-rag-proof",
    reviewed_at: "2026-07-07T00:00:00.000Z",
    review_status: "accepted_by_agent_review",
    last_verified: "2026-07-07",
  });
  json(path.join(dataRoot, ".dino", "evaluations", "behavior-golden.json"), {
    version: 1,
    description: "RAG proof fixture behavior golden.",
    target_memory_lift: 10,
    minimum_cases: 1,
    cases: [
      {
        id: "rag-fixture",
        request: query,
        expected_memory_paths: ["50_Instances/accepted/rag-quality.json"],
        required_context_terms: [
          "verified chunks",
          "retrieval mode honest",
          "memory-on behavior",
          "source evidence",
        ],
      },
    ],
  });
  return query;
}

async function main() {
  const dataRoot = mkdtempSync(path.join(tmpdir(), "dinobrain-rag-proof-"));
  try {
    await seedVault(dataRoot);
    const proof = await buildAndWriteRagProof(dataRoot, {
      now: new Date("2026-07-07T00:00:00.000Z"),
      dimensions: 32,
    });
    assert(proof.report.status === "healthy", `proof should be healthy, got ${proof.report.status}`);
    assert(proof.report.counts.golden_cases === 1, "proof did not create one golden case");
    assert(proof.report.counts.record_vectors >= 2, "proof did not vectorize indexed records");
    assert(proof.report.counts.query_vectors === 1, "proof did not vectorize query");
    assert(existsSync(path.join(dataRoot, RAG_GOLDEN_RELATIVE_PATH)), "rag-golden.json missing");
    assert(existsSync(path.join(dataRoot, ".dino", "index", "dense-vectors.json")), "dense-vectors.json missing");
    assert(existsSync(path.join(dataRoot, RAG_PROOF_STATUS_RELATIVE_PATH)), "rag proof status missing");

    const dense = JSON.parse(readFileSync(path.join(dataRoot, ".dino", "index", "dense-vectors.json"), "utf8"));
    assert(dense.provider === "huggingface_transformers_feature_extraction_v1", "semantic vector provider metadata missing");
    assert(dense.model === "Xenova/all-MiniLM-L6-v2", "semantic model metadata missing");
    assert(dense.semantic_embedding_provider === true, "proof did not use a real semantic embedding provider");
    assert(dense.dimensions === 384, "semantic embedding dimensions missing");

    const evalResult = await buildAndWriteRagEvalReport(dataRoot, {
      now: new Date("2026-07-07T00:01:00.000Z"),
    });
    assert(evalResult.report.golden_source === "rag_golden", "eval did not use explicit rag golden");
    assert(evalResult.report.status === "healthy", `eval should be healthy, got ${evalResult.report.status}`);
    assert(evalResult.report.hybrid_ratio === 1, "eval did not prove full hybrid ratio");
    assert(evalResult.report.counts.lexical_fallback === 0, "eval still used lexical fallback");
    assert(evalResult.report.generated_answer_eval?.status === "healthy", "generated answer eval did not pass");
    assert(typeof evalResult.report.generated_answer_eval?.metrics?.faithfulness === "number", "faithfulness metric missing");
    assert(!evalResult.report.warnings.includes("rag_eval_using_fallback_golden"), "fallback golden warning remained");

    console.log("rag proof verification ok");
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  console.error(`cwd=${root}`);
  process.exit(1);
});
