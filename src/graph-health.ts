import { promises as fs } from "node:fs";
import path from "node:path";

import { atomicWriteJson } from "./concurrency.js";
import { dataPath, relDataPath } from "./context.js";
import { ensureWikiIndex, type WikiIndex } from "./wiki-index.js";

export const GRAPH_HEALTH_VERSION = "graph_health_v1";
export const GRAPH_HEALTH_RELATIVE_PATH = ".dino/index/graph-health.json";

export type GraphHealthStatus = "healthy" | "warning" | "degraded" | "index_error";

export type GraphHealth = {
  version: typeof GRAPH_HEALTH_VERSION;
  status: GraphHealthStatus;
  score: number;
  generated_at: string;
  data_root: string;
  index_path: string | null;
  indexed_record_count: number;
  node_count: number;
  edge_count: number;
  unresolved_wiki_link_count: number;
  referenced_unresolved_wiki_link_count: number;
  curated_paths_checked: number;
  curated_paths_missing_from_index: string[];
  referenced_paths_missing_on_disk: string[];
  accepted_instance_count: number;
  candidate_instance_count: number;
  promotion_review_count: number;
  quarantine_count: number;
  accepted_without_source_count: number;
  accepted_missing_source_count: number;
  candidate_without_review_count: number;
  source_mapping_missing_count: number;
  warnings: string[];
};

type JsonObject = Record<string, unknown>;

type GraphHealthOptions = {
  referencedPaths?: string[];
  now?: Date;
};

function nowIso(date: Date): string {
  return date.toISOString();
}

function cap<T>(values: T[], limit = 50): T[] {
  return values.slice(0, limit);
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values)).filter(Boolean).sort((a, b) => a.localeCompare(b));
}

function normalizeVaultPath(dataRoot: string, value: string): string {
  const normalized = value.replace(/\\/g, "/").replace(/^\/+/, "").trim();
  if (!normalized) return "";
  dataPath(dataRoot, normalized);
  return normalized;
}

function normalizeVaultPaths(dataRoot: string, values: string[]): string[] {
  return unique(values.map((value) => normalizeVaultPath(dataRoot, value)));
}

function isCuratedPath(vaultPath: string): boolean {
  return [
    "00_Home/",
    "20_Wiki/",
    "30_Sources/",
    "40_Projects/",
    "50_Instances/accepted/",
    "60_Operations/",
    "70_Error_Book/",
  ].some((prefix) => vaultPath.startsWith(prefix));
}

async function readJson<T>(filePath: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function readJsonDir(dataRoot: string, relativeDir: string): Promise<Array<{ path: string; record: JsonObject }>> {
  const dir = dataPath(dataRoot, relativeDir);
  let entries: Array<import("node:fs").Dirent>;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }

  const records: Array<{ path: string; record: JsonObject }> = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const filePath = path.join(dir, entry.name);
    const record = await readJson<JsonObject>(filePath);
    if (record) records.push({ path: relDataPath(dataRoot, filePath), record });
  }
  return records.sort((a, b) => a.path.localeCompare(b.path));
}

async function pathExists(dataRoot: string, vaultPath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(dataPath(dataRoot, vaultPath));
    return stat.isFile() || stat.isDirectory();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function firstString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return "";
}

function stringsFrom(value: unknown): string[] {
  if (typeof value === "string" && value.trim()) return [value.trim()];
  if (Array.isArray(value)) return value.flatMap(stringsFrom);
  return [];
}

function sourcePaths(record: JsonObject): string[] {
  const evidence = record.evidence && typeof record.evidence === "object" ? (record.evidence as JsonObject) : {};
  const source = record.source && typeof record.source === "object" ? (record.source as JsonObject) : {};
  return unique([
    firstString(record.source_candidate_path),
    firstString(record.source_path),
    firstString(record.evidence_source),
    ...stringsFrom(record.source_paths),
    firstString(evidence.source),
    firstString(source.trace_path),
    firstString(source.task_path),
    firstString(record.source_operation_path),
  ]);
}

async function lifecycleHealth(dataRoot: string): Promise<{
  acceptedInstanceCount: number;
  candidateInstanceCount: number;
  promotionReviewCount: number;
  quarantineCount: number;
  acceptedWithoutSourceCount: number;
  acceptedMissingSourceCount: number;
  candidateWithoutReviewCount: number;
}> {
  const [accepted, candidates, reviews, quarantines] = await Promise.all([
    readJsonDir(dataRoot, "50_Instances/accepted"),
    readJsonDir(dataRoot, "50_Instances/candidates"),
    readJsonDir(dataRoot, "80_Review_Queue/promotion"),
    readJsonDir(dataRoot, ".dino/quarantine"),
  ]);

  const acceptedWithoutSource = accepted.filter((entry) => sourcePaths(entry.record).length === 0);
  const acceptedWithMissingSource = (
    await Promise.all(
      accepted.map(async (entry) => {
        const sources = sourcePaths(entry.record);
        if (sources.length === 0) return null;
        const existence = await Promise.all(sources.map((source) => pathExists(dataRoot, source)));
        return existence.some(Boolean) ? null : entry.path;
      }),
    )
  ).filter((entry): entry is string => Boolean(entry));
  const reviewIds = new Set(reviews.map((entry) => path.basename(entry.path, ".json")));
  const candidatesWithoutReview = candidates.filter((entry) => !reviewIds.has(path.basename(entry.path, ".json")));

  return {
    acceptedInstanceCount: accepted.length,
    candidateInstanceCount: candidates.length,
    promotionReviewCount: reviews.length,
    quarantineCount: quarantines.length,
    acceptedWithoutSourceCount: acceptedWithoutSource.length,
    acceptedMissingSourceCount: acceptedWithMissingSource.length,
    candidateWithoutReviewCount: candidatesWithoutReview.length,
  };
}

function statusFromScore(score: number): GraphHealthStatus {
  if (score >= 85) return "healthy";
  if (score >= 70) return "warning";
  return "degraded";
}

function graphScore(params: {
  index: WikiIndex;
  missingFromIndex: string[];
  missingOnDisk: string[];
  referencedUnresolved: number;
  acceptedWithoutSource: number;
  acceptedMissingSource: number;
  candidateWithoutReview: number;
}): number {
  const emptyPenalty = params.index.record_count === 0 ? 35 : 0;
  const unresolvedPenalty = Math.min(20, params.referencedUnresolved);
  const lineagePenalty = params.acceptedWithoutSource * 8 + params.acceptedMissingSource * 10;
  const reviewPenalty = params.candidateWithoutReview * 5;
  const totalPenalty =
    emptyPenalty +
    params.missingFromIndex.length * 12 +
    params.missingOnDisk.length * 10 +
    unresolvedPenalty +
    lineagePenalty +
    reviewPenalty;
  return Math.max(0, Math.min(100, 100 - totalPenalty));
}

function warningsFor(health: Omit<GraphHealth, "warnings">): string[] {
  const warnings: string[] = [];
  if (health.indexed_record_count === 0) warnings.push("wiki_index_empty");
  if (health.curated_paths_missing_from_index.length > 0) warnings.push("curated_path_missing_from_index");
  if (health.referenced_paths_missing_on_disk.length > 0) warnings.push("referenced_path_missing_on_disk");
  if (health.referenced_unresolved_wiki_link_count > 0) warnings.push("referenced_unresolved_wiki_link");
  if (health.accepted_without_source_count > 0) warnings.push("accepted_instance_source_mapping_missing");
  if (health.accepted_missing_source_count > 0) warnings.push("accepted_instance_source_file_missing");
  if (health.candidate_without_review_count > 0) warnings.push("candidate_review_mapping_missing");
  return warnings;
}

export function getGraphHealthPath(dataRoot: string): string {
  return dataPath(dataRoot, ...GRAPH_HEALTH_RELATIVE_PATH.split("/"));
}

export async function buildGraphHealth(dataRoot: string, options: GraphHealthOptions = {}): Promise<GraphHealth> {
  const generatedAt = nowIso(options.now ?? new Date());
  const referencedPaths = normalizeVaultPaths(dataRoot, options.referencedPaths ?? []);
  const missingOnDisk: string[] = [];
  for (const referencedPath of referencedPaths) {
    if (!(await pathExists(dataRoot, referencedPath))) missingOnDisk.push(referencedPath);
  }

  const lifecycle = await lifecycleHealth(dataRoot);
  const base = {
    version: GRAPH_HEALTH_VERSION as typeof GRAPH_HEALTH_VERSION,
    generated_at: generatedAt,
    data_root: path.resolve(dataRoot),
    accepted_instance_count: lifecycle.acceptedInstanceCount,
    candidate_instance_count: lifecycle.candidateInstanceCount,
    promotion_review_count: lifecycle.promotionReviewCount,
    quarantine_count: lifecycle.quarantineCount,
    accepted_without_source_count: lifecycle.acceptedWithoutSourceCount,
    accepted_missing_source_count: lifecycle.acceptedMissingSourceCount,
    candidate_without_review_count: lifecycle.candidateWithoutReviewCount,
    source_mapping_missing_count: lifecycle.acceptedWithoutSourceCount + lifecycle.acceptedMissingSourceCount,
  };

  let index: WikiIndex;
  try {
    index = await ensureWikiIndex(dataRoot);
  } catch {
    const score = Math.max(
      0,
      55 -
        missingOnDisk.length * 10 -
        lifecycle.acceptedWithoutSourceCount * 8 -
        lifecycle.acceptedMissingSourceCount * 10 -
        lifecycle.candidateWithoutReviewCount * 5,
    );
    const healthWithoutWarnings = {
      ...base,
      status: "index_error" as const,
      score,
      index_path: null,
      indexed_record_count: 0,
      node_count: 0,
      edge_count: 0,
      unresolved_wiki_link_count: 0,
      referenced_unresolved_wiki_link_count: 0,
      curated_paths_checked: referencedPaths.filter(isCuratedPath).length,
      curated_paths_missing_from_index: [],
      referenced_paths_missing_on_disk: cap(missingOnDisk),
    };
    return {
      ...healthWithoutWarnings,
      warnings: ["wiki_index_error", ...warningsFor(healthWithoutWarnings)],
    };
  }

  const indexedPaths = new Set(index.records.map((record) => record.path));
  const curatedPaths = unique(referencedPaths.filter(isCuratedPath));
  const missingFromIndex = curatedPaths.filter((referencedPath) => !indexedPaths.has(referencedPath));
  const recordIdByPath = new Map(index.records.map((record) => [record.path, `record:${record.id}`]));
  const referencedRecordNodes = new Set(
    curatedPaths.map((referencedPath) => recordIdByPath.get(referencedPath)).filter((node): node is string => Boolean(node)),
  );
  const unresolvedEdges = index.edges.filter((edge) => edge.type === "unresolved_wiki_link");
  const referencedUnresolved = unresolvedEdges.filter((edge) => referencedRecordNodes.has(edge.from)).length;
  const score = graphScore({
    index,
    missingFromIndex,
    missingOnDisk,
    referencedUnresolved,
    acceptedWithoutSource: lifecycle.acceptedWithoutSourceCount,
    acceptedMissingSource: lifecycle.acceptedMissingSourceCount,
    candidateWithoutReview: lifecycle.candidateWithoutReviewCount,
  });
  const healthWithoutWarnings = {
    ...base,
    status: statusFromScore(score),
    score,
    index_path: index.index_path,
    indexed_record_count: index.record_count,
    node_count: index.stats.node_count,
    edge_count: index.stats.edge_count,
    unresolved_wiki_link_count: unresolvedEdges.length,
    referenced_unresolved_wiki_link_count: referencedUnresolved,
    curated_paths_checked: curatedPaths.length,
    curated_paths_missing_from_index: cap(missingFromIndex),
    referenced_paths_missing_on_disk: cap(missingOnDisk),
  };
  return {
    ...healthWithoutWarnings,
    warnings: warningsFor(healthWithoutWarnings),
  };
}

export async function buildAndWriteGraphHealth(
  dataRoot: string,
  options: GraphHealthOptions = {},
): Promise<{ health: GraphHealth; path: string }> {
  const health = await buildGraphHealth(dataRoot, options);
  const healthPath = getGraphHealthPath(dataRoot);
  await atomicWriteJson(healthPath, health);
  return { health, path: healthPath };
}
