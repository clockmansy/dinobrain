import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { SEARCH_ROOTS, STANDARD_RANKING_INPUTS } from "./context.js";
import { buildMemoryAudit } from "./memory-audit.js";
import {
  type OperationContextPackEntry,
  type OperationEventEntry,
  type OperationTaskEntry,
  type OperationTraceEntry,
  appendOperationEvent,
  upsertOperationContextPack,
  upsertOperationTask,
  upsertOperationTrace,
} from "./operations-index.js";
import { getContextPackItems, searchWiki } from "./retrieval.js";
import {
  appendSqliteOperationEvent,
  invalidateSqliteWikiShard,
  upsertSqliteOperationContextPack,
  upsertSqliteOperationTask,
  upsertSqliteOperationTrace,
} from "./sqlite-shards.js";
import { buildSessionImportPlan, type SessionMessageInput } from "./session-ingest.js";
import { invalidateWikiIndex } from "./wiki-index.js";

const execFileAsync = promisify(execFile);

const DATA_ROOT = path.resolve(
  process.env.DINOBRAIN_DATA_DIR ?? path.join(process.cwd(), "..", "dinobrain-data"),
);

function nowIso(): string {
  return new Date().toISOString();
}

function dateStamp(date = new Date()): string {
  return date.toISOString().slice(0, 10);
}

function safeSlug(value: string): string {
  const slug = value
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 72);
  return slug || "task";
}

function makeTaskId(request: string): string {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "-");
  return `task-${stamp}-${safeSlug(request).slice(0, 28)}`;
}

function makePackId(question: string): string {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "-");
  return `pack-${stamp}-${safeSlug(question).slice(0, 28)}`;
}

function makeCandidateId(claim: string): string {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "-");
  return `candidate-${stamp}-${safeSlug(claim).slice(0, 28)}`;
}

function makeQuarantineId(targetPath: string): string {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "-");
  return `quarantine-${stamp}-${safeSlug(targetPath).slice(0, 36)}`;
}

function isInside(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!!relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}

function dataPath(...parts: string[]): string {
  const target = path.resolve(DATA_ROOT, ...parts);
  if (!isInside(target, DATA_ROOT)) {
    throw new Error(`Path escapes data root: ${parts.join("/")}`);
  }
  return target;
}

function relDataPath(filePath: string): string {
  return path.relative(DATA_ROOT, filePath).split(path.sep).join("/");
}

function normalizeVaultPath(value: string): string {
  const normalized = value.replace(/\\/g, "/").replace(/^\/+/, "");
  dataPath(normalized);
  return normalized;
}

function normalizeVaultPaths(values: string[]): string[] {
  return Array.from(
    new Set(
      values
        .map((value) => value.trim())
        .filter(Boolean)
        .map((value) => normalizeVaultPath(value)),
    ),
  );
}

function normalizeTextList(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}

async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await ensureDir(path.dirname(filePath));
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function readJson<T>(filePath: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function appendJsonLine(filePath: string, value: unknown): Promise<void> {
  await ensureDir(path.dirname(filePath));
  await fs.appendFile(filePath, `${JSON.stringify(value)}\n`, "utf8");
}

async function appendEvent(value: Record<string, unknown>): Promise<string> {
  const eventPath = dataPath(".dino", "events", `${dateStamp()}.jsonl`);
  await appendJsonLine(eventPath, value);
  const relativePath = relDataPath(eventPath);
  await appendOperationEvent(DATA_ROOT, relativePath, value);
  await appendSqliteOperationEvent(DATA_ROOT, {
    ...value,
    event: typeof value.event === "string" ? value.event : "event",
    at: typeof value.at === "string" ? value.at : null,
    _path: relativePath,
  } as OperationEventEntry);
  return relativePath;
}

function firstString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return "";
}

function taskEntryFromRecord(taskPath: string, task: Record<string, unknown>): OperationTaskEntry {
  const taskId = firstString(task.task_id, path.basename(taskPath, ".json"));
  return {
    path: taskPath,
    task_id: taskId,
    status: firstString(task.status, "unknown"),
    request: firstString(task.request, taskId),
    project: typeof task.project === "string" ? task.project : null,
    sync_policy: typeof task.sync_policy === "string" ? task.sync_policy : null,
    trace_path: typeof task.trace_path === "string" ? task.trace_path : null,
    created_at: firstString(task.created_at),
    updated_at: firstString(task.updated_at, task.finished_at, task.created_at),
    finished_at: typeof task.finished_at === "string" ? task.finished_at : null,
  };
}

function traceEntryFromRecord(tracePath: string, trace: Record<string, unknown>): OperationTraceEntry {
  return {
    path: tracePath,
    task_id: firstString(trace.task_id, path.basename(tracePath, ".json")),
    outcome: firstString(trace.outcome, "unknown"),
    summary: firstString(trace.summary),
    finished_at: firstString(trace.finished_at),
    used_memory_paths: Array.isArray(trace.used_memory_paths) ? trace.used_memory_paths.map(String) : [],
    context_pack_paths: Array.isArray(trace.context_pack_paths) ? trace.context_pack_paths.map(String) : [],
    session_archive_paths: Array.isArray(trace.session_archive_paths) ? trace.session_archive_paths.map(String) : [],
    candidate_paths: Array.isArray(trace.candidate_paths) ? trace.candidate_paths.map(String) : [],
  };
}

function contextPackEntryFromRecord(packPath: string, pack: Record<string, unknown>): OperationContextPackEntry {
  const items = Array.isArray(pack.items) ? pack.items : [];
  return {
    path: packPath,
    pack_id: firstString(pack.pack_id, path.basename(packPath, ".json")),
    question: firstString(pack.question),
    created_at: firstString(pack.created_at),
    item_count: typeof pack.included_item_count === "number" ? pack.included_item_count : items.length,
    retrieval_mode: typeof pack.retrieval_mode === "string" ? pack.retrieval_mode : null,
    items: items
      .filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null && !Array.isArray(item))
      .slice(0, 12)
      .map((item) => ({
        path: firstString(item.path),
        kind: firstString(item.kind) || undefined,
        title: firstString(item.title) || undefined,
        summary: firstString(item.summary) || undefined,
        score: typeof item.score === "number" ? item.score : undefined,
      })),
  };
}

function jsonResult(value: unknown): CallToolResult {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(value, null, 2),
      },
    ],
  };
}

type SyncClassification = "syncable" | "conditional" | "blocked";

type PathClassification = {
  classification: SyncClassification;
  policy: string;
  reasons: string[];
};

type SensitivityHit = {
  pattern: string;
  line: number;
};

function classifyPath(normalizedPath: string): PathClassification {
  const blockedPrefixes = [
    "10_Conversations/raw/",
    "50_Instances/raw/",
    "attachments/private/",
    ".dino/cache/",
    ".dino/tmp/",
  ];
  const blockedExact = new Set([".env", ".dino/secrets.json", ".dino/local.json"]);
  const blockedExtensions = [".pem", ".key", ".p12", ".pfx"];
  const conditionalPrefixes = [
    "50_Instances/candidates/",
    "80_Review_Queue/",
    ".dino/index/",
    ".dino/evaluations/",
    ".dino/tasks/",
    ".dino/events/",
    ".dino/traces/",
    ".dino/context-packs/",
    ".dino/audits/",
    ".dino/quarantine/",
  ];
  const syncablePrefixes = [
    "00_Home/",
    "20_Wiki/",
    "30_Sources/",
    "40_Projects/",
    "50_Instances/accepted/",
    "60_Operations/",
    "70_Error_Book/",
  ];
  const syncableExact = new Set(["README.md", ".gitignore"]);

  if (
    blockedExact.has(normalizedPath) ||
    blockedPrefixes.some((prefix) => normalizedPath.startsWith(prefix)) ||
    blockedExtensions.some((extension) => normalizedPath.toLowerCase().endsWith(extension))
  ) {
    return {
      classification: "blocked",
      policy: "local_only",
      reasons: ["path is local-only or secret-bearing"],
    };
  }

  if (conditionalPrefixes.some((prefix) => normalizedPath.startsWith(prefix))) {
    return {
      classification: "conditional",
      policy: "requires_review",
      reasons: ["path requires review before sync"],
    };
  }

  if (syncableExact.has(normalizedPath) || syncablePrefixes.some((prefix) => normalizedPath.startsWith(prefix))) {
    return {
      classification: "syncable",
      policy: "syncable_after_review",
      reasons: ["path is allowed by sync policy"],
    };
  }

  return {
    classification: "conditional",
    policy: "unclassified_requires_review",
    reasons: ["path is not explicitly classified"],
  };
}

async function sensitivityHits(filePath: string): Promise<SensitivityHit[]> {
  try {
    const stat = await fs.stat(filePath);
    if (!stat.isFile() || stat.size > 512 * 1024) return [];
    const text = await fs.readFile(filePath, "utf8");
    const patterns: Array<[string, RegExp]> = [
      ["api_key_assignment", /api[_-]?key\s*[:=]/i],
      ["secret_assignment", /secret\s*[:=]/i],
      ["token_assignment", /token\s*[:=]/i],
      ["password_assignment", /password\s*[:=]/i],
      ["private_key_block", /BEGIN [A-Z ]*PRIVATE KEY/],
      ["openai_key_shape", /sk-[A-Za-z0-9]{20,}/],
      ["github_token_shape", /(?:github_pat_[A-Za-z0-9_]{20,}|(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{20,})/],
      ["aws_access_key_shape", /(?:AKIA|ASIA)[A-Z0-9]{16}/],
      ["jwt_shape", /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/],
      ["cookie_assignment", /(session|sessionid|cookie)\s*[:=]/i],
    ];
    const hits: SensitivityHit[] = [];
    const lines = text.split(/\r?\n/);
    for (const [patternName, pattern] of patterns) {
      const lineIndex = lines.findIndex((line) => pattern.test(line));
      if (lineIndex >= 0) {
        hits.push({ pattern: patternName, line: lineIndex + 1 });
      }
    }
    return hits;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

function parseGitStatus(stdout: string): Array<{ status: string; path: string }> {
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .map((line) => {
      const status = line.slice(0, 2);
      const rawPath = line.slice(3);
      const normalized = rawPath.includes(" -> ") ? rawPath.split(" -> ").pop() ?? rawPath : rawPath;
      return { status, path: normalized.replace(/\\/g, "/").replace(/^"|"$/g, "") };
    });
}

const server = new McpServer({
  name: "dinobrain",
  version: "0.1.2",
});

server.registerTool(
  "start_task",
  {
    title: "Start Task",
    description: "Register a new DinoBrain task record in the data repo.",
    inputSchema: {
      request: z.string().min(1),
      project: z.string().optional(),
      mode: z.enum(["standard", "deep"]).default("standard"),
      sensitivity: z.enum(["normal", "sensitive", "unknown"]).default("unknown"),
    },
  },
  async ({ request, project, mode, sensitivity }) => {
    const taskId = makeTaskId(request);
    const taskPath = dataPath(".dino", "tasks", `${taskId}.json`);
    const record = {
      task_id: taskId,
      status: "started",
      request,
      project: project ?? null,
      mode,
      sensitivity,
      created_at: nowIso(),
      updated_at: nowIso(),
      data_root: DATA_ROOT,
      sync_policy: sensitivity === "normal" ? "conditional" : "blocked_until_review",
    };
    await writeJson(taskPath, record);
    const taskRelativePath = relDataPath(taskPath);
    await upsertOperationTask(DATA_ROOT, taskRelativePath, record);
    await upsertSqliteOperationTask(DATA_ROOT, taskEntryFromRecord(taskRelativePath, record));
    const eventLog = await appendEvent({
      event: "task_started",
      task_id: taskId,
      at: record.created_at,
      path: relDataPath(taskPath),
    });
    return jsonResult({
      ok: true,
      task_id: taskId,
      task_path: taskRelativePath,
      event_log: eventLog,
      record,
    });
  },
);

server.registerTool(
  "finish_task",
  {
    title: "Finish Task",
    description: "Finish a DinoBrain task and write a trace/event log entry.",
    inputSchema: {
      task_id: z.string().min(1),
      summary: z.string().min(1),
      outcome: z.enum(["completed", "partial", "blocked"]).default("completed"),
      changed_files: z.array(z.string()).default([]),
      decisions: z.array(z.string()).default([]),
      next_steps: z.array(z.string()).default([]),
      used_memory_paths: z.array(z.string()).default([]),
      context_pack_paths: z.array(z.string()).default([]),
      session_archive_paths: z.array(z.string()).default([]),
      candidate_paths: z.array(z.string()).default([]),
      search_queries: z.array(z.string()).default([]),
    },
  },
  async ({
    task_id,
    summary,
    outcome,
    changed_files,
    decisions,
    next_steps,
    used_memory_paths,
    context_pack_paths,
    session_archive_paths,
    candidate_paths,
    search_queries,
  }) => {
    const taskPath = dataPath(".dino", "tasks", `${safeSlug(task_id)}.json`);
    const existing = (await readJson<Record<string, unknown>>(taskPath)) ?? {
      task_id,
      status: "missing_start_record",
      created_at: null,
    };
    const finishedAt = nowIso();
    const normalizedUsedMemoryPaths = normalizeVaultPaths(used_memory_paths);
    const normalizedContextPackPaths = normalizeVaultPaths(context_pack_paths);
    const normalizedSessionArchivePaths = normalizeVaultPaths(session_archive_paths);
    const normalizedCandidatePaths = normalizeVaultPaths(candidate_paths);
    const normalizedSearchQueries = normalizeTextList(search_queries);
    const trace = {
      task_id,
      outcome,
      summary,
      changed_files,
      decisions,
      next_steps,
      used_memory_paths: normalizedUsedMemoryPaths,
      context_pack_paths: normalizedContextPackPaths,
      session_archive_paths: normalizedSessionArchivePaths,
      candidate_paths: normalizedCandidatePaths,
      search_queries: normalizedSearchQueries,
      memory_use: {
        used_memory_count: normalizedUsedMemoryPaths.length,
        context_pack_count: normalizedContextPackPaths.length,
        session_archive_count: normalizedSessionArchivePaths.length,
        candidate_count: normalizedCandidatePaths.length,
        search_query_count: normalizedSearchQueries.length,
      },
      finished_at: finishedAt,
    };
    const updated = {
      ...existing,
      status: outcome,
      updated_at: finishedAt,
      finished_at: finishedAt,
      trace_path: `.dino/traces/${safeSlug(task_id)}.json`,
    };
    const tracePath = dataPath(".dino", "traces", `${safeSlug(task_id)}.json`);
    await writeJson(taskPath, updated);
    await writeJson(tracePath, trace);
    const taskRelativePath = relDataPath(taskPath);
    const traceRelativePath = relDataPath(tracePath);
    await upsertOperationTask(DATA_ROOT, taskRelativePath, updated);
    await upsertOperationTrace(DATA_ROOT, traceRelativePath, trace);
    await upsertSqliteOperationTask(DATA_ROOT, taskEntryFromRecord(taskRelativePath, updated));
    await upsertSqliteOperationTrace(DATA_ROOT, traceEntryFromRecord(traceRelativePath, trace));
    const eventLog = await appendEvent({
      event: "task_finished",
      task_id,
      outcome,
      at: finishedAt,
      trace_path: relDataPath(tracePath),
      used_memory_paths: normalizedUsedMemoryPaths,
      context_pack_paths: normalizedContextPackPaths,
      session_archive_paths: normalizedSessionArchivePaths,
      candidate_paths: normalizedCandidatePaths,
      search_query_count: normalizedSearchQueries.length,
    });
    return jsonResult({
      ok: true,
      task_id,
      task_path: taskRelativePath,
      trace_path: traceRelativePath,
      event_log: eventLog,
    });
  },
);

server.registerTool(
  "audit_memory_use",
  {
    title: "Audit Memory Use",
    description: "Create a short trust audit for whether provided DinoBrain memories were declared and observably used.",
    inputSchema: {
      task_id: z.string().optional(),
      trace_path: z.string().optional(),
      context_pack_paths: z.array(z.string()).default([]),
      expected_memory_paths: z.array(z.string()).default([]),
      observed_artifact_paths: z.array(z.string()).default([]),
      observed_summary: z.string().default(""),
      auditor: z.string().default("memory-audit"),
      notes: z.string().default(""),
    },
  },
  async ({
    task_id,
    trace_path,
    context_pack_paths,
    expected_memory_paths,
    observed_artifact_paths,
    observed_summary,
    auditor,
    notes,
  }) => {
    let plan;
    try {
      plan = await buildMemoryAudit(DATA_ROOT, {
        taskId: task_id,
        tracePath: trace_path,
        contextPackPaths: context_pack_paths,
        expectedMemoryPaths: expected_memory_paths,
        observedArtifactPaths: observed_artifact_paths,
        observedSummary: observed_summary,
        auditor,
        notes,
      });
    } catch (error) {
      return jsonResult({
        ok: false,
        error: (error as Error).message,
      });
    }

    const auditPath = dataPath(plan.auditPath);
    await writeJson(auditPath, plan.audit);
    const eventLog = await appendEvent({
      event: "memory_use_audited",
      audit_id: plan.auditId,
      at: typeof plan.audit.audited_at === "string" ? plan.audit.audited_at : nowIso(),
      task_id: plan.audit.task_id,
      trace_path: plan.audit.trace_path,
      audit_path: plan.auditPath,
      trust_score: plan.audit.trust_score,
      verdict: plan.audit.verdict,
      graph_health_score:
        typeof plan.audit.graph_health_snapshot === "object" &&
        plan.audit.graph_health_snapshot !== null &&
        "score" in plan.audit.graph_health_snapshot
          ? (plan.audit.graph_health_snapshot as { score?: unknown }).score
          : null,
    });

    return jsonResult({
      ok: true,
      audit_id: plan.auditId,
      audit_path: plan.auditPath,
      event_log: eventLog,
      trust_score: plan.audit.trust_score,
      verdict: plan.audit.verdict,
      provided_memory_count: (plan.audit.counts as { provided?: number }).provided ?? 0,
      declared_used_count: (plan.audit.counts as { declared_used?: number }).declared_used ?? 0,
      observed_used_count: (plan.audit.counts as { observed_used?: number }).observed_used ?? 0,
      graph_health_snapshot: plan.audit.graph_health_snapshot,
      missing_expected_memory: plan.audit.missing_expected_memory,
      hallucinated_memory_reference: plan.audit.hallucinated_memory_reference,
    });
  },
);

server.registerTool(
  "get_context_pack",
  {
    title: "Get Context Pack",
    description: "Build a Standard Context Pack from curated DinoBrain records.",
    inputSchema: {
      question: z.string().min(1),
      limit: z.number().int().min(1).max(20).default(7),
    },
  },
  async ({ question, limit }) => {
    const { records, ranked, stats } = await getContextPackItems(DATA_ROOT, question, limit);
    const packId = makePackId(question);
    const createdAt = nowIso();
    const packPath = dataPath(".dino", "context-packs", `${packId}.json`);
    const items = ranked.map(({ path: recordPath, kind, title, summary, tags, score, reasons }) => ({
      path: recordPath,
      kind,
      title,
      summary,
      tags,
      score,
      reasons,
    }));
    const trace = {
      pack_id: packId,
      pack_type: "standard",
      question,
      created_at: createdAt,
      ranking_inputs: STANDARD_RANKING_INPUTS,
      source_roots: SEARCH_ROOTS,
      recent_task_limit: 10,
      candidate_records_excluded: true,
      review_queue_excluded: true,
      scanned_record_count: records.length,
      retrieval_mode: stats.retrieval_mode,
      index_path: stats.index_path,
      indexed_record_count: stats.index_record_count,
      index_candidate_count: stats.candidate_record_count,
      index_total_candidate_count: stats.total_candidate_count,
      index_matching_terms: stats.matching_terms,
      included_item_count: items.length,
      excluded_record_count: Math.max(0, stats.index_record_count + (stats.recent_task_count ?? 0) - ranked.length),
      items,
    };
    await writeJson(packPath, trace);
    const packRelativePath = relDataPath(packPath);
    await upsertOperationContextPack(DATA_ROOT, packRelativePath, trace);
    await upsertSqliteOperationContextPack(DATA_ROOT, contextPackEntryFromRecord(packRelativePath, trace));
    const eventLog = await appendEvent({
      event: "context_pack_created",
      pack_id: packId,
      at: createdAt,
      path: packRelativePath,
      item_count: items.length,
    });
    return jsonResult({
      ok: true,
      pack_id: packId,
      pack_type: "standard",
      question,
      data_root: DATA_ROOT,
      trace_path: packRelativePath,
      event_log: eventLog,
      ranking_inputs: trace.ranking_inputs,
      scanned_record_count: records.length,
      retrieval_mode: stats.retrieval_mode,
      index_path: stats.index_path,
      indexed_record_count: stats.index_record_count,
      index_candidate_count: stats.candidate_record_count,
      index_total_candidate_count: stats.total_candidate_count,
      item_count: items.length,
      items,
      caveats: [
        "Context Pack v0 uses a persistent Wiki index for candidate selection.",
        "Final Context Pack ranking still uses keyword/frontmatter/recent-task matching only.",
        "Candidate and review queue records are excluded from default packs.",
      ],
    });
  },
);

server.registerTool(
  "wiki_search",
  {
    title: "Wiki Search",
    description: "Search curated Wiki, Source, Project, and accepted Instance records.",
    inputSchema: {
      query: z.string().min(1),
      limit: z.number().int().min(1).max(50).default(10),
    },
  },
  async ({ query, limit }) => {
    const { ranked, stats } = await searchWiki(DATA_ROOT, query, limit);
    return jsonResult({
      ok: true,
      query,
      retrieval_mode: stats.retrieval_mode,
      index_path: stats.index_path,
      indexed_record_count: stats.index_record_count,
      candidate_record_count: stats.candidate_record_count,
      total_candidate_count: stats.total_candidate_count,
      matching_terms: stats.matching_terms,
      result_count: ranked.length,
      results: ranked,
    });
  },
);

server.registerTool(
  "import_session",
  {
    title: "Import Session",
    description: "Import a redacted session excerpt and extract pending-review memory candidates.",
    inputSchema: {
      source: z.string().min(1).default("manual"),
      project: z.string().optional(),
      title: z.string().optional(),
      transcript: z.string().optional(),
      messages: z
        .array(
          z.object({
            role: z.enum(["user", "assistant", "system", "tool", "unknown"]).default("unknown"),
            content: z.string().min(1),
            at: z.string().optional(),
          }),
        )
        .optional(),
      sensitivity: z.enum(["normal", "sensitive", "unknown"]).default("unknown"),
      max_candidates: z.number().int().min(1).max(50).default(12),
      raw_retention: z.enum(["metadata_only", "redacted_excerpt"]).default("redacted_excerpt"),
    },
  },
  async ({ source, project, title, transcript, messages, sensitivity, max_candidates, raw_retention }) => {
    let plan;
    try {
      plan = buildSessionImportPlan({
        source,
        project,
        title,
        transcript,
        messages: messages as SessionMessageInput[] | undefined,
        sensitivity,
        maxCandidates: max_candidates,
        rawRetention: raw_retention,
      });
    } catch (error) {
      return jsonResult({
        ok: false,
        error: (error as Error).message,
      });
    }

    await writeJson(dataPath(plan.archivePath), plan.archive);
    for (const candidate of plan.candidates) {
      await writeJson(dataPath(candidate.candidatePath), candidate.candidate);
      await writeJson(dataPath(candidate.reviewPath), candidate.review);
    }
    const importedAt = typeof plan.archive.imported_at === "string" ? plan.archive.imported_at : nowIso();
    const eventLog = await appendEvent({
      event: "session_imported",
      session_id: plan.sessionId,
      at: importedAt,
      source,
      project: project ?? null,
      archive_path: plan.archivePath,
      raw_retention,
      raw_full_transcript_stored: false,
      candidate_count: plan.candidates.length,
      temperature_counts: plan.stats.temperature_counts,
      category_counts: plan.stats.category_counts,
      redaction_hits: plan.stats.redaction_hits,
    });

    return jsonResult({
      ok: true,
      session_id: plan.sessionId,
      archive_path: plan.archivePath,
      event_log: eventLog,
      raw_retention,
      raw_full_transcript_stored: false,
      sync_policy: "local_only",
      candidate_count: plan.candidates.length,
      candidate_paths: plan.candidates.map((candidate) => candidate.candidatePath),
      review_paths: plan.candidates.map((candidate) => candidate.reviewPath),
      temperature_counts: plan.stats.temperature_counts,
      category_counts: plan.stats.category_counts,
      redaction_hits: plan.stats.redaction_hits,
      next_step: "Review candidates with review_candidate before they can enter accepted memory.",
    });
  },
);

server.registerTool(
  "create_candidate_instance",
  {
    title: "Create Candidate Instance",
    description: "Create a reviewed-by-default memory candidate with required evidence metadata.",
    inputSchema: {
      claim: z.string().min(1),
      evidence_snippet: z.string().min(1),
      evidence_source: z.string().min(1),
      confidence: z.enum(["low", "medium", "high"]),
      last_verified: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      source_status: z.enum(["internal", "external", "mixed", "unknown"]).default("unknown"),
      tags: z.array(z.string()).default([]),
      task_id: z.string().optional(),
      sensitivity: z.enum(["normal", "sensitive", "unknown"]).default("unknown"),
    },
  },
  async ({
    claim,
    evidence_snippet,
    evidence_source,
    confidence,
    last_verified,
    source_status,
    tags,
    task_id,
    sensitivity,
  }) => {
    const candidateId = makeCandidateId(claim);
    const createdAt = nowIso();
    const candidatePath = dataPath("50_Instances", "candidates", `${candidateId}.json`);
    const reviewPath = dataPath("80_Review_Queue", "promotion", `${candidateId}.json`);
    const candidate = {
      candidate_id: candidateId,
      status: "pending_review",
      claim,
      evidence: {
        snippet: evidence_snippet,
        source: evidence_source,
      },
      confidence,
      last_verified,
      source_status,
      tags,
      task_id: task_id ?? null,
      sensitivity,
      auto_promote: false,
      promotion_blockers: ["manual_review_required"],
      created_at: createdAt,
      updated_at: createdAt,
    };
    const review = {
      review_id: candidateId,
      type: "promotion",
      status: "pending",
      candidate_path: relDataPath(candidatePath),
      required_checks: ["evidence_snippet", "confidence", "last_verified", "sensitivity"],
      created_at: createdAt,
      updated_at: createdAt,
    };
    await writeJson(candidatePath, candidate);
    await writeJson(reviewPath, review);
    await appendEvent({
      event: "candidate_instance_created",
      candidate_id: candidateId,
      at: createdAt,
      candidate_path: relDataPath(candidatePath),
      review_path: relDataPath(reviewPath),
    });
    return jsonResult({
      ok: true,
      candidate_id: candidateId,
      candidate_path: relDataPath(candidatePath),
      review_path: relDataPath(reviewPath),
      auto_promote: false,
      reason: "Candidate instances always enter Review Queue first.",
    });
  },
);

server.registerTool(
  "review_candidate",
  {
    title: "Review Candidate",
    description: "Approve or reject a candidate instance from the Review Queue.",
    inputSchema: {
      candidate_id: z.string().min(1),
      decision: z.enum(["approve", "reject"]),
      reviewer: z.string().default("manual-review"),
      notes: z.string().default(""),
    },
  },
  async ({ candidate_id, decision, reviewer, notes }) => {
    const candidateId = safeSlug(candidate_id);
    const candidatePath = dataPath("50_Instances", "candidates", `${candidateId}.json`);
    const reviewPath = dataPath("80_Review_Queue", "promotion", `${candidateId}.json`);
    const candidate = await readJson<Record<string, unknown>>(candidatePath);
    if (!candidate) {
      return jsonResult({
        ok: false,
        candidate_id: candidateId,
        error: "candidate_not_found",
      });
    }

    const evidence = candidate.evidence;
    const hasEvidence =
      typeof evidence === "object" &&
      evidence !== null &&
      typeof (evidence as { snippet?: unknown }).snippet === "string" &&
      ((evidence as { snippet: string }).snippet.trim().length > 0);
    const hasConfidence = ["low", "medium", "high"].includes(String(candidate.confidence));
    const hasLastVerified = /^\d{4}-\d{2}-\d{2}$/.test(String(candidate.last_verified ?? ""));
    const reviewedAt = nowIso();

    if (decision === "approve" && (!hasEvidence || !hasConfidence || !hasLastVerified)) {
      await writeJson(reviewPath, {
        review_id: candidateId,
        type: "promotion",
        status: "blocked",
        candidate_path: relDataPath(candidatePath),
        decision,
        reviewer,
        notes,
        blockers: [
          !hasEvidence ? "missing_evidence_snippet" : null,
          !hasConfidence ? "missing_confidence" : null,
          !hasLastVerified ? "missing_last_verified" : null,
        ].filter(Boolean),
        reviewed_at: reviewedAt,
        updated_at: reviewedAt,
      });
      return jsonResult({
        ok: false,
        candidate_id: candidateId,
        status: "blocked",
        reason: "Claims without evidence, confidence, and last_verified cannot be promoted.",
      });
    }

    const updatedCandidate = {
      ...candidate,
      status: decision === "approve" ? "accepted" : "rejected",
      reviewed_by: reviewer,
      review_notes: notes,
      reviewed_at: reviewedAt,
      updated_at: reviewedAt,
    };
    await writeJson(candidatePath, updatedCandidate);

    let acceptedPath: string | null = null;
    if (decision === "approve") {
      acceptedPath = dataPath("50_Instances", "accepted", `${candidateId}.json`);
      await writeJson(acceptedPath, {
        ...updatedCandidate,
        accepted_at: reviewedAt,
        source_candidate_path: relDataPath(candidatePath),
      });
      await invalidateWikiIndex(DATA_ROOT);
      await invalidateSqliteWikiShard(DATA_ROOT);
    }

    await writeJson(reviewPath, {
      review_id: candidateId,
      type: "promotion",
      status: decision === "approve" ? "approved" : "rejected",
      candidate_path: relDataPath(candidatePath),
      accepted_path: acceptedPath ? relDataPath(acceptedPath) : null,
      decision,
      reviewer,
      notes,
      reviewed_at: reviewedAt,
      updated_at: reviewedAt,
    });
    await appendEvent({
      event: "candidate_instance_reviewed",
      candidate_id: candidateId,
      decision,
      at: reviewedAt,
      accepted_path: acceptedPath ? relDataPath(acceptedPath) : null,
    });

    return jsonResult({
      ok: true,
      candidate_id: candidateId,
      decision,
      candidate_path: relDataPath(candidatePath),
      review_path: relDataPath(reviewPath),
      accepted_path: acceptedPath ? relDataPath(acceptedPath) : null,
    });
  },
);

server.registerTool(
  "quarantine_record",
  {
    title: "Quarantine Record",
    description: "Mark a vault record as quarantined so default Context Packs exclude it.",
    inputSchema: {
      target_path: z.string().min(1),
      reason: z.string().min(1),
      reviewer: z.string().default("manual-review"),
      replacement_path: z.string().optional(),
    },
  },
  async ({ target_path, reason, reviewer, replacement_path }) => {
    const targetPath = normalizeVaultPath(target_path);
    const targetAbsolutePath = dataPath(targetPath);
    try {
      await fs.stat(targetAbsolutePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return jsonResult({
          ok: false,
          error: "target_not_found",
          target_path: targetPath,
        });
      }
      throw error;
    }

    const quarantineId = makeQuarantineId(targetPath);
    const createdAt = nowIso();
    const quarantinePath = dataPath(".dino", "quarantine", `${quarantineId}.json`);
    const reviewPath = dataPath("80_Review_Queue", "demotion", `${quarantineId}.json`);
    const record = {
      quarantine_id: quarantineId,
      status: "quarantined",
      target_path: targetPath,
      reason,
      reviewer,
      replacement_path: replacement_path ? normalizeVaultPath(replacement_path) : null,
      created_at: createdAt,
      updated_at: createdAt,
    };
    await writeJson(quarantinePath, record);
    await writeJson(reviewPath, {
      review_id: quarantineId,
      type: "demotion",
      status: "quarantined",
      target_path: targetPath,
      quarantine_path: relDataPath(quarantinePath),
      reason,
      reviewer,
      created_at: createdAt,
      updated_at: createdAt,
    });
    await appendEvent({
      event: "record_quarantined",
      quarantine_id: quarantineId,
      target_path: targetPath,
      at: createdAt,
    });
    await invalidateWikiIndex(DATA_ROOT);
    await invalidateSqliteWikiShard(DATA_ROOT);

    return jsonResult({
      ok: true,
      quarantine_id: quarantineId,
      target_path: targetPath,
      quarantine_path: relDataPath(quarantinePath),
      review_path: relDataPath(reviewPath),
      context_pack_effect: "excluded_from_default_context_packs",
    });
  },
);

server.registerTool(
  "git_sync",
  {
    title: "Git Sync Dry Run",
    description: "Classify data repo changes for safe git sync without committing or pushing.",
    inputSchema: {
      include_sensitive_scan: z.boolean().default(true),
    },
  },
  async ({ include_sensitive_scan }) => {
    let stdout = "";
    try {
      const result = await execFileAsync("git", ["status", "--porcelain=v1", "--untracked-files=all"], {
        cwd: DATA_ROOT,
        windowsHide: true,
      });
      stdout = result.stdout;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      return jsonResult({
        ok: false,
        unavailable: true,
        reason: code === "ENOENT" ? "git_missing" : "data_root_not_git_repository",
        dry_run: true,
        data_root: DATA_ROOT,
        changed_file_count: 0,
        would_commit: false,
        would_push: false,
        manual_approval_required: true,
        commit_allowed_by_tool: false,
        policy_version: "phase-6-dry-run",
        files: [],
        summary: {
          syncable: 0,
          conditional: 0,
          blocked: 0,
          ready_for_manual_commit: 0,
          requires_review: 0,
          do_not_sync: 0,
        },
      });
    }
    const changes = parseGitStatus(stdout);
    const files = [];
    for (const change of changes) {
      const classification = classifyPath(change.path);
      const deleted = change.status.includes("D");
      const hits = include_sensitive_scan && !deleted ? await sensitivityHits(dataPath(change.path)) : [];
      const finalClassification: SyncClassification = hits.length > 0 ? "blocked" : classification.classification;
      const reasons =
        hits.length > 0 ? [...classification.reasons, "sensitive pattern detected"] : classification.reasons;
      files.push({
        ...change,
        classification: finalClassification,
        policy: hits.length > 0 ? "sensitive_pattern_block" : classification.policy,
        reasons,
        action:
          finalClassification === "syncable"
            ? "ready_for_manual_commit"
            : finalClassification === "conditional"
              ? "requires_review"
              : "do_not_sync",
        sensitivity_scan: {
          enabled: include_sensitive_scan,
          scanned: include_sensitive_scan && !deleted,
        },
        sensitive_patterns: hits,
      });
    }
    const summary = {
      syncable: files.filter((file) => file.classification === "syncable").length,
      conditional: files.filter((file) => file.classification === "conditional").length,
      blocked: files.filter((file) => file.classification === "blocked").length,
      ready_for_manual_commit: files.filter((file) => file.action === "ready_for_manual_commit").length,
      requires_review: files.filter((file) => file.action === "requires_review").length,
      do_not_sync: files.filter((file) => file.action === "do_not_sync").length,
    };

    return jsonResult({
      ok: true,
      dry_run: true,
      data_root: DATA_ROOT,
      changed_file_count: files.length,
      would_commit: false,
      would_push: false,
      manual_approval_required: true,
      commit_allowed_by_tool: false,
      policy_version: "phase-6-dry-run",
      files,
      summary,
    });
  },
);

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
