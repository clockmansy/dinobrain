import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import { DENSE_VECTOR_INDEX_RELATIVE_PATH } from "./hybrid-retrieval.js";
import {
  HUGGINGFACE_TRANSFORMERS_PROVIDER,
  LOCAL_TEXT_HASHING_PROVIDER,
  tryEmbedTextsWithSemanticProvider,
} from "./semantic-embeddings.js";
import type { WikiIndex } from "./wiki-index.js";
import { buildAndWriteWikiIndex, WIKI_INDEX_RELATIVE_PATH } from "./wiki-index.js";

export const RAG_GOLDEN_RELATIVE_PATH = ".dino/evaluations/rag-golden.json";
export const RAG_PROOF_STATUS_RELATIVE_PATH = ".dino/state/rag_proof_status.json";
export const RAG_PROOF_VERSION = "rag_proof_v1";

type BehaviorGolden = {
  version: number;
  description?: string;
  target_memory_lift?: number;
  minimum_cases?: number;
  cases: Array<{
    id: string;
    request: string;
    expected_memory_paths: string[];
    required_context_terms?: string[];
    expected_behavior_terms?: string[];
    forbidden_context_terms?: string[];
  }>;
};

type RagGolden = {
  version: number;
  description: string;
  pack_limit: number;
  target_recall: number;
  target_required_term_recall: number;
  target_memory_lift: number;
  min_hybrid_ratio: number;
  minimum_cases: number;
  cases: Array<{
    id: string;
    query: string;
    expected_paths: string[];
    required_terms: string[];
    forbidden_terms: string[];
    allowed_prefixes: string[];
    require_hybrid: boolean;
  }>;
};

export type RagProofReport = {
  version: typeof RAG_PROOF_VERSION;
  status: "healthy" | "needs_attention" | "degraded";
  generated_at: string;
  data_root: string;
  rag_golden_path: string;
  dense_vector_path: string;
  source_behavior_golden_path: string | null;
  counts: {
    golden_cases: number;
    record_vectors: number;
    query_vectors: number;
    missing_expected_paths: number;
  };
  dense_vector: {
    provider: typeof HUGGINGFACE_TRANSFORMERS_PROVIDER | typeof LOCAL_TEXT_HASHING_PROVIDER;
    model: string | null;
    dimensions: number;
    semantic_embedding_provider: boolean;
    cache_dir?: string | null;
  };
  warnings: string[];
  visible_status: string;
};

type BuildOptions = {
  now?: Date;
  dimensions?: number;
};

function dataPath(dataRoot: string, relativePath: string): string {
  return path.resolve(dataRoot, ...relativePath.split("/"));
}

async function readJsonIfExists<T>(filePath: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function tokenize(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^\p{L}\p{N}_-]+/u)
    .map((term) => term.trim())
    .filter((term) => term.length > 1);
}

function charGrams(value: string, size = 4): string[] {
  const normalized = value.toLowerCase().replace(/\s+/g, " ").trim();
  const grams: string[] = [];
  for (let index = 0; index <= normalized.length - size; index += 1) {
    grams.push(normalized.slice(index, index + size));
  }
  return grams;
}

function hashFeature(feature: string): bigint {
  return createHash("sha256").update(feature).digest().readBigUInt64BE(0);
}

function addFeature(vector: number[], feature: string, weight: number): void {
  const hash = hashFeature(feature);
  const index = Number(hash % BigInt(vector.length));
  const sign = (hash >> 8n) % 2n === 0n ? 1 : -1;
  vector[index] += sign * weight;
}

function embedText(value: string, dimensions: number): number[] {
  const vector = Array.from({ length: dimensions }, () => 0);
  for (const term of tokenize(value)) addFeature(vector, `tok:${term}`, 1.2);
  for (const gram of charGrams(value)) addFeature(vector, `gram:${gram}`, 0.35);
  const norm = Math.sqrt(vector.reduce((sum, item) => sum + item * item, 0));
  if (norm === 0) return vector;
  return vector.map((item) => Number((item / norm).toFixed(6)));
}

function recordText(record: WikiIndex["records"][number]): string {
  return [record.path, record.title, record.summary, record.tags.join(" "), record.excerpt].join("\n");
}

function convertBehaviorGolden(behavior: BehaviorGolden): RagGolden {
  return {
    version: 1,
    description: `Explicit RAG golden generated from reviewed behavior golden cases. ${behavior.description ?? ""}`.trim(),
    pack_limit: 8,
    target_recall: 0.8,
    target_required_term_recall: 0.8,
    target_memory_lift: behavior.target_memory_lift ?? 35,
    min_hybrid_ratio: 1,
    minimum_cases: behavior.minimum_cases ?? 1,
    cases: behavior.cases.map((item) => ({
      id: item.id,
      query: item.request,
      expected_paths: item.expected_memory_paths,
      required_terms: Array.from(
        new Set([...(item.required_context_terms ?? []), ...(item.expected_behavior_terms ?? [])].filter(Boolean)),
      ),
      forbidden_terms: item.forbidden_context_terms ?? [],
      allowed_prefixes: ["50_Instances/accepted/"],
      require_hybrid: true,
    })),
  };
}

export function getRagGoldenPath(dataRoot: string): string {
  return dataPath(dataRoot, RAG_GOLDEN_RELATIVE_PATH);
}

export function getDenseVectorPath(dataRoot: string): string {
  return dataPath(dataRoot, DENSE_VECTOR_INDEX_RELATIVE_PATH);
}

export function getRagProofStatusPath(dataRoot: string): string {
  return dataPath(dataRoot, RAG_PROOF_STATUS_RELATIVE_PATH);
}

export async function buildAndWriteRagProof(
  dataRoot: string,
  options: BuildOptions = {},
): Promise<{ report: RagProofReport; statusPath: string }> {
  const generatedAt = (options.now ?? new Date()).toISOString();
  const dimensions = options.dimensions ?? 128;
  const behaviorPath = dataPath(dataRoot, ".dino/evaluations/behavior-golden.json");
  const behavior = await readJsonIfExists<BehaviorGolden>(behaviorPath);
  const ragGolden = behavior ? convertBehaviorGolden(behavior) : null;
  const wiki = await buildAndWriteWikiIndex(dataRoot);

  const ragGoldenPath = getRagGoldenPath(dataRoot);
  const denseVectorPath = getDenseVectorPath(dataRoot);
  const statusPath = getRagProofStatusPath(dataRoot);
  const records: Record<string, number[]> = {};
  const queries: Record<string, number[]> = {};

  for (const record of wiki.records) {
    records[record.path] = [];
  }
  for (const item of ragGolden?.cases ?? []) {
    queries[item.query.toLowerCase().replace(/\s+/g, " ").trim()] = [];
  }

  const recordEntries = wiki.records.map((record) => ({ path: record.path, text: recordText(record) }));
  const queryEntries = (ragGolden?.cases ?? []).map((item) => ({
    key: item.query.toLowerCase().replace(/\s+/g, " ").trim(),
    text: item.query,
  }));
  const semantic = await tryEmbedTextsWithSemanticProvider([
    ...recordEntries.map((entry) => entry.text),
    ...queryEntries.map((entry) => entry.text),
  ]);
  let vectorProvider: typeof HUGGINGFACE_TRANSFORMERS_PROVIDER | typeof LOCAL_TEXT_HASHING_PROVIDER = LOCAL_TEXT_HASHING_PROVIDER;
  let vectorModel: string | null = null;
  let vectorDimensions = dimensions;
  let semanticProvider = false;
  let cacheDir: string | null | undefined = undefined;
  if (semantic) {
    vectorProvider = semantic.provider;
    vectorModel = semantic.model;
    vectorDimensions = semantic.dimensions;
    semanticProvider = true;
    cacheDir = semantic.cache_dir;
    for (let index = 0; index < recordEntries.length; index += 1) {
      const entry = recordEntries[index];
      if (entry) records[entry.path] = semantic.vectors[index] ?? [];
    }
    const queryOffset = recordEntries.length;
    for (let index = 0; index < queryEntries.length; index += 1) {
      const entry = queryEntries[index];
      if (entry) queries[entry.key] = semantic.vectors[queryOffset + index] ?? [];
    }
  } else {
    vectorProvider = LOCAL_TEXT_HASHING_PROVIDER;
    vectorModel = null;
    vectorDimensions = dimensions;
    semanticProvider = false;
    cacheDir = null;
    for (const entry of recordEntries) {
      records[entry.path] = embedText(entry.text, dimensions);
    }
    for (const entry of queryEntries) {
      queries[entry.key] = embedText(entry.text, dimensions);
    }
  }

  const expectedPaths = new Set((ragGolden?.cases ?? []).flatMap((item) => item.expected_paths));
  const missingExpected = Array.from(expectedPaths).filter((expectedPath) => !records[expectedPath]);
  if (ragGolden) await writeJson(ragGoldenPath, ragGolden);
  await writeJson(denseVectorPath, {
    version: 1,
    provider: vectorProvider,
    model: vectorModel,
    dimensions: vectorDimensions,
    semantic_embedding_provider: semanticProvider,
    cache_dir: cacheDir,
    generated_at: generatedAt,
    source_index_path: WIKI_INDEX_RELATIVE_PATH,
    records,
    queries,
  });

  const hasGolden = Boolean(ragGolden && ragGolden.cases.length > 0 && missingExpected.length === 0);
  const status = !hasGolden ? "degraded" : semanticProvider ? "healthy" : "needs_attention";
  const report: RagProofReport = {
    version: RAG_PROOF_VERSION,
    status,
    generated_at: generatedAt,
    data_root: path.resolve(dataRoot),
    rag_golden_path: RAG_GOLDEN_RELATIVE_PATH,
    dense_vector_path: DENSE_VECTOR_INDEX_RELATIVE_PATH,
    source_behavior_golden_path: behavior ? ".dino/evaluations/behavior-golden.json" : null,
    counts: {
      golden_cases: ragGolden?.cases.length ?? 0,
      record_vectors: Object.keys(records).length,
      query_vectors: Object.keys(queries).length,
      missing_expected_paths: missingExpected.length,
    },
    dense_vector: {
      provider: vectorProvider,
      model: vectorModel,
      dimensions: vectorDimensions,
      semantic_embedding_provider: semanticProvider,
      cache_dir: cacheDir,
    },
    warnings: [
      !ragGolden ? "behavior_golden_missing" : "",
      missingExpected.length > 0 ? "rag_expected_paths_missing_from_wiki_index" : "",
      semanticProvider ? "" : "local_text_hashing_vectors_are_not_external_embedding_provider",
    ].filter(Boolean),
    visible_status:
      status === "healthy"
        ? "RAG proof artifacts ready with semantic embeddings"
        : status === "needs_attention"
          ? "RAG proof artifacts use lexical hashing fallback"
          : "RAG proof artifacts need repair",
  };
  await writeJson(statusPath, report);
  return { report, statusPath };
}
