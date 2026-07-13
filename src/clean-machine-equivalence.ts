import { execFile, spawn } from "node:child_process";
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomUUID,
  sign,
  verify,
} from "node:crypto";
import { createWriteStream, existsSync, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import {
  buildClientMcpDirectStatus,
  type ClientMcpAgentReport,
} from "./client-mcp-direct-status.js";
import {
  canonicalJson,
  readLocalProofIdentityFingerprint,
  sha256Text,
  type ClientMcpAgent,
} from "./client-mcp-proof.js";
import { atomicCreateText, atomicWriteJson, withFileLock } from "./concurrency.js";
import { findClientLivePreResponseProof, type LivePreResponseProof } from "./live-pre-response-proof.js";
import {
  DEFAULT_PRIVATE_DATA_PATHS,
  PRIVATE_BACKUP_INVENTORY_POLICY_VERSION,
  PRIVATE_BACKUP_VERSION,
} from "./private-backup.js";
import { DINOBRAIN_DATA_CONTRACT_VERSION, DINOBRAIN_VERSION } from "./version.js";

const execFileAsync = promisify(execFile);

export const CLEAN_MACHINE_RUN_VERSION = "clean_machine_equivalence_run_v1";
export const CLEAN_MACHINE_EQUIVALENCE_VERSION = "clean_machine_equivalence_v2";
export const CLEAN_MACHINE_ATTESTATION_VERSION = "clean_machine_attestation_ed25519_v1";

export const CLEAN_MACHINE_REQUIRED_COMMANDS = [
  "status:refresh",
  "verify:live-semantic-query",
  "verify:behavior-recall",
  "observatory:verify",
  "safety:task-sync:verify",
  "hooks:data:verify",
  "verify:codex-loop",
  "installer:verify:native-result",
  "installer:verify:transaction",
  "safety:public-data:check",
] as const;

export const CLEAN_MACHINE_REQUIRED_CAPABILITIES = [
  "reviewed_memory_policy",
  "semantic_retrieval",
  "behavior_correction",
  "observatory_graph",
  "scoped_sync",
] as const;

export const CLEAN_MACHINE_REQUIRED_SCENARIOS = [
  "immutable_github_install",
  "dirty_user_config_update_regression",
  "git_missing_degraded_rejected",
  "interrupted_network_build_config_rollback",
  "github_plus_encrypted_private_restore",
  "codex_direct_mcp_and_live_pre_response",
  "claude_direct_mcp_and_live_pre_response",
] as const;

export type CleanMachineMode = "both_clients" | "codex_only";
export type ProofStatus = "PASS" | "FAIL" | "BLOCKED" | "NOT_APPLICABLE";
type JsonObject = Record<string, unknown>;

export type CleanMachineCommandReceipt = {
  command_id: (typeof CLEAN_MACHINE_REQUIRED_COMMANDS)[number];
  status: "PASS" | "FAIL";
  started_at: string;
  finished_at: string;
  elapsed_ms: number;
  exit_code: number | null;
  signal: string | null;
  stdout_sha256: string;
  stderr_sha256: string;
  stdout_bytes: number;
  stderr_bytes: number;
  peak_process_tree_working_set_bytes: number | null;
  memory_measurement: "windows_process_tree_sampled" | "unavailable";
};

export type CleanMachineRunDescriptor = {
  version: typeof CLEAN_MACHINE_RUN_VERSION;
  run_id: string;
  mode: CleanMachineMode;
  started_at: string;
  app_root: string;
  data_root: string;
  install_result_path: string | null;
  restore_receipt_path: string | null;
  installed_app_commit: string;
  installed_data_commit: string;
  app_upstream_commit: string | null;
  data_upstream_commit: string | null;
  app_repository: string | null;
  data_repository: string | null;
  expected_app_repository: string;
  expected_data_repository: string;
  install_transaction_id: string | null;
  install_started_at: string | null;
  install_finished_at: string | null;
  install_result_sha256: string | null;
  restore_receipt_sha256: string | null;
  attestation_public_key_sha256: string;
  initial_reason_codes: string[];
};

export type PublicGitIdentity = {
  repository: string | null;
  installed_commit: string;
  final_commit: string;
  upstream_commit: string | null;
  head_matches_upstream: boolean;
  installed_commit_is_ancestor: boolean;
  tracked_dirty_count: number;
  runtime_generated_tracked_dirty_count: number;
  authorized_restore_tracked_dirty_count: number;
  unexpected_tracked_dirty_count: number;
};

export type CleanMachineClientEvidence = {
  agent: ClientMcpAgent;
  status: ProofStatus;
  client_name: string | null;
  client_version: string | null;
  local_identity_fingerprint: string | null;
  challenge_id_sha256: string | null;
  direct_proof_sha256: string | null;
  direct_verified_at: string | null;
  live_pre_response: LivePreResponseProof | null;
  reason_codes: string[];
};

export type CleanMachineCapabilityEvidence = {
  id: (typeof CLEAN_MACHINE_REQUIRED_CAPABILITIES)[number];
  status: ProofStatus;
  artifact_sha256s: string[];
  command_ids: string[];
  reason_codes: string[];
  metrics: Record<string, number | boolean | null>;
};

export type CleanMachineScenarioEvidence = {
  id: (typeof CLEAN_MACHINE_REQUIRED_SCENARIOS)[number];
  status: ProofStatus;
  reason_codes: string[];
};

export type CleanMachineEvidencePayload = {
  version: typeof CLEAN_MACHINE_EQUIVALENCE_VERSION;
  status: "complete" | "diagnostic_only" | "blocked";
  generated_at: string;
  run_id: string;
  mode: CleanMachineMode;
  run_started_at: string;
  run_finished_at: string;
  os_version: string;
  data_contract_version: number;
  machine: {
    platform: string;
    architecture: string;
    attestation_public_key_sha256: string;
    local_proof_identity_fingerprint: string | null;
  };
  install: {
    status: ProofStatus;
    transaction_id_sha256: string | null;
    result_sha256: string | null;
    stage_verified: boolean;
    verification_skipped: boolean;
    full_equivalence: boolean;
    app_resolution: string | null;
    data_resolution: string | null;
    snapshot_count: number;
    reason_codes: string[];
  };
  repositories: {
    app: PublicGitIdentity;
    data: PublicGitIdentity;
  };
  recovery: {
    status: ProofStatus;
    receipt_sha256: string | null;
    backup_id_sha256: string | null;
    archive_sha256: string | null;
    inventory_sha256: string | null;
    restored_entry_count: number;
    source_app_commit: string | null;
    source_data_commit: string | null;
    source_identity_matches_install: boolean;
    reason_codes: string[];
  };
  clients: {
    codex: CleanMachineClientEvidence;
    claude: CleanMachineClientEvidence;
  };
  capabilities: CleanMachineCapabilityEvidence[];
  scenarios: CleanMachineScenarioEvidence[];
  commands: CleanMachineCommandReceipt[];
  resource_usage: {
    peak_process_tree_working_set_bytes: number | null;
    peak_process_tree_working_set_mib: number | null;
    commands_measured: number;
  };
  warnings: string[];
  blockers: string[];
};

export type CleanMachineAttestation = {
  version: typeof CLEAN_MACHINE_ATTESTATION_VERSION;
  algorithm: "ed25519";
  public_key_spki_base64: string;
  public_key_sha256: string;
  payload_sha256: string;
  signature_base64: string;
};

export type CleanMachineEquivalenceEvidence = CleanMachineEvidencePayload & {
  attestation: CleanMachineAttestation;
};

export type CleanMachineEvidenceValidation = {
  ok: boolean;
  complete: boolean;
  errors: string[];
  payload_sha256: string | null;
};

type GitState = {
  head: string;
  upstream: string | null;
  origin: string | null;
  repository: string | null;
  trackedDirtyCount: number;
  trackedDirtyPaths: string[];
};

type ArtifactState = {
  id: string;
  exists: boolean;
  status: string | null;
  generatedAt: string | null;
  warnings: string[];
  sha256: string | null;
  value: JsonObject | null;
};

type InstallState = {
  value: JsonObject | null;
  sha256: string | null;
  reasons: string[];
};

type RestoreState = {
  value: JsonObject | null;
  sha256: string | null;
  mtime: string | null;
  sourceAppCommitIsAncestor: boolean;
  reasons: string[];
};

function asObject(value: unknown): JsonObject | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : null;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asBoolean(value: unknown): boolean {
  return value === true;
}

function asNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function asStrings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0) : [];
}

function sha256Bytes(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/i.test(value);
}

function isCommit(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{40}$/i.test(value);
}

function validIso(value: unknown): boolean {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))].sort();
}

const DATA_RUNTIME_TRACKED_PREFIXES = [
  ".dino/context-packs/",
  ".dino/events/",
  ".dino/gates/",
  ".dino/index/",
  ".dino/locks/",
  ".dino/proofs/client-mcp/",
  ".dino/state/",
  ".dino/tasks/",
  ".dino/tmp/",
  ".dino/traces/",
] as const;

export function classifyCleanMachineTrackedPaths(
  repository: "app" | "data",
  paths: string[],
  options: { allowPrivateRestore?: boolean } = {},
): { runtimeGenerated: string[]; authorizedRestore: string[]; unexpected: string[] } {
  const normalized = unique(paths.map((value) => value.replace(/\\/g, "/").replace(/^\.\//, "")));
  if (repository === "app") return { runtimeGenerated: [], authorizedRestore: [], unexpected: normalized };
  const runtimeGenerated = normalized.filter((value) =>
    DATA_RUNTIME_TRACKED_PREFIXES.some((prefix) => value.startsWith(prefix)),
  );
  const runtime = new Set(runtimeGenerated);
  const authorizedRestore = options.allowPrivateRestore
    ? normalized.filter((value) =>
      !runtime.has(value) && DEFAULT_PRIVATE_DATA_PATHS.some((selector) =>
        value === selector || value.startsWith(`${selector}/`),
      )
    )
    : [];
  const allowed = new Set([...runtimeGenerated, ...authorizedRestore]);
  return {
    runtimeGenerated,
    authorizedRestore,
    unexpected: normalized.filter((value) => !allowed.has(value)),
  };
}

function defaultLocalStateRoot(): string {
  const configured = process.env.DINOBRAIN_CLEAN_MACHINE_PROOF_DIR?.trim();
  if (configured) return path.resolve(configured);
  if (process.platform === "win32" && process.env.LOCALAPPDATA) {
    return path.resolve(process.env.LOCALAPPDATA, "DinoBrain", "proofs", "clean-machine");
  }
  return path.resolve(os.homedir(), ".local", "state", "dinobrain", "proofs", "clean-machine");
}

function safeRunId(value: string): string {
  if (!/^clean-machine-[a-f0-9-]{36}$/i.test(value)) throw new Error(`Invalid clean-machine run id: ${value}`);
  return value;
}

function runDirectory(localStateRoot: string, runId: string): string {
  return path.join(path.resolve(localStateRoot), safeRunId(runId));
}

function descriptorPath(localStateRoot: string, runId: string): string {
  return path.join(runDirectory(localStateRoot, runId), "run.json");
}

function attestationKeyPath(localStateRoot: string): string {
  return path.join(path.resolve(localStateRoot), "attestation-ed25519-private.pem");
}

async function readJsonObject(filePath: string): Promise<JsonObject> {
  const parsed = asObject(JSON.parse(await fs.readFile(filePath, "utf8")));
  if (!parsed) throw new Error(`JSON root is not an object: ${filePath}`);
  return parsed;
}

async function readJsonObjectOrNull(filePath: string | null): Promise<JsonObject | null> {
  if (!filePath) return null;
  try {
    return await readJsonObject(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function fileHash(filePath: string): Promise<string> {
  return sha256Bytes(await fs.readFile(filePath));
}

async function gitText(
  root: string,
  args: string[],
  required = true,
  preserveLeadingWhitespace = false,
): Promise<string | null> {
  try {
    const result = await execFileAsync("git", ["-c", `safe.directory=${path.resolve(root)}`, "-C", root, ...args], {
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024,
    });
    const value = preserveLeadingWhitespace
      ? result.stdout.replace(/(?:\r?\n)+$/, "")
      : result.stdout.trim();
    return value || null;
  } catch (error) {
    if (required) throw error;
    return null;
  }
}

function githubRepository(remote: string | null): string | null {
  if (!remote) return null;
  const normalized = remote.trim().replace(/\\/g, "/");
  const patterns = [
    /^https?:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/i,
    /^ssh:\/\/git@github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/i,
    /^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/i,
  ];
  for (const pattern of patterns) {
    const match = normalized.match(pattern);
    if (match) return `${match[1]}/${match[2]}`.toLowerCase();
  }
  return null;
}

async function gitState(root: string): Promise<GitState> {
  const [head, branchUpstream, originMain, origin, status] = await Promise.all([
    gitText(root, ["rev-parse", "HEAD"]),
    gitText(root, ["rev-parse", "@{u}"], false),
    gitText(root, ["rev-parse", "refs/remotes/origin/main"], false),
    gitText(root, ["remote", "get-url", "origin"], false),
    gitText(root, ["status", "--porcelain=v1"], false, true),
  ]);
  if (!head || !isCommit(head)) throw new Error(`Repository HEAD is not a full commit: ${root}`);
  const lines = status?.split(/\r?\n/).filter(Boolean) ?? [];
  const trackedDirtyPaths = lines
    .filter((line) => !line.startsWith("?? "))
    .map((line) => {
      const rawPath = line.slice(3);
      const renameSeparator = rawPath.lastIndexOf(" -> ");
      const selected = renameSeparator >= 0 ? rawPath.slice(renameSeparator + 4) : rawPath;
      return selected.replace(/^"(.*)"$/, "$1").replace(/\\/g, "/");
    });
  return {
    head: head.toLowerCase(),
    upstream: branchUpstream && isCommit(branchUpstream)
      ? branchUpstream.toLowerCase()
      : originMain && isCommit(originMain)
        ? originMain.toLowerCase()
        : null,
    origin,
    repository: githubRepository(origin),
    trackedDirtyCount: trackedDirtyPaths.length,
    trackedDirtyPaths,
  };
}

async function isAncestor(root: string, ancestor: string, descendant: string): Promise<boolean> {
  try {
    await execFileAsync("git", ["-c", `safe.directory=${path.resolve(root)}`, "-C", root, "merge-base", "--is-ancestor", ancestor, descendant], {
      windowsHide: true,
    });
    return true;
  } catch {
    return false;
  }
}

function installReasons(
  value: JsonObject | null,
  app: GitState,
  data: GitState,
  appRoot: string,
  dataRoot: string,
): string[] {
  if (!value) return ["install_result_missing"];
  const appResult = asObject(value.app);
  const dataResult = asObject(value.data);
  const startedAt = Date.parse(asString(value.started_at));
  const finishedAt = Date.parse(asString(value.finished_at));
  const reasons = [
    value.version !== "dinobrain_install_transaction_v1" ? "install_result_version_invalid" : "",
    !asString(value.transaction_id) ? "install_transaction_id_missing" : "",
    !Number.isFinite(startedAt) || !Number.isFinite(finishedAt) || finishedAt < startedAt
      ? "install_timestamps_invalid"
      : "",
    value.status !== "complete" ? "install_not_complete" : "",
    !asBoolean(value.stage_verified) ? "install_stage_not_verified" : "",
    asBoolean(value.verification_skipped) ? "install_verification_skipped" : "",
    !asBoolean(value.full_equivalence) ? "install_not_full_equivalence" : "",
    appResult?.resolution !== "git_fetch" ? "app_not_git_resolved" : "",
    dataResult?.resolution !== "git_fetch" ? "data_not_git_resolved" : "",
    !isCommit(appResult?.resolved_commit) ? "app_install_commit_invalid" : "",
    !isCommit(dataResult?.resolved_commit) ? "data_install_commit_invalid" : "",
    path.resolve(asString(appResult?.target_path) || path.parse(appRoot).root) !== path.resolve(appRoot)
      ? "app_install_target_mismatch"
      : "",
    path.resolve(asString(dataResult?.target_path) || path.parse(dataRoot).root) !== path.resolve(dataRoot)
      ? "data_install_target_mismatch"
      : "",
    isCommit(appResult?.resolved_commit) && asString(appResult?.resolved_commit).toLowerCase() !== app.head
      ? "app_install_commit_not_checked_out"
      : "",
    isCommit(dataResult?.resolved_commit) && asString(dataResult?.resolved_commit).toLowerCase() !== data.head
      ? "data_install_commit_not_checked_out"
      : "",
    app.upstream !== app.head ? "app_head_not_at_upstream" : "",
    data.upstream !== data.head ? "data_head_not_at_upstream" : "",
    app.trackedDirtyCount > 0 ? "app_tracked_dirty" : "",
    data.trackedDirtyCount > 0 ? "data_tracked_dirty" : "",
  ];
  return unique(reasons);
}

async function inspectInstall(
  filePath: string | null,
  app: GitState,
  data: GitState,
  appRoot: string,
  dataRoot: string,
): Promise<InstallState> {
  const value = await readJsonObjectOrNull(filePath);
  return {
    value,
    sha256: filePath && value ? await fileHash(filePath) : null,
    reasons: installReasons(value, app, data, appRoot, dataRoot),
  };
}

async function inspectRestore(
  filePath: string | null,
  descriptor: Pick<CleanMachineRunDescriptor, "app_root" | "installed_app_commit" | "installed_data_commit" | "install_started_at">,
): Promise<RestoreState> {
  const value = await readJsonObjectOrNull(filePath);
  if (!filePath || !value) {
    return { value, sha256: null, mtime: null, sourceAppCommitIsAncestor: false, reasons: ["restore_receipt_missing"] };
  }
  const stat = await fs.stat(filePath);
  const source = asObject(value.source_identity);
  const sourceAppCommit = asString(source?.app_commit).toLowerCase();
  const sourceAppCommitIsAncestor = isCommit(sourceAppCommit)
    ? await isAncestor(descriptor.app_root, sourceAppCommit, descriptor.installed_app_commit)
    : false;
  const installStarted = descriptor.install_started_at ? Date.parse(descriptor.install_started_at) : null;
  const restoreBeforeRepairAllowanceMs = 5 * 60 * 1000;
  const reasons = unique([
    value.version !== PRIVATE_BACKUP_VERSION ? "restore_version_invalid" : "",
    value.inventory_policy_version !== PRIVATE_BACKUP_INVENTORY_POLICY_VERSION ? "restore_inventory_policy_invalid" : "",
    value.status !== "restored" || value.ok !== true ? "restore_not_verified" : "",
    !isSha256(value.archive_sha256) ? "restore_archive_hash_invalid" : "",
    !isSha256(value.inventory_sha256) ? "restore_inventory_hash_invalid" : "",
    asNumber(value.restored_entry_count) < 1 ? "restore_entry_count_empty" : "",
    !sourceAppCommitIsAncestor ? "restore_app_identity_mismatch" : "",
    asString(source?.data_commit).toLowerCase() !== descriptor.installed_data_commit ? "restore_data_identity_mismatch" : "",
    asNumber(source?.data_contract_version) !== DINOBRAIN_DATA_CONTRACT_VERSION ? "restore_contract_identity_mismatch" : "",
    installStarted !== null && stat.mtimeMs + restoreBeforeRepairAllowanceMs < installStarted
      ? "restore_receipt_predates_install"
      : "",
  ]);
  return {
    value,
    sha256: await fileHash(filePath),
    mtime: stat.mtime.toISOString(),
    sourceAppCommitIsAncestor,
    reasons,
  };
}

async function loadOrCreateAttestationKey(localStateRoot: string): Promise<{
  privateKey: ReturnType<typeof createPrivateKey>;
  publicKeyDer: Buffer;
  publicKeySha256: string;
}> {
  const filePath = attestationKeyPath(localStateRoot);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await withFileLock(`${filePath}.lock`, async () => {
    try {
      await fs.access(filePath);
      return;
    } catch {
      const pair = generateKeyPairSync("ed25519");
      const pem = pair.privateKey.export({ format: "pem", type: "pkcs8" }).toString();
      await atomicCreateText(filePath, pem, 0o600);
    }
  });
  const privateKey = createPrivateKey(await fs.readFile(filePath, "utf8"));
  const publicKeyDer = createPublicKey({
    key: privateKey.export({ format: "pem", type: "pkcs8" }),
    format: "pem",
  }).export({ format: "der", type: "spki" });
  return { privateKey, publicKeyDer, publicKeySha256: sha256Bytes(publicKeyDer) };
}

export async function beginCleanMachineEquivalenceRun(options: {
  appRoot: string;
  dataRoot: string;
  mode: CleanMachineMode;
  installResultPath?: string | null;
  restoreReceiptPath?: string | null;
  localStateRoot?: string;
  expectedAppRepository?: string;
  expectedDataRepository?: string;
  now?: Date;
}): Promise<{ descriptor: CleanMachineRunDescriptor; descriptorPath: string }> {
  const appRoot = path.resolve(options.appRoot);
  const dataRoot = path.resolve(options.dataRoot);
  const localStateRoot = path.resolve(options.localStateRoot ?? defaultLocalStateRoot());
  const expectedAppRepository = (options.expectedAppRepository ?? "clockmansy/dinobrain").toLowerCase();
  const expectedDataRepository = (options.expectedDataRepository ?? "clockmansy/dinobrain-data").toLowerCase();
  const [app, data] = await Promise.all([gitState(appRoot), gitState(dataRoot)]);
  const installResultPath = options.installResultPath ? path.resolve(options.installResultPath) : null;
  const restoreReceiptPath = options.restoreReceiptPath ? path.resolve(options.restoreReceiptPath) : null;
  const installValue = await readJsonObjectOrNull(installResultPath);
  const restore = await inspectRestore(restoreReceiptPath, {
    app_root: appRoot,
    installed_app_commit: app.head,
    installed_data_commit: data.head,
    install_started_at: asString(installValue?.started_at) || null,
  });
  const restoreVerified = restore.reasons.length === 0;
  const appDirty = classifyCleanMachineTrackedPaths("app", app.trackedDirtyPaths);
  const dataDirty = classifyCleanMachineTrackedPaths("data", data.trackedDirtyPaths, {
    allowPrivateRestore: restoreVerified,
  });
  const install: InstallState = {
    value: installValue,
    sha256: installResultPath && installValue ? await fileHash(installResultPath) : null,
    reasons: installReasons(
      installValue,
      { ...app, trackedDirtyCount: appDirty.unexpected.length },
      { ...data, trackedDirtyCount: dataDirty.unexpected.length },
      appRoot,
      dataRoot,
    ),
  };
  const repositoryReasons = unique([
    app.repository !== expectedAppRepository ? "app_github_repository_mismatch" : "",
    data.repository !== expectedDataRepository ? "data_github_repository_mismatch" : "",
  ]);
  const initialReasons = unique([
    ...install.reasons,
    ...repositoryReasons,
    ...(options.mode === "both_clients" ? restore.reasons : []),
  ]);
  if (options.mode === "both_clients" && initialReasons.length > 0) {
    throw new Error(`Clean-machine proof requires a full immutable GitHub install: ${initialReasons.join(", ")}`);
  }
  const key = await loadOrCreateAttestationKey(localStateRoot);
  const value = install.value;
  const runId = `clean-machine-${randomUUID()}`;
  const descriptor: CleanMachineRunDescriptor = {
    version: CLEAN_MACHINE_RUN_VERSION,
    run_id: runId,
    mode: options.mode,
    started_at: (options.now ?? new Date()).toISOString(),
    app_root: appRoot,
    data_root: dataRoot,
    install_result_path: installResultPath,
    restore_receipt_path: restoreReceiptPath,
    installed_app_commit: app.head,
    installed_data_commit: data.head,
    app_upstream_commit: app.upstream,
    data_upstream_commit: data.upstream,
    app_repository: app.repository,
    data_repository: data.repository,
    expected_app_repository: expectedAppRepository,
    expected_data_repository: expectedDataRepository,
    install_transaction_id: asString(value?.transaction_id) || null,
    install_started_at: asString(value?.started_at) || null,
    install_finished_at: asString(value?.finished_at) || null,
    install_result_sha256: install.sha256,
    restore_receipt_sha256: restoreReceiptPath && (await readJsonObjectOrNull(restoreReceiptPath))
      ? await fileHash(restoreReceiptPath)
      : null,
    attestation_public_key_sha256: key.publicKeySha256,
    initial_reason_codes: initialReasons,
  };
  const filePath = descriptorPath(localStateRoot, runId);
  await atomicWriteJson(filePath, descriptor);
  return { descriptor, descriptorPath: filePath };
}

export async function loadCleanMachineRunDescriptor(
  runId: string,
  localStateRoot = defaultLocalStateRoot(),
): Promise<{ descriptor: CleanMachineRunDescriptor; descriptorPath: string; runDirectory: string }> {
  const filePath = descriptorPath(localStateRoot, runId);
  const parsed = (await readJsonObject(filePath)) as Partial<CleanMachineRunDescriptor>;
  if (parsed.version !== CLEAN_MACHINE_RUN_VERSION || parsed.run_id !== runId) {
    throw new Error(`Clean-machine run descriptor is invalid: ${filePath}`);
  }
  return {
    descriptor: parsed as CleanMachineRunDescriptor,
    descriptorPath: filePath,
    runDirectory: runDirectory(localStateRoot, runId),
  };
}

function emptyHash(): string {
  return sha256Text("");
}

function startWindowsProcessTreeWatcher(rootPid: number): Promise<number | null> {
  if (process.platform !== "win32") return Promise.resolve(null);
  const script = String.raw`
$ErrorActionPreference = 'SilentlyContinue'
$rootPid = [int]$env:DINOBRAIN_WATCH_ROOT_PID
$peak = [int64]0
while ($true) {
  $rows = @(Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId)
  $ids = New-Object 'System.Collections.Generic.HashSet[int]'
  [void]$ids.Add($rootPid)
  $changed = $true
  while ($changed) {
    $changed = $false
    foreach ($row in $rows) {
      if ($ids.Contains([int]$row.ParentProcessId) -and $ids.Add([int]$row.ProcessId)) { $changed = $true }
    }
  }
  $working = [int64]0
  foreach ($id in $ids) {
    $proc = Get-Process -Id $id -ErrorAction SilentlyContinue
    if ($proc) { $working += [int64]$proc.WorkingSet64 }
  }
  if ($working -gt $peak) { $peak = $working }
  if (-not (Get-Process -Id $rootPid -ErrorAction SilentlyContinue)) { break }
  Start-Sleep -Milliseconds 750
}
[Console]::Out.WriteLine([string]$peak)
`;
  return new Promise((resolve) => {
    const watcher = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
      windowsHide: true,
      env: { ...process.env, DINOBRAIN_WATCH_ROOT_PID: String(rootPid) },
      stdio: ["ignore", "pipe", "ignore"],
    });
    let stdout = "";
    watcher.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    watcher.on("error", () => resolve(null));
    watcher.on("close", () => {
      const value = Number(stdout.trim().split(/\r?\n/).at(-1));
      resolve(Number.isFinite(value) && value >= 0 ? value : null);
    });
  });
}

async function runNpmScript(params: {
  appRoot: string;
  dataRoot: string;
  runDirectory: string;
  commandId: (typeof CLEAN_MACHINE_REQUIRED_COMMANDS)[number];
}): Promise<CleanMachineCommandReceipt> {
  const safeId = params.commandId.replace(/[^A-Za-z0-9._-]+/g, "-");
  const stdoutPath = path.join(params.runDirectory, "logs", `${safeId}.stdout.log`);
  const stderrPath = path.join(params.runDirectory, "logs", `${safeId}.stderr.log`);
  await fs.mkdir(path.dirname(stdoutPath), { recursive: true });
  const stdoutFile = createWriteStream(stdoutPath, { flags: "w" });
  const stderrFile = createWriteStream(stderrPath, { flags: "w" });
  const stdoutHash = createHash("sha256");
  const stderrHash = createHash("sha256");
  let stdoutBytes = 0;
  let stderrBytes = 0;
  const started = new Date();
  const npmExecPath = process.env.npm_execpath;
  const siblingNpm = path.join(path.dirname(process.execPath), process.platform === "win32" ? "npm.cmd" : "npm");
  const command = npmExecPath
    ? process.execPath
    : existsSync(siblingNpm)
      ? siblingNpm
      : process.platform === "win32" ? "npm.cmd" : "npm";
  const args = npmExecPath ? [npmExecPath, "run", params.commandId] : ["run", params.commandId];
  const child = spawn(command, args, {
    cwd: params.appRoot,
    windowsHide: true,
    shell: false,
    env: { ...process.env, DINOBRAIN_DATA_DIR: params.dataRoot },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const memory = child.pid ? startWindowsProcessTreeWatcher(child.pid) : Promise.resolve(null);
  child.stdout.on("data", (chunk: Buffer) => {
    stdoutHash.update(chunk);
    stdoutBytes += chunk.length;
    stdoutFile.write(chunk);
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderrHash.update(chunk);
    stderrBytes += chunk.length;
    stderrFile.write(chunk);
  });
  const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    let settled = false;
    const settle = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (settled) return;
      settled = true;
      resolve({ code, signal });
    };
    child.on("error", (error) => {
      const message = Buffer.from(`${error instanceof Error ? error.message : String(error)}\n`, "utf8");
      stderrHash.update(message);
      stderrBytes += message.length;
      stderrFile.write(message);
      settle(null, null);
    });
    child.on("close", (code, signal) => settle(code, signal));
  });
  stdoutFile.end();
  stderrFile.end();
  await Promise.all([
    new Promise<void>((resolve) => stdoutFile.on("finish", () => resolve())),
    new Promise<void>((resolve) => stderrFile.on("finish", () => resolve())),
  ]);
  const peak = await memory;
  const finished = new Date();
  return {
    command_id: params.commandId,
    status: result.code === 0 ? "PASS" : "FAIL",
    started_at: started.toISOString(),
    finished_at: finished.toISOString(),
    elapsed_ms: finished.getTime() - started.getTime(),
    exit_code: result.code,
    signal: result.signal,
    stdout_sha256: stdoutBytes > 0 ? stdoutHash.digest("hex") : emptyHash(),
    stderr_sha256: stderrBytes > 0 ? stderrHash.digest("hex") : emptyHash(),
    stdout_bytes: stdoutBytes,
    stderr_bytes: stderrBytes,
    peak_process_tree_working_set_bytes: peak,
    memory_measurement: peak === null ? "unavailable" : "windows_process_tree_sampled",
  };
}

export async function runCleanMachineVerificationCommands(options: {
  appRoot: string;
  dataRoot: string;
  runDirectory: string;
}): Promise<CleanMachineCommandReceipt[]> {
  const receipts: CleanMachineCommandReceipt[] = [];
  for (const commandId of CLEAN_MACHINE_REQUIRED_COMMANDS) {
    receipts.push(await runNpmScript({ ...options, commandId }));
  }
  await atomicWriteJson(path.join(options.runDirectory, "command-receipts.json"), {
    version: "clean_machine_command_receipts_v1",
    generated_at: new Date().toISOString(),
    receipts,
  });
  return receipts;
}

async function readArtifact(dataRoot: string, id: string, relativePath: string): Promise<ArtifactState> {
  const filePath = path.resolve(dataRoot, ...relativePath.split("/"));
  try {
    const raw = await fs.readFile(filePath);
    const value = asObject(JSON.parse(raw.toString("utf8")));
    if (!value) throw new Error("artifact root is not an object");
    return {
      id,
      exists: true,
      status: asString(value.status) || null,
      generatedAt: asString(value.generated_at) || null,
      warnings: asStrings(value.warnings),
      sha256: sha256Bytes(raw),
      value,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      return { id, exists: true, status: null, generatedAt: null, warnings: ["artifact_invalid"], sha256: null, value: null };
    }
    return { id, exists: false, status: null, generatedAt: null, warnings: [], sha256: null, value: null };
  }
}

function artifactPass(artifact: ArtifactState, accepted: string[], since: string): { pass: boolean; reasons: string[] } {
  const generated = artifact.generatedAt ? Date.parse(artifact.generatedAt) : NaN;
  const baseline = Date.parse(since);
  const reasons = unique([
    !artifact.exists ? `${artifact.id}_missing` : "",
    artifact.exists && !artifact.value ? `${artifact.id}_invalid` : "",
    artifact.status && !accepted.includes(artifact.status) ? `${artifact.id}_status_${artifact.status}` : "",
    !artifact.status ? `${artifact.id}_status_missing` : "",
    !Number.isFinite(generated) || generated + 5_000 < baseline ? `${artifact.id}_stale_for_run` : "",
    artifact.warnings.length > 0 ? `${artifact.id}_warnings_present` : "",
  ]);
  return { pass: reasons.length === 0, reasons };
}

function commandMap(receipts: CleanMachineCommandReceipt[]): Map<string, CleanMachineCommandReceipt> {
  return new Map(receipts.map((receipt) => [receipt.command_id, receipt]));
}

function commandReasons(receipts: Map<string, CleanMachineCommandReceipt>, ids: string[]): string[] {
  return unique(ids.map((id) => {
    const receipt = receipts.get(id);
    return !receipt ? `command_missing:${id}` : receipt.status !== "PASS" ? `command_failed:${id}` : "";
  }));
}

function artifactHashes(artifacts: ArtifactState[]): string[] {
  return artifacts.map((artifact) => artifact.sha256).filter((value): value is string => Boolean(value));
}

function countMetric(artifact: ArtifactState, key: string): number {
  return asNumber(asObject(artifact.value?.counts)?.[key]);
}

function makeCapability(params: {
  id: CleanMachineCapabilityEvidence["id"];
  artifacts: Array<{ artifact: ArtifactState; accepted: string[] }>;
  commands: string[];
  receipts: Map<string, CleanMachineCommandReceipt>;
  since: string;
  metrics: Record<string, number | boolean | null>;
}): CleanMachineCapabilityEvidence {
  const artifactReasons = params.artifacts.flatMap(({ artifact, accepted }) => artifactPass(artifact, accepted, params.since).reasons);
  const reasons = unique([...artifactReasons, ...commandReasons(params.receipts, params.commands)]);
  return {
    id: params.id,
    status: reasons.length === 0 ? "PASS" : "FAIL",
    artifact_sha256s: artifactHashes(params.artifacts.map((entry) => entry.artifact)),
    command_ids: params.commands,
    reason_codes: reasons,
    metrics: params.metrics,
  };
}

function directReportReasons(report: ClientMcpAgentReport | undefined, since: string): string[] {
  const verifiedAt = report?.latest_verified_at ? Date.parse(report.latest_verified_at) : NaN;
  return unique([
    !report ? "direct_mcp_agent_report_missing" : "",
    report?.status !== "verified" ? `direct_mcp_${report?.status ?? "missing"}` : "",
    !report?.challenge_id ? "direct_mcp_challenge_missing" : "",
    !isSha256(report?.proof_sha256) ? "direct_mcp_proof_hash_invalid" : "",
    !Number.isFinite(verifiedAt) || verifiedAt < Date.parse(since) ? "direct_mcp_proof_predates_run" : "",
    !report?.local_identity_fingerprint ? "direct_mcp_local_identity_missing" : "",
  ]);
}

async function clientEvidence(params: {
  agent: ClientMcpAgent;
  report: ClientMcpAgentReport | undefined;
  appRoot: string;
  dataRoot: string;
  since: string;
  required: boolean;
}): Promise<CleanMachineClientEvidence> {
  if (!params.required) {
    return {
      agent: params.agent,
      status: "NOT_APPLICABLE",
      client_name: params.report?.client_name ?? null,
      client_version: params.report?.client_version ?? null,
      local_identity_fingerprint: params.report?.local_identity_fingerprint ?? null,
      challenge_id_sha256: null,
      direct_proof_sha256: null,
      direct_verified_at: null,
      live_pre_response: null,
      reason_codes: ["codex_only_diagnostic"],
    };
  }
  const reasons = directReportReasons(params.report, params.since);
  let live: LivePreResponseProof | null = null;
  if (reasons.length === 0 && params.report?.challenge_id) {
    const result = await findClientLivePreResponseProof({
      appRoot: params.appRoot,
      dataRoot: params.dataRoot,
      agent: params.agent,
      since: params.since,
      challengeId: params.report.challenge_id,
    });
    if (result.ok) live = result.proof;
    else reasons.push(...result.reason_codes);
  }
  return {
    agent: params.agent,
    status: reasons.length === 0 && live ? "PASS" : "FAIL",
    client_name: params.report?.client_name ?? null,
    client_version: params.report?.client_version ?? null,
    local_identity_fingerprint: params.report?.local_identity_fingerprint ?? null,
    challenge_id_sha256: params.report?.challenge_id ? sha256Text(params.report.challenge_id) : null,
    direct_proof_sha256: params.report?.proof_sha256 ?? null,
    direct_verified_at: params.report?.latest_verified_at ?? null,
    live_pre_response: live,
    reason_codes: unique(reasons),
  };
}

function publicGitIdentity(
  state: GitState,
  installedCommit: string,
  ancestor: boolean,
  classification: { runtimeGenerated: string[]; authorizedRestore: string[]; unexpected: string[] },
): PublicGitIdentity {
  return {
    repository: state.repository,
    installed_commit: installedCommit,
    final_commit: state.head,
    upstream_commit: state.upstream,
    head_matches_upstream: state.upstream === state.head,
    installed_commit_is_ancestor: ancestor,
    tracked_dirty_count: state.trackedDirtyCount,
    runtime_generated_tracked_dirty_count: classification.runtimeGenerated.length,
    authorized_restore_tracked_dirty_count: classification.authorizedRestore.length,
    unexpected_tracked_dirty_count: classification.unexpected.length,
  };
}

function installEvidence(install: InstallState, descriptor: CleanMachineRunDescriptor): CleanMachineEvidencePayload["install"] {
  const value = install.value;
  const app = asObject(value?.app);
  const data = asObject(value?.data);
  const reasons = unique([
    ...descriptor.initial_reason_codes,
    ...install.reasons,
    descriptor.install_result_sha256 && install.sha256 !== descriptor.install_result_sha256 ? "install_result_changed_after_run_start" : "",
  ]);
  return {
    status: reasons.length === 0 ? "PASS" : "FAIL",
    transaction_id_sha256: descriptor.install_transaction_id ? sha256Text(descriptor.install_transaction_id) : null,
    result_sha256: install.sha256,
    stage_verified: asBoolean(value?.stage_verified),
    verification_skipped: asBoolean(value?.verification_skipped),
    full_equivalence: asBoolean(value?.full_equivalence),
    app_resolution: asString(app?.resolution) || null,
    data_resolution: asString(data?.resolution) || null,
    snapshot_count: asNumber(value?.snapshot_count),
    reason_codes: reasons,
  };
}

function recoveryEvidence(restore: RestoreState, descriptor: CleanMachineRunDescriptor): CleanMachineEvidencePayload["recovery"] {
  const source = asObject(restore.value?.source_identity);
  const reasons = unique([
    ...restore.reasons,
    descriptor.restore_receipt_sha256 && restore.sha256 !== descriptor.restore_receipt_sha256
      ? "restore_receipt_changed_after_run_start"
      : "",
  ]);
  const sourceApp = asString(source?.app_commit).toLowerCase() || null;
  const sourceData = asString(source?.data_commit).toLowerCase() || null;
  return {
    status: reasons.length === 0 ? "PASS" : "FAIL",
    receipt_sha256: restore.sha256,
    backup_id_sha256: asString(restore.value?.backup_id) ? sha256Text(asString(restore.value?.backup_id)) : null,
    archive_sha256: isSha256(restore.value?.archive_sha256) ? asString(restore.value?.archive_sha256).toLowerCase() : null,
    inventory_sha256: isSha256(restore.value?.inventory_sha256) ? asString(restore.value?.inventory_sha256).toLowerCase() : null,
    restored_entry_count: asNumber(restore.value?.restored_entry_count),
    source_app_commit: sourceApp,
    source_data_commit: sourceData,
    source_identity_matches_install:
      restore.sourceAppCommitIsAncestor && sourceData === descriptor.installed_data_commit,
    reason_codes: reasons,
  };
}

function scenario(
  id: CleanMachineScenarioEvidence["id"],
  pass: boolean,
  failureReason: string,
): CleanMachineScenarioEvidence {
  return { id, status: pass ? "PASS" : "FAIL", reason_codes: pass ? [] : [failureReason] };
}

export async function signCleanMachineEquivalenceEvidence(
  payload: CleanMachineEvidencePayload,
  localStateRoot = defaultLocalStateRoot(),
): Promise<CleanMachineEquivalenceEvidence> {
  const key = await loadOrCreateAttestationKey(localStateRoot);
  const canonical = canonicalJson(payload);
  const payloadSha256 = sha256Text(canonical);
  const signature = sign(null, Buffer.from(canonical, "utf8"), key.privateKey);
  return {
    ...payload,
    attestation: {
      version: CLEAN_MACHINE_ATTESTATION_VERSION,
      algorithm: "ed25519",
      public_key_spki_base64: key.publicKeyDer.toString("base64"),
      public_key_sha256: key.publicKeySha256,
      payload_sha256: payloadSha256,
      signature_base64: signature.toString("base64"),
    },
  };
}

export async function finalizeCleanMachineEquivalenceRun(options: {
  descriptor: CleanMachineRunDescriptor;
  commandReceipts: CleanMachineCommandReceipt[];
  localStateRoot?: string;
  outputPath?: string;
  now?: Date;
}): Promise<{ evidence: CleanMachineEquivalenceEvidence; outputPath: string; validation: CleanMachineEvidenceValidation }> {
  const descriptor = options.descriptor;
  const appRoot = path.resolve(descriptor.app_root);
  const dataRoot = path.resolve(descriptor.data_root);
  const localStateRoot = path.resolve(options.localStateRoot ?? defaultLocalStateRoot());
  const finished = options.now ?? new Date();
  const [appState, dataState, directStatus, localIdentity] = await Promise.all([
    gitState(appRoot),
    gitState(dataRoot),
    buildClientMcpDirectStatus(dataRoot, { now: finished }),
    readLocalProofIdentityFingerprint(),
  ]);
  const [appAncestor, dataAncestor] = await Promise.all([
    isAncestor(appRoot, descriptor.installed_app_commit, appState.head),
    isAncestor(dataRoot, descriptor.installed_data_commit, dataState.head),
  ]);
  const restore = await inspectRestore(descriptor.restore_receipt_path, descriptor);
  const restoreVerified = restore.reasons.length === 0 && restore.sha256 === descriptor.restore_receipt_sha256;
  const appDirty = classifyCleanMachineTrackedPaths("app", appState.trackedDirtyPaths);
  const dataDirty = classifyCleanMachineTrackedPaths("data", dataState.trackedDirtyPaths, {
    allowPrivateRestore: restoreVerified,
  });
  const install = await inspectInstall(descriptor.install_result_path, {
    ...appState,
    head: descriptor.installed_app_commit,
    upstream: descriptor.app_upstream_commit,
    trackedDirtyCount: appDirty.unexpected.length,
  }, {
    ...dataState,
    head: descriptor.installed_data_commit,
    upstream: descriptor.data_upstream_commit,
    trackedDirtyCount: dataDirty.unexpected.length,
  }, appRoot, dataRoot);
  const installPublic = installEvidence(install, descriptor);
  const recoveryPublic = recoveryEvidence(restore, descriptor);
  const reports = new Map(directStatus.agents.map((report) => [report.agent, report]));
  const [codex, claude] = await Promise.all([
    clientEvidence({
      agent: "codex",
      report: reports.get("codex"),
      appRoot,
      dataRoot,
      since: descriptor.started_at,
      required: true,
    }),
    clientEvidence({
      agent: "claude",
      report: reports.get("claude"),
      appRoot,
      dataRoot,
      since: descriptor.started_at,
      required: descriptor.mode === "both_clients",
    }),
  ]);

  const artifactEntries = await Promise.all([
    readArtifact(dataRoot, "full_memory_audit", ".dino/state/full_memory_audit_status.json"),
    readArtifact(dataRoot, "review_backpressure", ".dino/state/review_queue_backpressure.json"),
    readArtifact(dataRoot, "live_semantic_query", ".dino/state/live_semantic_query_status.json"),
    readArtifact(dataRoot, "rag_proof", ".dino/state/rag_proof_status.json"),
    readArtifact(dataRoot, "rag_eval", ".dino/state/rag_eval_status.json"),
    readArtifact(dataRoot, "behavior_recall", ".dino/state/behavior_recall_status.json"),
    readArtifact(dataRoot, "evidence_graph", ".dino/state/evidence_graph_status.json"),
    readArtifact(dataRoot, "graph_health", ".dino/index/graph-health.json"),
  ]);
  const artifacts = new Map(artifactEntries.map((entry) => [entry.id, entry]));
  const receiptMap = commandMap(options.commandReceipts);
  const fullMemory = artifacts.get("full_memory_audit")!;
  const reviewBackpressure = artifacts.get("review_backpressure")!;
  const liveSemantic = artifacts.get("live_semantic_query")!;
  const ragProof = artifacts.get("rag_proof")!;
  const ragEval = artifacts.get("rag_eval")!;
  const behavior = artifacts.get("behavior_recall")!;
  const evidenceGraph = artifacts.get("evidence_graph")!;
  const graphHealth = artifacts.get("graph_health")!;
  const capabilities: CleanMachineCapabilityEvidence[] = [
    makeCapability({
      id: "reviewed_memory_policy",
      artifacts: [
        { artifact: fullMemory, accepted: ["healthy", "drift_classified"] },
        { artifact: reviewBackpressure, accepted: ["healthy"] },
      ],
      commands: ["status:refresh"],
      receipts: receiptMap,
      since: descriptor.started_at,
      metrics: {
        audited_files: countMetric(fullMemory, "files"),
        unclassified_drift: countMetric(fullMemory, "unclassified_drift"),
        review_blockers: countMetric(reviewBackpressure, "blockers"),
      },
    }),
    makeCapability({
      id: "semantic_retrieval",
      artifacts: [
        { artifact: liveSemantic, accepted: ["healthy"] },
        { artifact: ragProof, accepted: ["healthy"] },
        { artifact: ragEval, accepted: ["healthy"] },
      ],
      commands: ["verify:live-semantic-query"],
      receipts: receiptMap,
      since: descriptor.started_at,
      metrics: {
        rag_cases: countMetric(ragEval, "cases"),
        rag_failed: countMetric(ragEval, "failed"),
        live_dense_reason_count: asNumber(asObject(liveSemantic.value?.retrieval)?.dense_reason_count),
      },
    }),
    makeCapability({
      id: "behavior_correction",
      artifacts: [{ artifact: behavior, accepted: ["healthy"] }],
      commands: ["verify:behavior-recall"],
      receipts: receiptMap,
      since: descriptor.started_at,
      metrics: {
        recall_entries: countMetric(behavior, "entries"),
        correction_entries: countMetric(behavior, "correction"),
        blockers: countMetric(behavior, "blockers"),
      },
    }),
    makeCapability({
      id: "observatory_graph",
      artifacts: [
        { artifact: evidenceGraph, accepted: ["healthy"] },
        { artifact: graphHealth, accepted: ["healthy"] },
      ],
      commands: ["observatory:verify"],
      receipts: receiptMap,
      since: descriptor.started_at,
      metrics: {
        graph_nodes: countMetric(evidenceGraph, "nodes"),
        graph_edges: countMetric(evidenceGraph, "edges"),
        graph_parse_errors: countMetric(evidenceGraph, "parse_errors"),
      },
    }),
    makeCapability({
      id: "scoped_sync",
      artifacts: [],
      commands: ["safety:task-sync:verify", "hooks:data:verify", "verify:codex-loop", "safety:public-data:check"],
      receipts: receiptMap,
      since: descriptor.started_at,
      metrics: {
        app_head_matches_upstream: appState.upstream === appState.head,
        data_head_matches_upstream: dataState.upstream === dataState.head,
      },
    }),
  ];

  const installerRegressionPassed = commandReasons(receiptMap, ["installer:verify:native-result", "installer:verify:transaction"]).length === 0;
  const installPass = installPublic.status === "PASS" && appState.repository === descriptor.expected_app_repository && dataState.repository === descriptor.expected_data_repository;
  const repositoryPass = appState.upstream === appState.head &&
    dataState.upstream === dataState.head &&
    appAncestor &&
    dataAncestor &&
    appDirty.unexpected.length === 0 &&
    dataDirty.unexpected.length === 0;
  const scenarios: CleanMachineScenarioEvidence[] = [
    scenario("immutable_github_install", installPass && repositoryPass, "immutable_github_install_not_proven"),
    scenario("dirty_user_config_update_regression", installerRegressionPassed, "dirty_config_regression_not_proven"),
    scenario("git_missing_degraded_rejected", installerRegressionPassed, "no_git_degraded_regression_not_proven"),
    scenario("interrupted_network_build_config_rollback", installerRegressionPassed, "interruption_rollback_regression_not_proven"),
    scenario("github_plus_encrypted_private_restore", installPass && recoveryPublic.status === "PASS", "github_private_restore_not_proven"),
    scenario("codex_direct_mcp_and_live_pre_response", codex.status === "PASS", "codex_direct_live_proof_missing"),
    scenario(
      "claude_direct_mcp_and_live_pre_response",
      descriptor.mode === "both_clients" && claude.status === "PASS",
      descriptor.mode === "both_clients" ? "claude_direct_live_proof_missing" : "both_client_mode_required",
    ),
  ];
  const repositoryReasons = unique([
    appState.repository !== descriptor.expected_app_repository ? "app_repository_changed_or_not_github" : "",
    dataState.repository !== descriptor.expected_data_repository ? "data_repository_changed_or_not_github" : "",
    appState.upstream !== appState.head ? "app_head_not_at_upstream" : "",
    dataState.upstream !== dataState.head ? "data_head_not_at_upstream" : "",
    !appAncestor ? "installed_app_commit_not_ancestor" : "",
    !dataAncestor ? "installed_data_commit_not_ancestor" : "",
    appDirty.unexpected.length > 0 ? "app_unexpected_tracked_dirty" : "",
    dataDirty.unexpected.length > 0 ? "data_unexpected_tracked_dirty" : "",
  ]);
  const commandFailureReasons = commandReasons(receiptMap, [...CLEAN_MACHINE_REQUIRED_COMMANDS]);
  const clientReasons = unique([
    ...codex.reason_codes.map((reason) => `codex:${reason}`),
    ...(descriptor.mode === "both_clients" ? claude.reason_codes.map((reason) => `claude:${reason}`) : []),
    descriptor.mode === "both_clients" && codex.local_identity_fingerprint !== claude.local_identity_fingerprint
      ? "client_local_identity_mismatch"
      : "",
    localIdentity && codex.local_identity_fingerprint !== localIdentity ? "codex_proof_not_bound_to_current_local_identity" : "",
    descriptor.mode === "both_clients" && localIdentity && claude.local_identity_fingerprint !== localIdentity
      ? "claude_proof_not_bound_to_current_local_identity"
      : "",
  ]);
  const capabilityReasons = capabilities
    .filter((entry) => entry.status !== "PASS")
    .flatMap((entry) => entry.reason_codes.map((reason) => `${entry.id}:${reason}`));
  const scenarioReasons = scenarios
    .filter((entry) => entry.status !== "PASS")
    .flatMap((entry) => entry.reason_codes.map((reason) => `${entry.id}:${reason}`));
  const blockers = unique([
    ...repositoryReasons,
    ...installPublic.reason_codes.map((reason) => `install:${reason}`),
    ...(descriptor.mode === "both_clients" ? recoveryPublic.reason_codes.map((reason) => `recovery:${reason}`) : []),
    ...commandFailureReasons,
    ...clientReasons,
    ...capabilityReasons,
    ...scenarioReasons,
    descriptor.mode !== "both_clients" ? "both_real_clients_required_for_release_equivalence" : "",
  ]);
  const measured = options.commandReceipts
    .map((entry) => entry.peak_process_tree_working_set_bytes)
    .filter((entry): entry is number => entry !== null);
  const peak = measured.length > 0 ? Math.max(...measured) : null;
  const status: CleanMachineEvidencePayload["status"] =
    descriptor.mode !== "both_clients" ? "diagnostic_only" : blockers.length === 0 ? "complete" : "blocked";
  const payload: CleanMachineEvidencePayload = {
    version: CLEAN_MACHINE_EQUIVALENCE_VERSION,
    status,
    generated_at: finished.toISOString(),
    run_id: descriptor.run_id,
    mode: descriptor.mode,
    run_started_at: descriptor.started_at,
    run_finished_at: finished.toISOString(),
    os_version: DINOBRAIN_VERSION,
    data_contract_version: DINOBRAIN_DATA_CONTRACT_VERSION,
    machine: {
      platform: process.platform,
      architecture: process.arch,
      attestation_public_key_sha256: descriptor.attestation_public_key_sha256,
      local_proof_identity_fingerprint: localIdentity,
    },
    install: installPublic,
    repositories: {
      app: publicGitIdentity(appState, descriptor.installed_app_commit, appAncestor, appDirty),
      data: publicGitIdentity(dataState, descriptor.installed_data_commit, dataAncestor, dataDirty),
    },
    recovery: descriptor.mode === "both_clients"
      ? recoveryPublic
      : { ...recoveryPublic, status: "NOT_APPLICABLE", reason_codes: ["codex_only_diagnostic"] },
    clients: { codex, claude },
    capabilities,
    scenarios,
    commands: options.commandReceipts,
    resource_usage: {
      peak_process_tree_working_set_bytes: peak,
      peak_process_tree_working_set_mib: peak === null ? null : Math.round((peak / 1024 / 1024) * 10) / 10,
      commands_measured: measured.length,
    },
    warnings: [],
    blockers,
  };
  const evidence = await signCleanMachineEquivalenceEvidence(payload, localStateRoot);
  const outputPath = path.resolve(
    options.outputPath ??
      path.join(dataRoot, "60_Operations", "clean-machine", `clean-machine-equivalence-${descriptor.run_id}.json`),
  );
  const relativeOutput = path.relative(dataRoot, outputPath);
  if (!relativeOutput || relativeOutput.startsWith("..") || path.isAbsolute(relativeOutput)) {
    throw new Error("Public clean-machine evidence must be written inside the DinoBrain data root");
  }
  await atomicWriteJson(outputPath, evidence);
  const validation = validateCleanMachineEquivalenceEvidence(evidence, {
    requireComplete: descriptor.mode === "both_clients",
  });
  await atomicWriteJson(path.join(runDirectory(localStateRoot, descriptor.run_id), "final-result.json"), {
    version: "clean_machine_equivalence_local_result_v1",
    generated_at: finished.toISOString(),
    public_evidence_path: outputPath,
    public_evidence_sha256: await fileHash(outputPath),
    status: evidence.status,
    validation,
  });
  return { evidence, outputPath, validation };
}

function publicPayload(value: CleanMachineEquivalenceEvidence): CleanMachineEvidencePayload {
  const { attestation: _attestation, ...payload } = value;
  return payload;
}

function publicPathLeak(value: unknown): boolean {
  const text = JSON.stringify(value);
  return /\b[A-Z]:\\(?:Users\\)?[^"\s]+/i.test(text) || /(?:^|["\s])\/(?:Users|home)\/[^"\s]+/i.test(text);
}

export function validateCleanMachineEquivalenceEvidence(
  value: unknown,
  options: { requireComplete?: boolean } = {},
): CleanMachineEvidenceValidation {
  const requireComplete = options.requireComplete ?? true;
  const evidence = asObject(value) as CleanMachineEquivalenceEvidence | null;
  if (!evidence) return { ok: false, complete: false, errors: ["evidence_root_invalid"], payload_sha256: null };
  const errors: string[] = [];
  if (evidence.version !== CLEAN_MACHINE_EQUIVALENCE_VERSION) errors.push("evidence_version_invalid");
  if (!validIso(evidence.generated_at) || !validIso(evidence.run_started_at) || !validIso(evidence.run_finished_at)) {
    errors.push("evidence_timestamp_invalid");
  }
  if (!/^clean-machine-[a-f0-9-]{36}$/i.test(asString(evidence.run_id))) errors.push("run_id_invalid");
  if (evidence.mode !== "both_clients" && evidence.mode !== "codex_only") errors.push("mode_invalid");
  if (requireComplete && evidence.status !== "complete") errors.push("evidence_not_complete");
  if (requireComplete && evidence.mode !== "both_clients") errors.push("both_clients_mode_required");
  if (requireComplete && asStrings(evidence.warnings).length > 0) errors.push("evidence_warnings_present");
  if (requireComplete && asStrings(evidence.blockers).length > 0) errors.push("evidence_blockers_present");
  if (publicPathLeak(evidence)) errors.push("public_evidence_contains_local_path");

  const attestation = asObject(evidence.attestation) as CleanMachineAttestation | null;
  let payloadSha256: string | null = null;
  if (!attestation || attestation.version !== CLEAN_MACHINE_ATTESTATION_VERSION || attestation.algorithm !== "ed25519") {
    errors.push("attestation_invalid");
  } else {
    try {
      const publicKeyDer = Buffer.from(attestation.public_key_spki_base64, "base64");
      const publicKeySha256 = sha256Bytes(publicKeyDer);
      if (publicKeySha256 !== attestation.public_key_sha256) errors.push("attestation_public_key_hash_mismatch");
      if (evidence.machine?.attestation_public_key_sha256 !== publicKeySha256) errors.push("machine_attestation_key_mismatch");
      const payload = publicPayload(evidence);
      const canonical = canonicalJson(payload);
      payloadSha256 = sha256Text(canonical);
      if (payloadSha256 !== attestation.payload_sha256) errors.push("attestation_payload_hash_mismatch");
      const publicKey = createPublicKey({ key: publicKeyDer, format: "der", type: "spki" });
      if (!verify(null, Buffer.from(canonical, "utf8"), publicKey, Buffer.from(attestation.signature_base64, "base64"))) {
        errors.push("attestation_signature_invalid");
      }
    } catch {
      errors.push("attestation_parse_failed");
    }
  }

  if (!isCommit(evidence.repositories?.app?.installed_commit) || !isCommit(evidence.repositories?.app?.final_commit)) {
    errors.push("app_commit_identity_invalid");
  }
  if (!isCommit(evidence.repositories?.data?.installed_commit) || !isCommit(evidence.repositories?.data?.final_commit)) {
    errors.push("data_commit_identity_invalid");
  }
  if (evidence.os_version !== DINOBRAIN_VERSION) errors.push("os_version_mismatch");
  if (evidence.data_contract_version !== DINOBRAIN_DATA_CONTRACT_VERSION) errors.push("data_contract_version_mismatch");
  if (requireComplete) {
    if (evidence.repositories?.app?.repository !== "clockmansy/dinobrain") errors.push("app_repository_identity_invalid");
    if (evidence.repositories?.data?.repository !== "clockmansy/dinobrain-data") errors.push("data_repository_identity_invalid");
    if (evidence.install?.status !== "PASS" || evidence.install?.full_equivalence !== true) errors.push("full_install_equivalence_missing");
    if (evidence.install?.verification_skipped !== false || evidence.install?.stage_verified !== true) errors.push("install_verification_invalid");
    if (evidence.repositories?.app?.head_matches_upstream !== true || evidence.repositories?.data?.head_matches_upstream !== true) {
      errors.push("repository_upstream_parity_missing");
    }
    if (evidence.repositories?.app?.installed_commit_is_ancestor !== true || evidence.repositories?.data?.installed_commit_is_ancestor !== true) {
      errors.push("installed_commit_lineage_missing");
    }
    const appUnexpectedDirty = evidence.repositories?.app?.unexpected_tracked_dirty_count ??
      evidence.repositories?.app?.tracked_dirty_count;
    const dataUnexpectedDirty = evidence.repositories?.data?.unexpected_tracked_dirty_count ??
      evidence.repositories?.data?.tracked_dirty_count;
    if (appUnexpectedDirty !== 0 || dataUnexpectedDirty !== 0) {
      errors.push("tracked_repository_dirty");
    }
    if (evidence.recovery?.status !== "PASS" || evidence.recovery?.source_identity_matches_install !== true) {
      errors.push("encrypted_restore_equivalence_missing");
    }
    if (evidence.recovery?.source_data_commit !== evidence.repositories?.data?.installed_commit) errors.push("restore_data_commit_mismatch");
    const codex = evidence.clients?.codex;
    const claude = evidence.clients?.claude;
    if (codex?.status !== "PASS" || !codex.live_pre_response || !isSha256(codex.direct_proof_sha256)) {
      errors.push("codex_direct_live_proof_missing");
    }
    if (claude?.status !== "PASS" || !claude.live_pre_response || !isSha256(claude.direct_proof_sha256)) {
      errors.push("claude_direct_live_proof_missing");
    }
    if (
      !codex?.local_identity_fingerprint ||
      !claude?.local_identity_fingerprint ||
      !isSha256(codex.local_identity_fingerprint) ||
      !isSha256(claude.local_identity_fingerprint) ||
      codex.local_identity_fingerprint !== claude.local_identity_fingerprint ||
      codex.local_identity_fingerprint !== evidence.machine?.local_proof_identity_fingerprint
    ) errors.push("client_machine_identity_binding_invalid");
    const runStarted = Date.parse(evidence.run_started_at);
    const runFinished = Date.parse(evidence.run_finished_at);
    for (const client of [codex, claude]) {
      const directAt = Date.parse(client?.direct_verified_at ?? "");
      const liveSubmittedAt = Date.parse(client?.live_pre_response?.submitted_at ?? "");
      const liveCompletedAt = Date.parse(client?.live_pre_response?.completed_at ?? "");
      if (
        !Number.isFinite(directAt) ||
        !Number.isFinite(liveSubmittedAt) ||
        !Number.isFinite(liveCompletedAt) ||
        directAt < runStarted ||
        liveSubmittedAt < runStarted ||
        liveCompletedAt < liveSubmittedAt ||
        directAt > runFinished + 5 * 60_000 ||
        liveCompletedAt > runFinished + 5 * 60_000
      ) errors.push(`${client?.agent ?? "unknown"}_proof_window_invalid`);
      if (
        !client?.challenge_id_sha256 ||
        client.challenge_id_sha256 !== client.live_pre_response?.challenge_id_sha256
      ) errors.push(`${client?.agent ?? "unknown"}_direct_live_challenge_binding_invalid`);
      if (
        client?.live_pre_response?.status !== "verified" ||
        client.live_pre_response.context_item_count < 1 ||
        client.live_pre_response.memory_path_count < 1 ||
        !isSha256(client.live_pre_response.context_trace_sha256)
      ) errors.push(`${client?.agent ?? "unknown"}_live_context_evidence_invalid`);
    }
    const commandStatuses = new Map((Array.isArray(evidence.commands) ? evidence.commands : []).map((entry) => [entry.command_id, entry.status]));
    for (const id of CLEAN_MACHINE_REQUIRED_COMMANDS) if (commandStatuses.get(id) !== "PASS") errors.push(`required_command_not_passed:${id}`);
    for (const receipt of Array.isArray(evidence.commands) ? evidence.commands : []) {
      if (
        !isSha256(receipt.stdout_sha256) ||
        !isSha256(receipt.stderr_sha256) ||
        !validIso(receipt.started_at) ||
        !validIso(receipt.finished_at) ||
        Date.parse(receipt.started_at) < runStarted ||
        Date.parse(receipt.finished_at) < Date.parse(receipt.started_at) ||
        Date.parse(receipt.finished_at) > runFinished + 5 * 60_000
      ) errors.push(`command_receipt_invalid:${receipt.command_id}`);
    }
    const capabilityStatuses = new Map((Array.isArray(evidence.capabilities) ? evidence.capabilities : []).map((entry) => [entry.id, entry.status]));
    for (const id of CLEAN_MACHINE_REQUIRED_CAPABILITIES) if (capabilityStatuses.get(id) !== "PASS") errors.push(`required_capability_not_passed:${id}`);
    const scenarioStatuses = new Map((Array.isArray(evidence.scenarios) ? evidence.scenarios : []).map((entry) => [entry.id, entry.status]));
    for (const id of CLEAN_MACHINE_REQUIRED_SCENARIOS) if (scenarioStatuses.get(id) !== "PASS") errors.push(`required_scenario_not_passed:${id}`);
  }
  return { ok: errors.length === 0, complete: evidence.status === "complete" && errors.length === 0, errors: unique(errors), payload_sha256: payloadSha256 };
}

export async function validateCleanMachineEquivalenceEvidenceFile(
  filePath: string,
  options: { requireComplete?: boolean } = {},
): Promise<CleanMachineEvidenceValidation> {
  try {
    return validateCleanMachineEquivalenceEvidence(await readJsonObject(path.resolve(filePath)), options);
  } catch {
    return { ok: false, complete: false, errors: ["evidence_file_invalid"], payload_sha256: null };
  }
}
