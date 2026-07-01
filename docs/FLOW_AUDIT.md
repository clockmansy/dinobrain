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
| 5. Narrow extra search | `partially_verified` | `wiki_search` works; no separate `search_memory` tool exists yet. |
| 6. Finish task record | `verified` | `finish_task` writes summary/decisions/next steps plus structured `used_memory_paths` and `context_pack_paths`. |
| 7. Knowledge growth | `partially_verified` | Candidate -> accepted instance -> later Context Pack works; Wiki/semantic/correction/proposal flows are not separate yet. |
| 8. Backup/restore | `partially_verified` | Installer and repos exist; data sync remains dry-run/manual approval. |

## What Would Make It Fully True

To upgrade this from MCP-assisted memory to an automatic OS loop:

1. Trust the project hook in Codex and restart or open a new thread if the current session was already running.
2. Add a `search_memory` alias or broader memory search tool if non-Wiki records need a first-class search surface.
3. Add explicit growth record types:
   - Wiki promotion
   - semantic job
   - correction
   - proposal
4. Add a guarded commit/push workflow after `git_sync` policy stabilizes.

## Evidence

`flow:audit` creates a temporary vault and calls the DinoBrain MCP server through `StdioClientTransport`.

It verifies:

- tools are listable
- the Codex `UserPromptSubmit` hook can call DinoBrain preflight and return `additionalContext`
- `start_task` creates records
- `get_context_pack` retrieves user preference and project flow records
- `wiki_search` performs narrow body search
- `finish_task` writes trace data, including structured memory-use paths
- candidate approval produces an accepted instance
- the accepted instance is retrieved in a later Context Pack
- installer files and Git remotes are present
- `git_sync` remains dry-run only
