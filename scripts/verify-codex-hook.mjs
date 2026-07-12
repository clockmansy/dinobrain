import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const serverPath = path.join(root, "dist", "index.js");
const hookConfigPath = path.join(root, ".codex", "hooks.json");
const nodeHookPath = path.join(root, "scripts", "dinobrain-user-prompt-hook.mjs");
const psHookPath = path.join(root, "scripts", "dinobrain-user-prompt-hook.ps1");
const reportPath = path.resolve(process.env.DINOBRAIN_HOOK_VERIFY_OUT ?? path.join(root, "reports", "dinobrain-codex-hook-verify.json"));

function assert(condition, message) {
  if (!condition) throw new Error(message);
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
    path.join(dataRoot, "20_Wiki", "Codex-Hook-Protocol.md"),
    `---
title: Codex Hook Protocol
summary: DinoBrain should observe Codex prompts through UserPromptSubmit, start a task, create a Context Pack, and inject subordinate memory into the agent turn.
tags: [codex, hook, dinobrain, context-pack]
source_status: internal
confidence: high
last_verified: 2026-07-01
---

# Codex Hook Protocol

The live Codex bridge starts a task, retrieves focused memory, and records visible OS events for the Observatory.
`,
    "utf8",
  );
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

function parseHookOutput(stdout) {
  const trimmed = stdout.trim();
  try {
    return JSON.parse(trimmed);
  } catch (error) {
    const nearby = trimmed.slice(780, 900).replace(/\s+/g, " ");
    throw new Error(`Hook returned invalid JSON: ${error.message}; nearby=${nearby}`);
  }
}

function runHook(input, dataRoot, reportRoot) {
  const env = {
    ...process.env,
    DINOBRAIN_DATA_DIR: dataRoot,
    DINOBRAIN_HOOK_REPORT_DIR: reportRoot,
    DINOBRAIN_HOOK_CONTEXT_LIMIT: "5",
    DINOBRAIN_HOOK_SESSION_MAX_CANDIDATES: "8",
    DINOBRAIN_HOOK_PROJECT: "dinobrain-hook-verify",
    DINOBRAIN_NODE_EXE: process.execPath,
    DINOBRAIN_HOOK_LAUNCH_KIND: "verification_fixture",
  };

  if (process.platform === "win32" && existsSync(psHookPath)) {
    return spawnSync(
      "powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", psHookPath],
      {
        cwd: root,
        env,
        input,
        encoding: "utf8",
        windowsHide: true,
      },
    );
  }

  return spawnSync(process.execPath, [nodeHookPath], {
    cwd: root,
    env,
    input,
    encoding: "utf8",
    windowsHide: true,
  });
}

function powershellCommand() {
  const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
  const candidate = path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  return existsSync(candidate) ? candidate : "powershell.exe";
}

function runPowerShellHookWithoutNode(input, dataRoot, reportRoot) {
  assert(process.platform === "win32", "PowerShell wrapper no-node verification is Windows-only.");
  const fakeLocalAppData = mkdtempSync(path.join(tmpdir(), "dinobrain-no-node-localappdata-"));
  const env = {
    ...process.env,
    DINOBRAIN_DATA_DIR: dataRoot,
    DINOBRAIN_HOOK_REPORT_DIR: reportRoot,
    DINOBRAIN_HOOK_CONTEXT_LIMIT: "5",
    DINOBRAIN_HOOK_PROJECT: "dinobrain-hook-verify-no-node",
    DINOBRAIN_NODE_EXE: path.join(fakeLocalAppData, "missing-node.exe"),
    LOCALAPPDATA: fakeLocalAppData,
    Path: "",
    PATH: "",
  };

  return spawnSync(
    powershellCommand(),
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", psHookPath],
    {
      cwd: root,
      env,
      input,
      encoding: "utf8",
      windowsHide: true,
    },
  );
}

function runPowerShellHookTimeout(input, dataRoot, reportRoot) {
  assert(process.platform === "win32", "PowerShell wrapper timeout verification is Windows-only.");
  const processMarker = `dinobrain-hook-timeout-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const env = {
    ...process.env,
    DINOBRAIN_DATA_DIR: dataRoot,
    DINOBRAIN_HOOK_REPORT_DIR: reportRoot,
    DINOBRAIN_HOOK_PROJECT: "dinobrain-hook-timeout-verify",
    DINOBRAIN_NODE_EXE: process.execPath,
    DINOBRAIN_HOOK_LAUNCH_KIND: "verification_fixture",
    DINOBRAIN_HOOK_IMPORT_SESSION: "0",
    DINOBRAIN_HOOK_AUTO_SYNC: "0",
    DINOBRAIN_HOOK_TIMEOUT_SECONDS: "1",
    DINOBRAIN_HOOK_TEST_DELAY_AFTER_CONNECT_MS: "2500",
    DINOBRAIN_HOOK_PROCESS_MARKER: processMarker,
  };
  const result = spawnSync(
    powershellCommand(),
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", psHookPath],
    {
      cwd: root,
      env,
      input,
      encoding: "utf8",
      windowsHide: true,
    },
  );
  return { ...result, processMarker };
}

function runPowerShellHookSoftTimeoutAfterTask(input, dataRoot, reportRoot) {
  assert(process.platform === "win32", "PowerShell wrapper cooperative-timeout verification is Windows-only.");
  const env = {
    ...process.env,
    DINOBRAIN_DATA_DIR: dataRoot,
    DINOBRAIN_HOOK_REPORT_DIR: reportRoot,
    DINOBRAIN_HOOK_PROJECT: "dinobrain-hook-soft-timeout-verify",
    DINOBRAIN_NODE_EXE: process.execPath,
    DINOBRAIN_HOOK_LAUNCH_KIND: "verification_fixture",
    DINOBRAIN_HOOK_IMPORT_SESSION: "0",
    DINOBRAIN_HOOK_AUTO_SYNC: "0",
    DINOBRAIN_HOOK_TIMEOUT_SECONDS: "6",
    DINOBRAIN_HOOK_SOFT_TIMEOUT_MS: "2500",
    DINOBRAIN_HOOK_TEST_DELAY_AFTER_BEGIN_MS: "5000",
  };
  return spawnSync(
    powershellCommand(),
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", psHookPath],
    {
      cwd: root,
      env,
      input,
      encoding: "utf8",
      windowsHide: true,
    },
  );
}

function normalizePowerShellHookOutput(input) {
  assert(process.platform === "win32", "PowerShell output normalization verification is Windows-only.");
  return spawnSync(
    powershellCommand(),
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", psHookPath, "-NormalizeOnly"],
    {
      cwd: root,
      input,
      encoding: "utf8",
      windowsHide: true,
    },
  );
}

function countMarkedNodeProcesses(processMarker) {
  const escaped = processMarker.replace(/'/g, "''");
  const command = [
    `$marker = '${escaped}'`,
    "$count = @(Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -like ('*' + $marker + '*') }).Count",
    "[Console]::Out.Write($count)",
  ].join("; ");
  const result = spawnSync(powershellCommand(), ["-NoProfile", "-Command", command], {
    encoding: "utf8",
    windowsHide: true,
  });
  assert(result.status === 0, `Could not inspect timeout child processes: ${result.stderr}`);
  return Number(result.stdout.trim() || "0");
}

function hookDedupeKey(input, request) {
  const source = JSON.stringify({
    hookEventName: input.hookEventName ?? input.hook_event_name ?? "UserPromptSubmit",
    session_id: input.session_id ?? input.sessionId ?? input.conversation_id ?? input.conversationId ?? "",
    turn_id: input.turn_id ?? input.turnId ?? input.message_id ?? input.messageId ?? "",
    cwd: input.cwd ?? "",
    request,
  });
  return createHash("sha256").update(source).digest("hex").slice(0, 32);
}

async function verifyHook() {
  assert(existsSync(serverPath), "dist/index.js is missing. Run npm run build first.");
  assert(existsSync(hookConfigPath), ".codex/hooks.json is missing.");
  const hookConfig = readJson(hookConfigPath);
  const repoHookText = JSON.stringify(hookConfig.hooks?.UserPromptSubmit ?? []);
  assert(!/dinobrain-user-prompt-hook\.ps1|Loading DinoBrain context/i.test(repoHookText), ".codex/hooks.json must not duplicate the managed DinoBrain hook.");

  const tempDataRoot = mkdtempSync(path.join(tmpdir(), "dinobrain-codex-hook-"));
  const tempReportRoot = path.join(tempDataRoot, "hook-reports");
  seedVault(tempDataRoot);

  const prompt = [
    "사용자가 Codex랑 대화하면 공룡두뇌 OS 상호작용을 실시간으로 보여줘.",
    "I prefer DinoBrain hook work to follow the approved plan.",
    "Decision: use import_session for Codex hook prompt ingest.",
    "How to verify: run hook:verify after build.",
    "If an error happens, record root cause before fix.",
    "Codex hook protocol context pack DinoBrain Observatory.",
    "Attachment: C:/Users/example-user/AppData/Local/Temp/codex-clipboard-proof.png",
  ].join("\n");
  const hookInput = JSON.stringify({
    hookEventName: "UserPromptSubmit",
    prompt,
    cwd: root,
  });

  const run = runHook(hookInput, tempDataRoot, tempReportRoot);
  assert(run.status === 0, `Hook exited with ${run.status}: ${run.stderr}`);
  assert(run.stdout.trim(), "Hook produced no stdout.");

  const output = parseHookOutput(run.stdout);
  const additionalContext = output.hookSpecificOutput?.additionalContext ?? "";
  assert(output.hookSpecificOutput?.hookEventName === "UserPromptSubmit", "Hook output has wrong event name.");
  assert(additionalContext.includes("DinoBrain OS preflight completed"), "Hook did not inject preflight context.");
  assert(additionalContext.includes("Codex-Hook-Protocol.md"), "Hook did not include seeded memory.");
  assert(additionalContext.includes("gate_status:"), "Hook did not inject OS gate status.");
  assert(additionalContext.includes("action_decision: allow"), "Hook did not expose the allow action decision.");
  assert(additionalContext.includes("fail_closed: false"), "Hook did not report non-blocking preflight state.");
  assert(additionalContext.includes("context_trace_verified: true"), "Hook did not expose verified context bytes.");
  assert(additionalContext.includes("context_trace_fresh: true"), "Hook did not expose fresh context evidence.");
  assert(additionalContext.includes("preflight_event_order_verified: true"), "Hook did not expose ordered preflight evidence.");
  assert(additionalContext.includes("session_import:"), "Hook did not report session import status.");
  assert(additionalContext.includes("finish_task.used_memory_paths"), "Hook did not inject structured finish_task protocol.");

  const taskFiles = readdirSync(path.join(tempDataRoot, ".dino", "tasks")).filter((file) => file.endsWith(".json"));
  const packFiles = readdirSync(path.join(tempDataRoot, ".dino", "context-packs")).filter((file) => file.endsWith(".json"));
  const rawSessionFiles = readdirSync(path.join(tempDataRoot, "10_Conversations", "raw")).filter((file) =>
    file.endsWith(".json"),
  );
  const candidateFiles = readdirSync(path.join(tempDataRoot, "50_Instances", "candidates")).filter((file) =>
    file.endsWith(".json"),
  );
  const reviewFiles = readdirSync(path.join(tempDataRoot, "80_Review_Queue", "promotion")).filter((file) =>
    file.endsWith(".json"),
  );
  const reportFiles = readdirSync(tempReportRoot).filter((file) => file.endsWith(".json"));
  assert(taskFiles.length === 1, `Expected 1 task file, found ${taskFiles.length}.`);
  assert(packFiles.length === 1, `Expected 1 context pack, found ${packFiles.length}.`);
  assert(rawSessionFiles.length === 1, `Expected 1 raw session archive, found ${rawSessionFiles.length}.`);
  assert(candidateFiles.length >= 3, `Expected extracted hook candidates, found ${candidateFiles.length}.`);
  assert(reviewFiles.length === candidateFiles.length, "Review queue count did not match candidate count.");
  assert(reportFiles.length === 1, `Expected 1 hook report, found ${reportFiles.length}.`);

  const task = readJson(path.join(tempDataRoot, ".dino", "tasks", taskFiles[0]));
  assert(task.sensitivity === "normal", "Normal prompt was incorrectly marked sensitive.");
  assert(task.request.includes("[REDACTED_MACHINE_LOCAL_PATH]"), "Stored task request exposed the attachment path.");
  assert(task.request_redactions?.includes("windows_user_path"), "Stored task did not record its path redaction.");
  assert(task.supplied_prompt_hash_matches === true, "Attachment redaction changed the preflight identity hash.");
  assert(task.prompt_hash === task.request_hash, "Task prompt identity diverged from the original request hash.");
  assert(task.task_id.includes(task.prompt_hash.slice(0, 28)), "Task id is not bound to the original prompt identity.");

  const pack = readJson(path.join(tempDataRoot, ".dino", "context-packs", packFiles[0]));
  assert(
    pack.items.some((item) => item.path === "20_Wiki/Codex-Hook-Protocol.md"),
    "Context Pack trace missed seeded hook protocol memory.",
  );

  const rawSession = readJson(path.join(tempDataRoot, "10_Conversations", "raw", rawSessionFiles[0]));
  assert(rawSession.sync_policy === "local_only", "Hook session archive is not local-only.");
  assert(rawSession.storage_policy?.raw_full_transcript_stored === false, "Hook session stored full raw transcript.");
  assert(rawSession.extraction?.candidate_count === candidateFiles.length, "Raw session extraction count is inconsistent.");

  const candidates = candidateFiles.map((file) => readJson(path.join(tempDataRoot, "50_Instances", "candidates", file)));
  assert(
    candidates.every((candidate) => ["pending_review", "held"].includes(candidate.status)),
    "Hook candidate bypassed review or hold.",
  );
  assert(candidates.every((candidate) => candidate.auto_promote === false), "Hook candidate allowed auto promotion.");
  assert(
    candidates.every((candidate) => ["hot", "warm", "cold"].includes(candidate.temperature)),
    "Hook candidate did not get a hot/warm/cold label.",
  );

  const hookReport = readJson(path.join(tempReportRoot, reportFiles[0]));
  assert(hookReport.hook_run_id, "Hook report did not record hook_run_id.");
  assert(hookReport.prompt_hash, "Hook report did not record prompt_hash.");
  assert(hookReport.launch_provenance, "Hook report did not record launch provenance.");
  assert(
    hookReport.launch_provenance.launch_kind !== "codex_desktop",
    "Synthetic hook verification was incorrectly labeled as codex_desktop.",
  );
  assert(hookReport.session_import?.archive_path, "Hook report did not record session archive path.");
  assert(hookReport.session_import?.candidate_count === candidateFiles.length, "Hook report candidate count mismatch.");
  assert(hookReport.context_delivery_status === "ready_for_model", "Hook report was finalized before context delivery was ready.");
  assert(hookReport.preflight_event_order_verified === true, "Hook report did not verify preflight ordering.");

  const eventFiles = readdirSync(path.join(tempDataRoot, ".dino", "events")).filter((file) => file.endsWith(".jsonl"));
  const events = eventFiles.flatMap((file) => readJsonl(path.join(tempDataRoot, ".dino", "events", file)));
  for (const eventName of [
    "codex_prompt_submitted",
    "task_started",
    "context_pack_created",
    "os_begin_task_completed",
    "session_imported",
    "codex_preflight_completed",
  ]) {
    assert(events.some((event) => event.event === eventName), `Missing event ${eventName}.`);
  }
  const submittedEvent = events.find((event) => event.event === "codex_prompt_submitted");
  const startedEvent = events.find((event) => event.event === "task_started");
  const completedEvent = events.find((event) => event.event === "codex_preflight_completed");
  assert(submittedEvent?.hook_run_id && submittedEvent.hook_run_id === completedEvent?.hook_run_id, "Hook events did not share hook_run_id.");
  assert(submittedEvent?.prompt_hash && submittedEvent.prompt_hash === completedEvent?.prompt_hash, "Hook events did not share prompt_hash.");
  assert(submittedEvent.prompt_hash === startedEvent?.prompt_hash, "Attachment redaction broke submitted-to-task hash linkage.");
  assert(completedEvent.hook_run_id === hookReport.hook_run_id, "Hook report did not match event hook_run_id.");
  const orderedNames = ["codex_prompt_submitted", "task_started", "context_pack_created", "os_begin_task_completed", "codex_preflight_completed"];
  const orderedIndexes = orderedNames.map((eventName) => events.findIndex((event) => event.event === eventName));
  assert(orderedIndexes.every((index) => index >= 0), "Ordered hook proof is missing an event.");
  assert(orderedIndexes.every((index, position) => position === 0 || index > orderedIndexes[position - 1]), "Hook events are out of order.");
  assert(completedEvent.preflight_event_order_verified === true, "Final hook event did not carry ordered evidence.");
  assert(completedEvent.context_delivery_status === "ready_for_model", "Final hook event was emitted before delivery readiness.");
  assert(
    completedEvent.context_delivery_sha256 === createHash("sha256").update(additionalContext).digest("hex"),
    "Final hook event context hash does not match hook output.",
  );

  const duplicateDataRoot = mkdtempSync(path.join(tmpdir(), "dinobrain-codex-hook-duplicate-"));
  const duplicateReportRoot = path.join(duplicateDataRoot, "hook-reports");
  seedVault(duplicateDataRoot);
  const duplicatePrompt = "Duplicate hook lock must fail closed without a verified sibling preflight report.";
  const duplicateInput = {
    hookEventName: "UserPromptSubmit",
    prompt: duplicatePrompt,
    cwd: root,
  };
  const duplicateKey = hookDedupeKey(duplicateInput, duplicatePrompt);
  const lockDir = path.join(duplicateDataRoot, ".dino", "hook-locks");
  mkdirSync(lockDir, { recursive: true });
  writeFileSync(
    path.join(lockDir, `${duplicateKey}.json`),
    `${JSON.stringify({ at: new Date().toISOString(), key: duplicateKey, cwd: root })}\n`,
    "utf8",
  );
  const duplicateRun = runHook(JSON.stringify(duplicateInput), duplicateDataRoot, duplicateReportRoot);
  assert(duplicateRun.status === 0, `Duplicate hook exited with ${duplicateRun.status}: ${duplicateRun.stderr}`);
  const duplicateOutput = parseHookOutput(duplicateRun.stdout);
  const duplicateContext = duplicateOutput.hookSpecificOutput?.additionalContext ?? "";
  assert(duplicateContext.includes("DEGRADED NON-BLOCKING"), "Duplicate hook lock did not emit degraded continuation context.");
  assert(duplicateOutput.decision !== "block", "Duplicate hook lock blocked the Codex conversation.");
  assert(!duplicateContext.includes("Use the other injected DinoBrain context"), "Duplicate hook still used the unsafe skip message.");

  if (process.platform === "win32" && existsSync(psHookPath)) {
    const forcedBlockRun = normalizePowerShellHookOutput(
      JSON.stringify({
        decision: "block",
        reason: "simulated regression",
        hookSpecificOutput: {
          hookEventName: "UserPromptSubmit",
          additionalContext: "FAIL-CLOSED: do not perform substantial work.",
        },
      }),
    );
    assert(forcedBlockRun.status === 0, `Blocking-output normalizer exited with ${forcedBlockRun.status}: ${forcedBlockRun.stderr}`);
    const forcedBlockOutput = parseHookOutput(forcedBlockRun.stdout);
    const forcedBlockContext = forcedBlockOutput.hookSpecificOutput?.additionalContext ?? "";
    assert(forcedBlockOutput.decision !== "block", "Final PowerShell boundary preserved a blocking decision.");
    assert(forcedBlockContext.includes("conversation-liveness boundary suppressed it"), "Final boundary did not report block suppression.");
    assert(/continue the current conversation/i.test(forcedBlockContext), "Final boundary did not preserve conversation continuity.");
    assert(!/FAIL[\s-]*CLOSED/i.test(forcedBlockContext), "Final boundary preserved a fail-closed conversation directive.");

    const invalidChildRun = normalizePowerShellHookOutput("not-json");
    assert(invalidChildRun.status === 0, `Invalid-output normalizer exited with ${invalidChildRun.status}: ${invalidChildRun.stderr}`);
    const invalidChildOutput = parseHookOutput(invalidChildRun.stdout);
    const invalidChildContext = invalidChildOutput.hookSpecificOutput?.additionalContext ?? "";
    assert(invalidChildOutput.decision !== "block", "Invalid child output blocked the Codex conversation.");
    assert(invalidChildContext.includes("DEGRADED NON-BLOCKING"), "Invalid child output did not degrade safely.");

    const noNodeDataRoot = mkdtempSync(path.join(tmpdir(), "dinobrain-codex-hook-no-node-"));
    const noNodeReportRoot = path.join(noNodeDataRoot, "hook-reports");
    seedVault(noNodeDataRoot);
    const noNodeRun = runPowerShellHookWithoutNode(
      JSON.stringify({
        hookEventName: "UserPromptSubmit",
        prompt: "This hook run must degrade safely when the PowerShell wrapper cannot locate Node.",
        cwd: root,
      }),
      noNodeDataRoot,
      noNodeReportRoot,
    );
    assert(noNodeRun.status === 0, `No-node wrapper exited with ${noNodeRun.status}: ${noNodeRun.stderr}`);
    const noNodeOutput = parseHookOutput(noNodeRun.stdout);
    const noNodeContext = noNodeOutput.hookSpecificOutput?.additionalContext ?? "";
    assert(noNodeOutput.decision !== "block", "No-node PowerShell wrapper blocked the Codex conversation.");
    assert(noNodeContext.includes("DEGRADED NON-BLOCKING"), "No-node PowerShell wrapper did not emit degraded context.");
    assert(/continue ordinary conversation/i.test(noNodeContext), "No-node wrapper did not preserve conversation continuity.");

    const timeoutDataRoot = mkdtempSync(path.join(tmpdir(), "dinobrain-codex-hook-timeout-"));
    const timeoutReportRoot = path.join(timeoutDataRoot, "hook-reports");
    seedVault(timeoutDataRoot);
    const timeoutRun = runPowerShellHookTimeout(
      JSON.stringify({
        hookEventName: "UserPromptSubmit",
        prompt: "This hook run must degrade safely when preflight exceeds the wrapper timeout.",
        cwd: root,
      }),
      timeoutDataRoot,
      timeoutReportRoot,
    );
    assert(timeoutRun.status === 0, `Timeout wrapper exited with ${timeoutRun.status}: ${timeoutRun.stderr}`);
    const timeoutOutput = parseHookOutput(timeoutRun.stdout);
    const timeoutContext = timeoutOutput.hookSpecificOutput?.additionalContext ?? "";
    assert(timeoutOutput.decision !== "block", "Timed-out PowerShell wrapper blocked the Codex conversation.");
    assert(timeoutContext.includes("timed out after 1 seconds"), "Timed-out wrapper did not expose its timeout reason.");
    assert(timeoutContext.includes("DEGRADED NON-BLOCKING"), "Timed-out wrapper did not emit degraded context.");
    assert(countMarkedNodeProcesses(timeoutRun.processMarker) === 0, "Timed-out hook left its MCP Node child running.");
    const timeoutTaskDir = path.join(timeoutDataRoot, ".dino", "tasks");
    assert(!existsSync(timeoutTaskDir) || readdirSync(timeoutTaskDir).length === 0, "Timed-out hook created a durable task.");

    const softTimeoutDataRoot = mkdtempSync(path.join(tmpdir(), "dinobrain-codex-hook-soft-timeout-"));
    const softTimeoutReportRoot = path.join(softTimeoutDataRoot, "hook-reports");
    seedVault(softTimeoutDataRoot);
    const softTimeoutRun = runPowerShellHookSoftTimeoutAfterTask(
      JSON.stringify({
        hookEventName: "UserPromptSubmit",
        prompt: "This hook run creates a task, then must cooperatively terminalize it before the hard timeout.",
        cwd: root,
      }),
      softTimeoutDataRoot,
      softTimeoutReportRoot,
    );
    assert(softTimeoutRun.status === 0, `Cooperative timeout wrapper exited with ${softTimeoutRun.status}: ${softTimeoutRun.stderr}`);
    const softTimeoutOutput = parseHookOutput(softTimeoutRun.stdout);
    const softTimeoutContext = softTimeoutOutput.hookSpecificOutput?.additionalContext ?? "";
    assert(softTimeoutOutput.decision !== "block", "Cooperative timeout blocked the Codex conversation.");
    assert(softTimeoutContext.includes("cooperative timeout"), "Cooperative timeout reason was not exposed.");
    assert(softTimeoutContext.includes("timeout_cleanup: settled=1, failed=0"), "Cooperative timeout did not report exact task cleanup.");
    const softTimeoutTaskDir = path.join(softTimeoutDataRoot, ".dino", "tasks");
    const softTimeoutTaskFiles = readdirSync(softTimeoutTaskDir).filter((file) => file.endsWith(".json"));
    assert(softTimeoutTaskFiles.length === 1, `Expected one cooperative-timeout task, found ${softTimeoutTaskFiles.length}.`);
    const softTimeoutTask = readJson(path.join(softTimeoutTaskDir, softTimeoutTaskFiles[0]));
    assert(softTimeoutTask.status === "blocked", "Cooperative timeout left its task active.");
    assert(softTimeoutTask.lease?.state === "terminal", "Cooperative timeout left its task lease active.");
    assert(
      existsSync(path.join(softTimeoutDataRoot, ".dino", "traces", `${softTimeoutTask.task_id}.json`)),
      "Cooperative timeout did not write a terminal trace.",
    );
  }

  return {
    ok: true,
    generated_at: new Date().toISOString(),
    temp_data_root: tempDataRoot,
    hook_config: path.relative(root, hookConfigPath).split(path.sep).join("/"),
    used_wrapper: process.platform === "win32" && existsSync(psHookPath),
    conversation_liveness_boundary_verified: process.platform !== "win32" || existsSync(psHookPath),
    task_path: `.dino/tasks/${taskFiles[0]}`,
    context_pack_path: `.dino/context-packs/${packFiles[0]}`,
    session_archive_path: `10_Conversations/raw/${rawSessionFiles[0]}`,
    session_candidate_count: candidateFiles.length,
    hook_report: path.join(tempReportRoot, reportFiles[0]),
    event_names: events.map((event) => event.event),
    injected_context_preview: additionalContext.slice(0, 600),
  };
}

verifyHook()
  .then(async (report) => {
    const reportWithPath = { ...report, report_path: reportPath };
    await fs.mkdir(path.dirname(reportPath), { recursive: true });
    await fs.writeFile(reportPath, `${JSON.stringify(reportWithPath, null, 2)}\n`, "utf8");
    console.log(JSON.stringify(reportWithPath, null, 2));
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
