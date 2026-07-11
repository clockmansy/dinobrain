import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import { collectColdPartitionPaths } from "./cold-partitions.js";
import {
  LEXICAL_FALLBACK_RETRIEVAL_MODE,
  type RetrievalMode,
  rankingInputsForMode,
  rankRecordsHybridV2,
} from "./hybrid-retrieval.js";
import { isAcceptedMemoryRetrievable } from "./node-lifecycle.js";
import { collectRecentTaskRecordsFromIndex } from "./operations-index.js";

type RecordValue = string | number | boolean | null | Record<string, unknown> | unknown[];

export type RecordLanguage = "ko" | "en" | "mixed" | "unknown";
export type RetrievalLane =
  | "wiki"
  | "source"
  | "project"
  | "accepted_behavior"
  | "operations"
  | "error_book"
  | "recent_task"
  | "other";

export type KnowledgeRole =
  | "behavior_guidance"
  | "accepted_memory"
  | "source_anchor"
  | "fetched_source"
  | "source_citation"
  | "verified_claim_support"
  | "project_context"
  | "operations_evidence"
  | "internal_memory";

export type RetrievalScoreBreakdown = {
  exact_alias: number;
  sparse_field: number;
  bm25: number;
  dense_cosine: number;
  dense_lexical_fallback: number;
  rrf: number;
  rerank: number;
  provenance: number;
  lifecycle: number;
  type_budget: number;
  recency: number;
  noise: number;
  final: number;
};

export type RankedRecord = {
  path: string;
  kind: "curated_record" | "recent_task";
  title: string;
  summary: string;
  tags: string[];
  score: number;
  reasons: string[];
  excerpt: string;
  contextual_chunk: string;
  source_sha256: string;
  parent_record_path: string | null;
  language: RecordLanguage;
  lifecycle_state: string;
  verification_status: string;
  retrieval_lane: RetrievalLane;
  knowledge_role: KnowledgeRole;
  aliases: string[];
  modified_at_ms: number;
  score_breakdown?: RetrievalScoreBreakdown;
};

type QuarantineRecord = {
  target_path?: unknown;
  status?: unknown;
};

export const SEARCH_ROOTS = [
  "20_Wiki",
  "30_Sources",
  "40_Projects",
  "50_Instances/accepted",
  "60_Operations",
  "70_Error_Book",
] as const;

export const STANDARD_RANKING_INPUTS = [
  ...rankingInputsForMode(LEXICAL_FALLBACK_RETRIEVAL_MODE),
  "recent task records",
] as const;

export function standardRankingInputsForMode(mode: RetrievalMode): string[] {
  return [...rankingInputsForMode(mode), "recent task records"];
}

function isInside(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!!relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}

export function dataPath(dataRoot: string, ...parts: string[]): string {
  const target = path.resolve(dataRoot, ...parts);
  if (!isInside(target, dataRoot)) {
    throw new Error(`Path escapes data root: ${parts.join("/")}`);
  }
  return target;
}

export function relDataPath(dataRoot: string, filePath: string): string {
  return path.relative(dataRoot, filePath).split(path.sep).join("/");
}

async function readJson<T>(filePath: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function collectQuarantinedPaths(dataRoot: string): Promise<Set<string>> {
  const quarantineDir = dataPath(dataRoot, ".dino", "quarantine");
  const quarantined = new Set<string>();
  let entries: Array<import("node:fs").Dirent>;
  try {
    entries = await fs.readdir(quarantineDir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return quarantined;
    throw error;
  }

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const record = await readJson<QuarantineRecord>(path.join(quarantineDir, entry.name));
    if (!record || record.status !== "quarantined" || typeof record.target_path !== "string") continue;
    quarantined.add(record.target_path.replace(/\\/g, "/"));
  }

  return quarantined;
}

function tokenize(value: string): string[] {
  return Array.from(
    new Set(
      value
        .toLowerCase()
        .split(/[^\p{L}\p{N}_-]+/u)
        .map((term) => term.trim())
        .filter((term) => term.length >= 2),
    ),
  );
}

function parseFrontmatter(markdown: string): { metadata: Record<string, RecordValue>; body: string } {
  if (!markdown.startsWith("---\n")) {
    return { metadata: {}, body: markdown };
  }

  const end = markdown.indexOf("\n---\n", 4);
  if (end < 0) {
    return { metadata: {}, body: markdown };
  }

  const raw = markdown.slice(4, end);
  const metadata: Record<string, RecordValue> = {};

  for (const line of raw.split(/\r?\n/)) {
    const match = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (!match) continue;
    const [, key, rawValue] = match;
    const trimmed = rawValue.trim();
    if (trimmed === "true") metadata[key] = true;
    else if (trimmed === "false") metadata[key] = false;
    else if (/^\[.*\]$/.test(trimmed)) {
      metadata[key] = trimmed
        .slice(1, -1)
        .split(",")
        .map((item) => item.trim().replace(/^["']|["']$/g, ""))
        .filter(Boolean);
    } else {
      metadata[key] = trimmed.replace(/^["']|["']$/g, "");
    }
  }

  return { metadata, body: markdown.slice(end + 5) };
}

function firstHeading(body: string): string {
  const heading = body.match(/^#\s+(.+)$/m);
  return heading?.[1]?.trim() ?? "";
}

function firstParagraph(body: string): string {
  return (
    body
      .replace(/^---[\s\S]*?---\s*/m, "")
      .split(/\n\s*\n/)
      .map((part) => part.replace(/^#+\s+.+$/gm, "").trim())
      .find((part) => part.length > 0) ?? ""
  ).slice(0, 420);
}

function stringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === "string") return value.split(/[, ]+/).filter(Boolean);
  return [];
}

function firstString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return "";
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function detectLanguage(value: string): RecordLanguage {
  const korean = (value.match(/[\uac00-\ud7a3]/g) ?? []).length;
  const latin = (value.match(/[A-Za-z]/g) ?? []).length;
  if (korean > 0 && latin > 0) return "mixed";
  if (korean > 0) return "ko";
  if (latin > 0) return "en";
  return "unknown";
}

export function retrievalLaneForPath(relativePath: string, kind: RankedRecord["kind"] = "curated_record"): RetrievalLane {
  if (kind === "recent_task" || relativePath.startsWith(".dino/tasks/")) return "recent_task";
  if (relativePath.startsWith("20_Wiki/")) return "wiki";
  if (relativePath.startsWith("30_Sources/")) return "source";
  if (relativePath.startsWith("40_Projects/")) return "project";
  if (relativePath.startsWith("50_Instances/accepted/")) return "accepted_behavior";
  if (relativePath.startsWith("60_Operations/")) return "operations";
  if (relativePath.startsWith("70_Error_Book/")) return "error_book";
  return "other";
}

export function knowledgeRoleForRecord(
  relativePath: string,
  record: Record<string, unknown>,
  kind: RankedRecord["kind"] = "curated_record",
): KnowledgeRole {
  const tags = stringArray(record.tags).map((tag) => tag.toLowerCase());
  const verification = firstString(record.verification_status, record.source_status, record.review_status).toLowerCase();
  if (kind === "recent_task" || relativePath.startsWith("60_Operations/") || relativePath.startsWith(".dino/")) {
    return "operations_evidence";
  }
  if (relativePath.startsWith("30_Sources/")) {
    if (/anchor_only|anchor-only/.test(verification) || tags.includes("source-anchor-unverified")) return "source_anchor";
    if (/verified|reviewed/.test(verification)) return "source_citation";
    return "fetched_source";
  }
  if (relativePath.startsWith("50_Instances/accepted/")) {
    if (
      tags.some((tag) => ["codex-session-derived", "user-preference", "operating-rule", "mistake-lesson"].includes(tag)) ||
      verification === "internal"
    ) {
      return "behavior_guidance";
    }
    return "accepted_memory";
  }
  if (relativePath.startsWith("20_Wiki/") && /verified|reviewed|mixed_verified/.test(verification)) {
    return "verified_claim_support";
  }
  if (relativePath.startsWith("40_Projects/")) return "project_context";
  return "internal_memory";
}

function normalizedAliases(...values: unknown[]): string[] {
  return Array.from(
    new Set(
      values
        .flatMap((value) =>
          Array.isArray(value)
            ? value.map(String)
            : typeof value === "string"
              ? value.split(/[,\n]+/)
              : [],
        )
        .map((value) => value.trim())
        .filter(Boolean),
    ),
  );
}

function boundedContextChunk(title: string, summary: string, excerpt: string): string {
  return [`title: ${title}`, `summary: ${summary}`, `content: ${excerpt}`]
    .filter((value) => value.replace(/^[^:]+:\s*/, "").trim().length > 0)
    .join("\n")
    .slice(0, 1_600);
}

function evidenceSnippet(value: Record<string, unknown>): string {
  const evidence = value.evidence;
  if (typeof evidence === "object" && evidence !== null) {
    return firstString((evidence as { snippet?: unknown }).snippet);
  }
  return "";
}

function isQuarantinedRecord(value: Record<string, unknown>, relativePath: string, quarantinedPaths: Set<string>): boolean {
  const status = String(value.status ?? "").toLowerCase();
  const temperature = String(value.temperature ?? "").toLowerCase();
  const quarantineFlag = value.quarantine === true || String(value.quarantine ?? "").toLowerCase() === "true";
  return (
    ["quarantined", "quarantine", "hold", "held", "archived", "demoted", "deleted-tombstone"].includes(status) ||
    temperature === "cold" ||
    quarantineFlag ||
    quarantinedPaths.has(relativePath)
  );
}

export function isDefaultRetrievalExcludedPath(relativePath: string): boolean {
  const normalized = relativePath.replace(/\\/g, "/");
  return (
    normalized.startsWith("30_Sources/private/") ||
    normalized.startsWith("30_Sources/fetched/") ||
    normalized.startsWith("60_Operations/task-summaries/") ||
    normalized.startsWith(".dino/context-packs/") ||
    normalized.startsWith(".dino/events/") ||
    normalized.startsWith(".dino/gates/") ||
    normalized.startsWith(".dino/tasks/") ||
    normalized.startsWith(".dino/traces/")
  );
}

async function walkSupportedRecords(dir: string, records: string[] = []): Promise<string[]> {
  let entries: Array<import("node:fs").Dirent>;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return records;
    throw error;
  }

  for (const entry of entries) {
    if (entry.name === ".git" || entry.name === "node_modules") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walkSupportedRecords(full, records);
    } else if (entry.isFile() && [".md", ".json"].includes(path.extname(entry.name).toLowerCase())) {
      records.push(full);
    }
  }

  return records;
}

export async function collectCuratedRecords(dataRoot: string): Promise<RankedRecord[]> {
  const files: string[] = [];
  const quarantinedPaths = await collectQuarantinedPaths(dataRoot);
  const coldPartitionPaths = await collectColdPartitionPaths(dataRoot);
  for (const root of SEARCH_ROOTS) {
    await walkSupportedRecords(dataPath(dataRoot, root), files);
  }

  const configuredConcurrency = Number(process.env.DINOBRAIN_RECORD_READ_CONCURRENCY ?? 64);
  const concurrency = Number.isFinite(configuredConcurrency)
    ? Math.max(1, Math.min(128, Math.floor(configuredConcurrency)))
    : 64;
  const records: RankedRecord[] = [];
  for (let offset = 0; offset < files.length; offset += concurrency) {
    const chunk = await Promise.all(files.slice(offset, offset + concurrency).map(async (file): Promise<RankedRecord | null> => {
      const stat = await fs.stat(file);
      if (stat.size > 256 * 1024) return null;

      const relativePath = relDataPath(dataRoot, file);
      if (isDefaultRetrievalExcludedPath(relativePath) || coldPartitionPaths.has(relativePath)) return null;

      const raw = await fs.readFile(file, "utf8");
      const extension = path.extname(file).toLowerCase();

      if (extension === ".json") {
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw) as unknown;
        } catch {
          return null;
        }
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
        const jsonRecord = parsed as Record<string, unknown>;
        if (isQuarantinedRecord(jsonRecord, relativePath, quarantinedPaths)) return null;
        if (!(await isAcceptedMemoryRetrievable(dataRoot, relativePath, jsonRecord))) return null;
        const claim = firstString(jsonRecord.claim);
        const reusableRule = firstString(jsonRecord.reusable_rule, jsonRecord.rule, jsonRecord.decision);
        const evidence = evidenceSnippet(jsonRecord);
        const summary = firstString(jsonRecord.summary, claim, evidence);
        const title = firstString(jsonRecord.title, claim, path.basename(file, extension));
        const excerpt = raw.replace(/\s+/g, " ").trim().slice(0, 900);
        const aliases = normalizedAliases(jsonRecord.aliases, jsonRecord.alias, jsonRecord.aka, jsonRecord.exact_aliases);
        const lifecycleState = firstString(jsonRecord.lifecycle_state, jsonRecord.lifecycle, jsonRecord.status, "active");
        const verificationStatus = firstString(
          jsonRecord.verification_status,
          jsonRecord.review_status,
          jsonRecord.source_status,
          relativePath.startsWith("50_Instances/accepted/") ? "accepted" : "unverified",
        );
        const reviewLineage = [
          typeof jsonRecord.source_candidate_path === "string" ? `source_candidate_path=${jsonRecord.source_candidate_path}` : "",
          typeof jsonRecord.reviewed_by === "string" ? `reviewed_by=${jsonRecord.reviewed_by}` : "",
          typeof jsonRecord.reviewed_at === "string" ? `reviewed_at=${jsonRecord.reviewed_at}` : "",
          String(jsonRecord.review_status ?? "").toLowerCase() === "accepted_by_agent_review"
            ? "review_status=accepted_by_agent_review"
            : "",
        ]
          .filter(Boolean)
          .join(" ");
        return {
          path: relativePath,
          kind: "curated_record",
          title,
          summary: [
            summary,
            reusableRule && reusableRule !== summary ? `Rule: ${reusableRule}` : "",
            evidence && evidence !== summary ? `Evidence: ${evidence}` : "",
            reviewLineage ? `Review: ${reviewLineage}` : "",
          ]
            .filter(Boolean)
            .join(" | ")
            .slice(0, 1000),
          tags: stringArray(jsonRecord.tags),
          score: 0,
          reasons: [],
          excerpt,
          contextual_chunk: boundedContextChunk(title, summary, excerpt),
          source_sha256: sha256(raw),
          parent_record_path:
            firstString(
              jsonRecord.parent_record_path,
              jsonRecord.parent_path,
              jsonRecord.source_path,
              jsonRecord.source_candidate_path,
            ) || null,
          language: detectLanguage([title, summary, excerpt].join(" ")),
          lifecycle_state: lifecycleState,
          verification_status: verificationStatus,
          retrieval_lane: retrievalLaneForPath(relativePath),
          knowledge_role: knowledgeRoleForRecord(relativePath, jsonRecord),
          aliases,
          modified_at_ms: stat.mtimeMs,
        };
      }

      if (relativePath.startsWith("50_Instances/accepted/")) return null;
      const { metadata, body } = parseFrontmatter(raw);
      if (isQuarantinedRecord(metadata, relativePath, quarantinedPaths)) return null;
      const title = String(metadata.title ?? firstHeading(body) ?? path.basename(file, ".md"));
      const summary = String(metadata.summary ?? firstParagraph(body));
      const tags = stringArray(metadata.tags);
      const excerpt = body.replace(/\s+/g, " ").trim().slice(0, 600);
      return {
        path: relativePath,
        kind: "curated_record",
        title,
        summary,
        tags,
        score: 0,
        reasons: [],
        excerpt,
        contextual_chunk: boundedContextChunk(title, summary, excerpt),
        source_sha256: sha256(raw),
        parent_record_path:
          firstString(metadata.parent_record_path, metadata.parent_path, metadata.source_path) || null,
        language: detectLanguage([title, summary, excerpt].join(" ")),
        lifecycle_state: firstString(metadata.lifecycle_state, metadata.lifecycle, metadata.status, "active"),
        verification_status: firstString(metadata.verification_status, metadata.review_status, metadata.source_status, "unverified"),
        retrieval_lane: retrievalLaneForPath(relativePath),
        knowledge_role: knowledgeRoleForRecord(relativePath, metadata as Record<string, unknown>),
        aliases: normalizedAliases(metadata.aliases, metadata.alias, metadata.aka, metadata.exact_aliases),
        modified_at_ms: stat.mtimeMs,
      };
    }));
    records.push(...chunk.filter((record): record is RankedRecord => record !== null));
  }

  return records;
}

export async function collectRecentTaskRecords(dataRoot: string, limit = 10): Promise<RankedRecord[]> {
  const indexedRecords = await collectRecentTaskRecordsFromIndex(dataRoot, limit);
  if (indexedRecords) return indexedRecords;

  const tasksDir = dataPath(dataRoot, ".dino", "tasks");
  let entries: Array<import("node:fs").Dirent>;
  try {
    entries = await fs.readdir(tasksDir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }

  const tasks = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const taskPath = path.join(tasksDir, entry.name);
    const task = await readJson<Record<string, unknown>>(taskPath);
    if (!task) continue;
    const updatedAt = String(task.updated_at ?? task.created_at ?? "");
    tasks.push({ taskPath, task, updatedAt });
  }

  tasks.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

  const records: RankedRecord[] = [];
  for (const { taskPath, task } of tasks.slice(0, limit)) {
    const request = String(task.request ?? task.task_id ?? path.basename(taskPath, ".json"));
    const tracePathValue = typeof task.trace_path === "string" ? task.trace_path : null;
    const trace = tracePathValue ? await readJson<Record<string, unknown>>(dataPath(dataRoot, tracePathValue)) : null;
    const traceSummary = trace && typeof trace.summary === "string" ? trace.summary : "";
    const relativePath = relDataPath(dataRoot, taskPath);
    const title = `Task: ${request.slice(0, 96)}`;
    const summary = [
      `status=${String(task.status ?? "unknown")}`,
      task.project ? `project=${String(task.project)}` : "",
      traceSummary,
    ]
      .filter(Boolean)
      .join(" | ")
      .slice(0, 420);
    records.push({
      path: relativePath,
      kind: "recent_task",
      title,
      summary,
      tags: ["recent-task", String(task.status ?? "unknown")],
      score: 0,
      reasons: [],
      excerpt: request,
      contextual_chunk: boundedContextChunk(title, summary, request),
      source_sha256: sha256(JSON.stringify(task)),
      parent_record_path: tracePathValue,
      language: detectLanguage(request),
      lifecycle_state: String(task.status ?? "active"),
      verification_status: trace ? "trace_recorded" : "unverified",
      retrieval_lane: "recent_task",
      knowledge_role: "operations_evidence",
      aliases: [],
      modified_at_ms: Number.isFinite(Date.parse(String(task.updated_at ?? task.created_at ?? "")))
        ? Date.parse(String(task.updated_at ?? task.created_at ?? ""))
        : 0,
    });
  }

  return records;
}

export async function collectContextRecords(dataRoot: string): Promise<RankedRecord[]> {
  const [curated, recentTasks] = await Promise.all([
    collectCuratedRecords(dataRoot),
    collectRecentTaskRecords(dataRoot),
  ]);
  return [...curated, ...recentTasks];
}

export function rankRecords(
  records: RankedRecord[],
  query: string,
  options: { includeExcerpt?: boolean } = {},
): RankedRecord[] {
  const terms = tokenize(query);
  return records
    .map((record) => {
      let score = 0;
      const reasons: string[] = [];
      const pathText = record.path.toLowerCase();
      const titleText = record.title.toLowerCase();
      const summaryText = record.summary.toLowerCase();
      const tagText = record.tags.join(" ").toLowerCase();
      const excerptText = record.excerpt.toLowerCase();

      for (const term of terms) {
        if (pathText.includes(term)) {
          score += 3;
          reasons.push(`path matched "${term}"`);
        }
        if (titleText.includes(term)) {
          score += 4;
          reasons.push(`title matched "${term}"`);
        }
        if (summaryText.includes(term)) {
          score += 3;
          reasons.push(`summary matched "${term}"`);
        }
        if (tagText.includes(term)) {
          score += 3;
          reasons.push(`tag matched "${term}"`);
        }
        if (options.includeExcerpt && excerptText.includes(term)) {
          score += 1;
          reasons.push(`excerpt matched "${term}"`);
        }
      }

      return { ...record, score, reasons: Array.from(new Set(reasons)) };
    })
    .filter((record) => record.score > 0)
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
}

export async function getStandardPackItems(
  dataRoot: string,
  question: string,
  limit: number,
): Promise<{ records: RankedRecord[]; ranked: RankedRecord[] }> {
  const records = await collectContextRecords(dataRoot);
  return { records, ranked: rankRecordsHybridV2(records, question, { limit, contextPackBudget: true }) };
}
