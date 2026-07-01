# DinoBrain Sync Policy

Date: 2026-07-01
Status: Phase 1 foundation

## Goal

Sync only data that is safe, useful, and intended to be durable.

GitHub is used as a private sync server for curated DinoBrain data. It is not a raw dump of personal files, browser history, conversation transcripts, secrets, or machine-local state.

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
- `.dino/index`
- `.dino/evaluations`
- `.dino/tasks`
- `.dino/events`
- `.dino/traces`
- `.dino/context-packs`
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
- `10_Conversations/raw`

## `git_sync` MVP Behavior

In Phase 6, `git_sync` is dry-run only.

It must report:

- changed files
- whether each file is syncable, conditional, or blocked
- policy reasons
- suspected sensitive patterns
- per-file recommended action
- whether manual approval is required

It must not commit or push until manual approval is added in a later phase.

Required dry-run fields:

- `dry_run: true`
- `would_commit: false`
- `would_push: false`
- `manual_approval_required: true`
- `commit_allowed_by_tool: false`

## Commit Rule

Commits must describe the knowledge or policy change, not just the file operation.

Good:

- `docs: establish DinoBrain foundation policies`
- `data: add initial vault structure`

Bad:

- `update files`
- `misc`
