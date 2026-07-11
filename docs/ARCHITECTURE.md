# DinoBrain Architecture

Date: 2026-07-11
Status: OS v2 completion execution

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

- `os_begin_task`
- `os_gate`
- `start_task`
- `heartbeat_task`
- `finish_task`
- `get_context_pack`
- `wiki_search`
- `search_cold_memory`
- `import_session`
- `audit_memory_use`
- `git_sync` as dry-run only
- `auto_sync` as task-scoped only
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

## Evaluation Isolation And Resource Boundary

Normal Context Packs may use recent task records. Versioned RAG and answer-quality evaluations explicitly exclude them so test prompts, judge tasks, and prior evaluation output cannot satisfy their own golden cases. Answer calibration binds the golden, generated answer hashes, combined answer/retrieval runtime identity, dense index, judge protocol, judge IDs, and durable review artifact.

Live semantic query vectors use a bounded LRU. A process keeps at most the configured semantic pipeline count and serializes inference per pipeline. Observatory coalesces in-flight state work, serves one bounded snapshot DTO, and polls only after the prior refresh completes. Multiple live stdio MCP connections still create separate processes and can duplicate one model residency per process; a shared embedding sidecar remains later scale work.

At 50k scale, sparse term expansion uses an indexed exact/prefix range and
matching terms plus candidate rows are fetched in bounded batches instead of
N+1 statements. Dense search first probes semantic partition centroids and
scans at most 4,096 vectors; an oversized unpartitioned index fails back to
`lexical_fallback_v2`. The parsed dense index is an mtime-bound single-entry
cache. SQLite shard builds omit JSON-only adjacency/cold-hotset materialization,
store record/node/edge counts as metadata, and index graph node type/count.
Observatory verifies a changed status-generation pointer immediately but does
not rehash an unchanged multi-hundred-megabyte generation on every poll.

## SQLite Shards

SQLite shards are the preferred speed layer over the JSON manifests.

The app writes `.dino/index/sqlite/wiki.sqlite`, `.dino/index/sqlite/operations.sqlite`, and `.dino/index/sqlite/manifest.json`. Runtime retrieval uses the SQLite shards first, then falls back to JSON indexes when shards are missing. See `docs/SQLITE_SHARDS.md`.

## Session Ingest Boundary

Sessions can be used as source material through `import_session`.

The tool stores only redacted local-only archives under `10_Conversations/raw`, extracts review candidates under `50_Instances/candidates`, and writes promotion review records under `80_Review_Queue/promotion`.

Raw archives, candidates, and review records are excluded from default retrieval. Only reviewed accepted instances can become normal Context Pack input. See `docs/SESSION_INGEST.md`.

## Unified Public Data Classification Boundary

`src/data-classification.ts` is the only public-data classifier. Policy version
`data_classification_20260712_v3` classifies every path through an explicit
allowlist and performs a complete scan of supported regular files before they
can be treated as syncable. It fails closed on unclassified paths, symlinks,
submodules, unsupported or binary file types, files over the complete-scan limit, invalid UTF-8, malformed
JSON/JSONL, secret shapes, machine-local paths, raw transcript markers, and
missing accepted-memory review lineage.

The MCP `git_sync`/`auto_sync` paths import this module directly. The public-data
audit and installed data Git hooks call the same built module through
`scripts/classify-data-git-surface.mjs`. Hook configuration is local-only under
the data repository Git directory and binds the Node executable, classifier
entrypoint, and policy version. Missing or mismatched runtime configuration is a
blocking result. Pre-push scans only the commits named by Git's push update
stream, including intermediate blobs that were later deleted, while the public
audit scans every unique historical blob in bounded batches.

## Task-Scoped Synchronization Boundary

Automatic Git writes use policy `task_sync_scope_20260711_v2`. Each task owns a
local-only scope ledger under `.dino/sync-scopes`; entries bind a relative
regular-file path to SHA-256, Git-filtered blob id, byte size, writer identity,
and review state. MCP
writers register artifacts at creation or lifecycle transition. Candidate and
growth outputs cannot become auto-syncable merely because a caller names them:
they remain `pending_review` until the review path promotes them.

`auto_sync` requires a task id and nonempty requested path set, verifies every
entry and current file hash, re-runs the unified public-data classifier, rejects
unrelated staged files, and invokes `git add` only for the verified
intersection. Dirty files outside the task are observed in bounded summaries
but left untouched. The state machine distinguishes `blocked`, `no_op`,
`committed`, `pushed`, and `retry_required`; a remote failure after a successful
commit preserves the commit identity for explicit retry.

Conditional artifacts require an additional public receipt under
`60_Operations/task-sync-receipts`. The receipt binds the task record, task
request hash, local scope-ledger hash and revision, classifier policy, and every
selected artifact's SHA-256, Git-filtered blob id, size, path, producer, and
approval state. It is committed with the artifacts, and commit trailers bind
the receipt path, file hash, and blob id to the commit. Pre-commit rechecks the
live local scope ledger; pre-push and full-history scans independently recheck
the public receipt and committed blobs. A repository-wide Git lock serializes
automatic stage/commit/push operations.

For a data-publication action, `os_gate` accepts an exact requested path set but
does not trust it directly. The server resolves those paths against the task's
local scope ledger, rechecks current hashes, Git blob identities, approval
state, and classifier results, and reports unrelated dirty files separately as
out of scope. An unregistered, changed, pending, or blocked requested path
still fails closed; unrelated backlog cannot veto an otherwise verified scoped
operation.

Scope filenames include the scope policy version. An installer/update can start
a v2 ledger without rewriting or trusting an in-flight v1 ledger; artifacts
must be registered again by current v2 writers before they become syncable.

Durable task records store `data_root: "."` rather than a machine-local
absolute path. Runtime responses and local diagnostics may still expose the
resolved root, but pushed task evidence remains portable across computers.

## Private Recovery Boundary

GitHub stores reviewed, classifier-approved knowledge. Raw conversations,
private sources, attachments, local events, credentials, and user client config
use a separate authenticated encrypted archive. The archive is streamed so file
size does not become process memory, and its public header contains no private
paths. Restore authenticates into isolated staging before any target write,
requires matching app/data Git identity, and refuses existing private files
unless overwrite is explicit and rollback copies verify. Recovery keys,
archives, staging, and receipts are local-only. See
`docs/PRIVATE_BACKUP_RECOVERY.md`.

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
- shared cross-process embedding service for eliminating per-MCP model residency
- unredacted full transcript storage

## Phase 5 Promotion And Demotion Boundary

Phase 5 adds three policy tools:

- `create_candidate_instance`
- `review_candidate`
- `quarantine_record`

Candidate instances are never auto-promoted. They enter `50_Instances/candidates` and `80_Review_Queue/promotion` first.

Quarantine records live in `.dino/quarantine`. Default Context Packs must exclude any target path listed in an active quarantine record.
