import {
  denseIndexUsesSemanticProvider,
  denseRecordVectorCount,
  denseVectorDimensions,
  hasDenseQueryVector,
  loadDenseVectorIndex,
  normalizeVectorKey,
  setDenseQueryVector,
  type DenseVectorIndex,
} from "./hybrid-retrieval.js";
import {
  HUGGINGFACE_TRANSFORMERS_PROVIDER,
  tryEmbedTextsWithSemanticProvider,
} from "./semantic-embeddings.js";

export const LIVE_SEMANTIC_QUERY_STATUS_RELATIVE_PATH = ".dino/state/live_semantic_query_status.json";
export const LIVE_SEMANTIC_QUERY_VERSION = "live_semantic_query_v1";

export type LiveQueryEmbeddingProof = {
  status:
    | "existing_query_vector"
    | "generated_live_query_vector"
    | "dense_index_missing"
    | "semantic_provider_missing"
    | "semantic_provider_mismatch"
    | "semantic_model_mismatch"
    | "dimension_mismatch"
    | "query_vector_generation_failed";
  query_key: string;
  query_vector_preexisting: boolean;
  on_the_fly_query_embedding: boolean;
  provider: string | null;
  model: string | null;
  dimensions: number;
  record_vector_count: number;
  semantic_embedding_provider: boolean;
  fallback_reason: string | null;
};

type LoadedLiveQueryIndex = {
  index: DenseVectorIndex | null;
  proof: LiveQueryEmbeddingProof;
};

const liveQueryVectorCache = new Map<string, number[]>();

function cacheKey(model: string | null | undefined, query: string): string {
  return `${model ?? ""}\u0000${normalizeVectorKey(query)}`;
}

function baseProof(
  index: DenseVectorIndex | null,
  query: string,
  status: LiveQueryEmbeddingProof["status"],
  fallbackReason: string | null,
): LiveQueryEmbeddingProof {
  return {
    status,
    query_key: normalizeVectorKey(query),
    query_vector_preexisting: Boolean(index && hasDenseQueryVector(index, query)),
    on_the_fly_query_embedding: false,
    provider: typeof index?.provider === "string" ? index.provider : null,
    model: typeof index?.model === "string" ? index.model : null,
    dimensions: denseVectorDimensions(index),
    record_vector_count: denseRecordVectorCount(index),
    semantic_embedding_provider: denseIndexUsesSemanticProvider(index),
    fallback_reason: fallbackReason,
  };
}

export async function ensureLiveQueryDenseVector(
  denseVectorIndex: DenseVectorIndex | null,
  query: string,
): Promise<LoadedLiveQueryIndex> {
  if (!denseVectorIndex) {
    return {
      index: null,
      proof: baseProof(null, query, "dense_index_missing", "dense_vector_index_missing"),
    };
  }

  if (hasDenseQueryVector(denseVectorIndex, query)) {
    return {
      index: denseVectorIndex,
      proof: baseProof(denseVectorIndex, query, "existing_query_vector", null),
    };
  }

  const declaredProvider = typeof denseVectorIndex.provider === "string" ? denseVectorIndex.provider : null;
  const declaredModel = typeof denseVectorIndex.model === "string" ? denseVectorIndex.model : null;
  const dimensions = denseVectorDimensions(denseVectorIndex);
  if (!denseIndexUsesSemanticProvider(denseVectorIndex)) {
    return {
      index: denseVectorIndex,
      proof: baseProof(denseVectorIndex, query, "semantic_provider_missing", "dense_index_not_semantic"),
    };
  }

  const key = cacheKey(declaredModel, query);
  const cached = liveQueryVectorCache.get(key);
  if (cached) {
    setDenseQueryVector(denseVectorIndex, query, cached);
    return {
      index: denseVectorIndex,
      proof: {
        ...baseProof(denseVectorIndex, query, "generated_live_query_vector", null),
        on_the_fly_query_embedding: true,
        query_vector_preexisting: false,
      },
    };
  }

  const semantic = await tryEmbedTextsWithSemanticProvider([query]);
  if (!semantic) {
    return {
      index: denseVectorIndex,
      proof: baseProof(denseVectorIndex, query, "semantic_provider_missing", "semantic_embedding_provider_unavailable"),
    };
  }
  if (declaredProvider && declaredProvider !== semantic.provider) {
    return {
      index: denseVectorIndex,
      proof: baseProof(denseVectorIndex, query, "semantic_provider_mismatch", "semantic_provider_mismatch"),
    };
  }
  if (declaredModel && declaredModel !== semantic.model) {
    return {
      index: denseVectorIndex,
      proof: baseProof(denseVectorIndex, query, "semantic_model_mismatch", "semantic_model_mismatch"),
    };
  }
  if (dimensions > 0 && dimensions !== semantic.dimensions) {
    return {
      index: denseVectorIndex,
      proof: baseProof(denseVectorIndex, query, "dimension_mismatch", "semantic_query_vector_dimension_mismatch"),
    };
  }

  const vector = semantic.vectors[0] ?? [];
  if (vector.length === 0) {
    return {
      index: denseVectorIndex,
      proof: baseProof(denseVectorIndex, query, "query_vector_generation_failed", "empty_semantic_query_vector"),
    };
  }
  liveQueryVectorCache.set(key, vector);
  setDenseQueryVector(denseVectorIndex, query, vector);
  return {
    index: denseVectorIndex,
    proof: {
      ...baseProof(denseVectorIndex, query, "generated_live_query_vector", null),
      query_vector_preexisting: false,
      on_the_fly_query_embedding: true,
      provider: HUGGINGFACE_TRANSFORMERS_PROVIDER,
      model: semantic.model,
      dimensions: semantic.dimensions,
      semantic_embedding_provider: true,
    },
  };
}

export async function loadDenseVectorIndexWithLiveQuery(dataRoot: string, query: string): Promise<LoadedLiveQueryIndex> {
  return await ensureLiveQueryDenseVector(loadDenseVectorIndex(dataRoot), query);
}
