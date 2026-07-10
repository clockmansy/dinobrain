import path from "node:path";
import { pathToFileURL } from "node:url";

import { COMPLETION_COMMANDS } from "./completion-registry.js";
import { runCompletionAudit } from "./completion-evidence.js";

function argValue(name: string): string | null {
  const index = process.argv.indexOf(name);
  if (index < 0) return null;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

function argValues(name: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < process.argv.length; index += 1) {
    if (process.argv[index] !== name) continue;
    const value = process.argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
    values.push(value);
  }
  return values;
}

function externalEvidence(): Record<string, string> {
  const entries: Record<string, string> = {};
  for (const value of argValues("--external")) {
    const separator = value.indexOf("=");
    if (separator <= 0 || separator === value.length - 1) {
      throw new Error("--external must use evidence_id=path");
    }
    entries[value.slice(0, separator)] = path.resolve(value.slice(separator + 1));
  }
  return entries;
}

async function main(): Promise<void> {
  const appRoot = path.resolve(argValue("--app-root") ?? process.cwd());
  const dataRoot = path.resolve(
    argValue("--data-root") ?? process.env.DINOBRAIN_DATA_DIR ?? path.join(appRoot, "..", "dinobrain-data"),
  );
  const only = argValue("--only");
  const planOnly = process.argv.includes("--plan-only");
  if (only && planOnly) throw new Error("Use either --only or --plan-only, not both");
  const selectedCommandIds = planOnly
    ? []
    : only
      ? only.split(",").map((entry) => entry.trim()).filter(Boolean)
      : undefined;
  const result = await runCompletionAudit({
    appRoot,
    dataRoot,
    auditor: argValue("--auditor") ?? "codex",
    auditRunId: argValue("--audit-run-id") ?? undefined,
    selectedCommandIds,
    externalEvidencePaths: externalEvidence(),
  });
  console.log(
    JSON.stringify(
      {
        ok: result.verdict.status === "COMPLETE",
        audit_run_id: result.audit_run_id,
        command_count: COMPLETION_COMMANDS.length,
        audit_dir: result.audit_dir,
        command_results_path: result.command_results_path,
        artifact_manifest_path: result.artifact_manifest_path,
        completion_verdict_path: result.completion_verdict_path,
        status: result.verdict.status,
        gate_results: result.verdict.gate_results.map((gate) => ({
          gate_id: gate.gate_id,
          status: gate.status,
          reason_count: gate.reasons.length,
        })),
        automatic_disqualifiers: result.verdict.automatic_disqualifiers,
        failing_predicate_count: result.verdict.failing_predicates.length,
      },
      null,
      2,
    ),
  );
  if (result.verdict.status !== "COMPLETE" && !process.argv.includes("--allow-not-complete")) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
}
