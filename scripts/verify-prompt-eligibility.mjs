import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const serverPath = path.join(root, "dist", "index.js");
const hookPath = path.join(root, "scripts", "dinobrain-user-prompt-hook.mjs");
const { classifyPromptLaunch, makePromptIdentityHash } = await import(
  pathToFileURL(path.join(root, "dist", "prompt-eligibility.js")).href
);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function parseTool(result) {
  const text = result.content?.find((part) => part.type === "text")?.text;
  assert(text, "MCP tool returned no text");
  if (result.isError) throw new Error(text);
  return JSON.parse(text);
}

function files(dataRoot, relativeDir) {
  const dir = path.join(dataRoot, ...relativeDir.split("/"));
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((name) => name.endsWith(".json"));
}

function seedVault(dataRoot) {
  for (const dir of [
    "20_Wiki",
    "30_Sources",
    "40_Projects",
    "50_Instances/accepted",
    "60_Operations",
    "70_Error_Book",
    ".dino/tasks",
    ".dino/traces",
    ".dino/context-packs",
    ".dino/events",
  ]) {
    mkdirSync(path.join(dataRoot, ...dir.split("/")), { recursive: true });
  }
  writeFileSync(
    path.join(dataRoot, "20_Wiki", "Prompt-Eligibility.md"),
    `---
title: Prompt Eligibility
summary: Only real user-interactive prompts create durable DinoBrain tasks.
tags: [prompt, eligibility, lifecycle]
source_status: internal
confidence: high
last_verified: 2026-07-10
---

# Prompt Eligibility

Internal title, ambient, diagnostic, and service work stays out of durable task memory.
`,
    "utf8",
  );
}

async function connect(dataRoot) {
  const client = new Client({ name: "dinobrain-prompt-eligibility-verifier", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath],
    cwd: root,
    env: {
      ...process.env,
      DINOBRAIN_DATA_DIR: dataRoot,
      DINOBRAIN_AUTO_COMPOUND: "0",
      DINOBRAIN_AUTO_GROWTH: "0",
      DINOBRAIN_AUTO_SYNC: "0",
      DINOBRAIN_SEMANTIC_EMBEDDINGS: "0",
    },
    stderr: "pipe",
  });
  await client.connect(transport);
  return client;
}

function runHook(dataRoot, reportRoot, input, launchKind = "verification_fixture") {
  const result = spawnSync(process.execPath, [hookPath], {
    cwd: root,
    input: `${JSON.stringify(input)}\n`,
    encoding: "utf8",
    env: {
      ...process.env,
      DINOBRAIN_DATA_DIR: dataRoot,
      DINOBRAIN_HOOK_REPORT_DIR: reportRoot,
      DINOBRAIN_HOOK_LAUNCH_KIND: launchKind,
      DINOBRAIN_HOOK_IMPORT_SESSION: "0",
      DINOBRAIN_HOOK_AUTO_SYNC: "0",
      DINOBRAIN_AUTO_COMPOUND: "0",
      DINOBRAIN_AUTO_GROWTH: "0",
      DINOBRAIN_AUTO_SYNC: "0",
      DINOBRAIN_SEMANTIC_EMBEDDINGS: "0",
    },
  });
  assert(result.status === 0, `Hook failed: ${result.stderr}`);
  const output = JSON.parse(result.stdout.trim());
  return { output, context: output.hookSpecificOutput?.additionalContext ?? "" };
}

const titlePrompt =
  "You are a helpful assistant. You will be presented with a user prompt, and your job is to provide a short title for a task that will be created from that prompt. Generate a concise UI title (up to 36 characters).";
const ambientPrompt =
  "# Overview\n\nGenerate 0 to 3 hyperpersonalized suggestions for what this user can do with Codex in this local project. Optimize for relief: choose suggestions that make the user's life easier.";
const internalPrompt =
  "## Memory Writing Agent: Phase 2 (Consolidation)\n\nConsolidate raw memories and rollout summaries into a local agent memory folder.";

async function main() {
  for (const [request, expected] of [
    [titlePrompt, "title_generation"],
    [ambientPrompt, "ambient_suggestion"],
    [internalPrompt, "internal_codex_service"],
    ["DinoBrain installer hook handshake", "diagnostic_probe"],
  ]) {
    const launchKind = expected === "diagnostic_probe" ? "installer_handshake" : "codex_desktop";
    const result = classifyPromptLaunch({ request, launchKind });
    assert(result.classification === expected, `Expected ${expected}, got ${result.classification}`);
    assert(result.durable_task_eligible === false, `${expected} was durable-task eligible`);
  }
  const interactive = classifyPromptLaunch({ request: "Fix prompt task deduplication", launchKind: "codex_desktop" });
  assert(interactive.classification === "user_interactive", "Interactive prompt was not classified as user work");
  assert(interactive.durable_task_eligible === true, "Interactive prompt was filtered");

  const mcpRoot = mkdtempSync(path.join(tmpdir(), "dinobrain-prompt-eligibility-mcp-"));
  const hookRoot = mkdtempSync(path.join(tmpdir(), "dinobrain-prompt-eligibility-hook-"));
  const reportRoot = path.join(hookRoot, "hook-reports");
  seedVault(mcpRoot);
  seedVault(hookRoot);
  let client;
  let secondClient;
  try {
    client = await connect(mcpRoot);
    for (const [request, expected, launchKind] of [
      [titlePrompt, "title_generation", "codex_desktop"],
      [ambientPrompt, "ambient_suggestion", "codex_desktop"],
      [internalPrompt, "internal_codex_service", "codex_desktop"],
      ["DinoBrain installer hook handshake", "diagnostic_probe", "installer_handshake"],
    ]) {
      const result = parseTool(
        await client.callTool({
          name: "os_begin_task",
          arguments: { request, launch_kind: launchKind, launch_source: "eligibility_regression" },
        }),
      );
      assert(result.skipped === true, `${expected} MCP launch was not skipped`);
      assert(result.prompt_classification === expected, `${expected} MCP classification mismatch`);
      assert(result.durable_task_created === false, `${expected} MCP launch created a durable task`);
    }
    assert(files(mcpRoot, ".dino/tasks").length === 0, "Filtered MCP launches created task files");
    assert(files(mcpRoot, ".dino/context-packs").length === 0, "Filtered MCP launches created Context Packs");

    secondClient = await connect(mcpRoot);
    const userRequest = "Implement prompt eligibility without polluting durable memory";
    const promptHash = createHash("sha256").update(userRequest).digest("hex");
    const hookRunId = "turn-user-1";
    const clientSessionId = "session-user-1";
    const dedupeKey = makePromptIdentityHash({ hookRunId, promptHash, clientSessionId });
    const beginArguments = {
      request: userRequest,
      project: "dinobrain",
      launch_kind: "direct_mcp",
      hook_run_id: hookRunId,
      client_session_id: clientSessionId,
      prompt_hash: promptHash,
      dedupe_key: dedupeKey,
      owner_id: "verifier-owner",
      sensitivity: "normal",
    };
    const [begin, duplicateBegin] = await Promise.all([
      client.callTool({ name: "os_begin_task", arguments: beginArguments }).then(parseTool),
      secondClient.callTool({ name: "os_begin_task", arguments: beginArguments }).then(parseTool),
    ]);
    assert(begin.task_id === duplicateBegin.task_id, "Concurrent stable MCP starts produced different tasks");
    assert(begin.context_pack.trace_path === duplicateBegin.context_pack.trace_path, "Concurrent starts produced duplicate Context Packs");
    assert(begin.idempotent === true || duplicateBegin.idempotent === true, "Concurrent duplicate did not reuse server receipt");
    assert(begin.task_id && begin.lease?.lease_id, "Interactive MCP launch did not create a leased task");
    assert(files(mcpRoot, ".dino/tasks").length === 1, "Interactive MCP launch did not create exactly one task");

    const wrongHeartbeat = await client.callTool({
      name: "heartbeat_task",
      arguments: { task_id: begin.task_id, lease_id: "wrong-lease", extend_seconds: 600 },
    });
    assert(wrongHeartbeat.isError === true, "Wrong task heartbeat lease was accepted");
    const heartbeat = parseTool(
      await client.callTool({
        name: "heartbeat_task",
        arguments: { task_id: begin.task_id, lease_id: begin.lease.lease_id, extend_seconds: 600 },
      }),
    );
    assert(heartbeat.lease?.state === "active", "Correct task heartbeat did not renew the lease");

    const finishArguments = {
      task_id: begin.task_id,
      summary: "Prompt eligibility MCP regression completed.",
      outcome: "completed",
      growth_policy: "trace_only",
      changed_files: [],
      decisions: ["Filter non-user Codex service launches before durable task creation."],
      next_steps: [],
      used_memory_paths: begin.context_pack.items.map((item) => item.path),
      context_pack_paths: [begin.context_pack.trace_path],
    };
    const wrongFinish = await client.callTool({
      name: "finish_task",
      arguments: { ...finishArguments, lease_id: "wrong-lease" },
    });
    assert(wrongFinish.isError === true, "Wrong finish-task lease was accepted");
    const finished = parseTool(
      await client.callTool({
        name: "finish_task",
        arguments: { ...finishArguments, lease_id: begin.lease.lease_id },
      }),
    );
    assert(finished.trace_path, "Correct finish-task lease did not create a trace");
    const repeatedFinish = parseTool(
      await client.callTool({
        name: "finish_task",
        arguments: { ...finishArguments, lease_id: begin.lease.lease_id },
      }),
    );
    assert(repeatedFinish.idempotent === true, "Repeated terminal write was not idempotent");
    assert(files(mcpRoot, ".dino/traces").length === 1, "Repeated finish created more than one trace");
    await client.close();
    client = null;
    await secondClient.close();
    secondClient = null;

    const stableInput = {
      hookEventName: "UserPromptSubmit",
      prompt: "Use DinoBrain memory to implement one durable user task.",
      cwd: root,
      session_id: "hook-session-1",
      turn_id: "hook-turn-1",
    };
    const firstHook = runHook(hookRoot, reportRoot, stableInput);
    assert(firstHook.context.includes("DinoBrain OS preflight completed for this Codex prompt"), "First user hook missed preflight");
    const secondHook = runHook(hookRoot, reportRoot, stableInput);
    assert(secondHook.context.includes("another matching DinoBrain hook"), "Repeated hook did not reuse its durable receipt");
    assert(files(hookRoot, ".dino/tasks").length === 1, "Repeated hook created duplicate tasks");
    assert(files(hookRoot, ".dino/context-packs").length === 1, "Repeated hook created duplicate Context Packs");

    for (const [prompt, expected, launchKind, turnId] of [
      [titlePrompt, "title_generation", "codex_desktop", "filtered-title"],
      [ambientPrompt, "ambient_suggestion", "codex_desktop", "filtered-ambient"],
      [internalPrompt, "internal_codex_service", "codex_desktop", "filtered-internal"],
      ["DinoBrain installer hook handshake", "diagnostic_probe", "installer_handshake", "filtered-diagnostic"],
    ]) {
      const result = runHook(
        hookRoot,
        reportRoot,
        { ...stableInput, prompt, turn_id: turnId },
        launchKind,
      );
      assert(result.context.includes(`prompt_classification: ${expected}`), `${expected} hook classification missing`);
      assert(result.context.includes("durable_task_created: false"), `${expected} hook did not report zero durable task`);
    }
    assert(files(hookRoot, ".dino/tasks").length === 1, "Filtered hook launches polluted durable tasks");
    assert(files(hookRoot, ".dino/context-packs").length === 1, "Filtered hook launches polluted Context Packs");
    const receiptDir = path.join(hookRoot, ".dino", "tmp", "hook-receipts");
    assert(existsSync(receiptDir) && readdirSync(receiptDir).length === 5, "Stable hook receipts were not recorded once per turn");

    const task = JSON.parse(readFileSync(path.join(hookRoot, ".dino", "tasks", files(hookRoot, ".dino/tasks")[0]), "utf8"));
    assert(task.prompt_classification === "user_interactive", "Durable hook task lacks user-interactive classification");
    assert(task.lease?.lease_id, "Durable hook task lacks lease ownership");

    console.log(
      JSON.stringify(
        {
          ok: true,
          filtered_classes: ["title_generation", "ambient_suggestion", "internal_codex_service", "diagnostic_probe"],
          filtered_mcp_task_count: 0,
          durable_hook_task_count: files(hookRoot, ".dino/tasks").length,
          durable_hook_pack_count: files(hookRoot, ".dino/context-packs").length,
          duplicate_hook_idempotent: true,
          duplicate_mcp_start_idempotent: true,
          lease_heartbeat_enforced: true,
          terminal_owner_enforced: true,
          repeated_finish_idempotent: true,
        },
        null,
        2,
      ),
    );
  } finally {
    if (client) await client.close().catch(() => undefined);
    if (secondClient) await secondClient.close().catch(() => undefined);
    rmSync(mcpRoot, { recursive: true, force: true });
    rmSync(hookRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
