import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const serverPath = path.join(root, "dist", "index.js");
const dataRoot = mkdtempSync(path.join(tmpdir(), "dinobrain-compounding-"));

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

function parseTool(result) {
  const text = result.content?.find((part) => part.type === "text")?.text;
  assert(text, "Tool did not return text content");
  return JSON.parse(text);
}

for (const dir of [
  "20_Wiki",
  "30_Sources/chunks",
  "50_Instances/accepted",
  "50_Instances/archive/merged",
  "60_Operations",
  "70_Error_Book",
  "80_Review_Queue/promotion",
  ".dino/evaluations",
  ".dino/traces",
  ".dino/tasks",
]) {
  mkdirSync(path.join(dataRoot, dir), { recursive: true });
}

markdown(
  path.join(dataRoot, "20_Wiki", "Release-Parity.md"),
  `---
title: Release Parity
summary: Release work must verify local and remote refs before completion.
tags: [release, github, parity]
source_status: internal
confidence: high
last_verified: 2026-07-05
---

# Release Parity

Use exact commit/ref checks before reporting a GitHub release or installer update as complete.
`,
);

json(path.join(dataRoot, "50_Instances", "accepted", "invalid-behavior-rule.json"), {
  type: "behavior_rule",
  status: "accepted",
  behavior_rule: "Always use this invalid rule only after evidence exists.",
  claim: "Behavior rule without evidence must be held.",
  confidence: "low",
  tags: ["behavior-rule"],
});

json(path.join(dataRoot, "50_Instances", "accepted", "duplicate-behavior-rule.json"), {
  type: "behavior_rule",
  status: "accepted",
  behavior_rule: "Always verify release parity before reporting completion.",
  claim: "Duplicate behavior rule should merge into the auto-compounded keeper.",
  evidence: {
    source: "manual-seed",
    snippet: "Seed duplicate for merge verification.",
  },
  evidence_sources: [
    {
      trace_path: "manual-seed",
      signal_kind: "decision",
      snippet: "Seed duplicate for merge verification.",
    },
  ],
  support_count: 1,
  confidence: "medium",
  tags: ["behavior-rule"],
});

const client = new Client({ name: "dinobrain-compounding-verify", version: "2.2.1" });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [serverPath],
  cwd: root,
  env: {
    ...process.env,
    DINOBRAIN_DATA_DIR: dataRoot,
    DINOBRAIN_AUTO_GROWTH: "1",
    DINOBRAIN_AUTO_COMPOUND: "1",
    DINOBRAIN_AUTO_SYNC: "0",
  },
  stderr: "pipe",
});

try {
  await client.connect(transport);
  const tools = (await client.listTools()).tools.map((tool) => tool.name);
  for (const tool of ["os_begin_task", "finish_task", "run_compounding_cycle", "search_memory", "evaluate_behavior"]) {
    assert(tools.includes(tool), `Missing compounding tool dependency: ${tool}`);
  }

  const begin = parseTool(
    await client.callTool({
      name: "os_begin_task",
      arguments: {
        request: "GitHub release parity and installer push verification",
        project: "dinobrain",
        sensitivity: "normal",
        limit: 6,
      },
    }),
  );
  assert(begin.ok === true, `os_begin_task failed: ${JSON.stringify(begin.gates)}`);

  const finish = parseTool(
    await client.callTool({
      name: "finish_task",
      arguments: {
        task_id: begin.task_id,
        summary:
          "Verified release parity rules and pushed installer work only after exact local/remote ref checks.",
        outcome: "completed",
        changed_files: ["scripts/verify-compounding-loop.mjs"],
        decisions: [
          "Always verify release parity before reporting completion.",
          "When pushing release/data work, always verify local HEAD equals origin/main and tag refs before reporting completion.",
          "Do not call a memory OS loop complete unless a later Context Pack retrieves the promoted behavior rule.",
        ],
        next_steps: ["Run behavior evaluation after automatic compounding."],
        used_memory_paths: begin.context_pack.items.map((item) => item.path),
        context_pack_paths: [begin.context_pack.trace_path],
      },
    }),
  );

  assert(finish.compounding?.ok === true, "finish_task did not run automatic compounding");
  assert(
    Number(finish.compounding.promoted_count ?? 0) + Number(finish.compounding.updated_count ?? 0) >= 1,
    "automatic compounding did not promote or update a behavior rule",
  );
  assert(existsSync(path.join(dataRoot, finish.compounding.cycle_path)), "compounding cycle report missing");

  const parityPromotion = finish.compounding.promotions.find((promotion) =>
    String(promotion.behavior_rule).includes("verify release parity"),
  );
  assert(parityPromotion?.path, "release parity behavior rule candidate was not created");
  assert(existsSync(path.join(dataRoot, parityPromotion.path)), "behavior rule candidate file missing");
  assert(parityPromotion.review_path && existsSync(path.join(dataRoot, parityPromotion.review_path)), "behavior rule review file missing");

  const reviewedParity = parseTool(
    await client.callTool({
      name: "review_candidate",
      arguments: {
        candidate_id: path.basename(parityPromotion.path, ".json"),
        decision: "approve",
        reviewer: "verify-compounding-loop",
        notes: "Verifier approves the auto-compounded behavior rule after evidence checks.",
      },
    }),
  );
  assert(reviewedParity.accepted_path, "release parity behavior rule was not promoted after explicit review");

  const search = parseTool(
    await client.callTool({
      name: "search_memory",
      arguments: {
        query: "verify release parity reporting completion",
        limit: 8,
      },
    }),
  );
  assert(
    search.results.some((result) => result.path === reviewedParity.accepted_path),
    "search_memory did not retrieve the reviewed behavior rule",
  );

  const laterPack = parseTool(
    await client.callTool({
      name: "get_context_pack",
      arguments: {
        question: "Before reporting completion on GitHub release work verify release parity",
        limit: 8,
      },
    }),
  );
  assert(
    laterPack.items.some((item) => item.path === reviewedParity.accepted_path),
    "later Context Pack did not retrieve the reviewed behavior rule",
  );

  json(path.join(dataRoot, ".dino", "evaluations", "behavior-golden.json"), {
    version: 1,
    description: "Auto-compounded behavior rules must improve memory-on behavior.",
    target_memory_lift: 40,
    cases: [
      {
        id: "release-parity-rule",
        request: "Before completion on GitHub release work verify release parity",
        expected_memory_paths: [reviewedParity.accepted_path],
        expected_behavior_terms: ["verify", "release", "parity"],
      },
    ],
  });
  const behavior = parseTool(
    await client.callTool({
      name: "evaluate_behavior",
      arguments: {
        pack_limit: 8,
      },
    }),
  );
  assert(behavior.ok === true, `behavior eval failed: ${JSON.stringify(behavior.failing_cases)}`);
  assert(Number(behavior.average_memory_lift) > 0, "memory-on behavior did not beat memory-off baseline");

  const cleanup = parseTool(
    await client.callTool({
      name: "run_compounding_cycle",
      arguments: {
        apply: true,
        reviewer: "verify-compounding-cleanup",
        trace_limit: 20,
      },
    }),
  );
  assert(cleanup.ok === true, "manual compounding cycle failed");
  const cleanupActions = [...(finish.compounding.cleanup_actions ?? []), ...(cleanup.cleanup_actions ?? [])];
  assert(
    cleanupActions.some(
      (action) => action.type === "hold_invalid" && action.target_path === "50_Instances/accepted/invalid-behavior-rule.json" && action.applied === true,
    ),
    "compounding cleanup did not hold invalid behavior rule",
  );
  assert(
    cleanupActions.some(
      (action) => action.type === "merge_duplicate" && action.target_path === "50_Instances/accepted/duplicate-behavior-rule.json" && action.applied === true,
    ),
    "compounding cleanup did not merge duplicate behavior rule",
  );

  const held = JSON.parse(readFileSync(path.join(dataRoot, "50_Instances", "accepted", "invalid-behavior-rule.json"), "utf8"));
  assert(held.status === "hold" && held.quarantine === true, "invalid behavior rule was not held out");
  assert(
    existsSync(path.join(dataRoot, "50_Instances", "archive", "merged", "duplicate-behavior-rule.json")),
    "duplicate behavior rule was not archived after merge",
  );

  console.log(
    JSON.stringify(
      {
        ok: true,
        knowledge_compounding_proven: true,
        data_root: dataRoot,
        task_id: begin.task_id,
        behavior_rule_candidate_path: parityPromotion.path,
        promoted_behavior_rule_path: reviewedParity.accepted_path,
        compounding_cycle_path: finish.compounding.cycle_path,
        behavior_eval_path: behavior.evaluation_path,
        average_memory_lift: behavior.average_memory_lift,
        cleanup_cycle_path: cleanup.cycle_path,
        held_invalid_rule: held.status,
        duplicate_archived: "50_Instances/archive/merged/duplicate-behavior-rule.json",
      },
      null,
      2,
    ),
  );
} finally {
  await client.close();
}
