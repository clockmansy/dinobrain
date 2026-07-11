# SQLite Shards

Date: 2026-07-05
Status: v6 contextual retrieval rows, explicit knowledge roles, and private-source exclusion implemented

## Goal

The JSON Wiki and operations indexes are useful manifests, but very large JSON files still have to be read and parsed as a whole.

SQLite shards are the next speed layer:

```text
.dino/index/sqlite/wiki.sqlite
.dino/index/sqlite/operations.sqlite
.dino/index/sqlite/manifest.json
```

The shards split the hot retrieval surface by domain:

- `wiki.sqlite`: curated Wiki/Source/Project/accepted records, contextual row metadata, terms, graph nodes, graph edges
- `operations.sqlite`: tasks, traces, Context Packs, Context Pack items, events

## Runtime Behavior

When SQLite shards exist:

- `wiki_search` routes through `wiki.sqlite`
- `get_context_pack` routes curated candidate selection through `wiki.sqlite`
- recent task context routes through `operations.sqlite`
- Observatory reads recent rows from `operations.sqlite`
- MCP writes update `operations.sqlite` incrementally
- sparse rows preserve bounded chunk context, source SHA-256, parent path, language, lifecycle, verification status, retrieval lane, knowledge role, and aliases
- semantic candidates are selected as an independent bounded cosine top-K before RRF/reranking
- exact/prefix term expansion uses indexed ranges; matching term rows and
  candidate records are fetched in bounded batches rather than N+1 statements
- record, node, edge, and term counts come from immutable shard metadata on
  warm paths instead of repeated whole-table `COUNT(*)`
- graph windows use `(type, count, id)` and source-edge indexes with explicit
  node/edge quotas

If the shards are missing or use an old shard metadata version, DinoBrain falls back to the JSON indexes and legacy scanners.

## Refresh

Manual full rebuild:

```powershell
npm run build
npm run index:sqlite
```

The installer runs `npm run index:sqlite` after building the app so fresh machines start with SQLite shards already prepared.

## Verification

```powershell
npm run build
npm run index:verify:sqlite
npm run scale:50k:verify
npm run scale:50k:check
```

The verifier creates a synthetic vault with more than 1,200 Wiki records and 1,200 operational records. It proves:

- the two shard files and manifest are written
- direct Wiki search reports `retrieval_mode: lexical_fallback_v2` when no dense vector index is configured
- routed `wiki_search` reports `retrieval_mode: lexical_fallback_v2` when no dense vector index is configured
- routed Context Pack retrieval reports `retrieval_mode: lexical_fallback_v2` when no dense vector index is configured
- recent task lookup comes from SQLite
- incremental task/event writes are visible without rebuilding the shard
- contextual row metadata and per-result score contribution breakdowns survive SQLite routing

## Session Growth Boundary

This is still a local single-user SQLite layer.

The first hot/warm/cold session growth layer is implemented by `import_session`; see `docs/SESSION_INGEST.md`.

The qualifying 50k proof demonstrates the current single Wiki shard within the
declared HG-04 latency and memory budgets. Physical project/time/temperature
sharding remains an optional next step beyond that tested envelope, not a
substitute for lifecycle-based hot/cold exclusion. Raw session archives remain
local-only and outside retrieval.
