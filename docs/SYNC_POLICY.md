# DinoBrain Sync Policy

Date: 2026-07-01
Status: Phase 1 foundation

## Goal

Sync only data that is safe, useful, and intended to be durable.

GitHub is used as the durable sync and recovery remote for curated DinoBrain data. The remote may be private or public, so the default sync posture treats data as public-safe unless a stricter local policy is configured. It is not a raw dump of personal files, browser history, conversation transcripts, secrets, or machine-local state.

## Public Visibility Rule

If the data remote is public, or if visibility cannot be verified, synced records must be safe to expose publicly. Public-safe means:

- no raw full conversations
- no raw personal files or private attachments
- no secrets, tokens, credentials, cookies, or private keys
- no machine-local caches
- no tracked local-only paths such as `10_Conversations/raw`
- no candidate or review queue records in the default Wiki index
- no documentation that claims the data remote is private when GitHub reports it as public

Run `npm run safety:public-data` from the app repo to generate the current safety report under `60_Operations/public-data-safety`.

## Always Syncable After Review

These paths are intended to be syncable after ordinary sensitivity checks:

- `00_Home`
- `20_Wiki`
- `30_Sources`
- `40_Projects`
- `50_Instances/accepted`
- `60_Operations`
- `70_Error_Book`

## Conditionally Syncable

These paths may be synced only when the records are curated and non-sensitive:

- `50_Instances/candidates`
- `80_Review_Queue`
- `.dino/evaluations`
- `.dino/tasks`
- `.dino/traces`
- `.dino/context-packs`
- `.dino/compounding`
- `.dino/audits`
- `.dino/quarantine`

## Local Only By Default

These data types are local-only unless the plan is explicitly changed:

- raw full conversation logs
- raw browser history
- raw personal document imports
- private attachments
- machine-local caches
- secrets and credentials
- API keys and access tokens
- `.dino/secrets.json`
- `.dino/local.json`
- `.dino/index`
- `.dino/events`
- `10_Conversations/raw`

## `git_sync` And `auto_sync` Behavior

`git_sync` is the dry-run classifier. It reports what would be safe, conditional, or blocked without committing.

It must report:

- changed files
- whether each file is syncable, conditional, or blocked
- policy reasons
- suspected sensitive patterns
- per-file recommended action
- whether manual approval is required

`auto_sync` is the bounded writer. Hook and `finish_task` callers must pass an `allowed_paths` scope so only artifacts created by the current task can be committed. Broad repo policy sync is reserved for explicit manual calls. `auto_sync` may commit and push only policy-approved records after sensitivity scanning and path classification. It must skip blocked local-only records and report skipped paths.

The installed default is public-safe: `DINOBRAIN_AUTO_SYNC=1` may evaluate and
commit syncable reviewed artifacts, but `DINOBRAIN_AUTO_SYNC_ALLOW_CONDITIONAL=0`
and `DINOBRAIN_AUTO_SYNC_PUSH=0` prevent prompt-derived task, trace, context
pack, gate, candidate, review, and compounding records from being auto-pushed.
Closed-loop push tests and private/encrypted backup workflows may explicitly set
both flags to `1`; that opt-in is not the default public data posture.

Generated indexes under `.dino/index` and append-only event logs under `.dino/events` are local-only by default. Indexes are rebuilt during install/update and event logs can contain prompt/task payloads from more than the current task.

The data repo also carries Git hooks under `.githooks`. Install/update must set `core.hooksPath = .githooks`. These hooks block local-only paths and auto-generated accepted memories without review lineage at `pre-commit` and `pre-push` time. This is required because a long-lived stale MCP process may not yet know the newest in-process sync policy.

Required dry-run fields:

- `dry_run: true`
- `would_commit: false`
- `would_push: false`
- `manual_approval_required: true`
- `commit_allowed_by_tool: false`

## Public Data Safety Report

The public-data safety report is stricter than a minimal token scan. It scans tracked accepted memories, tasks, traces, Context Packs, events, gates, audits, operations records, indexes, source/provenance records, and currently untracked candidate sync records. It classifies local untracked records so blocked local-only material is visible before a future sync.

The report is written to:

```text
60_Operations/public-data-safety/public-data-safety-report.json
60_Operations/public-data-safety/public-data-safety-report.md
```

The report stores only relative paths, finding ids, pattern names, line numbers, counts, and GitHub visibility metadata. It does not print matched secret values.

## Commit Rule

Commits must describe the knowledge or policy change, not just the file operation.

Good:

- `docs: establish DinoBrain foundation policies`
- `data: add initial vault structure`

Bad:

- `update files`
- `misc`
