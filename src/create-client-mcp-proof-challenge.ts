import path from "node:path";
import { pathToFileURL } from "node:url";

import { createClientMcpProofChallenge, type ClientMcpAgent } from "./client-mcp-proof.js";

function argument(name: string): string {
  const prefix = `--${name}=`;
  const inline = process.argv.slice(2).find((value) => value.startsWith(prefix));
  if (inline) return inline.slice(prefix.length).trim();
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? String(process.argv[index + 1] ?? "").trim() : "";
}

async function main(): Promise<void> {
  const agentValue = argument("agent");
  if (agentValue !== "codex" && agentValue !== "claude") {
    throw new Error("--agent must be codex or claude");
  }
  const dataRoot = path.resolve(process.env.DINOBRAIN_DATA_DIR ?? path.join(process.cwd(), "..", "dinobrain-data"));
  const ttlMinutes = Number(argument("ttl-minutes") || 15);
  const result = await createClientMcpProofChallenge(dataRoot, agentValue as ClientMcpAgent, {
    ttlMs: Math.max(1, ttlMinutes) * 60_000,
  });
  console.log(
    JSON.stringify(
      {
        ok: true,
        data_root: dataRoot,
        agent: agentValue,
        challenge_id: result.challenge.challenge_id,
        challenge_path: result.path,
        issued_at: result.challenge.issued_at,
        expires_at: result.challenge.expires_at,
        prompt: result.prompt,
      },
      null,
      2,
    ),
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
}
