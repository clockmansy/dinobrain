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

The current MVP is not a fully automatic OS hook. It is a working MCP memory system that an agent can call.

Expected states:

| Step | Current state | Meaning |
| --- | --- | --- |
| 1. User request detection | `not_implemented` | No pre-task Codex hook automatically calls DinoBrain yet. |
| 2. Start task record | `verified` | `start_task` creates task/event records. |
| 3. Context Pack | `verified` | `get_context_pack` returns focused records and writes a trace. |
| 4. Agent uses context with current instruction priority | `partially_verified` | Memory can state the rule, but model behavior is not enforced by DinoBrain runtime. |
| 5. Narrow extra search | `partially_verified` | `wiki_search` works; no separate `search_memory` tool exists yet. |
| 6. Finish task record | `partially_verified` | `finish_task` writes summary/decisions/next steps, but used memories are free text. |
| 7. Knowledge growth | `partially_verified` | Candidate -> accepted instance -> later Context Pack works; Wiki/semantic/correction/proposal flows are not separate yet. |
| 8. Backup/restore | `partially_verified` | Installer and repos exist; data sync remains dry-run/manual approval. |

## What Would Make It Fully True

To upgrade this from MCP-assisted memory to an automatic OS loop:

1. Add an agent protocol or Codex hook that calls `start_task` and `get_context_pack` before work.
2. Add a structured `used_memory_paths` field to `finish_task`.
3. Add a `search_memory` alias or broader memory search tool if non-Wiki records need a first-class search surface.
4. Add explicit growth record types:
   - Wiki promotion
   - semantic job
   - correction
   - proposal
5. Add a guarded commit/push workflow after `git_sync` policy stabilizes.

## Evidence

`flow:audit` creates a temporary vault and calls the DinoBrain MCP server through `StdioClientTransport`.

It verifies:

- tools are listable
- `start_task` creates records
- `get_context_pack` retrieves user preference and project flow records
- `wiki_search` performs narrow body search
- `finish_task` writes trace data
- candidate approval produces an accepted instance
- the accepted instance is retrieved in a later Context Pack
- installer files and Git remotes are present
- `git_sync` remains dry-run only
