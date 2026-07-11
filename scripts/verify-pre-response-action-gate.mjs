import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const serverPath = path.join(root, "dist", "index.js");
const hookPath = path.join(root, "scripts", "dinobrain-user-prompt-hook.mjs");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function seedVault(dataRoot) {
  for (const relative of [
    "10_Conversations/raw",
    "20_Wiki",
    "50_Instances/accepted",
    "50_Instances/candidates",
    "60_Operations",
    "80_Review_Queue/promotion",
    ".dino/tasks",
    ".dino/traces",
    ".dino/context-packs",
    ".dino/events",
    ".dino/gates",
  ]) {
    mkdirSync(path.join(dataRoot, relative), { recursive: true });
  }
  writeFileSync(
    path.join(dataRoot, "20_Wiki", "Pre-Response-Action-Policy.md"),
    [
      "---",
      "title: Pre-Response Action Policy",
      "summary: DinoBrain verifies context bytes, event order, tool presence, sensitivity, and sync state before action.",
      "tags: [pre-response, action-gate, fail-closed]",
      "source_status: internal",
      "confidence: high",
      "last_verified: 2026-07-11",
      "---",
      "",
      "# Pre-Response Action Policy",
      "",
      "Safe assistance is distinct from persistence, synchronization, and destructive operations.",
      "",
    ].join("\n"),
    "utf8",
  );
  execFileSync("git", ["init"], { cwd: dataRoot, stdio: "ignore", windowsHide: true });
  execFileSync("git", ["config", "user.email", "dinobrain-verifier@example.invalid"], {
    cwd: dataRoot,
    stdio: "ignore",
    windowsHide: true,
  });
  execFileSync("git", ["config", "user.name", "DinoBrain Verifier"], {
    cwd: dataRoot,
    stdio: "ignore",
    windowsHide: true,
  });
  execFileSync("git", ["add", "20_Wiki/Pre-Response-Action-Policy.md"], {
    cwd: dataRoot,
    stdio: "ignore",
    windowsHide: true,
  });
  execFileSync("git", ["commit", "-m", "seed gate fixture"], {
    cwd: dataRoot,
    stdio: "ignore",
    windowsHide: true,
  });
}

async function connect(dataRoot, extraEnv = {}) {
  const client = new Client({ name: "dinobrain-pre-response-gate-verifier", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath],
    env: {
      ...process.env,
      DINOBRAIN_DATA_DIR: dataRoot,
      DINOBRAIN_AUTO_GROWTH: "0",
      DINOBRAIN_AUTO_COMPOUND: "0",
      DINOBRAIN_AUTO_SYNC: "0",
      ...extraEnv,
    },
    stderr: "pipe",
  });
  await client.connect(transport);
  return client;
}

function parseTool(result) {
  const text = result.content?.find((part) => part.type === "text")?.text;
  assert(text, "MCP tool returned no text");
  if (result.isError) throw new Error(text);
  return JSON.parse(text);
}

async function call(client, name, args) {
  return parseTool(await client.callTool({ name, arguments: args }));
}

function readEvents(dataRoot) {
  const eventDir = path.join(dataRoot, ".dino", "events");
  if (!existsSync(eventDir)) return [];
  return readdirSync(eventDir)
    .filter((file) => file.endsWith(".jsonl"))
    .sort()
    .flatMap((file) =>
      readFileSync(path.join(eventDir, file), "utf8")
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => JSON.parse(line)),
    );
}

function filesUnder(dir) {
  if (!existsSync(dir)) return [];
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...filesUnder(fullPath));
    else files.push(fullPath);
  }
  return files;
}

function assertSecretAbsent(dataRoot, secret) {
  for (const filePath of filesUnder(dataRoot)) {
    if (filePath.includes(`${path.sep}.git${path.sep}`)) continue;
    const text = readFileSync(filePath, "utf8");
    assert(!text.includes(secret), `Sensitive value leaked into ${filePath}`);
  }
}

async function finish(client, begin, summary) {
  if (begin.record?.status !== "started") return;
  await call(client, "finish_task", {
    task_id: begin.task_id,
    lease_id: begin.lease.lease_id,
    summary,
    outcome: "completed",
    growth_policy: "trace_only",
    changed_files: [],
    decisions: [],
    next_steps: [],
    used_memory_paths: begin.context_pack?.items?.map((item) => item.path) ?? [],
    context_pack_paths: begin.context_pack?.trace_path ? [begin.context_pack.trace_path] : [],
  });
}

function runHook(dataRoot, reportRoot, options = {}) {
  const input = {
    hookEventName: "UserPromptSubmit",
    prompt: options.prompt ?? "Analyze the verified pre-response action policy and report the result.",
    cwd: root,
    session_id: "gate-verifier-session",
    turn_id: options.turnId ?? "gate-verifier-turn",
  };
  const run = spawnSync(process.execPath, [hookPath], {
    cwd: root,
    input: JSON.stringify(input),
    encoding: "utf8",
    env: {
      ...process.env,
      DINOBRAIN_DATA_DIR: dataRoot,
      DINOBRAIN_HOOK_REPORT_DIR: reportRoot,
      DINOBRAIN_HOOK_IMPORT_SESSION: options.importSession ?? "0",
      DINOBRAIN_HOOK_AUTO_SYNC: options.autoSync ?? "0",
      DINOBRAIN_HOOK_LAUNCH_PROVENANCE: JSON.stringify({
        launch_kind: "verification_fixture",
        launch_kind_source: "gate_verifier",
      }),
    },
    timeout: 60_000,
    windowsHide: true,
  });
  assert(run.status === 0, `Hook fixture failed: ${run.stderr}`);
  const output = JSON.parse(run.stdout.trim());
  return { output, context: output.hookSpecificOutput?.additionalContext ?? "" };
}

async function main() {
  assert(existsSync(serverPath), "dist/index.js is missing; run npm run build first");
  const roots = [];
  const clients = [];
  const makeRoot = (name) => {
    const dataRoot = mkdtempSync(path.join(tmpdir(), `dinobrain-${name}-`));
    roots.push(dataRoot);
    seedVault(dataRoot);
    return dataRoot;
  };

  try {
    const normalRoot = makeRoot("gate-normal");
    const normalClient = await connect(normalRoot);
    clients.push(normalClient);
    const normal = await call(normalClient, "os_begin_task", {
      request: "Analyze the verified pre-response action policy.",
      project: "gate-verifier",
      sensitivity: "normal",
    });
    assert(normal.action_decision === "allow" && normal.fail_closed === false, "Safe preflight was not allowed");
    assert(normal.context_evidence?.contextTraceVerified === true, "Context bytes were not independently verified");
    assert(normal.context_evidence?.contextTraceFresh === true, "Fresh context was not recognized");
    assert(normal.preflight_evidence?.eventOrderVerified === true, "Direct MCP event order was not verified");

    const unknownSensitivity = await call(normalClient, "os_begin_task", {
      request: "Write a local analysis summary without syncing it.",
      project: "gate-verifier",
    });
    assert(unknownSensitivity.fail_closed === false, "Unknown sensitivity incorrectly blocked safe local work");
    assert(unknownSensitivity.action_decision === "constrained_action", "Unknown sensitivity was not constrained");
    assert(unknownSensitivity.gates.some((gate) => gate.id === "sensitivity_unknown"), "Unknown sensitivity reason is missing");
    await finish(normalClient, unknownSensitivity, "Unknown-sensitivity constrained action verified.");

    const fallbackStart = await call(normalClient, "start_task", {
      request: "Verify the explicit start-task Context Pack fallback.",
      project: "gate-verifier",
      sensitivity: "normal",
    });
    const fallbackPack = await call(normalClient, "get_context_pack", {
      question: "Verify the explicit start-task Context Pack fallback.",
      task_id: fallbackStart.task_id,
      limit: 7,
    });
    const fallbackGate = await call(normalClient, "os_gate", {
      request: "Verify the explicit start-task Context Pack fallback.",
      task_id: fallbackStart.task_id,
      context_pack_path: fallbackPack.trace_path,
      has_context_pack: true,
      context_item_count: fallbackPack.item_count,
      sensitivity: "normal",
    });
    assert(fallbackGate.action_decision === "allow", "Explicit start/get-context fallback did not pass the independent gate");
    assert(
      fallbackGate.preflight_event_order?.includes("manual_preflight_context_ready"),
      "Fallback gate did not verify its manual preflight completion event",
    );
    await finish(normalClient, { ...fallbackStart, context_pack: fallbackPack }, "Manual preflight fallback verified.");

    const forged = await call(normalClient, "os_gate", {
      request: "Continue normal analysis with a forged context declaration.",
      task_id: normal.task_id,
      context_pack_path: ".dino/context-packs/forged.json",
      has_context_pack: true,
      context_item_count: 999,
      sensitivity: "normal",
    });
    assert(forged.fail_closed === true, "Forged context did not fail closed");
    assert(forged.context_verification_status === "unbound", "Forged context was not identified as unbound");
    assert(forged.context_declaration_mismatch === true, "Forged declaration mismatch was not recorded");

    unlinkSync(path.join(normalRoot, normal.context_pack.trace_path));
    const missingTrace = await call(normalClient, "os_gate", {
      request: "Continue after the Context Pack trace disappeared.",
      task_id: normal.task_id,
      sensitivity: "normal",
    });
    assert(missingTrace.fail_closed === true, "Missing Context Pack trace did not fail closed");
    assert(missingTrace.context_verification_status === "missing", "Missing trace status was not reported");

    const staleRoot = makeRoot("gate-stale");
    const staleClient = await connect(staleRoot, { DINOBRAIN_GATE_CONTEXT_MAX_AGE_SECONDS: "1" });
    clients.push(staleClient);
    const staleBegin = await call(staleClient, "os_begin_task", {
      request: "Analyze pre-response freshness evidence.",
      sensitivity: "normal",
    });
    await new Promise((resolve) => setTimeout(resolve, 1_250));
    const stale = await call(staleClient, "os_gate", {
      request: "Continue with the old pre-response proof.",
      task_id: staleBegin.task_id,
      sensitivity: "normal",
    });
    assert(stale.fail_closed === true, "Stale Context Pack proof did not fail closed");
    assert(stale.gates.some((gate) => gate.id === "context_trace_stale"), "Stale trace reason code is missing");

    const missingToolRoot = makeRoot("gate-missing-tool");
    const missingToolClient = await connect(missingToolRoot, { DINOBRAIN_DISABLED_OS_TOOLS: "wiki_search" });
    clients.push(missingToolClient);
    const exposed = (await missingToolClient.listTools()).tools.map((tool) => tool.name);
    assert(!exposed.includes("wiki_search"), "Missing-tool fixture still exposed wiki_search");
    const missingTool = await call(missingToolClient, "os_begin_task", {
      request: "Analyze tool availability before work.",
      sensitivity: "normal",
    });
    assert(missingTool.fail_closed === true, "Missing required tool did not fail closed");
    assert(missingTool.gates.some((gate) => gate.id === "required_tool_missing:wiki_search"), "Missing tool reason absent");
    assert(missingTool.record?.status === "blocked" && missingTool.trace_path, "Blocked preflight was not auto-terminal");

    const sensitiveRoot = makeRoot("gate-sensitive");
    const sensitiveClient = await connect(sensitiveRoot);
    clients.push(sensitiveClient);
    const secret = ["sk", "-", "test-sensitive-", "012345678901234567890123456789"].join("");
    const safeSensitive = await call(sensitiveClient, "os_begin_task", {
      request: `Explain how to rotate api_key: ${secret} without retaining the value.`,
      sensitivity: "normal",
    });
    assert(safeSensitive.action_decision === "constrained_action", "Safe sensitive assistance was not constrained");
    assert(safeSensitive.fail_closed === false, "Safe sensitive assistance was fully blocked");
    assert(safeSensitive.persistence_policy === "metadata_only_no_growth", "Sensitive assistance persistence policy is wrong");
    assertSecretAbsent(sensitiveRoot, secret);
    await finish(sensitiveClient, safeSensitive, "Sensitive rotation guidance completed without persistence.");

    const blockedSensitive = await call(sensitiveClient, "os_begin_task", {
      request: `Store api_key: ${secret} in the memory vault for later use.`,
      sensitivity: "normal",
    });
    assert(blockedSensitive.fail_closed === true, "Sensitive persistence request was not blocked");
    assert(blockedSensitive.gates.some((gate) => gate.id === "sensitive_persistence_blocked"), "Sensitive block reason absent");
    assert(blockedSensitive.record?.status === "blocked" && blockedSensitive.trace_path, "Sensitive block was not auto-terminal");
    assertSecretAbsent(sensitiveRoot, secret);

    const destructiveRoot = makeRoot("gate-destructive");
    const destructiveClient = await connect(destructiveRoot);
    clients.push(destructiveClient);
    const destructive = await call(destructiveClient, "os_begin_task", {
      request: "Delete all data and run git reset --hard.",
      sensitivity: "normal",
    });
    assert(destructive.fail_closed === true, "Destructive request did not fail closed");
    assert(destructive.gates.some((gate) => gate.id === "destructive_action_risk"), "Destructive reason absent");
    assert(destructive.record?.status === "blocked" && destructive.trace_path, "Destructive block was not auto-terminal");

    const syncRoot = makeRoot("gate-sync");
    const syncClient = await connect(syncRoot);
    clients.push(syncClient);
    const syncBlocked = await call(syncClient, "os_begin_task", {
      request: "Sync the DinoBrain data repo to GitHub and push the memory vault now.",
      sensitivity: "normal",
    });
    assert(syncBlocked.fail_closed === true, "Blocked data sync did not fail closed");
    assert(syncBlocked.sync_observation?.status === "blocked", "OS did not independently observe blocked sync paths");
    assert(syncBlocked.gates.some((gate) => gate.id === "sync_policy_blocked"), "Blocked sync reason absent");

    const scopedRoot = makeRoot("gate-scoped-sync");
    const scopedClient = await connect(scopedRoot);
    clients.push(scopedClient);
    const scopedBegin = await call(scopedClient, "os_begin_task", {
      request: "Prepare one exact task-scoped publication proof.",
      project: "gate-verifier",
      sensitivity: "normal",
    });
    writeFileSync(path.join(scopedRoot, ".dino", "events", "unrelated-private-backlog.jsonl"), "{}\n", "utf8");
    const scopedAllowed = await call(scopedClient, "os_gate", {
      request: "Sync the DinoBrain data repo to GitHub using the exact task allowlist.",
      task_id: scopedBegin.task_id,
      context_pack_path: scopedBegin.context_pack.trace_path,
      has_context_pack: true,
      context_item_count: scopedBegin.context_pack.item_count,
      sensitivity: "normal",
      allowed_paths: [scopedBegin.task_path],
      allow_conditional: true,
    });
    assert(scopedAllowed.fail_closed === false, "Verified task-scoped sync was blocked by unrelated backlog");
    assert(scopedAllowed.sync_observation?.scope === "task_scope", "Scoped sync observation did not identify its scope");
    assert(scopedAllowed.sync_observation?.status === "clean", "Verified task scope was not clean");
    assert(scopedAllowed.sync_observation?.selected_path_count === 1, "Scoped sync selected the wrong path count");
    assert(scopedAllowed.sync_observation?.out_of_scope_changed_count > 0, "Unrelated backlog was not observed out of scope");
    const scopedRejected = await call(scopedClient, "os_gate", {
      request: "Sync the DinoBrain data repo to GitHub using an unregistered path.",
      task_id: scopedBegin.task_id,
      context_pack_path: scopedBegin.context_pack.trace_path,
      has_context_pack: true,
      context_item_count: scopedBegin.context_pack.item_count,
      sensitivity: "normal",
      allowed_paths: ["20_Wiki/unregistered.md"],
      allow_conditional: true,
    });
    assert(scopedRejected.fail_closed === true, "Unregistered task-scoped path did not fail closed");
    assert(scopedRejected.sync_observation?.scope === "task_scope", "Rejected scope lost task-scope evidence");
    assert(scopedRejected.gates.some((gate) => gate.id === "sync_policy_blocked"), "Unregistered scope block reason absent");
    await finish(scopedClient, scopedBegin, "Task-scoped sync gate verified.");

    const hookRoot = makeRoot("gate-hook-order");
    const reportRoot = path.join(hookRoot, "hook-reports");
    const hook = runHook(hookRoot, reportRoot);
    assert(hook.output.decision !== "block", "Safe ordered hook was blocked");
    assert(hook.context.includes("preflight_event_order_verified: true"), "Hook context lacks order proof");
    assert(hook.context.includes("context_delivery_nonce:"), "Hook context lacks delivery nonce");
    const events = readEvents(hookRoot);
    const names = ["codex_prompt_submitted", "task_started", "context_pack_created", "os_begin_task_completed", "codex_preflight_completed"];
    const indexes = names.map((name) => events.findIndex((event) => event.event === name));
    assert(indexes.every((index) => index >= 0), "Hook delivery event chain is incomplete");
    assert(indexes.every((index, position) => position === 0 || index > indexes[position - 1]), "Hook delivery events are out of order");
    const completed = events[indexes[indexes.length - 1]];
    assert(completed.context_delivery_status === "ready_for_model", "Hook completed before context was ready");
    assert(completed.preflight_event_order_verified === true, "Hook final event lacks verified order");
    assert(
      completed.context_delivery_sha256 === createHash("sha256").update(hook.context).digest("hex"),
      "Hook output hash does not match final delivery event",
    );

    const sensitiveHookRoot = makeRoot("gate-hook-sensitive");
    const sensitiveReportRoot = path.join(sensitiveHookRoot, "hook-reports");
    const hookSecret = ["ghp", "_", "testSensitive012345678901234567890123456789"].join("");
    const sensitiveHook = runHook(sensitiveHookRoot, sensitiveReportRoot, {
      prompt: `Explain how to rotate token: ${hookSecret} without retaining it.`,
      turnId: "gate-verifier-sensitive-turn",
      importSession: "1",
      autoSync: "1",
    });
    assert(sensitiveHook.output.decision !== "block", "Safe sensitive hook assistance was fully blocked");
    assert(sensitiveHook.context.includes("action_decision: constrained_action"), "Sensitive hook was not constrained");
    const sensitiveReportFile = readdirSync(sensitiveReportRoot).find((file) => file.endsWith(".json"));
    assert(sensitiveReportFile, "Sensitive hook report is missing");
    const sensitiveReport = JSON.parse(readFileSync(path.join(sensitiveReportRoot, sensitiveReportFile), "utf8"));
    assert(
      sensitiveReport.session_import?.reason === "sensitive_metadata_only_policy",
      "Sensitive hook unexpectedly imported the prompt session",
    );
    assert(
      sensitiveReport.auto_sync?.reason === "sensitive_metadata_only_policy",
      "Sensitive hook unexpectedly attempted automatic sync",
    );
    assert(readdirSync(path.join(sensitiveHookRoot, "10_Conversations", "raw")).length === 0, "Sensitive hook wrote a raw archive");
    assert(readdirSync(path.join(sensitiveHookRoot, "50_Instances", "candidates")).length === 0, "Sensitive hook created memory candidates");
    assertSecretAbsent(sensitiveHookRoot, hookSecret);

    console.log(
      JSON.stringify(
        {
          ok: true,
          safe_action: normal.action_decision,
          unknown_sensitivity_constrained: true,
          manual_start_context_gate_fallback: true,
          forged_context_blocked: true,
          missing_trace_blocked: true,
          stale_trace_blocked: true,
          missing_required_tool_blocked: true,
          safe_sensitive_assistance: safeSensitive.action_decision,
          sensitive_persistence_blocked: true,
          destructive_action_blocked: true,
          observed_sync_blocked: true,
          verified_task_scoped_sync_allowed: true,
          unrelated_sync_backlog_excluded: true,
          unregistered_task_scope_blocked: true,
          hook_event_order: names,
          hook_context_delivery_verified: true,
          sensitive_hook_growth_and_sync_skipped: true,
        },
        null,
        2,
      ),
    );
  } finally {
    for (const client of clients) await client.close().catch(() => undefined);
    for (const dataRoot of roots) rmSync(dataRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
