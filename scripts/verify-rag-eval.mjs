import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const [{ buildAndWriteWikiIndex }, { buildAndWriteRagEvalReport, RAG_EVAL_STATUS_RELATIVE_PATH }] = await Promise.all([
  import(pathToFileURL(path.join(root, "dist", "wiki-index.js")).href),
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
    reviewed_by: "verify-rag-eval",
    reviewed_at: "2026-07-07T00:00:00.000Z",
    review_status: "accepted_by_agent_review",
    last_verified: "2026-07-07",
  });
  json(path.join(dataRoot, ".dino", "evaluations", "behavior-golden.json"), {
    version: 1,
    description: "RAG eval fixture converted from behavior golden.",
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
  await buildAndWriteWikiIndex(dataRoot);
  return query;
}

async function main() {
  const dataRoot = mkdtempSync(path.join(tmpdir(), "dinobrain-rag-eval-"));
  try {
    const query = await seedVault(dataRoot);
    let result = await buildAndWriteRagEvalReport(dataRoot, {
      now: new Date("2026-07-07T00:00:00.000Z"),
    });
    assert(existsSync(path.join(dataRoot, RAG_EVAL_STATUS_RELATIVE_PATH)), "RAG eval status was not written");
    assert(result.report.status === "needs_attention", "lexical fallback should not be treated as full RAG health");
    assert(result.report.warnings.includes("rag_hybrid_retrieval_not_proven"), "hybrid warning missing");
    assert(
      result.report.results[0]?.issue_codes.includes("hybrid_retrieval_not_active"),
      "case did not flag inactive hybrid retrieval",
    );

    json(path.join(dataRoot, ".dino", "index", "dense-vectors.json"), {
      version: 1,
      dimensions: 2,
      records: {
        "50_Instances/accepted/rag-quality.json": [1, 0],
      },
      queries: {
        [query]: [1, 0],
      },
    });
    result = await buildAndWriteRagEvalReport(dataRoot, {
      now: new Date("2026-07-07T00:01:00.000Z"),
    });
    assert(result.report.status === "healthy", `dense vector fixture should be healthy, got ${result.report.status}`);
    assert(result.report.hybrid_ratio === 1, "dense vector fixture did not reach full hybrid ratio");
    assert(result.report.average_memory_lift >= 10, "memory-on lift was not proven");
    assert(result.report.results[0]?.retrieval_mode === "hybrid_contextual_v2", "hybrid retrieval mode not reported");

    console.log("rag eval verification ok");
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  console.error(`cwd=${root}`);
  process.exit(1);
});
