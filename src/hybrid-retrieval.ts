import path from "node:path";

import type { RankedRecord } from "./context.js";

export const HYBRID_RETRIEVAL_MODE = "hybrid_contextual_v2";

export const HYBRID_RANKING_INPUTS = [
  "chunk context",
  "BM25 sparse retrieval",
  "dense lexical retrieval",
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
  "of",
  "on",
  "or",
  "should",
  "the",
  "to",
  "what",
  "when",
  "why",
  "with",
]);

type ScoredRecord = {
  record: RankedRecord;
  score: number;
  reasons: string[];
};

function unique(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)));
}

export function tokenizeHybrid(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^\p{L}\p{N}_-]+/u)
    .map((term) => term.trim())
    .filter((term) => term.length >= 2 && !STOPWORDS.has(term));
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
  options: { limit?: number } = {},
): RankedRecord[] {
  const queryTerms = unique(tokenizeHybrid(query));
  const sparse = sparseFieldRank(records, queryTerms);
  const bm25 = bm25Rank(records, queryTerms);
  const dense = denseLexicalRank(records, query);
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
