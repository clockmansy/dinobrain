import { execFile } from "node:child_process";
import {
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { atomicWriteJson, withFileLock } from "./concurrency.js";
import { dataPath, relDataPath } from "./context.js";

const execFileAsync = promisify(execFile);

export const CLIENT_MCP_PROOF_VERSION = "client_mcp_direct_proof_v2";
export const CLIENT_MCP_CHALLENGE_VERSION = "client_mcp_challenge_v1";
export const CLIENT_MCP_RECEIPT_LEDGER_VERSION = "client_mcp_receipt_ledger_v1";
export const CLIENT_MCP_PROOF_DIR = ".dino/proofs/client-mcp";
export const CLIENT_MCP_REQUIRED_TOOLS = [
  "os_begin_task",
  "get_context_pack",
  "wiki_search",
  "search_memory",
  "finish_task",
] as const;

export type ClientMcpAgent = "codex" | "claude";
export type ClientMcpRequiredTool = (typeof CLIENT_MCP_REQUIRED_TOOLS)[number];

export type McpClientInfo = {
  name: string;
  version: string;
};

export type ClientProcessEntry = {
  depth: number;
  pid: number;
  parent_pid: number | null;
  executable_name: string;
  executable_version: string | null;
  executable_path_sha256: string | null;
};

export type ClientProcessIdentity = {
  platform: string;
  collected_at: string;
  server_pid: number;
  server_parent_pid: number;
  observed_agent: ClientMcpAgent | null;
  chain: ClientProcessEntry[];
};

export type ClientMcpChallenge = {
  version: typeof CLIENT_MCP_CHALLENGE_VERSION;
  challenge_id: string;
  nonce: string;
  expected_agent: ClientMcpAgent;
  issued_at: string;
  expires_at: string;
  issuer: "dinobrain_local_cli";
  issuance_sha256: string;
  local_identity_fingerprint: string;
  status: "issued" | "active" | "finalized";
  activated_at?: string;
  finalized_at?: string;
  server_instance_id?: string;
  client_identity_sha256?: string;
  receipt_path?: string;
  final_proof_path?: string;
  final_proof_sha256?: string;
  challenge_hmac: string;
};

export type ClientMcpToolReceipt = {
  sequence: number;
  challenge_id: string;
  server_instance_id: string;
  tool: ClientMcpRequiredTool;
  at: string;
  input_sha256: string;
  result_sha256: string;
  ok: boolean;
  task_id: string | null;
  task_binding_ok: boolean;
  previous_receipt_sha256: string | null;
  receipt_sha256: string;
  receipt_hmac: string;
};

export type ClientMcpReceiptLedger = {
  version: typeof CLIENT_MCP_RECEIPT_LEDGER_VERSION;
  challenge_id: string;
  server_instance_id: string;
  local_identity_fingerprint: string;
  client_identity_sha256: string;
  receipts: ClientMcpToolReceipt[];
  ledger_head_sha256: string | null;
  ledger_hmac: string;
};

export type ClientMcpDirectProofV2 = {
  version: typeof CLIENT_MCP_PROOF_VERSION;
  agent: ClientMcpAgent;
  status: "verified";
  proof_source: "codex_desktop_direct_mcp" | "claude_code_direct_mcp";
  client_surface: "codex_desktop" | "claude_code";
  client_info: McpClientInfo;
  process_identity: ClientProcessIdentity;
  client_identity_sha256: string;
  local_identity_fingerprint: string;
  challenge_id: string;
  challenge_issuance_sha256: string;
  challenge_nonce_sha256: string;
  server_instance_id: string;
  tool_discovery_mode: "server_observed_exact_single_name";
  required_tools: ClientMcpRequiredTool[];
  verified_tools: ClientMcpRequiredTool[];
  missing_tools: ClientMcpRequiredTool[];
  tool_calls: Array<{
    tool: ClientMcpRequiredTool;
    ok: true;
    at: string;
    result_sha256: string;
    receipt_sha256: string;
  }>;
  task_id: string;
  receipt_path: string;
  receipt_chain_head: string;
  generated_at: string;
  stale_after_ms: number;
  proof_path: string;
  proof_sha256: string;
  proof_hmac: string;
};

export type ClientMcpProofValidation =
  | { ok: true; proof: ClientMcpDirectProofV2 }
  | { ok: false; reason: string };

type ProofStorageOptions = {
  localStateRoot?: string;
  now?: Date;
};

type RuntimeOptions = ProofStorageOptions & {
  getClientInfo: () => McpClientInfo | undefined;
  observeProcessIdentity?: () => Promise<ClientProcessIdentity>;
};

type ActiveProofSession = {
  challenge: ClientMcpChallenge;
  key: Buffer;
  clientInfo: McpClientInfo;
  processIdentity: ClientProcessIdentity;
  clientIdentitySha256: string;
  receiptPath: string;
  taskId: string | null;
};

type JsonObject = Record<string, unknown>;

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => canonicalize(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as JsonObject)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalize(item)]),
    );
  }
  return value;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

export function sha256Text(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function sha256Json(value: unknown): string {
  return sha256Text(canonicalJson(value));
}

function hmacText(key: Buffer, value: string): string {
  return createHmac("sha256", key).update(value, "utf8").digest("hex");
}

function equalHex(left: string, right: string): boolean {
  if (!/^[a-f0-9]{64}$/i.test(left) || !/^[a-f0-9]{64}$/i.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

function defaultLocalStateRoot(): string {
  const configured = process.env.DINOBRAIN_LOCAL_STATE_DIR?.trim();
  if (configured) return path.resolve(configured);
  if (process.platform === "win32" && process.env.LOCALAPPDATA) {
    return path.resolve(process.env.LOCALAPPDATA, "DinoBrain", "identity");
  }
  return path.resolve(os.homedir(), ".local", "state", "dinobrain");
}

function keyPath(options: ProofStorageOptions): string {
  return path.join(path.resolve(options.localStateRoot ?? defaultLocalStateRoot()), "client-mcp-proof-hmac.key");
}

async function readProofKeyFile(filePath: string): Promise<Buffer | null> {
  try {
    const encoded = (await fs.readFile(filePath, "utf8")).trim();
    const key = Buffer.from(encoded, "base64url");
    if (key.length !== 32) throw new Error("client MCP proof key has invalid length");
    return key;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function loadProofKey(options: ProofStorageOptions, create: boolean): Promise<Buffer | null> {
  const filePath = keyPath(options);
  const existing = await readProofKeyFile(filePath);
  if (existing || !create) return existing;

  await fs.mkdir(path.dirname(filePath), { recursive: true });
  return withFileLock(`${filePath}.lock`, async () => {
    const afterLock = await readProofKeyFile(filePath);
    if (afterLock) return afterLock;
    const candidate = randomBytes(32);
    const handle = await fs.open(filePath, "wx", 0o600);
    try {
      await handle.writeFile(`${candidate.toString("base64url")}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    return candidate;
  });
}

export async function readLocalProofIdentityFingerprint(options: ProofStorageOptions = {}): Promise<string | null> {
  const key = await loadProofKey(options, false);
  return key ? sha256Text(key.toString("base64url")) : null;
}

function challengeRoot(dataRoot: string): string {
  return dataPath(dataRoot, ...CLIENT_MCP_PROOF_DIR.split("/"), "challenges");
}

function receiptRoot(dataRoot: string): string {
  return dataPath(dataRoot, ...CLIENT_MCP_PROOF_DIR.split("/"), "receipts");
}

function challengePath(dataRoot: string, challengeId: string): string {
  if (!/^client-mcp-[a-f0-9-]{36}$/i.test(challengeId)) throw new Error("invalid client MCP challenge id");
  return path.join(challengeRoot(dataRoot), `${challengeId}.json`);
}

function receiptPath(dataRoot: string, challengeId: string): string {
  return path.join(receiptRoot(dataRoot), `${challengeId}.json`);
}

function proofLockPath(dataRoot: string): string {
  return dataPath(dataRoot, ".dino", "locks", "client-mcp-proof.lock");
}

function issuancePayload(challenge: Pick<ClientMcpChallenge, "challenge_id" | "nonce" | "expected_agent" | "issued_at" | "expires_at" | "issuer" | "local_identity_fingerprint">): JsonObject {
  return {
    challenge_id: challenge.challenge_id,
    nonce: challenge.nonce,
    expected_agent: challenge.expected_agent,
    issued_at: challenge.issued_at,
    expires_at: challenge.expires_at,
    issuer: challenge.issuer,
    local_identity_fingerprint: challenge.local_identity_fingerprint,
  };
}

function signChallenge(challenge: Omit<ClientMcpChallenge, "challenge_hmac">, key: Buffer): ClientMcpChallenge {
  const challengeHmac = hmacText(key, canonicalJson(challenge));
  return { ...challenge, challenge_hmac: challengeHmac };
}

function verifyChallenge(challenge: ClientMcpChallenge, key: Buffer): boolean {
  const { challenge_hmac: actual, ...unsigned } = challenge;
  const expected = hmacText(key, canonicalJson(unsigned));
  return equalHex(actual, expected) && challenge.issuance_sha256 === sha256Json(issuancePayload(challenge));
}

function isoNow(options: ProofStorageOptions): string {
  return (options.now ?? new Date()).toISOString();
}

export async function createClientMcpProofChallenge(
  dataRoot: string,
  agent: ClientMcpAgent,
  options: ProofStorageOptions & { ttlMs?: number } = {},
): Promise<{ challenge: ClientMcpChallenge; path: string; prompt: string }> {
  const key = await loadProofKey(options, true);
  if (!key) throw new Error("could not create client MCP proof identity key");
  const now = options.now ?? new Date();
  const ttlMs = Math.max(60_000, Math.min(options.ttlMs ?? 15 * 60_000, 60 * 60_000));
  const challengeId = `client-mcp-${randomUUID()}`;
  const base: Pick<
    ClientMcpChallenge,
    | "version"
    | "challenge_id"
    | "nonce"
    | "expected_agent"
    | "issued_at"
    | "expires_at"
    | "issuer"
    | "local_identity_fingerprint"
  > = {
    version: CLIENT_MCP_CHALLENGE_VERSION,
    challenge_id: challengeId,
    nonce: randomBytes(32).toString("base64url"),
    expected_agent: agent,
    issued_at: now.toISOString(),
    expires_at: new Date(now.getTime() + ttlMs).toISOString(),
    issuer: "dinobrain_local_cli" as const,
    local_identity_fingerprint: sha256Text(key.toString("base64url")),
  };
  const unsigned: Omit<ClientMcpChallenge, "challenge_hmac"> = {
    ...base,
    issuance_sha256: sha256Json(issuancePayload(base)),
    status: "issued",
  };
  const challenge = signChallenge(unsigned, key);
  const filePath = challengePath(dataRoot, challengeId);
  await atomicWriteJson(filePath, challenge);
  const prompt = [
    `DinoBrain direct MCP proof challenge for ${agent}: ${challengeId}`,
    "Use the real client MCP tool surface only.",
    "1. Call begin_client_mcp_proof with this challenge_id.",
    "2. Call os_begin_task for this proof with launch_kind direct_mcp. Retain its returned task_id, lease_id, and Context Pack path.",
    "   If os_begin_task does not return a task_id, stop and report failure. Never substitute the challenge_id as a task_id.",
    "3. Call get_context_pack with that same active task_id.",
    "4. Call wiki_search and search_memory with a narrow query about DinoBrain direct MCP parity.",
    "5. Call finish_task with the same task_id and lease_id, outcome completed, growth_policy trace_only, and the Context Pack paths used.",
    "6. Call finalize_client_mcp_proof with this challenge_id.",
    "Do not create or edit proof JSON manually.",
  ].join("\n");
  return { challenge, path: relDataPath(dataRoot, filePath), prompt };
}

function normalizeClientInfo(value: McpClientInfo | undefined): McpClientInfo | null {
  const name = value?.name?.trim() ?? "";
  const version = value?.version?.trim() ?? "";
  if (!name || !version) return null;
  return { name: name.slice(0, 160), version: version.slice(0, 160) };
}

function clientInfoMatchesAgent(clientInfo: McpClientInfo, agent: ClientMcpAgent): boolean {
  return clientInfo.name.toLowerCase().includes(agent);
}

function observedAgent(chain: ClientProcessEntry[]): ClientMcpAgent | null {
  const directParent = chain.find((entry) => entry.depth === 1) ?? chain[1];
  const name = directParent?.executable_name.toLowerCase() ?? "";
  const codex = name === "codex.exe" || name === "codex";
  const claude = name === "claude.exe" || name === "claude";
  if (codex === claude) return null;
  return codex ? "codex" : "claude";
}

function directParentBindingValid(identity: ClientProcessIdentity): boolean {
  const server = identity.chain.find((entry) => entry.depth === 0) ?? identity.chain[0];
  const parent = identity.chain.find((entry) => entry.depth === 1) ?? identity.chain[1];
  return Boolean(
    server &&
      parent &&
      server.pid === identity.server_pid &&
      server.parent_pid === parent.pid &&
      parent.pid === identity.server_parent_pid &&
      observedAgent(identity.chain) === identity.observed_agent,
  );
}

async function observeWindowsProcessIdentity(): Promise<ClientProcessIdentity> {
  const script = `
$ErrorActionPreference = 'Stop'
$targetPid = [int]$env:DINOBRAIN_PROOF_SERVER_PID
$all = Get-CimInstance Win32_Process
$current = $all | Where-Object { $_.ProcessId -eq $targetPid } | Select-Object -First 1
$chain = @()
for ($depth = 0; $depth -lt 8 -and $null -ne $current; $depth++) {
  $version = $null
  if (-not [string]::IsNullOrWhiteSpace([string]$current.ExecutablePath)) {
    try { $version = (Get-Item -LiteralPath $current.ExecutablePath).VersionInfo.ProductVersion } catch { $version = $null }
  }
  $chain += [ordered]@{
    depth = $depth
    pid = [int]$current.ProcessId
    parent_pid = [int]$current.ParentProcessId
    executable_name = [string]$current.Name
    executable_version = if ([string]::IsNullOrWhiteSpace([string]$version)) { $null } else { [string]$version }
    executable_path = if ([string]::IsNullOrWhiteSpace([string]$current.ExecutablePath)) { $null } else { [string]$current.ExecutablePath }
  }
  $parentId = [int]$current.ParentProcessId
  $current = $all | Where-Object { $_.ProcessId -eq $parentId } | Select-Object -First 1
}
[ordered]@{ platform = 'win32'; chain = $chain } | ConvertTo-Json -Depth 6 -Compress
`;
  const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    env: { ...process.env, DINOBRAIN_PROOF_SERVER_PID: String(process.pid) },
    timeout: 15_000,
    windowsHide: true,
    maxBuffer: 1024 * 1024,
  });
  const parsed = JSON.parse(stdout) as {
    platform?: string;
    chain?: Array<{
      depth?: number;
      pid?: number;
      parent_pid?: number;
      executable_name?: string;
      executable_version?: string | null;
      executable_path?: string | null;
    }>;
  };
  const chain = (Array.isArray(parsed.chain) ? parsed.chain : []).map((entry, index): ClientProcessEntry => ({
    depth: Number.isInteger(entry.depth) ? Number(entry.depth) : index,
    pid: Number(entry.pid ?? 0),
    parent_pid: Number.isFinite(entry.parent_pid) ? Number(entry.parent_pid) : null,
    executable_name: String(entry.executable_name ?? "").trim().slice(0, 160),
    executable_version: entry.executable_version ? String(entry.executable_version).trim().slice(0, 160) : null,
    executable_path_sha256: entry.executable_path
      ? sha256Text(String(entry.executable_path).trim().toLowerCase())
      : null,
  }));
  return {
    platform: "win32",
    collected_at: new Date().toISOString(),
    server_pid: process.pid,
    server_parent_pid: process.ppid,
    observed_agent: observedAgent(chain),
    chain,
  };
}

export async function observeClientProcessIdentity(): Promise<ClientProcessIdentity> {
  if (process.platform === "win32") return observeWindowsProcessIdentity();
  return {
    platform: process.platform,
    collected_at: new Date().toISOString(),
    server_pid: process.pid,
    server_parent_pid: process.ppid,
    observed_agent: null,
    chain: [],
  };
}

function clientIdentityPayload(clientInfo: McpClientInfo, processIdentity: ClientProcessIdentity): JsonObject {
  return {
    client_info: clientInfo,
    platform: processIdentity.platform,
    observed_agent: processIdentity.observed_agent,
    chain: processIdentity.chain,
  };
}

function emptyLedger(
  challenge: ClientMcpChallenge,
  serverInstanceId: string,
  clientIdentitySha256: string,
): Omit<ClientMcpReceiptLedger, "ledger_hmac"> {
  return {
    version: CLIENT_MCP_RECEIPT_LEDGER_VERSION,
    challenge_id: challenge.challenge_id,
    server_instance_id: serverInstanceId,
    local_identity_fingerprint: challenge.local_identity_fingerprint,
    client_identity_sha256: clientIdentitySha256,
    receipts: [],
    ledger_head_sha256: null,
  };
}

function signLedger(unsigned: Omit<ClientMcpReceiptLedger, "ledger_hmac">, key: Buffer): ClientMcpReceiptLedger {
  return { ...unsigned, ledger_hmac: hmacText(key, canonicalJson(unsigned)) };
}

function verifyLedger(ledger: ClientMcpReceiptLedger, key: Buffer): { ok: true } | { ok: false; reason: string } {
  const { ledger_hmac: actualLedgerHmac, ...unsignedLedger } = ledger;
  if (!equalHex(actualLedgerHmac, hmacText(key, canonicalJson(unsignedLedger)))) {
    return { ok: false, reason: "receipt_ledger_hmac_mismatch" };
  }
  let previous: string | null = null;
  for (let index = 0; index < ledger.receipts.length; index += 1) {
    const receipt = ledger.receipts[index];
    const { receipt_hmac: actualHmac, receipt_sha256: actualSha, ...unsignedReceipt } = receipt;
    const expectedSha = sha256Json(unsignedReceipt);
    if (!equalHex(actualSha, expectedSha)) return { ok: false, reason: `receipt_sha256_mismatch:${index + 1}` };
    if (!equalHex(actualHmac, hmacText(key, expectedSha))) return { ok: false, reason: `receipt_hmac_mismatch:${index + 1}` };
    if (receipt.sequence !== index + 1) return { ok: false, reason: `receipt_sequence_mismatch:${index + 1}` };
    if (receipt.previous_receipt_sha256 !== previous) return { ok: false, reason: `receipt_chain_mismatch:${index + 1}` };
    previous = receipt.receipt_sha256;
  }
  if (ledger.ledger_head_sha256 !== previous) return { ok: false, reason: "receipt_ledger_head_mismatch" };
  return { ok: true };
}

async function readJson<T>(filePath: string): Promise<T> {
  return JSON.parse(await fs.readFile(filePath, "utf8")) as T;
}

function toolResultPayload(result: CallToolResult): unknown {
  return result;
}

function resultJson(result: CallToolResult): JsonObject | null {
  const text = result.content.find((item) => item.type === "text" && typeof item.text === "string");
  if (!text || text.type !== "text") return null;
  try {
    const parsed = JSON.parse(text.text) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as JsonObject) : null;
  } catch {
    return null;
  }
}

function firstString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function proofSource(agent: ClientMcpAgent): ClientMcpDirectProofV2["proof_source"] {
  return agent === "codex" ? "codex_desktop_direct_mcp" : "claude_code_direct_mcp";
}

function clientSurface(agent: ClientMcpAgent): ClientMcpDirectProofV2["client_surface"] {
  return agent === "codex" ? "codex_desktop" : "claude_code";
}

export class ClientMcpProofRuntime {
  readonly serverInstanceId = randomUUID();
  private readonly dataRoot: string;
  private readonly options: RuntimeOptions;
  private active: ActiveProofSession | null = null;

  constructor(dataRoot: string, options: RuntimeOptions) {
    this.dataRoot = path.resolve(dataRoot);
    this.options = options;
  }

  hasActiveChallenge(): boolean {
    return this.active !== null;
  }

  async begin(challengeId: string): Promise<JsonObject> {
    return withFileLock(proofLockPath(this.dataRoot), async () => {
      if (this.active) throw new Error(`client MCP proof already active: ${this.active.challenge.challenge_id}`);
      const key = await loadProofKey(this.options, false);
      if (!key) throw new Error("client MCP proof identity key is missing on this machine");
      const filePath = challengePath(this.dataRoot, challengeId);
      const challenge = await readJson<ClientMcpChallenge>(filePath);
      if (!verifyChallenge(challenge, key)) throw new Error("client MCP challenge signature is invalid");
      if (challenge.status !== "issued") throw new Error(`client MCP challenge is not reusable: ${challenge.status}`);
      const now = this.options.now ?? new Date();
      if (Date.parse(challenge.expires_at) < now.getTime()) throw new Error("client MCP challenge has expired");

      const clientInfo = normalizeClientInfo(this.options.getClientInfo());
      if (!clientInfo) throw new Error("MCP initialize clientInfo name/version is unavailable");
      if (!clientInfoMatchesAgent(clientInfo, challenge.expected_agent)) {
        throw new Error(`MCP initialize clientInfo does not identify ${challenge.expected_agent}`);
      }
      const processIdentity = await (this.options.observeProcessIdentity ?? observeClientProcessIdentity)();
      if (processIdentity.observed_agent !== challenge.expected_agent) {
        throw new Error(
          `real client process mismatch: expected ${challenge.expected_agent}, observed ${processIdentity.observed_agent ?? "unknown"}`,
        );
      }
      if (!directParentBindingValid(processIdentity)) throw new Error("real client direct-parent binding is unavailable");

      const clientIdentitySha256 = sha256Json(clientIdentityPayload(clientInfo, processIdentity));
      const ledgerPath = receiptPath(this.dataRoot, challengeId);
      const ledger = signLedger(emptyLedger(challenge, this.serverInstanceId, clientIdentitySha256), key);
      await atomicWriteJson(ledgerPath, ledger);

      const { challenge_hmac: _oldHmac, ...unsignedChallenge } = challenge;
      const activated = signChallenge(
        {
          ...unsignedChallenge,
          status: "active",
          activated_at: isoNow(this.options),
          server_instance_id: this.serverInstanceId,
          client_identity_sha256: clientIdentitySha256,
          receipt_path: relDataPath(this.dataRoot, ledgerPath),
        },
        key,
      );
      await atomicWriteJson(filePath, activated);
      this.active = {
        challenge: activated,
        key,
        clientInfo,
        processIdentity,
        clientIdentitySha256,
        receiptPath: ledgerPath,
        taskId: null,
      };
      return {
        ok: true,
        challenge_id: challengeId,
        expected_agent: challenge.expected_agent,
        server_instance_id: this.serverInstanceId,
        client_info: clientInfo,
        process_identity: processIdentity,
        required_tools: [...CLIENT_MCP_REQUIRED_TOOLS],
        safe_action: "Invoke each required tool through this same real client MCP session, then finalize the proof.",
      };
    });
  }

  async captureToolCall<T extends CallToolResult>(
    tool: string,
    input: unknown,
    operation: () => Promise<T>,
  ): Promise<T> {
    if (!this.active || !CLIENT_MCP_REQUIRED_TOOLS.includes(tool as ClientMcpRequiredTool)) {
      return operation();
    }
    let result: T;
    try {
      result = await operation();
    } catch (error) {
      await this.appendReceipt(tool as ClientMcpRequiredTool, input, null, false, error);
      throw error;
    }
    const parsed = resultJson(result);
    const ok = result.isError !== true && parsed?.ok !== false;
    await this.appendReceipt(tool as ClientMcpRequiredTool, input, result, ok, null);
    return result;
  }

  private async appendReceipt(
    tool: ClientMcpRequiredTool,
    input: unknown,
    result: CallToolResult | null,
    ok: boolean,
    error: unknown,
  ): Promise<void> {
    const active = this.active;
    if (!active) throw new Error("client MCP proof session is not active");
    await withFileLock(proofLockPath(this.dataRoot), async () => {
      const ledger = await readJson<ClientMcpReceiptLedger>(active.receiptPath);
      const ledgerCheck = verifyLedger(ledger, active.key);
      if (!ledgerCheck.ok) throw new Error(ledgerCheck.reason);
      if (ledger.server_instance_id !== this.serverInstanceId) throw new Error("client MCP proof server instance changed");

      const parsed = result ? resultJson(result) : null;
      const resultTaskId = firstString(parsed?.task_id);
      if (tool === "os_begin_task" && ok && resultTaskId) active.taskId = resultTaskId;
      const inputTaskId = firstString((input as JsonObject | null)?.task_id);
      const taskId = tool === "os_begin_task" ? resultTaskId : inputTaskId || active.taskId || "";
      const taskBindingOk =
        tool === "os_begin_task"
          ? Boolean(ok && resultTaskId)
          : tool === "get_context_pack" || tool === "finish_task"
            ? Boolean(active.taskId && inputTaskId === active.taskId)
            : Boolean(active.taskId);
      const previous = ledger.ledger_head_sha256;
      const unsignedReceipt = {
        sequence: ledger.receipts.length + 1,
        challenge_id: active.challenge.challenge_id,
        server_instance_id: this.serverInstanceId,
        tool,
        at: isoNow(this.options),
        input_sha256: sha256Json(input),
        result_sha256: result ? sha256Json(toolResultPayload(result)) : sha256Text(String((error as Error)?.message ?? error)),
        ok,
        task_id: taskId || null,
        task_binding_ok: taskBindingOk,
        previous_receipt_sha256: previous,
      };
      const receiptSha256 = sha256Json(unsignedReceipt);
      const receipt: ClientMcpToolReceipt = {
        ...unsignedReceipt,
        receipt_sha256: receiptSha256,
        receipt_hmac: hmacText(active.key, receiptSha256),
      };
      const unsignedLedger: Omit<ClientMcpReceiptLedger, "ledger_hmac"> = {
        ...ledger,
        receipts: [...ledger.receipts, receipt],
        ledger_head_sha256: receiptSha256,
      };
      const { ledger_hmac: _ignored, ...normalizedLedger } = unsignedLedger as ClientMcpReceiptLedger;
      await atomicWriteJson(active.receiptPath, signLedger(normalizedLedger, active.key));
    });
  }

  async finalize(challengeId: string): Promise<JsonObject> {
    return withFileLock(proofLockPath(this.dataRoot), async () => {
      const active = this.active;
      if (!active || active.challenge.challenge_id !== challengeId) {
        throw new Error("client MCP proof challenge is not active in this server instance");
      }
      const challengeFile = challengePath(this.dataRoot, challengeId);
      const challenge = await readJson<ClientMcpChallenge>(challengeFile);
      if (!verifyChallenge(challenge, active.key) || challenge.status !== "active") {
        throw new Error("active client MCP challenge is invalid");
      }
      if (challenge.server_instance_id !== this.serverInstanceId) throw new Error("client MCP challenge server mismatch");
      const now = this.options.now ?? new Date();
      if (Date.parse(challenge.expires_at) < now.getTime()) throw new Error("client MCP challenge expired before finalize");

      const ledger = await readJson<ClientMcpReceiptLedger>(active.receiptPath);
      const ledgerCheck = verifyLedger(ledger, active.key);
      if (!ledgerCheck.ok) throw new Error(ledgerCheck.reason);
      if (ledger.client_identity_sha256 !== active.clientIdentitySha256) throw new Error("client identity changed during proof");
      const successful = ledger.receipts.filter((receipt) => receipt.ok && receipt.task_binding_ok);
      const verifiedTools = CLIENT_MCP_REQUIRED_TOOLS.filter((tool) => successful.some((receipt) => receipt.tool === tool));
      const missingTools = CLIENT_MCP_REQUIRED_TOOLS.filter((tool) => !verifiedTools.includes(tool));
      if (missingTools.length > 0) throw new Error(`required direct MCP calls missing: ${missingTools.join(",")}`);
      const firstIndex = (tool: ClientMcpRequiredTool) => successful.findIndex((receipt) => receipt.tool === tool);
      const finishIndex = successful.findIndex((receipt) => receipt.tool === "finish_task");
      if (
        firstIndex("os_begin_task") !== 0 ||
        firstIndex("get_context_pack") <= firstIndex("os_begin_task") ||
        finishIndex !== successful.length - 1
      ) {
        throw new Error("required direct MCP call order is invalid");
      }
      const taskIds = new Set(successful.map((receipt) => receipt.task_id).filter((value): value is string => Boolean(value)));
      if (taskIds.size !== 1 || !active.taskId || !taskIds.has(active.taskId)) {
        throw new Error("required direct MCP calls are not bound to one task");
      }
      if (!ledger.ledger_head_sha256) throw new Error("client MCP receipt chain is empty");

      const generatedAt = now.toISOString();
      const proofFile = dataPath(this.dataRoot, ...CLIENT_MCP_PROOF_DIR.split("/"), `${challenge.expected_agent}-${challengeId}.json`);
      const proofRelativePath = relDataPath(this.dataRoot, proofFile);
      const unsignedProof: Omit<ClientMcpDirectProofV2, "proof_sha256" | "proof_hmac"> = {
        version: CLIENT_MCP_PROOF_VERSION,
        agent: challenge.expected_agent,
        status: "verified" as const,
        proof_source: proofSource(challenge.expected_agent),
        client_surface: clientSurface(challenge.expected_agent),
        client_info: active.clientInfo,
        process_identity: active.processIdentity,
        client_identity_sha256: active.clientIdentitySha256,
        local_identity_fingerprint: challenge.local_identity_fingerprint,
        challenge_id: challengeId,
        challenge_issuance_sha256: challenge.issuance_sha256,
        challenge_nonce_sha256: sha256Text(challenge.nonce),
        server_instance_id: this.serverInstanceId,
        tool_discovery_mode: "server_observed_exact_single_name" as const,
        required_tools: [...CLIENT_MCP_REQUIRED_TOOLS],
        verified_tools: [...CLIENT_MCP_REQUIRED_TOOLS],
        missing_tools: [] as ClientMcpRequiredTool[],
        tool_calls: successful.map((receipt) => ({
          tool: receipt.tool,
          ok: true as const,
          at: receipt.at,
          result_sha256: receipt.result_sha256,
          receipt_sha256: receipt.receipt_sha256,
        })),
        task_id: active.taskId,
        receipt_path: relDataPath(this.dataRoot, active.receiptPath),
        receipt_chain_head: ledger.ledger_head_sha256,
        generated_at: generatedAt,
        stale_after_ms: 24 * 60 * 60 * 1000,
        proof_path: proofRelativePath,
      };
      const proofSha256 = sha256Json(unsignedProof);
      const proof: ClientMcpDirectProofV2 = {
        ...unsignedProof,
        proof_sha256: proofSha256,
        proof_hmac: hmacText(active.key, proofSha256),
      };
      await atomicWriteJson(proofFile, proof);

      const { challenge_hmac: _oldHmac, ...unsignedChallenge } = challenge;
      const finalized = signChallenge(
        {
          ...unsignedChallenge,
          status: "finalized",
          finalized_at: generatedAt,
          final_proof_path: proofRelativePath,
          final_proof_sha256: proofSha256,
        },
        active.key,
      );
      await atomicWriteJson(challengeFile, finalized);
      this.active = null;
      return {
        ok: true,
        agent: proof.agent,
        challenge_id: challengeId,
        proof_path: proofRelativePath,
        proof_sha256: proofSha256,
        generated_at: generatedAt,
        stale_after_ms: proof.stale_after_ms,
      };
    });
  }
}

function exactToolList(value: unknown): value is ClientMcpRequiredTool[] {
  return (
    Array.isArray(value) &&
    value.length === CLIENT_MCP_REQUIRED_TOOLS.length &&
    CLIENT_MCP_REQUIRED_TOOLS.every((tool, index) => value[index] === tool)
  );
}

export async function validateClientMcpProofFile(
  dataRoot: string,
  filePath: string,
  options: ProofStorageOptions & { staleAfterMs?: number } = {},
): Promise<ClientMcpProofValidation> {
  let proof: ClientMcpDirectProofV2;
  try {
    proof = await readJson<ClientMcpDirectProofV2>(filePath);
  } catch {
    return { ok: false, reason: "invalid_json" };
  }
  if (proof.version !== CLIENT_MCP_PROOF_VERSION) return { ok: false, reason: "legacy_or_unknown_proof_version" };
  const key = await loadProofKey(options, false);
  if (!key) return { ok: false, reason: "local_proof_identity_key_missing" };
  if (proof.local_identity_fingerprint !== sha256Text(key.toString("base64url"))) {
    return { ok: false, reason: "proof_from_foreign_or_replaced_local_identity" };
  }
  const { proof_hmac: actualHmac, proof_sha256: actualSha, ...unsignedProof } = proof;
  const expectedSha = sha256Json(unsignedProof);
  if (!equalHex(actualSha, expectedSha)) return { ok: false, reason: "proof_sha256_mismatch" };
  if (!equalHex(actualHmac, hmacText(key, expectedSha))) return { ok: false, reason: "proof_hmac_mismatch" };
  if (proof.proof_path !== relDataPath(dataRoot, filePath)) return { ok: false, reason: "proof_path_binding_mismatch" };
  if (!exactToolList(proof.required_tools) || !exactToolList(proof.verified_tools) || proof.missing_tools.length > 0) {
    return { ok: false, reason: "required_tool_set_mismatch" };
  }
  if (proof.tool_discovery_mode !== "server_observed_exact_single_name") {
    return { ok: false, reason: "tool_discovery_not_server_observed" };
  }
  if (proof.proof_source !== proofSource(proof.agent) || proof.client_surface !== clientSurface(proof.agent)) {
    return { ok: false, reason: "proof_source_or_surface_mismatch" };
  }
  if (proof.process_identity.observed_agent !== proof.agent || !directParentBindingValid(proof.process_identity)) {
    return { ok: false, reason: "real_client_process_identity_mismatch" };
  }
  if (!normalizeClientInfo(proof.client_info)) return { ok: false, reason: "client_info_missing" };
  if (!clientInfoMatchesAgent(proof.client_info, proof.agent)) return { ok: false, reason: "client_info_agent_mismatch" };
  if (sha256Json(clientIdentityPayload(proof.client_info, proof.process_identity)) !== proof.client_identity_sha256) {
    return { ok: false, reason: "client_identity_hash_mismatch" };
  }
  const now = options.now ?? new Date();
  const generated = Date.parse(proof.generated_at);
  const staleAfterMs = Math.min(options.staleAfterMs ?? 24 * 60 * 60 * 1000, proof.stale_after_ms);
  if (!Number.isFinite(generated) || generated > now.getTime() + 5 * 60_000 || generated + staleAfterMs < now.getTime()) {
    return { ok: false, reason: "proof_stale_or_unparseable_time" };
  }

  let challenge: ClientMcpChallenge;
  try {
    challenge = await readJson<ClientMcpChallenge>(challengePath(dataRoot, proof.challenge_id));
  } catch {
    return { ok: false, reason: "challenge_missing_or_invalid" };
  }
  if (!verifyChallenge(challenge, key)) return { ok: false, reason: "challenge_hmac_mismatch" };
  if (
    challenge.status !== "finalized" ||
    challenge.expected_agent !== proof.agent ||
    challenge.issuance_sha256 !== proof.challenge_issuance_sha256 ||
    sha256Text(challenge.nonce) !== proof.challenge_nonce_sha256 ||
    challenge.server_instance_id !== proof.server_instance_id ||
    challenge.client_identity_sha256 !== proof.client_identity_sha256 ||
    challenge.final_proof_path !== proof.proof_path ||
    challenge.final_proof_sha256 !== proof.proof_sha256
  ) {
    return { ok: false, reason: "challenge_proof_binding_mismatch" };
  }

  let ledger: ClientMcpReceiptLedger;
  try {
    ledger = await readJson<ClientMcpReceiptLedger>(dataPath(dataRoot, ...proof.receipt_path.split("/")));
  } catch {
    return { ok: false, reason: "receipt_ledger_missing_or_invalid" };
  }
  const ledgerCheck = verifyLedger(ledger, key);
  if (!ledgerCheck.ok) return ledgerCheck;
  if (
    ledger.challenge_id !== proof.challenge_id ||
    ledger.server_instance_id !== proof.server_instance_id ||
    ledger.client_identity_sha256 !== proof.client_identity_sha256 ||
    ledger.ledger_head_sha256 !== proof.receipt_chain_head
  ) {
    return { ok: false, reason: "receipt_ledger_proof_binding_mismatch" };
  }
  const successful = ledger.receipts.filter((receipt) => receipt.ok && receipt.task_binding_ok);
  if (!CLIENT_MCP_REQUIRED_TOOLS.every((tool) => successful.some((receipt) => receipt.tool === tool))) {
    return { ok: false, reason: "receipt_required_tool_missing" };
  }
  const taskIds = new Set(successful.map((receipt) => receipt.task_id).filter((value): value is string => Boolean(value)));
  if (taskIds.size !== 1 || !taskIds.has(proof.task_id)) return { ok: false, reason: "receipt_task_binding_mismatch" };
  const proofReceiptHashes = proof.tool_calls.map((call) => call.receipt_sha256);
  const ledgerReceiptHashes = successful.map((receipt) => receipt.receipt_sha256);
  if (canonicalJson(proofReceiptHashes) !== canonicalJson(ledgerReceiptHashes)) {
    return { ok: false, reason: "proof_receipt_projection_mismatch" };
  }
  return { ok: true, proof };
}
