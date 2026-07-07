import { existsSync, readFileSync, readdirSync } from "node:fs";
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
  return {
    ok: Boolean(matchedHook),
    hooks_path: codexHooksPath,
    user_prompt_submit_group_count: groups.length,
    dinobrain_hook_registered: Boolean(matchedHook),
    command: matchedHook?.command ?? matchedHook?.commandWindows ?? null,
    reason: matchedHook ? "registered" : "dinobrain_user_prompt_hook_not_registered",
  };
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

function main() {
  const snippet = argValue("snippet", process.env.DINOBRAIN_LIVE_PREFLIGHT_SNIPPET ?? "");
  const since = sinceDate(argValue("since", process.env.DINOBRAIN_LIVE_PREFLIGHT_SINCE ?? ""));
  const requireSnippet = /^(1|true|yes|on)$/i.test(argValue("require-snippet", process.env.DINOBRAIN_LIVE_PREFLIGHT_REQUIRE_SNIPPET ?? "1"));
  assert(snippet || !requireSnippet, "--snippet is required unless --require-snippet=false");

  const hookRuntime = parseTomlFeatureHooks();
  const userHook = parseUserHookRegistration();
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

  const result = {
    ok: Boolean(hookRuntime.ok && userHook.ok && submitted && completed && report),
    generated_at: new Date().toISOString(),
    data_root: dataRoot,
    since: since.toISOString(),
    snippet,
    hook_runtime: hookRuntime,
    user_prompt_hook: userHook,
    submitted_event: submitted ?? null,
    completed_event: completed ?? null,
    live_report: report ?? null,
    event_count_after_since: events.length,
    report_count_after_since: reports.length,
    required_launch_kind: "codex_desktop",
  };

  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) {
    const reason = !hookRuntime.ok
      ? hookRuntime.reason
      : !userHook.ok
        ? userHook.reason
        : !submitted
          ? `no live Codex desktop UserPromptSubmit preflight event found for snippet "${snippet}"`
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
