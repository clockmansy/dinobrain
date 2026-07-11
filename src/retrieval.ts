import { collectRecentTaskRecords, type RankedRecord } from "./context.js";
import { rankRecordsHybridV2, retrievalModeFor } from "./hybrid-retrieval.js";
import { loadDenseVectorIndexWithLiveQuery } from "./live-semantic-query.js";
import {
  collectRecentTaskRecordsFromSqlite,
  querySqliteWiki,
  sqliteShardExists,
  type SqliteRetrievalStats,
} from "./sqlite-shards.js";
import { getIndexedPackItems, queryIndexedWiki, type IndexedRetrievalStats } from "./wiki-index.js";

type RetrievalStats = IndexedRetrievalStats | SqliteRetrievalStats;

export type ContextPackRetrievalOptions = {
  includeRecentTasks?: boolean;
  excludedPathPrefixes?: string[];
};

function withoutExcludedPaths(records: RankedRecord[], prefixes: string[] | undefined): RankedRecord[] {
  const normalized = (prefixes ?? []).map((prefix) => prefix.replace(/\\/g, "/")).filter(Boolean);
  if (normalized.length === 0) return records;
  return records.filter((record) => !normalized.some((prefix) => record.path.replace(/\\/g, "/").startsWith(prefix)));
}

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
  options: ContextPackRetrievalOptions = {},
): Promise<{ records: RankedRecord[]; ranked: RankedRecord[]; stats: RetrievalStats }> {
  if (!(await sqliteShardExists(dataRoot, "wiki"))) {
    return await getIndexedPackItems(dataRoot, question, limit, options);
  }

  const candidateLimit = Math.max(limit * 80, 400);
  const { index: denseVectorIndex } = await loadDenseVectorIndexWithLiveQuery(dataRoot, question);
  const sqlite = await querySqliteWiki(dataRoot, question, candidateLimit, {
    includeExcerpt: false,
    rankLimit: candidateLimit,
    denseVectorIndex,
  });
  const recentTasks = options.includeRecentTasks === false
    ? []
    : (await collectRecentTaskRecordsFromSqlite(dataRoot, 10)) ?? (await collectRecentTaskRecords(dataRoot, 10));
  const records = withoutExcludedPaths([...sqlite.records, ...recentTasks], options.excludedPathPrefixes);
  const ranked = rankRecordsHybridV2(records, question, { limit, denseVectorIndex, contextPackBudget: true });

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
