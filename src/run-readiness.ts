import path from "node:path";
import { pathToFileURL } from "node:url";

import { buildReadiness } from "./readiness.js";

function argValue(name: string): string | null {
  const index = process.argv.indexOf(name);
  if (index < 0) return null;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

async function main(): Promise<void> {
  const dataRoot = path.resolve(
    argValue("--data-root") ?? process.env.DINOBRAIN_DATA_DIR ?? path.join(process.cwd(), "..", "dinobrain-data"),
  );
  const staleAfterRaw = argValue("--generation-stale-after-ms");
  const generationStaleAfterMs = staleAfterRaw === null ? undefined : Number(staleAfterRaw);
  if (generationStaleAfterMs !== undefined && (!Number.isFinite(generationStaleAfterMs) || generationStaleAfterMs < 0)) {
    throw new Error("--generation-stale-after-ms must be a non-negative number");
  }
  const report = await buildReadiness(dataRoot, { generationStaleAfterMs });
  console.log(JSON.stringify(report, null, 2));
  if (!report.ok && !process.argv.includes("--allow-not-ready")) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
}
