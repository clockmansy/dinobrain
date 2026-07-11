import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataRoot = path.resolve(process.env.DINOBRAIN_DATA_DIR ?? path.join(root, "..", "dinobrain-data"));
const reportPath = path.join(dataRoot, ".dino", "evaluations", "scale-50k-status.json");
const scaleModule = await import(pathToFileURL(path.join(root, "dist", "scale-proof.js")).href);

const report = JSON.parse(await readFile(reportPath, "utf8"));
const reportCheck = scaleModule.verifyScaleProofReport(report, true);
const bindingCheck = await scaleModule.verifyScaleProofBindings(report);
const failures = Array.isArray(report.assertions)
  ? report.assertions.filter((entry) => entry?.ok !== true).map((entry) => entry?.id)
  : ["assertions_missing"];
const ok = reportCheck.ok && bindingCheck.ok && failures.length === 0;
console.log(JSON.stringify({
  ok,
  status: report.status,
  qualifying: report.qualifying,
  report_path: ".dino/evaluations/scale-50k-status.json",
  record_count: report.corpus?.record_count ?? null,
  session_count: report.corpus?.session_count ?? null,
  cold_build_ms: report.measurements?.cold_build?.wall_ms ?? null,
  context_pack_p95_ms: report.measurements?.context_pack?.p95_ms ?? null,
  wiki_search_p95_ms: report.measurements?.wiki_search?.p95_ms ?? null,
  graph_refresh_p95_ms: report.measurements?.graph_refresh?.p95_ms ?? null,
  process_rss_peak_bytes: report.measurements?.process_rss_peak_observed_bytes ?? null,
  assertion_failures: failures,
  verification_issues: [...reportCheck.issues, ...bindingCheck.issues],
}, null, 2));
if (!ok) process.exitCode = 1;
