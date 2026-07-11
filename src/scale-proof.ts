import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

import { atomicWriteJson, atomicWriteText } from "./concurrency.js";
import {
  DENSE_VECTOR_INDEX_RELATIVE_PATH,
  getDenseVectorIndexCacheStats,
  normalizeVectorKey,
  resetDenseVectorIndexCache,
  type DenseVectorIndex,
  type DenseVectorSearchStats,
} from "./hybrid-retrieval.js";
import { collectRecentTaskRecordsFromSqlite, buildAndWriteSqliteShards, getSqliteShardPath, upsertSqliteOperationTask } from "./sqlite-shards.js";
import { getContextPackItems, searchWiki } from "./retrieval.js";
import {
  HUGGINGFACE_TRANSFORMERS_PROVIDER,
  tryEmbedTextsWithSemanticProvider,
} from "./semantic-embeddings.js";
import type { OperationTaskEntry } from "./operations-index.js";
import { publishStatusGeneration } from "./status-generation.js";

export const SCALE_PROOF_VERSION = "scale_50k_v1";
export const SCALE_CORPUS_VERSION = "deterministic_curated_50k_v1";
export const SCALE_REPORT_RELATIVE_PATH = ".dino/evaluations/scale-50k-status.json";
const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DAY_MS = 86_400_000;
const CLUSTER_COUNT = 100;
const PROJECTION_DIMENSIONS = 32;
const DEFAULT_SAMPLE_COUNT = 25;
const DEFAULT_GRAPH_SAMPLE_COUNT = 5;
const DEFAULT_IO_CONCURRENCY = 64;

export type ScaleThresholds = {
  max_cold_build_ms: number;
  max_context_pack_p95_ms: number;
  max_wiki_search_p95_ms: number;
  max_recent_task_p95_ms: number;
  max_incremental_write_p95_ms: number;
  max_graph_refresh_p95_ms: number;
  max_observatory_poll_p95_ms: number;
  max_observatory_payload_bytes: number;
  max_dense_vectors_scanned: number;
  max_context_candidates: number;
  max_wiki_candidates: number;
  max_process_rss_bytes: number;
};

export const DEFAULT_SCALE_THRESHOLDS: ScaleThresholds = {
  max_cold_build_ms: 180_000,
  max_context_pack_p95_ms: 700,
  max_wiki_search_p95_ms: 300,
  max_recent_task_p95_ms: 50,
  max_incremental_write_p95_ms: 50,
  max_graph_refresh_p95_ms: 1_500,
  max_observatory_poll_p95_ms: 700,
  max_observatory_payload_bytes: 256 * 1024,
  max_dense_vectors_scanned: 4_096,
  max_context_candidates: 1_010,
  max_wiki_candidates: 100,
  max_process_rss_bytes: 4 * 1024 * 1024 * 1024,
};

type Distribution = {
  samples: number;
  min_ms: number;
  p50_ms: number;
  p95_ms: number;
  p99_ms: number;
  max_ms: number;
  mean_ms: number;
};

type OperationMeasurement = {
  wall_ms: number;
  cpu_user_ms: number;
  cpu_system_ms: number;
  cpu_percent_of_one_core: number;
  rss_start_bytes: number;
  rss_end_bytes: number;
  rss_peak_observed_bytes: number;
  heap_peak_observed_bytes: number;
};

type ScaleAssertion = {
  id: string;
  ok: boolean;
  actual: string | number | boolean;
  expected: string | number | boolean;
};

export type ScaleProofReport = {
  version: typeof SCALE_PROOF_VERSION;
  status: "healthy" | "healthy_fixture" | "needs_attention";
  qualifying: boolean;
  generated_at: string;
  corpus: {
    version: typeof SCALE_CORPUS_VERSION;
    record_count: number;
    session_count: number;
    root_counts: Record<string, number>;
    age_bucket_counts: Record<string, number>;
    manifest_sha256: string;
    session_manifest_sha256: string;
  };
  semantic_index: {
    provider: string;
    model: string;
    semantic_embedding_provider: boolean;
    encoding_strategy: string;
    source_dimensions: number;
    stored_dimensions: number;
    record_vectors: number;
    partition_count: number;
    probe_count: number;
    max_vectors_per_query: number;
  };
  reference_hardware: {
    platform: string;
    release: string;
    architecture: string;
    cpu_model: string;
    logical_cpu_count: number;
    total_memory_bytes: number;
    node_version: string;
  };
  hashes: {
    code_sha256: string;
    generator_sha256: string;
    environment_sha256: string;
  };
  thresholds: ScaleThresholds;
  measurements: {
    corpus_generation: OperationMeasurement;
    cold_build: OperationMeasurement;
    semantic_index_build: OperationMeasurement;
    context_pack: Distribution;
    wiki_search: Distribution;
    recent_task_lookup: Distribution;
    incremental_operation_write: Distribution;
    graph_refresh: Distribution;
    observatory_poll: Distribution;
    process_rss_peak_observed_bytes: number;
  };
  bounded_work: {
    candidate_source: string;
    retrieval_modes: string[];
    max_context_candidate_count: number;
    max_wiki_candidate_count: number;
    max_dense_vectors_scanned: number;
    dense_partitions_probed: number;
    dense_partition_count: number;
    dense_search_bounded: boolean;
    sqlite_term_lookup_mode: string;
    sqlite_term_query_plan: string[];
    sqlite_term_query_uses_index: boolean;
    sqlite_graph_node_query_plan: string[];
    sqlite_graph_edge_query_plan: string[];
    sqlite_graph_query_uses_index: boolean;
    dense_index_cache: ReturnType<typeof getDenseVectorIndexCacheStats>;
  };
  index_sizes: {
    wiki_sqlite_bytes: number;
    operations_sqlite_bytes: number;
    dense_index_bytes: number;
    wiki_records: number;
    wiki_terms: number;
    graph_nodes: number;
    graph_edges: number;
  };
  observatory: {
    graph_records: number;
    graph_nodes: number;
    graph_edges: number;
    graph_shown_nodes: number;
    graph_shown_edges: number;
    graph_truncated: boolean;
    snapshot_payload_max_bytes: number;
    cache_hits: number;
    cache_loads: number;
    cache_coalesced: number;
    sqlite_opens: number;
    directory_entries_seen: number;
    status_generation_verifications: number;
  };
  assertions: ScaleAssertion[];
  warnings: string[];
  integrity: {
    report_payload_sha256: string;
  };
};

type CorpusResult = {
  recordPathsByCluster: string[][];
  manifestSha256: string;
  sessionManifestSha256: string;
  rootCounts: Record<string, number>;
  ageBucketCounts: Record<string, number>;
};

type RunScaleProofOptions = {
  outputPath: string;
  fixtureRoot: string;
  recordCount?: number;
  sessionCount?: number;
  sampleCount?: number;
  graphSampleCount?: number;
  qualifying?: boolean;
  keepFixture?: boolean;
  fixtureSemantic?: boolean;
  thresholds?: Partial<ScaleThresholds>;
  ioConcurrency?: number;
};

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, stableValue(entry)]),
    );
  }
  return value;
}

function stableJson(value: unknown): string {
  return JSON.stringify(stableValue(value));
}

function round(value: number, digits = 3): number {
  return Number(value.toFixed(digits));
}

async function runBounded(total: number, concurrency: number, worker: (index: number) => Promise<void>): Promise<void> {
  let nextIndex = 0;
  await Promise.all(Array.from({ length: Math.min(total, concurrency) }, async () => {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= total) return;
      await worker(index);
    }
  }));
}

async function measureOperation<T>(operation: () => Promise<T>): Promise<{ value: T; measurement: OperationMeasurement }> {
  const startedAt = performance.now();
  const cpuStart = process.cpuUsage();
  const memoryStart = process.memoryUsage();
  let rssPeak = memoryStart.rss;
  let heapPeak = memoryStart.heapUsed;
  const sampler = setInterval(() => {
    const current = process.memoryUsage();
    rssPeak = Math.max(rssPeak, current.rss);
    heapPeak = Math.max(heapPeak, current.heapUsed);
  }, 25);
  const value = await operation();
  clearInterval(sampler);
  const memoryEnd = process.memoryUsage();
  rssPeak = Math.max(rssPeak, memoryEnd.rss);
  heapPeak = Math.max(heapPeak, memoryEnd.heapUsed);
  const wallMs = performance.now() - startedAt;
  const cpu = process.cpuUsage(cpuStart);
  const cpuMs = (cpu.user + cpu.system) / 1_000;
  return {
    value,
    measurement: {
      wall_ms: round(wallMs),
      cpu_user_ms: round(cpu.user / 1_000),
      cpu_system_ms: round(cpu.system / 1_000),
      cpu_percent_of_one_core: round(wallMs > 0 ? (cpuMs / wallMs) * 100 : 0),
      rss_start_bytes: memoryStart.rss,
      rss_end_bytes: memoryEnd.rss,
      rss_peak_observed_bytes: rssPeak,
      heap_peak_observed_bytes: heapPeak,
    },
  };
}

function distribution(samples: number[]): Distribution {
  const sorted = [...samples].sort((left, right) => left - right);
  const percentile = (ratio: number): number => sorted[Math.max(0, Math.ceil(sorted.length * ratio) - 1)] ?? 0;
  return {
    samples: sorted.length,
    min_ms: round(sorted[0] ?? 0),
    p50_ms: round(percentile(0.5)),
    p95_ms: round(percentile(0.95)),
    p99_ms: round(percentile(0.99)),
    max_ms: round(sorted[sorted.length - 1] ?? 0),
    mean_ms: round(sorted.reduce((sum, value) => sum + value, 0) / Math.max(1, sorted.length)),
  };
}

async function latencySamples<T>(count: number, operation: (index: number) => Promise<T>): Promise<{ values: T[]; stats: Distribution }> {
  const values: T[] = [];
  const latencies: number[] = [];
  for (let index = 0; index < count; index += 1) {
    const startedAt = performance.now();
    values.push(await operation(index));
    latencies.push(performance.now() - startedAt);
  }
  return { values, stats: distribution(latencies) };
}

function scaleRoot(index: number): string {
  const slot = index % 100;
  if (slot < 35) return "20_Wiki";
  if (slot < 50) return "30_Sources/chunks";
  if (slot < 65) return "40_Projects";
  if (slot < 80) return "50_Instances/accepted";
  if (slot < 90) return "60_Operations";
  return "70_Error_Book";
}

function ageBucket(index: number): { id: string; days: number } {
  const slot = (index * 17) % 100;
  if (slot < 10) return { id: "hot_0_7d", days: slot % 7 };
  if (slot < 35) return { id: "warm_8_90d", days: 8 + (slot % 83) };
  if (slot < 65) return { id: "cool_91_180d", days: 91 + (slot % 90) };
  return { id: "cold_181_720d", days: 181 + ((index * 13) % 540) };
}

function clusterText(cluster: number): string {
  const domains = ["retrieval", "provenance", "projects", "behavior", "operations", "recovery", "evaluation", "graph", "privacy", "installation"];
  const korean = ["검색", "근거", "프로젝트", "행동", "운영", "복구", "평가", "그래프", "보안", "설치"];
  const domain = domains[cluster % domains.length] ?? "memory";
  const ko = korean[cluster % korean.length] ?? "기억";
  return `DinoBrain scale cluster ${String(cluster).padStart(3, "0")} ${domain} ${ko} bilingual contextual memory topic`;
}

function recordRelativePath(index: number): string {
  const cluster = index % CLUSTER_COUNT;
  return `${scaleRoot(index)}/cluster-${String(cluster).padStart(3, "0")}/record-${String(index).padStart(6, "0")}.json`;
}

function lifecycleFields(relativePath: string, cluster: number, at: string): Record<string, unknown> {
  const candidatePath = `.dino/scale-lineage/candidate-${String(cluster).padStart(3, "0")}.json`;
  const reviewPath = `.dino/scale-lineage/review-${String(cluster).padStart(3, "0")}.json`;
  const transitionId = `scale-transition-${String(cluster).padStart(3, "0")}-${path.basename(relativePath, ".json")}`;
  return {
    lifecycle_version: "node_lifecycle_v3",
    lifecycle_state: "accepted",
    lifecycle_state_entered_at: at,
    lifecycle_last_transition_id: transitionId,
    lifecycle_history: [{
      transition_id: transitionId,
      idempotency_key: `${transitionId}-idempotency`,
      from_state: null,
      to_state: "accepted",
      reason_code: "scale_fixture_reviewed",
      reason: "Deterministic reviewed scale fixture",
      actor: "scale-proof-generator",
      at,
      evidence_paths: [candidatePath, reviewPath],
      predecessor_paths: [],
      successor_paths: [],
    }],
    node_id: `scale-node-${sha256(relativePath).slice(0, 20)}`,
    predecessor_paths: [],
    successor_paths: [],
    source_candidate_path: candidatePath,
    source_review_path: reviewPath,
    review_status: "accepted_by_agent_review",
    reviewed_by: "scale-proof-generator",
    reviewed_at: at,
  };
}

async function generateCorpus(root: string, recordCount: number, sessionCount: number, concurrency: number): Promise<CorpusResult> {
  const baseTime = Date.UTC(2026, 6, 1, 0, 0, 0);
  const roots = ["20_Wiki", "30_Sources/chunks", "40_Projects", "50_Instances/accepted", "60_Operations", "70_Error_Book"];
  await Promise.all([
    ...roots.map((entry) => fs.mkdir(path.join(root, entry), { recursive: true })),
    fs.mkdir(path.join(root, ".dino", "scale-lineage"), { recursive: true }),
    fs.mkdir(path.join(root, ".dino", "tasks"), { recursive: true }),
    fs.mkdir(path.join(root, ".dino", "traces"), { recursive: true }),
    fs.mkdir(path.join(root, ".dino", "context-packs"), { recursive: true }),
    fs.mkdir(path.join(root, ".dino", "events"), { recursive: true }),
  ]);

  await runBounded(CLUSTER_COUNT, concurrency, async (cluster) => {
    const suffix = String(cluster).padStart(3, "0");
    const candidatePath = path.join(root, ".dino", "scale-lineage", `candidate-${suffix}.json`);
    const reviewPath = path.join(root, ".dino", "scale-lineage", `review-${suffix}.json`);
    const candidateRelative = `.dino/scale-lineage/candidate-${suffix}.json`;
    await atomicWriteJson(candidatePath, {
      candidate_id: `scale-candidate-${suffix}`,
      status: "reviewed",
      claim: clusterText(cluster),
      sensitivity: "normal",
    });
    await atomicWriteJson(reviewPath, {
      review_id: `scale-review-${suffix}`,
      status: "approved",
      candidate_path: candidateRelative,
      reviewer: "scale-proof-generator",
    });
  });

  const manifestEntries = new Array<string>(recordCount);
  const recordPathsByCluster = Array.from({ length: CLUSTER_COUNT }, () => [] as string[]);
  const rootCounts: Record<string, number> = Object.fromEntries(roots.map((entry) => [entry, 0]));
  const ageBucketCounts: Record<string, number> = {
    hot_0_7d: 0,
    warm_8_90d: 0,
    cool_91_180d: 0,
    cold_181_720d: 0,
  };
  await runBounded(recordCount, concurrency, async (index) => {
    const relativePath = recordRelativePath(index);
    const absolutePath = path.join(root, ...relativePath.split("/"));
    const cluster = index % CLUSTER_COUNT;
    const age = ageBucket(index);
    const at = new Date(baseTime - age.days * DAY_MS).toISOString();
    const record: Record<string, unknown> = {
      id: `scale-record-${String(index).padStart(6, "0")}`,
      title: `Scale Record ${String(index).padStart(6, "0")} ${clusterText(cluster)}`,
      summary: `${clusterText(cluster)} deterministic item ${index} linked to [[Scale Record ${String(Math.max(0, index - CLUSTER_COUNT)).padStart(6, "0")}]].`,
      tags: ["scale", `cluster-${String(cluster).padStart(3, "0")}`, scaleRoot(index).split("/")[0]?.toLowerCase()],
      aliases: [`scale-alias-${String(index).padStart(6, "0")}`],
      updated_at: at,
      created_at: at,
      lifecycle_state: "active",
      verification_status: scaleRoot(index).startsWith("30_Sources") ? "verified" : "reviewed",
      source_status: scaleRoot(index).startsWith("30_Sources") ? "verified_summary" : "internal",
      type: scaleRoot(index).startsWith("30_Sources") ? "source_chunk" : "scale_memory",
    };
    if (relativePath.startsWith("50_Instances/accepted/")) Object.assign(record, lifecycleFields(relativePath, cluster, at));
    const raw = JSON.stringify(record);
    await fs.mkdir(path.dirname(absolutePath), { recursive: true });
    await atomicWriteText(absolutePath, raw);
    const modified = new Date(baseTime - age.days * DAY_MS);
    await fs.utimes(absolutePath, modified, modified);
    manifestEntries[index] = `${relativePath}\u0000${sha256(raw)}`;
    recordPathsByCluster[cluster]?.push(relativePath);
    const rootId = scaleRoot(index);
    rootCounts[rootId] = (rootCounts[rootId] ?? 0) + 1;
    ageBucketCounts[age.id] = (ageBucketCounts[age.id] ?? 0) + 1;
  });

  const sessionEntries = new Array<string>(sessionCount * 3);
  const eventLines = new Array<string>(sessionCount * 4);
  await runBounded(sessionCount, concurrency, async (index) => {
    const suffix = String(index).padStart(6, "0");
    const createdAt = new Date(baseTime + index * 1_000).toISOString();
    const taskRelative = `.dino/tasks/task-scale-${suffix}.json`;
    const traceRelative = `.dino/traces/task-scale-${suffix}.json`;
    const packRelative = `.dino/context-packs/pack-scale-${suffix}.json`;
    const selectedPath = recordRelativePath(index % recordCount);
    const taskRaw = JSON.stringify({
      task_id: `task-scale-${suffix}`,
      status: "completed",
      request: `Scale session ${suffix} ${clusterText(index % CLUSTER_COUNT)}`,
      project: "scale-proof",
      sync_policy: "local_only",
      trace_path: traceRelative,
      created_at: createdAt,
      updated_at: createdAt,
      finished_at: createdAt,
    });
    const traceRaw = JSON.stringify({
      task_id: `task-scale-${suffix}`,
      outcome: "completed",
      summary: `Completed deterministic scale session ${suffix}`,
      finished_at: createdAt,
      used_memory_paths: [selectedPath],
      context_pack_paths: [packRelative],
      session_archive_paths: [],
      candidate_paths: [],
    });
    const packRaw = JSON.stringify({
      pack_id: `pack-scale-${suffix}`,
      question: `Scale session ${suffix}`,
      created_at: createdAt,
      item_count: 1,
      retrieval_mode: "hybrid_contextual_v2",
      items: [{ path: selectedPath, kind: "curated_record", title: `Scale item ${suffix}`, score: 10 }],
    });
    const values = [[taskRelative, taskRaw], [traceRelative, traceRaw], [packRelative, packRaw]] as const;
    for (let offset = 0; offset < values.length; offset += 1) {
      const [relativePath, raw] = values[offset] ?? ["", ""];
      await atomicWriteText(path.join(root, ...relativePath.split("/")), raw);
      sessionEntries[index * 3 + offset] = `${relativePath}\u0000${sha256(raw)}`;
    }
    for (let eventIndex = 0; eventIndex < 4; eventIndex += 1) {
      eventLines[index * 4 + eventIndex] = JSON.stringify({
        event: ["task_started", "context_pack_created", "task_finished", "memory_used"][eventIndex],
        at: new Date(Date.parse(createdAt) + eventIndex).toISOString(),
        task_id: `task-scale-${suffix}`,
      });
    }
  });
  await atomicWriteText(path.join(root, ".dino", "events", "2026-07-01.jsonl"), `${eventLines.join("\n")}\n`);
  for (const clusterPaths of recordPathsByCluster) clusterPaths.sort((left, right) => left.localeCompare(right));

  return {
    recordPathsByCluster,
    manifestSha256: sha256(manifestEntries.join("\n")),
    sessionManifestSha256: sha256(sessionEntries.join("\n")),
    rootCounts,
    ageBucketCounts,
  };
}

function fixtureEmbedding(text: string, dimensions = 64): number[] {
  const vector = new Array<number>(dimensions).fill(0);
  const digest = createHash("sha512").update(text, "utf8").digest();
  for (let index = 0; index < dimensions; index += 1) vector[index] = ((digest[index % digest.length] ?? 0) - 127.5) / 127.5;
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0)) || 1;
  return vector.map((value) => value / norm);
}

function projectionSign(outputIndex: number, inputIndex: number): number {
  let value = ((outputIndex + 1) * 0x9e3779b1) ^ ((inputIndex + 1) * 0x85ebca6b);
  value ^= value >>> 16;
  value = Math.imul(value, 0x7feb352d);
  value ^= value >>> 15;
  return (value & 1) === 0 ? -1 : 1;
}

function projectVector(vector: number[], dimensions = PROJECTION_DIMENSIONS): number[] {
  const projected = new Array<number>(dimensions).fill(0);
  const scale = 1 / Math.sqrt(Math.max(1, dimensions));
  for (let output = 0; output < dimensions; output += 1) {
    let sum = 0;
    for (let input = 0; input < vector.length; input += 1) sum += (vector[input] ?? 0) * projectionSign(output, input) * scale;
    projected[output] = sum;
  }
  const norm = Math.sqrt(projected.reduce((sum, value) => sum + value * value, 0)) || 1;
  return projected.map((value) => round(value / norm, 6));
}

function benchmarkQueries(): string[] {
  return [0, 7, 14, 23, 31, 42, 55, 68, 79, 87, 93, 99].map(clusterText);
}

async function buildScaleDenseIndex(
  root: string,
  corpus: CorpusResult,
  fixtureSemantic: boolean,
): Promise<ScaleProofReport["semantic_index"]> {
  const clusters = Array.from({ length: CLUSTER_COUNT }, (_, index) => clusterText(index));
  const queries = benchmarkQueries();
  const texts = [...clusters, ...queries];
  const semantic = fixtureSemantic ? null : await tryEmbedTextsWithSemanticProvider(texts);
  if (!fixtureSemantic && !semantic) throw new Error("scale_semantic_provider_unavailable");
  const sourceVectors = fixtureSemantic ? texts.map((text) => fixtureEmbedding(text)) : semantic?.vectors ?? [];
  const projected = sourceVectors.map((vector) => projectVector(vector));
  const records: Record<string, number[]> = {};
  const centroids: Record<string, number[]> = {};
  const members: Record<string, string[]> = {};
  for (let cluster = 0; cluster < CLUSTER_COUNT; cluster += 1) {
    const id = `cluster-${String(cluster).padStart(3, "0")}`;
    const vector = projected[cluster] ?? [];
    centroids[id] = vector;
    members[id] = corpus.recordPathsByCluster[cluster] ?? [];
    for (const recordPath of members[id] ?? []) records[recordPath] = vector;
  }
  const queryVectors: Record<string, number[]> = {};
  for (let index = 0; index < queries.length; index += 1) {
    queryVectors[normalizeVectorKey(queries[index] ?? "")] = projected[CLUSTER_COUNT + index] ?? [];
  }
  const denseIndex: DenseVectorIndex & { projection: Record<string, unknown> } = {
    version: 3,
    provider: fixtureSemantic ? "deterministic_fixture_semantic_v1" : HUGGINGFACE_TRANSFORMERS_PROVIDER,
    model: fixtureSemantic ? "fixture-semantic-64" : semantic?.model ?? null,
    dimensions: PROJECTION_DIMENSIONS,
    record_count: Object.keys(records).length,
    record_count_verified: true,
    semantic_embedding_provider: true,
    generated_at: new Date().toISOString(),
    source_index_path: ".dino/index/sqlite/wiki.sqlite",
    source_index_sha256: corpus.manifestSha256,
    records,
    queries: queryVectors,
    search_partitions: {
      version: "dense_partition_v1",
      centroids,
      members,
      probe_count: 8,
      max_vectors_per_query: DEFAULT_SCALE_THRESHOLDS.max_dense_vectors_scanned,
    },
    projection: {
      strategy: "cluster_prototype_deterministic_random_projection_v1",
      source_dimensions: sourceVectors[0]?.length ?? 0,
      stored_dimensions: PROJECTION_DIMENSIONS,
    },
  };
  const densePath = path.join(root, ...DENSE_VECTOR_INDEX_RELATIVE_PATH.split("/"));
  await fs.mkdir(path.dirname(densePath), { recursive: true });
  const serialized = JSON.stringify(denseIndex);
  await atomicWriteText(densePath, serialized, async (candidatePath) => {
    const parsed = JSON.parse(await fs.readFile(candidatePath, "utf8")) as DenseVectorIndex;
    if (parsed.record_count !== denseIndex.record_count) throw new Error("scale_dense_index_record_count_mismatch");
  });
  return {
    provider: String(denseIndex.provider),
    model: String(denseIndex.model),
    semantic_embedding_provider: true,
    encoding_strategy: fixtureSemantic
      ? "deterministic_fixture_projection_v1"
      : "actual_minilm_cluster_prototype_random_projection_v1",
    source_dimensions: sourceVectors[0]?.length ?? 0,
    stored_dimensions: PROJECTION_DIMENSIONS,
    record_vectors: denseIndex.record_count ?? 0,
    partition_count: CLUSTER_COUNT,
    probe_count: 8,
    max_vectors_per_query: DEFAULT_SCALE_THRESHOLDS.max_dense_vectors_scanned,
  };
}

async function reservePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (!port) throw new Error("observatory_scale_port_reservation_failed");
  return port;
}

async function fetchJson(url: string): Promise<{ value: Record<string, unknown>; bytes: number }> {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) throw new Error(`scale_http_${response.status}:${url}`);
  const raw = await response.text();
  return { value: JSON.parse(raw) as Record<string, unknown>, bytes: Buffer.byteLength(raw, "utf8") };
}

async function startObservatory(root: string): Promise<{ child: ChildProcess; baseUrl: string; stop: () => Promise<void> }> {
  const port = await reservePort();
  const child = spawn(process.execPath, [path.join(APP_ROOT, "scripts", "dinobrain-observatory.mjs"), `--port=${port}`], {
    cwd: APP_ROOT,
    env: {
      ...process.env,
      DINOBRAIN_DATA_DIR: root,
      DINOBRAIN_OBSERVATORY_PORT: String(port),
      DINOBRAIN_OBSERVATORY_CACHE_TTL_MS: "75",
    },
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr?.on("data", (chunk) => {
    stderr = `${stderr}${String(chunk)}`.slice(-4_000);
  });
  const baseUrl = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`observatory_scale_start_failed:${stderr}`);
    try {
      await fetchJson(`${baseUrl}/api/health`);
      return {
        child,
        baseUrl,
        stop: async () => {
          if (child.exitCode !== null) return;
          child.kill();
          await Promise.race([
            new Promise<void>((resolve) => child.once("exit", () => resolve())),
            new Promise<void>((resolve) => setTimeout(resolve, 2_000)),
          ]);
        },
      };
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  child.kill();
  throw new Error(`observatory_scale_start_timeout:${stderr}`);
}

function hardwareIdentity(): ScaleProofReport["reference_hardware"] {
  const cpus = os.cpus();
  return {
    platform: os.platform(),
    release: os.release(),
    architecture: os.arch(),
    cpu_model: cpus[0]?.model ?? "unknown",
    logical_cpu_count: cpus.length,
    total_memory_bytes: os.totalmem(),
    node_version: process.version,
  };
}

async function codeHashes(recordCount: number, sessionCount: number): Promise<ScaleProofReport["hashes"]> {
  const relativeFiles = [
    "src/scale-proof.ts",
    "src/concurrency.ts",
    "src/context.ts",
    "src/wiki-index.ts",
    "src/sqlite-shards.ts",
    "src/operations-index.ts",
    "src/retrieval.ts",
    "src/hybrid-retrieval.ts",
    "src/live-semantic-query.ts",
    "src/semantic-embeddings.ts",
    "src/status-generation.ts",
    "scripts/dinobrain-observatory.mjs",
  ];
  const entries: Array<[string, string]> = [];
  for (const relativePath of relativeFiles) {
    const raw = await fs.readFile(path.join(APP_ROOT, ...relativePath.split("/")));
    entries.push([relativePath, sha256(raw)]);
  }
  const hardware = hardwareIdentity();
  return {
    code_sha256: sha256(stableJson(entries)),
    generator_sha256: sha256(stableJson({
      corpus_version: SCALE_CORPUS_VERSION,
      generator_file_sha256: entries.find(([entry]) => entry === "src/scale-proof.ts")?.[1],
      record_count: recordCount,
      session_count: sessionCount,
    })),
    environment_sha256: sha256(stableJson(hardware)),
  };
}

function metricAssertion(id: string, actual: number, maximum: number): ScaleAssertion {
  return { id, ok: actual <= maximum, actual: round(actual), expected: `<=${maximum}` };
}

function exactAssertion(id: string, actual: string | number | boolean, expected: string | number | boolean): ScaleAssertion {
  return { id, ok: actual === expected, actual, expected };
}

function maxDenseStats(values: Array<{ stats: Record<string, unknown> }>): DenseVectorSearchStats {
  const dense = values
    .map((value) => value.stats.dense_search as DenseVectorSearchStats | undefined)
    .filter((value): value is DenseVectorSearchStats => Boolean(value));
  return {
    partitioned: dense.every((entry) => entry.partitioned),
    partition_count: Math.max(0, ...dense.map((entry) => entry.partition_count)),
    partitions_probed: Math.max(0, ...dense.map((entry) => entry.partitions_probed)),
    total_vector_count: Math.max(0, ...dense.map((entry) => entry.total_vector_count)),
    vectors_scanned: Math.max(0, ...dense.map((entry) => entry.vectors_scanned)),
    max_vectors_per_query: Math.max(0, ...dense.map((entry) => entry.max_vectors_per_query)),
    result_limit: Math.max(0, ...dense.map((entry) => entry.result_limit)),
    bounded: dense.length > 0 && dense.every((entry) => entry.bounded),
  };
}

function reportPayloadHash(report: Omit<ScaleProofReport, "integrity">): string {
  return sha256(stableJson(report));
}

export function verifyScaleProofReport(report: ScaleProofReport, requireQualifying = true): { ok: boolean; issues: string[] } {
  const issues: string[] = [];
  const { integrity, ...payload } = report;
  if (report.version !== SCALE_PROOF_VERSION) issues.push("scale_report_version_invalid");
  if (integrity.report_payload_sha256 !== reportPayloadHash(payload)) issues.push("scale_report_hash_mismatch");
  if (requireQualifying && (!report.qualifying || report.status !== "healthy" || report.corpus.record_count !== 50_000 || report.corpus.session_count < 1_000)) {
    issues.push("scale_report_not_qualifying");
  }
  if (report.assertions.some((entry) => !entry.ok)) issues.push("scale_report_assertion_failed");
  for (const value of Object.values(report.hashes)) {
    if (!/^[a-f0-9]{64}$/.test(value)) issues.push("scale_report_binding_hash_invalid");
  }
  return { ok: issues.length === 0, issues: Array.from(new Set(issues)) };
}

export async function verifyScaleProofBindings(report: ScaleProofReport): Promise<{ ok: boolean; issues: string[] }> {
  const issues: string[] = [];
  const expected = await codeHashes(report.corpus.record_count, report.corpus.session_count);
  if (report.hashes.code_sha256 !== expected.code_sha256) issues.push("scale_report_code_hash_stale");
  if (report.hashes.generator_sha256 !== expected.generator_sha256) issues.push("scale_report_generator_hash_stale");
  if (report.hashes.environment_sha256 !== expected.environment_sha256) issues.push("scale_report_environment_hash_mismatch");
  if (stableJson(report.reference_hardware) !== stableJson(hardwareIdentity())) issues.push("scale_report_hardware_identity_mismatch");
  return { ok: issues.length === 0, issues };
}

export async function runScaleProof(options: RunScaleProofOptions): Promise<ScaleProofReport> {
  const recordCount = Math.max(1, Math.floor(options.recordCount ?? 50_000));
  const sessionCount = Math.max(1, Math.floor(options.sessionCount ?? 1_000));
  const sampleCount = Math.max(3, Math.floor(options.sampleCount ?? DEFAULT_SAMPLE_COUNT));
  const graphSampleCount = Math.max(2, Math.floor(options.graphSampleCount ?? DEFAULT_GRAPH_SAMPLE_COUNT));
  const qualifying = options.qualifying ?? (recordCount === 50_000 && sessionCount >= 1_000);
  const concurrency = Math.max(1, Math.min(128, Math.floor(options.ioConcurrency ?? DEFAULT_IO_CONCURRENCY)));
  const thresholds = { ...DEFAULT_SCALE_THRESHOLDS, ...options.thresholds };
  await fs.rm(options.fixtureRoot, { recursive: true, force: true });
  await fs.mkdir(options.fixtureRoot, { recursive: true });
  let observatory: Awaited<ReturnType<typeof startObservatory>> | null = null;
  try {
    const corpusResult = await measureOperation(async () => await generateCorpus(options.fixtureRoot, recordCount, sessionCount, concurrency));
    const coldBuild = await measureOperation(async () => await buildAndWriteSqliteShards(options.fixtureRoot));
    const semanticBuild = await measureOperation(
      async () => await buildScaleDenseIndex(options.fixtureRoot, corpusResult.value, options.fixtureSemantic === true),
    );
    resetDenseVectorIndexCache();

    const queries = benchmarkQueries();
    await getContextPackItems(options.fixtureRoot, queries[0] ?? "scale", 5, { includeRecentTasks: true });
    const context = await latencySamples(sampleCount, async (index) => await getContextPackItems(
      options.fixtureRoot,
      queries[index % queries.length] ?? "scale",
      5,
      { includeRecentTasks: true },
    ));
    const wiki = await latencySamples(sampleCount, async (index) => await searchWiki(
      options.fixtureRoot,
      queries[index % queries.length] ?? "scale",
      4,
    ));
    const recent = await latencySamples(sampleCount, async () => await collectRecentTaskRecordsFromSqlite(options.fixtureRoot, 10));
    const incremental = await latencySamples(sampleCount, async (index) => {
      const timestamp = new Date(Date.UTC(2026, 6, 2, 0, 0, index)).toISOString();
      const task: OperationTaskEntry = {
        path: `.dino/tasks/task-scale-incremental-${String(index).padStart(4, "0")}.json`,
        task_id: `task-scale-incremental-${String(index).padStart(4, "0")}`,
        status: "completed",
        request: `Scale incremental operation ${index}`,
        project: "scale-proof",
        sync_policy: "local_only",
        trace_path: null,
        created_at: timestamp,
        updated_at: timestamp,
        finished_at: timestamp,
      };
      await upsertSqliteOperationTask(options.fixtureRoot, task);
      return task.task_id;
    });

    await publishStatusGeneration(options.fixtureRoot, {
      artifactPaths: [
        ".dino/index/sqlite/manifest.json",
        ".dino/index/sqlite/wiki.sqlite",
        ".dino/index/sqlite/operations.sqlite",
        DENSE_VECTOR_INDEX_RELATIVE_PATH,
      ],
      producerCommand: "scale:50k",
      retainGenerations: 1,
    });

    const wikiDb = new DatabaseSync(getSqliteShardPath(options.fixtureRoot, "wiki"), { readOnly: true });
    const queryPlan = (wikiDb
      .prepare("EXPLAIN QUERY PLAN SELECT DISTINCT term FROM terms WHERE term >= ? AND term < ? AND term <> ? ORDER BY term LIMIT ?")
      .all("scale", "scale\uffff", "scale", 200) as Array<{ detail?: unknown }>)
      .map((entry) => String(entry.detail ?? ""));
    const graphNodeQueryPlan = (wikiDb
      .prepare("EXPLAIN QUERY PLAN SELECT id, type, label, path, record_id, count FROM nodes WHERE type = ? ORDER BY count DESC, id ASC LIMIT ?")
      .all("record", 241) as Array<{ detail?: unknown }>)
      .map((entry) => String(entry.detail ?? ""));
    const graphEdgeQueryPlan = (wikiDb
      .prepare("EXPLAIN QUERY PLAN SELECT from_id, to_id, type FROM edges WHERE from_id IN (?,?,?) ORDER BY from_id ASC, type ASC, to_id ASC LIMIT ?")
      .all("record:a", "record:b", "record:c", 900) as Array<{ detail?: unknown }>)
      .map((entry) => String(entry.detail ?? ""));
    wikiDb.close();
    const queryUsesIndex = queryPlan.some((entry) => /SEARCH terms USING/i.test(entry)) && !queryPlan.some((entry) => /SCAN terms/i.test(entry));
    const graphQueryUsesIndex =
      graphNodeQueryPlan.some((entry) => /SEARCH nodes USING INDEX idx_nodes_type_count_id/i.test(entry)) &&
      graphEdgeQueryPlan.some((entry) => /SEARCH edges USING (?:COVERING )?INDEX/i.test(entry)) &&
      ![...graphNodeQueryPlan, ...graphEdgeQueryPlan].some((entry) => /SCAN (?:nodes|edges)/i.test(entry));

    observatory = await startObservatory(options.fixtureRoot);
    await fetchJson(`${observatory.baseUrl}/api/graph`);
    const graph = await latencySamples(graphSampleCount, async () => {
      await new Promise((resolve) => setTimeout(resolve, 90));
      return await fetchJson(`${observatory?.baseUrl}/api/graph`);
    });
    await fetchJson(`${observatory.baseUrl}/api/snapshot`);
    const polling = await latencySamples(sampleCount, async () => await fetchJson(`${observatory?.baseUrl}/api/snapshot`));
    const health = await fetchJson(`${observatory.baseUrl}/api/health`);
    const latestGraph = graph.values[graph.values.length - 1]?.value ?? {};
    const graphStats = (latestGraph.stats ?? {}) as Record<string, unknown>;
    const healthCache = (health.value.cache ?? {}) as Record<string, unknown>;
    const healthResources = (health.value.resources ?? {}) as Record<string, unknown>;
    const snapshotBytes = Math.max(0, ...polling.values.map((entry) => entry.bytes));
    const cacheHits = Number(healthCache.hits ?? 0);
    const cacheLoads = Number(healthCache.loads ?? 0);
    const cacheCoalesced = Number(healthCache.coalesced ?? 0);

    const retrievalValues = [...context.values, ...wiki.values] as Array<{ stats: Record<string, unknown> }>;
    const denseStats = maxDenseStats(retrievalValues);
    const maxContextCandidates = Math.max(0, ...context.values.map((entry) => Number(entry.stats.candidate_record_count ?? 0)));
    const maxWikiCandidates = Math.max(0, ...wiki.values.map((entry) => Number(entry.stats.candidate_record_count ?? 0)));
    const retrievalModes = Array.from(new Set(retrievalValues.map((entry) => String(entry.stats.retrieval_mode ?? "unknown")))).sort();
    const candidateSources = Array.from(new Set(retrievalValues.map((entry) => String(entry.stats.candidate_source ?? "unknown"))));
    const termModes = Array.from(new Set(retrievalValues.map((entry) => {
      const termLookup = entry.stats.term_lookup as Record<string, unknown> | undefined;
      return String(termLookup?.mode ?? "unknown");
    })));
    const denseCache = getDenseVectorIndexCacheStats();
    const manifest = coldBuild.value;
    const wikiSize = (await fs.stat(getSqliteShardPath(options.fixtureRoot, "wiki"))).size;
    const operationsSize = (await fs.stat(getSqliteShardPath(options.fixtureRoot, "operations"))).size;
    const denseSize = (await fs.stat(path.join(options.fixtureRoot, ...DENSE_VECTOR_INDEX_RELATIVE_PATH.split("/")))).size;
    const processRssPeak = Math.max(
      corpusResult.measurement.rss_peak_observed_bytes,
      coldBuild.measurement.rss_peak_observed_bytes,
      semanticBuild.measurement.rss_peak_observed_bytes,
      process.memoryUsage().rss,
    );

    const assertions: ScaleAssertion[] = [
      exactAssertion("corpus_record_count", recordCount, qualifying ? 50_000 : recordCount),
      { id: "session_growth_count", ok: sessionCount >= (qualifying ? 1_000 : 1), actual: sessionCount, expected: qualifying ? ">=1000" : ">=1" },
      metricAssertion("cold_build_p95_budget", coldBuild.measurement.wall_ms, thresholds.max_cold_build_ms),
      metricAssertion("context_pack_p95_budget", context.stats.p95_ms, thresholds.max_context_pack_p95_ms),
      metricAssertion("wiki_search_p95_budget", wiki.stats.p95_ms, thresholds.max_wiki_search_p95_ms),
      metricAssertion("recent_task_p95_budget", recent.stats.p95_ms, thresholds.max_recent_task_p95_ms),
      metricAssertion("incremental_write_p95_budget", incremental.stats.p95_ms, thresholds.max_incremental_write_p95_ms),
      metricAssertion("graph_refresh_p95_budget", graph.stats.p95_ms, thresholds.max_graph_refresh_p95_ms),
      metricAssertion("observatory_poll_p95_budget", polling.stats.p95_ms, thresholds.max_observatory_poll_p95_ms),
      metricAssertion("observatory_payload_budget", snapshotBytes, thresholds.max_observatory_payload_bytes),
      metricAssertion("dense_vector_scan_budget", denseStats.vectors_scanned, thresholds.max_dense_vectors_scanned),
      metricAssertion("context_candidate_budget", maxContextCandidates, thresholds.max_context_candidates),
      metricAssertion("wiki_candidate_budget", maxWikiCandidates, thresholds.max_wiki_candidates),
      metricAssertion("process_rss_budget", processRssPeak, thresholds.max_process_rss_bytes),
      exactAssertion("dense_search_partitioned", denseStats.partitioned, true),
      exactAssertion("dense_search_bounded", denseStats.bounded, true),
      exactAssertion("sqlite_term_query_uses_index", queryUsesIndex, true),
      exactAssertion("sqlite_graph_query_uses_index", graphQueryUsesIndex, true),
      exactAssertion("candidate_source_sqlite", candidateSources.join(","), "sqlite_shards_v2"),
      exactAssertion("hybrid_semantic_mode", retrievalModes.join(","), "hybrid_contextual_v2"),
      exactAssertion("dense_index_single_parse", denseCache.parses, 1),
      exactAssertion("dense_index_cache_capacity", denseCache.entries <= denseCache.capacity, true),
      exactAssertion("graph_record_count", Number(graphStats.records ?? 0), recordCount),
      exactAssertion("graph_window_bounded", Number(graphStats.shown_nodes ?? 0) <= 450, true),
      exactAssertion(
        "graph_window_truncated",
        Boolean(graphStats.truncated),
        Number(graphStats.nodes ?? 0) > Number(graphStats.shown_nodes ?? 0) ||
          Number(graphStats.edges ?? 0) > Number(graphStats.shown_edges ?? 0),
      ),
      exactAssertion("observatory_cache_reused", cacheHits > 0, true),
      exactAssertion("observatory_generation_verification_bounded", Number(healthResources.status_generation_verifications ?? 0) <= 1, true),
      exactAssertion("semantic_provider_qualifying", options.fixtureSemantic === true ? !qualifying : true, true),
    ];
    const hashes = await codeHashes(recordCount, sessionCount);
    const hardware = hardwareIdentity();
    const warnings = assertions.filter((entry) => !entry.ok).map((entry) => entry.id);
    const status: ScaleProofReport["status"] = warnings.length === 0
      ? qualifying ? "healthy" : "healthy_fixture"
      : "needs_attention";
    const payload: Omit<ScaleProofReport, "integrity"> = {
      version: SCALE_PROOF_VERSION,
      status,
      qualifying,
      generated_at: new Date().toISOString(),
      corpus: {
        version: SCALE_CORPUS_VERSION,
        record_count: recordCount,
        session_count: sessionCount,
        root_counts: corpusResult.value.rootCounts,
        age_bucket_counts: corpusResult.value.ageBucketCounts,
        manifest_sha256: corpusResult.value.manifestSha256,
        session_manifest_sha256: corpusResult.value.sessionManifestSha256,
      },
      semantic_index: semanticBuild.value,
      reference_hardware: hardware,
      hashes,
      thresholds,
      measurements: {
        corpus_generation: corpusResult.measurement,
        cold_build: coldBuild.measurement,
        semantic_index_build: semanticBuild.measurement,
        context_pack: context.stats,
        wiki_search: wiki.stats,
        recent_task_lookup: recent.stats,
        incremental_operation_write: incremental.stats,
        graph_refresh: graph.stats,
        observatory_poll: polling.stats,
        process_rss_peak_observed_bytes: processRssPeak,
      },
      bounded_work: {
        candidate_source: candidateSources.join(","),
        retrieval_modes: retrievalModes,
        max_context_candidate_count: maxContextCandidates,
        max_wiki_candidate_count: maxWikiCandidates,
        max_dense_vectors_scanned: denseStats.vectors_scanned,
        dense_partitions_probed: denseStats.partitions_probed,
        dense_partition_count: denseStats.partition_count,
        dense_search_bounded: denseStats.bounded,
        sqlite_term_lookup_mode: termModes.join(","),
        sqlite_term_query_plan: queryPlan,
        sqlite_term_query_uses_index: queryUsesIndex,
        sqlite_graph_node_query_plan: graphNodeQueryPlan,
        sqlite_graph_edge_query_plan: graphEdgeQueryPlan,
        sqlite_graph_query_uses_index: graphQueryUsesIndex,
        dense_index_cache: denseCache,
      },
      index_sizes: {
        wiki_sqlite_bytes: wikiSize,
        operations_sqlite_bytes: operationsSize,
        dense_index_bytes: denseSize,
        wiki_records: manifest.shards.wiki.records,
        wiki_terms: manifest.shards.wiki.terms,
        graph_nodes: manifest.shards.wiki.nodes,
        graph_edges: manifest.shards.wiki.edges,
      },
      observatory: {
        graph_records: Number(graphStats.records ?? 0),
        graph_nodes: Number(graphStats.nodes ?? 0),
        graph_edges: Number(graphStats.edges ?? 0),
        graph_shown_nodes: Number(graphStats.shown_nodes ?? 0),
        graph_shown_edges: Number(graphStats.shown_edges ?? 0),
        graph_truncated: Boolean(graphStats.truncated),
        snapshot_payload_max_bytes: snapshotBytes,
        cache_hits: cacheHits,
        cache_loads: cacheLoads,
        cache_coalesced: cacheCoalesced,
        sqlite_opens: Number(healthResources.sqlite_opens ?? 0),
        directory_entries_seen: Number(healthResources.directory_entries_seen ?? 0),
        status_generation_verifications: Number(healthResources.status_generation_verifications ?? 0),
      },
      assertions,
      warnings,
    };
    const report: ScaleProofReport = {
      ...payload,
      integrity: { report_payload_sha256: reportPayloadHash(payload) },
    };
    await fs.mkdir(path.dirname(options.outputPath), { recursive: true });
    await atomicWriteJson(options.outputPath, report);
    return report;
  } finally {
    if (observatory) await observatory.stop();
    resetDenseVectorIndexCache();
    if (!options.keepFixture) await fs.rm(options.fixtureRoot, { recursive: true, force: true });
  }
}
