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

DinoBrain is in Phase 1: Foundation.

The only approved work in this phase is:

- define repository boundaries
- document architecture
- document sync policy
- document sensitivity policy
- create the initial data vault structure
- commit and push the initial state

Implementation work starts in Phase 2 after Phase 1 is complete.

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

## Phase 2 Development

The MCP server skeleton lives in `src/index.ts`.

Available tools:

- `start_task`
- `finish_task`
- `get_context_pack`
- `wiki_search`
- `git_sync` as dry-run only

`get_context_pack` writes a trace record to `.dino/context-packs` in the configured data vault so the inclusion reasons are inspectable after the tool call.

Local verification:

```powershell
npm install
npm run build
npm run check
npm run smoke
```

Set `DINOBRAIN_DATA_DIR` to point at a data vault. If omitted, the server uses `../dinobrain-data`.
