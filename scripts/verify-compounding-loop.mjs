import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { DINOBRAIN_VERSION } from "./lib/version-manifest.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const serverPath = path.join(root, "dist", "index.js");
const dataRoot = mkdtempSync(path.join(tmpdir(), "dinobrain-controlled-compounding-"));
const capRoot = mkdtempSync(path.join(tmpdir(), "dinobrain-compounding-caps-"));
const RULE = "Always verify release parity before reporting completion.";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function json(filePath, value) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function markdown(filePath, value) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, value, "utf8");
}

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function sha(value) {
  return createHash("sha256").update(value).digest("hex");
}

function fileHash(filePath) {
  return existsSync(filePath) ? sha(readFileSync(filePath)) : null;
}

function snapshot(relativePaths) {
  return Object.fromEntries(relativePaths.map((relativePath) => [relativePath, fileHash(path.join(dataRoot, relativePath))]));
}

function assertSnapshot(actual, expected, label) {
  for (const [relativePath, expectedHash] of Object.entries(expected)) {
    assert(actual[relativePath] === expectedHash, `${label} hash mismatch: ${relativePath}`);
  }
}

function parseTool(result) {
  const text = result.content?.find((part) => part.type === "text")?.text;
  assert(text, "Tool did not return text content");
  return JSON.parse(text);
}

function controlledCandidates(vaultRoot) {
  const dir = path.join(vaultRoot, "50_Instances", "candidates");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .map((name) => ({ name, record: readJson(path.join(dir, name)) }))
    .filter((entry) => entry.record.proposal_version === "controlled_compounding_proposal_v2");
}

function acceptedLifecycle(record, id, at, evidencePath) {
  const transitionId = `node-transition-test-seed-${id}`;
  return {
    ...record,
    node_id: id,
    lifecycle_version: "node_lifecycle_v3",
    lifecycle_state: "accepted",
    lifecycle_state_entered_at: at,
    lifecycle_last_transition_id: transitionId,
    lifecycle_history: [{
      transition_id: transitionId,
      idempotency_key: `test-seed|${id}|accepted`,
      from_state: null,
      to_state: "accepted",
      reason_code: "test_seed_accepted",
      reason: "Seed a deterministic accepted rule for controlled lifecycle regression.",
      actor: "verify-compounding-loop",
      evidence_paths: evidencePath ? [evidencePath] : [],
      predecessor_paths: [],
      successor_paths: [],
      at,
    }],
    predecessor_paths: [],
    successor_paths: [],
    status: "accepted",
    updated_at: at,
  };
}

function seedCapTrace(vaultRoot, id, decisions, at) {
  const request = `Recurring release policy sample ${id}`;
  json(path.join(vaultRoot, ".dino", "tasks", `${id}.json`), {
    task_id: id,
    request,
    prompt_hash: sha(request),
    project: "dinobrain",
    status: "completed",
    created_at: at,
    updated_at: at,
  });
  json(path.join(vaultRoot, ".dino", "traces", `${id}.json`), {
    task_id: id,
    outcome: "completed",
    summary: "Recurring release policy fixture.",
    decisions,
    next_steps: [],
    used_memory_paths: [],
    context_pack_paths: [],
    finished_at: at,
  });
}

for (const dir of [
  "20_Wiki",
  "30_Sources/chunks",
  "50_Instances/accepted",
  "50_Instances/candidates",
  "60_Operations",
  "70_Error_Book",
  "80_Review_Queue/promotion",
  ".dino/evaluations",
  ".dino/traces",
  ".dino/tasks",
]) {
  mkdirSync(path.join(dataRoot, dir), { recursive: true });
  mkdirSync(path.join(capRoot, dir), { recursive: true });
}

markdown(
  path.join(dataRoot, "20_Wiki", "Release-Parity.md"),
  `---
title: Release Parity
summary: Release work must verify local and remote refs before completion.
tags: [release, github, parity]
source_status: internal
confidence: high
last_verified: 2026-07-11
---

# Release Parity

Use exact commit and ref checks before reporting a GitHub release or installer update as complete.
`,
);

const client = new Client({ name: "dinobrain-controlled-compounding-verify", version: DINOBRAIN_VERSION });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [serverPath],
  cwd: root,
  env: {
    ...process.env,
    DINOBRAIN_DATA_DIR: dataRoot,
    DINOBRAIN_AUTO_GROWTH: "0",
    DINOBRAIN_AUTO_COMPOUND: "1",
    DINOBRAIN_AUTO_SYNC: "0",
  },
  stderr: "pipe",
});

async function call(name, args) {
  return parseTool(await client.callTool({ name, arguments: args }));
}

async function completeRecurringTask(run) {
  const begin = await call("os_begin_task", {
    request: `Release parity verification recurrence run ${run}`,
    project: "dinobrain",
    sensitivity: "normal",
    limit: 6,
  });
  assert(begin.ok === true, `os_begin_task ${run} failed`);
  const finish = await call("finish_task", {
    task_id: begin.task_id,
    lease_id: begin.lease?.lease_id,
    summary: `Completed independent release parity verification run ${run}.`,
    outcome: "completed",
    changed_files: ["scripts/verify-compounding-loop.mjs"],
    decisions: [RULE],
    next_steps: ["Continue using the reviewed rule only after independent promotion review."],
    used_memory_paths: begin.context_pack.items.map((item) => item.path),
    context_pack_paths: [begin.context_pack.trace_path],
  });
  assert(finish.compounding?.ok === true, `automatic compounding ${run} failed: ${JSON.stringify(finish.compounding)}`);
  return { begin, finish };
}

try {
  await client.connect(transport);
  const tools = (await client.listTools()).tools.map((tool) => tool.name);
  for (const tool of ["os_begin_task", "finish_task", "review_candidate", "run_compounding_cycle", "search_memory", "evaluate_behavior"]) {
    assert(tools.includes(tool), `Missing compounding tool dependency: ${tool}`);
  }

  const first = await completeRecurringTask(1);
  assert(Number(first.finish.compounding.promoted_count ?? -1) === 0, "a singleton signal created a proposal");
  assert(controlledCandidates(dataRoot).length === 0, "singleton signal persisted a controlled proposal");
  assert(
    (first.finish.compounding.promotions ?? []).some((entry) => entry.reason_code === "single_occurrence_suppressed"),
    "singleton suppression reason missing",
  );

  const second = await completeRecurringTask(2);
  assert(Number(second.finish.compounding.promoted_count ?? 0) === 1, "recurring signal did not create exactly one proposal");
  const parityPromotion = second.finish.compounding.promotions.find((entry) => entry.behavior_rule === RULE && entry.path);
  assert(parityPromotion?.path && parityPromotion.review_path, "recurring proposal paths missing");
  const candidateAbsolute = path.join(dataRoot, parityPromotion.path);
  const reviewAbsolute = path.join(dataRoot, parityPromotion.review_path);
  const candidateBeforeBlockedReview = fileHash(candidateAbsolute);
  const reviewBeforeBlockedReview = fileHash(reviewAbsolute);

  const blockedReview = await call("review_candidate", {
    candidate_id: path.basename(parityPromotion.path, ".json"),
    decision: "approve",
    reviewer: "independent-compounding-reviewer",
    notes: "Attempt approval without explicit scope attestation.",
  });
  assert(blockedReview.ok === false && blockedReview.mutation_performed === false, "missing scope approval was not fail-closed");
  assert(blockedReview.blockers.includes("compounding_scope_review_required"), "scope blocker missing");
  assert(fileHash(candidateAbsolute) === candidateBeforeBlockedReview, "blocked review mutated candidate bytes");
  assert(fileHash(reviewAbsolute) === reviewBeforeBlockedReview, "blocked review mutated review bytes");

  const reviewedParity = await call("review_candidate", {
    candidate_id: path.basename(parityPromotion.path, ".json"),
    decision: "approve",
    reviewer: "independent-compounding-reviewer",
    notes: "Verified recurrence, scope, durable task/trace provenance, contradiction state, and hot-rule budget.",
    compounding_scope_approved: true,
  });
  assert(reviewedParity.ok === true && reviewedParity.accepted_path, "independent controlled review did not promote the rule");
  assert(reviewedParity.controlled_compounding_gate?.eligible === true, "promotion gate was not retained as eligible evidence");
  const acceptedAbsolute = path.join(dataRoot, reviewedParity.accepted_path);
  const accepted = readJson(acceptedAbsolute);
  assert(accepted.independently_reviewed === true, "accepted rule lacks independent-review marker");
  assert(accepted.proposal_version === "controlled_compounding_proposal_v2", "accepted rule lost proposal lineage");

  const search = await call("search_memory", { query: "verify release parity before completion", limit: 8 });
  assert(search.results.some((entry) => entry.path === reviewedParity.accepted_path), "reviewed rule was not searchable");
  const laterPack = await call("get_context_pack", {
    question: "Before reporting completion on release work, verify release parity",
    limit: 8,
  });
  assert(laterPack.items.some((entry) => entry.path === reviewedParity.accepted_path), "later Context Pack did not retrieve reviewed rule");

  json(path.join(dataRoot, ".dino", "evaluations", "behavior-golden.json"), {
    version: 1,
    description: "Reviewed recurring behavior rules must improve memory-on behavior.",
    target_memory_lift: 40,
    cases: [{
      id: "controlled-release-parity-rule",
      request: "Before completion on GitHub release work verify release parity",
      expected_memory_paths: [reviewedParity.accepted_path],
      expected_behavior_terms: ["verify", "release", "parity"],
    }],
  });
  const behavior = await call("evaluate_behavior", { pack_limit: 8 });
  assert(behavior.ok === true, `behavior eval failed: ${JSON.stringify(behavior.failing_cases)}`);
  assert(Number(behavior.average_memory_lift) > 0, "memory-on behavior did not beat memory-off baseline");

  const validBase = readJson(acceptedAbsolute);
  const firstEvidencePath = validBase.evidence_sources[0].trace_path;
  const invalidPath = "50_Instances/accepted/controlled-invalid.json";
  const duplicatePath = "50_Instances/accepted/controlled-duplicate.json";
  const tamperedPath = "50_Instances/accepted/controlled-tampered.json";
  const demotePath = "50_Instances/accepted/controlled-demote.json";
  const archivePath = "50_Instances/accepted/controlled-archive.json";
  json(path.join(dataRoot, invalidPath), acceptedLifecycle({
    type: "behavior_rule",
    proposal_version: "controlled_compounding_proposal_v2",
    behavior_rule: "Always publish unsupported broad memory rules without independent review evidence.",
    auto_generated: true,
    independently_reviewed: false,
    confidence: "low",
    evidence_sources: [],
    support_count: 0,
    distinct_task_count: 0,
    scope_key: "project:dinobrain",
    topic_key: "project:dinobrain|topic:memory",
    tags: ["behavior-rule", "controlled-compounding", "topic:memory"],
    accepted_at: "2026-07-01T00:00:00.000Z",
  }, "controlled-invalid", "2026-07-01T00:00:00.000Z", firstEvidencePath));

  const cloneRule = (id, behaviorRule, topic, acceptedAt) => acceptedLifecycle({
    ...structuredClone(validBase),
    candidate_id: id,
    behavior_rule_id: id,
    behavior_rule: behaviorRule,
    claim: `Behavior rule: ${behaviorRule}`,
    topic_key: `project:dinobrain|topic:${topic}`,
    topic_label: topic,
    tags: ["behavior-rule", "controlled-compounding", `topic:${topic}`],
    accepted_at: acceptedAt,
    reviewed_at: acceptedAt,
    created_at: acceptedAt,
    updated_at: acceptedAt,
  }, id, acceptedAt, firstEvidencePath);
  json(path.join(dataRoot, duplicatePath), cloneRule("controlled-duplicate", RULE, "release", "2026-07-01T00:00:00.000Z"));
  const tamperedRule = cloneRule(
    "controlled-tampered",
    "Always verify durable source hashes before trusting reviewed memory rules.",
    "memory",
    "2026-07-01T00:00:00.000Z",
  );
  tamperedRule.evidence_sources[0].trace_sha256 = "0".repeat(64);
  json(path.join(dataRoot, tamperedPath), tamperedRule);
  json(path.join(dataRoot, demotePath), cloneRule(
    "controlled-demote",
    "Always compare archived package manifests before restoring old installer releases.",
    "installer",
    "2026-03-20T00:00:00.000Z",
  ));
  json(path.join(dataRoot, archivePath), cloneRule(
    "controlled-archive",
    "Always inspect obsolete deployment snapshots before restoring retired release channels.",
    "release",
    "2025-01-01T00:00:00.000Z",
  ));

  const lifecyclePaths = [
    reviewedParity.accepted_path,
    invalidPath,
    duplicatePath,
    tamperedPath,
    demotePath,
    archivePath,
    "60_Operations/behavior-rules/behavior-rule-index.json",
    ".dino/state/controlled_compounding_status.json",
  ];
  const beforeCleanup = snapshot(lifecyclePaths);
  const cleanup = await call("run_compounding_cycle", {
    apply: true,
    reviewer: "verify-compounding-cleanup",
    trace_limit: 20,
  });
  assert(cleanup.ok === true && cleanup.cycle_path, "controlled cleanup cycle failed");
  const actions = cleanup.cleanup_actions ?? [];
  for (const [type, target] of [
    ["hold_invalid", invalidPath],
    ["hold_invalid", tamperedPath],
    ["merge_duplicate", duplicatePath],
    ["demote_low_use", demotePath],
    ["archive_stale_low_use", archivePath],
  ]) {
    assert(actions.some((entry) => entry.type === type && entry.target_path === target && entry.applied === true), `${type} action missing`);
  }
  assert(readJson(path.join(dataRoot, invalidPath)).lifecycle_state === "held", "invalid rule was not held");
  assert(readJson(path.join(dataRoot, duplicatePath)).lifecycle_state === "archived", "duplicate rule was not archived");
  assert(readJson(path.join(dataRoot, tamperedPath)).lifecycle_state === "held", "tampered provenance rule was not held");
  assert(readJson(path.join(dataRoot, demotePath)).lifecycle_state === "demoted", "low-use rule was not demoted");
  assert(readJson(path.join(dataRoot, archivePath)).lifecycle_state === "archived", "stale rule was not archived");
  const controlledStatus = readJson(path.join(dataRoot, ".dino", "state", "controlled_compounding_status.json"));
  assert(controlledStatus.status === "healthy", `controlled status not healthy: ${controlledStatus.blockers}`);

  const cleanupProofPaths = [
    ...lifecyclePaths,
    cleanup.public_summary_path,
    cleanup.usage_snapshot_path,
  ].filter(Boolean);
  const afterCleanup = snapshot(cleanupProofPaths);
  const rolledBack = await call("run_compounding_cycle", {
    apply: true,
    reviewer: "verify-compounding-cleanup",
    trace_limit: 20,
    rollback_cycle_path: cleanup.cycle_path,
  });
  assert(rolledBack.ok === true && rolledBack.cycle_status === "rolled_back", "cleanup rollback failed");
  assertSnapshot(snapshot(lifecyclePaths), beforeCleanup, "rollback");
  assert(fileHash(path.join(dataRoot, cleanup.public_summary_path)) === null, "rollback left public summary behind");
  assert(fileHash(path.join(dataRoot, cleanup.usage_snapshot_path)) === null, "rollback left usage snapshot behind");

  const reapplied = await call("run_compounding_cycle", {
    apply: true,
    reviewer: "verify-compounding-cleanup",
    trace_limit: 20,
    reapply_cycle_path: cleanup.cycle_path,
  });
  assert(reapplied.ok === true && reapplied.cycle_status === "applied", "cleanup reapply failed");
  assertSnapshot(snapshot(cleanupProofPaths), afterCleanup, "reapply");

  const { runCompoundingCycle } = await import("../dist/controlled-compounding.js");
  const { takeWithContextPackBudgets } = await import("../dist/hybrid-retrieval.js");
  const capRules = [
    "Always verify release parity before publishing completion reports.",
    "Always compare installer artifact hashes before publishing release assets.",
    "Always verify GitHub tag commit parity before publishing installer releases.",
  ];
  seedCapTrace(capRoot, "cap-task-1", capRules, "2026-07-10T00:00:00.000Z");
  seedCapTrace(capRoot, "cap-task-2", capRules, "2026-07-10T01:00:00.000Z");
  json(path.join(capRoot, "50_Instances", "candidates", "existing-release-proposal.json"), {
    candidate_id: "existing-release-proposal",
    proposal_version: "controlled_compounding_proposal_v2",
    type: "behavior_rule_proposal",
    status: "pending_review",
    topic_key: "project:dinobrain|topic:release",
  });
  const capDryRun = await runCompoundingCycle(capRoot, {
    apply: false,
    reviewer: "cap-verifier",
    traceLimit: 10,
    now: new Date("2026-07-11T00:00:00.000Z"),
    policy: { max_signals_per_trace: 2, max_active_proposals_per_topic: 1 },
  });
  assert(capDryRun.suppressed.some((entry) => entry.reason_code === "per_trace_signal_cap"), "per-session signal cap was not observed");
  assert(capDryRun.promotions.every((entry) => entry.action === "suppressed" && entry.reason_code === "topic_proposal_cap"), "per-topic proposal cap failed");
  assert(controlledCandidates(capRoot).length === 1, "dry-run wrote new controlled proposals");

  const syntheticRecords = [
    ...Array.from({ length: 5 }, (_, index) => ({
      path: `50_Instances/accepted/release-rule-${index}.json`,
      kind: "curated_record",
      title: `Release rule ${index}`,
      summary: "Reviewed controlled release behavior rule.",
      tags: ["behavior-rule", "controlled-compounding", "topic:release"],
      score: 100 - index,
      reasons: [],
      excerpt: "controlled_compounding_proposal_v2 independently_reviewed true",
    })),
    ...Array.from({ length: 3 }, (_, index) => ({
      path: `50_Instances/accepted/memory-rule-${index}.json`,
      kind: "curated_record",
      title: `Memory rule ${index}`,
      summary: "Reviewed controlled memory behavior rule.",
      tags: ["behavior-rule", "controlled-compounding", "topic:memory"],
      score: 90 - index,
      reasons: [],
      excerpt: "controlled_compounding_proposal_v2 independently_reviewed true",
    })),
    {
      path: "20_Wiki/release.md",
      kind: "curated_record",
      title: "Release Wiki",
      summary: "Normal curated context remains available.",
      tags: ["release"],
      score: 80,
      reasons: [],
      excerpt: "release evidence",
    },
  ];
  const budgeted = takeWithContextPackBudgets(syntheticRecords, 9, "release memory behavior rules");
  const budgetedControlled = budgeted.filter((entry) => entry.tags.includes("controlled-compounding"));
  assert(budgetedControlled.length <= 3, "Context Pack controlled-rule total cap failed");
  assert(budgetedControlled.filter((entry) => entry.tags.includes("topic:release")).length <= 2, "Context Pack per-topic cap failed");
  assert(budgeted.some((entry) => entry.path === "20_Wiki/release.md"), "Context Pack budget starved normal curated context");

  console.log(JSON.stringify({
    ok: true,
    version: "controlled_compounding_v2",
    singleton_persisted: false,
    recurring_candidate_path: parityPromotion.path,
    reviewed_rule_path: reviewedParity.accepted_path,
    behavior_memory_lift: behavior.average_memory_lift,
    cleanup_cycle_path: cleanup.cycle_path,
    rollback_exact_paths: lifecyclePaths.length,
    reapply_exact_paths: cleanupProofPaths.length,
    lifecycle_actions: actions.map((entry) => entry.type),
    cap_reasons: capDryRun.suppressed,
    context_pack_controlled_rule_count: budgetedControlled.length,
    controlled_status_path: ".dino/state/controlled_compounding_status.json",
  }, null, 2));
} finally {
  await client.close();
}
