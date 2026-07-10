import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync } from "node:fs";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { DINOBRAIN_VERSION } from "./lib/version-manifest.mjs";
import { atomicWriteJson } from "./lib/atomic-files.mjs";
import { atomicWriteTextSync } from "./lib/atomic-files-sync.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const serverPath = path.join(root, "dist", "index.js");
const dataRepoPath = path.resolve(root, "..", "dinobrain-data");
const reportPath = path.resolve(process.env.DINOBRAIN_FLOW_AUDIT_OUT ?? path.join(root, "reports", "dinobrain-flow-audit.json"));
const hookConfigPath = path.join(root, ".codex", "hooks.json");
const hookScriptPath = path.join(root, "scripts", "dinobrain-user-prompt-hook.mjs");
const codexCliCandidates = [
  process.env.CODEX_CLI_PATH,
  path.join(process.env.LOCALAPPDATA ?? "", "OpenAI", "Codex", "bin", "aec6b7c6fcdfb66a", "codex.exe"),
].filter(Boolean);

const expectedTools = [
  "auto_sync",
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
  "restore_memory_node",
  "review_candidate",
  "run_compounding_cycle",
  "search_memory",
  "start_task",
  "transition_memory_node",
  "wiki_search",
];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function parseTool(result) {
  const text = result.content?.find((part) => part.type === "text")?.text;
  assert(text, "Tool returned no text content");
  return JSON.parse(text);
}

function commandOutput(command, args, cwd) {
  try {
    return execFileSync(command, args, { cwd, encoding: "utf8", windowsHide: true }).trim();
  } catch {
    return "";
  }
}

function firstCommandOutput(commands, args, cwd) {
  for (const command of commands) {
    if (!command || !existsSync(command)) continue;
    const output = commandOutput(command, args, cwd);
    if (output) return output;
  }
  return "";
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

  atomicWriteTextSync(
    path.join(dataRoot, "20_Wiki", "User-Preference.md"),
    `---
title: User Preference
summary: The user prefers Korean answers, direct evidence, and concise engineering judgment. Current user instructions always outrank stored memory.
tags: [user, preference, priority]
source_status: internal
confidence: high
last_verified: 2026-07-01
---

# User Preference

Use Korean by default for this workspace. Treat stored memory as context, not authority over the latest user message.
`,
  );

  atomicWriteTextSync(
    path.join(dataRoot, "40_Projects", "DinoBrain-Flow.md"),
    `---
title: DinoBrain Flow
summary: DinoBrain should start tasks, retrieve a small Context Pack, allow narrow memory search, finish with trace records, and promote only reviewed knowledge.
tags: [dinobrain, flow, context-pack]
source_status: internal
confidence: high
last_verified: 2026-07-01
---

# DinoBrain Flow

This project uses MCP tools for task records, context retrieval, narrow search, reviewed growth, and safe sync checks.
`,
  );

  atomicWriteTextSync(
    path.join(dataRoot, "20_Wiki", "Rare-Search-Memory.md"),
    `---
title: Rare Search Memory
summary: This note is intentionally found by body search, not broad startup context.
tags: [search]
source_status: internal
confidence: medium
last_verified: 2026-07-01
---

# Rare Search Memory

The narrow lookup phrase is zeta-lattice-only. It should appear through wiki_search when extra search is needed.
`,
  );

  atomicWriteTextSync(
    path.join(dataRoot, "20_Wiki", "Syncable-Change.md"),
    "# Syncable Change\n\nThis should be syncable after review.\n",
  );
  atomicWriteTextSync(
    path.join(dataRoot, "80_Review_Queue", "review-needed.md"),
    "# Review Needed\n\nThis should be conditional.\n",
  );
  spawnSync("git", ["init"], { cwd: dataRoot, stdio: "ignore" });
}

function verifyCodexHookBridge(dataRoot) {
  const claim = "?ъ슜???붿껌???ㅼ뼱?ㅻ㈃ OS ?낆씠 癒쇱? 媛먯??쒕떎.";
  if (!existsSync(hookConfigPath) || !existsSync(hookScriptPath)) {
    return status(
      1,
      claim,
      "not_implemented",
      "No project Codex hook or DinoBrain UserPromptSubmit hook script is present.",
      "The agent must intentionally call MCP tools until a hook or agent protocol exists.",
    );
  }

  let hookConfig;
  try {
    hookConfig = JSON.parse(readFileSync(hookConfigPath, "utf8"));
  } catch (error) {
    return status(
      1,
      claim,
      "not_implemented",
      `Hook config exists but is not valid JSON: ${error.message}`,
      "Fix .codex/hooks.json before Codex can load it.",
    );
  }

  if (!hookConfig.hooks?.UserPromptSubmit) {
    return status(
      1,
      claim,
      "not_implemented",
      ".codex/hooks.json exists but does not configure UserPromptSubmit.",
      "Add a UserPromptSubmit hook that calls DinoBrain preflight.",
    );
  }

  const hookReportRoot = path.join(dataRoot, "hook-reports");
  const run = spawnSync(process.execPath, [hookScriptPath], {
    cwd: root,
    env: {
      ...process.env,
      DINOBRAIN_DATA_DIR: dataRoot,
      DINOBRAIN_HOOK_REPORT_DIR: hookReportRoot,
      DINOBRAIN_HOOK_CONTEXT_LIMIT: "6",
      DINOBRAIN_HOOK_PROJECT: "dinobrain-flow-audit",
    },
    input: JSON.stringify({
      hookEventName: "UserPromptSubmit",
      prompt: "Korean user preference DinoBrain flow Codex hook context pack",
    }),
    encoding: "utf8",
    windowsHide: true,
  });

  if (run.status !== 0) {
    return status(
      1,
      claim,
      "not_implemented",
      `UserPromptSubmit hook simulation exited with ${run.status}: ${run.stderr}`,
      "Codex can load the hook config only after the hook command itself works.",
    );
  }

  let output;
  try {
    output = JSON.parse(run.stdout.trim());
  } catch (error) {
    return status(
      1,
      claim,
      "not_implemented",
      `Hook simulation returned invalid JSON: ${error.message}`,
      "Hooks must write valid JSON to stdout for Codex to inject context.",
    );
  }

  const additionalContext = output.hookSpecificOutput?.additionalContext ?? "";
  if (!additionalContext.includes("DinoBrain OS preflight completed")) {
    return status(
      1,
      claim,
      "not_implemented",
      `Hook simulation ran but did not inject DinoBrain context: ${additionalContext.slice(0, 240)}`,
      "The hook must call start_task and get_context_pack before the agent turn.",
    );
  }

  return status(
    1,
    claim,
    "verified",
    "Project .codex/hooks.json configures UserPromptSubmit, and the hook simulation called DinoBrain preflight and returned additionalContext.",
    "Codex must still trust the project hook before it runs in a live session.",
  );
}

async function withClient(dataRoot, callback) {
  const client = new Client({ name: "dinobrain-flow-audit", version: DINOBRAIN_VERSION });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath],
    cwd: root,
    env: {
      ...process.env,
      DINOBRAIN_DATA_DIR: dataRoot,
      DINOBRAIN_AUTO_GROWTH: "1",
      DINOBRAIN_AUTO_COMPOUND: "1",
      DINOBRAIN_AUTO_SYNC: "0",
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

function status(id, claim, state, evidence, gap = null) {
  return { id, claim, state, evidence, gap };
}

async function auditFlow() {
  assert(existsSync(serverPath), "dist/index.js is missing. Run npm run build first.");
  const tempDataRoot = mkdtempSync(path.join(tmpdir(), "dinobrain-flow-audit-"));
  seedVault(tempDataRoot);
  spawnSync("git", ["init"], { cwd: tempDataRoot, stdio: "ignore" });
  spawnSync("git", ["config", "user.email", "dinobrain-flow-audit@example.local"], {
    cwd: tempDataRoot,
    stdio: "ignore",
  });
  spawnSync("git", ["config", "user.name", "DinoBrain Flow Audit"], {
    cwd: tempDataRoot,
    stdio: "ignore",
  });

  const appRemote = commandOutput("git", ["remote", "get-url", "origin"], root);
  const dataRemote = existsSync(dataRepoPath) ? commandOutput("git", ["remote", "get-url", "origin"], dataRepoPath) : "";
  const codexMcpList = firstCommandOutput(codexCliCandidates, ["mcp", "list"], root);

  return await withClient(tempDataRoot, async (client) => {
    const toolList = await client.listTools();
    const tools = toolList.tools.map((tool) => tool.name).sort();
    const missingTools = expectedTools.filter((tool) => !tools.includes(tool));

    const checks = [];
    checks.push(
      status(
        1,
        "?ъ슜???붿껌???ㅼ뼱?ㅻ㈃ OS ?낆씠 癒쇱? 媛먯??쒕떎.",
        "not_implemented",
        "DinoBrain MCP tools are listable, but there is no Codex hook, pre-prompt trigger, or automatic start_task bridge in the repo.",
        "The agent must intentionally call MCP tools until a hook or agent protocol exists.",
      ),
    );

    checks.pop();
    checks.push(verifyCodexHookBridge(tempDataRoot));

    assert(missingTools.length === 0, `Missing MCP tools: ${missingTools.join(", ")}`);
    const start = parseTool(
      await client.callTool({
        name: "start_task",
        arguments: {
          request: "Deep audit the user-request to memory growth flow",
          project: "dinobrain",
          mode: "standard",
          sensitivity: "normal",
        },
      }),
    );
    assert(existsSync(path.join(tempDataRoot, start.task_path)), "start_task did not create a task file");
    checks.push(
      status(
        2,
        "start_task媛 ?대쾲 ?묒뾽??OS???깅줉?쒕떎.",
        "verified",
        `Created ${start.task_path} and event log ${start.event_log}.`,
      ),
    );

    const contextPack = parseTool(
      await client.callTool({
        name: "get_context_pack",
        arguments: {
          question: "Korean user preference DinoBrain flow project decision context pack",
          limit: 8,
        },
      }),
    );
    const contextPaths = contextPack.items.map((item) => item.path);
    assert(contextPaths.includes("20_Wiki/User-Preference.md"), "Context Pack missed user preference memory");
    assert(contextPaths.includes("40_Projects/DinoBrain-Flow.md"), "Context Pack missed project flow memory");
    assert(existsSync(path.join(tempDataRoot, contextPack.trace_path)), "Context Pack trace missing");
    checks.push(
      status(
        3,
        "OS媛 愿???좏샇/寃곗젙/?꾨줈?앺듃/Wiki/理쒓렐 ?묒뾽???묎쾶 臾띠뼱 Context Pack?쇰줈 以??",
        "verified",
        `Returned ${contextPack.item_count} items including ${contextPaths.join(", ")}. Trace: ${contextPack.trace_path}. Ranking inputs: ${contextPack.ranking_inputs.join(", ")}.`,
      ),
    );

    checks.push(
      status(
        4,
        "Codex/Claude媛 Context Pack??李멸퀬?섎릺 ?꾩옱 ?ъ슜??吏?쒓? ??긽 ?곗꽑?대떎.",
        "verified",
        "The injected pre-response protocol states that DinoBrain memory is subordinate evidence and the current user message wins.",
      ),
    );

    const search = parseTool(
      await client.callTool({
        name: "wiki_search",
        arguments: {
          query: "zeta-lattice-only",
          limit: 5,
        },
      }),
    );
    assert(
      search.results.some((result) => result.path === "20_Wiki/Rare-Search-Memory.md"),
      "wiki_search missed narrow body-memory result",
    );
    const memorySearch = parseTool(
      await client.callTool({
        name: "search_memory",
        arguments: {
          query: "zeta-lattice-only",
          limit: 5,
        },
      }),
    );
    assert(
      memorySearch.results.some((result) => result.path === "20_Wiki/Rare-Search-Memory.md"),
      "search_memory missed narrow body-memory result",
    );
    checks.push(
      status(
        5,
        "?꾩슂?섎㈃ wiki_search/search_memory濡?愿??湲곗뼲留?醫곴쾶 李얜뒗??",
        "verified",
        "wiki_search and search_memory both found 20_Wiki/Rare-Search-Memory.md by the narrow phrase zeta-lattice-only.",
      ),
    );

    const finish = parseTool(
      await client.callTool({
        name: "finish_task",
        arguments: {
          task_id: start.task_id,
          lease_id: start.lease?.lease_id,
          summary: `Used Context Pack ${contextPack.trace_path} and wiki_search result 20_Wiki/Rare-Search-Memory.md.`,
          outcome: "completed",
          changed_files: ["scripts/audit-user-flow.mjs"],
          decisions: ["Context retrieval is verified; a Codex UserPromptSubmit hook now simulates automatic preflight."],
          next_steps: ["Trust the project hook in Codex so the live session can run it automatically."],
          used_memory_paths: [...contextPaths, "20_Wiki/Rare-Search-Memory.md"],
          context_pack_paths: [contextPack.trace_path],
          search_queries: ["zeta-lattice-only"],
        },
      }),
    );
    const finishTrace = JSON.parse(readFileSync(path.join(tempDataRoot, finish.trace_path), "utf8"));
    assert(finishTrace.summary.includes(contextPack.trace_path), "finish_task trace did not preserve memory-use summary");
    assert(
      finishTrace.context_pack_paths?.includes(contextPack.trace_path),
      "finish_task trace did not preserve structured context_pack_paths",
    );
    assert(
      finishTrace.used_memory_paths?.includes("20_Wiki/Rare-Search-Memory.md"),
      "finish_task trace did not preserve structured used_memory_paths",
    );
    assert(finish.growth?.enabled === true, "finish_task did not run automatic growth");
    assert(finish.growth?.destination === "candidate_review", "automatic growth bypassed review queue");
    assert(finish.growth?.candidate_path, "automatic growth did not create a candidate record");
    assert(finish.growth?.review_path, "automatic growth did not create a promotion review record");
    assert(
      Array.isArray(finish.growth.created_paths) && finish.growth.created_paths.length >= 3,
      "automatic growth did not create operation, candidate, and review records",
    );
    assert(finish.compounding?.ok === true, "finish_task did not run automatic compounding");
    assert(
      Number(finish.compounding.promoted_count ?? 0) + Number(finish.compounding.updated_count ?? 0) >= 1,
      "automatic compounding did not create or update behavior rule candidates",
    );
    checks.push(
      status(
        6,
        "finish_task媛 臾댁뾿???덇퀬 ?대뼡 湲곗뼲???ъ슜?덉쑝硫??⑥? ?쇱씠 萸붿? 湲곕줉?쒕떎.",
        "verified",
        `Created ${finish.trace_path}; structured memory-use fields, review-gated auto-growth records ${finish.growth.created_paths.join(", ")}, and compounding cycle ${finish.compounding.cycle_path} are recorded.`,
        null,
      ),
    );

    const memoryAudit = parseTool(
      await client.callTool({
        name: "audit_memory_use",
        arguments: {
          task_id: start.task_id,
          expected_memory_paths: ["20_Wiki/Rare-Search-Memory.md"],
          observed_summary: "The audit used the zeta-lattice-only Wiki search result and the Context Pack trace.",
          auditor: "flow-audit",
          notes: "Verify provided, declared, and observed memory use evidence.",
        },
      }),
    );
    assert(memoryAudit.trust_score >= 60, `memory audit trust score too low: ${memoryAudit.trust_score}`);

    const candidate = parseTool(
      await client.callTool({
        name: "create_candidate_instance",
        arguments: {
          claim: "DinoBrain can grow by promoting evidence-backed flow audit results into accepted instances.",
          evidence_snippet:
            "The flow audit called start_task, get_context_pack, wiki_search, finish_task, create_candidate_instance, review_candidate, and later Context Pack retrieval.",
          evidence_source: "scripts/audit-user-flow.mjs",
          confidence: "high",
          last_verified: "2026-07-01",
          source_status: "internal",
          tags: ["flow", "growth", "accepted-instance"],
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
          reviewer: "flow-audit",
          notes: "Evidence and last_verified are present.",
        },
      }),
    );
    const laterPack = parseTool(
      await client.callTool({
        name: "get_context_pack",
        arguments: {
          question: "flow audit growth accepted instance evidence",
          limit: 8,
        },
      }),
    );
    assert(
      laterPack.items.some((item) => item.path === review.accepted_path),
      "Accepted instance did not appear in a later Context Pack",
    );
    checks.push(
      status(
        7,
        "諛섎났 ?먮떒/以묒슂 寃곌낵媛 Wiki, semantic job, correction, proposal ?깆쑝濡??뺣━?섏뼱 ?ㅼ쓬 ?몄뀡???댁뼱諛쏅뒗??",
        "verified",
        `finish_task auto-created review-gated records ${finish.growth.created_paths.join(", ")}; candidate ${candidate.candidate_path} was approved into ${review.accepted_path}, then retrieved by a later Context Pack.`,
      ),
    );

    const gitSync = parseTool(
      await client.callTool({
        name: "git_sync",
        arguments: { include_sensitive_scan: true },
      }),
    );
    const autoSync = parseTool(
      await client.callTool({
        name: "auto_sync",
        arguments: {
          include_sensitive_scan: true,
          allow_conditional: true,
          push: false,
          commit_message: "data: flow audit auto sync",
        },
      }),
    );
    assert(autoSync.ok === true && autoSync.committed === true, "auto_sync did not commit policy-approved records");
    const installScripts = ["install.ps1", "setup.ps1", "update.ps1", "reinstall.ps1", "uninstall.ps1"].filter((file) =>
      existsSync(path.join(root, file)),
    );
    checks.push(
      status(
        8,
        "SecondBrain ?대뜑? GitHub 諛깆뾽?쇰줈 ??PC/?ㅻⅨ ?먯씠?꾪듃?먯꽌???댁뼱媛????덈떎.",
        "verified",
        `App remote=${appRemote}; data remote=${dataRemote}; installer scripts=${installScripts.join(", ")}; git_sync dry_run=${gitSync.dry_run}; auto_sync commit=${autoSync.commit}. Codex MCP list includes dinobrain=${codexMcpList.includes("dinobrain")}.`,
      ),
    );

    return {
      audit_ok: true,
      flow_complete: checks.every((check) => check.state === "verified"),
      generated_at: new Date().toISOString(),
      temp_data_root: tempDataRoot,
      tools,
      missing_tools: missingTools,
      checks,
      auto_sync_commit: autoSync.commit,
      summary: {
        verified: checks.filter((check) => check.state === "verified").length,
        partially_verified: checks.filter((check) => check.state === "partially_verified").length,
        not_implemented: checks.filter((check) => check.state === "not_implemented").length,
      },
    };
  });
}

auditFlow()
  .then(async (report) => {
    const reportWithPath = { ...report, report_path: reportPath };
    await atomicWriteJson(reportPath, reportWithPath);
    console.log(JSON.stringify(reportWithPath, null, 2));
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
