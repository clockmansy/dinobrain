# DinoBrain Architecture

Date: 2026-07-01
Status: Phase 1 foundation

## Purpose

DinoBrain gives Codex and Claude a controlled way to use project memory through MCP.

It is not a general file sync app, note taking app, or visual knowledge graph. The first useful version must prove that it can select relevant context, explain why it selected that context, and keep unsafe or low-confidence material out of the working pack.

## Repository Split

### App Repo: `dinobrain`

Owns executable behavior:

- MCP server
- tool definitions
- policy checks
- context pack assembly
- search and indexing
- trace console
- test and evaluation harnesses

### Data Repo: `dinobrain-data`

Owns durable local knowledge:

- wiki notes
- source records
- project records
- task and instance records
- review queue
- error book
- trace/event logs

The app repo may read and write the data repo only through approved tools and policies.

## Phase 2 Tool Boundary

The first MCP server skeleton will expose these tools:

- `start_task`
- `finish_task`
- `get_context_pack`
- `wiki_search`
- `git_sync` as dry-run only

No other tools are approved until the plan is updated.

The Phase 2 skeleton is implemented as a stdio MCP server in `src/index.ts`.

## Write Boundary

The final architecture uses a single MCP server as the writer.

Role threads, browser pages, and ad hoc scripts must not write directly to shared vault files. They may request writes through MCP tools once those tools exist.

## Context Pack Boundary

Session start must not read the entire data vault.

The Standard Pack is assembled from narrow metadata and recent records:

- file name
- frontmatter
- title
- summary
- tags
- recent task records

Deep Pack behavior is deferred until the core retrieval path is working.

## Trace Boundary

Every context decision should eventually leave a trace record explaining:

- what was selected
- why it was selected
- what was excluded
- which policy allowed or blocked the action

The Phase 1 trace target is documentation only. Implementation begins in Phase 2.

## Deferred Work

The following are intentionally deferred:

- Observatory visual UI
- multi-user permission model
- external fact ingestion
- automatic push without policy checks
- vector search before keyword/frontmatter retrieval is proven
