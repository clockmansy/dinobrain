# DinoBrain Agent Protocol

## Working Loop

- Treat DinoBrain as a local-first memory OS for this repository.
- At the beginning of nontrivial work, use the DinoBrain preflight context injected by the Codex `UserPromptSubmit` hook when it is present.
- If no preflight context is present and DinoBrain MCP tools are available, call `start_task` and then `get_context_pack` before implementation or analysis.
- Current user instructions always outrank stored DinoBrain memory.
- Use `wiki_search` only when the initial Context Pack is not enough and the needed memory can be searched narrowly.
- At completion, call `finish_task` with the active `task_id`, summary, changed files, decisions, and next steps.
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
