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
- redacted local-only session archives

The app repo may read and write the data repo only through approved tools and policies.

## MCP Tool Boundary

The MCP server exposes the approved write/read surface:

- `start_task`
- `finish_task`
- `get_context_pack`
- `wiki_search`
- `search_cold_memory`
- `import_session`
- `audit_memory_use`
- `git_sync` as dry-run only
- `create_candidate_instance`
- `review_candidate`
- `quarantine_record`
- `apply_review_backpressure`
- `apply_cold_partitions`

The server is implemented as a stdio MCP server in `src/index.ts`.

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

## LLM Wiki Graph Index

The Obsidian-style graph goal is represented by a persistent Wiki index, not by visual graph layout alone.

The Wiki index writes `.dino/index/wiki-index.json` and uses it to narrow `get_context_pack` and `wiki_search` candidates before ranking. Each v6 row stores bounded contextual text, source hash, parent path, language, lifecycle, verification, retrieval lane, explicit knowledge role, and aliases alongside token-to-record mappings, graph nodes, graph edges, hot recent records, and cold records. Semantic vectors use an independent cosine top-K; sparse, dense, RRF, rerank, provenance, lifecycle, lane, recency, and noise contributions remain inspectable. Source publication uses a separate hash-preconditioned transaction that binds a fetched-source snapshot, bounded chunk, provenance record, exact claim hashes, evidence hashes, and a generation receipt before any claim support becomes visible.

This keeps the default prompt path from reading every curated Wiki/Project/Source/Instance file on every request. See `docs/LLM_WIKI_GRAPH.md`.

## Operations Index

Live OS records use `.dino/index/operations-index.json`.

The MCP server updates this index when it writes tasks, traces, Context Packs, and events. Recent-task retrieval and Observatory state read this index before falling back to legacy directory scans. See `docs/OPERATIONS_INDEX.md`.

## SQLite Shards

SQLite shards are the preferred speed layer over the JSON manifests.

The app writes `.dino/index/sqlite/wiki.sqlite`, `.dino/index/sqlite/operations.sqlite`, and `.dino/index/sqlite/manifest.json`. Runtime retrieval uses the SQLite shards first, then falls back to JSON indexes when shards are missing. See `docs/SQLITE_SHARDS.md`.

## Session Ingest Boundary

Sessions can be used as source material through `import_session`.

The tool stores only redacted local-only archives under `10_Conversations/raw`, extracts review candidates under `50_Instances/candidates`, and writes promotion review records under `80_Review_Queue/promotion`.

Raw archives, candidates, and review records are excluded from default retrieval. Only reviewed accepted instances can become normal Context Pack input. See `docs/SESSION_INGEST.md`.

## Review Backpressure And Cold Boundary

The review queue is bounded before candidate/review publication. One serialized
admission ledger applies lane and global budgets; overflow is durable cold hold,
not silent loss and not hot growth. Exact and high-confidence near duplicates
become one provenance-complete merge review through a hash-preconditioned,
rollback-capable transaction. Logical monthly cold partitions exclude old
operations and obsolete rules from normal prompt retrieval without moving
source truth. See `docs/REVIEW_QUEUE_BACKPRESSURE.md`.

## Trace Boundary

Every context decision should eventually leave a trace record explaining:

- what was selected
- why it was selected
- what was excluded
- which policy allowed or blocked the action

`audit_memory_use` adds a short audit instance over task traces. It separates memory evidence into `provided`, `declared_used`, and `observed_used`, records a trust score, and snapshots graph health without storing raw conversation logs.

## Deferred Work

The following are intentionally deferred:

- multi-user permission model
- external fact ingestion
- automatic push without policy checks
- vector search before keyword/frontmatter retrieval is proven
- unredacted full transcript storage

## Phase 5 Promotion And Demotion Boundary

Phase 5 adds three policy tools:

- `create_candidate_instance`
- `review_candidate`
- `quarantine_record`

Candidate instances are never auto-promoted. They enter `50_Instances/candidates` and `80_Review_Queue/promotion` first.

Quarantine records live in `.dino/quarantine`. Default Context Packs must exclude any target path listed in an active quarantine record.
