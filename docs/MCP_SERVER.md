# DinoBrain MCP Server

Date: 2026-07-01
Status: Phase 2 skeleton

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
```

`npm run smoke` starts the compiled MCP server through `StdioClientTransport`, lists tools, and calls each Phase 2 tool against a temporary data vault.

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

### `wiki_search`

Searches the same curated roots as `get_context_pack`.

### `git_sync`

Dry-run only.

Reports:

- changed files
- sync classification
- policy reasons
- sensitive pattern flags

It does not commit or push.

## Phase 2 Verification

Phase 2 is considered locally verified when these commands pass:

```powershell
npm run build
npm run check
npm run smoke
```

