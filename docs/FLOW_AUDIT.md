# DinoBrain User Flow Audit

Date: 2026-07-01

This audit checks the end-to-end claim:

```text
User request -> OS provides compressed relevant memory -> agent works -> result and judgment are stored -> future work can inherit it.
```

Run:

```powershell
npm run build
npm run flow:audit
```

The audit is intentionally stricter than `smoke`.

The JSON report is written locally to:

```text
reports/dinobrain-flow-audit.json
```

## Current Result Shape

The current MVP now has a project Codex hook bridge plus the MCP memory system. A live Codex session must trust the project hook before automatic preflight runs.

Expected states:

| Step | Current state | Meaning |
| --- | --- | --- |
| 1. User request detection | `verified` | `.codex/hooks.json` configures `UserPromptSubmit`, and the hook verifier simulates `start_task` -> `get_context_pack` -> `additionalContext`. |
| 2. Start task record | `verified` | `start_task` creates task/event records. |
| 3. Context Pack | `verified` | `get_context_pack` returns focused records and writes a trace. |
| 4. Agent uses context with current instruction priority | `partially_verified` | Memory can state the rule, but model behavior is not enforced by DinoBrain runtime. |
| 5. Narrow extra search | `verified` | `wiki_search` and `search_memory` both work for narrow lookup. |
| 6. Finish task record | `verified` | `finish_task` writes summary/decisions/next steps plus structured `used_memory_paths` and `context_pack_paths`. |
| 7. Knowledge growth | `verified` | With `DINOBRAIN_AUTO_GROWTH=1` and `DINOBRAIN_AUTO_COMPOUND=1`, `finish_task` creates reusable task memory and runs behavior-rule compounding/cleanup. |
| 8. Backup/restore | `partially_verified` | Installer config enables sync policy checks by default, but public-safe installs keep conditional auto-push disabled unless explicitly opted in. |

## What Would Make It Fully True

To upgrade this from MCP-assisted memory to an automatic OS loop:

1. Trust the project hook in Codex and restart or open a new thread if the current session was already running.
2. Keep `verify:compounding`, `verify:v2`, and `verify:os` in the release checklist so regressions in the closed loop are caught before installer publication.
3. Expand the behavior golden set with real user-domain cases; the harness exists, but the quality of the proof depends on non-self-referential cases.

## Evidence

`flow:audit` creates a temporary vault and calls the DinoBrain MCP server through `StdioClientTransport`.

It verifies:

- tools are listable
- the Codex `UserPromptSubmit` hook can call DinoBrain preflight and return `additionalContext`
- `start_task` creates records
- `get_context_pack` retrieves user preference and project flow records
- `wiki_search` and `search_memory` perform narrow body search
- `finish_task` writes trace data, including structured memory-use paths and automatic compounding output
- `audit_memory_use` writes a short trust log for provided/declared/observed memory use
- candidate approval produces an accepted instance
- the accepted instance is retrieved in a later Context Pack
- behavior-rule compounding can promote, merge, and hold records
- installer files and Git remotes are present
- `git_sync` remains dry-run only for policy inspection; `auto_sync` performs guarded commit/push only for allowed scopes and explicit push settings
