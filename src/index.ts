import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import {
  SEARCH_ROOTS,
  STANDARD_RANKING_INPUTS,
  collectCuratedRecords,
  getStandardPackItems,
  rankRecords,
} from "./context.js";

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

function classifyPath(normalizedPath: string): { classification: string; reasons: string[] } {
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
    return { classification: "blocked", reasons: ["path is local-only or secret-bearing"] };
  }

  if (conditionalPrefixes.some((prefix) => normalizedPath.startsWith(prefix))) {
    return { classification: "conditional", reasons: ["path requires review before sync"] };
  }

  if (syncableExact.has(normalizedPath) || syncablePrefixes.some((prefix) => normalizedPath.startsWith(prefix))) {
    return { classification: "syncable", reasons: ["path is allowed by sync policy"] };
  }

  return { classification: "conditional", reasons: ["path is not explicitly classified"] };
}

async function sensitivityHits(filePath: string): Promise<string[]> {
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
    ];
    return patterns.filter(([, pattern]) => pattern.test(text)).map(([name]) => name);
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
  version: "0.1.0",
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
    await appendJsonLine(dataPath(".dino", "events", `${dateStamp()}.jsonl`), {
      event: "task_started",
      task_id: taskId,
      at: record.created_at,
      path: relDataPath(taskPath),
    });
    return jsonResult({
      ok: true,
      task_id: taskId,
      task_path: relDataPath(taskPath),
      event_log: `.dino/events/${dateStamp()}.jsonl`,
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
    },
  },
  async ({ task_id, summary, outcome, changed_files, decisions, next_steps }) => {
    const taskPath = dataPath(".dino", "tasks", `${safeSlug(task_id)}.json`);
    const existing = (await readJson<Record<string, unknown>>(taskPath)) ?? {
      task_id,
      status: "missing_start_record",
      created_at: null,
    };
    const finishedAt = nowIso();
    const trace = {
      task_id,
      outcome,
      summary,
      changed_files,
      decisions,
      next_steps,
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
    await appendJsonLine(dataPath(".dino", "events", `${dateStamp()}.jsonl`), {
      event: "task_finished",
      task_id,
      outcome,
      at: finishedAt,
      trace_path: relDataPath(tracePath),
    });
    return jsonResult({
      ok: true,
      task_id,
      task_path: relDataPath(taskPath),
      trace_path: relDataPath(tracePath),
      event_log: `.dino/events/${dateStamp()}.jsonl`,
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
    const { records, ranked } = await getStandardPackItems(DATA_ROOT, question, limit);
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
      included_item_count: items.length,
      excluded_record_count: Math.max(0, records.length - ranked.length),
      items,
    };
    await writeJson(packPath, trace);
    await appendJsonLine(dataPath(".dino", "events", `${dateStamp()}.jsonl`), {
      event: "context_pack_created",
      pack_id: packId,
      at: createdAt,
      path: relDataPath(packPath),
      item_count: items.length,
    });
    return jsonResult({
      ok: true,
      pack_id: packId,
      pack_type: "standard",
      question,
      data_root: DATA_ROOT,
      trace_path: relDataPath(packPath),
      event_log: `.dino/events/${dateStamp()}.jsonl`,
      ranking_inputs: trace.ranking_inputs,
      scanned_record_count: records.length,
      item_count: items.length,
      items,
      caveats: [
        "Context Pack v0 uses keyword/frontmatter/recent-task matching only.",
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
    const records = await collectCuratedRecords(DATA_ROOT);
    const ranked = rankRecords(records, query, { includeExcerpt: true }).slice(0, limit);
    return jsonResult({
      ok: true,
      query,
      result_count: ranked.length,
      results: ranked,
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
    const { stdout } = await execFileAsync("git", ["status", "--porcelain=v1"], {
      cwd: DATA_ROOT,
      windowsHide: true,
    });
    const changes = parseGitStatus(stdout);
    const files = [];
    for (const change of changes) {
      const classification = classifyPath(change.path);
      const hits = include_sensitive_scan ? await sensitivityHits(dataPath(change.path)) : [];
      files.push({
        ...change,
        classification: hits.length > 0 ? "blocked" : classification.classification,
        reasons: hits.length > 0 ? [...classification.reasons, "sensitive pattern detected"] : classification.reasons,
        sensitive_patterns: hits,
      });
    }

    return jsonResult({
      ok: true,
      dry_run: true,
      data_root: DATA_ROOT,
      changed_file_count: files.length,
      would_commit: false,
      would_push: false,
      files,
      summary: {
        syncable: files.filter((file) => file.classification === "syncable").length,
        conditional: files.filter((file) => file.classification === "conditional").length,
        blocked: files.filter((file) => file.classification === "blocked").length,
      },
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
