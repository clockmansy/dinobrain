# DinoBrain Sync Policy

Date: 2026-07-11
Status: SAFE-01 unified classifier implemented; HG-09 cleanup and recovery pending

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
- `.dino/migrations` except explicitly local-only migration families
- `.dino/proofs`
- `.dino/state`

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
- `.dino/sync-scopes`
- `.dino/migrations/behavior-recall`
- `.dino/state/behavior_recall_evidence_migration.json`
- `10_Conversations/raw`

## `git_sync` And `auto_sync` Behavior

`git_sync` is the dry-run surface over the versioned unified classifier in
`src/data-classification.ts`. It reports what would be safe, conditional, or
blocked without committing. `auto_sync`, the public-data audit, and data Git
hooks use the same policy version and file decision object.

It must report:

- changed files
- whether each file is syncable, conditional, or blocked
- policy reasons
- suspected sensitive patterns
- per-file recommended action
- whether manual approval is required

`auto_sync` is the bounded writer. Every call must provide an active `task_id`
and nonempty `allowed_paths`. The caller list is not authority by itself: the
server intersects it with an atomically written, local-only task scope under
`.dino/sync-scopes`. A scope entry binds path, SHA-256, Git-filtered blob id,
size, producing tool, and lifecycle approval. Changed bytes downgrade any prior
higher approval. Missing scope, out-of-scope paths, pending review,
changed bytes, unsupported files, and classifier findings fail closed.

Only the intersection can be staged. Existing staged files outside that set
block the operation, and neighboring dirty/untracked backlog is counted but
never staged. Broad repository sync remains a manual operation. Results use
distinct `blocked`, `no_op`, `committed`, `pushed`, and `retry_required` states;
a push failure after commit reports the commit SHA so recovery does not repeat
or hide the write.

Task, Context Pack, gate, and terminal trace writers register system-generated
artifacts. Candidate, review, session-import, growth, and compounding outputs
start as `pending_review`; accepted lifecycle records become `reviewed`.
Conditional system records still require the explicit
`DINOBRAIN_AUTO_SYNC_ALLOW_CONDITIONAL=1` opt-in.

Portable task evidence stores the vault root as `"."`; absolute install paths
remain local diagnostics and must not be committed through the task-scoped
writer.

The installed default is public-safe: `DINOBRAIN_AUTO_SYNC=1` may evaluate and
commit syncable reviewed artifacts, but `DINOBRAIN_AUTO_SYNC_ALLOW_CONDITIONAL=0`
and `DINOBRAIN_AUTO_SYNC_PUSH=0` prevent prompt-derived task, trace, context
pack, gate, candidate, review, and compounding records from being auto-pushed.
Closed-loop push tests and private/encrypted backup workflows may explicitly set
both flags to `1`; that opt-in is not the default public data posture.

Generated indexes under `.dino/index` and append-only event logs under `.dino/events` are local-only by default. Indexes are rebuilt during install/update and event logs can contain prompt/task payloads from more than the current task.

Behavior-recall migration maps are also local-only because they contain task and
trace identities. Their reviewed public evidence is limited to hash-only
summaries under `60_Operations/behavior-recall-migrations/`.

The data repo also carries thin Git launchers under `.githooks`. Install/update
must set `core.hooksPath = .githooks` and write a local-only
`.git/dinobrain-classifier.json` binding to the installed Node runtime,
classifier CLI, and exact policy version. The launchers contain no duplicate
classification rules. Missing config, a missing runtime, or version drift fails
closed. Pre-commit scans staged blobs; pre-push scans every changed blob in the
Git-provided push range, so a secret added in one commit and deleted in a later
commit remains blocked.

Required dry-run fields:

- `dry_run: true`
- `would_commit: false`
- `would_push: false`
- `manual_approval_required: true`
- `commit_allowed_by_tool: false`

Run `npm run safety:task-sync:verify` to prove the scope ledger, review/hash
binding, real isolated remote push, backlog preservation, sensitive-data block,
no-op behavior, and retry state.

## Public Data Safety Report

The public-data safety report is stricter than a minimal token scan. It scans
tracked accepted memories, tasks, traces, Context Packs, events, gates, audits,
operations records, indexes, source/provenance records, currently untracked
candidate sync records, and every unique blob in Git history. Historical blobs
are read in bounded batches; files that are too large, unsupported, or not
strict UTF-8 are blockers rather than partially scanned successes.

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
