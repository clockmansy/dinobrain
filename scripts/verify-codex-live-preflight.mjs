import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataRoot = path.resolve(process.env.DINOBRAIN_DATA_DIR ?? path.join(root, "..", "dinobrain-data"));
const liveReportRoot = path.resolve(process.env.DINOBRAIN_HOOK_REPORT_DIR ?? path.join(root, "reports", "live-hooks"));
const codexConfigPath = path.resolve(
  process.env.DINOBRAIN_CODEX_CONFIG_PATH ?? path.join(homedir(), ".codex", "config.toml"),
);
const codexHooksPath = path.resolve(process.env.DINOBRAIN_CODEX_HOOKS_PATH ?? path.join(homedir(), ".codex", "hooks.json"));
const programData = process.env.ProgramData || "C:\\ProgramData";
const codexRequirementsPath = path.resolve(
  process.env.DINOBRAIN_CODEX_REQUIREMENTS_PATH ?? path.join(programData, "OpenAI", "Codex", "requirements.toml"),
);
const serverPath = path.join(root, "dist", "index.js");

function argValue(name, fallback = "") {
  const prefix = `--${name}=`;
  const match = process.argv.find((arg) => arg.startsWith(prefix));
  if (match) return match.slice(prefix.length);
  const index = process.argv.indexOf(`--${name}`);
  if (index >= 0) return process.argv[index + 1] ?? fallback;
  return fallback;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
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

function filesUnder(dir, suffix) {
  if (!existsSync(dir)) return [];
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const filePath = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...filesUnder(filePath, suffix));
    if (entry.isFile() && entry.name.endsWith(suffix)) files.push(filePath);
  }
  return files;
}

function sinceDate(value) {
  if (!value) return new Date(Date.now() - 10 * 60 * 1000);
  const parsed = new Date(value);
  assert(!Number.isNaN(parsed.getTime()), `Invalid --since value: ${value}`);
  return parsed;
}

function includesSnippet(value, snippet) {
  if (!snippet) return true;
  return String(value ?? "").toLowerCase().includes(snippet.toLowerCase());
}

function isCodexDesktopLaunch(record) {
  return record?.launch_provenance?.launch_kind === "codex_desktop";
}

function decodeUuidV7Timestamp(threadId) {
  const match = String(threadId ?? "").match(/^([0-9a-f]{8})-([0-9a-f]{4})-/i);
  if (!match) return null;
  const millis = Number.parseInt(`${match[1]}${match[2]}`, 16);
  if (!Number.isSafeInteger(millis) || millis <= 0) return null;
  const createdAt = new Date(millis);
  return Number.isNaN(createdAt.getTime()) ? null : createdAt;
}

function loadThreadDiagnostics() {
  const currentThreadId = process.env.CODEX_THREAD_ID ?? "";
  const currentThreadCreatedAt = decodeUuidV7Timestamp(currentThreadId);
  const hooksLastWrite = existsSync(codexHooksPath) ? statSync(codexHooksPath).mtime : null;
  const requirementsLastWrite = existsSync(codexRequirementsPath) ? statSync(codexRequirementsPath).mtime : null;
  const promptHookLastWrite =
    hooksLastWrite && requirementsLastWrite
      ? new Date(Math.max(hooksLastWrite.getTime(), requirementsLastWrite.getTime()))
      : (hooksLastWrite ?? requirementsLastWrite);
  const sessionIndexPath = path.join(homedir(), ".codex", "session_index.jsonl");
  const globalStatePath = path.join(homedir(), ".codex", ".codex-global-state.json");
  const globalState = existsSync(globalStatePath) ? readJson(globalStatePath) : null;
  const projectlessThreadIds = new Set(
    Array.isArray(globalState?.["projectless-thread-ids"]) ? globalState["projectless-thread-ids"] : [],
  );
  const workspaceRootHints =
    globalState?.["thread-workspace-root-hints"] && typeof globalState["thread-workspace-root-hints"] === "object"
      ? globalState["thread-workspace-root-hints"]
      : {};
  const recentThreads = [];

  if (existsSync(sessionIndexPath)) {
    const lines = readFileSync(sessionIndexPath, "utf8").split(/\r?\n/).filter(Boolean).slice(-200);
    for (const line of lines) {
      try {
        const record = JSON.parse(line);
        const createdAt = decodeUuidV7Timestamp(record.id);
        recentThreads.push({
          id: record.id,
          thread_name: record.thread_name ?? null,
          created_at: createdAt?.toISOString() ?? null,
          updated_at: record.updated_at ?? null,
          created_after_hooks: Boolean(createdAt && promptHookLastWrite && createdAt >= promptHookLastWrite),
          projectless: projectlessThreadIds.has(record.id),
          workspace_root_hint: workspaceRootHints[record.id] ?? null,
        });
      } catch {
        // Advisory only: a corrupt local index row should not hide live hook evidence.
      }
    }
  }
  const recentThreadsAfterHooks = recentThreads.filter((thread) => thread.created_after_hooks);
  const latestThreadAfterHooks = recentThreadsAfterHooks.at(-1) ?? null;
  const freshProjectlessThreads = recentThreadsAfterHooks.filter((thread) => thread.projectless);
  const freshProjectThreads = recentThreadsAfterHooks.filter((thread) => !thread.projectless);

  return {
    ok: true,
    current_thread_id: currentThreadId || null,
    current_thread_created_at: currentThreadCreatedAt?.toISOString() ?? null,
    hooks_last_write: hooksLastWrite?.toISOString() ?? null,
    requirements_last_write: requirementsLastWrite?.toISOString() ?? null,
    prompt_hook_last_write: promptHookLastWrite?.toISOString() ?? null,
    current_thread_stale_for_hooks: Boolean(
      currentThreadCreatedAt && promptHookLastWrite && currentThreadCreatedAt < promptHookLastWrite,
    ),
    recent_thread_count: recentThreads.length,
    recent_threads_after_hooks_count: recentThreadsAfterHooks.length,
    fresh_projectless_thread_count: freshProjectlessThreads.length,
    fresh_project_thread_count: freshProjectThreads.length,
    latest_thread_after_hooks: latestThreadAfterHooks,
    recent_threads_after_hooks: recentThreadsAfterHooks.slice(-10),
    recent_threads: recentThreads.slice(-10),
  };
}

function parseTomlFeatureHooks() {
  if (!existsSync(codexConfigPath)) {
    return { ok: false, config_path: codexConfigPath, reason: "config_not_found" };
  }
  const text = readFileSync(codexConfigPath, "utf8");
  const featuresStart = text.indexOf("[features]");
  if (featuresStart < 0) {
    return { ok: false, config_path: codexConfigPath, reason: "features_section_missing" };
  }
  const bodyStart = text.indexOf("\n", featuresStart);
  const body = bodyStart < 0 ? "" : text.slice(bodyStart + 1);
  const nextSection = body.search(/^\[/m);
  const featuresBody = nextSection < 0 ? body : body.slice(0, nextSection);
  const match = featuresBody.match(/^hooks\s*=\s*(.+)$/m);
  const hooksValue = match?.[1]?.trim() ?? null;
  return {
    ok: /^true$/i.test(hooksValue ?? ""),
    config_path: codexConfigPath,
    hooks: hooksValue ?? "missing",
    reason: /^true$/i.test(hooksValue ?? "") ? "features_hooks_true" : "features_hooks_not_true",
  };
}

function tomlSection(text, sectionName) {
  const header = `[${sectionName}]`;
  const headerIndex = text.indexOf(header);
  if (headerIndex < 0) return "";
  const bodyStart = text.indexOf("\n", headerIndex);
  if (bodyStart < 0) return "";
  const start = bodyStart + 1;
  const nextSection = text.slice(start).search(/^\[/m);
  const end = nextSection < 0 ? text.length : start + nextSection;
  return text.slice(start, end);
}

function tomlValue(section, key) {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = section.match(new RegExp(`^\\s*${escaped}\\s*=\\s*(.+)$`, "m"));
  return match?.[1]?.trim() ?? null;
}

function tomlString(raw) {
  if (!raw) return "";
  const trimmed = raw.trim();
  if ((trimmed.startsWith("'") && trimmed.endsWith("'")) || (trimmed.startsWith('"') && trimmed.endsWith('"'))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function parseManagedHookRegistration() {
  if (!existsSync(codexRequirementsPath)) {
    return {
      ok: false,
      requirements_path: codexRequirementsPath,
      reason: "requirements_config_not_found",
    };
  }
  const text = readFileSync(codexRequirementsPath, "utf8");
  const hooksSection = tomlSection(text, "hooks");
  const managedDir = tomlString(tomlValue(hooksSection, "windows_managed_dir"));
  const dinobrainManagedHookRegistered =
    /\[\[hooks\.UserPromptSubmit\]\]/.test(text) &&
    /dinobrain-managed-user-prompt-hook\.ps1|dinobrain-user-prompt-hook\.ps1/i.test(text);
  const managedWrapper = managedDir ? path.join(managedDir, "dinobrain-managed-user-prompt-hook.ps1") : null;
  const wrapperExists = managedWrapper ? existsSync(managedWrapper) : false;
  return {
    ok: Boolean(dinobrainManagedHookRegistered && wrapperExists),
    requirements_path: codexRequirementsPath,
    dinobrain_managed_hook_registered: dinobrainManagedHookRegistered,
    managed_dir: managedDir || null,
    managed_wrapper: managedWrapper,
    managed_wrapper_exists: wrapperExists,
    reason: !dinobrainManagedHookRegistered
      ? "dinobrain_managed_user_prompt_hook_not_registered"
      : !wrapperExists
        ? "dinobrain_managed_wrapper_missing"
        : "registered",
  };
}

function parseUserHookRegistration() {
  if (!existsSync(codexHooksPath)) {
    return { ok: false, hooks_path: codexHooksPath, reason: "hooks_config_not_found" };
  }
  let config;
  try {
    config = readJson(codexHooksPath);
  } catch (error) {
    return { ok: false, hooks_path: codexHooksPath, reason: "hooks_config_invalid_json", error: error.message };
  }
  const groups = Array.isArray(config.hooks?.UserPromptSubmit) ? config.hooks.UserPromptSubmit : [];
  const hooks = groups.flatMap((group) => (Array.isArray(group?.hooks) ? group.hooks : []));
  const matchedHook = hooks.find((hook) => /dinobrain-user-prompt-hook\.ps1/i.test(JSON.stringify(hook)));
  const hookState = matchedHook?.state && typeof matchedHook.state === "object" ? matchedHook.state : null;
  const trustedHash = hookState?.trusted_hash ?? matchedHook?.trusted_hash ?? null;
  const stateEnabled = hookState?.enabled ?? matchedHook?.enabled ?? null;
  const trustedHashPresent = typeof trustedHash === "string" && trustedHash.trim().length > 0;
  const disabledByState = stateEnabled === false;
  return {
    ok: Boolean(matchedHook && !disabledByState),
    hooks_path: codexHooksPath,
    user_prompt_submit_group_count: groups.length,
    dinobrain_hook_registered: Boolean(matchedHook),
    command: matchedHook?.command ?? matchedHook?.commandWindows ?? null,
    state_enabled: stateEnabled,
    trust_state_present: Boolean(hookState || trustedHashPresent),
    trusted_hash_present: trustedHashPresent,
    disabled_by_state: disabledByState,
    trust_review_likely_required: Boolean(matchedHook && !trustedHashPresent),
    reason: !matchedHook
      ? "dinobrain_user_prompt_hook_not_registered"
      : disabledByState
        ? "dinobrain_user_prompt_hook_disabled"
        : "registered",
  };
}

function loadProcessDiagnostics() {
  if (process.platform !== "win32") {
    return {
      ok: true,
      platform: process.platform,
      skipped: true,
      reason: "process_diagnostics_windows_only",
    };
  }

  const command = String.raw`
$ErrorActionPreference = "Stop"
$hooksPath = $env:DINOBRAIN_DIAG_HOOKS_PATH
$requirementsPath = $env:DINOBRAIN_DIAG_REQUIREMENTS_PATH
$serverPath = $env:DINOBRAIN_DIAG_SERVER_PATH
$hooksItem = if (Test-Path -LiteralPath $hooksPath) { Get-Item -LiteralPath $hooksPath } else { $null }
$requirementsItem = if (Test-Path -LiteralPath $requirementsPath) { Get-Item -LiteralPath $requirementsPath } else { $null }
$serverItem = if (Test-Path -LiteralPath $serverPath) { Get-Item -LiteralPath $serverPath } else { $null }
$promptHookWriteTime = $null
if ($hooksItem -and $requirementsItem) {
  if ($hooksItem.LastWriteTime -gt $requirementsItem.LastWriteTime) { $promptHookWriteTime = $hooksItem.LastWriteTime } else { $promptHookWriteTime = $requirementsItem.LastWriteTime }
} elseif ($hooksItem) {
  $promptHookWriteTime = $hooksItem.LastWriteTime
} elseif ($requirementsItem) {
  $promptHookWriteTime = $requirementsItem.LastWriteTime
}
$codexProcesses = @(
  Get-Process -ErrorAction SilentlyContinue |
    Where-Object { $_.ProcessName -match "^(Codex|OpenAI\.Codex|codex)$" } |
    ForEach-Object {
      $start = $null
      try { $start = $_.StartTime } catch {}
      [ordered]@{
        name = $_.ProcessName
        id = $_.Id
        start_time = if ($start) { $start.ToUniversalTime().ToString("o") } else { $null }
        stale_for_hooks = [bool]($promptHookWriteTime -and $start -and $start -lt $promptHookWriteTime)
      }
    }
)
$serverNeedle = if ($serverItem) { $serverItem.FullName.ToLowerInvariant().Replace("/", "\") } else { "" }
$mcpProcesses = @(
  if ($serverNeedle) {
    Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
      Where-Object {
        $cmd = [string]$_.CommandLine
        $_.Name -match "^(?i:node(\.exe)?)$" -and $cmd.ToLowerInvariant().Replace("/", "\").Contains($serverNeedle)
      } |
      ForEach-Object {
        $start = $null
        try {
          if ($_.CreationDate -is [datetime]) {
            $start = $_.CreationDate
          } elseif ($_.CreationDate) {
            $start = [System.Management.ManagementDateTimeConverter]::ToDateTime($_.CreationDate)
          }
        } catch {}
        [ordered]@{
          name = $_.Name
          id = $_.ProcessId
          start_time = if ($start) { $start.ToUniversalTime().ToString("o") } else { $null }
          stale_for_server = [bool]($serverItem -and $start -and $start -lt $serverItem.LastWriteTime)
        }
      }
  }
)
[ordered]@{
  ok = $true
  platform = "win32"
  hooks_last_write = if ($hooksItem) { $hooksItem.LastWriteTimeUtc.ToString("o") } else { $null }
  requirements_last_write = if ($requirementsItem) { $requirementsItem.LastWriteTimeUtc.ToString("o") } else { $null }
  prompt_hook_last_write = if ($promptHookWriteTime) { $promptHookWriteTime.ToUniversalTime().ToString("o") } else { $null }
  server_last_write = if ($serverItem) { $serverItem.LastWriteTimeUtc.ToString("o") } else { $null }
  codex_process_count = $codexProcesses.Count
  stale_codex_count = @($codexProcesses | Where-Object { $_.stale_for_hooks }).Count
  mcp_process_count = $mcpProcesses.Count
  stale_mcp_count = @($mcpProcesses | Where-Object { $_.stale_for_server }).Count
  codex_processes = $codexProcesses
  mcp_processes = $mcpProcesses
  approval_command = "powershell -NoProfile -ExecutionPolicy Bypass -File scripts\start-codex-hook-approval.ps1 -RestartStaleCodex -RestartStaleMcp"
} | ConvertTo-Json -Depth 8 -Compress
`;

  try {
    const output = execFileSync("powershell.exe", ["-NoProfile", "-Command", command], {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        DINOBRAIN_DIAG_HOOKS_PATH: codexHooksPath,
        DINOBRAIN_DIAG_REQUIREMENTS_PATH: codexRequirementsPath,
        DINOBRAIN_DIAG_SERVER_PATH: serverPath,
      },
      windowsHide: true,
    });
    return JSON.parse(output);
  } catch (error) {
    return {
      ok: false,
      platform: "win32",
      reason: "process_diagnostics_failed",
      error: String(error?.message ?? error).slice(0, 500),
    };
  }
}

function loadLiveEvents(since) {
  const eventsDir = path.join(dataRoot, ".dino", "events");
  return filesUnder(eventsDir, ".jsonl")
    .flatMap((filePath) =>
      readJsonl(filePath).map((event) => ({
        ...event,
        _path: path.relative(dataRoot, filePath).split(path.sep).join("/"),
      })),
    )
    .filter((event) => {
      const at = new Date(String(event.at ?? ""));
      return !Number.isNaN(at.getTime()) && at >= since;
    })
    .sort((a, b) => String(a.at).localeCompare(String(b.at)));
}

function loadLiveReports(since) {
  return filesUnder(liveReportRoot, ".json")
    .map((filePath) => ({
      ...readJson(filePath),
      _path: path.relative(root, filePath).split(path.sep).join("/"),
    }))
    .filter((report) => {
      const at = new Date(String(report.at ?? ""));
      return !Number.isNaN(at.getTime()) && at >= since;
    })
    .sort((a, b) => String(a.at ?? "").localeCompare(String(b.at ?? "")));
}

function findLatestCompleteLiveProof(events, reports, snippet) {
  const submittedEvents = events
    .filter(
      (event) =>
        event.event === "codex_prompt_submitted" &&
        event.source === "codex_hook" &&
        isCodexDesktopLaunch(event) &&
        includesSnippet(event.prompt_preview, snippet),
    )
    .sort((a, b) => String(b.at ?? "").localeCompare(String(a.at ?? "")));

  for (const submitted of submittedEvents) {
    const completed = events.find(
      (event) =>
        event.event === "codex_preflight_completed" &&
        event.source === "codex_hook" &&
        event.hook_run_id === submitted.hook_run_id &&
        event.prompt_hash === submitted.prompt_hash &&
        isCodexDesktopLaunch(event) &&
        String(event.at ?? "") >= String(submitted.at ?? ""),
    );
    if (!completed) continue;

    const report = reports.find(
      (item) =>
        item.event === "codex_preflight_completed" &&
        item.hook_run_id === completed.hook_run_id &&
        item.prompt_hash === completed.prompt_hash &&
        isCodexDesktopLaunch(item) &&
        String(item.at ?? "") >= String(completed.at ?? "") &&
        typeof item.context_pack_trace === "string" &&
        existsSync(path.join(dataRoot, item.context_pack_trace.replace(/\//g, path.sep))) &&
        Array.isArray(item.context_paths) &&
        item.context_paths.length > 0,
    );
    if (report) return { submitted, completed, report };
  }

  return null;
}

function summarizeLiveProof(proof, since) {
  if (!proof) return null;
  const completedAt = new Date(String(proof.completed.at ?? ""));
  return {
    present: true,
    submitted_at: proof.submitted.at ?? null,
    completed_at: proof.completed.at ?? null,
    report_at: proof.report.at ?? null,
    stale_since: since.toISOString(),
    stale_for_current_window: Number.isFinite(completedAt.getTime()) ? completedAt < since : null,
    hook_run_id: proof.completed.hook_run_id ?? null,
    prompt_hash: proof.completed.prompt_hash ?? null,
    prompt_preview: String(proof.submitted.prompt_preview ?? "").slice(0, 240),
    task_id: proof.completed.task_id ?? proof.report.task_id ?? null,
    context_pack_trace: proof.report.context_pack_trace ?? proof.completed.context_pack_trace ?? null,
    context_item_count: proof.report.context_item_count ?? proof.completed.context_item_count ?? null,
    context_paths: Array.isArray(proof.report.context_paths) ? proof.report.context_paths.slice(0, 20) : [],
    report_path: proof.report._path ?? null,
    event_path: proof.completed._path ?? proof.submitted._path ?? null,
  };
}

function main() {
  const snippet = argValue("snippet", process.env.DINOBRAIN_LIVE_PREFLIGHT_SNIPPET ?? "");
  const since = sinceDate(argValue("since", process.env.DINOBRAIN_LIVE_PREFLIGHT_SINCE ?? ""));
  const requireSnippet = /^(1|true|yes|on)$/i.test(argValue("require-snippet", process.env.DINOBRAIN_LIVE_PREFLIGHT_REQUIRE_SNIPPET ?? "1"));
  assert(snippet || !requireSnippet, "--snippet is required unless --require-snippet=false");

  const hookRuntime = parseTomlFeatureHooks();
  const userHook = parseUserHookRegistration();
  const managedHook = parseManagedHookRegistration();
  const processDiagnostics = loadProcessDiagnostics();
  const threadDiagnostics = loadThreadDiagnostics();
  const events = loadLiveEvents(since);
  const reports = loadLiveReports(since);
  const submitted = events.find(
    (event) =>
      event.event === "codex_prompt_submitted" &&
      event.source === "codex_hook" &&
      isCodexDesktopLaunch(event) &&
      includesSnippet(event.prompt_preview, snippet),
  );
  const completed = submitted
    ? events.find(
        (event) =>
          event.event === "codex_preflight_completed" &&
          event.source === "codex_hook" &&
          event.hook_run_id === submitted.hook_run_id &&
          event.prompt_hash === submitted.prompt_hash &&
          isCodexDesktopLaunch(event) &&
          String(event.at ?? "") >= String(submitted.at ?? ""),
      )
    : null;
  const report = reports.find(
    (item) =>
      item.event === "codex_preflight_completed" &&
      item.hook_run_id === completed?.hook_run_id &&
      item.prompt_hash === completed?.prompt_hash &&
      isCodexDesktopLaunch(item) &&
      String(item.at ?? "") >= String(completed?.at ?? "") &&
      typeof item.context_pack_trace === "string" &&
      existsSync(path.join(dataRoot, item.context_pack_trace.replace(/\//g, path.sep))) &&
      Array.isArray(item.context_paths) &&
      item.context_paths.length > 0,
  );
  const hookRegistered = Boolean(userHook.ok || managedHook.ok);
  const staleProof =
    submitted && completed && report
      ? null
      : summarizeLiveProof(findLatestCompleteLiveProof(loadLiveEvents(new Date(0)), loadLiveReports(new Date(0)), snippet), since);

  const result = {
    ok: Boolean(hookRuntime.ok && hookRegistered && submitted && completed && report),
    generated_at: new Date().toISOString(),
    data_root: dataRoot,
    since: since.toISOString(),
    snippet,
    hook_runtime: hookRuntime,
    user_prompt_hook: userHook,
    managed_prompt_hook: managedHook,
    submitted_event: submitted ?? null,
    completed_event: completed ?? null,
    live_report: report ?? null,
    event_count_after_since: events.length,
    report_count_after_since: reports.length,
    required_launch_kind: "codex_desktop",
    stale_live_proof: staleProof?.stale_for_current_window ? staleProof : null,
    process_diagnostics: processDiagnostics,
    thread_diagnostics: threadDiagnostics,
  };

  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) {
    const reason = !hookRuntime.ok
      ? hookRuntime.reason
      : !hookRegistered
        ? userHook.reason
      : !submitted
        ? managedHook.ok
          ? staleProof?.stale_for_current_window
            ? `DinoBrain managed hook is registered and an older live Codex desktop preflight proof exists at ${staleProof.completed_at}, but no proof was found after ${since.toISOString()}. Paste the proof prompt into a fresh Codex Desktop workspace thread after the latest hook/server update, then rerun this verifier.`
            : `DinoBrain managed hook is registered through requirements.toml, but no live Codex desktop UserPromptSubmit preflight event was found. Restart Codex so it reloads managed requirements, paste the proof prompt into a fresh Codex Desktop workspace thread, then rerun this verifier.`
          : userHook.trust_review_likely_required
          ? `DinoBrain hook is registered but no persisted trusted_hash/state is visible in hooks.json. Codex skips non-managed command hooks until /hooks records trust for the current command hash; approve the DinoBrain UserPromptSubmit hook in /hooks, then paste the proof prompt into a fresh Codex Desktop workspace thread.`
          : processDiagnostics.stale_codex_count > 0
          ? `no live Codex desktop UserPromptSubmit preflight event found; ${processDiagnostics.stale_codex_count} Codex process(es) started before hooks.json was updated. Run: ${processDiagnostics.approval_command}`
          : threadDiagnostics.recent_threads_after_hooks_count > 0
            ? `no live Codex desktop UserPromptSubmit preflight event found; ${threadDiagnostics.recent_threads_after_hooks_count} Codex thread(s) were created after hooks.json was updated, latest=${threadDiagnostics.latest_thread_after_hooks?.id ?? "unknown"} (${threadDiagnostics.latest_thread_after_hooks?.thread_name ?? "untitled"}), but none emitted codex_desktop hook evidence. Do not count delegated/background messages as proof; approve /hooks if prompted and paste the proof prompt manually into a trusted Codex Desktop workspace thread.`
          : threadDiagnostics.current_thread_stale_for_hooks
            ? `no live Codex desktop UserPromptSubmit preflight event found; current thread ${threadDiagnostics.current_thread_id} was created before hooks.json was updated. Start a fresh Codex Desktop thread after approving /hooks, paste the proof prompt, then rerun this verifier.`
            : `no live Codex desktop UserPromptSubmit preflight event found for snippet "${snippet}"`
          : !completed
            ? "no live codex_preflight_completed event found with matching hook_run_id and prompt_hash"
            : "no matching live hook report with hook_run_id, prompt_hash, context paths, and existing Context Pack trace found";
    throw new Error(reason);
  }
}

try {
  main();
} catch (error) {
  console.error(error);
  process.exit(1);
}
