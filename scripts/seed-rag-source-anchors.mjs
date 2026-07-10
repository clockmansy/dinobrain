import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { appendFileWithLockSync, atomicWriteJsonSync, atomicWriteTextSync } from "./lib/atomic-files-sync.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(scriptDir, "..");
const dataRoot = path.resolve(process.env.DINOBRAIN_DATA_DIR || path.join(appRoot, "..", "dinobrain-data"));
const shouldWrite = process.argv.includes("--write");
const generatedAt = new Date().toISOString();
const recordedDate = "2026-07-07";
const catalogPath = "20_Wiki/RAG-Methodology-Anchor-Catalog.md";

const anchors = [
  {
    id: "rag-survey",
    title: "RAG-Survey",
    uri: "https://github.com/Tongji-KGLLM/RAG-Survey",
    type: "external_doc",
    category: "survey",
    note: "User-provided external RAG methodology anchor for broad RAG survey coverage.",
  },
  {
    id: "anthropic-contextual-retrieval",
    title: "Anthropic Contextual Retrieval",
    uri: "https://www.anthropic.com/engineering/contextual-retrieval",
    type: "external_doc",
    category: "contextual-retrieval",
    note: "User-provided anchor for contextual chunk enrichment and retrieval quality methodology.",
  },
  {
    id: "pinecone-rag",
    title: "Pinecone RAG explanation",
    uri: "https://www.pinecone.io/learn/retrieval-augmented-generation/",
    type: "external_doc",
    category: "rag-overview",
    note: "User-provided anchor for vector database RAG concepts.",
  },
  {
    id: "elastic-rag",
    title: "Elastic RAG explanation",
    uri: "https://www.elastic.co/what-is/retrieval-augmented-generation",
    type: "external_doc",
    category: "rag-overview",
    note: "User-provided anchor for search-backed RAG concepts.",
  },
  {
    id: "azure-search-rag-overview",
    title: "Microsoft Azure AI Search RAG overview",
    uri: "https://learn.microsoft.com/en-us/azure/search/retrieval-augmented-generation-overview",
    type: "external_doc",
    category: "rag-overview",
    note: "User-provided anchor for Azure Search RAG architecture.",
  },
  {
    id: "aws-bedrock-knowledge-base",
    title: "AWS Bedrock Knowledge Base",
    uri: "https://docs.aws.amazon.com/bedrock/latest/userguide/knowledge-base.html",
    type: "external_doc",
    category: "knowledge-base",
    note: "User-provided anchor for managed RAG knowledge-base workflow.",
  },
  {
    id: "google-rag-engine-overview",
    title: "Google RAG Engine overview",
    uri: "https://docs.cloud.google.com/gemini-enterprise-agent-platform/build/rag-engine/rag-overview",
    type: "external_doc",
    category: "rag-engine",
    note: "User-provided anchor for Google RAG engine concepts.",
  },
  {
    id: "openai-retrieval-guide",
    title: "OpenAI Retrieval guide",
    uri: "https://developers.openai.com/api/docs/guides/retrieval",
    type: "external_doc",
    category: "retrieval",
    note: "User-provided anchor for OpenAI retrieval guidance.",
  },
  {
    id: "openai-embeddings-qa-cookbook",
    title: "OpenAI embeddings QA cookbook",
    uri: "https://developers.openai.com/cookbook/examples/question_answering_using_embeddings",
    type: "external_doc",
    category: "embeddings",
    note: "User-provided anchor for embeddings-based question answering examples.",
  },
  {
    id: "langchain-rag",
    title: "LangChain RAG",
    uri: "https://docs.langchain.com/oss/python/langchain/rag",
    type: "external_doc",
    category: "framework-rag",
    note: "User-provided anchor for framework-level RAG construction.",
  },
  {
    id: "llamaindex-rag",
    title: "LlamaIndex RAG",
    uri: "https://developers.llamaindex.ai/python/framework/understanding/rag/",
    type: "external_doc",
    category: "framework-rag",
    note: "User-provided anchor for data framework RAG concepts.",
  },
  {
    id: "haystack-first-rag-pipeline",
    title: "Haystack first RAG pipeline",
    uri: "https://haystack.deepset.ai/tutorials/27_first_rag_pipeline",
    type: "external_doc",
    category: "framework-rag",
    note: "User-provided anchor for a Haystack RAG pipeline tutorial.",
  },
  {
    id: "haystack-rag-from-scratch",
    title: "Haystack RAG from scratch",
    uri: "https://haystack.deepset.ai/blog/rag-pipelines-from-scratch",
    type: "external_doc",
    category: "framework-rag",
    note: "User-provided anchor for RAG pipeline implementation concepts.",
  },
  {
    id: "microsoft-graphrag",
    title: "Microsoft GraphRAG",
    uri: "https://microsoft.github.io/graphrag/",
    type: "external_doc",
    category: "graph-rag",
    note: "User-provided anchor for graph-based retrieval and synthesis.",
  },
  {
    id: "ragas-evaluation",
    title: "RAGAS evaluation",
    uri: "https://docs.ragas.io/en/stable/",
    type: "external_doc",
    category: "evaluation",
    note: "User-provided anchor for RAG evaluation metrics and workflows.",
  },
  {
    id: "langsmith-evaluation-concepts",
    title: "LangSmith evaluation concepts",
    uri: "https://docs.langchain.com/langsmith/evaluation-concepts",
    type: "external_doc",
    category: "evaluation",
    note: "User-provided anchor for LLM application evaluation concepts.",
  },
  {
    id: "rag-paper-2005-11401",
    title: "RAG paper anchor arXiv 2005.11401",
    uri: "https://arxiv.org/abs/2005.11401",
    type: "paper",
    category: "paper",
    note: "User-provided paper anchor for foundational RAG literature.",
  },
  {
    id: "rag-paper-2303-11366",
    title: "RAG paper anchor arXiv 2303.11366",
    uri: "https://arxiv.org/abs/2303.11366",
    type: "paper",
    category: "paper",
    note: "User-provided paper anchor for retrieval/generation methodology.",
  },
  {
    id: "rag-paper-2401-18059",
    title: "RAG paper anchor arXiv 2401.18059",
    uri: "https://arxiv.org/abs/2401.18059",
    type: "paper",
    category: "paper",
    note: "User-provided paper anchor for advanced RAG methodology.",
  },
  {
    id: "rag-paper-2212-10496",
    title: "RAG paper anchor arXiv 2212.10496",
    uri: "https://arxiv.org/abs/2212.10496",
    type: "paper",
    category: "paper",
    note: "User-provided paper anchor for retrieval or evaluation methodology.",
  },
];

const topicBacklog = [
  "Pinecone chunking strategies",
  "Jina late chunking",
  "Weaviate hybrid search",
  "Milvus hybrid search",
  "Qdrant hybrid search and reranking",
  "Cohere rerank",
  "Voyage reranker",
  "Pinecone rerank",
  "Weaviate rerank",
  "LlamaIndex BM25 retriever",
  "Haystack retrievers",
  "OpenAI embeddings",
  "SBERT STS",
  "HuggingFace MTEB",
  "RAGAS metrics",
  "Research-backed Learning Loop Health for Cognitive Continuity OS",
  "Research-backed Cognitive Continuity OS Growth Criteria",
  "OS memory growth diagnosis and improvement plan",
  "LLM Wiki",
  "Karpathy LLM Wiki reference summary",
  "learning-loop-health.md",
  "llm-wiki-visual-layer-spec.md",
  "source lineage and source chunk mapping design",
  "rag-quality report",
  "rag_canaries.json",
  "RTD retrieval canary records",
];

function dataPath(...segments) {
  return path.join(dataRoot, ...segments);
}

function ensureDir(relativeDir) {
  mkdirSync(dataPath(relativeDir), { recursive: true });
}

function readJsonSafe(relativePath) {
  const fullPath = dataPath(relativePath);
  if (!existsSync(fullPath)) return null;
  try {
    return JSON.parse(readFileSync(fullPath, "utf8"));
  } catch {
    return null;
  }
}

function writeJson(relativePath, value) {
  atomicWriteJsonSync(dataPath(relativePath), value);
}

function appendJsonl(relativePath, value) {
  const fullPath = dataPath(relativePath);
  appendFileWithLockSync(fullPath, `${JSON.stringify(value)}\n`);
}

function writeText(relativePath, value) {
  atomicWriteTextSync(dataPath(relativePath), value);
}

function sourceChunkPath(anchor) {
  return `30_Sources/chunks/${anchor.id}.json`;
}

function provenancePath(anchor) {
  return `.dino/provenance/${anchor.id}.json`;
}

function chunkText(anchor) {
  return [
    "Anchor-only RAG methodology source candidate.",
    `Recorded from user-provided cross-OS RAG learning notes on ${recordedDate}.`,
    `Title: ${anchor.title}.`,
    `URL: ${anchor.uri}.`,
    `Category: ${anchor.category}.`,
    `Note: ${anchor.note}`,
    "Verification status: URL/content not fetched in this seed step; do not treat this anchor as a verified claim.",
    "Promotion rule: fetch the source, create bounded source chunks, connect specific claims, and pass review before using as source truth.",
  ].join(" ");
}

function buildSourceRecord(anchor, previous) {
  const text = chunkText(anchor);
  const createdAt = previous?.created_at || generatedAt;
  return {
    source_chunk_id: anchor.id,
    type: "source_chunk",
    status: "active",
    title: anchor.title,
    source_uri: anchor.uri,
    chunk_type: anchor.type,
    chunk_text: text,
    chunk_text_redactions: [],
    chunk_text_truncated: false,
    chunk_text_original_length: text.length,
    chunk_text_stored_length: text.length,
    claim_paths: [catalogPath],
    tags: ["rag", "source-anchor", "anchor-only", anchor.category],
    verification_status: "anchor_only_unverified",
    last_verified: recordedDate,
    created_at: createdAt,
    updated_at: generatedAt,
  };
}

function buildProvenanceRecord(anchor, previous) {
  const createdAt = previous?.created_at || generatedAt;
  return {
    provenance_id: anchor.id,
    source_chunk_path: sourceChunkPath(anchor),
    claim_paths: [catalogPath],
    source_uri: anchor.uri,
    verification_status: "anchor_only_unverified",
    created_at: createdAt,
    updated_at: generatedAt,
  };
}

function buildCatalog() {
  const byCategory = new Map();
  for (const anchor of anchors) {
    if (!byCategory.has(anchor.category)) byCategory.set(anchor.category, []);
    byCategory.get(anchor.category).push(anchor);
  }
  const lines = [
    "---",
    "title: RAG Methodology Anchor Catalog",
    "summary: Anchor-only registry of user-provided RAG methodology sources for later verified source chunking.",
    "source_status: mixed",
    "confidence: low",
    `last_verified: ${recordedDate}`,
    "tags: [rag, llm-wiki, source-lineage, retrieval-quality, anchor-only]",
    "---",
    "",
    "# RAG Methodology Anchor Catalog",
    "",
    "Status: anchor-only, unverified content.",
    `Recorded at: ${generatedAt}`,
    "",
    "This catalog preserves RAG methodology URLs and internal topic names supplied by the user from another public OS learning pass. It is not a claim that the linked pages have been read, summarized, or verified by DinoBrain. Each URL anchor is stored as a source chunk with `verification_status: anchor_only_unverified` and a provenance link back to this catalog.",
    "",
    "Use these anchors as the next source-truth backlog for the LLM Wiki: fetch a source, create bounded chunks, link concrete claims, review them, then allow the reviewed claims into Context Packs.",
    "",
    "## URL Anchors",
    "",
  ];
  for (const [category, categoryAnchors] of Array.from(byCategory.entries()).sort(([a], [b]) => a.localeCompare(b))) {
    lines.push(`### ${category}`, "");
    for (const anchor of categoryAnchors) {
      lines.push(`- [${anchor.title}](${anchor.uri}) -> \`${sourceChunkPath(anchor)}\``);
    }
    lines.push("");
  }
  lines.push(
    "## Topic Backlog Without Exact URLs In This Thread",
    "",
    "The user also named these RAG components or internal OS records, but did not provide exact URLs or file exports for all of them in this thread. They should stay as a follow-up backlog rather than invented source anchors.",
    "",
  );
  for (const topic of topicBacklog) lines.push(`- ${topic}`);
  lines.push(
    "",
    "## Guardrails",
    "",
    "- URL anchors are provenance candidates, not verified source truth.",
    "- Do not use these anchors as factual support until source chunks are fetched and reviewed.",
    "- Do not store raw full pages or copyrighted full-text dumps.",
    "- Keep claim lineage at source/chunk/claim granularity.",
    "- Use retrieval canaries and behavior evaluation to prove these sources improve future answers.",
    "",
  );
  return `${lines.join("\n")}\n`;
}

function removeStaleIndexes() {
  const stalePaths = [
    ".dino/index/wiki-index.json",
    ".dino/index/sqlite/wiki.sqlite",
    ".dino/index/sqlite/wiki.sqlite-shm",
    ".dino/index/sqlite/wiki.sqlite-wal",
  ];
  for (const relativePath of stalePaths) {
    const fullPath = dataPath(relativePath);
    if (existsSync(fullPath)) rmSync(fullPath, { force: true });
  }
}

function main() {
  if (!existsSync(dataRoot)) throw new Error(`DinoBrain data root not found: ${dataRoot}`);
  const planned = {
    data_root: dataRoot,
    catalog_path: catalogPath,
    anchor_count: anchors.length,
    topic_backlog_count: topicBacklog.length,
    anchors: anchors.map((anchor) => ({
      id: anchor.id,
      title: anchor.title,
      source_uri: anchor.uri,
      source_chunk_path: sourceChunkPath(anchor),
      provenance_path: provenancePath(anchor),
      verification_status: "anchor_only_unverified",
    })),
  };

  if (!shouldWrite) {
    process.stdout.write(`${JSON.stringify({ ok: true, write: false, ...planned }, null, 2)}\n`);
    return;
  }

  ensureDir("20_Wiki");
  ensureDir("30_Sources/chunks");
  ensureDir(".dino/provenance");
  ensureDir(".dino/events");

  writeText(catalogPath, buildCatalog());
  for (const anchor of anchors) {
    writeJson(sourceChunkPath(anchor), buildSourceRecord(anchor, readJsonSafe(sourceChunkPath(anchor))));
    writeJson(provenancePath(anchor), buildProvenanceRecord(anchor, readJsonSafe(provenancePath(anchor))));
  }
  removeStaleIndexes();
  appendJsonl(`.dino/events/${recordedDate}.jsonl`, {
    event: "rag_source_anchors_seeded",
    at: generatedAt,
    catalog_path: catalogPath,
    anchor_count: anchors.length,
    topic_backlog_count: topicBacklog.length,
    verification_status: "anchor_only_unverified",
  });

  process.stdout.write(`${JSON.stringify({ ok: true, write: true, ...planned }, null, 2)}\n`);
}

main();
