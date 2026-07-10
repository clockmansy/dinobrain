import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { DINOBRAIN_VERSION } from "./lib/version-manifest.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const serverPath = path.join(root, "dist", "index.js");
const tempDataRoot = mkdtempSync(path.join(tmpdir(), "dinobrain-smoke-"));

for (const dir of [
  "00_Home",
  "20_Wiki",
  "30_Sources",
  "40_Projects",
  "50_Instances/accepted",
  "60_Operations",
  "70_Error_Book",
  "80_Review_Queue",
  ".dino",
]) {
  mkdirSync(path.join(tempDataRoot, dir), { recursive: true });
}

writeFileSync(
  path.join(tempDataRoot, "20_Wiki", "DinoBrain-MCP.md"),
  `---
title: DinoBrain MCP
summary: DinoBrain exposes task memory through an MCP server.
tags: [dinobrain, mcp, context-pack]
source_status: internal
confidence: high
last_verified: 2026-07-01
---

# DinoBrain MCP

DinoBrain uses MCP tools to start tasks, finish tasks, search curated notes, and build Context Packs.
`,
  "utf8",
);
writeFileSync(
  path.join(tempDataRoot, "20_Wiki", "Quarantine-Test-Memory.md"),
  `---
title: Quarantine Test Memory
summary: This record should disappear from default Context Packs after quarantine.
tags: [quarantine, test-memory]
source_status: internal
confidence: low
last_verified: 2026-07-01
---

# Quarantine Test Memory

This note exists only to verify quarantine exclusion from Context Packs.
`,
  "utf8",
);
writeFileSync(
  path.join(tempDataRoot, "20_Wiki", "Syncable-Change.md"),
  `---
title: Syncable Change
summary: This file should be classified as syncable after review.
tags: [syncable]
source_status: internal
confidence: high
last_verified: 2026-07-01
---

# Syncable Change

This file exists to verify git_sync dry-run classification.
`,
  "utf8",
);
writeFileSync(
  path.join(tempDataRoot, "80_Review_Queue", "review-needed.md"),
  "# Review Needed\n\nThis file should be classified as conditional.\n",
  "utf8",
);
writeFileSync(
  path.join(tempDataRoot, ".dino", "secrets.json"),
  "{\"note\":\"This path must be blocked even without secret-looking values.\"}\n",
  "utf8",
);
mkdirSync(path.join(tempDataRoot, ".dino", "review-admissions", "2026-07"), { recursive: true });
writeFileSync(
  path.join(tempDataRoot, ".dino", "review-admissions", "2026-07", "decision.json"),
  "{\"idempotency_key\":\"local-review-decision\"}\n",
  "utf8",
);
writeFileSync(
  path.join(tempDataRoot, "20_Wiki", "Sensitive-Pattern.md"),
  `api_${"key"}: pretend-this-is-sensitive\n`,
  "utf8",
);

spawnSync("git", ["init"], { cwd: tempDataRoot, stdio: "ignore" });
spawnSync("git", ["config", "user.email", "dinobrain-smoke@example.local"], { cwd: tempDataRoot, stdio: "ignore" });
spawnSync("git", ["config", "user.name", "DinoBrain Smoke"], { cwd: tempDataRoot, stdio: "ignore" });

const client = new Client({
  name: "dinobrain-smoke",
  version: DINOBRAIN_VERSION,
});

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [serverPath],
  cwd: root,
  env: {
    ...process.env,
    DINOBRAIN_DATA_DIR: tempDataRoot,
  },
  stderr: "pipe",
});

function parseTool(result) {
  const text = result.content?.find((part) => part.type === "text")?.text;
  if (!text) throw new Error("Tool did not return text content");
  return JSON.parse(text);
}

try {
  await client.connect(transport);

  const tools = await client.listTools();
  const names = tools.tools.map((tool) => tool.name).sort();
  const expected = [
    "auto_sync",
    "apply_node_lifecycle",
    "audit_memory_use",
    "create_candidate_instance",
    "create_source_chunk",
    "evaluate_behavior",
    "finish_task",
    "get_context_pack",
    "git_sync",
    "import_session",
    "os_begin_task",
    "os_gate",
    "quarantine_record",
    "record_feedback_correction",
    "restore_memory_node",
    "review_candidate",
    "run_compounding_cycle",
    "search_memory",
    "start_task",
    "transition_memory_node",
    "wiki_search",
  ];
  for (const name of expected) {
    if (!names.includes(name)) throw new Error(`Missing tool: ${name}`);
  }

  const begin = parseTool(
    await client.callTool({
      name: "os_begin_task",
      arguments: {
        request: "Smoke test DinoBrain OS v2 mandatory pre-response context",
        project: "dinobrain",
        mode: "standard",
        sensitivity: "normal",
        limit: 5,
      },
    }),
  );
  if (!begin.context_pack?.trace_path || !existsSync(path.join(tempDataRoot, begin.context_pack.trace_path))) {
    throw new Error("os_begin_task did not create a Context Pack trace");
  }
  if (begin.fail_closed === true) {
    throw new Error(`os_begin_task unexpectedly failed closed: ${JSON.stringify(begin.gates)}`);
  }

  const start = parseTool(
    await client.callTool({
      name: "start_task",
      arguments: {
        request: "Smoke test DinoBrain MCP server",
        project: "dinobrain",
        mode: "standard",
        sensitivity: "normal",
      },
    }),
  );
  if (!existsSync(path.join(tempDataRoot, start.task_path))) {
    throw new Error(`Missing task record: ${start.task_path}`);
  }

  const contextPack = parseTool(
    await client.callTool({
      name: "get_context_pack",
      arguments: {
        question: "How does DinoBrain use MCP context pack tools?",
        limit: 5,
      },
    }),
  );
  if (contextPack.item_count < 1) {
    throw new Error("Context Pack did not return the seeded Wiki note");
  }
  if (!contextPack.trace_path || !existsSync(path.join(tempDataRoot, contextPack.trace_path))) {
    throw new Error(`Missing Context Pack trace: ${contextPack.trace_path}`);
  }
  if (contextPack.ranking_inputs.includes("body excerpt")) {
    throw new Error("Context Pack ranking inputs should not include body excerpt");
  }
  if (!contextPack.ranking_inputs.includes("recent task records")) {
    throw new Error("Context Pack ranking inputs should include recent task records");
  }
  const contextTrace = JSON.parse(readFileSync(path.join(tempDataRoot, contextPack.trace_path), "utf8"));
  if (!Array.isArray(contextTrace.items) || contextTrace.items.length < 1) {
    throw new Error("Context Pack trace did not record included items");
  }
  if (!contextTrace.items.every((item) => Array.isArray(item.reasons) && item.reasons.length > 0)) {
    throw new Error("Context Pack trace did not record inclusion reasons");
  }

  const search = parseTool(
    await client.callTool({
      name: "wiki_search",
      arguments: {
        query: "MCP",
        limit: 5,
      },
    }),
  );
  if (search.result_count < 1) {
    throw new Error("wiki_search did not return the seeded Wiki note");
  }

  let missingEvidenceRejected = false;
  try {
    const invalidCandidate = await client.callTool({
      name: "create_candidate_instance",
      arguments: {
        claim: "This should not be accepted without evidence.",
        evidence_snippet: "",
        evidence_source: "smoke",
        confidence: "low",
        last_verified: "2026-07-01",
        source_status: "internal",
      },
    });
    missingEvidenceRejected = invalidCandidate.isError === true;
  } catch {
    missingEvidenceRejected = true;
  }
  if (!missingEvidenceRejected) {
    throw new Error("Candidate without evidence was not rejected");
  }

  const candidate = parseTool(
    await client.callTool({
      name: "create_candidate_instance",
      arguments: {
        claim: "DinoBrain candidate instances enter review before promotion.",
        evidence_snippet: "Candidate instances always enter Review Queue first.",
        evidence_source: "scripts/smoke-mcp.mjs",
        confidence: "medium",
        last_verified: "2026-07-01",
        source_status: "internal",
        tags: ["candidate", "review"],
        task_id: start.task_id,
        sensitivity: "normal",
      },
    }),
  );
  if (!existsSync(path.join(tempDataRoot, candidate.candidate_path))) {
    throw new Error(`Missing candidate instance: ${candidate.candidate_path}`);
  }
  if (!existsSync(path.join(tempDataRoot, candidate.review_path))) {
    throw new Error(`Missing promotion review item: ${candidate.review_path}`);
  }

  const review = parseTool(
    await client.callTool({
      name: "review_candidate",
      arguments: {
        candidate_id: candidate.candidate_id,
        decision: "approve",
        reviewer: "smoke-test",
        notes: "Evidence, confidence, and last_verified are present.",
      },
    }),
  );
  if (!review.accepted_path || !existsSync(path.join(tempDataRoot, review.accepted_path))) {
    throw new Error(`Missing accepted instance: ${review.accepted_path}`);
  }

  const quarantine = parseTool(
    await client.callTool({
      name: "quarantine_record",
      arguments: {
        target_path: "20_Wiki/Quarantine-Test-Memory.md",
        reason: "Smoke test quarantine exclusion.",
        reviewer: "smoke-test",
      },
    }),
  );
  if (!existsSync(path.join(tempDataRoot, quarantine.quarantine_path))) {
    throw new Error(`Missing quarantine record: ${quarantine.quarantine_path}`);
  }
  const quarantineSidecarBefore = JSON.parse(
    readFileSync(path.join(tempDataRoot, quarantine.target_lifecycle_path), "utf8"),
  );
  const quarantineReplay = parseTool(
    await client.callTool({
      name: "quarantine_record",
      arguments: {
        target_path: "20_Wiki/Quarantine-Test-Memory.md",
        reason: "Smoke test quarantine exclusion.",
        reviewer: "smoke-test",
      },
    }),
  );
  const quarantineSidecarAfter = JSON.parse(
    readFileSync(path.join(tempDataRoot, quarantineReplay.target_lifecycle_path), "utf8"),
  );
  if (
    quarantineReplay.quarantine_id !== quarantine.quarantine_id ||
    quarantineReplay.target_lifecycle_path !== quarantine.target_lifecycle_path ||
    quarantineSidecarAfter.lifecycle_history.length !== quarantineSidecarBefore.lifecycle_history.length
  ) {
    throw new Error("Repeated quarantine was not idempotent");
  }

  const quarantinedPack = parseTool(
    await client.callTool({
      name: "get_context_pack",
      arguments: {
        question: "quarantine test memory",
        limit: 5,
      },
    }),
  );
  const quarantinedPaths = quarantinedPack.items.map((item) => item.path);
  if (quarantinedPaths.includes("20_Wiki/Quarantine-Test-Memory.md")) {
    throw new Error("Quarantined note appeared in Context Pack");
  }

  const finish = parseTool(
    await client.callTool({
      name: "finish_task",
      arguments: {
        task_id: start.task_id,
        lease_id: start.lease?.lease_id,
        summary: "Smoke test completed.",
        outcome: "completed",
        changed_files: ["src/index.ts", "scripts/smoke-mcp.mjs"],
        decisions: ["Use MCP SDK stdio transport for Phase 2."],
        next_steps: ["Wire the server into a real MCP client configuration."],
        used_memory_paths: contextPack.items.map((item) => item.path),
        context_pack_paths: [contextPack.trace_path],
        candidate_paths: [candidate.candidate_path],
        search_queries: ["MCP"],
      },
    }),
  );
  if (!existsSync(path.join(tempDataRoot, finish.trace_path))) {
    throw new Error(`Missing trace record: ${finish.trace_path}`);
  }
  const finishTrace = JSON.parse(readFileSync(path.join(tempDataRoot, finish.trace_path), "utf8"));
  if (!finishTrace.context_pack_paths?.includes(contextPack.trace_path)) {
    throw new Error("finish_task did not preserve structured context_pack_paths");
  }
  if (!finishTrace.used_memory_paths?.includes("20_Wiki/DinoBrain-MCP.md")) {
    throw new Error("finish_task did not preserve structured used_memory_paths");
  }

  const memoryAudit = parseTool(
    await client.callTool({
      name: "audit_memory_use",
      arguments: {
        task_id: start.task_id,
        expected_memory_paths: ["20_Wiki/DinoBrain-MCP.md"],
        observed_summary: "Smoke test used DinoBrain MCP memory and its Context Pack trace.",
        auditor: "smoke-test",
        notes: "Verify short memory-use audit logs.",
      },
    }),
  );
  if (!memoryAudit.audit_path || !existsSync(path.join(tempDataRoot, memoryAudit.audit_path))) {
    throw new Error(`Missing memory audit log: ${memoryAudit.audit_path}`);
  }
  if (memoryAudit.trust_score < 70) {
    throw new Error(`Unexpectedly low memory audit trust score: ${memoryAudit.trust_score}`);
  }
  const memoryAuditRecord = JSON.parse(readFileSync(path.join(tempDataRoot, memoryAudit.audit_path), "utf8"));
  if (!memoryAuditRecord.graph_health_snapshot || typeof memoryAuditRecord.graph_health_snapshot.score !== "number") {
    throw new Error("Memory audit did not record graph health snapshot");
  }
  if (memoryAuditRecord.graph_health_snapshot.referenced_unresolved_wiki_link_count == null) {
    throw new Error("Memory audit did not distinguish referenced graph health from global graph health");
  }
  if (memoryAuditRecord.observed_summary_preview.includes("sk-")) {
    throw new Error("Memory audit did not redact observed summary preview");
  }

  const duplicateMemoryAudit = parseTool(
    await client.callTool({
      name: "audit_memory_use",
      arguments: {
        task_id: start.task_id,
        expected_memory_paths: ["20_Wiki/DinoBrain-MCP.md"],
        observed_summary: "Second audit for the same task should create a separate instance audit log.",
        auditor: "smoke-test",
        notes: "Duplicate id guard.",
      },
    }),
  );
  if (duplicateMemoryAudit.audit_path === memoryAudit.audit_path) {
    throw new Error("audit_memory_use reused an audit path for the same task");
  }

  const mismatchAudit = parseTool(
    await client.callTool({
      name: "audit_memory_use",
      arguments: {
        task_id: start.task_id,
        expected_memory_paths: ["20_Wiki/Missing-Expected.md"],
        observed_summary: "Smoke test mismatch audit should report missing expected memory. sk-proj-example-secret-token-12345",
        auditor: "smoke-test",
        notes: "Missing expected memory path.",
      },
    }),
  );
  const mismatchAuditRecord = JSON.parse(readFileSync(path.join(tempDataRoot, mismatchAudit.audit_path), "utf8"));
  if (!mismatchAuditRecord.missing_expected_memory?.includes("20_Wiki/Missing-Expected.md")) {
    throw new Error("audit_memory_use did not report missing expected memory");
  }
  if (mismatchAuditRecord.observed_summary_preview.includes("sk-proj-example-secret-token-12345")) {
    throw new Error("audit_memory_use leaked raw observed summary secret text");
  }

  const ghostTask = parseTool(
    await client.callTool({
      name: "start_task",
      arguments: {
        request: "Smoke test unfinished audit rejection",
        project: "dinobrain",
        mode: "standard",
        sensitivity: "normal",
      },
    }),
  );
  let unfinishedRejected = false;
  try {
    const unfinishedAudit = parseTool(
      await client.callTool({
        name: "audit_memory_use",
        arguments: {
          task_id: ghostTask.task_id,
          observed_summary: "This should fail because the task has not produced a finished trace.",
        },
      }),
    );
    unfinishedRejected = unfinishedAudit.ok === false;
  } catch {
    unfinishedRejected = true;
  }
  if (!unfinishedRejected) {
    throw new Error("audit_memory_use accepted an unfinished task without a trace");
  }

  writeFileSync(
    path.join(tempDataRoot, ".dino", "traces", "unfinished-audit.json"),
    `${JSON.stringify(
      {
        task_id: "unfinished-audit",
        outcome: "started",
        summary: "This trace exists but is not a finished task trace.",
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  let unfinishedTraceRejected = false;
  try {
    const unfinishedTraceAudit = parseTool(
      await client.callTool({
        name: "audit_memory_use",
        arguments: {
          trace_path: ".dino/traces/unfinished-audit.json",
          observed_summary: "This should fail because the trace has no finished_at and terminal outcome.",
        },
      }),
    );
    unfinishedTraceRejected = unfinishedTraceAudit.ok === false;
  } catch {
    unfinishedTraceRejected = true;
  }
  if (!unfinishedTraceRejected) {
    throw new Error("audit_memory_use accepted a non-terminal trace");
  }

  const hallucinatedTracePath = path.join(tempDataRoot, ".dino", "traces", "hallucinated-audit.json");
  writeFileSync(
    hallucinatedTracePath,
    `${JSON.stringify(
      {
        task_id: "hallucinated-audit",
        outcome: "completed",
        summary: "This trace claims a ghost memory was used.",
        used_memory_paths: ["20_Wiki/Ghost-Memory.md"],
        context_pack_paths: [contextPack.trace_path],
        finished_at: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  const hallucinatedAudit = parseTool(
    await client.callTool({
      name: "audit_memory_use",
      arguments: {
        trace_path: ".dino/traces/hallucinated-audit.json",
        observed_summary: "The ghost memory was supposedly used.",
        auditor: "smoke-test",
      },
    }),
  );
  const hallucinatedAuditRecord = JSON.parse(readFileSync(path.join(tempDataRoot, hallucinatedAudit.audit_path), "utf8"));
  if (!hallucinatedAuditRecord.hallucinated_memory_reference?.includes("20_Wiki/Ghost-Memory.md")) {
    throw new Error("audit_memory_use did not flag a missing declared memory path");
  }

  const gitSync = parseTool(
    await client.callTool({
      name: "git_sync",
      arguments: {
        include_sensitive_scan: true,
      },
    }),
  );
  if (gitSync.dry_run !== true || gitSync.would_commit !== false || gitSync.would_push !== false) {
    throw new Error("git_sync did not stay in dry-run mode");
  }
  if (gitSync.commit_allowed_by_tool !== false || gitSync.manual_approval_required !== true) {
    throw new Error("git_sync did not require manual approval");
  }
  const syncFiles = new Map(gitSync.files.map((file) => [file.path, file]));
  const syncableFile = syncFiles.get("20_Wiki/Syncable-Change.md");
  if (!syncableFile || syncableFile.classification !== "syncable") {
    throw new Error("git_sync did not classify syncable Wiki change correctly");
  }
  const conditionalFile = syncFiles.get("80_Review_Queue/review-needed.md");
  if (!conditionalFile || conditionalFile.classification !== "conditional") {
    throw new Error("git_sync did not classify review queue change as conditional");
  }
  const blockedPathFile = syncFiles.get(".dino/secrets.json");
  if (!blockedPathFile || blockedPathFile.classification !== "blocked") {
    throw new Error("git_sync did not block local-only secrets path");
  }
  const blockedAdmissionReceipt = syncFiles.get(".dino/review-admissions/2026-07/decision.json");
  if (!blockedAdmissionReceipt || blockedAdmissionReceipt.classification !== "blocked") {
    throw new Error("git_sync did not block local review admission receipt");
  }
  const sensitivePatternFile = syncFiles.get("20_Wiki/Sensitive-Pattern.md");
  if (
    !sensitivePatternFile ||
    sensitivePatternFile.classification !== "blocked" ||
    sensitivePatternFile.sensitive_patterns.length < 1
  ) {
    throw new Error("git_sync did not block sensitive pattern");
  }

  const autoSync = parseTool(
    await client.callTool({
      name: "auto_sync",
      arguments: {
        include_sensitive_scan: true,
        allow_conditional: true,
        push: false,
        commit_message: "data: smoke auto sync allowed DinoBrain records",
      },
    }),
  );
  if (autoSync.ok !== true || autoSync.committed !== true || autoSync.pushed !== false) {
    throw new Error(`auto_sync did not commit allowed records without push: ${JSON.stringify(autoSync)}`);
  }
  if (!Array.isArray(autoSync.skipped_paths) || !autoSync.skipped_paths.some((file) => file.path === ".dino/secrets.json")) {
    throw new Error("auto_sync did not skip blocked local-only data");
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        data_root: tempDataRoot,
        tools: names,
        task_path: start.task_path,
        trace_path: finish.trace_path,
        context_trace_path: contextPack.trace_path,
        candidate_path: candidate.candidate_path,
        accepted_path: review.accepted_path,
        quarantine_path: quarantine.quarantine_path,
        memory_audit_path: memoryAudit.audit_path,
        memory_audit_score: memoryAudit.trust_score,
        context_items: contextPack.item_count,
        search_results: search.result_count,
        git_sync_changed_files: gitSync.changed_file_count,
        auto_sync_commit: autoSync.commit,
      },
      null,
      2,
    ),
  );
} finally {
  await client.close();
}
