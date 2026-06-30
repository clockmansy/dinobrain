import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
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
  const expected = ["finish_task", "get_context_pack", "git_sync", "start_task", "wiki_search"];
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

  console.log(
    JSON.stringify(
      {
        ok: true,
        data_root: tempDataRoot,
        tools: names,
        task_path: start.task_path,
        trace_path: finish.trace_path,
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

