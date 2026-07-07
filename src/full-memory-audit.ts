import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import { dataPath, relDataPath } from "./context.js";

export const FULL_MEMORY_AUDIT_VERSION = "full_memory_audit_v1";
export const FULL_MEMORY_STATE_DIR = ".dino/state";
export const FULL_MEMORY_MANIFEST_RELATIVE_PATH = `${FULL_MEMORY_STATE_DIR}/full_memory_manifest.json`;
export const FULL_MEMORY_AUDIT_STATUS_RELATIVE_PATH = `${FULL_MEMORY_STATE_DIR}/full_memory_audit_status.json`;

export type FileParseStatus = "ok" | "skipped" | "parse_error";
export type FileParseKind = "json" | "jsonl" | "markdown" | "text" | "binary" | "unsupported";
export type DriftClass = "none" | "live_os_write" | "review_queue_write" | "audit_artifact" | "content_drift";
export type FullMemoryAuditStatus =
  | "healthy"
  | "baseline_created"
  | "drift_classified"
  | "drift_unclassified"
  | "parse_error";

export type FileAuditEntry = {
  path: string;
  bytes: number;
  sha256: string;
  mtime: string;
  parse_kind: FileParseKind;
  parse_status: FileParseStatus;
  parse_error?: string;
};

export type FullMemoryManifest = {
  version: typeof FULL_MEMORY_AUDIT_VERSION;
  generated_at: string;
  data_root: string;
  entry_count: number;
  total_bytes: number;
  entries: FileAuditEntry[];
};

export type DriftEntry = {
  path: string;
  change: "added" | "changed" | "removed";
  drift_class: DriftClass;
  previous_sha256?: string;
  current_sha256?: string;
  previous_bytes?: number;
  current_bytes?: number;
};

export type FullMemoryAuditReport = {
  version: typeof FULL_MEMORY_AUDIT_VERSION;
  status: FullMemoryAuditStatus;
  generated_at: string;
  data_root: string;
  manifest_path: string;
  manifest_sha256: string;
  previous_manifest_seen: boolean;
  latest_file_mtime: string | null;
  counts: {
    files: number;
    bytes: number;
    parse_ok: number;
    parse_skipped: number;
    parse_error: number;
    added: number;
    changed: number;
    removed: number;
    classified_drift: number;
    unclassified_drift: number;
  };
  drift: {
    added: DriftEntry[];
    changed: DriftEntry[];
    removed: DriftEntry[];
    by_class: Record<DriftClass, number>;
  };
  parse_errors: Array<Pick<FileAuditEntry, "path" | "parse_kind" | "parse_error">>;
  warnings: string[];
  visible_status: string;
};

type BuildOptions = {
  now?: Date;
  maxDriftEntries?: number;
  maxParseErrors?: number;
};

function nowIso(date: Date): string {
  return date.toISOString();
}

function sha256(buffer: Buffer | string): string {
  return createHash("sha256").update(buffer).digest("hex");
}

function cap<T>(values: T[], limit: number): T[] {
  return values.slice(0, limit);
}

function countByClass(entries: DriftEntry[]): Record<DriftClass, number> {
  return {
    none: entries.filter((entry) => entry.drift_class === "none").length,
    live_os_write: entries.filter((entry) => entry.drift_class === "live_os_write").length,
    review_queue_write: entries.filter((entry) => entry.drift_class === "review_queue_write").length,
    audit_artifact: entries.filter((entry) => entry.drift_class === "audit_artifact").length,
    content_drift: entries.filter((entry) => entry.drift_class === "content_drift").length,
  };
}

function isIgnoredDirectory(name: string): boolean {
  return name === ".git" || name === "node_modules";
}

function parseKind(relativePath: string): FileParseKind {
  const extension = path.extname(relativePath).toLowerCase();
  if (extension === ".json") return "json";
  if (extension === ".jsonl") return "jsonl";
  if (extension === ".md") return "markdown";
  if ([".txt", ".toml", ".yml", ".yaml", ".csv", ".gitignore"].includes(extension)) return "text";
  if ([".sqlite", ".db", ".png", ".jpg", ".jpeg", ".gif", ".zip", ".exe"].includes(extension)) return "binary";
  return "unsupported";
}

function parseFile(relativePath: string, raw: Buffer): Pick<FileAuditEntry, "parse_kind" | "parse_status" | "parse_error"> {
  const kind = parseKind(relativePath);
  if (kind === "binary" || kind === "unsupported") {
    return { parse_kind: kind, parse_status: "skipped" };
  }

  const text = raw.toString("utf8");
  try {
    if (kind === "json") {
      JSON.parse(text);
      return { parse_kind: kind, parse_status: "ok" };
    }
    if (kind === "jsonl") {
      const lines = text.split(/\r?\n/);
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index].trim();
        if (!line) continue;
        try {
          JSON.parse(line);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          throw new Error(`line ${index + 1}: ${message}`);
        }
      }
      return { parse_kind: kind, parse_status: "ok" };
    }
    if (kind === "markdown") {
      if (text.startsWith("---\n") || text.startsWith("---\r\n")) {
        const match = /\r?\n---\r?\n/.exec(text.slice(4));
        if (!match) throw new Error("frontmatter_start_without_closing_marker");
      }
      return { parse_kind: kind, parse_status: "ok" };
    }
    return { parse_kind: kind, parse_status: "ok" };
  } catch (error) {
    return {
      parse_kind: kind,
      parse_status: "parse_error",
      parse_error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function walkFiles(dataRoot: string, dir: string, files: string[] = []): Promise<string[]> {
  let entries: Array<import("node:fs").Dirent>;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return files;
    throw error;
  }

  for (const entry of entries) {
    if (isIgnoredDirectory(entry.name)) continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walkFiles(dataRoot, fullPath, files);
    } else if (entry.isFile()) {
      files.push(relDataPath(dataRoot, fullPath));
    }
  }
  return files;
}

async function readPreviousManifest(dataRoot: string): Promise<FullMemoryManifest | null> {
  try {
    return JSON.parse(await fs.readFile(getFullMemoryManifestPath(dataRoot), "utf8")) as FullMemoryManifest;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    return null;
  }
}

function classifyDrift(vaultPath: string): DriftClass {
  const normalized = vaultPath.replace(/\\/g, "/");
  if (normalized.startsWith(`${FULL_MEMORY_STATE_DIR}/`)) {
    return "audit_artifact";
  }
  if (
    normalized.startsWith(".dino/events/") ||
    normalized.startsWith(".dino/tasks/") ||
    normalized.startsWith(".dino/traces/") ||
    normalized.startsWith(".dino/context-packs/") ||
    normalized.startsWith(".dino/gates/") ||
    normalized.startsWith(".dino/audits/") ||
    normalized.startsWith(".dino/compounding/") ||
    normalized.startsWith(".dino/index/") ||
    normalized.startsWith(".dino/provenance/") ||
    normalized.startsWith(".dino/quarantine/") ||
    normalized.startsWith("10_Conversations/raw/") ||
    normalized.startsWith("60_Operations/task-summaries/") ||
    normalized.startsWith("60_Operations/behavior-rules/")
  ) {
    return "live_os_write";
  }
  if (normalized.startsWith("50_Instances/candidates/") || normalized.startsWith("80_Review_Queue/")) {
    return "review_queue_write";
  }
  return "content_drift";
}

function statusFor(params: {
  previousManifestSeen: boolean;
  parseErrorCount: number;
  unclassifiedDriftCount: number;
  driftCount: number;
}): FullMemoryAuditStatus {
  if (params.parseErrorCount > 0) return "parse_error";
  if (!params.previousManifestSeen) return "baseline_created";
  if (params.unclassifiedDriftCount > 0) return "drift_unclassified";
  if (params.driftCount > 0) return "drift_classified";
  return "healthy";
}

function visibleStatus(status: FullMemoryAuditStatus): string {
  switch (status) {
    case "healthy":
      return "전체 메모리 감사 최신";
    case "baseline_created":
      return "전체 메모리 감사 기준 생성";
    case "drift_classified":
      return "전체 메모리 변화 분류 완료";
    case "drift_unclassified":
      return "전체 메모리 미분류 변경 있음";
    case "parse_error":
      return "전체 메모리 파싱 오류";
  }
}

export function getFullMemoryManifestPath(dataRoot: string): string {
  return dataPath(dataRoot, ...FULL_MEMORY_MANIFEST_RELATIVE_PATH.split("/"));
}

export function getFullMemoryAuditStatusPath(dataRoot: string): string {
  return dataPath(dataRoot, ...FULL_MEMORY_AUDIT_STATUS_RELATIVE_PATH.split("/"));
}

export async function buildFullMemoryAudit(
  dataRoot: string,
  options: BuildOptions = {},
): Promise<{ manifest: FullMemoryManifest; report: FullMemoryAuditReport }> {
  const generatedAt = nowIso(options.now ?? new Date());
  const files = (await walkFiles(dataRoot, dataRoot)).sort((a, b) => a.localeCompare(b));
  const entries: FileAuditEntry[] = [];
  for (const relativePath of files) {
    const filePath = dataPath(dataRoot, relativePath);
    const [stat, raw] = await Promise.all([fs.stat(filePath), fs.readFile(filePath)]);
    entries.push({
      path: relativePath,
      bytes: stat.size,
      sha256: sha256(raw),
      mtime: stat.mtime.toISOString(),
      ...parseFile(relativePath, raw),
    });
  }

  const previousManifest = await readPreviousManifest(dataRoot);
  const previousByPath = new Map((previousManifest?.entries ?? []).map((entry) => [entry.path, entry]));
  const currentByPath = new Map(entries.map((entry) => [entry.path, entry]));
  const added: DriftEntry[] = [];
  const changed: DriftEntry[] = [];
  const removed: DriftEntry[] = [];

  if (previousManifest) {
    for (const entry of entries) {
      const previous = previousByPath.get(entry.path);
      if (!previous) {
        added.push({
          path: entry.path,
          change: "added",
          drift_class: classifyDrift(entry.path),
          current_sha256: entry.sha256,
          current_bytes: entry.bytes,
        });
        continue;
      }
      if (previous.sha256 !== entry.sha256 || previous.bytes !== entry.bytes) {
        changed.push({
          path: entry.path,
          change: "changed",
          drift_class: classifyDrift(entry.path),
          previous_sha256: previous.sha256,
          current_sha256: entry.sha256,
          previous_bytes: previous.bytes,
          current_bytes: entry.bytes,
        });
      }
    }

    for (const previous of previousByPath.values()) {
      if (!currentByPath.has(previous.path)) {
        removed.push({
          path: previous.path,
          change: "removed",
          drift_class: classifyDrift(previous.path),
          previous_sha256: previous.sha256,
          previous_bytes: previous.bytes,
        });
      }
    }
  }

  const totalBytes = entries.reduce((sum, entry) => sum + entry.bytes, 0);
  const manifest: FullMemoryManifest = {
    version: FULL_MEMORY_AUDIT_VERSION,
    generated_at: generatedAt,
    data_root: path.resolve(dataRoot),
    entry_count: entries.length,
    total_bytes: totalBytes,
    entries,
  };
  const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
  const allDrift = [...added, ...changed, ...removed];
  const unclassifiedDriftCount = allDrift.filter((entry) => entry.drift_class === "content_drift").length;
  const parseErrors = entries
    .filter((entry) => entry.parse_status === "parse_error")
    .map((entry) => ({ path: entry.path, parse_kind: entry.parse_kind, parse_error: entry.parse_error }));
  const parseErrorCount = parseErrors.length;
  const status = statusFor({
    previousManifestSeen: Boolean(previousManifest),
    parseErrorCount,
    unclassifiedDriftCount,
    driftCount: allDrift.length,
  });
  const byClass = countByClass(allDrift);
  const warnings = [
    !previousManifest ? "no_previous_full_memory_manifest" : "",
    parseErrorCount > 0 ? "parse_errors_present" : "",
    unclassifiedDriftCount > 0 ? "unclassified_content_drift_present" : "",
  ].filter(Boolean);
  const maxDriftEntries = options.maxDriftEntries ?? 100;
  const maxParseErrors = options.maxParseErrors ?? 100;

  return {
    manifest,
    report: {
      version: FULL_MEMORY_AUDIT_VERSION,
      status,
      generated_at: generatedAt,
      data_root: path.resolve(dataRoot),
      manifest_path: FULL_MEMORY_MANIFEST_RELATIVE_PATH,
      manifest_sha256: sha256(manifestText),
      previous_manifest_seen: Boolean(previousManifest),
      latest_file_mtime:
        entries.length > 0
          ? entries.map((entry) => entry.mtime).sort((a, b) => b.localeCompare(a))[0]
          : null,
      counts: {
        files: entries.length,
        bytes: totalBytes,
        parse_ok: entries.filter((entry) => entry.parse_status === "ok").length,
        parse_skipped: entries.filter((entry) => entry.parse_status === "skipped").length,
        parse_error: parseErrorCount,
        added: added.length,
        changed: changed.length,
        removed: removed.length,
        classified_drift: allDrift.length - unclassifiedDriftCount,
        unclassified_drift: unclassifiedDriftCount,
      },
      drift: {
        added: cap(added, maxDriftEntries),
        changed: cap(changed, maxDriftEntries),
        removed: cap(removed, maxDriftEntries),
        by_class: byClass,
      },
      parse_errors: cap(parseErrors, maxParseErrors),
      warnings,
      visible_status: visibleStatus(status),
    },
  };
}

export async function buildAndWriteFullMemoryAudit(
  dataRoot: string,
  options: BuildOptions = {},
): Promise<{ manifest: FullMemoryManifest; report: FullMemoryAuditReport; manifestPath: string; statusPath: string }> {
  const result = await buildFullMemoryAudit(dataRoot, options);
  const manifestPath = getFullMemoryManifestPath(dataRoot);
  const statusPath = getFullMemoryAuditStatusPath(dataRoot);
  await fs.mkdir(path.dirname(manifestPath), { recursive: true });
  await fs.writeFile(manifestPath, `${JSON.stringify(result.manifest, null, 2)}\n`, "utf8");
  await fs.writeFile(statusPath, `${JSON.stringify(result.report, null, 2)}\n`, "utf8");
  return { ...result, manifestPath, statusPath };
}
