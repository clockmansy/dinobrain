import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

type JsonObject = Record<string, unknown>;

type BehaviorSignal = {
  task_id: string;
  trace_path: string;
  kind: "decision" | "next_step" | "summary";
  behavior_rule: string;
  evidence_snippet: string;
  confidence: "low" | "medium" | "high";
};

type PromotionResult = {
  behavior_rule_id: string;
  path: string;
  action: "created" | "updated" | "unchanged" | "planned";
  behavior_rule: string;
};

type CleanupAction = {
  type: "merge_duplicate" | "hold_invalid";
  target_path: string;
  kept_path?: string;
  archive_path?: string;
  reason: string;
  applied: boolean;
};

export type CompoundingCycleOptions = {
  apply?: boolean;
  reviewer?: string;
  traceLimit?: number;
  now?: Date;
};

function nowIso(now = new Date()): string {
  return now.toISOString();
}

function dateStamp(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

function safeSlug(value: string): string {
  const slug = value
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 96);
  return slug || "node";
}

function shortHash(value: string, length = 16): string {
  return createHash("sha256").update(value).digest("hex").slice(0, length);
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

async function listJsonRecords(dataRoot: string, relativeDir: string): Promise<Array<{ path: string; record: JsonObject; mtimeMs: number }>> {
  const dir = dataPath(dataRoot, relativeDir);
  let entries: Array<import("node:fs").Dirent>;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const records = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const filePath = path.join(dir, entry.name);
    const record = await readJson<JsonObject>(filePath);
    if (!record) continue;
    const stat = await fs.stat(filePath);
    records.push({ path: relDataPath(dataRoot, filePath), record, mtimeMs: stat.mtimeMs });
  }
  return records.sort((a, b) => b.mtimeMs - a.mtimeMs || a.path.localeCompare(b.path));
}

function strings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map(String).map((item) => item.trim()).filter(Boolean);
}

function firstString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function compact(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function normalizeRule(value: string): string {
  return compact(value)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function toBehaviorRule(value: string): string {
  const text = compact(value);
  if (/^(when|before|after|always|never|do not|don't|verify|use|prefer|avoid)\b/i.test(text)) return text;
  if (/(무조건|항상|하지마|하지 말|해야|검증|확인|선호|원함|원해)/.test(text)) return text;
  return `In similar future work, apply this decision: ${text}`;
}

function hasBehaviorCue(value: string): boolean {
  return /(always|never|must|should|do not|don't|prefer|verify|check|fail-closed|before|after|무조건|항상|반드시|해야|하지마|하지 말|선호|검증|확인|기준)/i.test(value);
}

function sensitiveHits(value: string): string[] {
  const patterns: Array<[string, RegExp]> = [
    ["api_key_assignment", /api[_-]?key\s*[:=]/i],
    ["secret_assignment", /secret\s*[:=]/i],
    ["token_assignment", /token\s*[:=]/i],
    ["password_assignment", /password\s*[:=]/i],
    ["private_key_block", /BEGIN [A-Z ]*PRIVATE KEY/],
    ["openai_key_shape", /sk-[A-Za-z0-9_-]{20,}/],
    ["github_token_shape", /(?:github_pat_[A-Za-z0-9_]{20,}|(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{20,})/],
    ["aws_access_key_shape", /(?:AKIA|ASIA)[A-Z0-9]{16}/],
    ["jwt_shape", /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/],
  ];
  return patterns.filter(([, pattern]) => pattern.test(value)).map(([name]) => name);
}

function signalConfidence(trace: JsonObject, kind: BehaviorSignal["kind"]): "low" | "medium" | "high" {
  if (trace.outcome === "completed" && kind === "decision") return "high";
  if (trace.outcome === "completed") return "medium";
  return "low";
}

function extractBehaviorSignals(tracePath: string, trace: JsonObject): BehaviorSignal[] {
  const taskId = firstString(trace.task_id, path.basename(tracePath, ".json"));
  const signals: BehaviorSignal[] = [];
  const pushSignal = (kind: BehaviorSignal["kind"], raw: string): void => {
    const behaviorRule = toBehaviorRule(raw);
    if (sensitiveHits(behaviorRule).length > 0) return;
    signals.push({
      task_id: taskId,
      trace_path: tracePath,
      kind,
      behavior_rule: behaviorRule,
      evidence_snippet: compact(raw).slice(0, 700),
      confidence: signalConfidence(trace, kind),
    });
  };

  for (const decision of strings(trace.decisions)) {
    pushSignal("decision", decision);
  }
  for (const nextStep of strings(trace.next_steps).filter(hasBehaviorCue)) {
    pushSignal("next_step", nextStep);
  }
  const summary = firstString(trace.summary);
  if (summary && hasBehaviorCue(summary)) {
    pushSignal("summary", summary);
  }

  const seen = new Set<string>();
  return signals.filter((signal) => {
    const key = normalizeRule(signal.behavior_rule);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function behaviorRuleId(rule: string): string {
  return `behavior-rule-${shortHash(normalizeRule(rule))}`;
}

function evidenceSource(signal: BehaviorSignal): JsonObject {
  return {
    trace_path: signal.trace_path,
    task_id: signal.task_id,
    signal_kind: signal.kind,
    snippet: signal.evidence_snippet,
  };
}

function evidenceKey(source: JsonObject): string {
  return `${firstString(source.trace_path)}#${firstString(source.signal_kind)}#${firstString(source.snippet).slice(0, 80)}`;
}

function uniqueEvidenceSources(values: unknown[]): JsonObject[] {
  const result: JsonObject[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) continue;
    const source = value as JsonObject;
    const key = evidenceKey(source);
    if (!key.trim() || seen.has(key)) continue;
    seen.add(key);
    result.push(source);
  }
  return result;
}

async function promoteSignal(
  dataRoot: string,
  signal: BehaviorSignal,
  options: Required<Pick<CompoundingCycleOptions, "apply" | "reviewer">> & { at: string; lastVerified: string },
): Promise<PromotionResult> {
  const id = behaviorRuleId(signal.behavior_rule);
  const acceptedPath = dataPath(dataRoot, "50_Instances", "accepted", `${id}.json`);
  const relativePath = relDataPath(dataRoot, acceptedPath);
  const existing = await readJson<JsonObject>(acceptedPath);
  const newSource = evidenceSource(signal);
  const existingSources = uniqueEvidenceSources(Array.isArray(existing?.evidence_sources) ? existing.evidence_sources : []);
  const sources = uniqueEvidenceSources([...existingSources, newSource]);
  const action: PromotionResult["action"] = existing
    ? sources.length === existingSources.length
      ? "unchanged"
      : "updated"
    : "created";

  if (!options.apply) {
    return {
      behavior_rule_id: id,
      path: relativePath,
      action: "planned",
      behavior_rule: signal.behavior_rule,
    };
  }

  if (action !== "unchanged") {
    const record = {
      ...(existing ?? {}),
      behavior_rule_id: id,
      type: "behavior_rule",
      status: "accepted",
      claim: `Behavior rule: ${signal.behavior_rule}`,
      behavior_rule: signal.behavior_rule,
      category: "agent_behavior",
      evidence: {
        source: signal.trace_path,
        snippet: signal.evidence_snippet,
      },
      evidence_sources: sources,
      source_status: "internal",
      confidence: signal.confidence,
      last_verified: options.lastVerified,
      support_count: sources.length,
      tags: Array.from(
        new Set([
          "behavior-rule",
          "auto-compounded",
          `confidence:${signal.confidence}`,
          ...(Array.isArray(existing?.tags) ? existing.tags.map(String) : []),
        ]),
      ),
      auto_generated: true,
      reviewer: options.reviewer,
      created_at: firstString(existing?.created_at, options.at),
      updated_at: options.at,
      last_seen_at: options.at,
    };
    await writeJson(acceptedPath, record);
  }

  return {
    behavior_rule_id: id,
    path: relativePath,
    action,
    behavior_rule: signal.behavior_rule,
  };
}

function isBehaviorRecord(record: JsonObject): boolean {
  return (
    record.type === "behavior_rule" ||
    typeof record.behavior_rule === "string" ||
    (Array.isArray(record.tags) && record.tags.map(String).includes("behavior-rule"))
  );
}

function behaviorRecordKey(record: JsonObject): string {
  return normalizeRule(firstString(record.behavior_rule, record.claim, record.summary));
}

function hasValidEvidence(record: JsonObject): boolean {
  const evidence = record.evidence;
  if (typeof evidence !== "object" || evidence === null || Array.isArray(evidence)) return false;
  return Boolean(firstString((evidence as JsonObject).source) && firstString((evidence as JsonObject).snippet));
}

async function archiveRecord(dataRoot: string, sourcePath: string, archiveDir: string, updates: JsonObject): Promise<string> {
  const sourceAbsolute = dataPath(dataRoot, ...sourcePath.split("/"));
  const existing = await readJson<JsonObject>(sourceAbsolute);
  if (!existing) return "";
  const destination = dataPath(dataRoot, archiveDir, path.basename(sourcePath));
  await writeJson(destination, { ...existing, ...updates });
  await fs.unlink(sourceAbsolute);
  return relDataPath(dataRoot, destination);
}

async function cleanupBehaviorRules(
  dataRoot: string,
  options: Required<Pick<CompoundingCycleOptions, "apply" | "reviewer">> & { at: string },
): Promise<CleanupAction[]> {
  const accepted = (await listJsonRecords(dataRoot, "50_Instances/accepted")).filter((entry) =>
    isBehaviorRecord(entry.record),
  );
  const actions: CleanupAction[] = [];

  for (const entry of accepted) {
    if (hasValidEvidence(entry.record)) continue;
    actions.push({
      type: "hold_invalid",
      target_path: entry.path,
      reason: "behavior rule is missing durable evidence source/snippet",
      applied: false,
    });
  }

  const byRule = new Map<string, Array<{ path: string; record: JsonObject }>>();
  for (const entry of accepted) {
    const key = behaviorRecordKey(entry.record);
    if (!key) continue;
    byRule.set(key, [...(byRule.get(key) ?? []), entry]);
  }
  for (const duplicates of byRule.values()) {
    if (duplicates.length < 2) continue;
    const [keeper, ...rest] = duplicates.sort((a, b) => {
      const supportDelta = Number(b.record.support_count ?? 0) - Number(a.record.support_count ?? 0);
      if (supportDelta !== 0) return supportDelta;
      return a.path.localeCompare(b.path);
    });
    for (const duplicate of rest) {
      actions.push({
        type: "merge_duplicate",
        target_path: duplicate.path,
        kept_path: keeper?.path,
        reason: "duplicate behavior rule normalized to the same action standard",
        applied: false,
      });
    }
  }

  if (!options.apply) return actions;

  for (const action of actions) {
    if (action.type === "hold_invalid") {
      const absolutePath = dataPath(dataRoot, ...action.target_path.split("/"));
      const record = await readJson<JsonObject>(absolutePath);
      if (!record) continue;
      await writeJson(absolutePath, {
        ...record,
        status: "hold",
        quarantine: true,
        hold_reason: action.reason,
        held_by: options.reviewer,
        held_at: options.at,
        updated_at: options.at,
      });
      action.applied = true;
    }

    if (action.type === "merge_duplicate" && action.kept_path) {
      const keeperPath = dataPath(dataRoot, ...action.kept_path.split("/"));
      const duplicatePath = dataPath(dataRoot, ...action.target_path.split("/"));
      const keeper = await readJson<JsonObject>(keeperPath);
      const duplicate = await readJson<JsonObject>(duplicatePath);
      if (!keeper || !duplicate) continue;
      const sources = uniqueEvidenceSources([
        ...(Array.isArray(keeper.evidence_sources) ? keeper.evidence_sources : []),
        ...(Array.isArray(duplicate.evidence_sources) ? duplicate.evidence_sources : []),
      ]);
      await writeJson(keeperPath, {
        ...keeper,
        evidence_sources: sources,
        support_count: sources.length,
        merged_from: Array.from(new Set([...(Array.isArray(keeper.merged_from) ? keeper.merged_from.map(String) : []), action.target_path])),
        updated_at: options.at,
      });
      action.archive_path = await archiveRecord(dataRoot, action.target_path, "50_Instances/archive/merged", {
        status: "archived_merged",
        merged_into: action.kept_path,
        archived_at: options.at,
        lifecycle_action: "merge_duplicate_behavior_rule",
      });
      action.applied = Boolean(action.archive_path);
    }
  }

  return actions;
}

async function writeBehaviorRuleIndex(dataRoot: string, at: string): Promise<string> {
  const accepted = (await listJsonRecords(dataRoot, "50_Instances/accepted")).filter((entry) =>
    isBehaviorRecord(entry.record),
  );
  const indexPath = dataPath(dataRoot, "60_Operations", "behavior-rules", "behavior-rule-index.json");
  await writeJson(indexPath, {
    generated_at: at,
    record_count: accepted.length,
    records: accepted.map((entry) => ({
      path: entry.path,
      behavior_rule: firstString(entry.record.behavior_rule, entry.record.claim),
      status: firstString(entry.record.status, "unknown"),
      support_count: Number(entry.record.support_count ?? 0),
      confidence: firstString(entry.record.confidence, "unknown"),
      last_verified: firstString(entry.record.last_verified),
    })),
  });
  return relDataPath(dataRoot, indexPath);
}

export async function runCompoundingCycle(
  dataRoot: string,
  options: CompoundingCycleOptions = {},
): Promise<Record<string, unknown>> {
  const atDate = options.now ?? new Date();
  const at = nowIso(atDate);
  const apply = options.apply ?? true;
  const reviewer = options.reviewer ?? "compounding-cycle";
  const traces = (await listJsonRecords(dataRoot, ".dino/traces")).slice(0, Math.max(1, options.traceLimit ?? 50));
  const signals = traces.flatMap((entry) => extractBehaviorSignals(entry.path, entry.record));
  const promotions: PromotionResult[] = [];
  for (const signal of signals) {
    promotions.push(
      await promoteSignal(dataRoot, signal, {
        apply,
        reviewer,
        at,
        lastVerified: dateStamp(atDate),
      }),
    );
  }

  const cleanup_actions = await cleanupBehaviorRules(dataRoot, { apply, reviewer, at });
  const behavior_rule_index_path = apply ? await writeBehaviorRuleIndex(dataRoot, at) : null;
  const changed =
    promotions.some((promotion) => promotion.action === "created" || promotion.action === "updated") ||
    cleanup_actions.some((action) => action.applied);
  const cycleId = `compounding-cycle-${at.replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "-")}`;
  const cyclePath = dataPath(dataRoot, ".dino", "compounding", `${cycleId}.json`);
  const report = {
    ok: true,
    cycle_id: cycleId,
    version: "compounding_cycle_v1",
    generated_at: at,
    apply,
    reviewer,
    trace_count: traces.length,
    signal_count: signals.length,
    promoted_count: promotions.filter((promotion) => promotion.action === "created").length,
    updated_count: promotions.filter((promotion) => promotion.action === "updated").length,
    unchanged_count: promotions.filter((promotion) => promotion.action === "unchanged").length,
    cleanup_count: cleanup_actions.length,
    applied_cleanup_count: cleanup_actions.filter((action) => action.applied).length,
    changed,
    behavior_rule_index_path,
    promotions,
    cleanup_actions,
  };
  if (apply) await writeJson(cyclePath, report);
  return {
    ...report,
    cycle_path: apply ? relDataPath(dataRoot, cyclePath) : null,
  };
}
