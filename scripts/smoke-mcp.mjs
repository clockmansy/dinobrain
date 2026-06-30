import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

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
writeFileSync(
  path.join(tempDataRoot, "20_Wiki", "Sensitive-Pattern.md"),
  `api_${"key"}: pretend-this-is-sensitive\n`,
  "utf8",
);

spawnSync("git", ["init"], { cwd: tempDataRoot, stdio: "ignore" });

const client = new Client({
  name: "dinobrain-smoke",
  version: "0.1.0",
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
    "create_candidate_instance",
    "finish_task",
    "get_context_pack",
    "git_sync",
    "quarantine_record",
    "review_candidate",
    "start_task",
    "wiki_search",
  ];
  for (const name of expected) {
    if (!names.includes(name)) throw new Error(`Missing tool: ${name}`);
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
        summary: "Smoke test completed.",
        outcome: "completed",
        changed_files: ["src/index.ts", "scripts/smoke-mcp.mjs"],
        decisions: ["Use MCP SDK stdio transport for Phase 2."],
        next_steps: ["Wire the server into a real MCP client configuration."],
      },
    }),
  );
  if (!existsSync(path.join(tempDataRoot, finish.trace_path))) {
    throw new Error(`Missing trace record: ${finish.trace_path}`);
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
  const sensitivePatternFile = syncFiles.get("20_Wiki/Sensitive-Pattern.md");
  if (
    !sensitivePatternFile ||
    sensitivePatternFile.classification !== "blocked" ||
    sensitivePatternFile.sensitive_patterns.length < 1
  ) {
    throw new Error("git_sync did not block sensitive pattern");
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
        context_items: contextPack.item_count,
        search_results: search.result_count,
        git_sync_changed_files: gitSync.changed_file_count,
      },
      null,
      2,
    ),
  );
} finally {
  await client.close();
}
