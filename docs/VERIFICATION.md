# DinoBrain Verification

Date: 2026-07-01

This document defines how to verify that DinoBrain is more than a note store.

The verification target has two parts:

1. Knowledge compounds: completed work can become reviewed memory, appear in a later Context Pack, and be removed if it becomes unsafe or wrong.
2. Codex can use it: the local Codex MCP configuration points at the DinoBrain server and the configured server can list the DinoBrain tools.

## Commands

```powershell
npm run build
npm run check
npm run smoke
npm run eval:context
npm run hook:verify
npm run verify:os
```

Use the bundled or portable Node runtime if `npm` is not on `PATH`.

## What `verify:os` Proves

`npm run verify:os` performs three independent checks.

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
- `git_sync`
- `create_candidate_instance`
- `review_candidate`
- `quarantine_record`

If Codex was already running before the MCP block was added, the app may need to restart or reload before the new tool appears in future thread tool surfaces. The verifier still proves that the configured command is startable by an MCP client.

### Compounding Knowledge Loop

The script creates a temporary vault and calls the DinoBrain MCP server through `StdioClientTransport`.

It verifies this sequence:

1. `start_task` records a task.
2. `finish_task` writes a trace.
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

## Evidence Quality

A green `verify:os` run is stronger than the smoke test because it validates the full feedback loop, not only individual tool behavior.

It does not prove that every future Codex answer will automatically call DinoBrain. It proves that Codex is configured with a working DinoBrain MCP server and that an MCP client can retrieve reviewed memories through that server.

## Codex Hook Verification

`npm run hook:verify` simulates a Codex `UserPromptSubmit` event against a temporary vault.

It verifies:

- `.codex/hooks.json` contains a `UserPromptSubmit` hook.
- the hook wrapper can start the DinoBrain preflight script.
- `start_task` creates a task.
- `get_context_pack` creates a trace and returns relevant memory.
- the hook returns `hookSpecificOutput.additionalContext`.
- obvious secret-shaped prompt text is redacted before it reaches hook stdout or task records.
- live events include `codex_prompt_submitted`, `task_started`, `context_pack_created`, and `codex_preflight_completed`.
