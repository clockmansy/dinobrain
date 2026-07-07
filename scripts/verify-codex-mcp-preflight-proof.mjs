import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataRoot = path.resolve(process.env.DINOBRAIN_DATA_DIR ?? path.join(root, "..", "dinobrain-data"));

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
  if (!value) return new Date(Date.now() - 2 * 60 * 60 * 1000);
  const parsed = new Date(value);
  assert(!Number.isNaN(parsed.getTime()), `Invalid --since value: ${value}`);
  return parsed;
}

function includesSnippet(value, snippet) {
  if (!snippet) return true;
  return String(value ?? "").toLowerCase().includes(snippet.toLowerCase());
}

function vaultPath(relativePath) {
  return path.join(dataRoot, String(relativePath).replace(/\//g, path.sep));
}

function loadEvents(since) {
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
    .sort((a, b) => String(a.at ?? "").localeCompare(String(b.at ?? "")));
}

function loadCandidateTasks(since, snippet) {
  const taskRoot = path.join(dataRoot, ".dino", "tasks");
  return filesUnder(taskRoot, ".json")
    .map((filePath) => ({
      ...readJson(filePath),
      _path: path.relative(dataRoot, filePath).split(path.sep).join("/"),
    }))
    .filter((task) => {
      const createdAt = new Date(String(task.created_at ?? ""));
      return (
        !Number.isNaN(createdAt.getTime()) &&
        createdAt >= since &&
        includesSnippet(task.request, snippet) &&
        task.status === "completed" &&
        typeof task.trace_path === "string"
      );
    })
    .sort((a, b) => String(b.created_at ?? "").localeCompare(String(a.created_at ?? "")));
}

function buildProof(task, events) {
  const taskPath = task._path;
  const tracePath = task.trace_path;
  const traceFullPath = vaultPath(tracePath);
  if (!existsSync(traceFullPath)) return null;
  const trace = readJson(traceFullPath);
  const contextPackPaths = Array.isArray(trace.context_pack_paths) ? trace.context_pack_paths : [];
  const packs = contextPackPaths
    .filter((packPath) => existsSync(vaultPath(packPath)))
    .map((packPath) => ({
      path: packPath,
      content: readJson(vaultPath(packPath)),
    }))
    .filter((pack) => Array.isArray(pack.content.items) && pack.content.items.length > 0);
  if (packs.length === 0) return null;

  const taskStarted = events.find((event) => event.event === "task_started" && event.task_id === task.task_id);
  const packCreated = events.find(
    (event) =>
      event.event === "context_pack_created" &&
      event.path &&
      packs.some((pack) => pack.path === event.path),
  );
  const taskFinished = events.find((event) => event.event === "task_finished" && event.task_id === task.task_id);
  const taskAt = new Date(String(taskStarted?.at ?? task.created_at ?? ""));
  const packAt = new Date(String(packCreated?.at ?? packs[0].content.created_at ?? ""));
  const finishAt = new Date(String(taskFinished?.at ?? trace.finished_at ?? ""));
  const ordered =
    !Number.isNaN(taskAt.getTime()) &&
    !Number.isNaN(packAt.getTime()) &&
    !Number.isNaN(finishAt.getTime()) &&
    taskAt <= packAt &&
    packAt <= finishAt;

  return {
    task_id: task.task_id,
    task_path: taskPath,
    request: task.request,
    task_started_at: taskStarted?.at ?? task.created_at ?? null,
    context_pack_trace: packs[0].path,
    context_item_count: packs[0].content.items.length,
    context_paths: packs[0].content.items.map((item) => item.path).filter(Boolean),
    retrieval_mode: packs[0].content.retrieval_mode ?? null,
    trace_path: tracePath,
    trace_outcome: trace.outcome ?? null,
    finished_at: taskFinished?.at ?? trace.finished_at ?? null,
    event_order_verified: ordered,
    decisions: Array.isArray(trace.decisions) ? trace.decisions : [],
  };
}

function main() {
  const snippet = argValue(
    "snippet",
    process.env.DINOBRAIN_CODEX_MCP_PREFLIGHT_SNIPPET ?? "DinoBrain live hook proof",
  );
  const since = sinceDate(argValue("since", process.env.DINOBRAIN_CODEX_MCP_PREFLIGHT_SINCE ?? ""));
  const events = loadEvents(since);
  const tasks = loadCandidateTasks(since, snippet);
  const proofs = tasks.map((task) => buildProof(task, events)).filter(Boolean);
  const proof = proofs.find((item) => item.event_order_verified && item.context_item_count > 0) ?? proofs[0] ?? null;

  const result = {
    ok: Boolean(proof?.event_order_verified && proof?.context_item_count > 0),
    generated_at: new Date().toISOString(),
    data_root: dataRoot,
    home: homedir(),
    since: since.toISOString(),
    snippet,
    candidate_task_count: tasks.length,
    event_count_after_since: events.length,
    proof,
  };

  console.log(JSON.stringify(result, null, 2));
  assert(result.ok, `no ordered Codex MCP preflight proof found for snippet "${snippet}"`);
}

try {
  main();
} catch (error) {
  console.error(error);
  process.exit(1);
}
