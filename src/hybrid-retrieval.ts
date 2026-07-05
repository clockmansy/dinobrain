import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import type { RankedRecord } from "./context.js";

export const HYBRID_RETRIEVAL_MODE = "hybrid_contextual_v2";
export const LEXICAL_FALLBACK_RETRIEVAL_MODE = "lexical_fallback_v2";
export const DENSE_VECTOR_INDEX_RELATIVE_PATH = ".dino/index/dense-vectors.json";

export type RetrievalMode = typeof HYBRID_RETRIEVAL_MODE | typeof LEXICAL_FALLBACK_RETRIEVAL_MODE;

export type DenseVectorIndex = {
  version?: number;
  dimensions?: number;
  records?: Record<string, number[]>;
  record_vectors?: Record<string, number[]>;
  queries?: Record<string, number[]>;
  query_vectors?: Record<string, number[]>;
};

export const HYBRID_RANKING_INPUTS = [
  "chunk context",
  "BM25 sparse retrieval",
  "dense vector cosine retrieval",
  "reciprocal rank fusion",
  "provenance-aware reranking",
] as const;

export const LEXICAL_FALLBACK_RANKING_INPUTS = [
  "chunk context",
  "BM25 sparse retrieval",
  "dense-lite lexical fallback",
  "reciprocal rank fusion",
  "provenance-aware reranking",
] as const;

const STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "by",
  "for",
  "from",
  "how",
  "in",
  "is",
  "it",
  "its",
  "os",
  "of",
  "on",
  "or",
  "should",
  "system",
  "the",
  "this",
  "to",
  "use",
  "what",
  "when",
  "why",
  "with",
  "그",
  "그리고",
  "나는",
  "내가",
  "너",
  "이",
  "이거",
  "이제",
  "저",
  "좀",
  "해줘",
]);

const SHORT_TOKEN_ALLOWLIST = new Set(["ai", "ci", "db", "go", "js", "llm", "mcp", "pr", "qa", "ui", "ux", "v0", "v1", "v2", "v3"]);
const MAX_COMMON_TERM_RATIO = 0.65;
const MIN_BM25_IDF = 0.15;

type ScoredRecord = {
  record: RankedRecord;
  score: number;
  reasons: string[];
};

function unique(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)));
}

export function isMeaningfulHybridToken(term: string): boolean {
  if (!term || STOPWORDS.has(term)) return false;
  if (term.length <= 2 && !SHORT_TOKEN_ALLOWLIST.has(term)) return false;
  return true;
}

export function tokenizeHybrid(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^\p{L}\p{N}_-]+/u)
    .map((term) => term.trim())
    .filter(isMeaningfulHybridToken);
}

export function rankingInputsForMode(mode: RetrievalMode): string[] {
  return [...(mode === HYBRID_RETRIEVAL_MODE ? HYBRID_RANKING_INPUTS : LEXICAL_FALLBACK_RANKING_INPUTS)];
}

export function retrievalCaveatsForMode(mode: RetrievalMode): string[] {
  if (mode === HYBRID_RETRIEVAL_MODE) {
    return [
      "DinoBrain OS v2 uses contextual hybrid retrieval with configured dense vector cosine search.",
      "Candidate and review queue records are excluded from default packs.",
    ];
  }
  return [
    "DinoBrain OS v2 is running lexical fallback retrieval because no usable dense vector provider/index is configured for this query.",
    "Dense-lite lexical fallback is not semantic embedding search.",
    "Candidate and review queue records are excluded from default packs.",
  ];
}

function tokenSet(value: string): Set<string> {
  return new Set(tokenizeHybrid(value));
}

function charGrams(value: string, size = 3): Set<string> {
  const normalized = value.toLowerCase().replace(/\s+/g, " ").trim();
  const grams = new Set<string>();
  if (normalized.length < size) {
    if (normalized) grams.add(normalized);
    return grams;
  }
  for (let index = 0; index <= normalized.length - size; index += 1) {
    grams.add(normalized.slice(index, index + size));
  }
  return grams;
}

function jaccard(left: Set<string>, right: Set<string>): number {
  if (left.size === 0 || right.size === 0) return 0;
  let intersection = 0;
  for (const value of left) {
    if (right.has(value)) intersection += 1;
  }
  return intersection / (left.size + right.size - intersection);
}

function normalizeVectorKey(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

function vectorMap(index: DenseVectorIndex | null | undefined, key: "records" | "queries"): Record<string, number[]> {
  if (!index) return {};
  if (key === "records") return index.records ?? index.record_vectors ?? {};
  return index.queries ?? index.query_vectors ?? {};
}

function validVector(value: unknown): value is number[] {
  return Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === "number" && Number.isFinite(item));
}

function cosine(left: number[], right: number[]): number {
  const length = Math.min(left.length, right.length);
  if (length === 0) return 0;
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < length; index += 1) {
    const leftValue = left[index] ?? 0;
    const rightValue = right[index] ?? 0;
    dot += leftValue * rightValue;
    leftNorm += leftValue * leftValue;
    rightNorm += rightValue * rightValue;
  }
  if (leftNorm === 0 || rightNorm === 0) return 0;
  return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
}

function queryVector(index: DenseVectorIndex | null | undefined, query: string): number[] | null {
  const queries = vectorMap(index, "queries");
  const normalized = normalizeVectorKey(query);
  return validVector(queries[normalized]) ? queries[normalized] : validVector(queries[query]) ? queries[query] : null;
}

export function loadDenseVectorIndex(dataRoot: string): DenseVectorIndex | null {
  const configuredPath = process.env.DINOBRAIN_DENSE_VECTOR_INDEX?.trim();
  const indexPath = configuredPath
    ? path.resolve(configuredPath)
    : path.resolve(dataRoot, ...DENSE_VECTOR_INDEX_RELATIVE_PATH.split("/"));
  if (!existsSync(indexPath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(indexPath, "utf8")) as DenseVectorIndex;
    const records = vectorMap(parsed, "records");
    const queries = vectorMap(parsed, "queries");
    if (Object.keys(records).length === 0 || Object.keys(queries).length === 0) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function denseVectorAvailable(
  records: RankedRecord[],
  query: string,
  denseVectorIndex?: DenseVectorIndex | null,
): boolean {
  const qv = queryVector(denseVectorIndex, query);
  if (!qv) return false;
  const recordVectors = vectorMap(denseVectorIndex, "records");
  return records.some((record) => validVector(recordVectors[record.path]));
}

export function denseVectorCandidatePaths(
  denseVectorIndex: DenseVectorIndex | null | undefined,
  query: string,
): Set<string> {
  if (!queryVector(denseVectorIndex, query)) return new Set();
  const recordVectors = vectorMap(denseVectorIndex, "records");
  return new Set(Object.entries(recordVectors).filter(([, vector]) => validVector(vector)).map(([recordPath]) => recordPath));
}

export function retrievalModeFor(
  records: RankedRecord[],
  query: string,
  denseVectorIndex?: DenseVectorIndex | null,
): RetrievalMode {
  return denseVectorAvailable(records, query, denseVectorIndex)
    ? HYBRID_RETRIEVAL_MODE
    : LEXICAL_FALLBACK_RETRIEVAL_MODE;
}

function docFrequencyByTerm(records: RankedRecord[]): Map<string, number> {
  const docFreq = new Map<string, number>();
  for (const record of records) {
    for (const term of tokenSet(contextualText(record))) {
      docFreq.set(term, (docFreq.get(term) ?? 0) + 1);
    }
  }
  return docFreq;
}

export function isHighFrequencyHybridTerm(totalRecords: number, documentFrequency: number): boolean {
  return totalRecords >= 5 && documentFrequency / totalRecords >= MAX_COMMON_TERM_RATIO;
}

function filterQueryTermsByCorpus(records: RankedRecord[], queryTerms: string[]): string[] {
  if (records.length < 5 || queryTerms.length === 0) return queryTerms;
  const docFreq = docFrequencyByTerm(records);
  const filtered = queryTerms.filter((term) => !isHighFrequencyHybridTerm(records.length, docFreq.get(term) ?? 0));
  return filtered.length > 0 ? filtered : queryTerms;
}

function rootFor(recordPath: string): string {
  return recordPath.split("/")[0] ?? "";
}

function folderContext(recordPath: string): string {
  return recordPath
    .split("/")
    .slice(0, -1)
    .join(" ");
}

export function contextualText(record: RankedRecord): string {
  return [
    `path: ${record.path}`,
    `root: ${rootFor(record.path)}`,
    `folder: ${folderContext(record.path)}`,
    `kind: ${record.kind}`,
    `title: ${record.title}`,
    `summary: ${record.summary}`,
    `tags: ${record.tags.join(" ")}`,
    `chunk: ${record.excerpt}`,
  ]
    .filter(Boolean)
    .join("\n");
}

function phraseBonus(record: RankedRecord, query: string): number {
  const normalizedQuery = query.toLowerCase().replace(/\s+/g, " ").trim();
  if (normalizedQuery.length < 4) return 0;
  const haystack = contextualText(record).toLowerCase().replace(/\s+/g, " ");
  if (haystack.includes(normalizedQuery)) return 4;
  const title = record.title.toLowerCase();
  if (title.includes(normalizedQuery)) return 3;
  return 0;
}

function provenanceBonus(record: RankedRecord): number {
  const text = contextualText(record).toLowerCase();
  let bonus = 0;
  const hasProvenanceMetadata = /(source_uri|source_status|evidence|last_verified|confidence|provenance)/.test(text);
  if (record.path.startsWith("30_Sources/chunks/")) bonus += 2.5;
  else if (record.path.startsWith("30_Sources/") && hasProvenanceMetadata) bonus += 1.2;
  if (record.path.startsWith("50_Instances/accepted/") && hasProvenanceMetadata) bonus += 1.5;
  if (hasProvenanceMetadata) bonus += 1.2;
  if (/(pending_review|candidate|quarantine)/.test(text)) bonus -= 2;
  return bonus;
}

function rootIntentBonus(record: RankedRecord, query: string): number {
  const lower = query.toLowerCase();
  const intents: Array<[string, RegExp]> = [
    ["20_Wiki/", /\b(wiki|knowledge|curated|reusable)\b/],
    ["30_Sources/", /\b(source|sources|verification|checked|provenance|evidence)\b/],
    ["40_Projects/", /\b(project|projects|handoff|implementation|constraints|state)\b/],
    ["50_Instances/accepted/", /\b(instance|instances|accepted|confidence)\b/],
    ["60_Operations/", /\b(operation|operations|runbook|runbooks|policy|policies|maintenance|sync|vault)\b/],
    ["70_Error_Book/", /\b(error|mistake|mistakes|correction|corrections|prevention)\b/],
  ];
  const matched = intents.filter(([, pattern]) => pattern.test(lower));
  if (matched.length === 0) return 0;
  if (matched.some(([prefix]) => record.path.startsWith(prefix))) return 4.5;
  if (record.path.endsWith("/README.md")) return -12;
  return -4;
}

function fieldBonus(record: RankedRecord, queryTerms: string[]): { score: number; reasons: string[] } {
  let score = 0;
  const reasons: string[] = [];
  const fields: Array<[string, string, number]> = [
    ["path", record.path, 3],
    ["title", record.title, 5],
    ["summary", record.summary, 3],
    ["tags", record.tags.join(" "), 3],
    ["chunk", record.excerpt, 1.5],
  ];
  for (const [field, raw, weight] of fields) {
    const lower = raw.toLowerCase();
    const matches = queryTerms.filter((term) => lower.includes(term));
    if (matches.length === 0) continue;
    score += matches.length * weight;
    reasons.push(`${field}_matched:${matches.slice(0, 4).join(",")}`);
  }
  return { score, reasons };
}

function bm25Rank(records: RankedRecord[], queryTerms: string[]): ScoredRecord[] {
  if (records.length === 0 || queryTerms.length === 0) return [];
  const docs = records.map((record) => tokenizeHybrid(contextualText(record)));
  const avgLength = docs.reduce((sum, doc) => sum + doc.length, 0) / Math.max(1, docs.length);
  const docFreq = new Map<string, number>();
  for (const doc of docs) {
    for (const term of new Set(doc)) {
      docFreq.set(term, (docFreq.get(term) ?? 0) + 1);
    }
  }
  const k1 = 1.2;
  const b = 0.75;
  return records
    .map((record, index) => {
      const doc = docs[index] ?? [];
      const counts = new Map<string, number>();
      for (const term of doc) counts.set(term, (counts.get(term) ?? 0) + 1);
      let score = 0;
      const matched: string[] = [];
      for (const term of queryTerms) {
        const tf = counts.get(term) ?? 0;
        if (tf === 0) continue;
        const df = docFreq.get(term) ?? 0;
        const idf = Math.log(1 + (records.length - df + 0.5) / (df + 0.5));
        if (isHighFrequencyHybridTerm(records.length, df) || idf < MIN_BM25_IDF) continue;
        const denom = tf + k1 * (1 - b + b * (doc.length / Math.max(1, avgLength)));
        score += idf * ((tf * (k1 + 1)) / denom);
        matched.push(term);
      }
      return {
        record,
        score,
        reasons: matched.length > 0 ? [`bm25:${matched.slice(0, 5).join(",")}`] : [],
      };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.record.path.localeCompare(b.record.path));
}

function denseVectorRank(
  records: RankedRecord[],
  query: string,
  denseVectorIndex?: DenseVectorIndex | null,
): ScoredRecord[] | null {
  const qv = queryVector(denseVectorIndex, query);
  if (!qv) return null;
  const recordVectors = vectorMap(denseVectorIndex, "records");
  const ranked = records
    .map((record) => {
      const vector = recordVectors[record.path];
      if (!validVector(vector)) return null;
      const score = cosine(qv, vector) * 20;
      return {
        record,
        score,
        reasons: score > 0 ? [`dense_vector_cosine:${score.toFixed(2)}`] : [],
      };
    })
    .filter((entry): entry is ScoredRecord => entry !== null && entry.score > 0)
    .sort((a, b) => b.score - a.score || a.record.path.localeCompare(b.record.path));
  return ranked.length > 0 ? ranked : null;
}

function denseLexicalRank(records: RankedRecord[], query: string): ScoredRecord[] {
  const queryTokens = tokenSet(query);
  const queryGrams = charGrams(query);
  return records
    .map((record) => {
      const text = contextualText(record);
      const tokenScore = jaccard(queryTokens, tokenSet(text));
      const gramScore = jaccard(queryGrams, charGrams(text));
      const score = tokenScore * 12 + gramScore * 8;
      return {
        record,
        score,
        reasons: score > 0 ? [`dense_lexical:${score.toFixed(2)}`] : [],
      };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.record.path.localeCompare(b.record.path));
}

function sparseFieldRank(records: RankedRecord[], queryTerms: string[]): ScoredRecord[] {
  return records
    .map((record) => {
      const field = fieldBonus(record, queryTerms);
      return { record, score: field.score, reasons: field.reasons };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.record.path.localeCompare(b.record.path));
}

function rrf(lists: ScoredRecord[][]): Map<string, { record: RankedRecord; score: number; reasons: string[] }> {
  const fused = new Map<string, { record: RankedRecord; score: number; reasons: string[] }>();
  const k = 60;
  for (const list of lists) {
    list.forEach((entry, index) => {
      const current = fused.get(entry.record.path) ?? { record: entry.record, score: 0, reasons: [] };
      current.score += 1 / (k + index + 1);
      current.reasons.push(...entry.reasons);
      fused.set(entry.record.path, current);
    });
  }
  return fused;
}

export function rankRecordsHybridV2(
  records: RankedRecord[],
  query: string,
  options: { limit?: number; denseVectorIndex?: DenseVectorIndex | null } = {},
): RankedRecord[] {
  const queryTerms = filterQueryTermsByCorpus(records, unique(tokenizeHybrid(query)));
  const sparse = sparseFieldRank(records, queryTerms);
  const bm25 = bm25Rank(records, queryTerms);
  const dense = denseVectorRank(records, query, options.denseVectorIndex) ?? denseLexicalRank(records, query);
  const fused = rrf([sparse, bm25, dense]);

  for (const record of records) {
    if (fused.has(record.path)) continue;
    const score = phraseBonus(record, query) + provenanceBonus(record);
    if (score > 0) fused.set(record.path, { record, score: score / 100, reasons: ["rerank_prior"] });
  }

  const ranked = Array.from(fused.values())
    .map((entry) => {
      const phrase = phraseBonus(entry.record, query);
      const provenance = provenanceBonus(entry.record);
      const rootIntent = rootIntentBonus(entry.record, query);
      const finalScore = entry.score * 100 + phrase + provenance + rootIntent;
      const reasons = unique([
        ...entry.reasons,
        "rank_fusion:rrf",
        phrase > 0 ? "rerank_exact_phrase" : "",
        provenance > 0 ? "rerank_provenance_boost" : "",
        provenance < 0 ? "rerank_lifecycle_penalty" : "",
        rootIntent > 0 ? "rerank_root_intent_boost" : "",
        rootIntent < 0 ? "rerank_root_intent_penalty" : "",
      ]);
      return {
        ...entry.record,
        score: Number(finalScore.toFixed(3)),
        reasons,
      };
    })
    .filter((record) => record.score > 0)
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));

  return typeof options.limit === "number" ? ranked.slice(0, options.limit) : ranked;
}

export function recordDisplayName(recordPath: string): string {
  return path.basename(recordPath, path.extname(recordPath));
}
