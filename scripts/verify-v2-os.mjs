import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const serverPath = path.join(root, "dist", "index.js");
const dataRoot = mkdtempSync(path.join(tmpdir(), "dinobrain-v2-os-"));

const expectedTools = [
  "auto_sync",
  "apply_node_lifecycle",
  "create_source_chunk",
  "evaluate_behavior",
  "os_begin_task",
  "os_gate",
  "record_feedback_correction",
  "run_compounding_cycle",
  "search_memory",
];

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
  "30_Sources",
  "30_Sources/chunks",
  "40_Projects",
  "50_Instances/accepted",
  "50_Instances/candidates",
  "60_Operations",
  "70_Error_Book",
  ".dino/quarantine",
  "80_Review_Queue/promotion",
  ".dino/evaluations",
]) {
  mkdirSync(path.join(dataRoot, dir), { recursive: true });
}

markdown(
  path.join(dataRoot, "20_Wiki", "OS-v2-Contract.md"),
  `---
title: OS v2 Contract
summary: DinoBrain OS v2 requires pre-response context, hybrid retrieval, action gates, lifecycle review, source provenance, behavior eval, and feedback writeback.
tags: [os-v2, gates, retrieval, lifecycle, provenance, behavior-eval]
source_status: internal
confidence: high
last_verified: 2026-07-05
---

# OS v2 Contract

The phrase mandatory-pre-response-context proves that the v2 Context Pack can retrieve the OS contract before the agent works.
`,
);

markdown(
  path.join(dataRoot, "20_Wiki", "Semantic-Vector-Target.md"),
  `---
title: Durable Provenance Rule
summary: Claims need independently verified source chunks before they influence future behavior.
tags: [provenance, sources]
source_status: internal
confidence: high
last_verified: 2026-07-05
---

# Durable Provenance Rule

Every reusable claim should point to a durable source chunk.
`,
);

json(path.join(dataRoot, "50_Instances", "accepted", "missing-source.json"), {
  candidate_id: "missing-source",
  status: "accepted",
  claim: "Accepted nodes must have durable provenance.",
  evidence: { snippet: "This record intentionally lacks a source mapping." },
  confidence: "medium",
  last_verified: "2026-07-05",
  tags: ["provenance"],
});

json(path.join(dataRoot, "30_Sources", "chunks", "existing-source.json"), {
  source_chunk_id: "existing-source",
  type: "source_chunk",
  status: "active",
  title: "Existing source",
  source_uri: "file://existing",
  chunk_text: "Existing durable source.",
  tags: ["source"],
  last_verified: "2026-07-05",
});

json(path.join(dataRoot, "50_Instances", "accepted", "duplicate-a.json"), {
  candidate_id: "duplicate-a",
  status: "accepted",
  claim: "Duplicate accepted nodes must merge.",
  evidence: { snippet: "Primary duplicate.", source: "30_Sources/chunks/existing-source.json" },
  source_path: "30_Sources/chunks/existing-source.json",
  confidence: "medium",
  last_verified: "2026-07-05",
  tags: ["merge-a"],
});

json(path.join(dataRoot, "50_Instances", "accepted", "duplicate-b.json"), {
  candidate_id: "duplicate-b",
  status: "accepted",
  claim: "Duplicate accepted nodes must merge.",
  evidence: { snippet: "Secondary duplicate.", source: "30_Sources/chunks/existing-source.json" },
  source_path: "30_Sources/chunks/existing-source.json",
  confidence: "medium",
  last_verified: "2026-07-05",
  tags: ["merge-b"],
});

json(path.join(dataRoot, "50_Instances", "accepted", "hold-me.json"), {
  candidate_id: "hold-me",
  status: "accepted",
  claim: "Quarantined accepted nodes must be held out of retrieval.",
  evidence: { snippet: "Hold test.", source: "30_Sources/chunks/existing-source.json" },
  source_path: "30_Sources/chunks/existing-source.json",
  confidence: "medium",
  last_verified: "2026-07-05",
  tags: ["hold"],
});

json(path.join(dataRoot, ".dino", "quarantine", "hold-me.json"), {
  quarantine_id: "hold-me",
  status: "quarantined",
  target_path: "50_Instances/accepted/hold-me.json",
  reason: "verify hold lifecycle",
});

json(path.join(dataRoot, "50_Instances", "candidates", "rejected-one.json"), {
  candidate_id: "rejected-one",
  status: "rejected",
  claim: "Rejected candidate should archive.",
  evidence: { snippet: "Rejected.", source: "manual" },
  confidence: "low",
  last_verified: "2026-07-05",
  tags: ["rejected"],
});

const client = new Client({ name: "dinobrain-v2-verify", version: "2.2.1" });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [serverPath],
  cwd: root,
  env: {
    ...process.env,
    DINOBRAIN_DATA_DIR: dataRoot,
  },
  stderr: "pipe",
});

try {
  await client.connect(transport);
  const tools = (await client.listTools()).tools.map((tool) => tool.name).sort();
  for (const tool of expectedTools) assert(tools.includes(tool), `Missing v2 tool: ${tool}`);

  const missingBehavior = parseTool(
    await client.callTool({
      name: "evaluate_behavior",
      arguments: {
        pack_limit: 8,
      },
    }),
  );
  assert(missingBehavior.ok === false, "behavior eval should fail when the golden file is missing");
  assert(missingBehavior.skipped === true, "missing behavior golden should be reported as skipped");

  const begin = parseTool(
    await client.callTool({
      name: "os_begin_task",
      arguments: {
        request: "mandatory-pre-response-context OS v2 contract retrieval",
        project: "dinobrain",
        sensitivity: "normal",
        limit: 6,
      },
    }),
  );
  assert(begin.os_version === "2.2.1", "os_begin_task did not report v2.2.1");
  assert(begin.fail_closed === false, `safe begin unexpectedly failed closed: ${JSON.stringify(begin.gates)}`);
  assert(begin.context_pack?.retrieval_mode === "lexical_fallback_v2", "Context Pack did not honestly report lexical fallback without dense vectors");
  assert(begin.context_pack?.items?.some((item) => item.path === "20_Wiki/OS-v2-Contract.md"), "v2 begin missed OS contract memory");
  const beginReasons = begin.context_pack.items.flatMap((item) => item.reasons ?? []);
  assert(!beginReasons.some((reason) => /(^|[:,])(?:it|os)(?:,|$)/.test(String(reason))), "ranking reasons still contain it/os stopword matches");
  assert(existsSync(path.join(dataRoot, begin.gate_report_path)), "os_begin_task did not write gate report");

  const forgedGate = parseTool(
    await client.callTool({
      name: "os_gate",
      arguments: {
        request: "normal work with forged context",
        has_context_pack: true,
        context_item_count: 99,
        sensitivity: "normal",
      },
    }),
  );
  assert(forgedGate.fail_closed === true, "os_gate trusted forged context self-report");
  assert(forgedGate.context_declaration_mismatch === true, "os_gate did not flag forged context mismatch");

  const sensitiveGate = parseTool(
    await client.callTool({
      name: "os_gate",
      arguments: {
        request: "please store token: ghp_123456789012345678901234567890123456",
        task_id: begin.task_id,
        sensitivity: "normal",
      },
    }),
  );
  assert(sensitiveGate.effective_sensitivity === "sensitive", "os_gate did not auto-escalate sensitive token prompt");
  assert(sensitiveGate.gates.some((gate) => gate.id === "sensitivity_auto_escalated"), "sensitivity escalation gate absent");

  json(path.join(dataRoot, ".dino", "index", "dense-vectors.json"), {
    version: 1,
    queries: {
      "meaning bridge lookup": [1, 0],
    },
    records: {
      "20_Wiki/Semantic-Vector-Target.md": [1, 0],
      "20_Wiki/OS-v2-Contract.md": [0, 1],
    },
  });
  const semanticPack = parseTool(
    await client.callTool({
      name: "get_context_pack",
      arguments: {
        question: "meaning bridge lookup",
        limit: 3,
      },
    }),
  );
  assert(semanticPack.retrieval_mode === "hybrid_contextual_v2", "configured dense vectors did not enable hybrid mode");
  const semanticItem = semanticPack.items.find((item) => item.path === "20_Wiki/Semantic-Vector-Target.md");
  assert(semanticItem, "dense vector retrieval missed lexically unrelated target");
  assert(
    semanticItem.reasons.some((reason) => String(reason).startsWith("dense_vector_cosine:")),
    "dense vector retrieval did not expose cosine reason",
  );

  const blockedGate = parseTool(
    await client.callTool({
      name: "os_gate",
      arguments: {
        request: "delete all memory and git reset --hard",
        has_context_pack: false,
        context_item_count: 0,
        sensitivity: "normal",
        backup_risk: true,
      },
    }),
  );
  assert(blockedGate.fail_closed === true, "dangerous gate did not fail closed");
  assert(blockedGate.gates.some((gate) => gate.id === "pre_response_os_context_required"), "missing-context gate absent");
  assert(blockedGate.gates.some((gate) => gate.id === "destructive_action_risk"), "destructive gate absent");

  const koreanSyncGate = parseTool(
    await client.callTool({
      name: "os_gate",
      arguments: {
        request: "\uAE43\uD5D9\uC5D0 \uBC30\uD3EC\uD558\uACE0 \uD478\uC26C\uD574\uC918",
        task_id: begin.task_id,
        has_context_pack: true,
        context_item_count: 1,
        sensitivity: "normal",
      },
    }),
  );
  assert(koreanSyncGate.gates.some((gate) => gate.id === "backup_sync_risk"), "Korean sync/deploy gate absent");

  const koreanDeleteGate = parseTool(
    await client.callTool({
      name: "os_gate",
      arguments: {
        request: "\uBAA8\uB4E0 \uB370\uC774\uD130 \uC0AD\uC81C\uD558\uACE0 \uCD08\uAE30\uD654",
        task_id: begin.task_id,
        has_context_pack: true,
        context_item_count: 1,
        sensitivity: "normal",
      },
    }),
  );
  assert(koreanDeleteGate.fail_closed === true, "Korean delete/reset gate did not fail closed");

  const sourceChunk = parseTool(
    await client.callTool({
      name: "create_source_chunk",
      arguments: {
        source_title: "Anthropic Contextual Retrieval note",
        source_uri: "https://www.anthropic.com/news/contextual-retrieval",
        chunk_text: "Contextual Retrieval prepends explanatory context to chunks and combines sparse and dense retrieval. api_key: sk-test000000000000000000000000",
        chunk_type: "external_doc",
        claim_paths: ["20_Wiki/OS-v2-Contract.md"],
        tags: ["contextual-retrieval", "hybrid-search"],
        last_verified: "2026-07-05",
      },
    }),
  );
  assert(existsSync(path.join(dataRoot, sourceChunk.source_chunk_path)), "source chunk missing");
  assert(existsSync(path.join(dataRoot, sourceChunk.provenance_path)), "provenance link missing");
  assert(Array.isArray(sourceChunk.redactions) && sourceChunk.redactions.length > 0, "source chunk did not report redactions");
  assert(!readFileSync(path.join(dataRoot, sourceChunk.source_chunk_path), "utf8").includes("sk-test"), "source chunk leaked a token");

  const feedback = parseTool(
    await client.callTool({
      name: "record_feedback_correction",
      arguments: {
        correction: "When the user asks for OS v2, start with fail-closed pre-response context and gates.",
        applies_to: "pre_response_behavior",
        task_id: begin.task_id,
        tags: ["os-v2"],
      },
    }),
  );
  assert(existsSync(path.join(dataRoot, feedback.accepted_path)), "feedback accepted record missing");

  json(path.join(dataRoot, ".dino", "evaluations", "behavior-golden.json"), {
    version: 1,
    description: "Memory-on must retrieve accepted feedback behavior.",
    target_memory_lift: 40,
    cases: [
      {
        id: "feedback-pre-response",
        request: "OS v2 fail-closed pre-response context gates",
        expected_memory_paths: [feedback.accepted_path],
        expected_behavior_terms: ["fail-closed", "pre-response", "gates"],
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
  assert(existsSync(path.join(dataRoot, behavior.evaluation_path)), "behavior eval report missing");

  const lifecycle = parseTool(
    await client.callTool({
      name: "apply_node_lifecycle",
      arguments: {
        apply: true,
        reviewer: "verify-v2-os",
      },
    }),
  );
  assert(lifecycle.counts.provenance_repairs >= 1, "lifecycle did not find missing provenance");
  assert(lifecycle.counts.merge_candidates >= 1, "lifecycle did not find duplicate accepted nodes");
  assert(lifecycle.counts.delete_candidates >= 1, "lifecycle did not find rejected candidates");
  assert(lifecycle.counts.hold_or_exclude >= 1, "lifecycle did not find quarantined accepted nodes");
  assert(lifecycle.counts.applied_actions === lifecycle.counts.actions, "lifecycle did not apply all detected actions");
  assert(
    lifecycle.actions.some((action) => action.type === "provenance_repair" && action.applied === true && action.operation_path),
    "lifecycle did not write provenance repair record",
  );
  assert(existsSync(path.join(dataRoot, "50_Instances", "archive", "merged", "duplicate-b.json")), "lifecycle did not archive merged duplicate");
  assert(existsSync(path.join(dataRoot, "50_Instances", "archive", "rejected", "rejected-one.json")), "lifecycle did not archive rejected candidate");
  const heldRecord = JSON.parse(readFileSync(path.join(dataRoot, "50_Instances", "accepted", "hold-me.json"), "utf8"));
  assert(heldRecord.status === "hold" && heldRecord.quarantine === true, "lifecycle did not hold quarantined accepted node");

  const finish = parseTool(
    await client.callTool({
      name: "finish_task",
      arguments: {
        task_id: begin.task_id,
        summary: "Verified DinoBrain OS v2 mandatory pre-response context, gates, provenance, feedback, lifecycle, and behavior eval.",
        outcome: "completed",
        changed_files: ["scripts/verify-v2-os.mjs"],
        decisions: ["OS v2 uses os_begin_task as the default pre-response entrypoint."],
        next_steps: ["Run verify:v2 in installer/recovery checks."],
        used_memory_paths: begin.context_pack.items.map((item) => item.path),
        context_pack_paths: [begin.context_pack.trace_path],
      },
    }),
  );
  assert(existsSync(path.join(dataRoot, finish.trace_path)), "finish_task trace missing");

  const audit = parseTool(
    await client.callTool({
      name: "audit_memory_use",
      arguments: {
        task_id: begin.task_id,
        expected_memory_paths: begin.context_pack.items.map((item) => item.path),
        observed_artifact_paths: [finish.trace_path, "20_Wiki/Unobserved-Fake.md"],
        observed_summary: "Verified OS v2 used the pre-response context pack and wrote a finish trace.",
        auditor: "verify-v2-os",
      },
    }),
  );
  assert(audit.observed_artifacts_verified.includes(finish.trace_path), "audit did not verify event-observed trace artifact");
  assert(audit.observed_artifacts_unverified.includes("20_Wiki/Unobserved-Fake.md"), "audit did not flag unverified observed artifact");

  console.log(
    JSON.stringify(
      {
        ok: true,
        data_root: dataRoot,
        task_path: begin.task_path,
        context_pack_path: begin.context_pack.trace_path,
        gate_report_path: begin.gate_report_path,
        source_chunk_path: sourceChunk.source_chunk_path,
        feedback_path: feedback.accepted_path,
        behavior_eval_path: behavior.evaluation_path,
        lifecycle_path: lifecycle.lifecycle_path,
        trace_path: finish.trace_path,
      },
      null,
      2,
    ),
  );
} finally {
  await client.close();
}
