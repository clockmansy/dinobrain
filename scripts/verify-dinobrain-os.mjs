import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const serverPath = path.join(root, "dist", "index.js");
const realDataRoot = path.resolve(process.env.DINOBRAIN_DATA_DIR ?? path.join(root, "..", "dinobrain-data"));
const codexConfigPath = path.resolve(
  process.env.DINOBRAIN_CODEX_CONFIG_PATH ?? path.join(homedir(), ".codex", "config.toml"),
);
const codexHooksPath = path.resolve(process.env.DINOBRAIN_CODEX_HOOKS_PATH ?? path.join(homedir(), ".codex", "hooks.json"));
const requireCodexUserHook = /^(1|true|yes)$/i.test(process.env.DINOBRAIN_REQUIRE_CODEX_USER_HOOK ?? "");
const claudeCommand = process.env.DINOBRAIN_CLAUDE_COMMAND ?? "claude";
const requireClaudeCode = /^(1|true|yes)$/i.test(process.env.DINOBRAIN_REQUIRE_CLAUDE_CODE ?? "");
const claudeSettingsPath = path.resolve(process.env.DINOBRAIN_CLAUDE_SETTINGS_PATH ?? path.join(homedir(), ".claude", "settings.json"));
const requireClaudePromptHook = /^(1|true|yes)$/i.test(process.env.DINOBRAIN_REQUIRE_CLAUDE_PROMPT_HOOK ?? "");
const allowNoGit = /^(1|true|yes)$/i.test(process.env.DINOBRAIN_ALLOW_NO_GIT ?? "");

const expectedTools = [
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
  "review_candidate",
  "start_task",
  "wiki_search",
];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const gitAvailable = commandExists("git");

function parseTool(result) {
  const text = result.content?.find((part) => part.type === "text")?.text;
  assert(text, "Tool did not return text content");
  return JSON.parse(text);
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
  const match = section.match(new RegExp(`^${escaped}\\s*=\\s*(.+)$`, "m"));
  return match?.[1]?.trim() ?? null;
}

function tomlString(raw) {
  if (!raw) return null;
  const trimmed = raw.trim();
  if ((trimmed.startsWith("'") && trimmed.endsWith("'")) || (trimmed.startsWith('"') && trimmed.endsWith('"'))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function tomlStringArray(raw) {
  if (!raw) return [];
  const values = [];
  for (const match of raw.matchAll(/'([^']*)'|"([^"]*)"/g)) {
    values.push(match[1] ?? match[2] ?? "");
  }
  return values;
}

function parseCodexDinoBrainConfig() {
  if (!existsSync(codexConfigPath)) {
    return { registered: false, config_path: codexConfigPath, error: "config_not_found" };
  }

  const text = readFileSync(codexConfigPath, "utf8");
  const serverSection = tomlSection(text, "mcp_servers.dinobrain");
  const envSection = tomlSection(text, "mcp_servers.dinobrain.env");
  if (!serverSection) {
    return { registered: false, config_path: codexConfigPath, error: "dinobrain_mcp_not_registered" };
  }

  const command = tomlString(tomlValue(serverSection, "command"));
  const args = tomlStringArray(tomlValue(serverSection, "args"));
  const env = {};
  for (const line of envSection.split(/\r?\n/)) {
    const match = /^([A-Za-z0-9_]+)\s*=\s*(.+)$/.exec(line.trim());
    if (match) env[match[1]] = tomlString(match[2]) ?? "";
  }

  return {
    registered: true,
    config_path: codexConfigPath,
    command,
    args,
    env,
    command_exists: command ? existsSync(command) : false,
    server_entry_exists: args.some((arg) => existsSync(arg)),
    data_root_exists: env.DINOBRAIN_DATA_DIR ? existsSync(env.DINOBRAIN_DATA_DIR) : false,
  };
}

function parseCodexHookRuntimeConfig() {
  if (!existsSync(codexConfigPath)) {
    return {
      ok: !requireCodexUserHook,
      required: requireCodexUserHook,
      config_path: codexConfigPath,
      reason: "config_not_found",
    };
  }

  const text = readFileSync(codexConfigPath, "utf8");
  const featuresSection = tomlSection(text, "features");
  const hooksFeature = tomlValue(featuresSection, "hooks");
  const hooksDisabled = /^false$/i.test((hooksFeature ?? "").trim());
  const managedOnly = /^\s*allow_managed_hooks_only\s*=\s*true\s*$/im.test(text);
  let reason = "enabled";
  if (hooksDisabled) reason = "features_hooks_false";
  if (managedOnly) reason = "allow_managed_hooks_only_true";

  return {
    ok: (!hooksDisabled && !managedOnly) || !requireCodexUserHook,
    required: requireCodexUserHook,
    config_path: codexConfigPath,
    hooks_feature: hooksFeature ?? "default",
    allow_managed_hooks_only: managedOnly,
    reason,
  };
}

function parseCodexUserHookConfig() {
  if (!existsSync(codexHooksPath)) {
    return {
      ok: !requireCodexUserHook,
      required: requireCodexUserHook,
      registered: false,
      hooks_path: codexHooksPath,
      reason: "hooks_config_not_found",
    };
  }

  let config;
  try {
    config = JSON.parse(readFileSync(codexHooksPath, "utf8"));
  } catch (error) {
    return {
      ok: false,
      required: requireCodexUserHook,
      registered: false,
      hooks_path: codexHooksPath,
      reason: "hooks_config_invalid_json",
      error: error.message,
    };
  }

  const groups = Array.isArray(config.hooks?.UserPromptSubmit) ? config.hooks.UserPromptSubmit : [];
  const matchedHook = groups
    .flatMap((group) => (Array.isArray(group?.hooks) ? group.hooks : []))
    .find((hook) => {
      const text = JSON.stringify(hook);
      return /dinobrain-user-prompt-hook\.ps1/i.test(text) || /Loading DinoBrain context/i.test(text);
    });

  return {
    ok: Boolean(matchedHook) || !requireCodexUserHook,
    required: requireCodexUserHook,
    registered: Boolean(matchedHook),
    hooks_path: codexHooksPath,
    reason: matchedHook ? "registered" : "dinobrain_user_prompt_hook_not_registered",
    command: matchedHook?.command ?? null,
    timeout: matchedHook?.timeout ?? null,
  };
}

function parseClaudePromptHookConfig() {
  if (!existsSync(claudeSettingsPath)) {
    return {
      ok: !requireClaudePromptHook,
      required: requireClaudePromptHook,
      settings_path: claudeSettingsPath,
      reason: "claude_settings_not_found",
    };
  }
  let config;
  try {
    config = JSON.parse(readFileSync(claudeSettingsPath, "utf8"));
  } catch (error) {
    return {
      ok: false,
      required: requireClaudePromptHook,
      settings_path: claudeSettingsPath,
      reason: "claude_settings_invalid_json",
      error: error.message,
    };
  }
  const groups = Array.isArray(config.hooks?.UserPromptSubmit) ? config.hooks.UserPromptSubmit : [];
  const commands = groups
    .flatMap((group) => (Array.isArray(group?.hooks) ? group.hooks : []))
    .map((hook) => `${hook?.command ?? ""} ${hook?.commandWindows ?? ""}`.trim());
  const dinobrainHook = commands.find((text) => {
    return /dinobrain-user-prompt-hook\.ps1/i.test(text) || /Loading DinoBrain context/i.test(text);
  });
  return {
    ok: Boolean(dinobrainHook) || !requireClaudePromptHook,
    required: requireClaudePromptHook,
    settings_path: claudeSettingsPath,
    user_prompt_submit_group_count: groups.length,
    dinobrain_hook_registered: Boolean(dinobrainHook),
    command: dinobrainHook ?? null,
    reason: dinobrainHook ? "registered" : "dinobrain_claude_prompt_hook_missing",
  };
}

async function withClient({ name, command, args, env, cwd }, callback) {
  const client = new Client({ name, version: "2.0.2" });
  const transport = new StdioClientTransport({
    command,
    args,
    cwd,
    env: {
      ...process.env,
      ...env,
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

function seedVault(dataRoot) {
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
    mkdirSync(path.join(dataRoot, dir), { recursive: true });
  }

  writeFileSync(
    path.join(dataRoot, "20_Wiki", "Compound-Base.md"),
    `---
title: Compound Memory Base
summary: Codex should retrieve evidence-backed accepted instances in later Context Packs.
tags: [codex, compound, context-pack]
source_status: internal
confidence: high
last_verified: 2026-07-01
---

# Compound Memory Base

DinoBrain compounds knowledge when a completed task becomes a reviewed instance and that instance is retrieved for a later task.
`,
    "utf8",
  );

  writeFileSync(
    path.join(dataRoot, "20_Wiki", "Syncable-Change.md"),
    `---
title: Syncable Change
summary: This file should be classified as syncable after review.
tags: [syncable]
source_status: internal
confidence: high
last_verified: 2026-07-01
---

# Syncable Change
`,
    "utf8",
  );

  writeFileSync(
    path.join(dataRoot, "80_Review_Queue", "review-needed.md"),
    "# Review Needed\n\nThis file should be classified as conditional.\n",
    "utf8",
  );
  writeFileSync(
    path.join(dataRoot, ".dino", "secrets.json"),
    "{\"note\":\"This path must be blocked even without secret-looking values.\"}\n",
    "utf8",
  );
  writeFileSync(path.join(dataRoot, "20_Wiki", "Sensitive-Pattern.md"), `api_${"key"}: pretend\n`, "utf8");

  if (gitAvailable) {
    spawnSync("git", ["init"], { cwd: dataRoot, stdio: "ignore" });
  }
}

async function verifyConfiguredCodexMcp(config) {
  if (!config.registered) return { ok: false, reason: config.error };
  if (!config.command_exists) return { ok: false, reason: "configured_command_missing" };
  if (!config.server_entry_exists) return { ok: false, reason: "configured_server_entry_missing" };
  if (!config.data_root_exists) return { ok: false, reason: "configured_data_root_missing" };

  return await withClient(
    {
      name: "dinobrain-codex-config-check",
      command: config.command,
      args: config.args,
      env: config.env,
      cwd: root,
    },
    async (client) => {
      const tools = await client.listTools();
      const names = tools.tools.map((tool) => tool.name).sort();
      const missing = expectedTools.filter((tool) => !names.includes(tool));
      return {
        ok: missing.length === 0,
        tools: names,
        missing_tools: missing,
      };
    },
  );
}

async function verifyCompoundingLoop() {
  if (!gitAvailable && !allowNoGit) {
    throw new Error("git_missing: install Git or set DINOBRAIN_ALLOW_NO_GIT=1 for partial verification");
  }
  const tempDataRoot = mkdtempSync(path.join(tmpdir(), "dinobrain-verify-os-"));
  seedVault(tempDataRoot);

  return await withClient(
    {
      name: "dinobrain-compound-loop-check",
      command: process.execPath,
      args: [serverPath],
      env: { DINOBRAIN_DATA_DIR: tempDataRoot },
      cwd: root,
    },
    async (client) => {
      const tools = await client.listTools();
      const names = tools.tools.map((tool) => tool.name).sort();
      const missing = expectedTools.filter((tool) => !names.includes(tool));
      assert(missing.length === 0, `Missing MCP tools: ${missing.join(", ")}`);

      const start = parseTool(
        await client.callTool({
          name: "start_task",
          arguments: {
            request: "Verify Codex compounds knowledge through accepted instance retrieval",
            project: "dinobrain",
            mode: "standard",
            sensitivity: "normal",
          },
        }),
      );

      const finish = parseTool(
        await client.callTool({
          name: "finish_task",
          arguments: {
            task_id: start.task_id,
            summary: "The verifier produced an evidence-backed memory candidate for later retrieval.",
            outcome: "completed",
            changed_files: ["scripts/verify-dinobrain-os.mjs", "src/context.ts"],
            decisions: ["Accepted JSON instances must be indexed by Standard Context Packs."],
            next_steps: ["Use the accepted instance in the next Context Pack."],
            used_memory_paths: ["20_Wiki/Compound-Base.md"],
            search_queries: ["compound knowledge accepted instance"],
          },
        }),
      );
      const finishTrace = JSON.parse(readFileSync(path.join(tempDataRoot, finish.trace_path), "utf8"));
      assert(
        finishTrace.used_memory_paths?.includes("20_Wiki/Compound-Base.md"),
        "finish_task did not preserve structured used_memory_paths",
      );

      const candidate = parseTool(
        await client.callTool({
          name: "create_candidate_instance",
          arguments: {
            claim: "Codex compounds knowledge when accepted instances are retrieved in future Context Packs.",
            evidence_snippet:
              "The verifier starts and finishes a task, promotes an evidence-backed instance, and asks a later Context Pack for the same lesson.",
            evidence_source: "scripts/verify-dinobrain-os.mjs",
            confidence: "high",
            last_verified: "2026-07-01",
            source_status: "internal",
            tags: ["codex", "compound", "context-pack", "accepted-instance"],
            task_id: start.task_id,
            sensitivity: "normal",
          },
        }),
      );

      const review = parseTool(
        await client.callTool({
          name: "review_candidate",
          arguments: {
            candidate_id: candidate.candidate_id,
            decision: "approve",
            reviewer: "verify-os",
            notes: "Evidence, confidence, and last_verified are present.",
          },
        }),
      );
      assert(review.accepted_path, "Approved candidate did not produce an accepted instance");

      const pack = parseTool(
        await client.callTool({
          name: "get_context_pack",
          arguments: {
            question: "How does Codex compound knowledge with accepted instance context pack evidence?",
            limit: 8,
          },
        }),
      );
      const acceptedItem = pack.items.find((item) => item.path === review.accepted_path);
      assert(acceptedItem, `Accepted instance was not retrieved: ${review.accepted_path}`);
      assert(acceptedItem.reasons?.length > 0, "Accepted instance was retrieved without inclusion reasons");

      const trace = JSON.parse(readFileSync(path.join(tempDataRoot, pack.trace_path), "utf8"));
      const tracedItem = trace.items.find((item) => item.path === review.accepted_path);
      assert(tracedItem, "Context Pack trace did not include accepted instance");
      assert(tracedItem.reasons?.length > 0, "Context Pack trace did not explain accepted instance inclusion");

      const quarantine = parseTool(
        await client.callTool({
          name: "quarantine_record",
          arguments: {
            target_path: review.accepted_path,
            reason: "Verify demotion removes an accepted instance from later Context Packs.",
            reviewer: "verify-os",
          },
        }),
      );

      const postQuarantinePack = parseTool(
        await client.callTool({
          name: "get_context_pack",
          arguments: {
            question: "How does Codex compound knowledge with accepted instance context pack evidence?",
            limit: 8,
          },
        }),
      );
      assert(
        !postQuarantinePack.items.some((item) => item.path === review.accepted_path),
        "Quarantined accepted instance still appeared in a later Context Pack",
      );

      let gitSyncSummary;
      if (gitAvailable) {
        const gitSync = parseTool(
          await client.callTool({
            name: "git_sync",
            arguments: { include_sensitive_scan: true },
          }),
        );
        assert(gitSync.dry_run === true, "git_sync did not stay dry-run");
        assert(gitSync.manual_approval_required === true, "git_sync did not require manual approval");
        assert(gitSync.commit_allowed_by_tool === false, "git_sync allowed tool-driven commit");

        const syncFiles = new Map(gitSync.files.map((file) => [file.path, file]));
        assert(syncFiles.get("20_Wiki/Syncable-Change.md")?.classification === "syncable", "Syncable file failed");
        assert(syncFiles.get("80_Review_Queue/review-needed.md")?.classification === "conditional", "Review file failed");
        assert(syncFiles.get(".dino/secrets.json")?.classification === "blocked", "Local secret path failed");
        assert(syncFiles.get("20_Wiki/Sensitive-Pattern.md")?.classification === "blocked", "Sensitive pattern failed");
        gitSyncSummary = gitSync.summary;
      } else {
        gitSyncSummary = {
          skipped: true,
          reason: "git_missing",
          note: "Install Git to enable git_sync backup verification.",
        };
      }

      return {
        ok: true,
        data_root: tempDataRoot,
        tools: names,
        task_path: start.task_path,
        trace_path: finish.trace_path,
        accepted_path: review.accepted_path,
        context_trace_path: pack.trace_path,
        accepted_instance_retrieved: true,
        accepted_instance_reasons: acceptedItem.reasons,
        quarantined_path: quarantine.target_path,
        quarantine_excluded_from_later_pack: true,
        git_sync_summary: gitSyncSummary,
      };
    },
  );
}

function verifyGoldenRetrieval() {
  const result = spawnSync(process.execPath, [path.join(root, "dist", "evaluate-context.js")], {
    cwd: root,
    env: {
      ...process.env,
      DINOBRAIN_DATA_DIR: realDataRoot,
    },
    encoding: "utf8",
  });
  if (result.status !== 0) {
    return {
      ok: false,
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  }
  const report = JSON.parse(result.stdout);
  return {
    ok: report.ok === true,
    cases: report.cases,
    recall: report.recall,
    max_noise: report.max_noise,
    average_noise: report.average_noise,
    failing_cases: report.failing_cases,
  };
}

function commandExists(command) {
  if (existsSync(command)) return true;
  if (process.platform === "win32") {
    return spawnSync("where.exe", [command], { encoding: "utf8" }).status === 0;
  }
  const quoted = `'${command.replace(/'/g, "'\\''")}'`;
  return spawnSync("sh", ["-lc", `command -v ${quoted}`], { encoding: "utf8" }).status === 0;
}

function verifyClaudeCodeMcp() {
  if (!commandExists(claudeCommand)) {
    return {
      ok: !requireClaudeCode,
      required: requireClaudeCode,
      command: claudeCommand,
      command_exists: false,
      skipped: true,
      reason: "claude_code_cli_missing",
    };
  }

  const result = spawnSync(claudeCommand, ["mcp", "list"], {
    cwd: root,
    encoding: "utf8",
    shell: process.platform === "win32",
  });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();

  if (result.error) {
    return {
      ok: !requireClaudeCode,
      required: requireClaudeCode,
      command: claudeCommand,
      command_exists: false,
      skipped: true,
      reason: "claude_code_cli_missing",
      error: result.error.message,
    };
  }

  if (result.status !== 0) {
    return {
      ok: !requireClaudeCode,
      required: requireClaudeCode,
      command: claudeCommand,
      command_exists: true,
      mcp_list_ok: false,
      status: result.status,
      reason: "claude_mcp_list_failed",
      output,
    };
  }

  const dinobrainRegistered = /\bdinobrain\b/i.test(output);
  return {
    ok: dinobrainRegistered || !requireClaudeCode,
    required: requireClaudeCode,
    command: claudeCommand,
    command_exists: true,
    mcp_list_ok: true,
    dinobrain_registered: dinobrainRegistered,
    reason: dinobrainRegistered ? "registered" : "dinobrain_mcp_not_registered",
    output,
  };
}

async function main() {
  assert(existsSync(serverPath), "dist/index.js is missing. Run npm run build first.");

  const codexConfig = parseCodexDinoBrainConfig();
  const codexHookRuntime = parseCodexHookRuntimeConfig();
  const codexUserHook = parseCodexUserHookConfig();
  const claudePromptHook = parseClaudePromptHookConfig();
  const [codexMcp, compoundingLoop] = await Promise.all([
    verifyConfiguredCodexMcp(codexConfig),
    verifyCompoundingLoop(),
  ]);
  const retrievalEval = verifyGoldenRetrieval();
  const claudeCodeMcp = verifyClaudeCodeMcp();

  const report = {
    ok:
      codexMcp.ok === true &&
      codexHookRuntime.ok === true &&
      codexUserHook.ok === true &&
      compoundingLoop.ok === true &&
      retrievalEval.ok === true &&
      claudeCodeMcp.ok === true &&
      claudePromptHook.ok === true,
    verification_version: "dinobrain-os-2026-07-01",
    codex_integration: {
      config: codexConfig,
      hook_runtime_config: codexHookRuntime,
      user_prompt_hook: codexUserHook,
      mcp_list_tools: codexMcp,
      note: "If the Codex app was already running before MCP or user hooks were added, run DinoBrain Codex Hook Approval.cmd or open /hooks and trust the DinoBrain UserPromptSubmit hook.",
    },
    claude_code_integration: {
      mcp_list: claudeCodeMcp,
      user_prompt_hook: claudePromptHook,
      note: "Claude Code pre-response integration requires both the MCP server registration and the UserPromptSubmit hook in Claude settings.",
    },
    compounding_loop: compoundingLoop,
    retrieval_quality: retrievalEval,
  };

  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
