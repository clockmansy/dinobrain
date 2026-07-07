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
    maxBuffer: 64 * 1024 * 1024,
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

function hasGeneratedAnswerQualityEvidence(parsed) {
  const candidates = [parsed?.generated_answer_eval, parsed?.answer_quality, parsed?.ragas_eval].filter(Boolean);
  return candidates.some((candidate) => {
    const status = candidate?.status;
    const metrics = candidate?.metrics ?? candidate;
    return Boolean(
      (status === "healthy" || status === "passed" || status === "verified") &&
        typeof metrics?.faithfulness === "number" &&
        typeof (metrics?.answer_relevance ?? metrics?.answer_relevancy) === "number" &&
        typeof (metrics?.correctness ?? metrics?.answer_correctness) === "number" &&
        typeof (metrics?.grounding ?? metrics?.source_support) === "number",
    );
  });
}

function classifyRagCompletionBlocker(proofCheck, evalCheck) {
  if (proofCheck.ok !== true || evalCheck.ok !== true) return "real_rag_eval_failed";
  const proof = proofCheck.parsed;
  const evalReport = evalCheck.parsed;
  const denseVector = proof?.dense_vector;
  if (denseVector?.semantic_embedding_provider !== true) return "rag_semantic_provider_not_configured";
  if (denseVector?.provider === "local_text_hashing_v1") return "rag_text_hashing_scaffold_only";
  const caveats = Array.isArray(evalReport?.caveats) ? evalReport.caveats.join("\n") : "";
  if (/deterministic\s+RAG\s+canary|not\s+a\s+full\s+Ragas|not\s+a\s+full.*answer-quality/i.test(caveats)) {
    return "rag_deterministic_canary_only";
  }
  if (!hasGeneratedAnswerQualityEvidence(evalReport)) return "rag_answer_quality_eval_missing";
  return null;
}

function hasCompletionGradeRagEvidence(proofCheck, evalCheck) {
  return classifyRagCompletionBlocker(proofCheck, evalCheck) === null;
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
    case "direct_mcp_parity_not_verified":
      return "Create real Codex and Claude direct MCP proof artifacts under .dino/proofs/client-mcp, or record a valid Claude not_configured proof when Claude Code is absent, then rerun npm run status:mcp-direct and npm run verify:goal.";
    case "native_instruction_authority_not_healthy":
      return "Inspect .dino/state/native_instruction_authority.json, repair conflicting AGENTS/Codex/Claude/hook instructions, then rerun npm run status:native-authority and npm run verify:goal.";
    case "source_lineage_not_healthy":
      return "Run npm run status:source-lineage, repair missing source chunks, provenance links, verification_status, or dangling claim_paths, then rerun npm run verify:goal.";
    case "behavior_recall_not_healthy":
      return "Run npm run status:behavior-recall, repair missing/malformed recall ledger entries or correction conflict quarantine records, then rerun npm run verify:goal.";
    case "task_lifecycle_finish_gate_failed":
      return "Run npm run task:lifecycle and inspect .dino/state/task_sessions.json plus .dino/state/task_finish_grounding_classifications.jsonl, then repair or settle missing terminal traces before rerunning npm run verify:goal.";
    case "task_lifecycle_auto_settlement_failed":
      return "Run npm run task:lifecycle:settle -- --apply only after reviewing deterministic repair candidates, then rerun npm run task:lifecycle and npm run verify:goal.";
    case "rag_semantic_provider_not_configured":
    case "rag_text_hashing_scaffold_only":
    case "rag_deterministic_canary_only":
    case "rag_answer_quality_eval_missing":
      return "Configure a completion-grade semantic embedding provider or documented local multilingual model, add generated-answer RAG evaluation, rerun npm run rag:proof and npm run eval:rag, then rerun npm run verify:goal.";
    case "installer_new_pc_equivalence_failed":
      return "Run npm run installer:verify:version, npm run installer:verify:approval, npm run installer:verify:launchers, and npm run installer:verify:semantic-rag; repair installer drift, hook merge, launcher, or semantic RAG prewarm failures before rerunning npm run verify:goal.";
    default:
      return "Fix the failed requirement, then rerun npm run verify:goal.";
  }
}

function main() {
  const node = process.execPath;
  const powershell = process.env.ComSpec ? "powershell.exe" : "powershell";
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
        "Current data vault status artifacts must refresh in dependency order and then be fresh against their source roots.",
      command: node,
      args: ["dist/refresh-status-artifacts.js"],
    }),
    runCheck({
      id: "mcp_direct_regression",
      description:
        "Direct MCP parity status must reject config, hook, stale, alias-only, partial-tool, and single-client proofs while accepting exact single-name client proof artifacts.",
      command: node,
      args: ["scripts/verify-client-mcp-direct-status.mjs"],
    }),
    runCheck({
      id: "mcp_direct_current",
      description:
        "Current data vault must have verified direct Codex MCP proof and verified or explicitly not_configured Claude direct MCP proof.",
      command: node,
      args: ["dist/build-client-mcp-direct-status.js"],
    }),
    runCheck({
      id: "native_authority_regression",
      description:
        "Native instruction authority must accept clean AGENTS/Codex/Claude surfaces and reject memory-over-user, trusted-candidate, raw-transcript, broad-sync, and hook-trust-bypass conflicts.",
      command: node,
      args: ["scripts/verify-native-instruction-authority.mjs"],
    }),
    runCheck({
      id: "native_authority_current",
      description:
        "Current native AGENTS/Codex/Claude/hook instruction surfaces must preserve user-over-memory authority and safe memory policy.",
      command: node,
      args: ["dist/build-native-instruction-authority.js"],
    }),
    runCheck({
      id: "source_lineage_regression",
      description:
        "Source lineage must accept verified source chunk support and reject anchor-only support, missing provenance, dangling claim paths, missing body, missing URI, and missing verification status.",
      command: node,
      args: ["scripts/verify-source-lineage.mjs"],
    }),
    runCheck({
      id: "source_lineage_current",
      description:
        "Current data vault must distinguish internal behavior memory from factual claims and require verified source chunk plus provenance support for source-backed claims.",
      command: node,
      args: ["dist/build-source-lineage-status.js"],
    }),
    runCheck({
      id: "behavior_recall_regression",
      description:
        "Behavior recall ledger must write completion, handoff, error, direction-change, and correction entries, retrieve later corrections, and quarantine conflicting old behavior memory.",
      command: node,
      args: ["scripts/verify-behavior-recall.mjs"],
    }),
    runCheck({
      id: "behavior_recall_current",
      description:
        "Current data vault must have a well-formed behavior recall ledger and correction conflict quarantine evidence when corrections exist.",
      command: node,
      args: ["dist/build-behavior-recall-status.js"],
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
      id: "observatory_evidence",
      description:
        "Observatory must expose health/goal blockers, pending lanes, memory-audit paths, and invalid status artifacts through API and UI evidence.",
      command: node,
      args: ["scripts/verify-observatory-live-graph.mjs"],
    }),
    runCheck({
      id: "installer_version_alignment",
      description:
        "Installer must detect and repair app/data ref drift before claiming release or new-PC readiness.",
      command: powershell,
      args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "scripts/verify-installer-version-alignment.ps1"],
    }),
    runCheck({
      id: "installer_hook_merge",
      description:
        "Installer must preserve existing Codex/Claude prompt hooks while registering DinoBrain exactly once.",
      command: powershell,
      args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "scripts/verify-installer-hooks.ps1"],
    }),
    runCheck({
      id: "installer_launchers",
      description:
        "Installer must create Observatory, hook diagnose, approval, managed-hook, live-proof, and uninstall launchers.",
      command: powershell,
      args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "scripts/verify-installer-observatory-launcher.ps1"],
    }),
    runCheck({
      id: "installer_semantic_rag_prewarm",
      description:
        "Installer must rebuild semantic RAG proof/eval on a new PC with a real embedding provider and reject silent hashing fallback.",
      command: powershell,
      args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "scripts/verify-installer-semantic-rag.ps1"],
    }),
    runCheck({
      id: "rag_proof_regression",
      description:
        "RAG proof builder must write explicit rag-golden and dense-vector proof artifacts without pretending local hashing is an external embedding provider.",
      command: node,
      args: ["scripts/verify-rag-proof.mjs"],
    }),
    runCheck({
      id: "rag_proof_current",
      description:
        "Current data vault must have explicit rag-golden and dense-vector proof artifacts before RAG eval runs.",
      command: node,
      args: ["dist/build-rag-proof.js"],
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
        "Current data vault must pass RAG canaries; completion still requires semantic dense retrieval and generated-answer quality evidence.",
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
  const ragCompletionBlocker =
    byId.rag_proof_regression.ok === true && byId.rag_eval_regression.ok === true
      ? classifyRagCompletionBlocker(byId.rag_proof_current, byId.rag_eval_current)
      : "real_rag_eval_failed";
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
      requirement: "codex_claude_direct_mcp_parity",
      ok:
        byId.mcp_direct_regression.ok === true &&
        byId.mcp_direct_current.ok === true &&
        byId.mcp_direct_current.parsed?.status === "verified",
      evidence: "mcp_direct_regression + mcp_direct_current.status",
      blocker:
        byId.mcp_direct_regression.ok === true &&
        byId.mcp_direct_current.ok === true &&
        byId.mcp_direct_current.parsed?.status === "verified"
          ? null
          : "direct_mcp_parity_not_verified",
    },
    {
      requirement: "native_instruction_authority_and_drift_gate",
      ok:
        byId.native_authority_regression.ok === true &&
        byId.native_authority_current.ok === true &&
        byId.native_authority_current.parsed?.status === "healthy",
      evidence: "native_authority_regression + native_authority_current.status",
      blocker:
        byId.native_authority_regression.ok === true &&
        byId.native_authority_current.ok === true &&
        byId.native_authority_current.parsed?.status === "healthy"
          ? null
          : "native_instruction_authority_not_healthy",
    },
    {
      requirement: "source_chunk_claim_provenance_lineage",
      ok:
        byId.source_lineage_regression.ok === true &&
        byId.source_lineage_current.ok === true &&
        byId.source_lineage_current.parsed?.status === "healthy",
      evidence: "source_lineage_regression + source_lineage_current.status",
      blocker:
        byId.source_lineage_regression.ok === true &&
        byId.source_lineage_current.ok === true &&
        byId.source_lineage_current.parsed?.status === "healthy"
          ? null
          : "source_lineage_not_healthy",
    },
    {
      requirement: "behavior_recall_ledger_and_feedback_writeback",
      ok:
        byId.behavior_recall_regression.ok === true &&
        byId.behavior_recall_current.ok === true &&
        byId.behavior_recall_current.parsed?.status === "healthy",
      evidence: "behavior_recall_regression + behavior_recall_current.status",
      blocker:
        byId.behavior_recall_regression.ok === true &&
        byId.behavior_recall_current.ok === true &&
        byId.behavior_recall_current.parsed?.status === "healthy"
          ? null
          : "behavior_recall_not_healthy",
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
      requirement: "observatory_health_gate_alignment",
      ok: byId.observatory_evidence.ok === true,
      evidence: "observatory_evidence",
      blocker: byId.observatory_evidence.ok === true ? null : "observatory_evidence_failed",
    },
    {
      requirement: "install_new_pc_release_equivalence",
      ok:
        byId.installer_version_alignment.ok === true &&
        byId.installer_hook_merge.ok === true &&
        byId.installer_launchers.ok === true &&
        byId.installer_semantic_rag_prewarm.ok === true,
      evidence:
        "installer_version_alignment + installer_hook_merge + installer_launchers + installer_semantic_rag_prewarm",
      blocker:
        byId.installer_version_alignment.ok === true &&
        byId.installer_hook_merge.ok === true &&
        byId.installer_launchers.ok === true &&
        byId.installer_semantic_rag_prewarm.ok === true
          ? null
          : "installer_new_pc_equivalence_failed",
    },
    {
      requirement: "real_rag_eval_memory_on_off_and_hybrid_quality",
      ok:
        byId.rag_proof_regression.ok === true &&
        byId.rag_eval_regression.ok === true &&
        hasCompletionGradeRagEvidence(byId.rag_proof_current, byId.rag_eval_current),
      evidence:
        "rag_proof_regression + rag_eval_regression + completion-grade rag_proof_current/rag_eval_current semantic and answer-quality evidence",
      blocker:
        byId.rag_proof_regression.ok === true &&
        byId.rag_eval_regression.ok === true &&
        hasCompletionGradeRagEvidence(byId.rag_proof_current, byId.rag_eval_current)
          ? null
          : ragCompletionBlocker,
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
