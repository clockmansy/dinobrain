import { promises as fs } from "node:fs";
import path from "node:path";

import { atomicWriteJson } from "./concurrency.js";
import {
  LIVE_SEMANTIC_QUERY_STATUS_RELATIVE_PATH,
  LIVE_SEMANTIC_QUERY_VERSION,
  loadDenseVectorIndexWithLiveQuery,
  type LiveQueryEmbeddingProof,
} from "./live-semantic-query.js";
import { getContextPackItems } from "./retrieval.js";

export { LIVE_SEMANTIC_QUERY_STATUS_RELATIVE_PATH } from "./live-semantic-query.js";

export type LiveSemanticQueryReport = {
  version: typeof LIVE_SEMANTIC_QUERY_VERSION;
  status: "healthy" | "needs_attention" | "degraded";
  generated_at: string;
  data_root: string;
  query: string;
  limit: number;
  proof: LiveQueryEmbeddingProof;
  retrieval: {
    mode: string | null;
    returned_paths: string[];
    dense_reason_count: number;
    top_reasons: string[];
  };
  warnings: string[];
  visible_status: string;
};

type BuildOptions = {
  now?: Date;
  query?: string;
  limit?: number;
};

function dataPath(dataRoot: string, relativePath: string): string {
  return path.resolve(dataRoot, ...relativePath.split("/"));
}

export function getLiveSemanticQueryStatusPath(dataRoot: string): string {
  return dataPath(dataRoot, LIVE_SEMANTIC_QUERY_STATUS_RELATIVE_PATH);
}

export async function buildLiveSemanticQueryReport(
  dataRoot: string,
  options: BuildOptions = {},
): Promise<LiveSemanticQueryReport> {
  const generatedAt = (options.now ?? new Date()).toISOString();
  const query =
    options.query ??
    "How can DinoBrain prove a brand new user question uses semantic memory retrieval instead of lexical fallback?";
  const limit = options.limit ?? 8;
  const before = await loadDenseVectorIndexWithLiveQuery(dataRoot, query);
  const pack = await getContextPackItems(dataRoot, query, limit);
  const denseReasons = pack.ranked.flatMap((record) =>
    record.reasons.filter((reason) => reason.startsWith("dense_vector_cosine:")),
  );
  const ok =
    before.proof.status === "generated_live_query_vector" &&
    before.proof.on_the_fly_query_embedding &&
    pack.stats.retrieval_mode === "hybrid_contextual_v2" &&
    denseReasons.length > 0;
  const status = ok ? "healthy" : before.proof.fallback_reason ? "degraded" : "needs_attention";
  return {
    version: LIVE_SEMANTIC_QUERY_VERSION,
    status,
    generated_at: generatedAt,
    data_root: path.resolve(dataRoot),
    query,
    limit,
    proof: before.proof,
    retrieval: {
      mode: pack.stats.retrieval_mode,
      returned_paths: pack.ranked.map((record) => record.path),
      dense_reason_count: denseReasons.length,
      top_reasons: pack.ranked.flatMap((record) => record.reasons).slice(0, 24),
    },
    warnings: [
      before.proof.query_vector_preexisting ? "query_vector_was_precomputed_not_live" : "",
      before.proof.fallback_reason ?? "",
      pack.stats.retrieval_mode !== "hybrid_contextual_v2" ? "live_query_retrieval_not_hybrid" : "",
      denseReasons.length === 0 ? "live_query_dense_topk_not_observed" : "",
    ].filter(Boolean),
    visible_status: ok
      ? "Live semantic query retrieval is healthy"
      : "Live semantic query retrieval needs attention",
  };
}

export async function buildAndWriteLiveSemanticQueryReport(
  dataRoot: string,
  options: BuildOptions = {},
): Promise<{ report: LiveSemanticQueryReport; statusPath: string }> {
  const report = await buildLiveSemanticQueryReport(dataRoot, options);
  const statusPath = getLiveSemanticQueryStatusPath(dataRoot);
  await atomicWriteJson(statusPath, report);
  return { report, statusPath };
}
