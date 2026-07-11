# DinoBrain RAM Diagnosis

Date: 2026-07-11

## Measured Baseline

- Host memory: 31.93 GB total, 56.8% used during the audit.
- Two simultaneous Observatory servers held about 267 MB and 221 MB private memory.
- The old `/api/state` path returned about 2.04 MB and took about 3 seconds.
- The browser requested state, graph, and readiness every 1.2 seconds; graph rebuilt state again.
- Twenty concurrent generation checks added about 136 MB RSS.
- Thirty unique semantic queries with one pipeline construction per query added about 199 MB RSS; reusing one pipeline stayed approximately flat.
- Several stdio MCP processes were live. Each process can retain its own semantic model.

These numbers identify DinoBrain overhead, not all system RAM. Other applications can still dominate total host use.

## Root Causes And Fixes

1. Observatory performed overlapping full-vault work and returned oversized state. It now coalesces in-flight state, graph, readiness, and snapshot work; reads bounded windows; projects a compact DTO; and uses completion-driven 3-second browser polling.
2. Semantic embedding created a Hugging Face pipeline on each cache miss. It now caches one initialization promise per model/configuration, serializes inference, bounds the cache, and disposes evicted pipelines.
3. Live query vectors accumulated without a limit. They now use an LRU with a default capacity of 128 and a hard configuration ceiling.
4. The old and test Observatory processes ran together. They were replaced by one current server on port 3847.

Immediately after replacement, the current Observatory used about 86 MB private memory and served a 171,574-byte snapshot. Removing the two prior servers reduced Observatory private allocation by roughly 402 MB at that measurement point.

A real-server stress check then sent 400 snapshot requests in two 200-request rounds. The warmed second round grew private memory by 9.8 MB, while cumulative cache counters recorded 3 snapshot builds, 398 cache hits, and 38 in-flight coalesces. The later snapshot payload was 181,943 bytes, below the 256 KiB state budget.

## Verification

```powershell
npm run verify:live-query-cache-budget
npm run verify:semantic-pipeline-cache
npm run observatory:verify
```

The resource regression requires bounded cache size, one pipeline construction under concurrent callers, serialized inference, a compact Observatory payload, and no overlapping refresh loop.

## Residual Risk

Each live stdio MCP connection is still a separate Node process. A warm process may retain one model, so many simultaneous Codex/subagent connections can multiply RAM even though each process is now internally bounded. RAG-04 should benchmark this at scale and decide whether to add a shared local embedding sidecar. Closed MCP connections must also be verified to exit promptly.
