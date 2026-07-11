import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  beginCleanMachineEquivalenceRun,
  finalizeCleanMachineEquivalenceRun,
  loadCleanMachineRunDescriptor,
  runCleanMachineVerificationCommands,
  validateCleanMachineEquivalenceEvidenceFile,
  type CleanMachineCommandReceipt,
  type CleanMachineMode,
} from "./clean-machine-equivalence.js";

function argsMap(values: string[]): Map<string, string[]> {
  const output = new Map<string, string[]>();
  for (let index = 0; index < values.length; index += 1) {
    const key = values[index];
    if (!key?.startsWith("--")) continue;
    const next = values[index + 1];
    const value = next && !next.startsWith("--") ? (index += 1, next) : "true";
    output.set(key.slice(2), [...(output.get(key.slice(2)) ?? []), value]);
  }
  return output;
}

function value(map: Map<string, string[]>, key: string, fallback = ""): string {
  return map.get(key)?.at(-1)?.trim() || fallback;
}

function required(map: Map<string, string[]>, key: string): string {
  const result = value(map, key);
  if (!result) throw new Error(`Missing required --${key}`);
  return result;
}

function flag(map: Map<string, string[]>, key: string): boolean {
  return /^(?:1|true|yes|on)$/i.test(value(map, key, "false"));
}

function localRoot(map: Map<string, string[]>): string | undefined {
  const configured = value(map, "local-state-root");
  return configured ? path.resolve(configured) : undefined;
}

function defaultReceiptPath(): string | null {
  const base = process.env.LOCALAPPDATA
    ? path.join(process.env.LOCALAPPDATA, "DinoBrain", "proofs", "private-restore", "latest.json")
    : path.join(os.homedir(), ".local", "state", "dinobrain", "proofs", "private-restore", "latest.json");
  return existsSync(base) ? path.resolve(base) : null;
}

async function loadReceipts(filePath: string): Promise<CleanMachineCommandReceipt[]> {
  const parsed = JSON.parse(await import("node:fs/promises").then((module) => module.readFile(filePath, "utf8"))) as {
    receipts?: CleanMachineCommandReceipt[];
  };
  if (!Array.isArray(parsed.receipts)) throw new Error(`Command receipt file is invalid: ${filePath}`);
  return parsed.receipts;
}

async function main(): Promise<void> {
  const command = process.argv[2] ?? "";
  const map = argsMap(process.argv.slice(3));
  if (command === "begin") {
    const appRoot = path.resolve(value(map, "app-root", process.cwd()));
    const dataRoot = path.resolve(value(map, "data-root", process.env.DINOBRAIN_DATA_DIR ?? path.join(appRoot, "..", "dinobrain-data")));
    const modeValue = value(map, "mode", "both_clients");
    if (modeValue !== "both_clients" && modeValue !== "codex_only") throw new Error(`Invalid --mode: ${modeValue}`);
    const mode = modeValue as CleanMachineMode;
    const defaultInstall = path.join(path.dirname(appRoot), "dinobrain-install-result.json");
    const installArg = value(map, "install-result");
    const restoreArg = value(map, "restore-receipt");
    const result = await beginCleanMachineEquivalenceRun({
      appRoot,
      dataRoot,
      mode,
      installResultPath: installArg ? path.resolve(installArg) : existsSync(defaultInstall) ? defaultInstall : null,
      restoreReceiptPath: restoreArg ? path.resolve(restoreArg) : defaultReceiptPath(),
      localStateRoot: localRoot(map),
      expectedAppRepository: value(map, "expected-app-repository", "clockmansy/dinobrain"),
      expectedDataRepository: value(map, "expected-data-repository", "clockmansy/dinobrain-data"),
    });
    console.log(JSON.stringify({
      ok: true,
      run_id: result.descriptor.run_id,
      mode: result.descriptor.mode,
      started_at: result.descriptor.started_at,
      descriptor_path: result.descriptorPath,
      installed_app_commit: result.descriptor.installed_app_commit,
      installed_data_commit: result.descriptor.installed_data_commit,
    }, null, 2));
    return;
  }
  if (command === "finalize") {
    const runId = required(map, "run-id");
    const loaded = await loadCleanMachineRunDescriptor(runId, localRoot(map));
    const receiptPath = value(map, "command-receipts");
    const receipts = receiptPath
      ? await loadReceipts(path.resolve(receiptPath))
      : flag(map, "skip-commands")
        ? []
        : await runCleanMachineVerificationCommands({
            appRoot: loaded.descriptor.app_root,
            dataRoot: loaded.descriptor.data_root,
            runDirectory: loaded.runDirectory,
          });
    const result = await finalizeCleanMachineEquivalenceRun({
      descriptor: loaded.descriptor,
      commandReceipts: receipts,
      localStateRoot: localRoot(map),
      outputPath: value(map, "output") || undefined,
    });
    const operationalOk = loaded.descriptor.mode === "both_clients"
      ? result.evidence.status === "complete" && result.validation.ok
      : result.evidence.status === "diagnostic_only" && result.validation.ok;
    console.log(JSON.stringify({
      ok: operationalOk,
      run_id: runId,
      mode: loaded.descriptor.mode,
      status: result.evidence.status,
      evidence_path: result.outputPath,
      evidence_payload_sha256: result.evidence.attestation.payload_sha256,
      validation: result.validation,
      blockers: result.evidence.blockers,
      resource_usage: result.evidence.resource_usage,
    }, null, 2));
    if (!operationalOk) process.exitCode = 1;
    return;
  }
  if (command === "validate") {
    const filePath = path.resolve(required(map, "evidence"));
    const validation = await validateCleanMachineEquivalenceEvidenceFile(filePath, {
      requireComplete: !flag(map, "allow-diagnostic"),
    });
    console.log(JSON.stringify({ ok: validation.ok, evidence_path: filePath, validation }, null, 2));
    if (!validation.ok) process.exitCode = 1;
    return;
  }
  if (command === "show") {
    const loaded = await loadCleanMachineRunDescriptor(required(map, "run-id"), localRoot(map));
    console.log(JSON.stringify({ ok: true, descriptor: loaded.descriptor, descriptor_path: loaded.descriptorPath }, null, 2));
    return;
  }
  throw new Error("Usage: run-clean-machine-equivalence <begin|finalize|validate|show> [options]");
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }, null, 2));
  process.exit(1);
});
