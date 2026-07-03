import { promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";

import { buildGraphHealth, type GraphHealth } from "./graph-health.js";
import { redactSensitiveText } from "./session-ingest.js";

export type MemoryAuditInput = {
  taskId?: string;
  tracePath?: string;
  contextPackPaths: string[];
  expectedMemoryPaths: string[];
  observedArtifactPaths: string[];
  observedSummary: string;
  auditor: string;
  notes: string;
  now?: Date;
};

export type MemoryAuditPlan = {
  auditId: string;
  auditPath: string;
  audit: Record<string, unknown>;
};

type JsonObject = Record<string, unknown>;

type PackItem = {
  path: string;
  kind?: string;
  title?: string;
  summary?: string;
  score?: number;
};

function nowIso(date: Date): string {
  return date.toISOString();
}

function stamp(date: Date): string {
  return date.toISOString().replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "-");
}

function safeSlug(value: string): string {
  const slug = value
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 72);
  return slug || "audit";
}

function isInside(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!!relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}

function dataPath(dataRoot: string, ...parts: string[]): string {
  const target = path.resolve(dataRoot, ...parts);
  if (!isInside(target, dataRoot)) {
    throw new Error(`Path escapes data root: ${parts.join("/")}`);
  }
  return target;
}

function normalizeVaultPath(dataRoot: string, value: string): string {
  const normalized = value.replace(/\\/g, "/").replace(/^\/+/, "").trim();
  if (!normalized) return "";
  dataPath(dataRoot, normalized);
  return normalized;
}

function normalizeVaultPaths(dataRoot: string, values: string[]): string[] {
  return Array.from(
    new Set(
      values
        .map((value) => normalizeVaultPath(dataRoot, value))
        .filter(Boolean),
    ),
  );
}

function textArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String).filter((item) => item.trim().length > 0) : [];
}

function compactText(value: string, max = 600): string {
  const redacted = redactSensitiveText(value.replace(/\s+/g, " ").trim()).text;
  return redacted.length > max ? `${redacted.slice(0, max - 14).trimEnd()} [TRUNCATED]` : redacted;
}

async function readJson<T>(filePath: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function pathExists(dataRoot: string, vaultPath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(dataPath(dataRoot, vaultPath));
    return stat.isFile() || stat.isDirectory();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)));
}

function cap(values: string[], limit = 50): string[] {
  return values.slice(0, limit);
}

function pathKey(value: string): string {
  return value.toLowerCase();
}

function difference(left: string[], right: string[]): string[] {
  const rightSet = new Set(right.map(pathKey));
  return left.filter((value) => !rightSet.has(pathKey(value)));
}

function intersection(left: string[], right: string[]): string[] {
  const rightSet = new Set(right.map(pathKey));
  return left.filter((value) => rightSet.has(pathKey(value)));
}

function packItemPath(item: unknown): string {
  if (typeof item !== "object" || item === null || Array.isArray(item)) return "";
  const value = (item as { path?: unknown }).path;
  return typeof value === "string" ? value : "";
}

function packItemMetadata(item: unknown): PackItem | null {
  if (typeof item !== "object" || item === null || Array.isArray(item)) return null;
  const record = item as Record<string, unknown>;
  const itemPath = typeof record.path === "string" ? record.path : "";
  if (!itemPath) return null;
  return {
    path: itemPath,
    kind: typeof record.kind === "string" ? record.kind : undefined,
    title: typeof record.title === "string" ? record.title : undefined,
    summary: typeof record.summary === "string" ? record.summary : undefined,
    score: typeof record.score === "number" ? record.score : undefined,
  };
}

function traceText(trace: JsonObject, observedSummary: string): string {
  return [
    typeof trace.summary === "string" ? trace.summary : "",
    ...textArray(trace.decisions),
    ...textArray(trace.next_steps),
    observedSummary,
  ]
    .join(" ")
    .toLowerCase();
}

function evidenceHints(memoryPath: string, metadata?: PackItem): string[] {
  const basename = path.basename(memoryPath, path.extname(memoryPath));
  const title = metadata?.title ?? "";
  return unique(
    [memoryPath, basename, title]
      .join(" ")
      .toLowerCase()
      .split(/[^\p{L}\p{N}_-]+/u)
      .map((part) => part.trim())
      .filter((part) => part.length >= 4),
  );
}

function observedEvidence(memoryPath: string, observedText: string, metadata?: PackItem): string | null {
  const lowerPath = memoryPath.toLowerCase();
  if (observedText.includes(lowerPath)) return "path_mentioned";
  const hints = evidenceHints(memoryPath, metadata);
  const matched = hints.filter((hint) => observedText.includes(hint)).slice(0, 3);
  return matched.length > 0 ? `hint_matched:${matched.join(",")}` : null;
}

function scoreTrust(params: {
  provided: string[];
  declared: string[];
  declaredProvided: string[];
  observed: string[];
  expected: string[];
  missingExpected: string[];
  hallucinated: string[];
  unprovided: string[];
  graph: GraphHealth;
}): number {
  const providedScore = params.provided.length > 0 ? 15 : 0;
  const declaredScore = params.declared.length > 0 ? 20 : 0;
  const overlapScore =
    params.declared.length > 0 ? Math.round(20 * (params.declaredProvided.length / params.declared.length)) : 0;
  const observedScore =
    params.declared.length > 0 ? Math.round(20 * (params.observed.length / params.declared.length)) : 0;
  const expectedScore =
    params.expected.length > 0
      ? Math.round(10 * ((params.expected.length - params.missingExpected.length) / params.expected.length))
      : 10;
  const graphScore = Math.round(15 * (params.graph.score / 100));
  const penalty = Math.min(35, params.hallucinated.length * 15 + params.unprovided.length * 5);
  return Math.max(0, Math.min(100, providedScore + declaredScore + overlapScore + observedScore + expectedScore + graphScore - penalty));
}

function verdict(score: number): "high" | "medium" | "low" | "failed" {
  if (score >= 80) return "high";
  if (score >= 60) return "medium";
  if (score >= 40) return "low";
  return "failed";
}

export async function buildMemoryAudit(dataRoot: string, input: MemoryAuditInput): Promise<MemoryAuditPlan> {
  const now = input.now ?? new Date();
  const taskId = input.taskId?.trim() || "";
  if (!taskId && !input.tracePath) throw new Error("audit_memory_use_requires_task_id_or_trace_path");

  const tracePath = input.tracePath
    ? normalizeVaultPath(dataRoot, input.tracePath)
    : normalizeVaultPath(dataRoot, `.dino/traces/${safeSlug(taskId)}.json`);
  const trace = await readJson<JsonObject>(dataPath(dataRoot, tracePath));
  if (!trace) throw new Error(`trace_not_found:${tracePath}`);
  const traceOutcome = typeof trace.outcome === "string" ? trace.outcome : "";
  const traceFinishedAt = typeof trace.finished_at === "string" ? trace.finished_at.trim() : "";
  if (!traceFinishedAt || !["completed", "partial", "blocked"].includes(traceOutcome)) {
    throw new Error(`trace_not_finished:${tracePath}`);
  }

  const traceTaskId = typeof trace.task_id === "string" ? trace.task_id : taskId;
  const contextPackPaths = normalizeVaultPaths(dataRoot, [
    ...textArray(trace.context_pack_paths),
    ...input.contextPackPaths,
  ]);
  const expectedMemoryPaths = normalizeVaultPaths(dataRoot, input.expectedMemoryPaths);
  const observedArtifactPaths = normalizeVaultPaths(dataRoot, input.observedArtifactPaths);
  const declaredUsedPaths = normalizeVaultPaths(dataRoot, textArray(trace.used_memory_paths));
  const sessionArchivePaths = normalizeVaultPaths(dataRoot, textArray(trace.session_archive_paths));
  const candidatePaths = normalizeVaultPaths(dataRoot, textArray(trace.candidate_paths));

  const packs = (
    await Promise.all(
      contextPackPaths.map(async (packPath) => ({
        path: packPath,
        pack: await readJson<JsonObject>(dataPath(dataRoot, packPath)),
      })),
    )
  ).filter((entry): entry is { path: string; pack: JsonObject } => Boolean(entry.pack));

  const packItems = packs.flatMap((entry) => {
    const items = Array.isArray(entry.pack.items) ? entry.pack.items : [];
    return items.map(packItemMetadata).filter((item): item is PackItem => Boolean(item));
  });
  const itemByPath = new Map(packItems.map((item) => [pathKey(item.path), item]));
  const providedMemoryPaths = normalizeVaultPaths(dataRoot, packItems.map((item) => item.path));
  const observedText = traceText(trace, input.observedSummary);
  const observedUsage = declaredUsedPaths
    .map((usedPath) => {
      const evidence = observedEvidence(usedPath, observedText, itemByPath.get(pathKey(usedPath)));
      return evidence ? { path: usedPath, evidence } : null;
    })
    .filter((entry): entry is { path: string; evidence: string } => Boolean(entry));
  const observedUsedPaths = observedUsage.map((entry) => entry.path);
  const declaredProvided = intersection(declaredUsedPaths, providedMemoryPaths);
  const unprovidedUsedPaths = difference(declaredUsedPaths, providedMemoryPaths);
  const missingDeclaredPaths = (
    await Promise.all(
      unprovidedUsedPaths.map(async (usedPath) => ((await pathExists(dataRoot, usedPath)) ? null : usedPath)),
    )
  ).filter((usedPath): usedPath is string => Boolean(usedPath));
  const hallucinatedMemoryReferences = missingDeclaredPaths;
  const missingExpectedMemory = difference(expectedMemoryPaths, declaredUsedPaths);
  const expectedNotProvided = difference(expectedMemoryPaths, providedMemoryPaths);
  const referencedPaths = unique([
    ...providedMemoryPaths,
    ...declaredUsedPaths,
    ...expectedMemoryPaths,
    ...contextPackPaths,
    ...sessionArchivePaths,
    ...candidatePaths,
  ]);
  const graph = await buildGraphHealth(dataRoot, { referencedPaths });
  const trustScore = scoreTrust({
    provided: providedMemoryPaths,
    declared: declaredUsedPaths,
    declaredProvided,
    observed: observedUsedPaths,
    expected: expectedMemoryPaths,
    missingExpected: missingExpectedMemory,
    hallucinated: hallucinatedMemoryReferences,
    unprovided: difference(unprovidedUsedPaths, hallucinatedMemoryReferences),
    graph,
  });
  const auditId = `audit-${stamp(now)}-${safeSlug(traceTaskId).slice(0, 36)}-${randomUUID().slice(0, 8)}`;
  const auditPath = `.dino/audits/${auditId}.json`;
  const audit = {
    audit_id: auditId,
    type: "memory_use_audit",
    status: "completed",
    audited_at: nowIso(now),
    auditor: input.auditor,
    task_id: traceTaskId,
    trace_path: tracePath,
    trust_score: trustScore,
    verdict: verdict(trustScore),
    provided_memory_paths: cap(providedMemoryPaths),
    declared_used_memory_paths: cap(declaredUsedPaths),
    observed_used_memory_paths: cap(observedUsedPaths),
    declared_used_but_not_provided: cap(difference(unprovidedUsedPaths, hallucinatedMemoryReferences)),
    missing_expected_memory: cap(missingExpectedMemory),
    expected_memory_not_provided: cap(expectedNotProvided),
    hallucinated_memory_reference: cap(hallucinatedMemoryReferences),
    graph_health_snapshot: graph,
    observable_usage_evidence: observedUsage.slice(0, 30),
    context_pack_paths: cap(contextPackPaths),
    session_archive_paths: cap(sessionArchivePaths),
    candidate_paths: cap(candidatePaths),
    observed_artifact_paths: cap(observedArtifactPaths),
    observed_summary_preview: compactText(input.observedSummary),
    auditor_notes: compactText(input.notes),
    counts: {
      provided: providedMemoryPaths.length,
      declared_used: declaredUsedPaths.length,
      observed_used: observedUsedPaths.length,
      expected: expectedMemoryPaths.length,
      context_packs: contextPackPaths.length,
      session_archives: sessionArchivePaths.length,
      candidates: candidatePaths.length,
    },
  };

  return {
    auditId,
    auditPath,
    audit,
  };
}
