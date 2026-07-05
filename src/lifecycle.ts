import { promises as fs } from "node:fs";
import path from "node:path";

export type LifecycleActionType =
  | "merge_candidate"
  | "promote_review_missing"
  | "exclude_or_hold"
  | "delete_candidate"
  | "provenance_repair";

export type LifecycleAction = {
  type: LifecycleActionType;
  target_path: string;
  related_paths: string[];
  reason: string;
  applied: boolean;
  review_path?: string;
  operation_path?: string;
};

type JsonObject = Record<string, unknown>;

function nowIso(): string {
  return new Date().toISOString();
}

function safeSlug(value: string): string {
  const slug = value
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 72);
  return slug || "node";
}

function isInside(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!!relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}

function dataPath(dataRoot: string, ...parts: string[]): string {
  const target = path.resolve(dataRoot, ...parts);
  if (!isInside(target, dataRoot)) throw new Error(`Path escapes data root: ${parts.join("/")}`);
  return target;
}

function relDataPath(dataRoot: string, filePath: string): string {
  return path.relative(dataRoot, filePath).split(path.sep).join("/");
}

function normalizeVaultPath(value: string): string {
  const normalized = value.replace(/\\/g, "/").replace(/^\/+/, "");
  if (!normalized || normalized.split("/").includes("..") || path.isAbsolute(normalized)) {
    throw new Error(`Invalid vault path: ${value}`);
  }
  return normalized;
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

async function readJsonDir(dataRoot: string, relativeDir: string): Promise<Array<{ path: string; record: JsonObject }>> {
  const dir = dataPath(dataRoot, relativeDir);
  let entries: Array<import("node:fs").Dirent>;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const records: Array<{ path: string; record: JsonObject }> = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const filePath = path.join(dir, entry.name);
    const record = await readJson<JsonObject>(filePath);
    if (record) records.push({ path: relDataPath(dataRoot, filePath), record });
  }
  return records.sort((a, b) => a.path.localeCompare(b.path));
}

function firstString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function uniqueStrings(values: unknown[]): string[] {
  return Array.from(new Set(values.flatMap((value) => (Array.isArray(value) ? value : [value])).map(String).filter(Boolean)));
}

function claimKey(record: JsonObject): string {
  return firstString(record.claim, record.title, record.summary)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function sourcePath(record: JsonObject): string {
  return firstString(record.source_candidate_path, record.source_path, record.evidence_source, (record.evidence as { source?: unknown } | undefined)?.source);
}

async function pathExists(dataRoot: string, vaultPath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(dataPath(dataRoot, normalizeVaultPath(vaultPath)));
    return stat.isFile() || stat.isDirectory();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function writeReview(
  dataRoot: string,
  area: string,
  id: string,
  review: JsonObject,
): Promise<string> {
  const reviewPath = dataPath(dataRoot, "80_Review_Queue", area, `${safeSlug(id)}.json`);
  await writeJson(reviewPath, review);
  return relDataPath(dataRoot, reviewPath);
}

async function readVaultRecord(dataRoot: string, vaultPath: string): Promise<JsonObject | null> {
  return readJson<JsonObject>(dataPath(dataRoot, normalizeVaultPath(vaultPath)));
}

async function writeVaultRecord(dataRoot: string, vaultPath: string, record: JsonObject): Promise<void> {
  await writeJson(dataPath(dataRoot, normalizeVaultPath(vaultPath)), record);
}

async function archiveVaultRecord(
  dataRoot: string,
  vaultPath: string,
  archiveDir: string,
  updates: JsonObject,
): Promise<string> {
  const normalizedPath = normalizeVaultPath(vaultPath);
  const source = dataPath(dataRoot, normalizedPath);
  const existing = await readJson<JsonObject>(source);
  if (!existing) return "";
  const destination = dataPath(dataRoot, archiveDir, path.basename(normalizedPath));
  await ensureDir(path.dirname(destination));
  await writeJson(destination, { ...existing, ...updates });
  await fs.unlink(source);
  return relDataPath(dataRoot, destination);
}

async function applyPromoteReviewMissing(
  dataRoot: string,
  action: LifecycleAction,
  reviewer: string,
  appliedAt: string,
): Promise<string> {
  const id = path.basename(action.target_path, ".json");
  return writeReview(dataRoot, "promotion", id, {
    review_id: id,
    type: "promotion",
    status: "pending",
    candidate_path: action.target_path,
    required_checks: ["evidence_snippet", "confidence", "last_verified", "sensitivity"],
    reviewer,
    created_at: appliedAt,
    updated_at: appliedAt,
    source: "node_lifecycle_v2",
  });
}

async function applyDeleteCandidate(dataRoot: string, action: LifecycleAction, appliedAt: string): Promise<string> {
  return archiveVaultRecord(dataRoot, action.target_path, "50_Instances/archive/rejected", {
    status: "archived_rejected",
    archived_at: appliedAt,
    lifecycle_action: action.type,
    lifecycle_reason: action.reason,
  });
}

async function applyExcludeOrHold(dataRoot: string, action: LifecycleAction, reviewer: string, appliedAt: string): Promise<string> {
  const record = await readVaultRecord(dataRoot, action.target_path);
  if (!record) return "";
  await writeVaultRecord(dataRoot, action.target_path, {
    ...record,
    status: "hold",
    quarantine: true,
    hold_reason: action.reason,
    held_by: reviewer,
    held_at: appliedAt,
    updated_at: appliedAt,
  });
  return action.target_path;
}

async function applyMergeCandidate(dataRoot: string, action: LifecycleAction, reviewer: string, appliedAt: string): Promise<string> {
  const primary = await readVaultRecord(dataRoot, action.target_path);
  if (!primary) return "";
  const mergedFrom: string[] = uniqueStrings([primary.merged_from, ...action.related_paths]);
  const duplicateRecords = [];
  for (const relatedPath of action.related_paths) {
    const duplicate = await readVaultRecord(dataRoot, relatedPath);
    if (duplicate) duplicateRecords.push({ path: relatedPath, record: duplicate });
  }
  const tags = uniqueStrings([
    primary.tags,
    ...duplicateRecords.flatMap((entry) => (Array.isArray(entry.record.tags) ? entry.record.tags : [])),
  ]);
  await writeVaultRecord(dataRoot, action.target_path, {
    ...primary,
    tags,
    merged_from: mergedFrom,
    merge_reviewed_by: reviewer,
    merged_at: appliedAt,
    updated_at: appliedAt,
  });
  for (const duplicate of duplicateRecords) {
    await archiveVaultRecord(dataRoot, duplicate.path, "50_Instances/archive/merged", {
      ...duplicate.record,
      status: "archived_merged",
      merged_into: action.target_path,
      archived_at: appliedAt,
      lifecycle_action: action.type,
    });
  }
  return action.target_path;
}

async function applyProvenanceRepair(dataRoot: string, action: LifecycleAction, reviewer: string, appliedAt: string): Promise<string> {
  const repairId = `provenance-repair-${safeSlug(action.target_path)}`;
  const repairPath = dataPath(dataRoot, ".dino", "provenance", `${repairId}.json`);
  await writeJson(repairPath, {
    provenance_id: repairId,
    type: "provenance_repair",
    status: "pending_source",
    target_path: action.target_path,
    related_paths: action.related_paths,
    reason: action.reason,
    reviewer,
    created_at: appliedAt,
    updated_at: appliedAt,
  });
  const record = await readVaultRecord(dataRoot, action.target_path);
  if (record) {
    await writeVaultRecord(dataRoot, action.target_path, {
      ...record,
      provenance_status: "repair_required",
      provenance_repair_path: relDataPath(dataRoot, repairPath),
      updated_at: appliedAt,
    });
  }
  return relDataPath(dataRoot, repairPath);
}

async function applyAction(dataRoot: string, action: LifecycleAction, reviewer: string, appliedAt: string): Promise<string> {
  if (action.type === "promote_review_missing") return applyPromoteReviewMissing(dataRoot, action, reviewer, appliedAt);
  if (action.type === "delete_candidate") return applyDeleteCandidate(dataRoot, action, appliedAt);
  if (action.type === "exclude_or_hold") return applyExcludeOrHold(dataRoot, action, reviewer, appliedAt);
  if (action.type === "merge_candidate") return applyMergeCandidate(dataRoot, action, reviewer, appliedAt);
  if (action.type === "provenance_repair") return applyProvenanceRepair(dataRoot, action, reviewer, appliedAt);
  return "";
}

export async function applyNodeLifecycle(
  dataRoot: string,
  options: { apply: boolean; reviewer: string },
): Promise<Record<string, unknown>> {
  const appliedAt = nowIso();
  const [accepted, candidates, promotionReviews, quarantines] = await Promise.all([
    readJsonDir(dataRoot, "50_Instances/accepted"),
    readJsonDir(dataRoot, "50_Instances/candidates"),
    readJsonDir(dataRoot, "80_Review_Queue/promotion"),
    readJsonDir(dataRoot, ".dino/quarantine"),
  ]);
  const actions: LifecycleAction[] = [];
  const reviewIds = new Set(promotionReviews.map((entry) => path.basename(entry.path, ".json")));

  for (const candidate of candidates) {
    const id = path.basename(candidate.path, ".json");
    if (!reviewIds.has(id)) {
      actions.push({
        type: "promote_review_missing",
        target_path: candidate.path,
        related_paths: [],
        reason: "candidate has no promotion review record",
        applied: false,
      });
    }
    if (String(candidate.record.status ?? "") === "rejected") {
      actions.push({
        type: "delete_candidate",
        target_path: candidate.path,
        related_paths: [],
        reason: "rejected candidate should be archived after review",
        applied: false,
      });
    }
  }

  const acceptedByClaim = new Map<string, Array<{ path: string; record: JsonObject }>>();
  for (const entry of accepted) {
    const key = claimKey(entry.record);
    if (!key) continue;
    acceptedByClaim.set(key, [...(acceptedByClaim.get(key) ?? []), entry]);
  }
  for (const entries of acceptedByClaim.values()) {
    if (entries.length < 2) continue;
    actions.push({
      type: "merge_candidate",
      target_path: entries[0]?.path ?? "",
      related_paths: entries.slice(1).map((entry) => entry.path),
      reason: "accepted nodes have duplicate claim keys",
      applied: false,
    });
  }

  for (const entry of accepted) {
    const source = sourcePath(entry.record);
    if (!source) {
      actions.push({
        type: "provenance_repair",
        target_path: entry.path,
        related_paths: [],
        reason: "accepted node has no durable source/provenance mapping",
        applied: false,
      });
    } else if (!(await pathExists(dataRoot, source))) {
      actions.push({
        type: "provenance_repair",
        target_path: entry.path,
        related_paths: [source],
        reason: "accepted node points to a missing source path",
        applied: false,
      });
    }
  }

  const quarantineTargets = new Set(quarantines.map((entry) => String(entry.record.target_path ?? "")));
  for (const entry of accepted) {
    if (quarantineTargets.has(entry.path)) {
      actions.push({
        type: "exclude_or_hold",
        target_path: entry.path,
        related_paths: [],
        reason: "accepted node is also quarantined and should be held out of retrieval",
        applied: false,
      });
    }
  }

  if (options.apply) {
    for (const action of actions) {
      const id = `${action.type}-${safeSlug(action.target_path)}`;
      action.operation_path = await applyAction(dataRoot, action, options.reviewer, appliedAt);
      const review = {
        review_id: id,
        type: "node_lifecycle",
        status: action.operation_path ? "applied" : "pending",
        action: action.type,
        target_path: action.target_path,
        related_paths: action.related_paths,
        operation_path: action.operation_path ?? null,
        reason: action.reason,
        reviewer: options.reviewer,
        created_at: appliedAt,
        updated_at: appliedAt,
      };
      action.review_path = await writeReview(dataRoot, "lifecycle", id, review);
      action.applied = Boolean(action.operation_path);
    }
  }

  const lifecycleId = `lifecycle-${appliedAt.replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "-")}`;
  const reportPath = dataPath(dataRoot, ".dino", "lifecycle", `${lifecycleId}.json`);
  const report = {
    lifecycle_id: lifecycleId,
    version: "node_lifecycle_v2",
    status: actions.length === 0 ? "ready" : options.apply ? "applied_with_review" : "review_required",
    apply: options.apply,
    reviewer: options.reviewer,
    generated_at: appliedAt,
    counts: {
      accepted: accepted.length,
      candidates: candidates.length,
      promotion_reviews: promotionReviews.length,
      quarantined: quarantines.length,
      actions: actions.length,
      applied_actions: actions.filter((action) => action.applied).length,
      merge_candidates: actions.filter((action) => action.type === "merge_candidate").length,
      provenance_repairs: actions.filter((action) => action.type === "provenance_repair").length,
      delete_candidates: actions.filter((action) => action.type === "delete_candidate").length,
      hold_or_exclude: actions.filter((action) => action.type === "exclude_or_hold").length,
    },
    actions,
  };
  await writeJson(reportPath, report);
  return {
    ok: true,
    lifecycle_path: relDataPath(dataRoot, reportPath),
    ...report,
  };
}
