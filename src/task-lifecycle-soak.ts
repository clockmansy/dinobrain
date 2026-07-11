import { execFile } from "node:child_process";
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomUUID,
  sign,
  verify,
} from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import {
  buildClientMcpDirectStatus,
  type ClientMcpAgentReport,
  type ClientMcpDirectStatusReport,
} from "./client-mcp-direct-status.js";
import { canonicalJson, type ClientMcpAgent } from "./client-mcp-proof.js";
import { atomicCreateText, atomicWriteJson, withFileLock } from "./concurrency.js";
import { dataPath, relDataPath } from "./context.js";
import { buildTaskLifecycleReport, type TaskLifecycleReport, type TaskLifecycleSession } from "./task-lifecycle.js";

const execFileAsync = promisify(execFile);

export const TASK_LIFECYCLE_SOAK_VERSION = "task_lifecycle_soak_v1";
export const TASK_LIFECYCLE_SOAK_RUN_VERSION = "task_lifecycle_soak_run_v1";
export const TASK_LIFECYCLE_SOAK_START_ATTESTATION_VERSION = "task_lifecycle_soak_start_ed25519_v1";
export const TASK_LIFECYCLE_SOAK_ATTESTATION_VERSION = "task_lifecycle_soak_attestation_ed25519_v1";
export const TASK_LIFECYCLE_SOAK_MINIMUM_MS = 24 * 60 * 60 * 1000;
export const TASK_LIFECYCLE_SOAK_EVIDENCE_DIR = "60_Operations/lifecycle-soak";

type JsonObject = Record<string, unknown>;

export type LifecycleSoakSnapshot = {
  status: "healthy" | "needs_attention";
  generated_at: string;
  report_sha256: string;
  task_ids_sha256: string;
  counts: TaskLifecycleReport["counts"];
};

export type TaskLifecycleSoakRunDescriptor = {
  version: typeof TASK_LIFECYCLE_SOAK_RUN_VERSION;
  run_id: string;
  status: "running";
  started_at: string;
  required_duration_ms: number;
  app_commit: string;
  data_commit: string;
  app_clean_at_start: boolean;
  baseline: LifecycleSoakSnapshot;
  baseline_task_ids: string[];
  attestation_public_key_sha256: string;
  start_attestation: LifecycleSoakStartAttestation;
};

export type LifecycleSoakStartAttestation = {
  version: typeof TASK_LIFECYCLE_SOAK_START_ATTESTATION_VERSION;
  algorithm: "ed25519";
  public_key_spki_base64: string;
  public_key_sha256: string;
  payload_sha256: string;
  signature_base64: string;
};

export type LifecycleSoakTaskEvidence = {
  task_id: string;
  task_path: string;
  task_sha256: string;
  trace_path: string | null;
  trace_sha256: string | null;
  status: string;
  lifecycle_state: string;
  grounding_classification: string;
  prompt_classification: string | null;
  durable_task_eligible: boolean;
  created_at: string | null;
  finished_at: string | null;
  issue_codes: string[];
};

export type LifecycleSoakClientProof = {
  agent: ClientMcpAgent;
  status: "verified";
  generated_at: string;
  proof_path: string;
  proof_file_sha256: string;
  proof_sha256: string;
  task_id: string;
  client_name: string;
  client_version: string;
};

export type TaskLifecycleSoakEvidence = {
  version: typeof TASK_LIFECYCLE_SOAK_VERSION;
  status: "complete";
  run_id: string;
  generated_at: string;
  started_at: string;
  finished_at: string;
  duration_ms: number;
  required_duration_ms: number;
  repositories: {
    app_commit_at_start: string;
    app_commit_at_finish: string;
    data_commit_at_start: string;
    data_commit_at_finish: string;
    app_clean_at_start: boolean;
    app_clean_at_finish: boolean;
  };
  baseline: LifecycleSoakSnapshot;
  start_attestation: LifecycleSoakStartAttestation;
  final: LifecycleSoakSnapshot;
  window: {
    tasks: LifecycleSoakTaskEvidence[];
    counts: {
      tasks: number;
      durable_tasks: number;
      terminal_tasks: number;
      active_tasks: number;
      blocker_tasks: number;
    };
  };
  client_proofs: LifecycleSoakClientProof[];
  warnings: string[];
  blockers: string[];
  attestation: {
    version: typeof TASK_LIFECYCLE_SOAK_ATTESTATION_VERSION;
    algorithm: "ed25519";
    public_key_spki_base64: string;
    public_key_sha256: string;
    payload_sha256: string;
    signature_base64: string;
  };
};

export type TaskLifecycleSoakValidation = {
  ok: boolean;
  complete: boolean;
  errors: string[];
  payload_sha256: string | null;
};

type FinalizeOptions = {
  appRoot: string;
  dataRoot: string;
  runId?: string;
  localStateRoot?: string;
  clientProofLocalStateRoot?: string;
  now?: Date;
  clientStatusOverride?: ClientMcpDirectStatusReport;
};

function sha256Bytes(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/i.test(value);
}

function isCommit(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{40}$/i.test(value);
}

function asObject(value: unknown): JsonObject | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : null;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : Number.NaN;
}

function validIso(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function defaultLocalStateRoot(): string {
  if (process.env.LOCALAPPDATA) return path.resolve(process.env.LOCALAPPDATA, "DinoBrain", "proofs", "lifecycle-soak");
  return path.resolve(os.homedir(), ".local", "state", "dinobrain", "proofs", "lifecycle-soak");
}

function runDirectory(localStateRoot: string, runId: string): string {
  if (!/^lifecycle-soak-[a-f0-9-]{36}$/i.test(runId)) throw new Error(`Invalid lifecycle soak run id: ${runId}`);
  return path.join(path.resolve(localStateRoot), "runs", runId);
}

function descriptorPath(localStateRoot: string, runId: string): string {
  return path.join(runDirectory(localStateRoot, runId), "run.json");
}

function latestRunPath(localStateRoot: string): string {
  return path.join(path.resolve(localStateRoot), "latest-run.json");
}

function attestationKeyPath(localStateRoot: string): string {
  return path.join(path.resolve(localStateRoot), "attestation-ed25519-private.pem");
}

async function gitText(root: string, args: string[]): Promise<string> {
  const result = await execFileAsync("git", ["-C", path.resolve(root), ...args], {
    windowsHide: true,
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
  });
  return result.stdout.trim();
}

async function gitHead(root: string): Promise<string> {
  const head = await gitText(root, ["rev-parse", "HEAD"]);
  if (!isCommit(head)) throw new Error(`Invalid Git HEAD for ${path.resolve(root)}`);
  return head.toLowerCase();
}

async function gitClean(root: string): Promise<boolean> {
  return (await gitText(root, ["status", "--porcelain=v1"])).length === 0;
}

async function fileSha256(filePath: string): Promise<string> {
  return sha256Bytes(await fs.readFile(filePath));
}

async function hardenPrivateKeyPermissions(filePath: string): Promise<void> {
  await fs.chmod(filePath, 0o600);
  if (process.platform !== "win32") return;
  const identity = await execFileAsync("whoami", ["/user", "/fo", "csv", "/nh"], {
    windowsHide: true,
    encoding: "utf8",
  });
  const sid = identity.stdout.match(/"(S-[0-9-]+)"\s*$/m)?.[1];
  if (!sid) throw new Error("Could not resolve the current Windows SID for lifecycle soak key ACL");
  await execFileAsync(
    "icacls",
    [
      filePath,
      "/inheritance:r",
      "/grant:r",
      `*${sid}:(F)`,
      "*S-1-5-18:(F)",
      "*S-1-5-32-544:(F)",
    ],
    { windowsHide: true, encoding: "utf8" },
  );
  const acl = await execFileAsync("icacls", [filePath], { windowsHide: true, encoding: "utf8" });
  if (/\(I\)/i.test(acl.stdout)) throw new Error("Lifecycle soak private key still has inherited Windows ACL entries");
}

function lifecyclePayload(report: TaskLifecycleReport): unknown {
  return {
    version: report.version,
    status: report.status,
    generated_at: report.generated_at,
    stale_after_ms: report.stale_after_ms,
    counts: report.counts,
    sessions: report.sessions.map((session) => ({
      task_id: session.task_id,
      task_sha256: session.task_sha256,
      trace_sha256: session.trace_sha256,
      lifecycle_state: session.lifecycle_state,
      grounding_classification: session.grounding_classification,
      issue_codes: session.issue_codes,
    })),
  };
}

function lifecycleSnapshot(report: TaskLifecycleReport): LifecycleSoakSnapshot {
  const taskIds = report.sessions.filter((session) => session.task_path).map((session) => session.task_id).sort();
  return {
    status: report.status,
    generated_at: report.generated_at,
    report_sha256: sha256Bytes(canonicalJson(lifecyclePayload(report))),
    task_ids_sha256: sha256Bytes(canonicalJson(taskIds)),
    counts: report.counts,
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
    } catch {
      const pair = generateKeyPairSync("ed25519");
      await atomicCreateText(filePath, pair.privateKey.export({ format: "pem", type: "pkcs8" }).toString(), 0o600);
    }
  });
  await hardenPrivateKeyPermissions(filePath);
  const privateKey = createPrivateKey(await fs.readFile(filePath, "utf8"));
  const publicKeyDer = createPublicKey({
    key: privateKey.export({ format: "pem", type: "pkcs8" }),
    format: "pem",
  }).export({ format: "der", type: "spki" });
  return { privateKey, publicKeyDer, publicKeySha256: sha256Bytes(publicKeyDer) };
}

type LifecycleSoakStartClaim = {
  version: typeof TASK_LIFECYCLE_SOAK_RUN_VERSION;
  run_id: string;
  status: "running";
  started_at: string;
  required_duration_ms: number;
  app_commit: string;
  data_commit: string;
  app_clean_at_start: boolean;
  baseline: LifecycleSoakSnapshot;
  attestation_public_key_sha256: string;
};

function startClaim(value: LifecycleSoakStartClaim): LifecycleSoakStartClaim {
  return {
    version: value.version,
    run_id: value.run_id,
    status: value.status,
    started_at: value.started_at,
    required_duration_ms: value.required_duration_ms,
    app_commit: value.app_commit,
    data_commit: value.data_commit,
    app_clean_at_start: value.app_clean_at_start,
    baseline: value.baseline,
    attestation_public_key_sha256: value.attestation_public_key_sha256,
  };
}

function signStartClaim(
  claim: LifecycleSoakStartClaim,
  key: { privateKey: ReturnType<typeof createPrivateKey>; publicKeyDer: Buffer; publicKeySha256: string },
): LifecycleSoakStartAttestation {
  const canonical = canonicalJson(startClaim(claim));
  return {
    version: TASK_LIFECYCLE_SOAK_START_ATTESTATION_VERSION,
    algorithm: "ed25519",
    public_key_spki_base64: key.publicKeyDer.toString("base64"),
    public_key_sha256: key.publicKeySha256,
    payload_sha256: sha256Bytes(canonical),
    signature_base64: sign(null, Buffer.from(canonical, "utf8"), key.privateKey).toString("base64"),
  };
}

function validateStartClaimAttestation(
  claim: LifecycleSoakStartClaim,
  attestation: unknown,
): { ok: boolean; errors: string[] } {
  const parsed = asObject(attestation);
  const errors: string[] = [];
  if (
    parsed?.version !== TASK_LIFECYCLE_SOAK_START_ATTESTATION_VERSION ||
    parsed?.algorithm !== "ed25519"
  ) {
    return { ok: false, errors: ["start_attestation_invalid"] };
  }
  try {
    const publicKeyDer = Buffer.from(asString(parsed.public_key_spki_base64), "base64");
    const publicKeySha256 = sha256Bytes(publicKeyDer);
    if (publicKeySha256 !== asString(parsed.public_key_sha256)) errors.push("start_attestation_public_key_hash_mismatch");
    if (publicKeySha256 !== claim.attestation_public_key_sha256) errors.push("start_attestation_identity_mismatch");
    const canonical = canonicalJson(startClaim(claim));
    if (sha256Bytes(canonical) !== asString(parsed.payload_sha256)) errors.push("start_attestation_payload_hash_mismatch");
    const publicKey = createPublicKey({ key: publicKeyDer, format: "der", type: "spki" });
    if (!verify(null, Buffer.from(canonical, "utf8"), publicKey, Buffer.from(asString(parsed.signature_base64), "base64"))) {
      errors.push("start_attestation_signature_invalid");
    }
  } catch {
    errors.push("start_attestation_parse_failed");
  }
  return { ok: errors.length === 0, errors };
}

async function loadDescriptor(localStateRoot: string, runId?: string): Promise<TaskLifecycleSoakRunDescriptor> {
  let selected = runId;
  if (!selected) {
    const latest = JSON.parse(await fs.readFile(latestRunPath(localStateRoot), "utf8")) as JsonObject;
    selected = asString(latest.run_id);
  }
  const parsed = JSON.parse(await fs.readFile(descriptorPath(localStateRoot, selected ?? ""), "utf8")) as unknown;
  const descriptor = asObject(parsed) as TaskLifecycleSoakRunDescriptor | null;
  if (!descriptor || descriptor.version !== TASK_LIFECYCLE_SOAK_RUN_VERSION || descriptor.status !== "running") {
    throw new Error("Lifecycle soak descriptor is missing, malformed, or no longer running");
  }
  return descriptor;
}

function windowTask(session: TaskLifecycleSession): LifecycleSoakTaskEvidence | null {
  if (!session.task_path || !session.task_sha256) return null;
  return {
    task_id: session.task_id,
    task_path: session.task_path,
    task_sha256: session.task_sha256,
    trace_path: session.trace_path,
    trace_sha256: session.trace_sha256,
    status: session.status,
    lifecycle_state: session.lifecycle_state,
    grounding_classification: session.grounding_classification,
    prompt_classification: session.prompt_classification,
    durable_task_eligible: session.prompt_durable_task_eligible === true,
    created_at: session.created_at,
    finished_at: session.finished_at,
    issue_codes: [...session.issue_codes],
  };
}

function proofAgent(report: ClientMcpAgentReport, startedAt: number, finishedAt: number): boolean {
  const generated = Date.parse(report.latest_verified_at ?? "");
  return (
    report.status === "verified" &&
    Boolean(report.proof_path && report.proof_sha256 && report.client_name && report.client_version) &&
    Number.isFinite(generated) &&
    generated >= startedAt &&
    generated <= finishedAt + 5 * 60_000
  );
}

async function clientProofEvidence(
  dataRoot: string,
  report: ClientMcpAgentReport,
): Promise<LifecycleSoakClientProof> {
  if (!safeRelativePath(report.proof_path) || !report.proof_path.startsWith(".dino/proofs/client-mcp/")) {
    throw new Error(`${report.agent} direct MCP proof path is outside the proof directory`);
  }
  const proofPath = dataPath(dataRoot, ...(report.proof_path ?? "").split("/"));
  const parsed = JSON.parse(await fs.readFile(proofPath, "utf8")) as JsonObject;
  const taskId = asString(parsed.task_id);
  if (!taskId) throw new Error(`${report.agent} direct MCP proof has no task binding`);
  return {
    agent: report.agent,
    status: "verified",
    generated_at: asString(report.latest_verified_at),
    proof_path: relDataPath(dataRoot, proofPath),
    proof_file_sha256: await fileSha256(proofPath),
    proof_sha256: asString(report.proof_sha256),
    task_id: taskId,
    client_name: asString(report.client_name),
    client_version: asString(report.client_version),
  };
}

function publicPayload(evidence: TaskLifecycleSoakEvidence): Omit<TaskLifecycleSoakEvidence, "attestation"> {
  const { attestation: _attestation, ...payload } = evidence;
  return payload;
}

function publicPathLeak(value: unknown): boolean {
  const text = JSON.stringify(value);
  return /\b[A-Z]:\\(?:Users\\)?[^"\s]+/i.test(text) || /(?:^|["\s])\/(?:Users|home)\/[^"\s]+/i.test(text);
}

function safeRelativePath(value: unknown): value is string {
  if (typeof value !== "string" || !value || path.isAbsolute(value)) return false;
  const normalized = value.replace(/\\/g, "/");
  return !normalized.split("/").includes("..");
}

async function hashBoundPath(dataRoot: string, relativePath: string, expectedSha256: string): Promise<boolean> {
  if (!safeRelativePath(relativePath) || !isSha256(expectedSha256)) return false;
  const root = path.resolve(dataRoot);
  const target = path.resolve(root, ...relativePath.split("/"));
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) return false;
  try {
    return (await fileSha256(target)) === expectedSha256.toLowerCase();
  } catch {
    return false;
  }
}

export async function beginTaskLifecycleSoak(options: {
  appRoot: string;
  dataRoot: string;
  localStateRoot?: string;
  now?: Date;
}): Promise<{ descriptor: TaskLifecycleSoakRunDescriptor; descriptorPath: string }> {
  const appRoot = path.resolve(options.appRoot);
  const dataRoot = path.resolve(options.dataRoot);
  const localStateRoot = path.resolve(options.localStateRoot ?? defaultLocalStateRoot());
  const now = options.now ?? new Date();
  const [appCommit, dataCommit, appClean, baseline, key] = await Promise.all([
    gitHead(appRoot),
    gitHead(dataRoot),
    gitClean(appRoot),
    buildTaskLifecycleReport(dataRoot, { now }),
    loadOrCreateAttestationKey(localStateRoot),
  ]);
  if (!appClean) throw new Error("Lifecycle soak requires a clean app worktree at start");
  if (baseline.status !== "healthy" || baseline.counts.blockers !== 0 || baseline.counts.active !== 0) {
    throw new Error("Lifecycle soak requires a blocker-free baseline with zero active tasks");
  }
  const baselineTaskIds = baseline.sessions.filter((session) => session.task_path).map((session) => session.task_id).sort();
  const runId = `lifecycle-soak-${randomUUID()}`;
  const descriptorBase: Omit<TaskLifecycleSoakRunDescriptor, "start_attestation"> = {
    version: TASK_LIFECYCLE_SOAK_RUN_VERSION,
    run_id: runId,
    status: "running",
    started_at: now.toISOString(),
    required_duration_ms: TASK_LIFECYCLE_SOAK_MINIMUM_MS,
    app_commit: appCommit,
    data_commit: dataCommit,
    app_clean_at_start: true,
    baseline: lifecycleSnapshot(baseline),
    baseline_task_ids: baselineTaskIds,
    attestation_public_key_sha256: key.publicKeySha256,
  };
  const descriptor: TaskLifecycleSoakRunDescriptor = {
    ...descriptorBase,
    start_attestation: signStartClaim(descriptorBase, key),
  };
  const outputPath = descriptorPath(localStateRoot, runId);
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await atomicWriteJson(outputPath, descriptor);
  await atomicWriteJson(latestRunPath(localStateRoot), {
    version: "task_lifecycle_soak_latest_v1",
    run_id: runId,
    started_at: descriptor.started_at,
  });
  return { descriptor, descriptorPath: outputPath };
}

export async function finalizeTaskLifecycleSoak(
  options: FinalizeOptions,
): Promise<{ evidence: TaskLifecycleSoakEvidence; outputPath: string; validation: TaskLifecycleSoakValidation }> {
  const appRoot = path.resolve(options.appRoot);
  const dataRoot = path.resolve(options.dataRoot);
  const localStateRoot = path.resolve(options.localStateRoot ?? defaultLocalStateRoot());
  const now = options.now ?? new Date();
  const descriptor = await loadDescriptor(localStateRoot, options.runId);
  const startValidation = validateStartClaimAttestation(descriptor, descriptor.start_attestation);
  if (!startValidation.ok) {
    throw new Error(`Lifecycle soak start attestation invalid: ${startValidation.errors.join(",")}`);
  }
  if (sha256Bytes(canonicalJson([...descriptor.baseline_task_ids].sort())) !== descriptor.baseline.task_ids_sha256) {
    throw new Error("Lifecycle soak baseline task set hash mismatch");
  }
  const startedAt = Date.parse(descriptor.started_at);
  const durationMs = now.getTime() - startedAt;
  if (!Number.isFinite(startedAt) || durationMs < TASK_LIFECYCLE_SOAK_MINIMUM_MS) {
    throw new Error(`Lifecycle soak requires ${TASK_LIFECYCLE_SOAK_MINIMUM_MS} ms; elapsed ${Math.max(0, durationMs)} ms`);
  }

  const [appCommit, dataCommit, appClean, finalReport, key] = await Promise.all([
    gitHead(appRoot),
    gitHead(dataRoot),
    gitClean(appRoot),
    buildTaskLifecycleReport(dataRoot, { now }),
    loadOrCreateAttestationKey(localStateRoot),
  ]);
  const clientStatus =
    options.clientStatusOverride ??
    (await buildClientMcpDirectStatus(dataRoot, {
      now,
      staleAfterMs: TASK_LIFECYCLE_SOAK_MINIMUM_MS,
      localStateRoot: options.clientProofLocalStateRoot,
    }));
  const agentReports = (["codex", "claude"] as ClientMcpAgent[]).map((agent) =>
    clientStatus.agents.find((entry) => entry.agent === agent),
  );
  const proofReports = agentReports.filter(
    (entry): entry is ClientMcpAgentReport => Boolean(entry && proofAgent(entry, startedAt, now.getTime())),
  );
  const proofs: LifecycleSoakClientProof[] = [];
  for (const report of proofReports) proofs.push(await clientProofEvidence(dataRoot, report));

  const baselineTaskIds = new Set(descriptor.baseline_task_ids);
  const tasks = finalReport.sessions
    .filter((session) => session.task_path && !baselineTaskIds.has(session.task_id))
    .map(windowTask)
    .filter((entry): entry is LifecycleSoakTaskEvidence => Boolean(entry));
  const proofTaskIds = new Set(proofs.map((proof) => proof.task_id));
  const proofTasks = tasks.filter((task) => proofTaskIds.has(task.task_id));
  const blockerTasks = tasks.filter((task) => task.issue_codes.some((code) => code !== "partial_grounding"));
  const blockers = unique([
    descriptor.required_duration_ms !== TASK_LIFECYCLE_SOAK_MINIMUM_MS ? "required_duration_contract_mismatch" : "",
    descriptor.attestation_public_key_sha256 !== key.publicKeySha256 ? "attestation_identity_changed" : "",
    descriptor.app_commit !== appCommit ? "app_commit_changed_during_soak" : "",
    descriptor.data_commit !== dataCommit ? "data_commit_changed_during_soak" : "",
    !appClean ? "app_worktree_dirty_at_finish" : "",
    descriptor.baseline.status !== "healthy" || descriptor.baseline.counts.blockers !== 0 || descriptor.baseline.counts.active !== 0
      ? "baseline_not_healthy_or_not_drained"
      : "",
    finalReport.status !== "healthy" || finalReport.counts.blockers !== 0 ? "final_lifecycle_not_healthy" : "",
    proofReports.length !== 2 ? "fresh_codex_and_claude_proofs_required_inside_soak_window" : "",
    tasks.filter((task) => task.durable_task_eligible).length < 2 ? "insufficient_durable_tasks_in_soak_window" : "",
    blockerTasks.length > 0 ? "window_lifecycle_blockers_present" : "",
    proofs.some((proof) => !tasks.some((task) => task.task_id === proof.task_id))
      ? "client_proof_task_not_created_inside_soak_window"
      : "",
    proofTasks.length !== 2 || proofTasks.some((task) => task.lifecycle_state !== "terminal" || task.grounding_classification !== "grounded")
      ? "client_proof_tasks_not_terminal_grounded"
      : "",
  ]);
  if (blockers.length > 0) {
    await atomicWriteJson(path.join(runDirectory(localStateRoot, descriptor.run_id), "last-finalize-attempt.json"), {
      version: "task_lifecycle_soak_finalize_attempt_v1",
      generated_at: now.toISOString(),
      status: "blocked",
      blockers,
    });
    throw new Error(`Lifecycle soak finalization blocked: ${blockers.join(",")}`);
  }

  const unsigned: Omit<TaskLifecycleSoakEvidence, "attestation"> = {
    version: TASK_LIFECYCLE_SOAK_VERSION,
    status: "complete" as const,
    run_id: descriptor.run_id,
    generated_at: now.toISOString(),
    started_at: descriptor.started_at,
    finished_at: now.toISOString(),
    duration_ms: durationMs,
    required_duration_ms: TASK_LIFECYCLE_SOAK_MINIMUM_MS,
    repositories: {
      app_commit_at_start: descriptor.app_commit,
      app_commit_at_finish: appCommit,
      data_commit_at_start: descriptor.data_commit,
      data_commit_at_finish: dataCommit,
      app_clean_at_start: descriptor.app_clean_at_start,
      app_clean_at_finish: appClean,
    },
    baseline: descriptor.baseline,
    start_attestation: descriptor.start_attestation,
    final: lifecycleSnapshot(finalReport),
    window: {
      tasks,
      counts: {
        tasks: tasks.length,
        durable_tasks: tasks.filter((task) => task.durable_task_eligible).length,
        terminal_tasks: tasks.filter((task) => task.lifecycle_state === "terminal").length,
        active_tasks: tasks.filter((task) => task.lifecycle_state === "active").length,
        blocker_tasks: blockerTasks.length,
      },
    },
    client_proofs: proofs.sort((left, right) => left.agent.localeCompare(right.agent)),
    warnings: [] as string[],
    blockers: [] as string[],
  };
  const canonical = canonicalJson(unsigned);
  const payloadSha256 = sha256Bytes(canonical);
  const evidence: TaskLifecycleSoakEvidence = {
    ...unsigned,
    attestation: {
      version: TASK_LIFECYCLE_SOAK_ATTESTATION_VERSION,
      algorithm: "ed25519",
      public_key_spki_base64: key.publicKeyDer.toString("base64"),
      public_key_sha256: key.publicKeySha256,
      payload_sha256: payloadSha256,
      signature_base64: sign(null, Buffer.from(canonical, "utf8"), key.privateKey).toString("base64"),
    },
  };
  const validation = await validateTaskLifecycleSoakEvidence(evidence, { dataRoot, now });
  if (!validation.ok) throw new Error(`Generated lifecycle soak evidence failed validation: ${validation.errors.join(",")}`);
  const outputPath = dataPath(dataRoot, TASK_LIFECYCLE_SOAK_EVIDENCE_DIR, `${descriptor.run_id}.json`);
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await atomicWriteJson(outputPath, evidence);
  await atomicWriteJson(path.join(runDirectory(localStateRoot, descriptor.run_id), "final-result.json"), {
    version: "task_lifecycle_soak_local_result_v1",
    generated_at: now.toISOString(),
    status: "complete",
    public_evidence_path: relDataPath(dataRoot, outputPath),
    public_evidence_sha256: await fileSha256(outputPath),
    validation,
  });
  return { evidence, outputPath, validation };
}

export async function validateTaskLifecycleSoakEvidence(
  value: unknown,
  options: { dataRoot?: string; now?: Date } = {},
): Promise<TaskLifecycleSoakValidation> {
  const evidence = asObject(value) as TaskLifecycleSoakEvidence | null;
  if (!evidence) return { ok: false, complete: false, errors: ["evidence_root_invalid"], payload_sha256: null };
  const errors: string[] = [];
  if (evidence.version !== TASK_LIFECYCLE_SOAK_VERSION) errors.push("evidence_version_invalid");
  if (evidence.status !== "complete") errors.push("evidence_not_complete");
  if (!/^lifecycle-soak-[a-f0-9-]{36}$/i.test(asString(evidence.run_id))) errors.push("run_id_invalid");
  if (!validIso(evidence.generated_at) || !validIso(evidence.started_at) || !validIso(evidence.finished_at)) {
    errors.push("evidence_timestamp_invalid");
  }
  const startedAt = Date.parse(asString(evidence.started_at));
  const finishedAt = Date.parse(asString(evidence.finished_at));
  const durationMs = asNumber(evidence.duration_ms);
  if (
    !Number.isFinite(startedAt) ||
    !Number.isFinite(finishedAt) ||
    finishedAt < startedAt ||
    durationMs < TASK_LIFECYCLE_SOAK_MINIMUM_MS ||
    Math.abs(finishedAt - startedAt - durationMs) > 1_000 ||
    evidence.required_duration_ms !== TASK_LIFECYCLE_SOAK_MINIMUM_MS
  ) {
    errors.push("minimum_24_hour_duration_not_proven");
  }
  const now = options.now ?? new Date();
  if (Number.isFinite(finishedAt) && finishedAt > now.getTime() + 5 * 60_000) errors.push("evidence_from_future");
  if (publicPathLeak(evidence)) errors.push("public_evidence_contains_local_path");
  if (!Array.isArray(evidence.warnings) || evidence.warnings.length > 0) errors.push("evidence_warnings_present_or_invalid");
  if (!Array.isArray(evidence.blockers) || evidence.blockers.length > 0) errors.push("evidence_blockers_present_or_invalid");

  const repositories = asObject(evidence.repositories);
  const appStart = asString(repositories?.app_commit_at_start);
  const appFinish = asString(repositories?.app_commit_at_finish);
  const dataStart = asString(repositories?.data_commit_at_start);
  const dataFinish = asString(repositories?.data_commit_at_finish);
  if (!isCommit(appStart) || !isCommit(appFinish) || appStart !== appFinish) errors.push("app_commit_identity_invalid_or_changed");
  if (!isCommit(dataStart) || !isCommit(dataFinish) || dataStart !== dataFinish) errors.push("data_commit_identity_invalid_or_changed");
  if (repositories?.app_clean_at_start !== true || repositories?.app_clean_at_finish !== true) {
    errors.push("app_worktree_cleanliness_not_proven");
  }

  const startAttestation = asObject(evidence.start_attestation);
  const startValidation = validateStartClaimAttestation(
    {
      version: TASK_LIFECYCLE_SOAK_RUN_VERSION,
      run_id: asString(evidence.run_id),
      status: "running",
      started_at: asString(evidence.started_at),
      required_duration_ms: evidence.required_duration_ms,
      app_commit: appStart,
      data_commit: dataStart,
      app_clean_at_start: repositories?.app_clean_at_start === true,
      baseline: evidence.baseline,
      attestation_public_key_sha256: asString(startAttestation?.public_key_sha256),
    },
    evidence.start_attestation,
  );
  errors.push(...startValidation.errors);

  for (const [name, snapshot] of [["baseline", evidence.baseline], ["final", evidence.final]] as const) {
    if (snapshot?.status !== "healthy" || snapshot.counts?.blockers !== 0) errors.push(`${name}_lifecycle_not_healthy`);
    if (!isSha256(snapshot?.report_sha256) || !isSha256(snapshot?.task_ids_sha256)) errors.push(`${name}_snapshot_hash_invalid`);
  }
  if (evidence.baseline?.counts?.active !== 0) errors.push("baseline_active_tasks_not_drained");
  if (!Array.isArray(evidence.window?.tasks)) errors.push("window_tasks_invalid");
  if (!(evidence.window?.counts?.durable_tasks >= 2)) errors.push("insufficient_durable_tasks_in_window");
  if (!(evidence.window?.counts?.terminal_tasks >= 2)) errors.push("insufficient_terminal_tasks_in_window");
  if (evidence.window?.counts?.blocker_tasks !== 0) errors.push("window_blocker_tasks_present");
  if (evidence.window?.counts?.tasks !== evidence.window?.tasks?.length) errors.push("window_task_count_mismatch");

  const agents = evidence.client_proofs?.map((proof) => proof.agent).sort() ?? [];
  if (JSON.stringify(agents) !== JSON.stringify(["claude", "codex"])) errors.push("exact_codex_claude_proof_set_required");
  const windowTaskIds = new Set(evidence.window?.tasks?.map((task) => task.task_id) ?? []);
  if (windowTaskIds.size !== (evidence.window?.tasks?.length ?? 0)) errors.push("window_task_ids_not_unique");
  for (const proof of evidence.client_proofs ?? []) {
    const generated = Date.parse(proof.generated_at);
    if (
      proof.status !== "verified" ||
      !Number.isFinite(generated) ||
      generated < startedAt ||
      generated > finishedAt + 5 * 60_000 ||
      finishedAt - generated > TASK_LIFECYCLE_SOAK_MINIMUM_MS
    ) {
      errors.push(`client_proof_time_or_status_invalid:${proof.agent}`);
    }
    if (!windowTaskIds.has(proof.task_id)) errors.push(`client_proof_task_outside_window:${proof.agent}`);
    const proofTask = evidence.window?.tasks?.find((task) => task.task_id === proof.task_id);
    if (proofTask?.lifecycle_state !== "terminal" || proofTask?.grounding_classification !== "grounded") {
      errors.push(`client_proof_task_not_terminal_grounded:${proof.agent}`);
    }
    if (!safeRelativePath(proof.proof_path) || !isSha256(proof.proof_file_sha256) || !isSha256(proof.proof_sha256)) {
      errors.push(`client_proof_binding_invalid:${proof.agent}`);
    }
  }

  const attestation = asObject(evidence.attestation);
  let payloadSha256: string | null = null;
  if (
    attestation?.version !== TASK_LIFECYCLE_SOAK_ATTESTATION_VERSION ||
    attestation?.algorithm !== "ed25519"
  ) {
    errors.push("attestation_invalid");
  } else {
    try {
      const publicKeyDer = Buffer.from(asString(attestation.public_key_spki_base64), "base64");
      const publicKeySha256 = sha256Bytes(publicKeyDer);
      if (publicKeySha256 !== asString(attestation.public_key_sha256)) errors.push("attestation_public_key_hash_mismatch");
      if (publicKeySha256 !== asString(startAttestation?.public_key_sha256)) errors.push("start_and_final_attestation_identity_mismatch");
      const canonical = canonicalJson(publicPayload(evidence));
      payloadSha256 = sha256Bytes(canonical);
      if (payloadSha256 !== asString(attestation.payload_sha256)) errors.push("attestation_payload_hash_mismatch");
      const publicKey = createPublicKey({ key: publicKeyDer, format: "der", type: "spki" });
      if (!verify(null, Buffer.from(canonical, "utf8"), publicKey, Buffer.from(asString(attestation.signature_base64), "base64"))) {
        errors.push("attestation_signature_invalid");
      }
    } catch {
      errors.push("attestation_parse_failed");
    }
  }

  if (options.dataRoot) {
    const dataRoot = path.resolve(options.dataRoot);
    for (const proof of evidence.client_proofs ?? []) {
      if (!(await hashBoundPath(dataRoot, proof.proof_path, proof.proof_file_sha256))) {
        errors.push(`client_proof_file_hash_mismatch:${proof.agent}`);
        continue;
      }
      try {
        const parsed = JSON.parse(await fs.readFile(dataPath(dataRoot, ...proof.proof_path.split("/")), "utf8")) as JsonObject;
        if (
          parsed.agent !== proof.agent ||
          parsed.task_id !== proof.task_id ||
          parsed.generated_at !== proof.generated_at ||
          parsed.proof_sha256 !== proof.proof_sha256
        ) {
          errors.push(`client_proof_content_binding_mismatch:${proof.agent}`);
        }
      } catch {
        errors.push(`client_proof_content_invalid:${proof.agent}`);
      }
    }
    for (const task of evidence.window?.tasks ?? []) {
      if (!(await hashBoundPath(dataRoot, task.task_path, task.task_sha256))) errors.push(`task_hash_mismatch:${task.task_id}`);
      if (task.trace_path && task.trace_sha256 && !(await hashBoundPath(dataRoot, task.trace_path, task.trace_sha256))) {
        errors.push(`trace_hash_mismatch:${task.task_id}`);
      }
    }
  }
  const normalized = unique(errors);
  return { ok: normalized.length === 0, complete: normalized.length === 0 && evidence.status === "complete", errors: normalized, payload_sha256: payloadSha256 };
}

export async function validateTaskLifecycleSoakEvidenceFile(
  filePath: string,
  options: { dataRoot?: string; now?: Date } = {},
): Promise<TaskLifecycleSoakValidation> {
  try {
    return await validateTaskLifecycleSoakEvidence(JSON.parse(await fs.readFile(path.resolve(filePath), "utf8")), options);
  } catch {
    return { ok: false, complete: false, errors: ["evidence_file_missing_or_invalid"], payload_sha256: null };
  }
}

export async function showTaskLifecycleSoak(options: {
  runId?: string;
  localStateRoot?: string;
}): Promise<TaskLifecycleSoakRunDescriptor> {
  return loadDescriptor(path.resolve(options.localStateRoot ?? defaultLocalStateRoot()), options.runId);
}
