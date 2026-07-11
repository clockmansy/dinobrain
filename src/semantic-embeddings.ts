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

type SemanticExtractor = ((input: string[], options?: Record<string, unknown>) => Promise<unknown>) & {
  dispose?: () => Promise<void> | void;
};

type SemanticPipelineFactory = (params: {
  model: string;
  cacheDir: string | null;
  allowRemoteModels: boolean;
}) => Promise<SemanticExtractor>;

const DEFAULT_PIPELINE_CACHE_CAPACITY = 1;
const DEFAULT_EMBEDDING_BATCH_SIZE = 4;
const MAX_EMBEDDING_BATCH_SIZE = 64;
const DEFAULT_MAX_INPUT_CHARS = 2_000;
const MAX_INPUT_CHARS = 32_000;
const pipelineCache = new Map<string, Promise<SemanticExtractor>>();
const inferenceQueues = new Map<string, Promise<void>>();
let pipelineConstructions = 0;
let pipelineDisposals = 0;
let inferenceCalls = 0;
let testPipelineFactory: SemanticPipelineFactory | null = null;

function pipelineCacheCapacity(): number {
  const configured = Number(process.env.DINOBRAIN_SEMANTIC_PIPELINE_CACHE_CAPACITY ?? DEFAULT_PIPELINE_CACHE_CAPACITY);
  if (!Number.isFinite(configured)) return DEFAULT_PIPELINE_CACHE_CAPACITY;
  return Math.max(1, Math.min(4, Math.floor(configured)));
}

function embeddingBatchSize(): number {
  const configured = Number(process.env.DINOBRAIN_SEMANTIC_BATCH_SIZE ?? DEFAULT_EMBEDDING_BATCH_SIZE);
  if (!Number.isFinite(configured)) return DEFAULT_EMBEDDING_BATCH_SIZE;
  return Math.max(1, Math.min(MAX_EMBEDDING_BATCH_SIZE, Math.floor(configured)));
}

function maxInputChars(): number {
  const configured = Number(process.env.DINOBRAIN_SEMANTIC_MAX_INPUT_CHARS ?? DEFAULT_MAX_INPUT_CHARS);
  if (!Number.isFinite(configured)) return DEFAULT_MAX_INPUT_CHARS;
  return Math.max(256, Math.min(MAX_INPUT_CHARS, Math.floor(configured)));
}

async function defaultPipelineFactory(params: {
  model: string;
  cacheDir: string | null;
  allowRemoteModels: boolean;
}): Promise<SemanticExtractor> {
  const transformers = (await import("@huggingface/transformers")) as {
    env?: { cacheDir?: string; allowLocalModels?: boolean; allowRemoteModels?: boolean };
    pipeline: (task: string, model: string, options?: Record<string, unknown>) => Promise<unknown>;
  };
  if (params.cacheDir && transformers.env) transformers.env.cacheDir = params.cacheDir;
  if (transformers.env) {
    transformers.env.allowLocalModels = true;
    transformers.env.allowRemoteModels = params.allowRemoteModels;
  }
  return (await transformers.pipeline("feature-extraction", params.model, { dtype: "q8" })) as SemanticExtractor;
}

function pipelineKey(model: string, cacheDir: string | null, allowRemoteModels: boolean): string {
  return `${model}\u0000${cacheDir ?? ""}\u0000${allowRemoteModels ? "remote" : "local"}`;
}

async function disposePipeline(pipelinePromise: Promise<SemanticExtractor>): Promise<void> {
  try {
    const pipeline = await pipelinePromise;
    if (pipeline.dispose) await pipeline.dispose();
  } catch {
    // A failed construction has no usable native resources to dispose.
  } finally {
    pipelineDisposals += 1;
  }
}

function evictExcessPipelines(): void {
  while (pipelineCache.size > pipelineCacheCapacity()) {
    const oldestKey = pipelineCache.keys().next().value as string | undefined;
    if (!oldestKey) break;
    const pipelinePromise = pipelineCache.get(oldestKey);
    pipelineCache.delete(oldestKey);
    inferenceQueues.delete(oldestKey);
    if (pipelinePromise) void disposePipeline(pipelinePromise);
  }
}

function getPipeline(model: string, cacheDir: string | null, allowRemoteModels: boolean): {
  key: string;
  pipeline: Promise<SemanticExtractor>;
} {
  const key = pipelineKey(model, cacheDir, allowRemoteModels);
  let pipeline = pipelineCache.get(key);
  if (!pipeline) {
    pipelineConstructions += 1;
    const factory = testPipelineFactory ?? defaultPipelineFactory;
    pipeline = factory({ model, cacheDir, allowRemoteModels }).catch((error) => {
      pipelineCache.delete(key);
      inferenceQueues.delete(key);
      throw error;
    });
    pipelineCache.set(key, pipeline);
    evictExcessPipelines();
  } else {
    pipelineCache.delete(key);
    pipelineCache.set(key, pipeline);
  }
  return { key, pipeline };
}

async function runSerializedInference(key: string, pipeline: SemanticExtractor, texts: string[]): Promise<unknown> {
  const previous = inferenceQueues.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const queued = previous.then(() => current);
  inferenceQueues.set(key, queued);
  await previous;
  try {
    inferenceCalls += 1;
    return await pipeline(texts, { pooling: "mean", normalize: true, truncation: true });
  } finally {
    release();
    if (inferenceQueues.get(key) === queued) inferenceQueues.delete(key);
  }
}

export function getSemanticPipelineCacheStats(): {
  entries: number;
  capacity: number;
  constructions: number;
  disposals: number;
  inference_calls: number;
  batch_size: number;
  max_input_chars: number;
} {
  return {
    entries: pipelineCache.size,
    capacity: pipelineCacheCapacity(),
    constructions: pipelineConstructions,
    disposals: pipelineDisposals,
    inference_calls: inferenceCalls,
    batch_size: embeddingBatchSize(),
    max_input_chars: maxInputChars(),
  };
}

export async function disposeSemanticEmbeddingPipelines(): Promise<void> {
  const pipelines = [...pipelineCache.values()];
  pipelineCache.clear();
  inferenceQueues.clear();
  await Promise.all(pipelines.map(disposePipeline));
}

export async function setSemanticPipelineFactoryForTesting(factory: SemanticPipelineFactory | null): Promise<void> {
  await disposeSemanticEmbeddingPipelines();
  testPipelineFactory = factory;
  pipelineConstructions = 0;
  pipelineDisposals = 0;
  inferenceCalls = 0;
}

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
  const allowRemoteModels = process.env.DINOBRAIN_HF_ALLOW_REMOTE !== "0";
  try {
    const cached = getPipeline(model, cacheDir, allowRemoteModels);
    const extractor = await cached.pipeline;
    const boundedTexts = texts.map((text) => text.slice(0, maxInputChars()));
    const vectors: number[][] = [];
    const batchSize = embeddingBatchSize();
    for (let offset = 0; offset < boundedTexts.length; offset += batchSize) {
      const batch = boundedTexts.slice(offset, offset + batchSize);
      vectors.push(...toVectorRows(await runSerializedInference(cached.key, extractor, batch), batch.length));
    }
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
