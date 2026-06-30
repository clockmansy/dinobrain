# DinoBrain

DinoBrain is a local-first second-brain OS for AI coding agents.

This repository contains the app side of DinoBrain:

- MCP server
- policy modules
- context pack generator
- wiki search
- trace console
- tests and evaluation harness

The data vault lives in a separate private repository:

- `clockmansy/dinobrain-data`

## Current Phase

DinoBrain has the MVP core from `PLAN.md` implemented through Phase 6.

The current verification focus is proving that the system behaves like a compounding memory OS:

- reviewed task knowledge can become future Context Pack input
- Context Pack traces explain why a memory was selected
- quarantined memories are excluded from later Context Packs
- `git_sync` classifies safe, conditional, and blocked data without committing or pushing
- Codex has a local MCP server configuration for DinoBrain

## Ground Rules

- Follow `PLAN.md`.
- Do not do work outside the current approved phase.
- Do not auto-scan personal document folders.
- Do not store secrets, tokens, API keys, or raw full conversation logs.
- Do not build the Observatory visual UI before the core engine works.

## Repositories

| Repository | Purpose |
| --- | --- |
| `dinobrain` | App, MCP server, policies, tests, trace console |
| `dinobrain-data` | Private data vault, wiki, sources, project records, instances |

## Key Documents

- `PLAN.md`
- `docs/ARCHITECTURE.md`
- `docs/MCP_SERVER.md`
- `docs/SYNC_POLICY.md`
- `docs/SENSITIVITY_POLICY.md`
- `docs/VERIFICATION.md`

## MCP Development

The MCP server skeleton lives in `src/index.ts`.

Available tools:

- `start_task`
- `finish_task`
- `get_context_pack`
- `wiki_search`
- `git_sync` as dry-run only
- `create_candidate_instance`
- `review_candidate`
- `quarantine_record`

`get_context_pack` writes a trace record to `.dino/context-packs` in the configured data vault so the inclusion reasons are inspectable after the tool call.

`git_sync` is dry-run only. It reports syncable, conditional, and blocked files, but it does not commit or push.

Local verification:

```powershell
npm install
npm run build
npm run check
npm run smoke
npm run eval:context
npm run verify:os
```

Set `DINOBRAIN_DATA_DIR` to point at a data vault. If omitted, the server uses `../dinobrain-data`.

`npm run verify:os` is the strongest local gate. It verifies the compounding loop and the Codex MCP configuration described in `docs/VERIFICATION.md`.
