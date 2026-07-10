import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const serverPath = path.join(root, "dist", "index.js");
const { buildBehaviorRecallReport } = await import(pathToFileURL(path.join(root, "dist", "behavior-recall.js")).href);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function write(filePath, value) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function parseTool(result) {
  const text = result.content?.find((part) => part.type === "text")?.text;
  if (!text) throw new Error("MCP tool did not return JSON text");
  return JSON.parse(text);
}

function fileSha(filePath) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

const dataRoot = mkdtempSync(path.join(tmpdir(), "dinobrain-behavior-recall-e2e-"));
for (const dir of [
  "00_Home",
  "20_Wiki",
  "30_Sources",
  "40_Projects",
  "50_Instances/accepted",
  "50_Instances/candidates",
  "60_Operations",
  "70_Error_Book",
  "80_Review_Queue",
  ".dino",
]) mkdirSync(path.join(dataRoot, dir), { recursive: true });

const client = new Client({ name: "dinobrain-behavior-recall-e2e", version: "2.2.9" });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [serverPath],
  cwd: root,
  env: {
    ...process.env,
    DINOBRAIN_DATA_DIR: dataRoot,
    DINOBRAIN_AUTO_GROWTH: "0",
    DINOBRAIN_AUTO_COMPOUND: "0",
    DINOBRAIN_AUTO_SYNC: "0",
  },
  stderr: "pipe",
});

async function call(name, args) {
  return parseTool(await client.callTool({ name, arguments: args }));
}

async function begin(request) {
  const result = await call("os_begin_task", {
    request,
    project: "behavior-recall-e2e",
    mode: "standard",
    sensitivity: "normal",
    limit: 8,
  });
  assert(result.ok === true && result.fail_closed !== true, `preflight failed for ${request}: ${JSON.stringify(result)}`);
  assert(result.task_id && result.lease?.lease_id && result.context_pack?.trace_path, "preflight evidence is incomplete");
  return result;
}

async function finish(started, { summary, outcome = "completed", decisions = [], nextSteps = [], used = [], pack = true }) {
  const result = await call("finish_task", {
    task_id: started.task_id,
    lease_id: started.lease.lease_id,
    summary,
    outcome,
    growth_policy: "trace_only",
    changed_files: [],
    decisions,
    next_steps: nextSteps,
    used_memory_paths: used,
    context_pack_paths: pack ? [started.context_pack.trace_path] : [],
    session_archive_paths: [],
    candidate_paths: [],
    search_queries: [],
  });
  assert(result.ok === true, `finish_task failed: ${JSON.stringify(result)}`);
  return result;
}

try {
  await client.connect(transport);

  const oldCandidate = await call("create_candidate_instance", {
    claim: "Use casual tone for status updates.",
    evidence_snippet: "The prior operating rule preferred casual status updates.",
    evidence_source: "reviewed fixture evidence",
    confidence: "high",
    last_verified: "2026-07-11",
    source_status: "internal",
    provenance_paths: [],
    tags: ["behavior", "user-preference", "status-updates"],
    sensitivity: "normal",
  });
  assert(oldCandidate.candidate_id, "old behavior candidate was not created");
  const oldApproval = await call("review_candidate", {
    candidate_id: oldCandidate.candidate_id,
    decision: "approve",
    reviewer: "behavior-e2e-reviewer",
    notes: "Seed a reviewed prior behavior for correction conflict testing.",
  });
  assert(oldApproval.ok === true && oldApproval.accepted_path, `old behavior approval failed: ${JSON.stringify(oldApproval)}`);
  const oldAcceptedPath = oldApproval.accepted_path;

  const correctionTask = await begin("No, for status updates use terse Korean progress notes instead of casual tone.");
  const correction = await call("record_feedback_correction", {
    correction: "Do not use casual tone for status updates; use terse Korean progress notes instead.",
    applies_to: "status_updates",
    task_id: correctionTask.task_id,
    tags: ["status-updates", "terse-korean"],
    contradicted_memory_paths: [oldAcceptedPath],
    behavior_action: {
      memory_off_action: "use casual status updates",
      expected_memory_on_action: "use terse Korean progress notes",
    },
  });
  assert(correction.ok === true, `correction candidate creation failed: ${JSON.stringify(correction)}`);
  assert(correction.source_prompt_binding_status === "verified", "source prompt metadata was not verified");
  assert(correction.contradicted_memory_paths.includes(oldAcceptedPath), "contradicted memory was not pre-linked");

  const candidateFile = path.join(dataRoot, correction.candidate_path);
  const reviewFile = path.join(dataRoot, correction.review_path);
  const provenanceFile = path.join(dataRoot, correction.provenance_path);
  const oldAcceptedFile = path.join(dataRoot, oldAcceptedPath);
  const candidateRecord = JSON.parse(readFileSync(candidateFile, "utf8"));
  const provenanceRecord = JSON.parse(readFileSync(provenanceFile, "utf8"));
  assert(candidateRecord.source_prompt_metadata?.binding_status === "verified", "candidate prompt binding missing");
  assert(provenanceRecord.source_prompt_metadata?.prompt_hash === correctionTask.record.prompt_hash, "provenance prompt hash mismatch");

  const beforeBlocked = [candidateFile, reviewFile, oldAcceptedFile].map(fileSha);
  const blockedApproval = await call("review_candidate", {
    candidate_id: correction.feedback_id,
    decision: "approve",
    reviewer: "behavior-e2e-reviewer",
    notes: "This must not mutate without an explicit conflict resolution.",
  });
  assert(blockedApproval.ok === false, "correction approval without conflict resolution unexpectedly passed");
  assert(blockedApproval.mutation_performed === false, "blocked correction approval mutated state");
  assert(blockedApproval.blockers.includes("correction_conflict_resolution_required"), "missing conflict-resolution blocker");
  assert(
    beforeBlocked.every((hash, index) => hash === [candidateFile, reviewFile, oldAcceptedFile].map(fileSha)[index]),
    "blocked correction approval changed candidate, review, or old memory",
  );

  const approved = await call("review_candidate", {
    candidate_id: correction.feedback_id,
    decision: "approve",
    reviewer: "behavior-e2e-reviewer",
    notes: "Demote the contradicted rule and promote the direct user correction.",
    correction_resolution: "demote_superseded",
  });
  assert(approved.ok === true && approved.accepted_path, `correction approval failed: ${JSON.stringify(approved)}`);
  assert(approved.correction_resolution === "demote_superseded", "correction resolution was not persisted");
  const correctedAcceptedPath = approved.accepted_path;
  const correctedRecord = JSON.parse(readFileSync(path.join(dataRoot, correctedAcceptedPath), "utf8"));
  const demotedRecord = JSON.parse(readFileSync(oldAcceptedFile, "utf8"));
  const resolvedReview = JSON.parse(readFileSync(reviewFile, "utf8"));
  assert(correctedRecord.lifecycle_state === "accepted", "correction is not accepted");
  assert(correctedRecord.source_prompt_metadata?.binding_status === "verified", "accepted correction lost prompt binding");
  assert(demotedRecord.lifecycle_state === "demoted" && demotedRecord.status === "demoted", "old behavior was not demoted");
  assert(demotedRecord.successor_paths?.includes(correctedAcceptedPath), "old behavior does not link to correction successor");
  assert(resolvedReview.correction_resolution === "demote_superseded", "review conflict resolution missing");

  const laterTask = await begin("What style should be used for status updates?");
  const laterItems = laterTask.context_pack.items ?? [];
  assert(laterItems.some((item) => item.path === correctedAcceptedPath), "later Context Pack did not retrieve correction");
  assert(!laterItems.some((item) => item.path === oldAcceptedPath), "later Context Pack still retrieved demoted behavior");

  const goldenPath = ".dino/evaluations/behavior-golden.json";
  write(path.join(dataRoot, goldenPath), {
    version: 2,
    description: "Real reviewed correction must change the selected action.",
    target_memory_lift: 20,
    minimum_cases: 1,
    cases: [{
      id: "reviewed-correction-changes-status-action",
      request: "What style should be used for status updates?",
      expected_memory_paths: [correctedAcceptedPath],
      required_context_terms: ["terse Korean progress notes"],
      min_path_recall: 1,
      memory_off_action: "use casual status updates",
      expected_memory_on_action: "use terse Korean progress notes",
    }],
  });
  const evaluation = await call("evaluate_behavior", { golden_path: goldenPath, pack_limit: 8 });
  assert(evaluation.ok === true, `behavior lift evaluation failed: ${JSON.stringify(evaluation)}`);
  const evaluatedCase = evaluation.results[0];
  assert(evaluatedCase.action_changed === true, "memory-on behavior did not change the action");
  assert(evaluatedCase.action_correct === true, "memory-on behavior selected the wrong action");
  assert(evaluatedCase.action_source_path === correctedAcceptedPath, "changed action was not grounded in the correction");

  await finish(correctionTask, {
    summary: "Direction change completed after reviewed direct user correction.",
    outcome: "partial",
    decisions: ["Direction change: use the corrected status behavior."],
    used: [correctedAcceptedPath],
  });
  await finish(laterTask, {
    summary: "Completed a status update using the recalled operating rule.",
    used: [correctedAcceptedPath],
  });
  const handoffTask = await begin("Prepare a handoff for behavior recall verification.");
  await finish(handoffTask, {
    summary: "Prepared handoff for the next verifier.",
    outcome: "partial",
    nextSteps: ["Handoff: inspect the behavior evaluation artifact."],
    used: [],
    pack: true,
  });
  const errorTask = await begin("Verify blocked error recall handling.");
  await finish(errorTask, {
    summary: "Blocked by a deliberate runtime error fixture.",
    outcome: "blocked",
    used: [],
    pack: false,
  });

  const report = await buildBehaviorRecallReport(dataRoot, { now: new Date() });
  assert(report.status === "healthy", `behavior recall status is not healthy: ${JSON.stringify(report.findings)}`);
  for (const trigger of ["completion", "handoff", "error", "direction_change", "correction"]) {
    assert(report.counts[trigger] >= 1, `missing actual MCP trigger coverage: ${trigger}`);
  }
  assert(report.counts.performed >= 3, "performed decision coverage missing");
  assert(report.counts.skipped >= 1, "skipped decision coverage missing");
  assert(report.counts.not_applicable >= 1, "not_applicable decision coverage missing");
  assert(report.counts.correction_conflicts === 1, "correction conflict count mismatch");
  assert(existsSync(path.join(dataRoot, evaluation.evaluation_path)), "behavior evaluation artifact missing");
} finally {
  await client.close().catch(() => undefined);
  rmSync(dataRoot, { recursive: true, force: true });
}

console.log("behavior recall MCP correction verification ok");
