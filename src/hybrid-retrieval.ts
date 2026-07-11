import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import type { RankedRecord } from "./context.js";

export const HYBRID_RETRIEVAL_MODE = "hybrid_contextual_v2";
export const LEXICAL_FALLBACK_RETRIEVAL_MODE = "lexical_fallback_v2";
export const DENSE_VECTOR_INDEX_RELATIVE_PATH = ".dino/index/dense-vectors.json";

export type RetrievalMode = typeof HYBRID_RETRIEVAL_MODE | typeof LEXICAL_FALLBACK_RETRIEVAL_MODE;

export type DenseVectorIndex = {
  version?: number;
  provider?: string;
  model?: string | null;
  dimensions?: number;
  semantic_embedding_provider?: boolean;
  cache_dir?: string | null;
  generated_at?: string;
  source_index_path?: string;
  records?: Record<string, number[]>;
  record_vectors?: Record<string, number[]>;
  queries?: Record<string, number[]>;
  query_vectors?: Record<string, number[]>;
  source_index_sha256?: string;
  record_metadata?: Record<string, DenseVectorRecordMetadata>;
};

export type DenseVectorRecordMetadata = {
  contextual_chunk: string;
  source_sha256: string;
  parent_record_path: string | null;
  language: string;
  lifecycle_state: string;
  verification_status: string;
  retrieval_lane: string;
  knowledge_role: string;
};

export type DenseVectorCandidate = {
  path: string;
  cosine: number;
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
const MIN_RARE_EXACT_EVIDENCE_SCORE = 12;
const MIN_LEXICAL_EVIDENCE_SCORE = 8;
const MIN_DENSE_LEXICAL_FALLBACK_SCORE = 2;
const MIN_DENSE_ONLY_COSINE_SCORE = 7.5;
const HANGUL_TOKEN = /^[\p{Script=Hangul}]+$/u;
const KOREAN_SUFFIXES = [
  "으로부터",
  "에게서는",
  "이라면",
  "이라는",
  "이라고",
  "하려면",
  "하려고",
  "해야만",
  "하는지",
  "했는지",
  "되는지",
  "되어야",
  "하도록",
  "에서는",
  "으로는",
  "에게서",
  "께서는",
  "까지",
  "부터",
  "처럼",
  "만큼",
  "조차",
  "마저",
  "에서",
  "에게",
  "한테",
  "께서",
  "으로",
  "보다",
  "인지",
  "이라",
  "이나",
  "거나",
  "해야",
  "하는",
  "되는",
  "했다",
  "한다",
  "하고",
  "되고",
  "하면",
  "되면",
  "지만",
  "은",
  "는",
  "이",
  "가",
  "을",
  "를",
  "에",
  "의",
  "도",
  "만",
  "와",
  "과",
  "로",
] as const;
export const CONTROLLED_RULE_CONTEXT_PACK_MAX_TOTAL = 3;
export const CONTROLLED_RULE_CONTEXT_PACK_MAX_PER_TOPIC = 2;
export const CONTROLLED_RULE_CONTEXT_PACK_MAX_CHARS = 2400;
export const DENSE_CANDIDATE_TOP_K_DEFAULT = 64;

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
  if (HANGUL_TOKEN.test(term)) return term.length >= 2;
  if (term.length <= 2 && !SHORT_TOKEN_ALLOWLIST.has(term)) return false;
  return true;
}

function normalizeKoreanToken(term: string): string {
  if (!HANGUL_TOKEN.test(term)) return term;
  for (const suffix of KOREAN_SUFFIXES) {
    if (!term.endsWith(suffix)) continue;
    const stem = term.slice(0, -suffix.length);
    if (stem.length >= 2) return stem;
  }
  return term;
}

export function tokenizeHybrid(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^\p{L}\p{N}_-]+/u)
    .map((term) => term.trim())
    .map(normalizeKoreanToken)
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

export function normalizeVectorKey(value: string): string {
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

export function denseRecordVectorCount(index: DenseVectorIndex | null | undefined): number {
  return Object.values(vectorMap(index, "records")).filter(validVector).length;
}

export function denseVectorDimensions(index: DenseVectorIndex | null | undefined): number {
  const declared = typeof index?.dimensions === "number" && Number.isFinite(index.dimensions) ? index.dimensions : 0;
  if (declared > 0) return declared;
  return Object.values(vectorMap(index, "records")).find(validVector)?.length ?? 0;
}

export function hasDenseQueryVector(index: DenseVectorIndex | null | undefined, query: string): boolean {
  return Boolean(queryVector(index, query));
}

export function setDenseQueryVector(index: DenseVectorIndex, query: string, vector: number[]): void {
  if (!validVector(vector)) return;
  const key = normalizeVectorKey(query);
  index.queries = index.queries ?? {};
  index.query_vectors = index.query_vectors ?? {};
  index.queries[key] = vector;
  index.query_vectors[key] = vector;
}

export function denseIndexUsesSemanticProvider(index: DenseVectorIndex | null | undefined): boolean {
  return Boolean(index?.semantic_embedding_provider === true && index.provider && index.provider !== "local_text_hashing_v1");
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
    if (Object.keys(records).length === 0) return null;
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
  if (!denseIndexUsesSemanticProvider(denseVectorIndex)) return false;
  const qv = queryVector(denseVectorIndex, query);
  if (!qv) return false;
  const recordVectors = vectorMap(denseVectorIndex, "records");
  return records.some((record) => validVector(recordVectors[record.path]));
}

export function denseVectorCandidatePaths(
  denseVectorIndex: DenseVectorIndex | null | undefined,
  query: string,
  limit = DENSE_CANDIDATE_TOP_K_DEFAULT,
): Set<string> {
  return new Set(denseVectorCandidates(denseVectorIndex, query, limit).map((candidate) => candidate.path));
}

export function denseVectorCandidates(
  denseVectorIndex: DenseVectorIndex | null | undefined,
  query: string,
  limit = DENSE_CANDIDATE_TOP_K_DEFAULT,
): DenseVectorCandidate[] {
  if (!denseIndexUsesSemanticProvider(denseVectorIndex)) return [];
  const qv = queryVector(denseVectorIndex, query);
  if (!qv || limit <= 0) return [];
  const dimensions = denseVectorDimensions(denseVectorIndex);
  if (dimensions > 0 && qv.length !== dimensions) return [];
  return Object.entries(vectorMap(denseVectorIndex, "records"))
    .filter(([, vector]) => validVector(vector) && (dimensions <= 0 || vector.length === dimensions))
    .map(([recordPath, vector]) => ({ path: recordPath, cosine: cosine(qv, vector) }))
    .filter((candidate) => candidate.cosine > 0)
    .sort((a, b) => b.cosine - a.cosine || a.path.localeCompare(b.path))
    .slice(0, limit);
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
    `aliases: ${record.aliases.join(" ")}`,
    `language: ${record.language}`,
    `lifecycle: ${record.lifecycle_state}`,
    `verification: ${record.verification_status}`,
    `knowledge_role: ${record.knowledge_role}`,
    `parent: ${record.parent_record_path ?? ""}`,
    `chunk: ${record.contextual_chunk || record.excerpt}`,
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
  const reviewed = hasReviewLineage(record);
  if (record.path.startsWith("30_Sources/chunks/")) bonus += 2.5;
  else if (record.path.startsWith("30_Sources/") && hasProvenanceMetadata) bonus += 1.2;
  if (record.path.startsWith("50_Instances/accepted/") && hasProvenanceMetadata) bonus += 1.5;
  if (hasProvenanceMetadata) bonus += 1.2;
  if (/verified|accepted|reviewed|trace_recorded/.test(record.verification_status.toLowerCase())) bonus += 1.2;
  if (record.source_sha256.length === 64) bonus += 0.4;
  if (record.parent_record_path) bonus += 0.4;
  if (record.path.startsWith("50_Instances/accepted/") && /"auto_generated"\s*:\s*true/.test(text) && !reviewed) bonus -= 4;
  if (record.path.startsWith("50_Instances/accepted/behavior-rule-") && /"support_count"\s*:\s*1/.test(text) && !reviewed) {
    bonus -= 3;
  }
  if (record.path.startsWith("60_Operations/task-summaries/")) bonus -= 3;
  return bonus;
}

function lifecycleContribution(record: RankedRecord): number {
  const lifecycle = record.lifecycle_state.toLowerCase();
  const verification = record.verification_status.toLowerCase();
  if (/(deleted|tombstone|quarantine|rejected|excluded)/.test(`${lifecycle} ${verification}`)) return -12;
  if (/(hold|held|pending|candidate)/.test(`${lifecycle} ${verification}`)) return -4;
  if (/(accepted|active|promoted|verified|reviewed)/.test(`${lifecycle} ${verification}`)) return 1;
  return 0;
}

function typeBudgetContribution(record: RankedRecord): number {
  if (["wiki", "source", "project", "error_book"].includes(record.retrieval_lane)) return 0.5;
  if (record.retrieval_lane === "accepted_behavior") return 0.25;
  if (record.retrieval_lane === "operations") return -0.5;
  if (record.retrieval_lane === "recent_task") return -0.75;
  return -0.25;
}

function recencyContribution(record: RankedRecord): number {
  if (!(record.modified_at_ms > 0)) return 0;
  const ageDays = Math.max(0, (Date.now() - record.modified_at_ms) / 86_400_000);
  if (ageDays <= 7) return 0.75;
  if (ageDays <= 30) return 0.4;
  if (ageDays <= 180) return 0.15;
  return 0;
}

function noiseContribution(record: RankedRecord): number {
  const text = `${record.title} ${record.summary} ${record.contextual_chunk}`.trim();
  let penalty = 0;
  if (record.path.endsWith("/README.md") && text.length < 220) penalty -= 3;
  if (record.summary.length < 24) penalty -= 1;
  if (/use this folder for|placeholder|todo|coming soon/i.test(text)) penalty -= 2;
  return penalty;
}

function normalizeExact(value: string): string {
  return value.toLowerCase().replace(/[^\p{L}\p{N}_-]+/gu, " ").replace(/\s+/g, " ").trim();
}

function exactLexicalBonus(record: RankedRecord, query: string, queryTerms: string[], documentFrequency: Map<string, number>): number {
  const normalizedQuery = normalizeExact(query);
  if (!normalizedQuery) return 0;
  if (record.aliases.some((alias) => normalizeExact(alias) === normalizedQuery)) return 42;
  if (normalizeExact(record.title) === normalizedQuery) return 34;
  if (normalizeExact(recordDisplayName(record.path)) === normalizedQuery) return 30;

  const exactTokens = new Set(
    tokenizeHybrid([record.path, record.title, record.aliases.join(" ")].join(" ")),
  );
  const rareMatches = queryTerms.filter((term) => exactTokens.has(term) && (documentFrequency.get(term) ?? 0) <= 2);
  return Math.min(18, rareMatches.length * 6);
}

function isCodexSessionKnowledge(record: RankedRecord): boolean {
  return record.path.startsWith("50_Instances/accepted/codex-session-knowledge-");
}

function isAcceptedTaskMemory(record: RankedRecord): boolean {
  return record.path.startsWith("50_Instances/accepted/task-memory-");
}

function sessionKnowledgeIntentBonus(record: RankedRecord, query: string, queryTerms: string[]): number {
  if (!isCodexSessionKnowledge(record)) return 0;
  const lower = query.toLowerCase();
  const asksForReusableBehavior =
    /\b(criteria|criterion|standard|standards|preference|priority|rule|rules|goal|risk|state|proof|verification|equivalence|direction|quality|required|requirement|policy|lesson)\b/.test(
      lower,
    ) || lower.includes("dinobrain");
  if (!asksForReusableBehavior) return 0;

  const slug = path.basename(record.path, path.extname(record.path)).replace(/^codex-session-knowledge-/, "");
  const slugTerms = tokenizeHybrid(slug);
  const matchedSlugTerms = slugTerms.filter((term) => queryTerms.includes(term)).length;
  const titleTerms = tokenizeHybrid(record.title);
  const matchedTitleTerms = titleTerms.filter((term) => queryTerms.includes(term)).length;
  return 5 + Math.min(8, matchedSlugTerms * 2 + matchedTitleTerms * 1.5);
}

function taskMemorySpecificityPenalty(record: RankedRecord, query: string): number {
  if (!isAcceptedTaskMemory(record)) return 0;
  const lower = query.toLowerCase();
  if (/\b(task|trace|audit|reviewer|evidence|completion|recent)\b/.test(lower)) return 0;
  return -4.5;
}

function rootIntentBonus(record: RankedRecord, query: string): number {
  const lower = query.toLowerCase();
  const matched = rootIntentsForQuery(lower);
  if (matched.length === 0) return 0;
  const matchingPrefix = matched.find((prefix) => record.path.startsWith(prefix));
  if (matchingPrefix) return record.path === `${matchingPrefix}README.md` ? 12 : 4.5;
  if (record.path.endsWith("/README.md")) return -8;
  return -3;
}

export function rootIntentsForQuery(query: string): string[] {
  const lower = query.toLowerCase();
  const intents: Array<[string, RegExp]> = [
    ["20_Wiki/", /\b(wiki|knowledge|curated|reusable)\b/],
    ["30_Sources/", /\b(source|sources|provenance|evidence|citation|citations)\b/],
    ["40_Projects/", /\b(project|projects|handoff|implementation|constraints|state|installer|release|version|new pc|roadmap)\b/],
    [
      "50_Instances/accepted/",
      /\b(instance|instances|accepted|confidence|memory|preference|rule|lesson|goal|behavior|session knowledge|criteria|criterion|standard|equivalence|quality|direction|compounding|observability|release drift|risk|completion|reporting)\b/,
    ],
    ["60_Operations/", /\b(operation|operations|runbook|runbooks|policy|policies|maintenance|sync|vault)\b/],
    ["70_Error_Book/", /\b(error|mistake|mistakes|correction|corrections|prevention)\b/],
  ];
  return intents.filter(([, pattern]) => pattern.test(lower)).map(([prefix]) => prefix);
}

function allowsRecentTaskContext(query: string): boolean {
  return /\b(recent|latest|active|current|task|tasks|trace|audit|hook|session|operation|operations|status|work|verifier|pending|blocked)\b/i.test(
    query,
  ) || /최근|현재|작업|태스크|추적|감사|훅|세션|운영|상태|검증|보류|차단/.test(query);
}

function isControlledBehaviorRule(record: RankedRecord): boolean {
  return record.path.startsWith("50_Instances/accepted/") && record.tags.some((tag) => tag.toLowerCase() === "controlled-compounding");
}

function controlledRuleTopic(record: RankedRecord): string {
  const topicTag = record.tags.find((tag) => tag.toLowerCase().startsWith("topic:"));
  return topicTag?.toLowerCase() ?? "topic:general";
}

export function takeWithContextPackBudgets(records: RankedRecord[], limit: number, query: string): RankedRecord[] {
  const selected: RankedRecord[] = [];
  let recentTaskCount = 0;
  let controlledRuleCount = 0;
  let controlledRuleChars = 0;
  const controlledTopicCounts = new Map<string, number>();
  const maxRecentTasks = allowsRecentTaskContext(query) ? Math.min(1, limit) : 0;
  const laneCounts = new Map<RankedRecord["retrieval_lane"], number>();
  let supplementalLaneCount = 0;
  const intentPrefixes = rootIntentsForQuery(query);
  const intentLanes = new Set(
    intentPrefixes.map((prefix) =>
      prefix.startsWith("20_Wiki/")
        ? "wiki"
        : prefix.startsWith("30_Sources/")
          ? "source"
          : prefix.startsWith("40_Projects/")
            ? "project"
            : prefix.startsWith("50_Instances/accepted/")
              ? "accepted_behavior"
              : prefix.startsWith("60_Operations/")
                ? "operations"
                : "error_book",
    ),
  );
  const laneLimit = (lane: RankedRecord["retrieval_lane"]): number => {
    if (lane === "recent_task") return maxRecentTasks;
    if (lane === "operations") return Math.min(intentLanes.has(lane) ? 4 : 1, limit);
    if (lane === "other") return Math.min(1, limit);
    if (intentLanes.has(lane)) return lane === "accepted_behavior" ? Math.max(3, Math.ceil(limit * 0.75)) : limit;
    if (lane === "accepted_behavior") return Math.max(2, Math.ceil(limit * 0.5));
    return Math.max(2, Math.ceil(limit * 0.4));
  };
  const acceptedBehaviorAvailable = records.some((record) => record.retrieval_lane === "accepted_behavior");
  const maxSupplementalLanes =
    acceptedBehaviorAvailable && (intentLanes.size === 0 || intentLanes.has("accepted_behavior"))
      ? Math.min(2, limit)
      : limit;
  for (const record of records) {
    if (record.kind === "recent_task" || record.path.startsWith(".dino/tasks/")) {
      if (recentTaskCount >= maxRecentTasks) continue;
      recentTaskCount += 1;
    }
    if (isControlledBehaviorRule(record)) {
      const topic = controlledRuleTopic(record);
      const chars = record.summary.length + record.excerpt.length;
      if (controlledRuleCount >= CONTROLLED_RULE_CONTEXT_PACK_MAX_TOTAL) continue;
      if ((controlledTopicCounts.get(topic) ?? 0) >= CONTROLLED_RULE_CONTEXT_PACK_MAX_PER_TOPIC) continue;
      if (controlledRuleChars + chars > CONTROLLED_RULE_CONTEXT_PACK_MAX_CHARS) continue;
      controlledRuleCount += 1;
      controlledRuleChars += chars;
      controlledTopicCounts.set(topic, (controlledTopicCounts.get(topic) ?? 0) + 1);
    }
    const lane = record.retrieval_lane;
    if ((laneCounts.get(lane) ?? 0) >= laneLimit(lane)) continue;
    if (lane !== "accepted_behavior" && supplementalLaneCount >= maxSupplementalLanes) continue;
    laneCounts.set(lane, (laneCounts.get(lane) ?? 0) + 1);
    if (lane !== "accepted_behavior") supplementalLaneCount += 1;
    selected.push(record);
    if (selected.length >= limit) break;
  }
  return selected;
}

function applyContextPackIntentBudget(records: RankedRecord[], query: string, limit?: number): RankedRecord[] {
  const targetLimit = typeof limit === "number" ? limit : records.length;
  if (targetLimit <= 0) return [];
  return takeWithContextPackBudgets(records, targetLimit, query);
}

function hasMinimumRetrievalEvidence(record: RankedRecord): boolean {
  const score = record.score_breakdown;
  if (!score) return record.reasons.some((reason) => /(?:matched|exact|bm25|dense_lexical)/.test(reason));
  const lexicalEvidence = score.sparse_field + score.bm25;
  return (
    score.exact_alias >= MIN_RARE_EXACT_EVIDENCE_SCORE ||
    lexicalEvidence >= MIN_LEXICAL_EVIDENCE_SCORE ||
    score.dense_lexical_fallback >= MIN_DENSE_LEXICAL_FALLBACK_SCORE ||
    score.dense_cosine >= MIN_DENSE_ONLY_COSINE_SCORE
  );
}

function hasReviewLineage(record: RankedRecord): boolean {
  const text = contextualText(record).toLowerCase();
  return /source_candidate_path|reviewed_by|reviewed_at|accepted_by_agent_review/.test(text);
}

function isUnreviewedAutoGeneratedAccepted(record: RankedRecord): boolean {
  if (!record.path.startsWith("50_Instances/accepted/")) return false;
  const text = contextualText(record).toLowerCase();
  return /"auto_generated"\s*:\s*true/.test(text) && !hasReviewLineage(record);
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
  limit = DENSE_CANDIDATE_TOP_K_DEFAULT,
): ScoredRecord[] | null {
  if (!denseIndexUsesSemanticProvider(denseVectorIndex)) return null;
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
    .sort((a, b) => b.score - a.score || a.record.path.localeCompare(b.record.path))
    .slice(0, limit);
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

function exactLexicalRank(
  records: RankedRecord[],
  query: string,
  queryTerms: string[],
  documentFrequency: Map<string, number>,
): ScoredRecord[] {
  return records
    .map((record) => {
      const score = exactLexicalBonus(record, query, queryTerms, documentFrequency);
      return {
        record,
        score,
        reasons:
          score >= 42
            ? [`exact_alias:${normalizeExact(query)}`]
            : score >= 30
              ? ["exact_title_or_path"]
              : score > 0
                ? ["rare_lexical_exact"]
                : [],
      };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.record.path.localeCompare(b.record.path));
}

function scoreMap(entries: ScoredRecord[]): Map<string, number> {
  return new Map(entries.map((entry) => [entry.record.path, entry.score]));
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
  options: {
    limit?: number;
    denseVectorIndex?: DenseVectorIndex | null;
    contextPackBudget?: boolean;
    denseTopK?: number;
  } = {},
): RankedRecord[] {
  const eligibleRecords = records.filter((record) => !isUnreviewedAutoGeneratedAccepted(record));
  const queryTerms = filterQueryTermsByCorpus(eligibleRecords, unique(tokenizeHybrid(query)));
  const documentFrequency = docFrequencyByTerm(eligibleRecords);
  const exact = exactLexicalRank(eligibleRecords, query, queryTerms, documentFrequency);
  const sparse = sparseFieldRank(eligibleRecords, queryTerms);
  const bm25 = bm25Rank(eligibleRecords, queryTerms);
  const semanticDense = denseVectorRank(
    eligibleRecords,
    query,
    options.denseVectorIndex,
    options.denseTopK ?? DENSE_CANDIDATE_TOP_K_DEFAULT,
  );
  const lexicalDense = semanticDense ? [] : denseLexicalRank(eligibleRecords, query).slice(0, options.denseTopK ?? DENSE_CANDIDATE_TOP_K_DEFAULT);
  const dense = semanticDense ?? lexicalDense;
  const fused = rrf([exact, sparse, bm25, dense]);
  const exactScores = scoreMap(exact);
  const sparseScores = scoreMap(sparse);
  const bm25Scores = scoreMap(bm25);
  const denseScores = scoreMap(dense);

  for (const record of eligibleRecords) {
    if (fused.has(record.path)) continue;
    const score = phraseBonus(record, query) + provenanceBonus(record);
    if (score > 0) fused.set(record.path, { record, score: score / 100, reasons: ["rerank_prior"] });
  }

  const ranked = Array.from(fused.values())
    .map((entry) => {
      const phrase = phraseBonus(entry.record, query);
      const provenance = provenanceBonus(entry.record);
      const rootIntent = rootIntentBonus(entry.record, query);
      const sessionKnowledge = sessionKnowledgeIntentBonus(entry.record, query, queryTerms);
      const taskSpecificity = taskMemorySpecificityPenalty(entry.record, query);
      const exactAlias = exactScores.get(entry.record.path) ?? 0;
      const lifecycle = lifecycleContribution(entry.record);
      const typeBudget = typeBudgetContribution(entry.record);
      const recency = recencyContribution(entry.record);
      const noise = noiseContribution(entry.record);
      const rerank = phrase + rootIntent + sessionKnowledge + taskSpecificity;
      const rrfScore = entry.score * 100;
      const finalScore = rrfScore + exactAlias + rerank + provenance + lifecycle + typeBudget + recency + noise;
      const reasons = unique([
        ...entry.reasons,
        "rank_fusion:rrf",
        exactAlias >= 42 ? "rerank_exact_alias" : "",
        exactAlias > 0 && exactAlias < 42 ? "rerank_rare_lexical" : "",
        phrase > 0 ? "rerank_exact_phrase" : "",
        provenance > 0 ? "rerank_provenance_boost" : "",
        provenance < 0 ? "rerank_lifecycle_penalty" : "",
        rootIntent > 0 ? "rerank_root_intent_boost" : "",
        rootIntent < 0 ? "rerank_root_intent_penalty" : "",
        sessionKnowledge > 0 ? "rerank_session_knowledge_boost" : "",
        taskSpecificity < 0 ? "rerank_task_memory_specificity_penalty" : "",
        lifecycle > 0 ? "rerank_lifecycle_boost" : "",
        lifecycle < 0 ? "rerank_lifecycle_penalty" : "",
        typeBudget > 0 ? "rerank_type_budget_boost" : "",
        typeBudget < 0 ? "rerank_type_budget_penalty" : "",
        recency > 0 ? "rerank_recency_boost" : "",
        noise < 0 ? "rerank_noise_penalty" : "",
      ]);
      const scoreBreakdown = {
        exact_alias: Number(exactAlias.toFixed(6)),
        sparse_field: Number((sparseScores.get(entry.record.path) ?? 0).toFixed(6)),
        bm25: Number((bm25Scores.get(entry.record.path) ?? 0).toFixed(6)),
        dense_cosine: Number((semanticDense ? denseScores.get(entry.record.path) ?? 0 : 0).toFixed(6)),
        dense_lexical_fallback: Number((semanticDense ? 0 : denseScores.get(entry.record.path) ?? 0).toFixed(6)),
        rrf: Number(rrfScore.toFixed(6)),
        rerank: Number(rerank.toFixed(6)),
        provenance: Number(provenance.toFixed(6)),
        lifecycle: Number(lifecycle.toFixed(6)),
        type_budget: Number(typeBudget.toFixed(6)),
        recency: Number(recency.toFixed(6)),
        noise: Number(noise.toFixed(6)),
        final: Number(finalScore.toFixed(6)),
      };
      return {
        ...entry.record,
        score: Number(finalScore.toFixed(3)),
        reasons,
        score_breakdown: scoreBreakdown,
      };
    })
    .filter((record) => record.score > 0)
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));

  const confident = ranked.filter(hasMinimumRetrievalEvidence);

  if (options.contextPackBudget) return applyContextPackIntentBudget(confident, query, options.limit);
  return typeof options.limit === "number" ? confident.slice(0, options.limit) : confident;
}

export function recordDisplayName(recordPath: string): string {
  return path.basename(recordPath, path.extname(recordPath));
}
