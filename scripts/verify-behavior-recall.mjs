import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const {
  appendBehaviorRecallEntry,
  buildAndWriteBehaviorRecallReport,
  buildBehaviorRecallReport,
  buildFinishBehaviorRecallEntry,
  recordFeedbackCorrectionRecall,
  BEHAVIOR_RECALL_LEDGER_RELATIVE_PATH,
  BEHAVIOR_RECALL_STATUS_RELATIVE_PATH,
} = await import(pathToFileURL(path.join(root, "dist", "behavior-recall.js")).href);
const { getStandardPackItems, collectCuratedRecords } = await import(
  pathToFileURL(path.join(root, "dist", "context.js")).href
);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function write(filePath, value) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function withFixture(fn) {
  const dataRoot = mkdtempSync(path.join(tmpdir(), "dinobrain-behavior-recall-"));
  try {
    return await fn(dataRoot);
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
}

async function finishEntry(dataRoot, taskId, outcome, summary, extras = {}) {
  write(path.join(dataRoot, ".dino", "traces", `${taskId}.json`), {
    task_id: taskId,
    outcome,
    summary,
    used_memory_paths: extras.usedMemoryPaths ?? ["50_Instances/accepted/codex-session-knowledge-local_evidence_over_claims.json"],
    context_pack_paths: extras.contextPackPaths ?? [".dino/context-packs/example.json"],
    finished_at: extras.finishedAt ?? "2026-07-07T00:00:00.000Z",
  });
  const entry = buildFinishBehaviorRecallEntry({
    taskId,
    outcome,
    summary,
    decisions: extras.decisions ?? [],
    nextSteps: extras.nextSteps ?? [],
    usedMemoryPaths: extras.usedMemoryPaths ?? ["50_Instances/accepted/codex-session-knowledge-local_evidence_over_claims.json"],
    contextPackPaths: extras.contextPackPaths ?? [".dino/context-packs/example.json"],
    tracePath: `.dino/traces/${taskId}.json`,
    finishedAt: extras.finishedAt ?? "2026-07-07T00:00:00.000Z",
  });
  await appendBehaviorRecallEntry(dataRoot, entry);
  return entry;
}

await withFixture(async (dataRoot) => {
  await finishEntry(dataRoot, "task-completion", "completed", "Completed normal work.");
  await finishEntry(dataRoot, "task-handoff", "partial", "Prepared handoff for the next session.", {
    nextSteps: ["handoff: continue semantic retrieval work"],
    finishedAt: "2026-07-07T00:01:00.000Z",
  });
  await finishEntry(dataRoot, "task-error", "blocked", "Blocked by runtime error.", {
    finishedAt: "2026-07-07T00:02:00.000Z",
  });
  await finishEntry(dataRoot, "task-direction", "partial", "Direction change after user correction.", {
    decisions: ["direction change: remove decorative graph shape"],
    finishedAt: "2026-07-07T00:03:00.000Z",
  });

  const oldPath = "50_Instances/accepted/old-casual-status-rule.json";
  const correctionPath = "50_Instances/accepted/feedback-terse-status-rule.json";
  write(path.join(dataRoot, oldPath), {
    type: "behavior_rule",
    status: "accepted",
    title: "Use casual tone for status updates",
    claim: "Use casual tone for status updates.",
    behavior_rule: "Use casual tone for status updates.",
    applies_to: "status_updates",
    source_status: "internal",
    tags: ["behavior", "user-preference"],
  });
  write(path.join(dataRoot, correctionPath), {
    feedback_id: "feedback-terse-status-rule",
    type: "feedback_correction",
    status: "accepted",
    claim: "Do not use casual tone for status updates; use terse Korean progress notes instead.",
    behavior_rule: "Do not use casual tone for status updates; use terse Korean progress notes instead.",
    applies_to: "status_updates",
    source_status: "internal",
    tags: ["feedback", "correction", "behavior"],
  });
  const correction = await recordFeedbackCorrectionRecall(dataRoot, {
    feedbackId: "feedback-terse-status-rule",
    correction: "Do not use casual tone for status updates; use terse Korean progress notes instead.",
    appliesTo: "status_updates",
    taskId: "task-direction",
    acceptedPath: correctionPath,
    createdAt: "2026-07-07T00:04:00.000Z",
  });
  assert(correction.conflicting_memory_paths.includes(oldPath), "conflicting behavior memory was not detected");
  assert(correction.quarantine_paths.length === 1, "conflicting behavior memory was not quarantined");
  assert(correction.review_path, "behavior conflict review was not written");

  const records = await collectCuratedRecords(dataRoot);
  assert(!records.some((record) => record.path === oldPath), "quarantined old behavior memory remained retrievable");
  const { ranked } = await getStandardPackItems(dataRoot, "terse Korean status updates", 8);
  assert(ranked.some((record) => record.path === correctionPath), "later Context Pack did not retrieve correction");

  const report = await buildBehaviorRecallReport(dataRoot, { now: new Date("2026-07-07T00:05:00.000Z") });
  assert(report.status === "healthy", `expected healthy report, got ${report.status}`);
  for (const trigger of ["completion", "handoff", "error", "direction_change", "correction"]) {
    assert(report.counts[trigger] >= 1, `missing trigger count ${trigger}`);
  }
  assert(report.counts.performed >= 5, "performed recall count too low");
  assert(report.counts.correction_conflicts === 1, "correction conflict count mismatch");

  const written = await buildAndWriteBehaviorRecallReport(dataRoot, {
    now: new Date("2026-07-07T00:05:00.000Z"),
  });
  assert(written.path.replace(/\\/g, "/").endsWith(BEHAVIOR_RECALL_STATUS_RELATIVE_PATH), "status path mismatch");
});

await withFixture(async (dataRoot) => {
  write(
    path.join(dataRoot, BEHAVIOR_RECALL_LEDGER_RELATIVE_PATH),
    `${JSON.stringify({
      version: "behavior_recall_v1",
      recall_id: "bad",
      trigger_type: "completion",
      task_id: "task-bad",
      recalled_memory_paths: [],
      decision_status: "unknown",
      reason: "",
      evidence_path: "",
      conflicting_memory_paths: [],
      followup_action: "",
      created_at: "2026-07-07T00:00:00.000Z",
    })}\n`,
  );
  const report = await buildBehaviorRecallReport(dataRoot, { now: new Date("2026-07-07T00:05:00.000Z") });
  assert(report.status === "needs_attention", "malformed ledger should fail");
  assert(report.findings.some((finding) => finding.signal === "ledger_entry_malformed"), "malformed finding missing");
});

await withFixture(async (dataRoot) => {
  const report = await buildBehaviorRecallReport(dataRoot, { now: new Date("2026-07-07T00:05:00.000Z") });
  assert(report.status === "needs_attention", "missing ledger should fail");
  assert(report.findings.some((finding) => finding.signal === "ledger_missing"), "missing ledger finding missing");
});

console.log("behavior recall verification ok");
