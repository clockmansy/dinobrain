import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const serverPath = path.join(root, "dist", "index.js");
const psHookPath = path.join(root, "scripts", "dinobrain-user-prompt-hook.ps1");
const nodeHookPath = path.join(root, "scripts", "dinobrain-user-prompt-hook.mjs");
const reportPath = path.resolve(
  process.env.DINOBRAIN_CODEX_LOOP_VERIFY_OUT ?? path.join(root, "reports", "dinobrain-codex-closed-loop-verify.json"),
);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? root,
    env: options.env ?? process.env,
    input: options.input,
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with ${result.status}: ${result.stderr || result.stdout}`);
  }
  return result.stdout.trim();
}

function commandExists(command) {
  const result = spawnSync(process.platform === "win32" ? "where.exe" : "sh", process.platform === "win32" ? [command] : ["-lc", `command -v ${command}`], {
    encoding: "utf8",
    windowsHide: true,
  });
  return result.status === 0;
}

function git(cwd, args) {
  return run("git", args, { cwd });
}

function parseHookOutput(stdout) {
  try {
    return JSON.parse(stdout.trim());
  } catch (error) {
    throw new Error(`Hook returned invalid JSON: ${error.message}; stdout=${stdout.slice(0, 500)}`);
  }
}

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function readJsonl(filePath) {
  return readFileSync(filePath, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function seedVault(dataRoot) {
  for (const dir of [
    "00_Home",
    "20_Wiki",
    "30_Sources",
    "40_Projects",
    "10_Conversations/raw",
    "50_Instances/accepted",
    "50_Instances/candidates",
    "60_Operations",
    "70_Error_Book",
    "80_Review_Queue/promotion",
    ".dino",
  ]) {
    mkdirSync(path.join(dataRoot, dir), { recursive: true });
  }

  writeFileSync(
    path.join(dataRoot, "20_Wiki", "Codex-Closed-Loop-Contract.md"),
    `---
title: Codex Closed Loop Contract
summary: Every trusted Codex session must receive DinoBrain pre-response context, declare used memory, finish the task, create growth records, and push policy-approved data.
tags: [codex, closed-loop, pre-response, memory-growth, auto-sync]
source_status: internal
confidence: high
last_verified: 2026-07-07
---

# Codex Closed Loop Contract

Codex work is complete only when the OS preflight runs first, selected memory is visible to the agent, finish_task records the outcome, auto-growth creates durable memory, and auto_sync pushes policy-approved records.
`,
    "utf8",
  );
  writeFileSync(path.join(dataRoot, "README.md"), "# DinoBrain closed loop fixture\n", "utf8");
}

function initGitWithRemote(dataRoot, tempRoot) {
  const remoteRoot = path.join(tempRoot, "remote.git");
  mkdirSync(remoteRoot, { recursive: true });
  run("git", ["init", "--bare", remoteRoot]);
  try {
    git(dataRoot, ["init", "-b", "main"]);
  } catch {
    git(dataRoot, ["init"]);
    git(dataRoot, ["checkout", "-B", "main"]);
  }
  git(dataRoot, ["config", "user.email", "dinobrain-verify@example.invalid"]);
  git(dataRoot, ["config", "user.name", "DinoBrain Verify"]);
  git(dataRoot, ["add", "README.md", "20_Wiki/Codex-Closed-Loop-Contract.md"]);
  git(dataRoot, ["commit", "-m", "seed closed loop fixture"]);
  git(dataRoot, ["remote", "add", "origin", remoteRoot]);
  git(dataRoot, ["push", "-u", "origin", "main"]);
  return remoteRoot;
}

function runHook(input, dataRoot, reportRoot) {
  const env = {
    ...process.env,
    DINOBRAIN_DATA_DIR: dataRoot,
    DINOBRAIN_HOOK_REPORT_DIR: reportRoot,
    DINOBRAIN_HOOK_CONTEXT_LIMIT: "8",
    DINOBRAIN_HOOK_SESSION_MAX_CANDIDATES: "8",
    DINOBRAIN_HOOK_PROJECT: "codex-closed-loop-verify",
    DINOBRAIN_NODE_EXE: process.execPath,
    DINOBRAIN_AUTO_GROWTH: "1",
    DINOBRAIN_AUTO_COMPOUND: "1",
    DINOBRAIN_AUTO_SYNC: "1",
    DINOBRAIN_AUTO_SYNC_ALLOW_CONDITIONAL: "1",
    DINOBRAIN_AUTO_SYNC_PUSH: "1",
    DINOBRAIN_HOOK_AUTO_SYNC: "1",
    DINOBRAIN_HOOK_LAUNCH_KIND: "verification_fixture",
  };

  if (process.platform === "win32" && existsSync(psHookPath)) {
    return spawnSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", psHookPath], {
      cwd: root,
      env,
      input,
      encoding: "utf8",
      windowsHide: true,
    });
  }

  return spawnSync(process.execPath, [nodeHookPath], {
    cwd: root,
    env,
    input,
    encoding: "utf8",
    windowsHide: true,
  });
}

function latestJsonFile(dir) {
  const files = readdirSync(dir)
    .filter((file) => file.endsWith(".json"))
    .map((file) => path.join(dir, file))
    .sort();
  assert(files.length > 0, `No JSON files found in ${dir}`);
  return files.at(-1);
}

async function withClient(dataRoot, callback) {
  const client = new Client({ name: "dinobrain-codex-closed-loop-verify", version: "2.2.1" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath],
    cwd: root,
    env: {
      ...process.env,
      DINOBRAIN_DATA_DIR: dataRoot,
      DINOBRAIN_AUTO_GROWTH: "1",
      DINOBRAIN_AUTO_COMPOUND: "1",
      DINOBRAIN_AUTO_SYNC: "1",
      DINOBRAIN_AUTO_SYNC_ALLOW_CONDITIONAL: "1",
      DINOBRAIN_AUTO_SYNC_PUSH: "1",
    },
    stderr: "pipe",
  });

  try {
    await client.connect(transport);
    return await callback(client);
  } finally {
    await client.close();
  }
}

function parseTool(result) {
  const text = result.content?.find((part) => part.type === "text")?.text;
  assert(text, "Tool did not return text content");
  return JSON.parse(text);
}

function allEvents(dataRoot) {
  const eventsDir = path.join(dataRoot, ".dino", "events");
  return readdirSync(eventsDir)
    .filter((file) => file.endsWith(".jsonl"))
    .flatMap((file) => readJsonl(path.join(eventsDir, file)));
}

function remoteCommitCount(remoteRoot) {
  const count = run("git", [`--git-dir=${remoteRoot}`, "rev-list", "--count", "main"]);
  return Number(count);
}

async function verifyClosedLoop() {
  assert(existsSync(serverPath), "dist/index.js is missing. Run npm run build first.");
  assert(existsSync(nodeHookPath), "DinoBrain Codex node hook is missing.");
  assert(
    commandExists("git"),
    "git is required for verify:codex-loop because the Codex closed loop must prove auto_sync push to a remote repository.",
  );

  const tempRoot = mkdtempSync(path.join(tmpdir(), "dinobrain-codex-loop-"));
  const dataRoot = path.join(tempRoot, "dinobrain-data");
  const reportRoot = path.join(tempRoot, "hook-reports");
  mkdirSync(dataRoot, { recursive: true });
  mkdirSync(reportRoot, { recursive: true });
  seedVault(dataRoot);
  const remoteRoot = initGitWithRemote(dataRoot, tempRoot);
  const initialRemoteCommits = remoteCommitCount(remoteRoot);

  const hookInput = JSON.stringify({
    hookEventName: "UserPromptSubmit",
    prompt:
      "Verify the Codex closed loop. Use DinoBrain memory, do a small proof artifact, finish the task, grow knowledge, and push the data repo.",
    cwd: root,
    session_id: "closed-loop-session",
    turn_id: "turn-1",
  });
  const hookRun = runHook(hookInput, dataRoot, reportRoot);
  assert(hookRun.status === 0, `Hook exited with ${hookRun.status}: ${hookRun.stderr}`);
  assert(hookRun.stdout.trim(), "Hook produced no stdout");
  const hookOutput = parseHookOutput(hookRun.stdout);
  const additionalContext = hookOutput.hookSpecificOutput?.additionalContext ?? "";
  assert(additionalContext.includes("DinoBrain OS preflight completed"), "Codex hook did not complete pre-response OS preflight.");
  assert(additionalContext.includes("Codex-Closed-Loop-Contract.md"), "Codex hook did not inject the seeded memory record.");
  assert(additionalContext.includes("finish_task.used_memory_paths"), "Codex hook did not inject structured finish_task protocol.");

  const hookReport = readJson(latestJsonFile(reportRoot));
  assert(hookReport.task_id, "Hook report missing task_id");
  assert(hookReport.context_pack_trace, "Hook report missing context_pack_trace");
  assert(Array.isArray(hookReport.context_paths), "Hook report missing context_paths");
  assert(
    hookReport.context_paths.includes("20_Wiki/Codex-Closed-Loop-Contract.md"),
    "Hook report did not record the memory path used by preflight.",
  );
  assert(hookReport.auto_sync?.committed === true, "Hook preflight did not auto-commit policy-approved records.");
  assert(hookReport.auto_sync?.pushed === true, "Hook preflight did not push policy-approved records.");

  const proofPath = path.join(dataRoot, "60_Operations", "codex-closed-loop-proof.md");
  writeFileSync(
    proofPath,
    `# Codex Closed Loop Proof

- task_id: ${hookReport.task_id}
- context_pack_trace: ${hookReport.context_pack_trace}
- used_memory: 20_Wiki/Codex-Closed-Loop-Contract.md
- proof: this artifact simulates work performed after pre-response memory injection.
`,
    "utf8",
  );

  const finish = await withClient(dataRoot, async (client) =>
    parseTool(
      await client.callTool({
        name: "finish_task",
        arguments: {
          task_id: hookReport.task_id,
          summary:
            "Verified a Codex closed loop fixture where pre-response hook context was injected, memory was declared, a proof artifact was produced, auto-growth created accepted memory, and auto_sync pushed policy-approved data.",
          outcome: "completed",
          changed_files: ["60_Operations/codex-closed-loop-proof.md"],
          decisions: ["Codex closed-loop verification must prove hook preflight, memory use, finish_task growth, and push in one run."],
          next_steps: ["Keep verify:codex-loop in the release checklist for Codex-only OS guarantees."],
          used_memory_paths: ["20_Wiki/Codex-Closed-Loop-Contract.md"],
          context_pack_paths: [hookReport.context_pack_trace],
          session_archive_paths: hookReport.session_import?.archive_path ? [hookReport.session_import.archive_path] : [],
          candidate_paths: Array.isArray(hookReport.session_import?.candidate_paths)
            ? hookReport.session_import.candidate_paths
            : [],
          search_queries: ["codex closed loop contract"],
        },
      }),
    ),
  );

  assert(finish.ok === true, "finish_task did not complete.");
  assert(finish.growth?.enabled === true, "finish_task did not run auto-growth.");
  assert(finish.growth?.destination === "candidate_review", "auto-growth did not route generated memory through review.");
  assert(finish.growth?.candidate_path, "auto-growth did not create a memory candidate.");
  assert(finish.growth?.review_path, "auto-growth did not create a promotion review record.");
  assert(finish.auto_sync?.committed === true, "finish_task did not auto-commit policy-approved growth records.");
  assert(finish.auto_sync?.pushed === true, "finish_task did not push policy-approved growth records.");

  const trace = readJson(path.join(dataRoot, finish.trace_path));
  assert(trace.used_memory_paths.includes("20_Wiki/Codex-Closed-Loop-Contract.md"), "finish_task trace did not preserve used memory paths.");
  assert(trace.context_pack_paths.includes(hookReport.context_pack_trace), "finish_task trace did not preserve context pack path.");

  assert(existsSync(path.join(dataRoot, finish.growth.candidate_path)), `Growth candidate missing: ${finish.growth.candidate_path}`);
  assert(existsSync(path.join(dataRoot, finish.growth.review_path)), `Growth review missing: ${finish.growth.review_path}`);
  assert(existsSync(path.join(dataRoot, finish.growth.operation_path)), `Growth operation record missing: ${finish.growth.operation_path}`);

  const operationRecord = readJson(path.join(dataRoot, finish.growth.operation_path));
  assert(
    operationRecord.status === "pending_review",
    "Auto-generated operation task summary must not be marked accepted before review.",
  );

  const unreviewedPack = await withClient(dataRoot, async (client) =>
    parseTool(
      await client.callTool({
        name: "get_context_pack",
        arguments: {
          question: "Codex closed-loop generated task memory before explicit review",
          limit: 10,
        },
      }),
    ),
  );
  assert(
    !unreviewedPack.items.some((item) => item.path === finish.growth.operation_path),
    "Unreviewed operation task summary leaked into default Context Pack retrieval.",
  );

  const reviewedGrowth = await withClient(dataRoot, async (client) =>
    parseTool(
      await client.callTool({
        name: "review_candidate",
        arguments: {
          candidate_id: path.basename(finish.growth.candidate_path, ".json"),
          decision: "approve",
          reviewer: "verify-codex-loop",
          notes: "Closed-loop verifier approves the generated task memory after checking evidence metadata.",
        },
      }),
    ),
  );
  assert(reviewedGrowth.accepted_path, "review_candidate did not promote generated memory after explicit approval.");
  const reviewedSync = await withClient(dataRoot, async (client) =>
    parseTool(
      await client.callTool({
        name: "auto_sync",
        arguments: {
          include_sensitive_scan: true,
          allow_conditional: true,
          push: true,
          commit_message: "data: auto sync reviewed Codex loop memory",
        },
      }),
    ),
  );
  assert(reviewedSync.committed === true, "Reviewed generated memory was not auto-committed.");
  assert(reviewedSync.pushed === true, "Reviewed generated memory was not pushed.");

  const reviewedPack = await withClient(dataRoot, async (client) =>
    parseTool(
      await client.callTool({
        name: "get_context_pack",
        arguments: {
          question: "Codex closed-loop generated task memory verified after review",
          limit: 8,
        },
      }),
    ),
  );
  assert(
    reviewedPack.items.some((item) => item.path === reviewedGrowth.accepted_path),
    "Reviewed generated memory was not retrieved by a later Context Pack.",
  );

  const traceOnly = await withClient(dataRoot, async (client) => {
    const start = parseTool(
      await client.callTool({
        name: "start_task",
        arguments: {
          request: "Read-only Codex loop audit should leave only trace records.",
          project: "codex-closed-loop-verify",
          mode: "standard",
          sensitivity: "normal",
        },
      }),
    );
    return parseTool(
      await client.callTool({
        name: "finish_task",
        arguments: {
          task_id: start.task_id,
          summary: "Read-only audit finished without memory promotion or auto-sync push.",
          outcome: "completed",
          growth_policy: "trace_only",
          used_memory_paths: ["20_Wiki/Codex-Closed-Loop-Contract.md"],
        },
      }),
    );
  });
  assert(traceOnly.growth?.enabled === false, "trace_only finish_task still ran auto-growth.");
  assert(traceOnly.growth?.reason === "growth_policy_trace_only", "trace_only finish_task reported the wrong growth skip reason.");
  assert(traceOnly.compounding === null, "trace_only finish_task still ran compounding.");
  assert(traceOnly.auto_sync?.skipped === true, "trace_only finish_task did not skip auto_sync.");

  const events = allEvents(dataRoot);
  for (const eventName of [
    "codex_prompt_submitted",
    "task_started",
    "context_pack_created",
    "os_begin_task_completed",
    "session_imported",
    "codex_preflight_completed",
    "task_finished",
    "auto_growth_records_created",
  ]) {
    assert(events.some((event) => event.event === eventName), `Missing closed-loop event: ${eventName}`);
  }

  const finalRemoteCommits = remoteCommitCount(remoteRoot);
  assert(finalRemoteCommits > initialRemoteCommits, "Remote repository did not receive pushed closed-loop commits.");

  return {
    ok: true,
    generated_at: new Date().toISOString(),
    temp_data_root: dataRoot,
    remote_root: remoteRoot,
    initial_remote_commits: initialRemoteCommits,
    final_remote_commits: finalRemoteCommits,
    hook_task_id: hookReport.task_id,
    hook_context_pack_trace: hookReport.context_pack_trace,
    hook_auto_sync_commit: hookReport.auto_sync.commit,
    finish_trace_path: finish.trace_path,
    finish_growth_paths: finish.growth.created_paths,
    reviewed_growth_path: reviewedGrowth.accepted_path,
    reviewed_growth_auto_sync_commit: reviewedSync.commit,
    finish_auto_sync_commit: finish.auto_sync.commit,
    trace_only_trace_path: traceOnly.trace_path,
    proof_path: "60_Operations/codex-closed-loop-proof.md",
    event_names: events.map((event) => event.event),
    report_path: reportPath,
  };
}

verifyClosedLoop()
  .then(async (report) => {
    await fs.mkdir(path.dirname(reportPath), { recursive: true });
    await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    console.log(JSON.stringify(report, null, 2));
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
