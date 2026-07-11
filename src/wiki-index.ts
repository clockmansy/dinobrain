import { promises as fs } from "node:fs";
import path from "node:path";

import { atomicWriteJson } from "./concurrency.js";
import {
  collectCuratedRecords,
  collectRecentTaskRecords,
  dataPath,
  isDefaultRetrievalExcludedPath,
  type RankedRecord,
} from "./context.js";
import {
  type RetrievalMode,
  DENSE_CANDIDATE_TOP_K_DEFAULT,
  denseVectorCandidates,
  isHighFrequencyHybridTerm,
  rankRecordsHybridV2,
  retrievalModeFor,
  tokenizeHybrid,
  type DenseVectorIndex,
} from "./hybrid-retrieval.js";
import { loadDenseVectorIndexWithLiveQuery } from "./live-semantic-query.js";

export const WIKI_INDEX_VERSION = 6;
export const WIKI_INDEX_RELATIVE_PATH = ".dino/index/wiki-index.json";

export type WikiIndexRecord = RankedRecord & {
  id: string;
  root: string;
  mtime_ms: number;
  size_bytes: number;
  tokens: string[];
  links: string[];
};

export type WikiIndexNode = {
  id: string;
  type: "record" | "root" | "folder" | "tag" | "kind" | "wikilink";
  label: string;
  path?: string;
  record_id?: string;
  count?: number;
};

export type WikiIndexEdge = {
  from: string;
  to: string;
  type: "in_root" | "in_folder" | "has_tag" | "has_kind" | "wiki_link" | "unresolved_wiki_link";
};

export type WikiIndex = {
  version: typeof WIKI_INDEX_VERSION;
  generated_at: string;
  data_root: string;
  index_path: string;
  record_count: number;
  records: WikiIndexRecord[];
  inverted_index: Record<string, string[]>;
  nodes: WikiIndexNode[];
  edges: WikiIndexEdge[];
  adjacency: Record<string, string[]>;
  hotset: {
    recent_record_ids: string[];
    cold_record_ids: string[];
  };
  stats: {
    term_count: number;
    node_count: number;
    edge_count: number;
    max_candidates_per_term: number;
  };
};

export type IndexedRetrievalStats = {
  retrieval_mode: RetrievalMode;
  candidate_source: "wiki_index_v2";
  index_path: string;
  index_record_count: number;
  candidate_record_count: number;
  total_candidate_count: number;
  matching_terms: string[];
  recent_task_count?: number;
};

type CandidateSelection = {
  records: RankedRecord[];
  totalCandidateCount: number;
  matchingTerms: string[];
};

function nowIso(): string {
  return new Date().toISOString();
}

async function mapWithConcurrency<T, R>(
  values: T[],
  concurrency: number,
  mapper: (value: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= values.length) return;
      const value = values[index];
      if (value !== undefined) results[index] = await mapper(value, index);
    }
  });
  await Promise.all(workers);
  return results;
}

function tokenizeForIndex(value: string): string[] {
  return Array.from(new Set(tokenizeHybrid(value)));
}

function normalizeWikiLink(value: string): string {
  return value
    .split("|")[0]
    .split("#")[0]
    .trim()
    .replace(/\\/g, "/");
}

function extractWikiLinks(markdown: string): string[] {
  const links = new Set<string>();
  for (const match of markdown.matchAll(/\[\[([^\]\n]+)\]\]/g)) {
    const link = normalizeWikiLink(match[1] ?? "");
    if (link) links.add(link);
  }
  return Array.from(links).sort((a, b) => a.localeCompare(b));
}

function titleKey(value: string): string {
  return value
    .toLowerCase()
    .replace(/\.[a-z0-9]+$/i, "")
    .replace(/[^\p{L}\p{N}_\/-]+/gu, "-")
    .replace(/^-+|-+$/g, "");
}

function recordRoot(relativePath: string): string {
  return relativePath.split("/")[0] ?? "";
}

function recordTokens(record: RankedRecord, links: string[]): string[] {
  return tokenizeForIndex(
    [
      record.path,
      record.title,
      record.summary,
      record.tags.join(" "),
      record.aliases.join(" "),
      record.knowledge_role,
      record.contextual_chunk,
      record.excerpt,
      links.join(" "),
    ].join(" "),
  );
}

function toRankedRecord(record: WikiIndexRecord): RankedRecord {
  return {
    path: record.path,
    kind: record.kind,
    title: record.title,
    summary: record.summary,
    tags: record.tags,
    score: 0,
    reasons: [],
    excerpt: record.excerpt,
    contextual_chunk: record.contextual_chunk,
    source_sha256: record.source_sha256,
    parent_record_path: record.parent_record_path,
    language: record.language,
    lifecycle_state: record.lifecycle_state,
    verification_status: record.verification_status,
    retrieval_lane: record.retrieval_lane,
    knowledge_role: record.knowledge_role,
    aliases: record.aliases,
    modified_at_ms: record.modified_at_ms,
  };
}

function addNode(nodes: Map<string, WikiIndexNode>, node: WikiIndexNode): void {
  const existing = nodes.get(node.id);
  if (!existing) {
    nodes.set(node.id, { ...node, count: node.count ?? 1 });
    return;
  }
  existing.count = (existing.count ?? 1) + (node.count ?? 1);
}

function addEdge(edges: Map<string, WikiIndexEdge>, edge: WikiIndexEdge): void {
  edges.set(`${edge.from}\u0000${edge.type}\u0000${edge.to}`, edge);
}

async function safeReadSmallText(filePath: string, sizeBytes: number): Promise<string> {
  if (sizeBytes > 256 * 1024) return "";
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
}

async function indexRecord(dataRoot: string, record: RankedRecord): Promise<WikiIndexRecord | null> {
  const absolutePath = dataPath(dataRoot, record.path);
  let stat: import("node:fs").Stats;
  try {
    stat = await fs.stat(absolutePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }

  const raw = await safeReadSmallText(absolutePath, stat.size);
  const links = extractWikiLinks(raw);
  return {
    ...record,
    id: record.path,
    root: recordRoot(record.path),
    mtime_ms: stat.mtimeMs,
    modified_at_ms: stat.mtimeMs,
    size_bytes: stat.size,
    tokens: recordTokens(record, links),
    links,
  };
}

function buildGraph(
  records: WikiIndexRecord[],
  options: { includeAdjacency?: boolean } = {},
): Pick<WikiIndex, "nodes" | "edges" | "adjacency"> {
  const nodes = new Map<string, WikiIndexNode>();
  const edges = new Map<string, WikiIndexEdge>();
  const titleToRecordNode = new Map<string, string>();

  for (const record of records) {
    const recordNode = `record:${record.id}`;
    titleToRecordNode.set(titleKey(record.title), recordNode);
    titleToRecordNode.set(titleKey(path.basename(record.path)), recordNode);
  }

  for (const record of records) {
    const recordNode = `record:${record.id}`;
    addNode(nodes, {
      id: recordNode,
      type: "record",
      label: record.title || path.basename(record.path),
      path: record.path,
      record_id: record.id,
    });

    const rootNode = `root:${record.root}`;
    addNode(nodes, { id: rootNode, type: "root", label: record.root });
    addEdge(edges, { from: recordNode, to: rootNode, type: "in_root" });

    const kindNode = `kind:${record.kind}`;
    addNode(nodes, { id: kindNode, type: "kind", label: record.kind });
    addEdge(edges, { from: recordNode, to: kindNode, type: "has_kind" });

    const folderParts = record.path.split("/").slice(0, -1);
    for (let depth = 1; depth <= folderParts.length; depth += 1) {
      const folderPath = folderParts.slice(0, depth).join("/");
      const folderNode = `folder:${folderPath}`;
      addNode(nodes, { id: folderNode, type: "folder", label: folderParts[depth - 1] ?? folderPath, path: folderPath });
      addEdge(edges, { from: recordNode, to: folderNode, type: "in_folder" });
    }

    for (const tag of record.tags) {
      const cleanTag = tag.trim();
      if (!cleanTag) continue;
      const tagNode = `tag:${cleanTag.toLowerCase()}`;
      addNode(nodes, { id: tagNode, type: "tag", label: cleanTag });
      addEdge(edges, { from: recordNode, to: tagNode, type: "has_tag" });
    }

    for (const link of record.links) {
      const resolved = titleToRecordNode.get(titleKey(link));
      if (resolved) {
        addEdge(edges, { from: recordNode, to: resolved, type: "wiki_link" });
        continue;
      }
      const linkNode = `wikilink:${link}`;
      addNode(nodes, { id: linkNode, type: "wikilink", label: link });
      addEdge(edges, { from: recordNode, to: linkNode, type: "unresolved_wiki_link" });
    }
  }

  const adjacency: Record<string, string[]> = {};
  if (options.includeAdjacency !== false) {
    const adjacencyMap = new Map<string, Set<string>>();
    for (const edge of edges.values()) {
      if (!adjacencyMap.has(edge.from)) adjacencyMap.set(edge.from, new Set<string>());
      if (!adjacencyMap.has(edge.to)) adjacencyMap.set(edge.to, new Set<string>());
      adjacencyMap.get(edge.from)?.add(edge.to);
      adjacencyMap.get(edge.to)?.add(edge.from);
    }
    for (const [nodeId, neighbors] of adjacencyMap) {
      adjacency[nodeId] = Array.from(neighbors).sort((a, b) => a.localeCompare(b));
    }
  }

  return {
    nodes: Array.from(nodes.values()).sort((a, b) => a.id.localeCompare(b.id)),
    edges: Array.from(edges.values()).sort(
      (a, b) => a.from.localeCompare(b.from) || a.type.localeCompare(b.type) || a.to.localeCompare(b.to),
    ),
    adjacency,
  };
}

function buildInvertedIndex(records: WikiIndexRecord[]): Record<string, string[]> {
  const terms = new Map<string, Set<string>>();
  for (const record of records) {
    for (const token of record.tokens) {
      if (!terms.has(token)) terms.set(token, new Set<string>());
      terms.get(token)?.add(record.id);
    }
  }

  const invertedIndex: Record<string, string[]> = {};
  for (const [term, recordIds] of Array.from(terms.entries()).sort(([a], [b]) => a.localeCompare(b))) {
    if (isHighFrequencyHybridTerm(records.length, recordIds.size)) continue;
    invertedIndex[term] = Array.from(recordIds).sort((a, b) => a.localeCompare(b));
  }
  return invertedIndex;
}

function matchingIndexTerms(index: WikiIndex, queryTerm: string): string[] {
  const exact = index.inverted_index[queryTerm] ? [queryTerm] : [];
  const related = Object.keys(index.inverted_index)
    .filter((term) => term !== queryTerm && term.includes(queryTerm))
    .slice(0, 200);
  return [...exact, ...related];
}

function selectCandidates(index: WikiIndex, query: string, limit: number): CandidateSelection {
  const queryTerms = tokenizeForIndex(query);
  const scoreByRecordId = new Map<string, number>();
  const matchedTerms = new Set<string>();
  const recordById = new Map(index.records.map((record) => [record.id, record]));

  for (const queryTerm of queryTerms) {
    const matchingTerms = matchingIndexTerms(index, queryTerm);
    for (const matchingTerm of matchingTerms) {
      const recordIds = index.inverted_index[matchingTerm] ?? [];
      if (recordIds.length === 0) continue;
      matchedTerms.add(matchingTerm);
      const weight = matchingTerm === queryTerm ? 3 : 1;
      for (const recordId of recordIds) {
        scoreByRecordId.set(recordId, (scoreByRecordId.get(recordId) ?? 0) + weight);
      }
    }
  }

  const selected = Array.from(scoreByRecordId.entries())
    .sort((a, b) => {
      const scoreDelta = b[1] - a[1];
      if (scoreDelta !== 0) return scoreDelta;
      const aRecord = recordById.get(a[0]);
      const bRecord = recordById.get(b[0]);
      return (bRecord?.mtime_ms ?? 0) - (aRecord?.mtime_ms ?? 0);
    })
    .slice(0, limit)
    .map(([recordId]) => recordById.get(recordId))
    .filter((record): record is WikiIndexRecord => Boolean(record))
    .filter((record) => !isDefaultRetrievalExcludedPath(record.path))
    .map(toRankedRecord);

  return {
    records: selected,
    totalCandidateCount: scoreByRecordId.size,
    matchingTerms: Array.from(matchedTerms).sort((a, b) => a.localeCompare(b)),
  };
}

function mergeDenseVectorCandidates(
  index: WikiIndex,
  selected: RankedRecord[],
  query: string,
  denseVectorIndex: DenseVectorIndex | null,
  limit: number,
): RankedRecord[] {
  const denseCandidates = denseVectorCandidates(denseVectorIndex, query, Math.min(limit, DENSE_CANDIDATE_TOP_K_DEFAULT));
  if (denseCandidates.length === 0) return selected;
  const selectedPaths = new Set(selected.map((record) => record.path));
  const recordsByPath = new Map(index.records.map((record) => [record.path, record]));
  const denseRecords = denseCandidates
    .map((candidate) => recordsByPath.get(candidate.path))
    .filter((record): record is WikiIndexRecord => Boolean(record))
    .filter((record) => !selectedPaths.has(record.path) && !isDefaultRetrievalExcludedPath(record.path))
    .map(toRankedRecord);
  return [...selected, ...denseRecords];
}

export function getWikiIndexPath(dataRoot: string): string {
  return dataPath(dataRoot, ...WIKI_INDEX_RELATIVE_PATH.split("/"));
}

export async function readWikiIndex(dataRoot: string): Promise<WikiIndex | null> {
  const indexPath = getWikiIndexPath(dataRoot);
  try {
    const parsed = JSON.parse(await fs.readFile(indexPath, "utf8")) as WikiIndex;
    if (parsed.version !== WIKI_INDEX_VERSION) return null;
    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function buildWikiIndex(
  dataRoot: string,
  options: { includeAdjacency?: boolean; includeColdHotset?: boolean } = {},
): Promise<WikiIndex> {
  const curatedRecords = await collectCuratedRecords(dataRoot);
  const configuredConcurrency = Number(process.env.DINOBRAIN_INDEX_READ_CONCURRENCY ?? 64);
  const concurrency = Number.isFinite(configuredConcurrency)
    ? Math.max(1, Math.min(128, Math.floor(configuredConcurrency)))
    : 64;
  const records = (await mapWithConcurrency(
    curatedRecords,
    concurrency,
    async (record) => await indexRecord(dataRoot, record),
  )).filter((record): record is WikiIndexRecord => Boolean(record));
  records.sort((a, b) => a.path.localeCompare(b.path));

  const invertedIndex = buildInvertedIndex(records);
  const graph = buildGraph(records, options);
  const recentRecordIds = [...records]
    .sort((a, b) => b.mtime_ms - a.mtime_ms)
    .slice(0, 50)
    .map((record) => record.id);
  const hotset = new Set(recentRecordIds);
  const coldRecordIds = options.includeColdHotset === false
    ? []
    : records.filter((record) => !hotset.has(record.id)).map((record) => record.id);

  let maxCandidatesPerTerm = 0;
  for (const recordIds of Object.values(invertedIndex)) {
    maxCandidatesPerTerm = Math.max(maxCandidatesPerTerm, recordIds.length);
  }

  return {
    version: WIKI_INDEX_VERSION,
    generated_at: nowIso(),
    data_root: path.resolve(dataRoot),
    index_path: WIKI_INDEX_RELATIVE_PATH,
    record_count: records.length,
    records,
    inverted_index: invertedIndex,
    ...graph,
    hotset: {
      recent_record_ids: recentRecordIds,
      cold_record_ids: coldRecordIds,
    },
    stats: {
      term_count: Object.keys(invertedIndex).length,
      node_count: graph.nodes.length,
      edge_count: graph.edges.length,
      max_candidates_per_term: maxCandidatesPerTerm,
    },
  };
}

export async function writeWikiIndex(dataRoot: string, index: WikiIndex): Promise<string> {
  const indexPath = getWikiIndexPath(dataRoot);
  await atomicWriteJson(indexPath, index);
  return indexPath;
}

export async function buildAndWriteWikiIndex(dataRoot: string): Promise<WikiIndex> {
  const index = await buildWikiIndex(dataRoot);
  await writeWikiIndex(dataRoot, index);
  return index;
}

export async function ensureWikiIndex(dataRoot: string): Promise<WikiIndex> {
  const existing = await readWikiIndex(dataRoot);
  if (existing) return existing;
  return await buildAndWriteWikiIndex(dataRoot);
}

export async function invalidateWikiIndex(dataRoot: string): Promise<boolean> {
  try {
    await fs.unlink(getWikiIndexPath(dataRoot));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export async function queryIndexedWiki(
  dataRoot: string,
  query: string,
  limit: number,
): Promise<{ records: RankedRecord[]; ranked: RankedRecord[]; stats: IndexedRetrievalStats }> {
  const index = await ensureWikiIndex(dataRoot);
  const candidateLimit = Math.max(limit * 25, 100);
  const candidates = selectCandidates(index, query, candidateLimit);
  const { index: denseVectorIndex } = await loadDenseVectorIndexWithLiveQuery(dataRoot, query);
  const records = mergeDenseVectorCandidates(index, candidates.records, query, denseVectorIndex, candidateLimit);
  const ranked = rankRecordsHybridV2(records, query, { limit, denseVectorIndex });
  return {
    records,
    ranked,
    stats: {
      retrieval_mode: retrievalModeFor(records, query, denseVectorIndex),
      candidate_source: "wiki_index_v2",
      index_path: WIKI_INDEX_RELATIVE_PATH,
      index_record_count: index.record_count,
      candidate_record_count: records.length,
      total_candidate_count: candidates.totalCandidateCount,
      matching_terms: candidates.matchingTerms,
    },
  };
}

export async function getIndexedPackItems(
  dataRoot: string,
  question: string,
  limit: number,
  options: { includeRecentTasks?: boolean } = {},
): Promise<{ records: RankedRecord[]; ranked: RankedRecord[]; stats: IndexedRetrievalStats }> {
  const index = await ensureWikiIndex(dataRoot);
  const candidateLimit = Math.min(index.record_count, Math.max(limit * 80, 400));
  const candidates = selectCandidates(index, question, candidateLimit);
  const recentTasks = options.includeRecentTasks === false ? [] : await collectRecentTaskRecords(dataRoot, 10);
  const { index: denseVectorIndex } = await loadDenseVectorIndexWithLiveQuery(dataRoot, question);
  const selectedRecords = mergeDenseVectorCandidates(index, candidates.records, question, denseVectorIndex, candidateLimit);
  const records = [...selectedRecords, ...recentTasks];
  const ranked = rankRecordsHybridV2(records, question, { limit, denseVectorIndex, contextPackBudget: true });
  return {
    records,
    ranked,
    stats: {
      retrieval_mode: retrievalModeFor(records, question, denseVectorIndex),
      candidate_source: "wiki_index_v2",
      index_path: WIKI_INDEX_RELATIVE_PATH,
      index_record_count: index.record_count,
      candidate_record_count: records.length,
      total_candidate_count: candidates.totalCandidateCount + recentTasks.length,
      matching_terms: candidates.matchingTerms,
      recent_task_count: recentTasks.length,
    },
  };
}
