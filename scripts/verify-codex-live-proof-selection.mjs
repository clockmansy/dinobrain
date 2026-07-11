import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { DINOBRAIN_VERSION } from "./lib/version-manifest.mjs";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataRoot = mkdtempSync(path.join(tmpdir(), "dinobrain-live-proof-selection-"));
process.env.DINOBRAIN_DATA_DIR = dataRoot;
const { findLatestCompleteLiveProof } = await import(
  `${pathToFileURL(path.join(root, "scripts", "verify-codex-live-preflight.mjs")).href}?fixture=${Date.now()}`
);

function proofChain(id, version, baseTime) {
  const hookRunId = `hook-${id}`;
  const taskId = `task-${id}`;
  const promptHash = createHash("sha256").update(`prompt-${id}`).digest("hex");
  const traceRelative = `.dino/context-packs/${id}.json`;
  const tracePath = path.join(dataRoot, ...traceRelative.split("/"));
  mkdirSync(path.dirname(tracePath), { recursive: true });
  writeFileSync(tracePath, `${JSON.stringify({ id, version })}\n`, "utf8");
  const traceSha256 = createHash("sha256").update(Buffer.from(`${JSON.stringify({ id, version })}\n`)).digest("hex");
  const at = (offset) => new Date(baseTime + offset).toISOString();
  const launch = { launch_kind: "codex_desktop" };
  const submitted = {
    event: "codex_prompt_submitted",
    source: "codex_hook",
    hook_run_id: hookRunId,
    prompt_hash: promptHash,
    prompt_preview: `proof ${id}`,
    at: at(0),
    launch_provenance: launch,
  };
  const task = { event: "task_started", task_id: taskId, hook_run_id: hookRunId, os_version: version, at: at(10) };
  const context = {
    event: "context_pack_created",
    task_id: taskId,
    hook_run_id: hookRunId,
    os_version: version,
    at: at(20),
  };
  const begin = {
    event: "os_begin_task_completed",
    task_id: taskId,
    hook_run_id: hookRunId,
    os_version: version,
    at: at(30),
  };
  const completed = {
    event: "codex_preflight_completed",
    source: "codex_hook",
    task_id: taskId,
    hook_run_id: hookRunId,
    prompt_hash: promptHash,
    at: at(40),
    launch_provenance: launch,
    preflight_event_order_verified: true,
    context_delivery_status: "ready_for_model",
    context_delivery_nonce: `nonce-${id}`,
    context_delivery_sha256: createHash("sha256").update(`delivery-${id}`).digest("hex"),
    context_trace_sha256: traceSha256,
    action_decision: "allow",
    fail_closed: false,
  };
  const report = {
    ...completed,
    os_version: version,
    context_pack_trace: traceRelative,
    context_paths: [traceRelative],
    context_trace_verified: true,
    context_trace_fresh: true,
  };
  return { events: [submitted, task, context, begin, completed], report, submitted };
}

try {
  const minimumDate = new Date("2026-07-12T00:00:00.000Z");
  const old = proofChain("old", "2.2.11", minimumDate.getTime() - 60_000);
  const current = proofChain("current", DINOBRAIN_VERSION, minimumDate.getTime() + 1_000);
  const newerWrongVersion = proofChain("newer-wrong", "2.2.11", minimumDate.getTime() + 2_000);
  const events = [...old.events, ...current.events, ...newerWrongVersion.events].sort((a, b) => a.at.localeCompare(b.at));
  const reports = [old.report, current.report, newerWrongVersion.report].sort((a, b) => a.at.localeCompare(b.at));
  const selected = findLatestCompleteLiveProof(events, reports, "proof", {
    minimumDate,
    requiredVersion: DINOBRAIN_VERSION,
  });
  assert(selected?.submitted.hook_run_id === current.submitted.hook_run_id, "latest valid current-version proof was not selected");

  const invalidOnly = findLatestCompleteLiveProof(
    [...old.events, ...newerWrongVersion.events].sort((a, b) => a.at.localeCompare(b.at)),
    [old.report, newerWrongVersion.report].sort((a, b) => a.at.localeCompare(b.at)),
    "proof",
    { minimumDate, requiredVersion: DINOBRAIN_VERSION },
  );
  assert(invalidOnly === null, "stale or version-mismatched proof produced a false green result");
  console.log("codex live proof selection verification ok");
} finally {
  rmSync(dataRoot, { recursive: true, force: true });
}
