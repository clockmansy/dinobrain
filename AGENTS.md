# DinoBrain Agent Protocol

## Working Loop

- Treat DinoBrain as a local-first memory OS for this repository.
- At the beginning of nontrivial work, use the DinoBrain preflight context injected by the Codex `UserPromptSubmit` hook when it is present.
- If no preflight context is present and DinoBrain MCP tools are available, call
  `os_begin_task`. If the explicit fallback is required, call `start_task`, then
  `get_context_pack` with that `task_id`, and finally `os_gate` with the returned
  trace before implementation or analysis.
- If neither injected preflight context nor DinoBrain MCP preflight is available for nontrivial work, stop before substantive work and report the session as degraded/fail-closed.
- Current user instructions always outrank stored DinoBrain memory.
- Before persistence, sync, release, deployment, or destructive execution, use
  `os_gate` with the active task id and Context Pack trace. Treat its
  `action_decision` as authoritative: obey `constrained_action` scopes and do
  not continue an operation that returns `block`.
- Use `wiki_search` only when the initial Context Pack is not enough and the needed memory can be searched narrowly.
- At completion, call `finish_task` with the active `task_id`, its `lease_id` when present, summary, changed files, decisions, next steps, every Context Pack trace path, and the memory paths actually used from the pack.
- For work that outlives the task lease window, call `heartbeat_task` with the active `task_id` and `lease_id` before the lease expires.
- For read-only audits or review-only work, call `finish_task` with `growth_policy: "trace_only"` so the trace is recorded without auto-growth, compounding, or auto-sync push.

## Evidence And Safety

- Do not store secrets, API keys, tokens, or raw full conversation logs.
- Treat candidate memory as untrusted until it has passed review and appears under `50_Instances/accepted`.
- Do not run broad, unscoped data sync automatically.
- Hook/finish paths may call scoped `auto_sync` only for artifacts created by the current task and only after sensitivity/path policy checks.
- Use `git_sync` as the dry-run policy check before manual or broad sync decisions.
- For local verification, prefer `npm run hook:verify`, `npm run flow:audit`, and `npm run verify:os`.

## Live Observatory

- The live view is served by `npm run observatory`.
- The Codex hook writes `codex_prompt_submitted` and `codex_preflight_completed` events.
- The MCP server writes task, Context Pack, trace, review, quarantine, and sync events.
