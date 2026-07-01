# Operations Index

Date: 2026-07-01
Status: v0 implemented

## Goal

DinoBrain should not slow down just because task records, traces, Context Packs, and event logs keep accumulating.

The Wiki graph index handles curated knowledge retrieval. The operations index handles the live OS trail:

- tasks
- traces
- Context Packs
- events
- active task list

## Current File

The v0 operations index is written to:

```text
.dino/index/operations-index.json
```

It stores counts plus capped recent lists:

- latest 200 tasks
- latest 200 traces
- latest 200 Context Packs
- latest 500 events
- all active tasks currently visible to the index

## Runtime Behavior

The MCP server updates this index when it writes operational records:

- `start_task` upserts the task and appends a task-started event
- `finish_task` updates the task, upserts the trace, and appends a task-finished event
- `get_context_pack` upserts the Context Pack trace and appends a Context Pack event
- candidate/review/quarantine actions append events

`collectRecentTaskRecords` reads this index first, then falls back to legacy directory scanning only if the index is missing.

The Observatory reads this index first, then falls back to legacy directory scanning only if the index is missing.

## Manual Refresh

Direct manual edits to `.dino/tasks`, `.dino/traces`, `.dino/context-packs`, or `.dino/events` can be reindexed with:

```powershell
npm run build
npm run index:operations
```

## Verification

The focused verifier creates a synthetic vault with more than 2,500 tasks, traces, Context Packs, and events. It proves that the index keeps capped recent lists and can read recent task context without sorting every historical file:

```powershell
npm run build
npm run index:verify:operations
```

## Remaining Boundary

This is still a JSON manifest, not a database.

It is a practical v0 speed layer, but the long-term target for very large session history is an append-only SQLite or log-structured store with separate hot, warm, and cold partitions.
