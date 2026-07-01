import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataRoot = mkdtempSync(path.join(tmpdir(), "dinobrain-observatory-graph-"));
const port = 3900 + Math.floor(Math.random() * 400);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      env: { ...process.env, DINOBRAIN_DATA_DIR: dataRoot },
      stdio: ["ignore", "pipe", "pipe"],
      ...options,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${command} ${args.join(" ")} failed with ${code}\n${stdout}\n${stderr}`));
    });
  });
}

function waitForServer(child) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Observatory did not start in time")), 10000);
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk;
      if (output.includes(`http://127.0.0.1:${port}/`)) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.stderr.on("data", (chunk) => {
      output += chunk;
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`Observatory exited early with ${code}\n${output}`));
    });
  });
}

try {
  mkdirSync(path.join(dataRoot, "20_Wiki"), { recursive: true });
  mkdirSync(path.join(dataRoot, ".dino", "tasks"), { recursive: true });
  mkdirSync(path.join(dataRoot, ".dino", "events"), { recursive: true });
  writeFileSync(
    path.join(dataRoot, "20_Wiki", "Graph-Speed.md"),
    `---
title: Graph Speed
summary: The live graph should expose Obsidian-style nodes and links.
tags: [graph, obsidian]
---

# Graph Speed

This note links to [[Context Pack]].
`,
  );
  writeFileSync(
    path.join(dataRoot, "20_Wiki", "Context Pack.md"),
    `---
title: Context Pack
summary: Context packs should be visible in the graph.
tags: [context-pack]
---

# Context Pack
`,
  );
  writeFileSync(
    path.join(dataRoot, ".dino", "tasks", "task-active-observatory.json"),
    `${JSON.stringify(
      {
        task_id: "task-active-observatory",
        status: "started",
        request: "Verify active tasks appear in the DinoBrain Fossil Graph.",
        project: "observatory-verify",
        mode: "standard",
        sensitivity: "unknown",
        created_at: "2026-07-01T00:00:00.000Z",
        updated_at: "2026-07-01T00:00:00.000Z",
        data_root: dataRoot,
        sync_policy: "blocked_until_review",
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  writeFileSync(
    path.join(dataRoot, ".dino", "events", "2026-07-01.jsonl"),
    `${JSON.stringify({
      event: "task_started",
      task_id: "task-active-observatory",
      at: "2026-07-01T00:00:00.000Z",
      path: ".dino/tasks/task-active-observatory.json",
    })}\n`,
    "utf8",
  );

  await run(process.execPath, [path.join(root, "dist", "build-sqlite-shards.js")]);
  const server = spawn(process.execPath, [path.join(root, "scripts", "dinobrain-observatory.mjs"), `--port=${port}`], {
    cwd: root,
    env: { ...process.env, DINOBRAIN_DATA_DIR: dataRoot },
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    await waitForServer(server);
    const graph = await fetch(`http://127.0.0.1:${port}/api/graph`).then((response) => response.json());
    assert(graph.ok === true, "Graph endpoint did not return ok=true");
    assert(graph.stats.records >= 2, "Graph did not include seeded records");
    assert(graph.nodes.some((node) => node.label === "Graph Speed"), "Graph Speed node missing");
    assert(graph.edges.some((edge) => edge.type === "wiki_link"), "wiki_link edge missing");
    assert(graph.stats.active_tasks === 1, "Graph did not report active task count");
    assert(graph.nodes.some((node) => node.type === "active_task"), "Graph did not include active task node");
    assert(graph.edges.some((edge) => edge.type === "active_task"), "Graph did not include active task edge");
    const state = await fetch(`http://127.0.0.1:${port}/api/state`).then((response) => response.json());
    assert(state.ok === true, "State endpoint did not return ok=true");
    assert(state.summary.active_task_count === 1, "State endpoint did not report active task count");
    const health = await fetch(`http://127.0.0.1:${port}/api/health`).then((response) => response.json());
    assert(health.ok === true && health.observatory_version, "Health endpoint did not report Observatory version");
    console.log("observatory live graph verification ok");
  } finally {
    server.kill();
  }
} finally {
  rmSync(dataRoot, { recursive: true, force: true });
}
