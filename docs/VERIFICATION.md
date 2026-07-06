# DinoBrain Verification

Date: 2026-07-01

This document defines how to verify that DinoBrain is more than a note store.

The verification target has two parts:

1. Knowledge compounds: completed work can become reviewed memory, appear in a later Context Pack, and be removed if it becomes unsafe or wrong.
2. Codex can use it: the local Codex MCP configuration points at the DinoBrain server, the user-level prompt hook is registered when installed, and the configured server can list the DinoBrain tools.
3. Claude Code can use it when configured by the installer: `claude mcp list` includes the `dinobrain` MCP server.

## Commands

```powershell
npm run build
npm run check
npm run smoke
npm run sources:rag:seed
npm run session:verify
npm run safety:public-data
npm run eval:context
npm run index:verify:sqlite
npm run index:verify:operations
npm run index:verify
npm run hook:verify
npm run verify:os
npm run verify:compounding
npm run installer:verify:approval
npm run installer:win
npm run release:win -- -Tag v2.2.1 -ReplaceAsset
```

Use the bundled or portable Node runtime if `npm` is not on `PATH`.

`npm run installer:win` builds `artifacts\DinoBrainSetup.exe` and verifies that the generated EXE can extract the embedded `install.ps1`.

`npm run release:win` requires `GITHUB_TOKEN` or `GH_TOKEN`. It rebuilds the installer, creates or reuses the GitHub release, and uploads `DinoBrainSetup.zip` plus `DinoBrainSetup.zip.sha256` as the release assets.

Use `npm run release:win -- -SkipUpload` to verify local ZIP/SHA packaging without a GitHub token.

`npm run installer:verify:approval` verifies the post-install hook approval helper without opening or restarting Codex.

`npm run verify:compounding` proves the closed behavior loop: completed task traces are distilled into accepted behavior rules, later memory search and Context Packs retrieve the promoted rule, memory-on behavior beats the memory-off baseline for the golden case, and invalid/duplicate behavior rules are held or merged.

## What `verify:os` Proves

`npm run verify:os` performs five independent checks.

### Codex MCP Integration

The script reads:

```text
C:\Users\USER\.codex\config.toml
```

It requires a `dinobrain` MCP server entry. The configured command must exist, the configured `dist/index.js` server entry must exist, and `DINOBRAIN_DATA_DIR` must point at the data vault.

Then the script starts the configured MCP command and verifies that these tools are listable:

- `start_task`
- `finish_task`
- `get_context_pack`
- `wiki_search`
- `import_session`
- `audit_memory_use`
- `git_sync`
- `auto_sync`
- `os_begin_task`
- `os_gate`
- `search_memory`
- `apply_node_lifecycle`
- `create_source_chunk`
- `record_feedback_correction`
- `evaluate_behavior`
- `run_compounding_cycle`
- `create_candidate_instance`
- `review_candidate`
- `quarantine_record`

If Codex was already running before the MCP block was added, the app may need to restart or reload before the new tool appears in future thread tool surfaces. The verifier still proves that the configured command is startable by an MCP client.

### Codex User-Level Hook Integration

The installer writes a user-level hook file:

```text
C:\Users\<you>\.codex\hooks.json
```

The hook listens for `UserPromptSubmit` and calls the installed DinoBrain PowerShell wrapper by absolute path. This makes DinoBrain preflight available outside the `dinobrain` repo after Codex reloads and the hook is trusted.

During installer verification, `DINOBRAIN_REQUIRE_CODEX_USER_HOOK=1` requires this hook to be present. Manual `npm run verify:os` reports the hook state but does not fail solely because the user-level hook is absent.

The verifier also reports `hook_runtime_config`. This catches `hooks = false` under `[features]` and `allow_managed_hooks_only = true`, either of which can make a registered user hook look installed while Codex skips it at runtime.

The project hook in `.codex/hooks.json` remains for local verification and fallback. The runtime hook uses a short lock in `.dino/hook-locks` so project-level and user-level hooks do not both create task records for the same prompt.

### Claude Code MCP Integration

The installer registers a Claude Code `UserPromptSubmit` hook in `C:\Users\<you>\.claude\settings.json` so DinoBrain preflight can add context before Claude processes a prompt. When the `claude` CLI is available, the installer also registers the MCP server:

```powershell
claude mcp add --env DINOBRAIN_DATA_DIR=<vault> --transport stdio --scope user dinobrain -- <node.exe> <dist\index.js>
```

During installer verification, `DINOBRAIN_REQUIRE_CLAUDE_PROMPT_HOOK=1` requires the Claude prompt hook to be present. `DINOBRAIN_REQUIRE_CLAUDE_CODE=1` is set only after MCP registration succeeds; in that mode `verify:os` also requires `claude mcp list` to include `dinobrain`.

When running `npm run verify:os` manually on a PC without Claude Code, this check is reported as skipped and does not fail the OS verification.

### Compounding Knowledge Loop

The script creates a temporary vault and calls the DinoBrain MCP server through `StdioClientTransport`.

It verifies this sequence:

1. `start_task` records a task.
2. `finish_task` writes a trace with structured memory-use fields.
3. `create_candidate_instance` creates an evidence-backed candidate.
4. `review_candidate` approves it into `50_Instances/accepted`.
5. `get_context_pack` retrieves that accepted instance for a later related question.
6. The Context Pack trace records why the accepted instance was included.
7. `quarantine_record` quarantines that accepted instance.
8. A later `get_context_pack` no longer returns the quarantined instance.

This is the core compounding test: reviewed task knowledge must become future context, and bad memory must be removable.

### Retrieval Quality And Sync Safety

The script also runs the real data vault golden retrieval evaluator:

- target recall: `>= 0.8`
- target max noise: `<= 2`

It checks `git_sync` in the temporary vault:

- remains dry-run only
- requires manual approval
- blocks local-only secret paths
- blocks sensitive patterns
- classifies review queue paths as conditional
- classifies ordinary Wiki paths as syncable

Live hook task records under `.dino/tasks` and `.dino/context-packs` are reported as operational noise in retrieval evaluation, but they are not counted against the curated-memory noise target. They are expected to grow as the user-level hook runs.

### Session Ingest Safety

`npm run session:verify` creates a temporary vault and imports a synthetic session through MCP.

It verifies:

- redaction happens inside the `import_session` tool boundary
- raw archives are written under `10_Conversations/raw` with `raw_full_transcript_stored: false`
- candidates stay in `pending_review`
- hot/warm/cold labels are present
- raw archives, candidates, and review queue records are excluded from `wiki_search` and `get_context_pack`
- `git_sync` blocks raw archives and marks candidates/review records as conditional

### Public Data Safety

`npm run safety:public-data` scans the real configured data vault and writes a public-safety report under `60_Operations/public-data-safety`.

It verifies:

- tracked local-only paths such as `10_Conversations/raw` are blocked
- obvious secret, token, credential, private-key, and raw transcript markers are not present in public tracked data
- accepted memories, tasks, traces, Context Packs, events, gates, audits, and operations records are included in the scan scope
- candidate and review queue records are not present in the default Wiki index
- app documentation does not claim the data repo is private when GitHub reports it as public
- matched secret values are not printed in the report

### RAG Source Anchor Seeding

`npm run sources:rag:seed` records user-provided RAG methodology URLs as
anchor-only source candidates in the real data vault. It writes a catalog under
`20_Wiki`, source chunk records under `30_Sources/chunks`, and provenance links
under `.dino/provenance`.

It does not claim the external pages were read or verified. Every seeded source
record uses `verification_status: anchor_only_unverified`, so later source-truth
work must fetch bounded chunks, link concrete claims, and pass review before
using the source as factual support.

### Memory Use Audit

`npm run smoke` calls `audit_memory_use` after a completed task.

It verifies:

- a short `.dino/audits/<audit_id>.json` record is created
- the audit links provided Context Pack memories to declared `finish_task.used_memory_paths`
- the audit includes a trust score and graph health snapshot
- the audit does not need raw conversation logs

### Index And Shard Verification

The index verifiers use synthetic vaults:

- `npm run index:verify` checks the JSON Wiki graph index fallback.
- `npm run index:verify:operations` checks the JSON operations index fallback.
- `npm run index:verify:sqlite` checks routed SQLite shard retrieval for Wiki search, Context Packs, recent task lookup, and incremental task/event writes.
- `npm run graph:health:verify` checks empty graph, missing referenced path, accepted instance lineage, missing source mapping, and review queue mapping cases.

## Evidence Quality

A green `verify:os` run is stronger than the smoke test because it validates the full feedback loop, not only individual tool behavior.

It does not prove that every future Codex or Claude Code answer will automatically call DinoBrain. It proves that Codex is configured with a working DinoBrain MCP server, the user-level Codex hook is registered when required, Claude Code is registered when the installer configured it, and that an MCP client can retrieve reviewed memories through that server.

## Codex Hook Verification

`npm run hook:verify` simulates a Codex `UserPromptSubmit` event against a temporary vault.

It verifies:

- `.codex/hooks.json` contains a `UserPromptSubmit` hook.
- the hook wrapper can start the DinoBrain preflight script.
- `start_task` creates a task.
- `get_context_pack` creates a trace and returns relevant memory.
- `import_session` creates a local-only prompt archive and pending review candidates.
- the hook returns `hookSpecificOutput.additionalContext`.
- obvious secret-shaped prompt text is redacted before it reaches hook stdout or task records.
- live events include `codex_prompt_submitted`, `task_started`, `context_pack_created`, `session_imported`, and `codex_preflight_completed`.
