# DinoBrain MCP Server

Date: 2026-07-01
Status: MVP core with OS-level verification

## Runtime

DinoBrain uses the official TypeScript MCP SDK package:

- `@modelcontextprotocol/sdk`

The current installed SDK version is locked in `package-lock.json`.

Node.js `>=20` is required. The local development machine may use a portable Node runtime instead of a global install.

## Data Root

The MCP server writes to the data vault.

Default:

```text
../dinobrain-data
```

Override:

```text
DINOBRAIN_DATA_DIR=C:\path\to\dinobrain-data
```

## Commands

```powershell
npm install
npm run build
npm run check
npm run smoke
npm run hook:verify
```

`npm run smoke` starts the compiled MCP server through `StdioClientTransport`, lists tools, and calls each Phase 2 tool against a temporary data vault.

`npm run verify:os` runs the stronger OS-level verification from `docs/VERIFICATION.md`. It checks the Codex MCP configuration and proves that an approved accepted instance can be retrieved by a later Context Pack, then excluded after quarantine.

`npm run observatory` starts a local file-backed live view of DinoBrain events at `http://127.0.0.1:3847/`.

## Tools

### `start_task`

Creates:

- `.dino/tasks/<task_id>.json`
- `.dino/events/<date>.jsonl`

Purpose:

- record a task start
- store request, project, mode, and sensitivity

### `finish_task`

Creates or updates:

- `.dino/tasks/<task_id>.json`
- `.dino/traces/<task_id>.json`
- `.dino/events/<date>.jsonl`

Purpose:

- mark a task as completed, partial, or blocked
- store a trace summary

### `get_context_pack`

Builds a Standard Context Pack from curated data folders.

Search roots:

- `20_Wiki`
- `30_Sources`
- `40_Projects`
- `50_Instances/accepted`
- `60_Operations`
- `70_Error_Book`

It excludes candidates and review queue records by default.

Creates:

- `.dino/context-packs/<pack_id>.json`
- `.dino/events/<date>.jsonl`

The Context Pack trace records:

- question
- ranking inputs
- scanned record count
- included items
- why each item was included
- excluded record count

### `wiki_search`

Searches the same curated roots as `get_context_pack`.

### `git_sync`

Dry-run only.

Reports:

- changed files
- sync classification
- policy reasons
- sensitive pattern flags
- per-file recommended action
- manual approval requirement

It does not commit or push.

Phase 6 response fields include:

- `dry_run: true`
- `would_commit: false`
- `would_push: false`
- `manual_approval_required: true`
- `commit_allowed_by_tool: false`
- `policy_version`
- `files[].classification`
- `files[].policy`
- `files[].reasons`
- `files[].action`
- `files[].sensitivity_scan`
- `files[].sensitive_patterns`
- `summary.syncable`
- `summary.conditional`
- `summary.blocked`

### `create_candidate_instance`

Creates:

- `50_Instances/candidates/<candidate_id>.json`
- `80_Review_Queue/promotion/<candidate_id>.json`
- `.dino/events/<date>.jsonl`

Required fields:

- `claim`
- `evidence_snippet`
- `evidence_source`
- `confidence`
- `last_verified`

Candidates always enter Review Queue first. They are not auto-promoted.

### `review_candidate`

Approves or rejects a candidate.

Approval requires:

- non-empty evidence snippet
- valid confidence
- valid `last_verified`

Approved candidates are copied to:

- `50_Instances/accepted/<candidate_id>.json`

### `quarantine_record`

Creates:

- `.dino/quarantine/<quarantine_id>.json`
- `80_Review_Queue/demotion/<quarantine_id>.json`
- `.dino/events/<date>.jsonl`

Any active quarantine target is excluded from default Context Packs.

## Phase 2 Verification

Phase 2 is considered locally verified when these commands pass:

```powershell
npm run build
npm run check
npm run smoke
```

## Phase 3 Context Pack v0

Context Pack v0 uses only these ranking inputs:

- file name
- frontmatter
- title
- summary
- tags
- recent task records

The default pack excludes:

- `50_Instances/candidates`
- `80_Review_Queue`

Accepted instance JSON records under `50_Instances/accepted` are indexed by default so reviewed task knowledge can reappear in later Context Packs.

`wiki_search` may inspect body excerpts for interactive search, but `get_context_pack` keeps to the narrower Phase 3 ranking inputs.

## Phase 4 Search Quality Evaluation

Context Pack retrieval quality is measured with:

```powershell
npm run eval:context
```

## Phase 5 Promotion And Demotion

Phase 5 verification is included in:

```powershell
npm run smoke
```

The smoke test verifies:

- candidate creation requires evidence
- candidate approval creates an accepted instance
- quarantine creates a demotion review record
- quarantined notes are excluded from default Context Packs

## Phase 6 Git Sync Dry Run

Phase 6 verification is included in:

```powershell
npm run smoke
```

The smoke test verifies:

- `git_sync` remains dry-run only
- manual approval is required
- syncable paths are classified as `syncable`
- Review Queue paths are classified as `conditional`
- local-only secret paths are classified as `blocked`
- sensitive patterns block otherwise syncable files

Default golden set:

```text
../dinobrain-data/.dino/evaluations/context-golden.json
```

The evaluator reports:

- total cases
- aggregate recall
- max noise
- average noise
- per-case missing paths
- per-case noise paths

Phase 4 targets:

- recall >= `0.8`
- max noise <= `2`

Override paths:

```powershell
$env:DINOBRAIN_DATA_DIR="C:\path\to\dinobrain-data"
$env:DINOBRAIN_GOLDEN_FILE="C:\path\to\context-golden.json"
npm run eval:context
```
