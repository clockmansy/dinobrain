import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.env.DINOBRAIN_SEMANTIC_PIPELINE_CACHE_CAPACITY = "1";
process.env.DINOBRAIN_SEMANTIC_MODEL = "fixture-model-a";

const semantic = await import(pathToFileURL(path.join(root, "dist", "semantic-embeddings.js")).href);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

let constructions = 0;
let disposals = 0;
let activeInference = 0;
let maxActiveInference = 0;

await semantic.setSemanticPipelineFactoryForTesting(async () => {
  constructions += 1;
  const extractor = async (texts) => {
    activeInference += 1;
    maxActiveInference = Math.max(maxActiveInference, activeInference);
    await new Promise((resolve) => setTimeout(resolve, 1));
    activeInference -= 1;
    return {
      dims: [texts.length, 4],
      data: Float32Array.from(texts.flatMap((text, index) => [text.length, index + 1, 0.5, 1])),
    };
  };
  extractor.dispose = async () => {
    disposals += 1;
  };
  return extractor;
});

const results = await Promise.all(
  Array.from({ length: 100 }, (_, index) => semantic.tryEmbedTextsWithSemanticProvider([`query ${index}`])),
);
assert(results.every((result) => result?.vectors?.[0]?.length === 4), "fixture embeddings were not returned");
let stats = semantic.getSemanticPipelineCacheStats();
assert(constructions === 1, `pipeline was constructed ${constructions} times for one model`);
assert(stats.constructions === 1, `cache construction counter mismatch: ${stats.constructions}`);
assert(stats.entries === 1, `pipeline cache entry count mismatch: ${stats.entries}`);
assert(stats.inference_calls === 100, `inference call count mismatch: ${stats.inference_calls}`);
assert(maxActiveInference === 1, `inference calls overlapped: ${maxActiveInference}`);

process.env.DINOBRAIN_SEMANTIC_MODEL = "fixture-model-b";
await semantic.tryEmbedTextsWithSemanticProvider(["replacement model"]);
await new Promise((resolve) => setTimeout(resolve, 0));
stats = semantic.getSemanticPipelineCacheStats();
assert(constructions === 2, `replacement model was not constructed exactly once: ${constructions}`);
assert(stats.entries === 1, `pipeline LRU exceeded capacity: ${stats.entries}`);
assert(disposals === 1, `evicted pipeline was not disposed: ${disposals}`);

await semantic.disposeSemanticEmbeddingPipelines();
assert(semantic.getSemanticPipelineCacheStats().entries === 0, "pipeline cache did not clear on dispose");
assert(disposals === 2, `active pipeline was not disposed: ${disposals}`);

console.log("semantic pipeline cache verification ok");
