import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { atomicWriteJson, atomicWriteText } = await import(
  pathToFileURL(path.join(root, "dist", "concurrency.js")).href
);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function sourceFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(fullPath);
    return entry.isFile() && entry.name.endsWith(".ts") ? [fullPath] : [];
  });
}

async function main() {
  const directWrites = [];
  for (const filePath of sourceFiles(path.join(root, "src"))) {
    if (filePath.endsWith(`${path.sep}concurrency.ts`)) continue;
    const source = readFileSync(filePath, "utf8");
    if (/\bfs\.writeFile\s*\(|\bwriteFileSync\s*\(/.test(source)) {
      directWrites.push(path.relative(root, filePath).replace(/\\/g, "/"));
    }
  }
  assert(directWrites.length === 0, `production direct state writers remain: ${directWrites.join(", ")}`);

  const temp = mkdtempSync(path.join(tmpdir(), "dinobrain-atomic-writers-"));
  try {
    const jsonPath = path.join(temp, "state.json");
    writeFileSync(jsonPath, `${JSON.stringify({ generation: "old" })}\n`, "utf8");
    let rejected = false;
    try {
      await atomicWriteText(jsonPath, "{invalid}\n", async (candidatePath) => {
        JSON.parse(readFileSync(candidatePath, "utf8"));
      });
    } catch {
      rejected = true;
    }
    assert(rejected, "invalid candidate was not rejected before publication");
    assert(JSON.parse(readFileSync(jsonPath, "utf8")).generation === "old", "failed validation replaced the prior file");

    await Promise.all(
      Array.from({ length: 24 }, (_, index) => atomicWriteJson(jsonPath, { generation: index, payload: "x".repeat(128) })),
    );
    const final = JSON.parse(readFileSync(jsonPath, "utf8"));
    assert(Number.isInteger(final.generation), "concurrent publication produced invalid JSON");
    assert(final.payload.length === 128, "concurrent publication produced partial JSON");
    const leaked = readdirSync(temp).filter((entry) => entry.endsWith(".tmp") || entry.includes(".tmp."));
    assert(leaked.length === 0, `temporary publication files leaked: ${leaked.join(",")}`);

    console.log(
      JSON.stringify(
        {
          ok: true,
          production_direct_writer_count: directWrites.length,
          concurrent_writers: 24,
          failed_validation_preserved_previous: true,
          final_json_parseable: true,
          leaked_temp_files: leaked.length,
        },
        null,
        2,
      ),
    );
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
