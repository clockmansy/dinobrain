import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const modulePath = pathToFileURL(path.join(root, "dist", "task-lifecycle.js")).href;
const {
  buildAndWriteTaskLifecycleReport,
  TASK_FINISH_GROUNDING_RELATIVE_PATH,
  TASK_LIFECYCLE_STATUS_RELATIVE_PATH,
} = await import(modulePath);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function json(filePath, value) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function seedFinishedTask(dataRoot, id, extraTrace = {}, extraTask = {}) {
  json(path.join(dataRoot, ".dino", "tasks", `${id}.json`), {
    task_id: id,
    status: "completed",
    request: `Finish ${id}`,
    created_at: "2026-07-07T00:00:00.000Z",
    updated_at: "2026-07-07T00:01:00.000Z",
    finished_at: "2026-07-07T00:01:00.000Z",
    trace_path: `.dino/traces/${id}.json`,
    ...extraTask,
  });
  json(path.join(dataRoot, ".dino", "traces", `${id}.json`), {
    task_id: id,
    outcome: "completed",
    summary: `Completed ${id}.`,
    changed_files: ["src/example.ts"],
    decisions: ["Used grounded fixture evidence."],
    next_steps: [],
    used_memory_paths: ["50_Instances/accepted/example.json"],
    context_pack_paths: [".dino/context-packs/example.json"],
    finished_at: "2026-07-07T00:01:00.000Z",
    ...extraTrace,
  });
}

async function main() {
  const cleanRoot = mkdtempSync(path.join(tmpdir(), "dinobrain-task-lifecycle-clean-"));
  const dirtyRoot = mkdtempSync(path.join(tmpdir(), "dinobrain-task-lifecycle-dirty-"));
  try {
    seedFinishedTask(cleanRoot, "task-clean");
    let result = await buildAndWriteTaskLifecycleReport(cleanRoot, {
      now: new Date("2026-07-07T02:00:00.000Z"),
      staleAfterMs: 24 * 60 * 60 * 1000,
    });
    assert(result.report.status === "healthy", `clean report should be healthy, got ${result.report.status}`);
    assert(result.report.counts.blockers === 0, "clean report had blockers");
    assert(existsSync(path.join(cleanRoot, TASK_LIFECYCLE_STATUS_RELATIVE_PATH)), "task lifecycle status missing");
    assert(existsSync(path.join(cleanRoot, TASK_FINISH_GROUNDING_RELATIVE_PATH)), "finish grounding jsonl missing");

    seedFinishedTask(dirtyRoot, "task-grounded");
    json(path.join(dirtyRoot, ".dino", "tasks", "task-stale.json"), {
      task_id: "task-stale",
      status: "started",
      request: "Old unfinished task",
      created_at: "2026-07-01T00:00:00.000Z",
      updated_at: "2026-07-01T00:00:00.000Z",
    });
    json(path.join(dirtyRoot, ".dino", "tasks", "task-missing-trace.json"), {
      task_id: "task-missing-trace",
      status: "completed",
      request: "Completed without trace",
      created_at: "2026-07-07T00:00:00.000Z",
      updated_at: "2026-07-07T00:02:00.000Z",
      finished_at: "2026-07-07T00:02:00.000Z",
      trace_path: ".dino/traces/task-missing-trace.json",
    });
    json(path.join(dirtyRoot, ".dino", "tasks", "task-ungrounded.json"), {
      task_id: "task-ungrounded",
      status: "completed",
      request: "Ungrounded finish",
      created_at: "2026-07-07T00:00:00.000Z",
      updated_at: "2026-07-07T00:03:00.000Z",
      finished_at: "2026-07-07T00:03:00.000Z",
      trace_path: ".dino/traces/task-ungrounded.json",
    });
    json(path.join(dirtyRoot, ".dino", "traces", "task-ungrounded.json"), {
      task_id: "task-ungrounded",
      outcome: "completed",
      summary: "",
      changed_files: [],
      decisions: [],
      next_steps: [],
      finished_at: "2026-07-07T00:03:00.000Z",
    });
    json(path.join(dirtyRoot, ".dino", "traces", "orphan.json"), {
      task_id: "task-orphan",
      outcome: "completed",
      summary: "Trace has no task.",
      changed_files: ["src/orphan.ts"],
      finished_at: "2026-07-07T00:04:00.000Z",
    });

    result = await buildAndWriteTaskLifecycleReport(dirtyRoot, {
      now: new Date("2026-07-07T02:00:00.000Z"),
      staleAfterMs: 60 * 60 * 1000,
    });
    assert(result.report.status === "needs_attention", "dirty report did not require attention");
    assert(result.report.counts.stale_active === 1, "stale active task not detected");
    assert(result.report.counts.terminal_missing_trace === 1, "missing terminal trace not detected");
    assert(result.report.counts.trace_without_task === 1, "orphan trace not detected");
    assert(result.report.counts.ungrounded_finish >= 1, "ungrounded finish not detected");
    assert(result.report.counts.blockers >= 4, "dirty report blocker count too low");
    const persisted = JSON.parse(readFileSync(path.join(dirtyRoot, TASK_LIFECYCLE_STATUS_RELATIVE_PATH), "utf8"));
    assert(persisted.visible_status, "persisted lifecycle report missing visible status");

    console.log("task lifecycle verification ok");
  } finally {
    rmSync(cleanRoot, { recursive: true, force: true });
    rmSync(dirtyRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  console.error(`cwd=${root}`);
  process.exit(1);
});
