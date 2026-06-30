import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

const execFileAsync = promisify(execFile);

const DATA_ROOT = path.resolve(
  process.env.DINOBRAIN_DATA_DIR ?? path.join(process.cwd(), "..", "dinobrain-data"),
);

type RecordValue = string | number | boolean | null | Record<string, unknown> | unknown[];

type RankedRecord = {
  path: string;
  title: string;
  summary: string;
  tags: string[];
  score: number;
  reasons: string[];
  excerpt: string;
};

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
      .map((part) => part.replace(/^#+\s+/gm, "").trim())
      .find((part) => part.length > 0) ?? ""
  ).slice(0, 420);
}

function stringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === "string") return value.split(/[, ]+/).filter(Boolean);
  return [];
}

async function walkMarkdown(dir: string, records: string[] = []): Promise<string[]> {
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
      await walkMarkdown(full, records);
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
      records.push(full);
    }
  }

  return records;
}

const SEARCH_ROOTS = [
  "20_Wiki",
  "30_Sources",
  "40_Projects",
  "50_Instances/accepted",
  "60_Operations",
  "70_Error_Book",
];

async function collectRecords(): Promise<RankedRecord[]> {
  const files: string[] = [];
  for (const root of SEARCH_ROOTS) {
    await walkMarkdown(dataPath(root), files);
  }

  const records: RankedRecord[] = [];
  for (const file of files) {
    const stat = await fs.stat(file);
    if (stat.size > 256 * 1024) continue;

    const raw = await fs.readFile(file, "utf8");
    const { metadata, body } = parseFrontmatter(raw);
    const title = String(metadata.title ?? firstHeading(body) ?? path.basename(file, ".md"));
    const summary = String(metadata.summary ?? firstParagraph(body));
    const tags = stringArray(metadata.tags);
    records.push({
      path: relDataPath(file),
      title,
      summary,
      tags,
      score: 0,
      reasons: [],
      excerpt: body.replace(/\s+/g, " ").trim().slice(0, 600),
    });
  }

  return records;
}

function rankRecords(records: RankedRecord[], query: string): RankedRecord[] {
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
        if (excerptText.includes(term)) {
          score += 1;
          reasons.push(`body excerpt matched "${term}"`);
        }
      }

      return { ...record, score, reasons: Array.from(new Set(reasons)) };
    })
    .filter((record) => record.score > 0)
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
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
    const records = await collectRecords();
    const ranked = rankRecords(records, question).slice(0, limit);
    return jsonResult({
      ok: true,
      pack_type: "standard",
      question,
      data_root: DATA_ROOT,
      ranking_inputs: ["file name", "frontmatter", "title", "summary", "tags", "body excerpt"],
      item_count: ranked.length,
      items: ranked.map(({ path: recordPath, title, summary, tags, score, reasons }) => ({
        path: recordPath,
        title,
        summary,
        tags,
        score,
        reasons,
      })),
      caveats: [
        "Context Pack v0 uses keyword/frontmatter matching only.",
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
    const records = await collectRecords();
    const ranked = rankRecords(records, query).slice(0, limit);
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

