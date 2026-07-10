import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { DINOBRAIN_VERSION } from "./lib/version-manifest.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const serverPath = path.join(root, "dist", "index.js");
const dataRoot = path.resolve(process.env.DINOBRAIN_DATA_DIR ?? path.join(root, "..", "dinobrain-data"));

function argValue(name) {
  const index = process.argv.indexOf(name);
  if (index < 0) return null;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

function readStdin() {
  return readFileSync(0, "utf8");
}

function payloadText() {
  const payloadPath = argValue("--payload");
  if (payloadPath) return readFileSync(path.resolve(payloadPath), "utf8");
  return readStdin();
}

function parsePayload() {
  const text = payloadText().trim();
  if (!text) throw new Error("finish-task-stdio requires JSON payload on stdin or --payload <file>");
  const payload = JSON.parse(text);
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("finish-task-stdio payload must be a JSON object");
  }
  return payload;
}

function parseTool(result) {
  const text = result.content?.find((part) => part.type === "text")?.text;
  if (!text) throw new Error("finish_task did not return text content");
  return JSON.parse(text);
}

async function main() {
  const payload = parsePayload();
  const client = new Client({ name: "dinobrain-finish-task-stdio", version: DINOBRAIN_VERSION });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath],
    cwd: root,
    env: {
      ...process.env,
      DINOBRAIN_DATA_DIR: dataRoot,
      DINOBRAIN_AUTO_GROWTH: process.env.DINOBRAIN_AUTO_GROWTH ?? "0",
      DINOBRAIN_AUTO_COMPOUND: process.env.DINOBRAIN_AUTO_COMPOUND ?? "0",
      DINOBRAIN_AUTO_SYNC: process.env.DINOBRAIN_AUTO_SYNC ?? "0",
    },
    stderr: "pipe",
  });
  try {
    await client.connect(transport);
    const result = parseTool(await client.callTool({ name: "finish_task", arguments: payload }));
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await client.close();
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
