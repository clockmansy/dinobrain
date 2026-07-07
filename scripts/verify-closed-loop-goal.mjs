import { spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function latestExistingMtime(paths) {
  const times = paths
    .filter((filePath) => existsSync(filePath))
    .map((filePath) => statSync(filePath).mtime.getTime())
    .filter((time) => Number.isFinite(time));
  if (times.length === 0) return null;
  return new Date(Math.max(...times));
}

function liveProofSinceIso() {
  const programData = process.env.ProgramData || "C:\\ProgramData";
  const latestConfig = latestExistingMtime([
    process.env.DINOBRAIN_CODEX_HOOKS_PATH ?? path.join(homedir(), ".codex", "hooks.json"),
    process.env.DINOBRAIN_CODEX_REQUIREMENTS_PATH ??
      path.join(programData, "OpenAI", "Codex", "requirements.toml"),
    path.join(root, "dist", "index.js"),
  ]);
  const fallback = new Date(Date.now() - 24 * 60 * 60 * 1000);
  return (latestConfig ?? fallback).toISOString();
}

function tail(value, max = 4000) {
  const text = String(value ?? "");
  return text.length > max ? text.slice(text.length - max) : text;
}

function parseJsonFromStdout(stdout) {
  const text = String(stdout ?? "").trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(text.slice(start, end + 1));
      } catch {
        return null;
      }
    }
  }
  return null;
}

function runCheck({ id, description, command, args, timeoutMs = 120000, required = true }) {
  const startedAt = Date.now();
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    timeout: timeoutMs,
    windowsHide: true,
    env: {
      ...process.env,
    },
  });
  const elapsedMs = Date.now() - startedAt;
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  const parsed = parseJsonFromStdout(stdout);
  const ok = result.status === 0;
  return {
    id,
    description,
    required,
    ok,
    exit_code: result.status,
    signal: result.signal ?? null,
    elapsed_ms: elapsedMs,
    parsed,
    stdout_tail: ok ? undefined : tail(stdout),
    stderr_tail: ok ? undefined : tail(stderr),
  };
}

function classifyLiveBlocker(check) {
  const parsed = check.parsed;
  if (!parsed) return "live_preflight_unparsed_failure";
  if (parsed.process_diagnostics?.stale_codex_count > 0) return "stale_codex_processes";
  if (parsed.process_diagnostics?.stale_mcp_count > 0) return "stale_dinobrain_mcp_processes";
  const hasRunnableHook = parsed.user_prompt_hook?.ok === true || parsed.managed_prompt_hook?.ok === true;
  if (!hasRunnableHook) return "user_prompt_hook_not_registered";
  if (parsed.hook_runtime?.ok !== true) return "codex_hooks_runtime_not_enabled";
  if (!parsed.submitted_event && parsed.managed_prompt_hook?.ok === true) {
    return "managed_prompt_hook_seen_but_no_live_event";
  }
  if (!parsed.submitted_event && parsed.user_prompt_hook?.trust_review_likely_required === true) {
    return "user_prompt_hook_trust_required";
  }
  if (!parsed.submitted_event && parsed.thread_diagnostics?.recent_threads_after_hooks_count > 0) {
    return "fresh_codex_thread_seen_but_no_hook_event";
  }
  if (parsed.thread_diagnostics?.current_thread_stale_for_hooks) return "current_codex_thread_stale_for_hooks";
  if (!parsed.submitted_event) return "missing_live_codex_desktop_prompt_event";
  if (!parsed.completed_event) return "missing_live_preflight_completion_event";
  if (!parsed.live_report) return "missing_live_hook_report";
  return "unknown_live_preflight_failure";
}

function hasLiveMemoryEvidence(check) {
  const parsed = check.parsed;
  return Boolean(
    parsed?.submitted_event &&
      parsed?.completed_event &&
      parsed?.live_report &&
      Array.isArray(parsed.live_report.context_paths) &&
      parsed.live_report.context_paths.length > 0,
  );
}

function hasMcpPreflightEvidence(check) {
  const parsed = check.parsed;
  return Boolean(
    parsed?.ok === true &&
      parsed?.proof?.task_id &&
      parsed?.proof?.trace_path &&
      parsed?.proof?.context_pack_trace &&
      parsed?.proof?.context_item_count > 0 &&
      parsed?.proof?.event_order_verified === true,
  );
}

function hasClosedLoopEvidence(check) {
  const parsed = check.parsed;
  return Boolean(
    parsed?.ok === true &&
      parsed?.hook_context_pack_trace &&
      parsed?.finish_trace_path &&
      Array.isArray(parsed?.finish_growth_paths) &&
      parsed.finish_growth_paths.length > 0 &&
      parsed?.reviewed_growth_auto_sync_commit &&
      parsed?.finish_auto_sync_commit,
  );
}

function nextActionFor(requirementEvidence) {
  const blocker = requirementEvidence.find((item) => !item.ok)?.blocker;
  switch (blocker) {
    case undefined:
      return "Goal evidence is complete. It is now safe to mark the goal complete after reviewing this report.";
    case "stale_codex_processes":
      return "Run npm run codex:hooks:approval so Codex reloads hooks, then run npm run codex:live-proof, approve the DinoBrain hook in /hooks if prompted, paste the proof prompt into a fresh Codex Desktop thread, and rerun npm run verify:goal.";
    case "current_codex_thread_stale_for_hooks":
      return "The current Codex thread predates hooks.json. Run npm run codex:live-proof, paste the copied proof prompt into a newly created Codex Desktop thread, wait for the proof window to pass, then rerun npm run verify:goal.";
    case "user_prompt_hook_trust_required":
      return "The DinoBrain UserPromptSubmit hook is registered, but no persisted trusted hash/state is visible. In Codex, run /hooks, trust the DinoBrain hook for the current command hash, paste the live-proof prompt into a fresh Codex Desktop workspace thread, then rerun npm run verify:goal.";
    case "managed_prompt_hook_seen_but_no_live_event":
      return "The managed DinoBrain hook is installed, but no live Codex Desktop event has appeared yet. Fully restart Codex, paste the live-proof prompt into a fresh Codex Desktop workspace thread, then rerun npm run verify:goal.";
    case "fresh_codex_thread_seen_but_no_hook_event":
      return "A Codex thread was created after hooks.json, but no DinoBrain UserPromptSubmit event was written. Do not use app-thread delegation as proof; open a trusted Codex Desktop workspace thread, approve the DinoBrain hook in /hooks if prompted, paste the live-proof prompt manually, then rerun npm run verify:goal.";
    case "user_prompt_hook_not_registered":
    case "codex_hooks_runtime_not_enabled":
      return "Run the DinoBrain installer or npm run codex:hooks:diagnose, fix the hook registration/runtime failure, then rerun npm run verify:goal.";
    case "stale_dinobrain_mcp_processes":
      return "Run npm run codex:hooks:approval so stale DinoBrain MCP processes are restarted, then rerun npm run verify:goal.";
    case "missing_live_codex_desktop_prompt_event":
      return "Run npm run codex:live-proof, approve the DinoBrain hook in /hooks if prompted, paste the proof prompt into a fresh Codex Desktop thread, then rerun npm run verify:goal.";
    case "missing_live_preflight_completion_event":
    case "missing_live_hook_report":
      return "Inspect the latest reports/live-hooks output and .dino/events entries for the proof prompt, fix the hook completion/reporting path, then rerun npm run verify:goal.";
    default:
      return "Fix the failed requirement, then rerun npm run verify:goal.";
  }
}

function main() {
  const node = process.execPath;
  const liveSince = liveProofSinceIso();
  const checks = [
    runCheck({
      id: "codex_live_pre_response",
      description:
        "Real Codex Desktop prompt must dispatch DinoBrain UserPromptSubmit before response and write live hook evidence.",
      command: node,
      args: ["scripts/verify-codex-live-preflight.mjs", "--require-snippet=false", "--since", liveSince],
    }),
    runCheck({
      id: "codex_mcp_pre_response",
      description:
        "Real Codex app thread must run DinoBrain start_task, Context Pack retrieval, and finish_task before substantive response when injected hook context is absent.",
      command: node,
      args: ["scripts/verify-codex-mcp-preflight-proof.mjs"],
      required: false,
    }),
    runCheck({
      id: "closed_loop_fixture_push",
      description:
        "Closed-loop fixture must prove hook context, finish_task, auto-growth, review, and policy-approved push.",
      command: node,
      args: ["scripts/verify-codex-closed-loop.mjs"],
    }),
    runCheck({
      id: "full_memory_audit_regression",
      description:
        "Full-memory audit must baseline the data vault, classify live OS drift, flag unclassified content drift, and catch parse errors.",
      command: node,
      args: ["scripts/verify-full-memory-audit.mjs"],
    }),
    runCheck({
      id: "full_memory_audit_current",
      description:
        "Current data vault must have a reproducible full-memory audit with no unclassified drift or parse errors.",
      command: node,
      args: ["dist/build-full-memory-audit.js"],
    }),
    runCheck({
      id: "status_freshness_regression",
      description:
        "Status freshness must detect healthy, stale, and missing proof-artifact states in a temporary vault.",
      command: node,
      args: ["scripts/verify-status-freshness.mjs"],
    }),
    runCheck({
      id: "status_freshness_current",
      description:
        "Current data vault status artifacts must be present and fresh against their source roots.",
      command: node,
      args: ["dist/build-status-freshness.js"],
    }),
    runCheck({
      id: "review_settlement_regression",
      description:
        "Review queue settlement must classify residual promotion items and prove deterministic auto-hold application is safe.",
      command: node,
      args: ["scripts/verify-review-settlement.mjs"],
    }),
    runCheck({
      id: "review_settlement_current",
      description:
        "Current review queue and semantic jobs must have zero unclassified open items and no remaining deterministic auto-hold candidates.",
      command: node,
      args: ["dist/build-review-settlement.js"],
    }),
    runCheck({
      id: "task_lifecycle_regression",
      description:
        "Task lifecycle verifier must detect stale active tasks, missing terminal traces, orphan traces, and ungrounded finishes.",
      command: node,
      args: ["scripts/verify-task-lifecycle.mjs"],
    }),
    runCheck({
      id: "task_lifecycle_current",
      description:
        "Current task sessions must have no stale active tasks, orphan traces, missing terminal traces, or ungrounded finishes.",
      command: node,
      args: ["dist/build-task-lifecycle.js"],
    }),
    runCheck({
      id: "task_lifecycle_settlement_regression",
      description:
        "Task lifecycle settlement must auto-close only stale diagnostic tasks and leave manual repair blockers visible.",
      command: node,
      args: ["scripts/verify-task-lifecycle-settlement.mjs"],
    }),
    runCheck({
      id: "task_lifecycle_settlement_current",
      description:
        "Current task lifecycle settlement must have no remaining auto-close candidates.",
      command: node,
      args: ["dist/build-task-lifecycle-settlement.js"],
    }),
    runCheck({
      id: "rag_eval_regression",
      description:
        "RAG evaluator must distinguish lexical fallback from dense hybrid retrieval and prove memory-on lift on a fixture.",
      command: node,
      args: ["scripts/verify-rag-eval.mjs"],
    }),
    runCheck({
      id: "rag_eval_current",
      description:
        "Current data vault must pass RAG canaries with memory-on lift, provenance signals, and active dense hybrid retrieval.",
      command: node,
      args: ["dist/build-rag-eval.js"],
    }),
    runCheck({
      id: "os_memory_growth_quality",
      description:
        "OS verifier must prove configured MCP tools, compounding memory loop, retrieval quality, and behavior quality.",
      command: node,
      args: ["scripts/verify-dinobrain-os.mjs"],
    }),
    runCheck({
      id: "data_git_safety_hooks",
      description: "Data repo Git hooks must block local-only and unreviewed generated memory paths.",
      command: node,
      args: ["scripts/verify-data-git-hooks.mjs"],
    }),
    runCheck({
      id: "public_data_safety",
      description: "Public data safety scan must have zero blockers before any public GitHub data posture claim.",
      command: node,
      args: ["scripts/verify-public-data-safety.mjs"],
    }),
  ];

  const byId = Object.fromEntries(checks.map((check) => [check.id, check]));
  const liveMemoryEvidence = hasLiveMemoryEvidence(byId.codex_live_pre_response);
  const mcpPreflightEvidence = hasMcpPreflightEvidence(byId.codex_mcp_pre_response);
  const requirementEvidence = [
    {
      requirement: "pre_response_os_for_real_codex_desktop_hook",
      ok: byId.codex_live_pre_response.ok === true,
      evidence: "codex_live_pre_response",
      blocker: byId.codex_live_pre_response.ok ? null : classifyLiveBlocker(byId.codex_live_pre_response),
    },
    {
      requirement: "pre_response_os_for_real_codex_session",
      ok: byId.codex_live_pre_response.ok === true || mcpPreflightEvidence,
      evidence: "codex_live_pre_response || codex_mcp_pre_response",
      blocker:
        byId.codex_live_pre_response.ok === true || mcpPreflightEvidence
          ? null
          : "missing_real_codex_session_preflight",
    },
    {
      requirement: "memory_context_visible_before_agent_work",
      ok: liveMemoryEvidence || mcpPreflightEvidence,
      evidence: "codex_live_pre_response.live_report.context_paths || codex_mcp_pre_response.proof.context_paths",
      blocker: liveMemoryEvidence || mcpPreflightEvidence ? null : "missing_pre_response_context_paths",
    },
    {
      requirement: "finish_growth_review_and_github_push_loop",
      ok: hasClosedLoopEvidence(byId.closed_loop_fixture_push),
      evidence: "closed_loop_fixture_push",
      blocker: hasClosedLoopEvidence(byId.closed_loop_fixture_push) ? null : "closed_loop_fixture_incomplete",
    },
    {
      requirement: "full_memory_audit_reproducible",
      ok: byId.full_memory_audit_regression.ok === true && byId.full_memory_audit_current.ok === true,
      evidence: "full_memory_audit_regression + full_memory_audit_current",
      blocker:
        byId.full_memory_audit_regression.ok === true && byId.full_memory_audit_current.ok === true
          ? null
          : "full_memory_audit_failed",
    },
    {
      requirement: "status_freshness_current_and_regression",
      ok: byId.status_freshness_regression.ok === true && byId.status_freshness_current.ok === true,
      evidence: "status_freshness_regression + status_freshness_current",
      blocker:
        byId.status_freshness_regression.ok === true && byId.status_freshness_current.ok === true
          ? null
          : "status_freshness_failed",
    },
    {
      requirement: "review_queue_and_semantic_job_settlement",
      ok: byId.review_settlement_regression.ok === true && byId.review_settlement_current.ok === true,
      evidence: "review_settlement_regression + review_settlement_current",
      blocker:
        byId.review_settlement_regression.ok === true && byId.review_settlement_current.ok === true
          ? null
          : "review_settlement_failed",
    },
    {
      requirement: "task_session_lifecycle_and_finish_gate_integrity",
      ok: byId.task_lifecycle_regression.ok === true && byId.task_lifecycle_current.ok === true,
      evidence: "task_lifecycle_regression + task_lifecycle_current",
      blocker:
        byId.task_lifecycle_regression.ok === true && byId.task_lifecycle_current.ok === true
          ? null
          : "task_lifecycle_finish_gate_failed",
    },
    {
      requirement: "task_lifecycle_auto_settlement_applied",
      ok:
        byId.task_lifecycle_settlement_regression.ok === true &&
        byId.task_lifecycle_settlement_current.ok === true,
      evidence: "task_lifecycle_settlement_regression + task_lifecycle_settlement_current",
      blocker:
        byId.task_lifecycle_settlement_regression.ok === true &&
        byId.task_lifecycle_settlement_current.ok === true
          ? null
          : "task_lifecycle_auto_settlement_failed",
    },
    {
      requirement: "real_rag_eval_memory_on_off_and_hybrid_quality",
      ok: byId.rag_eval_regression.ok === true && byId.rag_eval_current.ok === true,
      evidence: "rag_eval_regression + rag_eval_current",
      blocker:
        byId.rag_eval_regression.ok === true && byId.rag_eval_current.ok === true
          ? null
          : "real_rag_eval_failed",
    },
    {
      requirement: "os_memory_growth_and_retrieval_quality",
      ok: byId.os_memory_growth_quality.ok === true,
      evidence: "os_memory_growth_quality",
      blocker: byId.os_memory_growth_quality.ok ? null : "os_verifier_failed",
    },
    {
      requirement: "data_push_safety_guardrails",
      ok: byId.data_git_safety_hooks.ok === true && byId.public_data_safety.ok === true,
      evidence: "data_git_safety_hooks + public_data_safety",
      blocker:
        byId.data_git_safety_hooks.ok === true && byId.public_data_safety.ok === true
          ? null
          : "data_safety_verifier_failed",
    },
  ];

  const ok = checks.every((check) => check.ok || !check.required) && requirementEvidence.every((item) => item.ok);
  const report = {
    ok,
    generated_at: new Date().toISOString(),
    goal:
      "Any Codex session must run DinoBrain pre-response, expose memory context, perform work, grow knowledge, and push policy-approved GitHub data.",
    live_proof_since: liveSince,
    checks,
    requirements: requirementEvidence,
    next_action: nextActionFor(requirementEvidence),
  };
  console.log(JSON.stringify(report, null, 2));
  if (!ok) process.exit(1);
}

main();
