import { createHash, randomUUID } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

import { atomicWriteJson, atomicWriteText } from "./concurrency.js";
import {
  COMPLETION_ARTIFACTS,
  COMPLETION_COMMANDS,
  COMPLETION_CONTRACT_VERSION,
  COMPLETION_EXTERNAL_EVIDENCE,
  COMPLETION_GATES,
  type CompletionArtifactSpec,
  type CompletionCommandSpec,
  type HardGateId,
} from "./completion-registry.js";
import { DINOBRAIN_VERSION_MANIFEST } from "./version.js";

const execFileAsync = promisify(execFile);
const COMPLETION_AUDIT_VERSION = "completion_audit_v1";
const SQLITE_HEADER = Buffer.from("SQLite format 3\0", "ascii");

export type CompletionResultStatus = "PASS" | "FAIL" | "BLOCKED" | "NOT_APPLICABLE";

export type CompletionCommandExecution = {
  exit_code: number | null;
  signal: string | null;
  stdout_sha256: string;
  stderr_sha256: string;
  stdout_bytes: number;
  stderr_bytes: number;
  timed_out: boolean;
};

export type CompletionCommandResult = CompletionCommandExecution & {
  version: typeof COMPLETION_AUDIT_VERSION;
  audit_run_id: string;
  command_id: string;
  command: string;
  npm_script: string;
  required: true;
  gates: HardGateId[];
  started_at: string;
  finished_at: string;
  elapsed_ms: number;
  status: CompletionResultStatus;
  reason: string | null;
  output_artifact_path: string;
};

export type CompletionArtifactEntry = {
  artifact_id: string;
  source: "required_artifact" | "command_summary" | "command_ledger" | "external_evidence";
  gates: HardGateId[];
  path: string | null;
  exists: boolean;
  size_bytes: number | null;
  sha256: string | null;
  mtime: string | null;
  generated_at: string | null;
  parse_status: "ok" | "missing" | "invalid";
  reported_status: string | null;
  warning_count: number;
  fresh: boolean;
  status: CompletionResultStatus;
  reason: string | null;
};

export type CompletionGitIdentity = {
  repository: "app" | "data";
  head: string | null;
  upstream_head: string | null;
  head_matches_upstream: boolean | null;
  tracked_dirty_count: number;
  untracked_count: number;
};

export type CompletionAuditIdentity = {
  app: CompletionGitIdentity;
  data: CompletionGitIdentity;
  package_version: string | null;
  os_version: string;
  installer_version: string | null;
  data_contract_version: number;
  release_candidate_tag: string | null;
  version_aligned: boolean;
};

export type CompletionArtifactManifest = {
  version: typeof COMPLETION_AUDIT_VERSION;
  contract_version: typeof COMPLETION_CONTRACT_VERSION;
  audit_run_id: string;
  generated_at: string;
  app_commit: string | null;
  data_commit: string | null;
  entries: CompletionArtifactEntry[];
  counts: {
    entries: number;
    pass: number;
    fail: number;
    blocked: number;
    missing: number;
    invalid: number;
  };
};

export type CompletionGateResult = {
  gate_id: HardGateId;
  title: string;
  status: CompletionResultStatus;
  reasons: string[];
  command_ids: string[];
  artifact_ids: string[];
  external_evidence_ids: string[];
};

export type CompletionVerdict = {
  version: typeof COMPLETION_AUDIT_VERSION;
  contract_version: typeof COMPLETION_CONTRACT_VERSION;
  audit_run_id: string;
  auditor: string;
  started_at: string;
  finished_at: string;
  status: "COMPLETE" | "NOT_COMPLETE";
  identity: CompletionAuditIdentity;
  command_results_path: string;
  artifact_manifest_path: string;
  artifact_manifest_sha256: string;
  gate_results: CompletionGateResult[];
  automatic_disqualifiers: string[];
  failing_predicates: string[];
};

export type CompletionAuditRunResult = {
  audit_run_id: string;
  audit_dir: string;
  command_results_path: string;
  artifact_manifest_path: string;
  completion_verdict_path: string;
  verdict: CompletionVerdict;
};

export type CompletionAuditOptions = {
  appRoot: string;
  dataRoot: string;
  auditor?: string;
  auditRunId?: string;
  selectedCommandIds?: string[];
  externalEvidencePaths?: Record<string, string>;
  commandRunner?: (spec: CompletionCommandSpec, appRoot: string) => Promise<CompletionCommandExecution>;
  now?: () => Date;
};

function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function isoCompact(date: Date): string {
  return date.toISOString().replace(/[-:]/g, "").replace("T", "-").replace(/[.Z]/g, "");
}

export function createCompletionAuditRunId(now = new Date()): string {
  return `completion-${isoCompact(now)}-${randomUUID()}`;
}

function dataPath(dataRoot: string, relativePath: string): string {
  return path.resolve(dataRoot, ...relativePath.split("/"));
}

function toDataRelativePath(dataRoot: string, filePath: string): string | null {
  const relative = path.relative(path.resolve(dataRoot), path.resolve(filePath));
  if (!relative || relative === ".") return ".";
  if (relative.startsWith("..") || path.isAbsolute(relative)) return null;
  return relative.replace(/\\/g, "/");
}

function safeFileId(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
}

async function gitText(root: string, args: string[]): Promise<string | null> {
  try {
    const result = await execFileAsync("git", ["-C", root, ...args], {
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024,
    });
    const value = result.stdout.trim();
    return value || null;
  } catch {
    return null;
  }
}

async function gitIdentity(
  root: string,
  repository: CompletionGitIdentity["repository"],
  excludedRelativePaths: string[] = [],
): Promise<CompletionGitIdentity> {
  const statusArgs = ["status", "--porcelain=v1"];
  if (excludedRelativePaths.length > 0) {
    statusArgs.push("--", ".", ...excludedRelativePaths.map((entry) => `:(exclude)${entry.replace(/\\/g, "/")}`));
  }
  const [head, upstreamHead, status] = await Promise.all([
    gitText(root, ["rev-parse", "HEAD"]),
    gitText(root, ["rev-parse", "@{u}"]),
    gitText(root, statusArgs),
  ]);
  const lines = status?.split(/\r?\n/).filter(Boolean) ?? [];
  return {
    repository,
    head,
    upstream_head: upstreamHead,
    head_matches_upstream: head && upstreamHead ? head === upstreamHead : null,
    tracked_dirty_count: lines.filter((line) => !line.startsWith("?? ")).length,
    untracked_count: lines.filter((line) => line.startsWith("?? ")).length,
  };
}

async function readJsonObject(filePath: string): Promise<Record<string, unknown> | null> {
  try {
    const value = JSON.parse(await fs.readFile(filePath, "utf8")) as unknown;
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

async function installerVersion(appRoot: string): Promise<string | null> {
  try {
    const text = await fs.readFile(path.join(appRoot, "installer", "DinoBrainSetup", "DinoBrainSetup.csproj"), "utf8");
    return text.match(/<Version>([^<]+)<\/Version>/)?.[1]?.trim() ?? null;
  } catch {
    return null;
  }
}

async function captureIdentity(
  appRoot: string,
  dataRoot: string,
  excludedDataPaths: string[] = [],
): Promise<CompletionAuditIdentity> {
  const [app, data, packageJson, setupVersion] = await Promise.all([
    gitIdentity(appRoot, "app"),
    gitIdentity(dataRoot, "data", excludedDataPaths),
    readJsonObject(path.join(appRoot, "package.json")),
    installerVersion(appRoot),
  ]);
  const packageVersion = typeof packageJson?.version === "string" ? packageJson.version : null;
  const version = DINOBRAIN_VERSION_MANIFEST.version;
  return {
    app,
    data,
    package_version: packageVersion,
    os_version: version,
    installer_version: setupVersion,
    data_contract_version: DINOBRAIN_VERSION_MANIFEST.data_contract_version,
    release_candidate_tag: version ? `v${version}` : null,
    version_aligned: packageVersion === version && setupVersion === version,
  };
}

function emptyHash(): string {
  return sha256("");
}

export async function runNpmCompletionCommand(
  spec: CompletionCommandSpec,
  appRoot: string,
): Promise<CompletionCommandExecution> {
  const npmExecPath = process.env.npm_execpath;
  const commandName = npmExecPath ? process.execPath : process.platform === "win32" ? "npm.cmd" : "npm";
  const args = npmExecPath ? [npmExecPath, "run", spec.npm_script] : ["run", spec.npm_script];
  const stdoutHash = createHash("sha256");
  const stderrHash = createHash("sha256");
  let stdoutBytes = 0;
  let stderrBytes = 0;
  return await new Promise((resolve, reject) => {
    const child = spawn(commandName, args, {
      cwd: appRoot,
      windowsHide: true,
      shell: false,
      env: { ...process.env, ...(spec.environment ?? {}) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, spec.timeout_ms);
    timer.unref();
    child.stdout.on("data", (chunk: Buffer) => {
      stdoutHash.update(chunk);
      stdoutBytes += chunk.length;
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrHash.update(chunk);
      stderrBytes += chunk.length;
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({
        exit_code: code,
        signal,
        stdout_sha256: stdoutBytes > 0 ? stdoutHash.digest("hex") : emptyHash(),
        stderr_sha256: stderrBytes > 0 ? stderrHash.digest("hex") : emptyHash(),
        stdout_bytes: stdoutBytes,
        stderr_bytes: stderrBytes,
        timed_out: timedOut,
      });
    });
  });
}

async function inspectArtifact(params: {
  spec: CompletionArtifactSpec;
  dataRoot: string;
  auditStartedAt: Date;
  now: Date;
}): Promise<CompletionArtifactEntry> {
  const filePath = dataPath(params.dataRoot, params.spec.relative_path);
  try {
    const [raw, stat] = await Promise.all([fs.readFile(filePath), fs.stat(filePath)]);
    let parsed: Record<string, unknown> | null = null;
    try {
      if (params.spec.kind === "json") {
        const value = JSON.parse(raw.toString("utf8")) as unknown;
        if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("JSON root must be an object");
        parsed = value as Record<string, unknown>;
      } else if (params.spec.kind === "jsonl") {
        for (const line of raw.toString("utf8").split(/\r?\n/).filter(Boolean)) JSON.parse(line);
      } else if (params.spec.kind === "sqlite" && !raw.subarray(0, SQLITE_HEADER.length).equals(SQLITE_HEADER)) {
        throw new Error("SQLite header is invalid");
      }
    } catch (error) {
      return {
        artifact_id: params.spec.id,
        source: "required_artifact",
        gates: params.spec.gates,
        path: params.spec.relative_path,
        exists: true,
        size_bytes: stat.size,
        sha256: sha256(raw),
        mtime: stat.mtime.toISOString(),
        generated_at: null,
        parse_status: "invalid",
        reported_status: null,
        warning_count: 0,
        fresh: false,
        status: "FAIL",
        reason: error instanceof Error ? error.message : "artifact_parse_failed",
      };
    }
    const reportedStatus = typeof parsed?.status === "string" ? parsed.status : null;
    const generatedAt = typeof parsed?.generated_at === "string" ? parsed.generated_at : null;
    const warnings = Array.isArray(parsed?.warnings) ? parsed.warnings.filter(Boolean) : [];
    const freshnessBaseline = params.spec.freshness_ms
      ? params.now.getTime() - params.spec.freshness_ms
      : params.auditStartedAt.getTime() - 2_000;
    const evidenceTime = generatedAt ? Date.parse(generatedAt) : stat.mtimeMs;
    const fresh = Number.isFinite(evidenceTime) && evidenceTime >= freshnessBaseline;
    const accepted =
      !params.spec.accepted_statuses ||
      (reportedStatus !== null && params.spec.accepted_statuses.includes(reportedStatus));
    const ok = fresh && accepted && warnings.length === 0;
    return {
      artifact_id: params.spec.id,
      source: "required_artifact",
      gates: params.spec.gates,
      path: params.spec.relative_path,
      exists: true,
      size_bytes: stat.size,
      sha256: sha256(raw),
      mtime: stat.mtime.toISOString(),
      generated_at: generatedAt,
      parse_status: "ok",
      reported_status: reportedStatus,
      warning_count: warnings.length,
      fresh,
      status: ok ? "PASS" : "FAIL",
      reason: !fresh
        ? "artifact_stale_for_audit_run"
        : !accepted
          ? `artifact_status_not_accepted:${reportedStatus ?? "missing"}`
          : warnings.length > 0
            ? "artifact_warnings_present"
            : null,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return {
      artifact_id: params.spec.id,
      source: "required_artifact",
      gates: params.spec.gates,
      path: params.spec.relative_path,
      exists: false,
      size_bytes: null,
      sha256: null,
      mtime: null,
      generated_at: null,
      parse_status: "missing",
      reported_status: null,
      warning_count: 0,
      fresh: false,
      status: "BLOCKED",
      reason: "required_artifact_missing",
    };
  }
}

async function inspectRecordedFile(params: {
  id: string;
  source: CompletionArtifactEntry["source"];
  gates: HardGateId[];
  dataRoot: string;
  filePath: string;
  parseJson: boolean;
}): Promise<CompletionArtifactEntry> {
  const relativePath = toDataRelativePath(params.dataRoot, params.filePath);
  if (relativePath === null) {
    return {
      artifact_id: params.id,
      source: params.source,
      gates: params.gates,
      path: null,
      exists: false,
      size_bytes: null,
      sha256: null,
      mtime: null,
      generated_at: null,
      parse_status: "invalid",
      reported_status: null,
      warning_count: 0,
      fresh: false,
      status: "FAIL",
      reason: "evidence_path_outside_data_root",
    };
  }
  try {
    const [raw, stat] = await Promise.all([fs.readFile(params.filePath), fs.stat(params.filePath)]);
    let parsed: Record<string, unknown> | null = null;
    try {
      if (params.parseJson) {
        const value = JSON.parse(raw.toString("utf8")) as unknown;
        if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("JSON root must be an object");
        parsed = value as Record<string, unknown>;
      } else {
        for (const line of raw.toString("utf8").split(/\r?\n/).filter(Boolean)) JSON.parse(line);
      }
    } catch (error) {
      return {
        artifact_id: params.id,
        source: params.source,
        gates: params.gates,
        path: relativePath,
        exists: true,
        size_bytes: stat.size,
        sha256: sha256(raw),
        mtime: stat.mtime.toISOString(),
        generated_at: null,
        parse_status: "invalid",
        reported_status: null,
        warning_count: 0,
        fresh: false,
        status: "FAIL",
        reason: error instanceof Error ? error.message : "evidence_parse_failed",
      };
    }
    const reportedStatus = typeof parsed?.status === "string" ? parsed.status : null;
    const generatedAt = typeof parsed?.generated_at === "string" ? parsed.generated_at : null;
    return {
      artifact_id: params.id,
      source: params.source,
      gates: params.gates,
      path: relativePath,
      exists: true,
      size_bytes: stat.size,
      sha256: sha256(raw),
      mtime: stat.mtime.toISOString(),
      generated_at: generatedAt,
      parse_status: "ok",
      reported_status: reportedStatus,
      warning_count: 0,
      fresh: true,
      status: "PASS",
      reason: null,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return {
      artifact_id: params.id,
      source: params.source,
      gates: params.gates,
      path: relativePath,
      exists: false,
      size_bytes: null,
      sha256: null,
      mtime: null,
      generated_at: null,
      parse_status: "missing",
      reported_status: null,
      warning_count: 0,
      fresh: false,
      status: "BLOCKED",
      reason: "evidence_missing",
    };
  }
}

function gateStatus(reasons: string[], failed: boolean): CompletionResultStatus {
  if (reasons.length === 0) return "PASS";
  return failed ? "FAIL" : "BLOCKED";
}

function buildGateResults(params: {
  commands: CompletionCommandResult[];
  artifacts: CompletionArtifactEntry[];
  identity: CompletionAuditIdentity;
}): CompletionGateResult[] {
  return COMPLETION_GATES.map((gate) => {
    const reasons: string[] = [];
    let failed = false;
    for (const commandId of gate.command_ids) {
      const result = params.commands.find((entry) => entry.command_id === commandId);
      if (!result || result.status !== "PASS") {
        reasons.push(`command:${commandId}:${result?.reason ?? "missing"}`);
        if (result?.status === "FAIL") failed = true;
      }
    }
    for (const artifactId of [...gate.artifact_ids, ...gate.external_evidence_ids]) {
      const result = params.artifacts.find((entry) => entry.artifact_id === artifactId);
      if (!result || result.status !== "PASS") {
        reasons.push(`artifact:${artifactId}:${result?.reason ?? "missing"}`);
        if (result?.status === "FAIL") failed = true;
      }
    }
    if (gate.id === "HG-11" || gate.id === "HG-12") {
      if (!params.identity.version_aligned) {
        reasons.push("identity:version_not_aligned");
        failed = true;
      }
    }
    if (gate.id === "HG-12") {
      if (params.identity.app.head_matches_upstream !== true) reasons.push("identity:app_head_not_at_upstream");
      if (params.identity.data.head_matches_upstream !== true) reasons.push("identity:data_head_not_at_upstream");
      if (params.identity.app.tracked_dirty_count > 0 || params.identity.app.untracked_count > 0) {
        reasons.push("identity:app_worktree_dirty");
      }
      if (params.identity.data.tracked_dirty_count > 0 || params.identity.data.untracked_count > 0) {
        reasons.push("identity:data_worktree_dirty");
      }
    }
    return {
      gate_id: gate.id,
      title: gate.title,
      status: gateStatus(reasons, failed),
      reasons,
      command_ids: gate.command_ids,
      artifact_ids: gate.artifact_ids,
      external_evidence_ids: gate.external_evidence_ids,
    };
  });
}

function buildAutomaticDisqualifiers(params: {
  commands: CompletionCommandResult[];
  artifacts: CompletionArtifactEntry[];
  identity: CompletionAuditIdentity;
  gates: CompletionGateResult[];
}): string[] {
  const reasons: string[] = [];
  if (params.commands.some((entry) => entry.status !== "PASS")) reasons.push("mandatory_command_not_passed");
  if (params.artifacts.some((entry) => entry.status !== "PASS")) reasons.push("required_evidence_not_passed");
  if (params.artifacts.some((entry) => entry.parse_status === "invalid")) reasons.push("malformed_evidence_present");
  if (params.artifacts.some((entry) => entry.warning_count > 0)) reasons.push("warning_bearing_evidence_present");
  if (!params.identity.version_aligned) reasons.push("version_identity_drift");
  if (params.gates.some((entry) => entry.status !== "PASS")) reasons.push("hard_gate_not_passed");
  const generatedArtifacts = params.artifacts.filter(
    (entry) => entry.source === "required_artifact" && entry.generated_at && Number.isFinite(Date.parse(entry.generated_at)),
  );
  const newestDependencyTime = Math.max(
    0,
    ...generatedArtifacts
      .filter((entry) => !["health_status", "monitoring_status"].includes(entry.artifact_id))
      .map((entry) => Date.parse(entry.generated_at!)),
  );
  for (const rollupId of ["health_status", "monitoring_status"]) {
    const rollup = generatedArtifacts.find((entry) => entry.artifact_id === rollupId);
    if (!rollup || Date.parse(rollup.generated_at!) < newestDependencyTime) {
      reasons.push(`${rollupId}_generation_not_coherent`);
    }
  }
  return [...new Set(reasons)];
}

export async function runCompletionAudit(options: CompletionAuditOptions): Promise<CompletionAuditRunResult> {
  const now = options.now ?? (() => new Date());
  const startedAt = now();
  const auditRunId = options.auditRunId ?? createCompletionAuditRunId(startedAt);
  if (!/^completion-[A-Za-z0-9._-]+$/.test(auditRunId)) throw new Error("Invalid completion audit run id");
  const dataRoot = path.resolve(options.dataRoot);
  const appRoot = path.resolve(options.appRoot);
  const auditDir = dataPath(dataRoot, `.dino/audits/completion/${auditRunId}`);
  const commandsDir = path.join(auditDir, "commands");
  await fs.mkdir(commandsDir, { recursive: true });
  const selected = options.selectedCommandIds ? new Set(options.selectedCommandIds) : null;
  if (selected) {
    const known = new Set(COMPLETION_COMMANDS.map((entry) => entry.id));
    const unknown = [...selected].filter((entry) => !known.has(entry));
    if (unknown.length > 0) throw new Error(`Unknown completion command ids: ${unknown.join(", ")}`);
  }
  const runner = options.commandRunner ?? runNpmCompletionCommand;
  const commandResults: CompletionCommandResult[] = [];

  for (const spec of COMPLETION_COMMANDS) {
    const commandStarted = now();
    let execution: CompletionCommandExecution;
    let reason: string | null = null;
    let status: CompletionResultStatus;
    if (selected && !selected.has(spec.id)) {
      execution = {
        exit_code: null,
        signal: null,
        stdout_sha256: emptyHash(),
        stderr_sha256: emptyHash(),
        stdout_bytes: 0,
        stderr_bytes: 0,
        timed_out: false,
      };
      status = "BLOCKED";
      reason = "command_not_selected_for_this_audit_run";
    } else {
      try {
        execution = await runner(spec, appRoot);
        status = execution.exit_code === 0 && !execution.timed_out ? "PASS" : "FAIL";
        reason = execution.timed_out
          ? "command_timed_out"
          : execution.exit_code === 0
            ? null
            : `command_exit_${execution.exit_code ?? "unknown"}`;
      } catch (error) {
        execution = {
          exit_code: null,
          signal: null,
          stdout_sha256: emptyHash(),
          stderr_sha256: sha256(error instanceof Error ? error.message : String(error)),
          stdout_bytes: 0,
          stderr_bytes: Buffer.byteLength(error instanceof Error ? error.message : String(error)),
          timed_out: false,
        };
        status = "FAIL";
        reason = "command_spawn_failed";
      }
    }
    const commandFinished = now();
    const outputPath = path.join(commandsDir, `${safeFileId(spec.id)}.json`);
    const result: CompletionCommandResult = {
      version: COMPLETION_AUDIT_VERSION,
      audit_run_id: auditRunId,
      command_id: spec.id,
      command: `npm run ${spec.npm_script}`,
      npm_script: spec.npm_script,
      required: true,
      gates: spec.gates,
      started_at: commandStarted.toISOString(),
      finished_at: commandFinished.toISOString(),
      elapsed_ms: Math.max(0, commandFinished.getTime() - commandStarted.getTime()),
      status,
      reason,
      output_artifact_path: toDataRelativePath(dataRoot, outputPath) ?? "",
      ...execution,
    };
    await atomicWriteJson(outputPath, result);
    commandResults.push(result);
  }

  const commandResultsPath = path.join(auditDir, "command-results.jsonl");
  await atomicWriteText(commandResultsPath, `${commandResults.map((entry) => JSON.stringify(entry)).join("\n")}\n`, async (candidate) => {
    for (const line of (await fs.readFile(candidate, "utf8")).split(/\r?\n/).filter(Boolean)) JSON.parse(line);
  });

  const identity = await captureIdentity(appRoot, dataRoot, [`.dino/audits/completion/${auditRunId}`]);
  const artifactEntries = await Promise.all(
    COMPLETION_ARTIFACTS.map((spec) => inspectArtifact({ spec, dataRoot, auditStartedAt: startedAt, now: now() })),
  );
  for (const result of commandResults) {
    artifactEntries.push(
      await inspectRecordedFile({
        id: `command_summary:${result.command_id}`,
        source: "command_summary",
        gates: result.gates,
        dataRoot,
        filePath: dataPath(dataRoot, result.output_artifact_path),
        parseJson: true,
      }),
    );
  }
  artifactEntries.push(
    await inspectRecordedFile({
      id: "command_results",
      source: "command_ledger",
      gates: [...new Set(COMPLETION_COMMANDS.flatMap((entry) => entry.gates))],
      dataRoot,
      filePath: commandResultsPath,
      parseJson: false,
    }),
  );

  for (const spec of COMPLETION_EXTERNAL_EVIDENCE) {
    const suppliedPath = options.externalEvidencePaths?.[spec.id];
    if (!suppliedPath) {
      artifactEntries.push({
        artifact_id: spec.id,
        source: "external_evidence",
        gates: spec.gates,
        path: null,
        exists: false,
        size_bytes: null,
        sha256: null,
        mtime: null,
        generated_at: null,
        parse_status: "missing",
        reported_status: null,
        warning_count: 0,
        fresh: false,
        status: "BLOCKED",
        reason: "external_evidence_not_supplied",
      });
      continue;
    }
    const entry = await inspectRecordedFile({
      id: spec.id,
      source: "external_evidence",
      gates: spec.gates,
      dataRoot,
      filePath: path.resolve(suppliedPath),
      parseJson: true,
    });
    if (entry.status === "PASS") {
      const accepted = ["PASS", "pass", "healthy", "verified", "complete", "completed"].includes(
        entry.reported_status ?? "",
      );
      const evidenceTime = entry.generated_at ? Date.parse(entry.generated_at) : Date.parse(entry.mtime ?? "");
      const fresh =
        spec.freshness_ms === null ||
        (Number.isFinite(evidenceTime) && evidenceTime >= now().getTime() - spec.freshness_ms);
      entry.fresh = fresh;
      entry.status = accepted && fresh ? "PASS" : "FAIL";
      entry.reason = !accepted ? "external_evidence_status_not_accepted" : !fresh ? "external_evidence_stale" : null;
    }
    artifactEntries.push(entry);
  }

  const manifest: CompletionArtifactManifest = {
    version: COMPLETION_AUDIT_VERSION,
    contract_version: COMPLETION_CONTRACT_VERSION,
    audit_run_id: auditRunId,
    generated_at: now().toISOString(),
    app_commit: identity.app.head,
    data_commit: identity.data.head,
    entries: artifactEntries,
    counts: {
      entries: artifactEntries.length,
      pass: artifactEntries.filter((entry) => entry.status === "PASS").length,
      fail: artifactEntries.filter((entry) => entry.status === "FAIL").length,
      blocked: artifactEntries.filter((entry) => entry.status === "BLOCKED").length,
      missing: artifactEntries.filter((entry) => entry.parse_status === "missing").length,
      invalid: artifactEntries.filter((entry) => entry.parse_status === "invalid").length,
    },
  };
  const artifactManifestPath = path.join(auditDir, "artifact-manifest.json");
  await atomicWriteJson(artifactManifestPath, manifest);
  const artifactManifestRaw = await fs.readFile(artifactManifestPath);
  const gates = buildGateResults({ commands: commandResults, artifacts: artifactEntries, identity });
  const automaticDisqualifiers = buildAutomaticDisqualifiers({
    commands: commandResults,
    artifacts: artifactEntries,
    identity,
    gates,
  });
  const failingPredicates = gates
    .filter((gate) => gate.status !== "PASS")
    .flatMap((gate) => gate.reasons.map((reason) => `${gate.gate_id}:${reason}`));
  const verdict: CompletionVerdict = {
    version: COMPLETION_AUDIT_VERSION,
    contract_version: COMPLETION_CONTRACT_VERSION,
    audit_run_id: auditRunId,
    auditor: options.auditor ?? "codex",
    started_at: startedAt.toISOString(),
    finished_at: now().toISOString(),
    status: gates.every((gate) => gate.status === "PASS") && automaticDisqualifiers.length === 0 ? "COMPLETE" : "NOT_COMPLETE",
    identity,
    command_results_path: toDataRelativePath(dataRoot, commandResultsPath) ?? "",
    artifact_manifest_path: toDataRelativePath(dataRoot, artifactManifestPath) ?? "",
    artifact_manifest_sha256: sha256(artifactManifestRaw),
    gate_results: gates,
    automatic_disqualifiers: automaticDisqualifiers,
    failing_predicates: failingPredicates,
  };
  const completionVerdictPath = path.join(auditDir, "completion-verdict.json");
  await atomicWriteJson(completionVerdictPath, verdict);
  const verification = await verifyCompletionEvidencePack(dataRoot, auditRunId);
  if (!verification.ok) {
    throw new Error(`Completion evidence pack failed post-write verification: ${verification.errors.join(", ")}`);
  }
  return {
    audit_run_id: auditRunId,
    audit_dir: auditDir,
    command_results_path: commandResultsPath,
    artifact_manifest_path: artifactManifestPath,
    completion_verdict_path: completionVerdictPath,
    verdict,
  };
}

export async function verifyCompletionEvidencePack(dataRoot: string, auditRunId: string): Promise<{
  ok: boolean;
  errors: string[];
  verdict: CompletionVerdict | null;
}> {
  const auditDir = dataPath(dataRoot, `.dino/audits/completion/${auditRunId}`);
  const verdictPath = path.join(auditDir, "completion-verdict.json");
  const manifestPath = path.join(auditDir, "artifact-manifest.json");
  const ledgerPath = path.join(auditDir, "command-results.jsonl");
  const errors: string[] = [];
  let verdict: CompletionVerdict | null = null;
  let manifest: CompletionArtifactManifest | null = null;
  try {
    verdict = JSON.parse(await fs.readFile(verdictPath, "utf8")) as CompletionVerdict;
    if (verdict.audit_run_id !== auditRunId) errors.push("verdict_audit_run_id_mismatch");
  } catch {
    errors.push("completion_verdict_missing_or_invalid");
  }
  try {
    const raw = await fs.readFile(manifestPath);
    manifest = JSON.parse(raw.toString("utf8")) as CompletionArtifactManifest;
    if (manifest.audit_run_id !== auditRunId) errors.push("manifest_audit_run_id_mismatch");
    if (verdict && sha256(raw) !== verdict.artifact_manifest_sha256) errors.push("manifest_hash_mismatch");
  } catch {
    errors.push("artifact_manifest_missing_or_invalid");
  }
  try {
    const lines = (await fs.readFile(ledgerPath, "utf8")).split(/\r?\n/).filter(Boolean);
    const parsed = lines.map((line) => JSON.parse(line) as CompletionCommandResult);
    if (parsed.length !== COMPLETION_COMMANDS.length) errors.push("command_ledger_count_mismatch");
    if (parsed.some((entry) => entry.audit_run_id !== auditRunId)) errors.push("command_ledger_audit_run_id_mismatch");
  } catch {
    errors.push("command_ledger_missing_or_invalid");
  }
  if (manifest) {
    for (const entry of manifest.entries.filter((item) => item.exists && item.path && item.sha256)) {
      try {
        const raw = await fs.readFile(dataPath(dataRoot, entry.path!));
        if (sha256(raw) !== entry.sha256) errors.push(`artifact_hash_mismatch:${entry.artifact_id}`);
      } catch {
        errors.push(`artifact_unreadable:${entry.artifact_id}`);
      }
    }
  }
  if (verdict?.status === "COMPLETE") {
    if (verdict.gate_results.some((gate) => gate.status !== "PASS")) errors.push("complete_verdict_has_nonpass_gate");
    if (verdict.automatic_disqualifiers.length > 0) errors.push("complete_verdict_has_disqualifier");
  }
  return { ok: errors.length === 0, errors, verdict };
}
