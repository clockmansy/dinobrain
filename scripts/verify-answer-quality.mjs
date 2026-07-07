import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const [{ buildAndWriteRagProof }, { buildAndWriteAnswerQualityReport }] = await Promise.all([
  import(pathToFileURL(path.join(root, "dist", "rag-proof.js")).href),
  import(pathToFileURL(path.join(root, "dist", "answer-quality.js")).href),
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

function seedVault(dataRoot, expectedPath = "50_Instances/accepted/answer-rule.json") {
  text(
    path.join(dataRoot, "20_Wiki", "README.md"),
    `---
title: Wiki
summary: Curated notes.
tags: [wiki]
---

# Wiki
`,
  );
  json(path.join(dataRoot, "30_Sources", "chunks", "answer-quality-source.json"), {
    title: "Answer quality source",
    source_uri: "https://example.invalid/answer-quality",
    source_status: "verified_chunk",
    chunk_text: "Generated answers should cite reviewed memory and avoid unsupported private claims.",
    last_verified: "2026-07-07",
  });
  json(path.join(dataRoot, "50_Instances", "accepted", "answer-rule.json"), {
    title: "Answer quality rule",
    summary:
      "When answering with memory, include reviewed memory, cite evidence paths, avoid unsupported private claims, and compare memory-on behavior against memory-off.",
    tags: ["answer-quality", "behavior", "memory"],
    source_paths: ["30_Sources/chunks/answer-quality-source.json"],
    evidence: {
      snippet:
        "include reviewed memory, cite evidence paths, avoid unsupported private claims, and compare memory-on behavior against memory-off",
    },
    reviewed_by: "verify-answer-quality",
    reviewed_at: "2026-07-07T00:00:00.000Z",
    review_status: "accepted_by_agent_review",
  });
  json(path.join(dataRoot, ".dino", "evaluations", "behavior-golden.json"), {
    version: 1,
    description: "Answer quality fixture.",
    target_memory_lift: 30,
    minimum_cases: 1,
    cases: [
      {
        id: "answer-quality-fixture",
        request: "How should DinoBrain answer quality be judged?",
        expected_memory_paths: [expectedPath],
        required_context_terms: [
          "reviewed memory",
          "cite evidence paths",
          "avoid unsupported private claims",
          "memory-off",
        ],
      },
    ],
  });
}

async function main() {
  const goodRoot = mkdtempSync(path.join(tmpdir(), "dinobrain-answer-quality-good-"));
  const badRoot = mkdtempSync(path.join(tmpdir(), "dinobrain-answer-quality-bad-"));
  try {
    seedVault(goodRoot);
    await buildAndWriteRagProof(goodRoot, { now: new Date("2026-07-07T00:00:00.000Z") });
    const good = await buildAndWriteAnswerQualityReport(goodRoot, { now: new Date("2026-07-07T00:01:00.000Z") });
    assert(good.report.status === "healthy", `good fixture should be healthy, got ${good.report.status}`);
    assert(good.report.counts.cases === 1, "good fixture case count missing");
    assert(good.report.counts.hybrid === 1, "good fixture did not use hybrid retrieval");
    assert(good.report.metrics.average_memory_lift >= 30, "memory-on answer did not beat memory-off enough");
    assert(good.report.metrics.faithfulness >= 0.8, "faithfulness metric too low");
    assert(good.report.metrics.source_support >= 0.8, "source support metric too low");
    assert(good.report.results[0]?.memory_on_answer.includes("Citations:"), "memory-on generated answer did not cite paths");

    seedVault(badRoot, "50_Instances/accepted/missing-answer-rule.json");
    await buildAndWriteRagProof(badRoot, { now: new Date("2026-07-07T00:00:00.000Z") });
    const bad = await buildAndWriteAnswerQualityReport(badRoot, { now: new Date("2026-07-07T00:01:00.000Z") });
    assert(bad.report.status === "needs_attention", "bad fixture should fail when expected memory is missing");
    assert(
      bad.report.results[0]?.issue_codes.includes("source_support_below_target"),
      "bad fixture did not flag missing source support",
    );

    console.log("answer quality verification ok");
  } finally {
    rmSync(goodRoot, { recursive: true, force: true });
    rmSync(badRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  console.error(`cwd=${root}`);
  process.exit(1);
});
