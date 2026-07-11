import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.env.DINOBRAIN_LIVE_QUERY_CACHE_CAPACITY = "32";

const {
  getLiveQueryVectorCacheStats,
  hasLiveQueryVectorCacheEntry,
  primeLiveQueryVectorCache,
  resetLiveQueryVectorCache,
} = await import(pathToFileURL(path.join(root, "dist", "live-semantic-query.js")).href);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

resetLiveQueryVectorCache();
for (let index = 0; index < 1000; index += 1) {
  primeLiveQueryVectorCache("fixture-model", `unique query ${index}`, [index, index + 1, index + 2, index + 3]);
}

const stats = getLiveQueryVectorCacheStats();
assert(stats.capacity === 32, `unexpected cache capacity: ${stats.capacity}`);
assert(stats.entries === 32, `cache exceeded its entry budget: ${stats.entries}`);
assert(stats.evictions === 968, `unexpected eviction count: ${stats.evictions}`);
assert(stats.estimated_vector_bytes === 32 * 4 * 8, `unexpected vector byte estimate: ${stats.estimated_vector_bytes}`);
assert(!hasLiveQueryVectorCacheEntry("fixture-model", "unique query 0"), "oldest cache entry was not evicted");
assert(hasLiveQueryVectorCacheEntry("fixture-model", "unique query 999"), "newest cache entry was not retained");

resetLiveQueryVectorCache();
assert(getLiveQueryVectorCacheStats().entries === 0, "cache reset did not release entries");

console.log("live query cache budget verification ok");
