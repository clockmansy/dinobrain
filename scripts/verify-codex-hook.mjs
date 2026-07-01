import { spawnSync } from "node:child_process";
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

function filesUnder(dir) {
  const entries = readdirSync(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...filesUnder(fullPath));
    if (entry.isFile()) files.push(fullPath);
  }
  return files;
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

async function verifyHook() {
  assert(existsSync(serverPath), "dist/index.js is missing. Run npm run build first.");
  assert(existsSync(hookConfigPath), ".codex/hooks.json is missing.");
  const hookConfig = readJson(hookConfigPath);
  assert(hookConfig.hooks?.UserPromptSubmit, ".codex/hooks.json does not configure UserPromptSubmit.");

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
    ["api", "_key: ", "sk-", "test000000000000000000000000"].join(""),
  ].join("\n");
  const hookInput = JSON.stringify({
    hookEventName: "UserPromptSubmit",
    prompt,
    cwd: root,
  });

  const run = runHook(hookInput, tempDataRoot, tempReportRoot);
  assert(run.status === 0, `Hook exited with ${run.status}: ${run.stderr}`);
  assert(run.stdout.trim(), "Hook produced no stdout.");
  assert(!run.stdout.includes("sk-test"), "Hook stdout leaked a sensitive prompt token.");

  const output = parseHookOutput(run.stdout);
  const additionalContext = output.hookSpecificOutput?.additionalContext ?? "";
  assert(output.hookSpecificOutput?.hookEventName === "UserPromptSubmit", "Hook output has wrong event name.");
  assert(additionalContext.includes("DinoBrain OS preflight completed"), "Hook did not inject preflight context.");
  assert(additionalContext.includes("Codex-Hook-Protocol.md"), "Hook did not include seeded memory.");
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
  assert(!JSON.stringify(task).includes("sk-test"), "Task record leaked a sensitive prompt token.");
  assert(task.sensitivity === "sensitive", "Sensitive prompt did not mark task sensitivity.");

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
  assert(candidates.every((candidate) => candidate.status === "pending_review"), "Hook candidate bypassed review.");
  assert(candidates.every((candidate) => candidate.auto_promote === false), "Hook candidate allowed auto promotion.");
  assert(
    candidates.every((candidate) => ["hot", "warm", "cold"].includes(candidate.temperature)),
    "Hook candidate did not get a hot/warm/cold label.",
  );

  const hookReport = readJson(path.join(tempReportRoot, reportFiles[0]));
  assert(hookReport.session_import?.archive_path, "Hook report did not record session archive path.");
  assert(hookReport.session_import?.candidate_count === candidateFiles.length, "Hook report candidate count mismatch.");

  const eventFiles = readdirSync(path.join(tempDataRoot, ".dino", "events")).filter((file) => file.endsWith(".jsonl"));
  const events = eventFiles.flatMap((file) => readJsonl(path.join(tempDataRoot, ".dino", "events", file)));
  for (const eventName of [
    "codex_prompt_submitted",
    "task_started",
    "context_pack_created",
    "session_imported",
    "codex_preflight_completed",
  ]) {
    assert(events.some((event) => event.event === eventName), `Missing event ${eventName}.`);
  }

  for (const filePath of filesUnder(tempDataRoot)) {
    const text = readFileSync(filePath, "utf8");
    assert(!text.includes("sk-test000000000000000000000000"), `Sensitive token leaked into ${filePath}.`);
  }

  return {
    ok: true,
    generated_at: new Date().toISOString(),
    temp_data_root: tempDataRoot,
    hook_config: path.relative(root, hookConfigPath).split(path.sep).join("/"),
    used_wrapper: process.platform === "win32" && existsSync(psHookPath),
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
