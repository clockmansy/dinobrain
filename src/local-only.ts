import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

export const LOCAL_ONLY_MODE_VERSION = "dinobrain_local_only_v1";
export const LOCAL_ONLY_STATE_RELATIVE_PATH = ".dino/state/local-only-mode.json";
export const LOCAL_ONLY_BACKUP_STATUS_RELATIVE_PATH = ".dino/state/private-backup-status.json";

export const LOCAL_ONLY_RUNTIME_PATHS = [
  ".dino/audits/",
  ".dino/compounding/",
  ".dino/context-packs/",
  ".dino/events/",
  ".dino/gates/",
  ".dino/generations/",
  ".dino/hook-locks/",
  ".dino/index/",
  ".dino/lifecycle/",
  ".dino/local-backups/",
  ".dino/locks/",
  ".dino/migrations/",
  ".dino/proofs/",
  ".dino/state/",
  ".dino/sync-scopes/",
  ".dino/tasks/",
  ".dino/tmp/",
  ".dino/traces/",
  "reports/live-hooks/",
] as const;

export const LOCAL_ONLY_SOURCE_PATHS = [
  "15_Profile/",
  "20_Wiki/",
  "30_Sources/",
  "40_Projects/",
  "50_Instances/",
  "70_Error_Book/",
  "80_Review_Queue/",
  ".dino/evaluations/",
  ".dino/provenance/",
  ".dino/quarantine/",
] as const;

export type LocalOnlyModeRecord = {
  version: typeof LOCAL_ONLY_MODE_VERSION;
  enabled: true;
  activated_at: string;
  final_app_commit: string | null;
  final_data_commit: string | null;
  push_policy: "blocked";
  remote_policy: "fetch_only" | "detached";
  runtime_paths: readonly string[];
  source_paths: readonly string[];
  candidate_loop: "capture_review_required";
  auto_accept: false;
};

function envEnabled(): boolean {
  const mode = process.env.DINOBRAIN_MODE?.trim().toLowerCase();
  if (mode === "local_only" || mode === "local-only") return true;
  return /^(?:1|true|yes|on)$/i.test(process.env.DINOBRAIN_LOCAL_ONLY?.trim() ?? "");
}

function statePath(dataRoot: string): string {
  return path.join(path.resolve(dataRoot), ...LOCAL_ONLY_STATE_RELATIVE_PATH.split("/"));
}

export function readLocalOnlyMode(dataRoot: string): LocalOnlyModeRecord | null {
  const filePath = statePath(dataRoot);
  if (!existsSync(filePath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf8")) as Partial<LocalOnlyModeRecord>;
    if (parsed.version !== LOCAL_ONLY_MODE_VERSION || parsed.enabled !== true || parsed.push_policy !== "blocked") return null;
    return parsed as LocalOnlyModeRecord;
  } catch {
    return null;
  }
}

export function isLocalOnlyMode(dataRoot: string): boolean {
  return envEnabled() || readLocalOnlyMode(dataRoot)?.enabled === true;
}

export function localOnlyStatus(dataRoot: string): Record<string, unknown> {
  const record = readLocalOnlyMode(dataRoot);
  const enabled = envEnabled() || record?.enabled === true;
  const backupStatusPath = path.join(path.resolve(dataRoot), ...LOCAL_ONLY_BACKUP_STATUS_RELATIVE_PATH.split("/"));
  let backup: Record<string, unknown> | null = null;
  if (existsSync(backupStatusPath)) {
    try {
      backup = JSON.parse(readFileSync(backupStatusPath, "utf8")) as Record<string, unknown>;
    } catch {
      backup = { status: "invalid", path: LOCAL_ONLY_BACKUP_STATUS_RELATIVE_PATH };
    }
  }
  return {
    version: LOCAL_ONLY_MODE_VERSION,
    enabled,
    mode: enabled ? "local_only" : "remote_capable",
    push_policy: enabled ? "blocked" : "configured_by_git",
    activated_at: record?.activated_at ?? null,
    final_app_commit: record?.final_app_commit ?? null,
    final_data_commit: record?.final_data_commit ?? null,
    remote_policy: record?.remote_policy ?? null,
    source_runtime_separated: Boolean(record?.runtime_paths?.length && record?.source_paths?.length),
    candidate_loop: record?.candidate_loop ?? (enabled ? "capture_review_required" : "disabled"),
    auto_accept: false,
    runtime_paths: record?.runtime_paths ?? LOCAL_ONLY_RUNTIME_PATHS,
    source_paths: record?.source_paths ?? LOCAL_ONLY_SOURCE_PATHS,
    backup,
  };
}

export function localOnlyPushBlock(dataRoot: string, requestedPush: boolean): Record<string, unknown> | null {
  if (!requestedPush || !isLocalOnlyMode(dataRoot)) return null;
  return {
    ok: false,
    state: "blocked",
    committed: false,
    pushed: false,
    reason: "local_only_remote_push_disabled",
    mode: "local_only",
    push_policy: "blocked",
  };
}
