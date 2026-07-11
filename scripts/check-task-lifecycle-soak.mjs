import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataRoot = path.resolve(process.env.DINOBRAIN_DATA_DIR ?? path.join(root, "..", "dinobrain-data"));
const soak = await import(pathToFileURL(path.join(root, "dist", "task-lifecycle-soak.js")).href);
const evidenceDir = path.join(dataRoot, ...soak.TASK_LIFECYCLE_SOAK_EVIDENCE_DIR.split("/"));
const now = new Date();
const freshnessMs = 2 * soak.TASK_LIFECYCLE_SOAK_MINIMUM_MS;

let files = [];
try {
  files = readdirSync(evidenceDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => path.join(evidenceDir, entry.name));
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
}

const candidates = files
  .map((filePath) => {
    try {
      const parsed = JSON.parse(readFileSync(filePath, "utf8"));
      return { filePath, parsed, finishedAt: Date.parse(parsed.finished_at ?? "") };
    } catch {
      return { filePath, parsed: null, finishedAt: Number.NaN };
    }
  })
  .sort((left, right) => (Number.isFinite(right.finishedAt) ? right.finishedAt : 0) - (Number.isFinite(left.finishedAt) ? left.finishedAt : 0));

const invalid = [];
let selected = null;
for (const candidate of candidates) {
  const validation = await soak.validateTaskLifecycleSoakEvidence(candidate.parsed, { dataRoot, now });
  const fresh = Number.isFinite(candidate.finishedAt) && candidate.finishedAt >= now.getTime() - freshnessMs;
  if (validation.ok && fresh) {
    selected = { candidate, validation };
    break;
  }
  invalid.push({
    path: path.relative(dataRoot, candidate.filePath).split(path.sep).join("/"),
    errors: [...validation.errors, ...(validation.ok && !fresh ? ["evidence_stale_over_48_hours"] : [])],
  });
}

const report = selected
  ? {
      ok: true,
      status: "complete",
      generated_at: now.toISOString(),
      evidence_path: path.relative(dataRoot, selected.candidate.filePath).split(path.sep).join("/"),
      run_id: selected.candidate.parsed.run_id,
      started_at: selected.candidate.parsed.started_at,
      finished_at: selected.candidate.parsed.finished_at,
      duration_ms: selected.candidate.parsed.duration_ms,
      client_agents: selected.candidate.parsed.client_proofs.map((proof) => proof.agent),
      window_counts: selected.candidate.parsed.window.counts,
      payload_sha256: selected.validation.payload_sha256,
      invalid_candidates: invalid,
    }
  : {
      ok: false,
      status: "pending",
      generated_at: now.toISOString(),
      evidence_path: null,
      run_id: null,
      reason: candidates.length === 0 ? "no_completed_lifecycle_soak_evidence" : "no_fresh_valid_lifecycle_soak_evidence",
      required_duration_ms: soak.TASK_LIFECYCLE_SOAK_MINIMUM_MS,
      required_agents: ["codex", "claude"],
      invalid_candidates: invalid,
    };

console.log(JSON.stringify(report, null, 2));
if (!report.ok) process.exit(1);
