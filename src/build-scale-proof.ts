import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  runScaleProof,
  SCALE_REPORT_RELATIVE_PATH,
  verifyScaleProofBindings,
  verifyScaleProofReport,
} from "./scale-proof.js";

function argValue(name: string): string | null {
  const index = process.argv.indexOf(name);
  if (index < 0) return null;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

function numericArg(name: string, fallback: number): number {
  const raw = argValue(name);
  if (raw === null) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${name} must be a positive number`);
  return Math.floor(parsed);
}

async function main(): Promise<void> {
  const appRoot = path.resolve(process.cwd());
  const dataRoot = path.resolve(process.env.DINOBRAIN_DATA_DIR ?? path.join(appRoot, "..", "dinobrain-data"));
  const recordCount = numericArg("--records", Number(process.env.DINOBRAIN_SCALE_RECORDS ?? 50_000));
  const sessionCount = numericArg("--sessions", Number(process.env.DINOBRAIN_SCALE_SESSIONS ?? 1_000));
  const sampleCount = numericArg("--samples", Number(process.env.DINOBRAIN_SCALE_SAMPLES ?? 25));
  const fixture = process.argv.includes("--fixture");
  const fixtureRoot = path.resolve(
    argValue("--fixture-root") ?? path.join(os.tmpdir(), `dinobrain-scale-${process.pid}-${Date.now()}`),
  );
  const outputPath = path.resolve(
    argValue("--output") ?? path.join(dataRoot, ...SCALE_REPORT_RELATIVE_PATH.split("/")),
  );
  const qualifying = !fixture && recordCount === 50_000 && sessionCount >= 1_000;
  const report = await runScaleProof({
    outputPath,
    fixtureRoot,
    recordCount,
    sessionCount,
    sampleCount,
    qualifying,
    fixtureSemantic: fixture,
    keepFixture: process.argv.includes("--keep-fixture"),
  });
  const verification = verifyScaleProofReport(report, qualifying);
  const bindingVerification = await verifyScaleProofBindings(report);
  console.log(JSON.stringify({
    ok: verification.ok && bindingVerification.ok,
    status: report.status,
    qualifying: report.qualifying,
    output_path: outputPath,
    record_count: report.corpus.record_count,
    session_count: report.corpus.session_count,
    cold_build_ms: report.measurements.cold_build.wall_ms,
    context_pack_p95_ms: report.measurements.context_pack.p95_ms,
    wiki_search_p95_ms: report.measurements.wiki_search.p95_ms,
    recent_task_p95_ms: report.measurements.recent_task_lookup.p95_ms,
    incremental_write_p95_ms: report.measurements.incremental_operation_write.p95_ms,
    graph_refresh_p95_ms: report.measurements.graph_refresh.p95_ms,
    observatory_poll_p95_ms: report.measurements.observatory_poll.p95_ms,
    process_rss_peak_mb: Number((report.measurements.process_rss_peak_observed_bytes / 1024 / 1024).toFixed(1)),
    dense_vectors_scanned: report.bounded_work.max_dense_vectors_scanned,
    assertion_failures: report.assertions.filter((entry) => !entry.ok).map((entry) => entry.id),
    verification_issues: [...verification.issues, ...bindingVerification.issues],
  }, null, 2));
  if (!verification.ok || !bindingVerification.ok || (qualifying && report.status !== "healthy")) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
}
