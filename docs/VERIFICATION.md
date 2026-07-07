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
npm run audit:full-memory
npm run audit:full-memory:verify
npm run status:freshness
npm run status:freshness:verify
npm run review:settle
npm run review:settle:verify
npm run sources:rag:seed
npm run session:verify
npm run session:promote
npm run safety:public-data
npm run eval:context
npm run index:verify:sqlite
npm run index:verify:operations
npm run index:verify
npm run hooks:data:verify
npm run hook:verify
npm run verify:os
npm run verify:goal
npm run verify:codex-loop
npm run verify:codex-live:recent
npm run verify:compounding
npm run installer:verify:approval
npm run installer:verify:launchers
npm run installer:verify:managed-hook
npm run codex:hooks:managed
npm run installer:win
npm run release:win -- -Tag v2.2.1 -ReplaceAsset
```

Use the bundled or portable Node runtime if `npm` is not on `PATH`.

`npm run audit:full-memory` writes `.dino/state/full_memory_manifest.json` and `.dino/state/full_memory_audit_status.json`. The manifest records every non-Git data-vault file by path, byte size, SHA-256, mtime, and parse status. The status report compares against the previous manifest and classifies drift as live OS writes, review-queue writes, audit artifacts, or unclassified content drift. Unclassified drift and parse errors must block final readiness.

`npm run audit:full-memory:verify` proves the audit can create a baseline, classify live OS drift without false failure, flag unclassified content drift, and surface JSON/JSONL parse errors.

`npm run status:freshness` writes `.dino/state/monitoring_status.json`. It checks whether the full-memory audit, Wiki index, operations index, SQLite shard manifest, graph-health artifact, review queue settlement, and semantic job settlement are present and newer than their source roots. Missing required artifacts produce `degraded`; stale artifacts produce `needs_refresh`. The report carries Korean `visible_status` fields so the Observatory can show freshness without hiding stale proof.

`npm run status:freshness:verify` proves the freshness gate is healthy after all required artifacts are refreshed, falls to `needs_refresh` after a source change, and falls to `degraded` when required proof artifacts are missing.

`npm run review:settle` writes `.dino/state/wiki-review-queue.json` and `.dino/state/semantic_jobs.json`. It does not auto-approve memory. It classifies every candidate/review item as closed, manual semantic review, auto-compounded behavior hold, legacy unreviewed hold, evidence repair, missing review, missing candidate, or unclassified. The command succeeds when open backlog remains but every residual item has a decision class, reason, evidence path, owner, and next action.

`npm run review:settle:verify` proves this classification on a temporary vault with behavior-rule, legacy, missing-evidence, missing-review, missing-candidate, and closed-review fixtures.

`npm run verify:goal` includes both the regression verifiers and current-vault `audit:full-memory` / `status:freshness` gates, so final closed-loop readiness cannot bypass P0-01 or P0-02.

`npm run installer:win` builds `artifacts\DinoBrainSetup.exe` and verifies that the generated EXE can extract the embedded `install.ps1`.

`npm run release:win` requires `GITHUB_TOKEN` or `GH_TOKEN`. It rebuilds the installer, creates or reuses the GitHub release, and uploads `DinoBrainSetup.zip` plus `DinoBrainSetup.zip.sha256` as the release assets.

Use `npm run release:win -- -SkipUpload` to verify local ZIP/SHA packaging without a GitHub token.

`npm run installer:verify:approval` verifies the post-install hook approval helper without opening or restarting Codex.

`npm run installer:verify:launchers` verifies the generated Observatory, hook diagnose, hook approval, Codex live proof, and purge uninstall launchers without touching the real install paths.

`npm run installer:verify:managed-hook` verifies the ProgramData managed-hook writer on temporary files: it preserves existing requirements content, installs DinoBrain exactly once, keeps an existing managed hook directory when present, and writes the wrapper script expected by Codex.

`npm run codex:hooks:managed` installs or repairs the trust-free managed Codex hook path through `C:\ProgramData\OpenAI\Codex\requirements.toml`. It may request administrator permission through UAC. After it runs, fully restart Codex and create a fresh workspace thread before counting live proof.

`npm run hooks:data:verify` verifies the real `dinobrain-data` checkout has `core.hooksPath = .githooks`, then proves the hook blocks unreviewed auto-generated accepted memories and local-only event/index paths while allowing reviewed accepted memories. This is intentionally below the MCP layer so stale MCP processes cannot bypass the public-data policy by committing directly.

`npm run verify:goal` is the completion gate for the full closed-loop objective. It combines real Codex Desktop live preflight evidence, the closed-loop fixture with GitHub-style push, OS memory/retrieval/behavior verification, data Git hooks, and public-data safety into one requirement-by-requirement JSON report. The live proof window starts at the latest Codex hook config or server build timestamp, so a valid proof remains useful after the default recent-live window has passed. The goal is not complete unless this command exits successfully.

`npm run verify:codex-loop` proves the Codex closed-loop fixture end to end against a temporary Git repository and bare remote: the hook preflight injects memory, the task is finished with declared memory paths, auto-growth creates durable memory, and `auto_sync` commits and pushes policy-approved data. The fixture explicitly opts in to conditional push with `DINOBRAIN_AUTO_SYNC_ALLOW_CONDITIONAL=1` and `DINOBRAIN_AUTO_SYNC_PUSH=1`; the installed public-safe default keeps both flags at `0`.

The same verifier also checks the safety valve for read-only work: `finish_task` with `growth_policy: "trace_only"` must write the task trace but skip auto-growth, compounding, and auto-sync push even when those environment flags are enabled.

`npm run verify:codex-live -- --snippet "<prompt text>" --since "<iso timestamp>"` is stricter in a different way: it checks the real data vault and `reports/live-hooks` for a live Codex `UserPromptSubmit` event/report after the given time. It is expected to fail until a fresh trusted or managed Codex session actually dispatches the installed hook for that prompt.

`npm run verify:codex-live:recent` is the no-snippet live gate. It uses the same real-vault evidence path and fails unless a recent real Codex Desktop prompt produced a `codex_prompt_submitted` event, a matching `codex_preflight_completed` event, and a live hook report with selected memory paths. A green synthetic `hook:verify`, `verify:os`, or `verify:codex-loop` run does not replace this live proof. If the report shows `managed_prompt_hook.ok=true` but no submitted event, the managed hook is installed but Codex has not yet produced live evidence; restart Codex, create a new workspace thread after the latest `requirements.toml` write time, paste the live-proof prompt, and rerun the verifier.

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

The verifier also reports `managed_prompt_hook`. A passing managed hook means `C:\ProgramData\OpenAI\Codex\requirements.toml` contains the DinoBrain `UserPromptSubmit` declaration and the configured managed wrapper exists. This satisfies the registration/trust-path check, but not the live-behavior check; `verify:codex-live` must still find real `codex_desktop` events.

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

### Session Knowledge Promotion

`npm run session:promote` performs the next knowledge-compounding step on the
real local Codex session history. It converts repeated session patterns into
accepted behavior/preference/decision memories and matching review records.

It verifies by construction:

- raw full transcripts are not stored
- message content is not stored
- evidence uses session refs and redacted message hashes rather than raw text
- promoted records link back to the metadata-only Codex Conversation Registry
- generated memories enter `50_Instances/accepted` so they can be indexed and
  retrieved by later Context Packs

### Public Data Safety

`npm run safety:public-data` scans the real configured data vault and writes a public-safety report under `60_Operations/public-data-safety`.

It verifies:

- tracked local-only paths such as `10_Conversations/raw` are blocked
- obvious secret, token, credential, private-key, and raw transcript markers are not present in public tracked data
- accepted memories, tasks, traces, Context Packs, events, gates, audits, operations records, and currently untracked sync candidates are included in the scan scope
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

It does not prove that every future Codex answer will automatically call DinoBrain. It proves that Codex is configured with a working DinoBrain MCP server, the user-level Codex hook is registered when required, and that an MCP client can retrieve reviewed memories through that server.

The current `eval:behavior` gate is a context-level behavior check: it proves reviewed memories are retrieved and contain required action criteria that a memory-off prompt does not contain. It is not yet a Ragas-style answer-quality grader, so answer relevance/correctness/faithfulness still require a later evaluator.

`verify:codex-loop` proves the hook/growth/sync loop can complete and push when invoked. `verify:codex-live` is the evidence gate for an actual Codex app session: it fails unless the real hook emitted live preflight events and a live hook report for the target prompt.

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
- the PowerShell wrapper fails closed with a blocking hook decision when Node cannot be found.

`npm run verify:codex-loop` extends this from hook preflight to the complete Codex loop. It creates a temporary data vault and a temporary bare Git remote, runs the hook, writes a proof artifact, calls `finish_task`, and asserts that both the preflight records and the finish/growth records are pushed to the remote under explicit conditional-push opt-in.

`npm run verify:codex-live` does not simulate Codex. It reads the real `.dino/events/*.jsonl` files plus `reports/live-hooks/*.json` and fails unless the selected prompt snippet has a matching `codex_prompt_submitted` event, `codex_preflight_completed` event, and live hook report with selected memory paths. On Windows it also reports stale Codex and DinoBrain MCP processes whose start time predates `hooks.json` or `dist/index.js`, so a missing live event can be separated from hook registration failures.

The same live verifier reports the user-level hook trust surface. If the
DinoBrain `UserPromptSubmit` hook is registered but no visible `trusted_hash`
or hook `state` is present and no live event appears, the failure is classified
as a likely `/hooks` trust-review blocker instead of a stale-thread-only
problem. Codex may store trust outside `hooks.json`, so the decisive proof is
still the real live event pair plus the hook report.

`npm run verify:codex-live` also reports whether the current `CODEX_THREAD_ID` was created before `hooks.json` was updated. That stale-thread condition means the next proof attempt must happen in a fresh Codex Desktop thread, not the old long-running thread.

If `verify:codex-live` reports fresh threads after `hooks.json` but still has no `codex_prompt_submitted` event, a new Codex thread existed but did not dispatch the user-level `UserPromptSubmit` hook. Do not count `send_message_to_thread`, app-tool delegation, or background thread messages as live proof. The proof prompt must be pasted manually into a trusted Codex Desktop workspace thread after `/hooks` approval.

`npm run codex:live-proof` wraps the live proof into an operator flow. It opens a separate proof window, restarts stale Codex/MCP processes through the approval helper, copies a unique proof prompt to the clipboard, and polls `verify:codex-live` until a fresh Codex Desktop thread emits the real `codex_desktop` preflight evidence. The npm command returns once the proof window has started.
