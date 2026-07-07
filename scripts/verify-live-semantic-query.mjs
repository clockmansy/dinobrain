import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const [{ buildAndWriteWikiIndex }, { getContextPackItems }, { tryEmbedTextsWithSemanticProvider }] = await Promise.all([
  import(pathToFileURL(path.join(root, "dist", "wiki-index.js")).href),
  import(pathToFileURL(path.join(root, "dist", "retrieval.js")).href),
  import(pathToFileURL(path.join(root, "dist", "semantic-embeddings.js")).href),
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
  const recordPath = "50_Instances/accepted/live-semantic-proof.json";
  const recordText = [
    "DinoBrain completion requires semantic embeddings for live user questions.",
    "The retrieval path must compute dense query vectors on demand.",
    "Precomputed golden query vectors alone are not readiness evidence.",
  ].join(" ");
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
  json(path.join(dataRoot, recordPath), {
    title: "Live semantic query proof",
    summary: recordText,
    tags: ["rag", "retrieval", "semantic", "live-query"],
    source_status: "internal_session_evidence",
    reviewed_by: "verify-live-semantic-query",
    reviewed_at: "2026-07-07T00:00:00.000Z",
    review_status: "accepted_by_agent_review",
  });
  const wiki = await buildAndWriteWikiIndex(dataRoot);
  const semantic = await tryEmbedTextsWithSemanticProvider([recordText]);
  assert(semantic, "semantic provider unavailable for live semantic query verification");
  json(path.join(dataRoot, ".dino", "index", "dense-vectors.json"), {
    version: 1,
    provider: semantic.provider,
    model: semantic.model,
    dimensions: semantic.dimensions,
    semantic_embedding_provider: true,
    generated_at: "2026-07-07T00:00:00.000Z",
    source_index_path: ".dino/index/wiki-index.json",
    records: {
      [recordPath]: semantic.vectors[0],
    },
    queries: {},
  });
  return { recordPath, wiki };
}

async function main() {
  const dataRoot = mkdtempSync(path.join(tmpdir(), "dinobrain-live-semantic-query-"));
  const oldDisabled = process.env.DINOBRAIN_SEMANTIC_EMBEDDINGS;
  try {
    const { recordPath } = await seedVault(dataRoot);
    const liveQuery = "Can this memory system understand a fresh question by embedding the query at runtime?";
    const denseBefore = JSON.parse(readFileSync(path.join(dataRoot, ".dino", "index", "dense-vectors.json"), "utf8"));
    assert(Object.keys(denseBefore.queries ?? {}).length === 0, "fixture unexpectedly started with query vectors");
    const pack = await getContextPackItems(dataRoot, liveQuery, 5);
    assert(pack.stats.retrieval_mode === "hybrid_contextual_v2", "live query did not activate hybrid retrieval");
    assert(pack.ranked.some((record) => record.path === recordPath), "live query did not return the dense-only record");
    assert(
      pack.ranked.some((record) => record.reasons.some((reason) => reason.startsWith("dense_vector_cosine:"))),
      "live query did not report dense vector contribution",
    );
    const denseAfter = JSON.parse(readFileSync(path.join(dataRoot, ".dino", "index", "dense-vectors.json"), "utf8"));
    assert(Object.keys(denseAfter.queries ?? {}).length === 0, "live query should not persist ad-hoc query vectors");

    process.env.DINOBRAIN_SEMANTIC_EMBEDDINGS = "0";
    const fallbackPack = await getContextPackItems(
      dataRoot,
      "A runtime-only question with semantic provider disabled must not count as hybrid readiness.",
      5,
    );
    assert(fallbackPack.stats.retrieval_mode === "lexical_fallback_v2", "semantic-disabled live query should fall back honestly");

    console.log("live semantic query verification ok");
  } finally {
    if (oldDisabled === undefined) delete process.env.DINOBRAIN_SEMANTIC_EMBEDDINGS;
    else process.env.DINOBRAIN_SEMANTIC_EMBEDDINGS = oldDisabled;
    rmSync(dataRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  console.error(`cwd=${root}`);
  process.exit(1);
});
