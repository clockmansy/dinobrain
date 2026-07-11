import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  beginTaskLifecycleSoak,
  finalizeTaskLifecycleSoak,
  showTaskLifecycleSoak,
  validateTaskLifecycleSoakEvidenceFile,
} from "./task-lifecycle-soak.js";

function argValue(name: string): string | null {
  const index = process.argv.indexOf(name);
  if (index < 0) return null;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

function roots(): { appRoot: string; dataRoot: string; localStateRoot?: string } {
  const appRoot = path.resolve(argValue("--app-root") ?? process.cwd());
  const dataRoot = path.resolve(argValue("--data-root") ?? process.env.DINOBRAIN_DATA_DIR ?? path.join(appRoot, "..", "dinobrain-data"));
  const localStateRoot = argValue("--local-state-root");
  return { appRoot, dataRoot, localStateRoot: localStateRoot ? path.resolve(localStateRoot) : undefined };
}

async function main(): Promise<void> {
  const command = process.argv[2];
  const { appRoot, dataRoot, localStateRoot } = roots();
  if (command === "begin") {
    const result = await beginTaskLifecycleSoak({ appRoot, dataRoot, localStateRoot });
    console.log(JSON.stringify({
      ok: true,
      status: result.descriptor.status,
      run_id: result.descriptor.run_id,
      started_at: result.descriptor.started_at,
      required_duration_ms: result.descriptor.required_duration_ms,
      app_commit: result.descriptor.app_commit,
      data_commit: result.descriptor.data_commit,
    }, null, 2));
    return;
  }
  if (command === "finalize") {
    const result = await finalizeTaskLifecycleSoak({
      appRoot,
      dataRoot,
      localStateRoot,
      runId: argValue("--run-id") ?? undefined,
      clientProofLocalStateRoot: argValue("--client-proof-local-state-root") ?? undefined,
    });
    console.log(JSON.stringify({
      ok: result.validation.ok,
      status: result.evidence.status,
      run_id: result.evidence.run_id,
      duration_ms: result.evidence.duration_ms,
      public_evidence_path: path.relative(dataRoot, result.outputPath).split(path.sep).join("/"),
      client_agents: result.evidence.client_proofs.map((proof) => proof.agent),
      window_counts: result.evidence.window.counts,
    }, null, 2));
    return;
  }
  if (command === "validate") {
    const evidencePath = argValue("--evidence");
    if (!evidencePath) throw new Error("validate requires --evidence <path>");
    const validation = await validateTaskLifecycleSoakEvidenceFile(path.resolve(evidencePath), { dataRoot });
    console.log(JSON.stringify(validation, null, 2));
    if (!validation.ok) process.exitCode = 1;
    return;
  }
  if (command === "show") {
    const descriptor = await showTaskLifecycleSoak({ runId: argValue("--run-id") ?? undefined, localStateRoot });
    console.log(JSON.stringify({
      ok: true,
      status: descriptor.status,
      run_id: descriptor.run_id,
      started_at: descriptor.started_at,
      required_duration_ms: descriptor.required_duration_ms,
      app_commit: descriptor.app_commit,
      data_commit: descriptor.data_commit,
      baseline: descriptor.baseline,
    }, null, 2));
    return;
  }
  throw new Error("Usage: run-task-lifecycle-soak <begin|finalize|validate|show> [options]");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
