import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const [{ collectCuratedRecords }, hybrid, semanticModule] = await Promise.all([
  import(pathToFileURL(path.join(root, "dist", "context.js")).href),
  import(pathToFileURL(path.join(root, "dist", "hybrid-retrieval.js")).href),
  import(pathToFileURL(path.join(root, "dist", "semantic-embeddings.js")).href),
]);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function text(filePath, value) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, value, "utf8");
}

function markdown(title, summary, aliases, body) {
  return `---
title: ${title}
summary: ${summary}
aliases: [${aliases.join(", ")}]
tags: [rag, policy]
verification_status: verified
lifecycle_state: active
---

# ${title}

${body}
`;
}

function assertBreakdown(record) {
  const required = [
    "exact_alias",
    "sparse_field",
    "bm25",
    "dense_cosine",
    "dense_lexical_fallback",
    "rrf",
    "rerank",
    "provenance",
    "lifecycle",
    "type_budget",
    "recency",
    "noise",
    "final",
  ];
  for (const key of required) assert(Number.isFinite(record.score_breakdown?.[key]), `score breakdown missing ${key}`);
}

async function main() {
  const dataRoot = mkdtempSync(path.join(tmpdir(), "dinobrain-contextual-rag-"));
  try {
    text(
      path.join(dataRoot, "20_Wiki", "paid-leave.md"),
      markdown(
        "Paid leave handbook",
        "Employees request compensated vacation through the people portal and manager approval workflow.",
        ["PTO-OMEGA"],
        "The handbook defines annual paid time away, approval timing, and the escalation path for a delayed request.",
      ),
    );
    text(
      path.join(dataRoot, "20_Wiki", "build-policy.md"),
      markdown(
        "Build release policy",
        "Release candidates require reproducible builds and signed artifacts.",
        ["BUILD-SIGMA"],
        "The release lane validates checksums, build provenance, and deployment approval.",
      ),
    );
    text(
      path.join(dataRoot, "30_Sources", "chunks", "leave-ko.md"),
      markdown(
        "휴가 신청 근거",
        "직원은 유급 휴가를 인사 포털에서 신청하고 관리자 승인을 받습니다.",
        ["휴가규정-세종"],
        "한국어 근거 청크는 휴가 일수, 승인 절차, 지연 시 에스컬레이션을 설명합니다.",
      ),
    );
    text(
      path.join(dataRoot, "30_Sources", "private", "chatgpt", "conversation.md"),
      markdown("Private conversation archive", "Local-only raw conversation source.", [], "This must never enter normal retrieval."),
    );
    text(
      path.join(dataRoot, "30_Sources", "fetched", "source-snapshot.json"),
      JSON.stringify({ type: "source_snapshot", source_uri: "https://example.com", verification_status: "verified_chunk" }),
    );
    text(
      path.join(dataRoot, "40_Projects", "retrieval.md"),
      markdown(
        "Contextual retrieval project",
        "Hybrid retrieval combines sparse matching with independent semantic candidates.",
        ["RAG-PROJECT"],
        "Each result exposes channel contributions and durable row metadata.",
      ),
    );
    text(
      path.join(dataRoot, "70_Error_Book", "retrieval-noise.md"),
      markdown(
        "Retrieval noise correction",
        "Do not let operational logs overwhelm durable knowledge lanes.",
        ["NOISE-GUARD"],
        "Apply bounded lane budgets and penalize placeholder records.",
      ),
    );

    const records = await collectCuratedRecords(dataRoot);
    assert(records.length === 5, `expected five contextual records, got ${records.length}`);
    assert(!records.some((record) => record.path.startsWith("30_Sources/private/")), "private source entered default retrieval");
    assert(!records.some((record) => record.path.startsWith("30_Sources/fetched/")), "source snapshot entered default retrieval");
    for (const record of records) {
      assert(record.contextual_chunk.length > 0 && record.contextual_chunk.length <= 1600, "bounded chunk missing");
      assert(/^[a-f0-9]{64}$/.test(record.source_sha256), "source hash missing");
      assert(record.language && record.lifecycle_state && record.verification_status, "row metadata missing");
      assert(record.knowledge_role, "knowledge role missing");
    }
    assert(records.find((record) => record.path === "30_Sources/chunks/leave-ko.md")?.knowledge_role === "source_citation", "verified source role missing");
    assert(records.find((record) => record.path === "20_Wiki/paid-leave.md")?.knowledge_role === "verified_claim_support", "verified claim-support role missing");
    assert(records.find((record) => record.path === "40_Projects/retrieval.md")?.knowledge_role === "project_context", "project context role missing");

    const paraphrase = "Where can a worker arrange compensated time away and obtain approval?";
    const bilingual = "유급 휴가 approval workflow는 어디에서 처리하나요?";
    const aliasQuery = "PTO-OMEGA";
    const texts = records.map((record) => hybrid.contextualText(record));
    const semantic = await semanticModule.tryEmbedTextsWithSemanticProvider([...texts, paraphrase, bilingual, aliasQuery]);
    assert(semantic?.semantic_embedding_provider === true, "real semantic provider unavailable");
    const recordVectors = Object.fromEntries(records.map((record, index) => [record.path, semantic.vectors[index]]));
    const queryOffset = records.length;
    const denseIndex = {
      version: 2,
      provider: semantic.provider,
      model: semantic.model,
      dimensions: semantic.dimensions,
      semantic_embedding_provider: true,
      records: recordVectors,
      queries: {
        [hybrid.normalizeVectorKey(paraphrase)]: semantic.vectors[queryOffset],
        [hybrid.normalizeVectorKey(bilingual)]: semantic.vectors[queryOffset + 1],
        [hybrid.normalizeVectorKey(aliasQuery)]: semantic.vectors[queryOffset + 2],
      },
    };

    for (const [query, expectedPath] of [
      [paraphrase, "20_Wiki/paid-leave.md"],
      [bilingual, "30_Sources/chunks/leave-ko.md"],
    ]) {
      const ranked = hybrid.rankRecordsHybridV2(records, query, { limit: 5, denseVectorIndex: denseIndex, denseTopK: 3 });
      assert(hybrid.retrievalModeFor(records, query, denseIndex) === "hybrid_contextual_v2", `${query} was not hybrid`);
      const expected = ranked.find((record) => record.path === expectedPath);
      assert(expected, `${query} did not retrieve ${expectedPath}`);
      assert(expected.score_breakdown?.dense_cosine > 0, `${query} did not use real dense retrieval`);
      assertBreakdown(expected);
    }

    const aliasRanked = hybrid.rankRecordsHybridV2(records, aliasQuery, { limit: 5, denseVectorIndex: denseIndex, denseTopK: 3 });
    assert(aliasRanked[0]?.path === "20_Wiki/paid-leave.md", "rare exact alias was not stable at rank 1");
    assert(aliasRanked[0]?.score_breakdown?.exact_alias >= 42, "exact alias contribution missing");

    const rareBodyRanked = hybrid.rankRecordsHybridV2(records, "checksums", { limit: 5, denseVectorIndex: null });
    assert(rareBodyRanked[0]?.path === "20_Wiki/build-policy.md", "rare exact body token was filtered out");
    assert(rareBodyRanked[0]?.score_breakdown?.exact_alias >= 12, "rare exact body evidence is missing");

    const denseTop = hybrid.denseVectorCandidates(
      { version: 2, dimensions: 2, semantic_embedding_provider: true, provider: "test", records: { a: [1, 0], b: [0.9, 0.1], c: [0, 1] }, queries: { q: [1, 0] } },
      "q",
      2,
    );
    assert(denseTop.map((item) => item.path).join(",") === "a,b", "dense candidates were not independent cosine top-K");

    const fallback = hybrid.rankRecordsHybridV2(records, aliasQuery, { limit: 3, denseVectorIndex: null });
    assert(hybrid.retrievalModeFor(records, aliasQuery, null) === "lexical_fallback_v2", "fallback mode was not honest");
    assert(fallback[0]?.score_breakdown?.dense_cosine === 0, "fallback reported semantic dense contribution");
    assert(fallback.some((record) => (record.score_breakdown?.dense_lexical_fallback ?? 0) > 0), "fallback contribution missing");

    const base = records[0];
    const laneFixture = [
      ...Array.from({ length: 5 }, (_, index) => ({ ...base, path: `60_Operations/log-${index}.md`, retrieval_lane: "operations", score: 100 - index })),
      { ...records[0], score: 80 },
      { ...records[2], score: 79 },
      { ...records[3], score: 78 },
      { ...records[4], score: 77 },
    ];
    const budgeted = hybrid.takeWithContextPackBudgets(laneFixture, 6, "general lookup");
    assert(budgeted.filter((record) => record.retrieval_lane === "operations").length <= 1, "operations swamped lane budget");
    assert(new Set(budgeted.map((record) => record.retrieval_lane)).size >= 4, "lane budget did not preserve durable lane diversity");
    const behaviorFixture = [
      ...Array.from({ length: 4 }, (_, index) => ({ ...base, path: `50_Instances/accepted/rule-${index}.json`, retrieval_lane: "accepted_behavior", score: 100 - index })),
      ...Array.from({ length: 5 }, (_, index) => ({ ...records[2], path: `30_Sources/chunks/source-${index}.md`, retrieval_lane: "source", score: 90 - index })),
      { ...records[3], score: 70 },
      { ...records[4], score: 69 },
    ];
    const behaviorBudgeted = hybrid.takeWithContextPackBudgets(behaviorFixture, 8, "configured hook live proof verification");
    assert(
      behaviorBudgeted.filter((record) => record.retrieval_lane !== "accepted_behavior").length <= 2,
      "supplemental lanes exceeded the behavior-context noise budget",
    );
    const operationsBudgeted = hybrid.takeWithContextPackBudgets(laneFixture, 6, "maintenance operations policies");
    assert(
      operationsBudgeted.filter((record) => record.retrieval_lane === "operations").length === 4,
      "explicit operations intent did not retain the bounded four-record lane",
    );
    const explicitIntentFixture = [
      ...Array.from({ length: 5 }, (_, index) => ({ ...records[0], path: `20_Wiki/wiki-${index}.md`, retrieval_lane: "wiki", score: 100 - index })),
      ...Array.from({ length: 4 }, (_, index) => ({ ...base, path: `50_Instances/accepted/supplement-${index}.json`, retrieval_lane: "accepted_behavior", score: 95 - index })),
      ...Array.from({ length: 3 }, (_, index) => ({ ...records[2], path: `30_Sources/chunks/supplement-${index}.md`, retrieval_lane: "source", score: 85 - index })),
    ];
    const wikiBudgeted = hybrid.takeWithContextPackBudgets(explicitIntentFixture, 7, "durable knowledge notes");
    assert(
      wikiBudgeted.filter((record) => record.retrieval_lane !== "wiki" && record.retrieval_lane !== "recent_task").length <= 2,
      "explicit Wiki intent admitted more than two supplemental records",
    );
    const projectBudgeted = hybrid.takeWithContextPackBudgets(
      explicitIntentFixture.map((record, index) => index < 5 ? { ...record, path: `40_Projects/project-${index}.md`, retrieval_lane: "project" } : record),
      7,
      "project state decisions handoffs",
    );
    assert(
      projectBudgeted.filter((record) => record.retrieval_lane !== "project" && record.retrieval_lane !== "recent_task").length <= 2,
      "explicit Project intent admitted more than two supplemental records",
    );

    console.log("contextual hybrid retrieval verification ok");
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
