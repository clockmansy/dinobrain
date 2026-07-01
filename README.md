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
- Codex can run a user-level `UserPromptSubmit` hook that starts a task and injects a Context Pack from any workspace after hook trust
- Claude Code can be registered to the same local MCP server when the `claude` CLI is installed

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
- `docs/INSTALL.md`
- `docs/FLOW_AUDIT.md`
- `docs/LLM_WIKI_GRAPH.md`
- `docs/OPERATIONS_INDEX.md`
- `docs/SQLITE_SHARDS.md`
- `docs/SESSION_INGEST.md`
- `docs/MEMORY_AUDIT.md`
- `docs/SYNC_POLICY.md`
- `docs/SENSITIVITY_POLICY.md`
- `docs/VERIFICATION.md`

## Install And Update

Recommended Windows setup from a release asset:

```powershell
.\DinoBrainSetup.exe
```

Build the release EXE from this repo:

```powershell
npm run installer:win
```

Publish the EXE to GitHub Releases:

```powershell
$env:GITHUB_TOKEN="<token-with-repo-release-access>"
npm run release:win -- -Tag v0.1.0 -ReplaceAsset
```

Fresh Windows setup from PowerShell:

```powershell
.\install.ps1
```

Inside an already cloned repo:

```powershell
.\setup.ps1
```

Update, reinstall, and uninstall entrypoints:

```powershell
.\update.ps1
.\reinstall.ps1
.\uninstall.ps1
```

See `docs/INSTALL.md` for custom paths, private repo prerequisites, and removal flags.

The installer configures Codex MCP, registers a user-level Codex prompt hook, and registers Claude Code automatically when `claude` is on `PATH`. If Claude Code is installed later, rerun `.\setup.ps1`.

## MCP Development

The MCP server skeleton lives in `src/index.ts`.

Available tools:

- `start_task`
- `finish_task`
- `get_context_pack`
- `wiki_search`
- `import_session`
- `audit_memory_use`
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
npm run flow:audit
npm run check
npm run smoke
npm run eval:context
npm run index:verify:sqlite
npm run index:verify:operations
npm run index:verify
npm run session:verify
npm run hook:verify
npm run verify:os
npm run index:sqlite
npm run index:operations
npm run index:wiki
npm run graph:vault
npm run observatory
```

Set `DINOBRAIN_DATA_DIR` to point at a data vault. If omitted, the server uses `../dinobrain-data`.

`npm run verify:os` is the strongest local gate. It verifies the compounding loop, the Codex MCP configuration, and Claude Code registration when the installer configured it, as described in `docs/VERIFICATION.md`.

`npm run graph:vault` writes a local Obsidian-style graph report to `reports/dinobrain-vault-graph.html` and `reports/dinobrain-vault-graph.svg`. It counts handwritten wikilinks separately from DinoBrain OS relationships such as folders, tags, golden evaluation cases, traces, review records, accepted instances, and quarantine targets.

`npm run index:wiki` rebuilds the persistent LLM Wiki graph index at `.dino/index/wiki-index.json`; `get_context_pack` and `wiki_search` use that index to avoid full curated-vault scans on every request. `npm run index:verify` checks the indexed path against a synthetic 1,500+ record vault.

`npm run index:operations` rebuilds the operational index at `.dino/index/operations-index.json`; recent-task retrieval and Observatory use that index to avoid sorting every historical task/trace/pack/event file. `npm run index:verify:operations` checks this against a synthetic 2,500+ record vault.

`npm run index:sqlite` rebuilds SQLite shards at `.dino/index/sqlite/wiki.sqlite` and `.dino/index/sqlite/operations.sqlite`. When present, `wiki_search`, `get_context_pack`, recent task lookup, and Observatory use the SQLite shards before JSON fallbacks. `npm run index:verify:sqlite` checks routed SQLite retrieval.

`npm run session:verify` proves that `import_session` stores only redacted local-only session excerpts, extracts hot/warm/cold review candidates, excludes unreviewed imports from retrieval, and keeps raw archives blocked from git sync.

`npm run hook:verify` simulates the Codex `UserPromptSubmit` hook and proves it calls DinoBrain preflight, imports the redacted prompt through `import_session`, and avoids leaking obvious secret patterns. The installed user-level hook is written to `~/.codex/hooks.json`; the repo-level `.codex/hooks.json` remains as local verification and fallback.

`npm run observatory` starts a local live view at `http://127.0.0.1:3847/` so Codex/DinoBrain events can be watched while working. See `docs/CODEX_HOOKS.md`.
