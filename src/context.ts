import { promises as fs } from "node:fs";
import path from "node:path";

type RecordValue = string | number | boolean | null | Record<string, unknown> | unknown[];

export type RankedRecord = {
  path: string;
  kind: "curated_record" | "recent_task";
  title: string;
  summary: string;
  tags: string[];
  score: number;
  reasons: string[];
  excerpt: string;
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
  "file name",
  "frontmatter",
  "title",
  "summary",
  "tags",
  "recent task records",
] as const;

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

export async function collectCuratedRecords(dataRoot: string): Promise<RankedRecord[]> {
  const files: string[] = [];
  for (const root of SEARCH_ROOTS) {
    await walkMarkdown(dataPath(dataRoot, root), files);
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
      path: relDataPath(dataRoot, file),
      kind: "curated_record",
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

export async function collectRecentTaskRecords(dataRoot: string, limit = 10): Promise<RankedRecord[]> {
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
    records.push({
      path: relDataPath(dataRoot, taskPath),
      kind: "recent_task",
      title: `Task: ${request.slice(0, 96)}`,
      summary: [
        `status=${String(task.status ?? "unknown")}`,
        task.project ? `project=${String(task.project)}` : "",
        traceSummary,
      ]
        .filter(Boolean)
        .join(" | ")
        .slice(0, 420),
      tags: ["recent-task", String(task.status ?? "unknown")],
      score: 0,
      reasons: [],
      excerpt: request,
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
  return { records, ranked: rankRecords(records, question).slice(0, limit) };
}
