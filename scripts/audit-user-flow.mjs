import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const serverPath = path.join(root, "dist", "index.js");
const dataRepoPath = path.resolve(root, "..", "dinobrain-data");
const reportPath = path.resolve(process.env.DINOBRAIN_FLOW_AUDIT_OUT ?? path.join(root, "reports", "dinobrain-flow-audit.json"));
const codexCliCandidates = [
  process.env.CODEX_CLI_PATH,
  path.join(process.env.LOCALAPPDATA ?? "", "OpenAI", "Codex", "bin", "aec6b7c6fcdfb66a", "codex.exe"),
].filter(Boolean);

const expectedTools = [
  "create_candidate_instance",
  "finish_task",
  "get_context_pack",
  "git_sync",
  "quarantine_record",
  "review_candidate",
  "start_task",
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

  writeFileSync(
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
    "utf8",
  );

  writeFileSync(
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
    "utf8",
  );

  writeFileSync(
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
    "utf8",
  );

  writeFileSync(
    path.join(dataRoot, "20_Wiki", "Syncable-Change.md"),
    "# Syncable Change\n\nThis should be syncable after review.\n",
    "utf8",
  );
  writeFileSync(
    path.join(dataRoot, "80_Review_Queue", "review-needed.md"),
    "# Review Needed\n\nThis should be conditional.\n",
    "utf8",
  );
  spawnSync("git", ["init"], { cwd: dataRoot, stdio: "ignore" });
}

async function withClient(dataRoot, callback) {
  const client = new Client({ name: "dinobrain-flow-audit", version: "0.1.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath],
    cwd: root,
    env: {
      ...process.env,
      DINOBRAIN_DATA_DIR: dataRoot,
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
        "사용자 요청이 들어오면 OS 훅이 먼저 감지한다.",
        "not_implemented",
        "DinoBrain MCP tools are listable, but there is no Codex hook, pre-prompt trigger, or automatic start_task bridge in the repo.",
        "The agent must intentionally call MCP tools until a hook or agent protocol exists.",
      ),
    );

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
        "start_task가 이번 작업을 OS에 등록한다.",
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
        "OS가 관련 선호/결정/프로젝트/Wiki/최근 작업을 작게 묶어 Context Pack으로 준다.",
        "verified",
        `Returned ${contextPack.item_count} items including ${contextPaths.join(", ")}. Trace: ${contextPack.trace_path}. Ranking inputs: ${contextPack.ranking_inputs.join(", ")}.`,
      ),
    );

    checks.push(
      status(
        4,
        "Codex/Claude가 Context Pack을 참고하되 현재 사용자 지시가 항상 우선이다.",
        "partially_verified",
        "The Context Pack includes a memory that states current user instructions outrank stored memory. MCP can provide this context.",
        "MCP cannot enforce model behavior. Priority of the current user instruction is a system/model policy obligation, not a DinoBrain runtime guard.",
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
    checks.push(
      status(
        5,
        "필요하면 wiki_search/search_memory로 관련 기억만 좁게 찾는다.",
        "partially_verified",
        "wiki_search found 20_Wiki/Rare-Search-Memory.md by the narrow phrase zeta-lattice-only.",
        "A separate search_memory tool does not exist yet; wiki_search covers curated roots only.",
      ),
    );

    const finish = parseTool(
      await client.callTool({
        name: "finish_task",
        arguments: {
          task_id: start.task_id,
          summary: `Used Context Pack ${contextPack.trace_path} and wiki_search result 20_Wiki/Rare-Search-Memory.md.`,
          outcome: "completed",
          changed_files: ["scripts/audit-user-flow.mjs"],
          decisions: ["Context retrieval is verified; automatic request hook is not implemented."],
          next_steps: ["Add a real pre-task hook or agent protocol if automatic capture is required."],
        },
      }),
    );
    const finishTrace = JSON.parse(readFileSync(path.join(tempDataRoot, finish.trace_path), "utf8"));
    assert(finishTrace.summary.includes(contextPack.trace_path), "finish_task trace did not preserve memory-use summary");
    checks.push(
      status(
        6,
        "finish_task가 무엇을 했고 어떤 기억을 사용했으며 남은 일이 뭔지 기록한다.",
        "partially_verified",
        `Created ${finish.trace_path}; summary/decisions/next_steps are recorded.`,
        "Used memories are only captured in free-text summary today. There is no structured used_memory_paths field.",
      ),
    );

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
        "반복 판단/중요 결과가 Wiki, semantic job, correction, proposal 등으로 정리되어 다음 세션이 이어받는다.",
        "partially_verified",
        `Candidate ${candidate.candidate_path} was approved into ${review.accepted_path}, then retrieved by a later Context Pack.`,
        "Only candidate/accepted-instance growth is implemented. Wiki promotion, semantic jobs, correction records, and proposal records are not separate implemented flows yet.",
      ),
    );

    const gitSync = parseTool(
      await client.callTool({
        name: "git_sync",
        arguments: { include_sensitive_scan: true },
      }),
    );
    const installScripts = ["install.ps1", "setup.ps1", "update.ps1", "reinstall.ps1", "uninstall.ps1"].filter((file) =>
      existsSync(path.join(root, file)),
    );
    checks.push(
      status(
        8,
        "SecondBrain 폴더와 GitHub 백업으로 새 PC/다른 에이전트에서도 이어갈 수 있다.",
        "partially_verified",
        `App remote=${appRemote}; data remote=${dataRemote}; installer scripts=${installScripts.join(", ")}; git_sync dry_run=${gitSync.dry_run}. Codex MCP list includes dinobrain=${codexMcpList.includes("dinobrain")}.`,
        "Restore/install is implemented and tested elsewhere, but git_sync still does not commit or push data automatically.",
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
    await fs.mkdir(path.dirname(reportPath), { recursive: true });
    await fs.writeFile(reportPath, `${JSON.stringify(reportWithPath, null, 2)}\n`, "utf8");
    console.log(JSON.stringify(reportWithPath, null, 2));
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
