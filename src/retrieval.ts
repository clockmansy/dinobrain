import { collectRecentTaskRecords, type RankedRecord } from "./context.js";
import { loadDenseVectorIndex, rankRecordsHybridV2, retrievalModeFor } from "./hybrid-retrieval.js";
import {
  collectRecentTaskRecordsFromSqlite,
  querySqliteWiki,
  sqliteShardExists,
  type SqliteRetrievalStats,
} from "./sqlite-shards.js";
import { getIndexedPackItems, queryIndexedWiki, type IndexedRetrievalStats } from "./wiki-index.js";

type RetrievalStats = IndexedRetrievalStats | SqliteRetrievalStats;

export async function searchWiki(
  dataRoot: string,
  query: string,
  limit: number,
): Promise<{ records: RankedRecord[]; ranked: RankedRecord[]; stats: RetrievalStats }> {
  if (await sqliteShardExists(dataRoot, "wiki")) {
    return await querySqliteWiki(dataRoot, query, limit);
  }
  return await queryIndexedWiki(dataRoot, query, limit);
}

export async function getContextPackItems(
  dataRoot: string,
  question: string,
  limit: number,
): Promise<{ records: RankedRecord[]; ranked: RankedRecord[]; stats: RetrievalStats }> {
  if (!(await sqliteShardExists(dataRoot, "wiki"))) {
    return await getIndexedPackItems(dataRoot, question, limit);
  }

  const sqlite = await querySqliteWiki(dataRoot, question, Math.max(limit * 200, 1000), {
    includeExcerpt: false,
    rankLimit: Math.max(limit * 200, 1000),
  });
  const recentTasks =
    (await collectRecentTaskRecordsFromSqlite(dataRoot, 10)) ?? (await collectRecentTaskRecords(dataRoot, 10));
  const records = [...sqlite.records, ...recentTasks];
  const denseVectorIndex = loadDenseVectorIndex(dataRoot);
  const ranked = rankRecordsHybridV2(records, question, { limit, denseVectorIndex });

  return {
    records,
    ranked,
    stats: {
      ...sqlite.stats,
      retrieval_mode: retrievalModeFor(records, question, denseVectorIndex),
      candidate_record_count: records.length,
      total_candidate_count: sqlite.stats.total_candidate_count + recentTasks.length,
      recent_task_count: recentTasks.length,
    },
  };
}
