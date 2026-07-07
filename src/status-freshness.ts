import { promises as fs } from "node:fs";
import path from "node:path";

import { dataPath, relDataPath } from "./context.js";
import { FULL_MEMORY_AUDIT_STATUS_RELATIVE_PATH, FULL_MEMORY_STATE_DIR } from "./full-memory-audit.js";
import { GRAPH_HEALTH_RELATIVE_PATH } from "./graph-health.js";
import { OPERATIONS_INDEX_RELATIVE_PATH } from "./operations-index.js";
import { REVIEW_QUEUE_STATUS_RELATIVE_PATH, SEMANTIC_JOBS_RELATIVE_PATH } from "./review-settlement.js";
import { SQLITE_MANIFEST_RELATIVE_PATH } from "./sqlite-shards.js";
import { TASK_LIFECYCLE_STATUS_RELATIVE_PATH } from "./task-lifecycle.js";
import { WIKI_INDEX_RELATIVE_PATH } from "./wiki-index.js";

export const STATUS_FRESHNESS_VERSION = "status_freshness_v1";
export const MONITORING_STATUS_RELATIVE_PATH = `${FULL_MEMORY_STATE_DIR}/monitoring_status.json`;

export type FreshnessStatus = "healthy" | "needs_refresh" | "degraded";
export type FreshnessCheckStatus = "fresh" | "stale" | "missing" | "not_applicable";

export type FreshnessCheck = {
  id: string;
  label: string;
  artifact_path: string;
  required: boolean;
  status: FreshnessCheckStatus;
  visible_status: string;
  exists: boolean;
  generated_at: string | null;
  artifact_report_status: string | null;
  artifact_visible_status: string | null;
  artifact_mtime: string | null;
  source_latest_mtime: string | null;
  source_latest_path: string | null;
  source_file_count: number;
  source_lag_ms: number | null;
  stale_after_ms: number;
};

export type StatusFreshnessReport = {
  version: typeof STATUS_FRESHNESS_VERSION;
  status: FreshnessStatus;
  generated_at: string;
  latest_verified_at: string | null;
  data_root: string;
  stale_after_ms: number;
  checks: FreshnessCheck[];
  counts: {
    checks: number;
    fresh: number;
    stale: number;
    missing: number;
    not_applicable: number;
    required_missing: number;
  };
  warnings: string[];
  visible_status: string;
};

type BuildOptions = {
  now?: Date;
  staleAfterMs?: number;
};

type SourceLatest = {
  latest_mtime: string | null;
  latest_path: string | null;
  file_count: number;
};

type ArtifactSpec = {
  id: string;
  label: string;
  artifactPath: string;
  sourceRoots: string[];
  required: boolean;
};

const ARTIFACTS: ArtifactSpec[] = [
  {
    id: "full_memory_audit",
    label: "전체 메모리 감사",
    artifactPath: FULL_MEMORY_AUDIT_STATUS_RELATIVE_PATH,
    sourceRoots: ["."],
    required: true,
  },
  {
    id: "wiki_index",
    label: "Wiki 검색 인덱스",
    artifactPath: WIKI_INDEX_RELATIVE_PATH,
    sourceRoots: ["20_Wiki", "30_Sources", "40_Projects", "50_Instances/accepted", "60_Operations", "70_Error_Book"],
    required: true,
  },
  {
    id: "operations_index",
    label: "작업/이벤트 인덱스",
    artifactPath: OPERATIONS_INDEX_RELATIVE_PATH,
    sourceRoots: [".dino/events", ".dino/tasks", ".dino/traces", ".dino/context-packs", ".dino/gates", ".dino/audits"],
    required: true,
  },
  {
    id: "sqlite_manifest",
    label: "SQLite 샤드 manifest",
    artifactPath: SQLITE_MANIFEST_RELATIVE_PATH,
    sourceRoots: [
      "20_Wiki",
      "30_Sources",
      "40_Projects",
      "50_Instances/accepted",
      "60_Operations",
      "70_Error_Book",
      ".dino/events",
      ".dino/tasks",
      ".dino/traces",
      ".dino/context-packs",
    ],
    required: true,
  },
  {
    id: "graph_health",
    label: "그래프 health",
    artifactPath: GRAPH_HEALTH_RELATIVE_PATH,
    sourceRoots: ["20_Wiki", "30_Sources", "50_Instances/accepted", "50_Instances/candidates", "80_Review_Queue", ".dino/index"],
    required: true,
  },
  {
    id: "review_queue_settlement",
    label: "리뷰 큐 정산",
    artifactPath: REVIEW_QUEUE_STATUS_RELATIVE_PATH,
    sourceRoots: ["50_Instances/candidates", "80_Review_Queue/promotion", "50_Instances/accepted"],
    required: true,
  },
  {
    id: "semantic_jobs",
    label: "시맨틱 작업 정산",
    artifactPath: SEMANTIC_JOBS_RELATIVE_PATH,
    sourceRoots: ["50_Instances/candidates", "80_Review_Queue/promotion", "50_Instances/accepted"],
    required: true,
  },
  {
    id: "task_lifecycle",
    label: "작업 세션 완료 게이트",
    artifactPath: TASK_LIFECYCLE_STATUS_RELATIVE_PATH,
    sourceRoots: [".dino/tasks", ".dino/traces", ".dino/context-packs", ".dino/events"],
    required: true,
  },
];

function nowIso(date: Date): string {
  return date.toISOString();
}

function isIgnoredDirectory(name: string): boolean {
  return name === ".git" || name === "node_modules";
}

function isGeneratedStatusArtifact(relativePath: string): boolean {
  const normalized = relativePath.replace(/\\/g, "/");
  return normalized.startsWith(`${FULL_MEMORY_STATE_DIR}/`);
}

function toMillis(value: string | null): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

async function readArtifactMetadata(
  filePath: string,
): Promise<{ generated_at: string | null; status: string | null; visible_status: string | null }> {
  try {
    const parsed = JSON.parse(await fs.readFile(filePath, "utf8")) as Record<string, unknown>;
    return {
      generated_at: typeof parsed.generated_at === "string" ? parsed.generated_at : null,
      status: typeof parsed.status === "string" ? parsed.status : null,
      visible_status: typeof parsed.visible_status === "string" ? parsed.visible_status : null,
    };
  } catch {
    return { generated_at: null, status: null, visible_status: null };
  }
}

async function pathStat(dataRoot: string, relativePath: string): Promise<{ exists: boolean; mtime: string | null }> {
  try {
    const stat = await fs.stat(dataPath(dataRoot, relativePath));
    return { exists: true, mtime: stat.mtime.toISOString() };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { exists: false, mtime: null };
    throw error;
  }
}

async function collectLatest(
  dataRoot: string,
  rootRelativePath: string,
  accumulator: { latest: Date | null; path: string | null; count: number },
  excludedPaths: Set<string>,
): Promise<void> {
  const rootPath = rootRelativePath === "." ? dataRoot : dataPath(dataRoot, rootRelativePath);
  let entries: Array<import("node:fs").Dirent>;
  try {
    entries = await fs.readdir(rootPath, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }

  for (const entry of entries) {
    if (isIgnoredDirectory(entry.name)) continue;
    const fullPath = path.join(rootPath, entry.name);
    const relativePath = relDataPath(dataRoot, fullPath);
    if (excludedPaths.has(relativePath)) continue;
    if (isGeneratedStatusArtifact(relativePath)) continue;
    if (entry.isDirectory()) {
      await collectLatest(dataRoot, relativePath, accumulator, excludedPaths);
      continue;
    }
    if (!entry.isFile()) continue;
    const stat = await fs.stat(fullPath);
    accumulator.count += 1;
    if (!accumulator.latest || stat.mtime > accumulator.latest) {
      accumulator.latest = stat.mtime;
      accumulator.path = relativePath;
    }
  }
}

async function latestSource(dataRoot: string, roots: string[], excludedPaths: Set<string>): Promise<SourceLatest> {
  const accumulator: { latest: Date | null; path: string | null; count: number } = {
    latest: null,
    path: null,
    count: 0,
  };
  for (const root of roots) {
    await collectLatest(dataRoot, root, accumulator, excludedPaths);
  }
  return {
    latest_mtime: accumulator.latest ? accumulator.latest.toISOString() : null,
    latest_path: accumulator.path,
    file_count: accumulator.count,
  };
}

function checkVisibleStatus(label: string, status: FreshnessCheckStatus): string {
  switch (status) {
    case "fresh":
      return `${label} 최신`;
    case "stale":
      return `${label} 갱신 필요`;
    case "missing":
      return `${label} 없음`;
    case "not_applicable":
      return `${label} 소스 없음`;
  }
}

function reportVisibleStatus(status: FreshnessStatus): string {
  switch (status) {
    case "healthy":
      return "상태 신선도 정상";
    case "needs_refresh":
      return "상태 신선도 갱신 필요";
    case "degraded":
      return "상태 신선도 증거 부족";
  }
}

async function buildCheck(dataRoot: string, artifact: ArtifactSpec, staleAfterMs: number): Promise<FreshnessCheck> {
  const artifactStat = await pathStat(dataRoot, artifact.artifactPath);
  const source = await latestSource(dataRoot, artifact.sourceRoots, new Set([artifact.artifactPath]));
  const artifactMetadata = artifactStat.exists
    ? await readArtifactMetadata(dataPath(dataRoot, artifact.artifactPath))
    : { generated_at: null, status: null, visible_status: null };
  const artifactMs = toMillis(artifactStat.mtime);
  const sourceMs = toMillis(source.latest_mtime);
  const sourceLagMs = artifactMs !== null && sourceMs !== null ? sourceMs - artifactMs : null;
  let status: FreshnessCheckStatus;
  if (!artifactStat.exists) status = "missing";
  else if (source.file_count === 0) status = "not_applicable";
  else status = sourceLagMs !== null && sourceLagMs > staleAfterMs ? "stale" : "fresh";
  return {
    id: artifact.id,
    label: artifact.label,
    artifact_path: artifact.artifactPath,
    required: artifact.required,
    status,
    visible_status: checkVisibleStatus(artifact.label, status),
    exists: artifactStat.exists,
    generated_at: artifactMetadata.generated_at,
    artifact_report_status: artifactMetadata.status,
    artifact_visible_status: artifactMetadata.visible_status,
    artifact_mtime: artifactStat.mtime,
    source_latest_mtime: source.latest_mtime,
    source_latest_path: source.latest_path,
    source_file_count: source.file_count,
    source_lag_ms: sourceLagMs,
    stale_after_ms: staleAfterMs,
  };
}

export function getMonitoringStatusPath(dataRoot: string): string {
  return dataPath(dataRoot, ...MONITORING_STATUS_RELATIVE_PATH.split("/"));
}

export async function buildStatusFreshness(dataRoot: string, options: BuildOptions = {}): Promise<StatusFreshnessReport> {
  const staleAfterMs = options.staleAfterMs ?? 1000;
  const checks = await Promise.all(ARTIFACTS.map((artifact) => buildCheck(dataRoot, artifact, staleAfterMs)));
  const requiredMissing = checks.filter((check) => check.required && check.status === "missing").length;
  const stale = checks.filter((check) => check.status === "stale").length;
  const status: FreshnessStatus = requiredMissing > 0 ? "degraded" : stale > 0 ? "needs_refresh" : "healthy";
  const latestVerifiedAt =
    checks
      .filter((check) => check.status === "fresh")
      .map((check) => check.generated_at ?? check.artifact_mtime)
      .filter((value): value is string => Boolean(value))
      .sort((a, b) => b.localeCompare(a))[0] ?? null;
  const warnings = [
    requiredMissing > 0 ? "required_status_artifact_missing" : "",
    stale > 0 ? "status_artifact_stale" : "",
  ].filter(Boolean);

  return {
    version: STATUS_FRESHNESS_VERSION,
    status,
    generated_at: nowIso(options.now ?? new Date()),
    latest_verified_at: latestVerifiedAt,
    data_root: path.resolve(dataRoot),
    stale_after_ms: staleAfterMs,
    checks,
    counts: {
      checks: checks.length,
      fresh: checks.filter((check) => check.status === "fresh").length,
      stale,
      missing: checks.filter((check) => check.status === "missing").length,
      not_applicable: checks.filter((check) => check.status === "not_applicable").length,
      required_missing: requiredMissing,
    },
    warnings,
    visible_status: reportVisibleStatus(status),
  };
}

export async function buildAndWriteStatusFreshness(
  dataRoot: string,
  options: BuildOptions = {},
): Promise<{ report: StatusFreshnessReport; path: string }> {
  const report = await buildStatusFreshness(dataRoot, options);
  const reportPath = getMonitoringStatusPath(dataRoot);
  await fs.mkdir(path.dirname(reportPath), { recursive: true });
  await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return { report, path: reportPath };
}
