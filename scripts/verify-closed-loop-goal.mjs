import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

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
  if (parsed.user_prompt_hook?.ok !== true) return "user_prompt_hook_not_registered";
  if (parsed.hook_runtime?.ok !== true) return "codex_hooks_runtime_not_enabled";
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
  const checks = [
    runCheck({
      id: "codex_live_pre_response",
      description:
        "Real Codex Desktop prompt must dispatch DinoBrain UserPromptSubmit before response and write live hook evidence.",
      command: node,
      args: ["scripts/verify-codex-live-preflight.mjs", "--require-snippet=false"],
    }),
    runCheck({
      id: "codex_mcp_pre_response",
      description:
        "Real Codex app thread must run DinoBrain start_task, Context Pack retrieval, and finish_task before substantive response when injected hook context is absent.",
      command: node,
      args: ["scripts/verify-codex-mcp-preflight-proof.mjs"],
    }),
    runCheck({
      id: "closed_loop_fixture_push",
      description:
        "Closed-loop fixture must prove hook context, finish_task, auto-growth, review, and policy-approved push.",
      command: node,
      args: ["scripts/verify-codex-closed-loop.mjs"],
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
    checks,
    requirements: requirementEvidence,
    next_action: nextActionFor(requirementEvidence),
  };
  console.log(JSON.stringify(report, null, 2));
  if (!ok) process.exit(1);
}

main();
