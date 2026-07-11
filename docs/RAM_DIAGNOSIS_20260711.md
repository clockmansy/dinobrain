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

## SAFE-02 Workload Observation

During the SAFE-02 implementation, host use stayed around 59-61%. The largest
single process was an unrelated application at about 2.5 GB working set. The
DinoBrain-specific steady-state set was:

- two identical `dist/index.js` stdio MCP children of the Codex app at about
  251 MB and 122 MB working set (144 MB and 34 MB private)
- one Observatory process at about 184 MB working set (105 MB private)
- both MCP processes started before the current `dist/index.js` modification
  time, so both were stale; `config.toml` contained only one DinoBrain server
  registration

The task-scoped sync build plus isolated MCP/Git fixture temporarily increased
the total Node working set by about 755 MB, with system use peaking at 61.1%.
After the test client closed, Node working set returned to about 686 MB. This
confirms a bounded test spike rather than an accumulating leak in that fixture.

## Root Causes And Fixes

1. Observatory performed overlapping full-vault work and returned oversized state. It now coalesces in-flight state, graph, readiness, and snapshot work; reads bounded windows; projects a compact DTO; and uses completion-driven 3-second browser polling.
2. Semantic embedding created a Hugging Face pipeline on each cache miss. It now caches one initialization promise per model/configuration, serializes inference, bounds the cache, and disposes evicted pipelines.
3. Live query vectors accumulated without a limit. They now use an LRU with a default capacity of 128 and a hard configuration ceiling.
4. The old and test Observatory processes ran together. They were replaced by one current server on port 3847.
5. The first 50k run exposed warm-path table scans hidden behind otherwise
   bounded candidate retrieval. Per-request `COUNT(*)`, term-by-term lookup, and
   record-by-record materialization were replaced by shard metadata and bounded
   bulk queries.
6. Dense candidate search now probes 8 semantic partitions and scans at most
   4,096 vectors. The dense index is parsed once per process and an oversized
   unpartitioned index fails closed instead of scanning or returning a partial
   semantic result.
7. Observatory no longer rehashes an unchanged 555 MB status generation every
   250 ms. Pointer changes invalidate immediately; unchanged full-byte
   verification is cached for 30 seconds. Graph type/count and source-edge
   queries use dedicated indexes and the response is capped at 420 nodes and
   800 edges.
8. Completion tests are run serially. Each MCP fixture closes its stdio client
   before the next memory-heavy verifier starts, avoiding additive model and
   TypeScript build peaks.

Immediately after replacement, the current Observatory used about 86 MB private memory and served a 171,574-byte snapshot. Removing the two prior servers reduced Observatory private allocation by roughly 402 MB at that measurement point.

A real-server stress check then sent 400 snapshot requests in two 200-request rounds. The warmed second round grew private memory by 9.8 MB, while cumulative cache counters recorded 3 snapshot builds, 398 cache hits, and 38 in-flight coalesces. The later snapshot payload was 181,943 bytes, below the 256 KiB state budget.

The qualifying RAG-04 run used 50,000 curated records plus 1,000 completed
sessions. It completed in about 115 seconds end to end. Cold shard build was
23.855 seconds; Context Pack, Wiki, graph, and Observatory p95 were 410.995 ms,
141.175 ms, 174.199 ms, and 63.085 ms. The process reported a 1.474 GB RSS peak,
while the external Windows monitor observed 2.252 GB private memory. The first
unoptimized run had reached 3.735 GB private memory and 24-30 second prompt
latency. The final report is `.dino/evaluations/scale-50k-status.json` and all
resource, latency, integrity, and binding assertions pass.

## Verification

```powershell
npm run verify:live-query-cache-budget
npm run verify:semantic-pipeline-cache
npm run observatory:verify
npm run scale:50k:verify
npm run scale:50k:check
```

The resource regression requires bounded cache size, one pipeline construction under concurrent callers, serialized inference, a compact Observatory payload, and no overlapping refresh loop.

## Residual Risk

Each live stdio MCP connection is still a separate Node process. A warm process may retain one model, so many simultaneous Codex/subagent connections can multiply RAM even though each process is now internally bounded. The 50k proof bounds one process but does not remove cross-process model duplication; a shared local embedding sidecar remains the next RAM architecture candidate. Closed MCP connections must also be verified to exit promptly.

Codex currently may retain more than one stale MCP child for the same configured
server even when the configuration contains no duplicate. Safe reclamation
requires a Codex restart or host-level MCP supervisor restart after active work
finishes; terminating those children mid-task can invalidate the current MCP
transport. Installer/update flows should continue to use their stale-MCP
restart path, and a future supervisor should key one process by
workspace/config/runtime identity and reap older generations after a health
handoff.
