import path from "node:path";

export const DEFAULT_SEMANTIC_MODEL = "Xenova/all-MiniLM-L6-v2";
export const HUGGINGFACE_TRANSFORMERS_PROVIDER = "huggingface_transformers_feature_extraction_v1";
export const LOCAL_TEXT_HASHING_PROVIDER = "local_text_hashing_v1";

export type SemanticEmbeddingProvider = {
  provider: typeof HUGGINGFACE_TRANSFORMERS_PROVIDER;
  model: string;
  dimensions: number;
  semantic_embedding_provider: true;
  cache_dir: string | null;
  vectors: number[][];
};

function defaultCacheDir(): string | null {
  const localAppData = process.env.LOCALAPPDATA?.trim();
  if (localAppData) return path.join(localAppData, "DinoBrain", "models", "huggingface");
  const home = process.env.HOME?.trim() || process.env.USERPROFILE?.trim();
  if (home) return path.join(home, ".cache", "dinobrain", "huggingface");
  return null;
}

function semanticDisabled(): boolean {
  const setting = process.env.DINOBRAIN_SEMANTIC_EMBEDDINGS?.trim().toLowerCase();
  return setting === "0" || setting === "false" || setting === "off" || setting === "disabled";
}

function toVectorRows(output: unknown, expectedRows: number): number[][] {
  const tensor = output as { data?: ArrayLike<number>; dims?: number[] };
  const data = tensor.data ? Array.from(tensor.data, Number) : [];
  const dims = Array.isArray(tensor.dims) ? tensor.dims : [];
  const rows = dims[0] ?? expectedRows;
  const dimensions = dims[1] ?? (rows > 0 ? data.length / rows : 0);
  if (!Number.isInteger(rows) || !Number.isInteger(dimensions) || rows !== expectedRows || dimensions <= 0) {
    throw new Error(`semantic_embedding_unexpected_shape:${JSON.stringify(dims)}`);
  }
  const vectors: number[][] = [];
  for (let row = 0; row < rows; row += 1) {
    const start = row * dimensions;
    vectors.push(data.slice(start, start + dimensions).map((value) => Number(value.toFixed(6))));
  }
  return vectors;
}

export async function tryEmbedTextsWithSemanticProvider(texts: string[]): Promise<SemanticEmbeddingProvider | null> {
  if (semanticDisabled() || texts.length === 0) return null;

  const model = process.env.DINOBRAIN_SEMANTIC_MODEL?.trim() || DEFAULT_SEMANTIC_MODEL;
  const cacheDir = process.env.DINOBRAIN_HF_CACHE_DIR?.trim() || defaultCacheDir();
  try {
    const transformers = (await import("@huggingface/transformers")) as {
      env?: { cacheDir?: string; allowLocalModels?: boolean; allowRemoteModels?: boolean };
      pipeline: (task: string, model: string, options?: Record<string, unknown>) => Promise<unknown>;
    };
    if (cacheDir && transformers.env) transformers.env.cacheDir = cacheDir;
    if (transformers.env) {
      transformers.env.allowLocalModels = true;
      transformers.env.allowRemoteModels = process.env.DINOBRAIN_HF_ALLOW_REMOTE !== "0";
    }
    const extractor = (await transformers.pipeline("feature-extraction", model, { dtype: "q8" })) as (
      input: string[],
      options?: Record<string, unknown>,
    ) => Promise<unknown>;
    const vectors = toVectorRows(await extractor(texts, { pooling: "mean", normalize: true }), texts.length);
    return {
      provider: HUGGINGFACE_TRANSFORMERS_PROVIDER,
      model,
      dimensions: vectors[0]?.length ?? 0,
      semantic_embedding_provider: true,
      cache_dir: cacheDir,
      vectors,
    };
  } catch (error) {
    if (process.env.DINOBRAIN_REQUIRE_SEMANTIC_EMBEDDINGS === "1") throw error;
    return null;
  }
}
