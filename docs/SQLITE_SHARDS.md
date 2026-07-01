# SQLite Shards

Date: 2026-07-01
Status: v0 implemented

## Goal

The JSON Wiki and operations indexes are useful manifests, but very large JSON files still have to be read and parsed as a whole.

SQLite shards are the next speed layer:

```text
.dino/index/sqlite/wiki.sqlite
.dino/index/sqlite/operations.sqlite
.dino/index/sqlite/manifest.json
```

The shards split the hot retrieval surface by domain:

- `wiki.sqlite`: curated Wiki/Source/Project/accepted records, terms, graph nodes, graph edges
- `operations.sqlite`: tasks, traces, Context Packs, Context Pack items, events

## Runtime Behavior

When SQLite shards exist:

- `wiki_search` routes through `wiki.sqlite`
- `get_context_pack` routes curated candidate selection through `wiki.sqlite`
- recent task context routes through `operations.sqlite`
- Observatory reads recent rows from `operations.sqlite`
- MCP writes update `operations.sqlite` incrementally

If the shards are missing, DinoBrain falls back to the JSON indexes and legacy scanners.

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
```

The verifier creates a synthetic vault with more than 1,200 Wiki records and 1,200 operational records. It proves:

- the two shard files and manifest are written
- direct Wiki search returns `retrieval_mode: sqlite_shards_v0`
- routed `wiki_search` returns `retrieval_mode: sqlite_shards_v0`
- routed Context Pack retrieval returns `retrieval_mode: sqlite_shards_v0`
- recent task lookup comes from SQLite
- incremental task/event writes are visible without rebuilding the shard

## Remaining Boundary

This is still a local single-user SQLite layer.

Later large-scale work should add hot/warm/cold partitioning by time or project, plus a raw session import pipeline that writes extracted candidates into reviewable records instead of pushing raw transcripts into retrieval.
