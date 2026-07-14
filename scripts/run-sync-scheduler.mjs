import path from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { DINOBRAIN_VERSION } from "./lib/version-manifest.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const serverPath = path.join(root, "dist", "index.js");
const dataRoot = path.resolve(process.env.DINOBRAIN_DATA_DIR ?? path.join(root, "..", "dinobrain-data"));
const command = (process.argv[2] ?? "status").toLowerCase();
const timeoutMs = Math.max(5_000, Math.min(120_000, Number(process.env.DINOBRAIN_SYNC_RUN_TIMEOUT_MS ?? 75_000)));

function parseTool(result) {
  const text = result.content?.find((part) => part.type === "text")?.text;
  if (!text) throw new Error("DinoBrain sync scheduler returned no text content");
  return JSON.parse(text);
}

function requestForCommand() {
  if (command === "status") return { name: "sync_scheduler_status", arguments: {} };
  if (command === "automatic") return { name: "sync_scheduler_run", arguments: { mode: "automatic" } };
  if (command === "manual" || command === "manual_safe_scoped") {
    return { name: "sync_scheduler_run", arguments: { mode: "manual_safe_scoped" } };
  }
  if (command === "enable" || command === "disable") {
    return { name: "sync_scheduler_set_automatic", arguments: { enabled: command === "enable" } };
  }
  throw new Error(`Unknown sync scheduler command: ${command}`);
}

async function main() {
  const client = new Client({ name: "dinobrain-sync-scheduler-cli", version: DINOBRAIN_VERSION });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath],
    cwd: root,
    env: {
      ...process.env,
      DINOBRAIN_DATA_DIR: dataRoot,
      DINOBRAIN_AUTO_GROWTH: "0",
      DINOBRAIN_AUTO_COMPOUND: "0",
      DINOBRAIN_AUTO_SYNC: "0",
    },
    stderr: "pipe",
  });
  let timer;
  try {
    await client.connect(transport);
    const request = requestForCommand();
    const response = await Promise.race([
      client.callTool(request),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Sync scheduler timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
    console.log(JSON.stringify(parseTool(response), null, 2));
  } finally {
    if (timer) clearTimeout(timer);
    await client.close().catch(() => undefined);
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
