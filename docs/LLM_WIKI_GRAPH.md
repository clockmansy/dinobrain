# LLM Wiki Graph Index

Date: 2026-07-01
Status: v0 implemented

## Goal

The DinoBrain Wiki should stay fast as session-derived knowledge grows.

The raw source is the user's AI sessions, but raw sessions are not the working memory layer. The intended shape is:

```text
Codex/Claude sessions
-> raw session archive
-> extracted candidates
-> reviewed Wiki/Project/Source/Instance records
-> persistent graph index
-> narrow Context Pack
```

## Obsidian Graph Lesson

An Obsidian-style graph is useful because it gives the system stable nodes and edges:

- records
- folders
- tags
- kinds
- wikilinks
- hot and cold sets

The graph alone does not guarantee speed. Speed comes from using the graph with an index so a query does not read every note on every prompt.

## Current Implementation

The JSON v0 index is written to:

```text
.dino/index/wiki-index.json
```

It contains:

- normalized curated records from `20_Wiki`, `30_Sources`, `40_Projects`, `50_Instances/accepted`, `60_Operations`, and `70_Error_Book`
- an inverted index from token to record ids
- graph nodes and edges for folders, tags, kinds, and wikilinks
- a recent hot set and a cold record set

The preferred fast path is now the SQLite shard:

```text
.dino/index/sqlite/wiki.sqlite
```

When the SQLite shard exists, `get_context_pack` and `wiki_search` use it for candidate selection. If the shard is missing, DinoBrain falls back to the JSON index.

The final `get_context_pack` ranking still follows the narrow Phase 3 boundary:

- file name
- frontmatter
- title
- summary
- tags
- recent task records

`wiki_search` may use excerpts because it is an explicit narrow lookup tool.

## Refresh Rules

If no index exists, DinoBrain builds it automatically on the next indexed query.

The MCP server invalidates the index when it writes data that changes curated retrieval:

- accepted instance approval
- quarantine record creation

Direct manual vault edits can be refreshed with:

```powershell
npm run build
npm run index:sqlite
```

## Verification

The focused index verifier creates a synthetic vault with more than 1,500 records and proves that a rare query is resolved through a smaller candidate set:

```powershell
npm run build
npm run index:verify
```

SQLite shard verification:

```powershell
npm run build
npm run index:verify:sqlite
```

## Related Operations Index

The next performance boundary after curated Wiki retrieval is operational data growth.

Tasks, traces, context packs, and event logs use `.dino/index/operations-index.json` so "latest task" and Observatory views do not sort every historical file forever. See `docs/OPERATIONS_INDEX.md`.
