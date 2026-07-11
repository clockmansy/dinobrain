# DinoBrain Readiness And RAM Operations

Last verified: 2026-07-11

## Canonical Read Model

`src/readiness.ts` is the only readiness authority. It reads the immutable
status-generation manifest, groups evidence through the typed 12-gate
completion registry, and overlays only a completion-audit verdict that is
hash-bound to the same generation.

Every CLI/API/UI gate row contains:

- final and operational status;
- completion-audit status;
- stable reason codes;
- immutable proof paths;
- freshness and generation id;
- the next safe command.

The stable `parity_hash` excludes wall-clock-only fields. CLI, Observatory API,
health, graph, and graph-health consumers must report the same hash.

```powershell
npm run status:readiness -- --allow-not-ready
npm run readiness:verify
npm run observatory:verify
```

`ready` is impossible when mandatory evidence is warning-bearing, stale,
malformed, missing, source-drifted, snapshot-tampered, or bound to another
generation. Operational health is kept separate from final completion so
`status:refresh` can rebuild evidence before the final completion audit runs.

## RAM Root Cause

Two independent amplification paths were found.

1. RAG proof sent every Wiki record to MiniLM in one inference batch. ONNX
   intermediate tensors grew with the corpus and produced a 3.38 GiB refresh
   peak on the current vault.
2. Observatory re-statted every generation source for every managed artifact
   read. A single screen poll could therefore multiply into hundreds of file
   operations.

Status generation also read complete SQLite files into Node buffers for hash
verification. That was not the dominant current-vault peak, but it would scale
poorly with larger shards.

## Applied Bounds

- semantic inference defaults to four texts per batch;
- each semantic input is capped at 2,000 characters and tokenizer truncation is
  enabled;
- the semantic pipeline is disposed after status refresh;
- SQLite generation copy and SHA-256 verification are streaming;
- Observatory coalesces in-flight reads and checks source stats at most once
  per short TTL window;
- the combined live snapshot measures its serialized size and trims only its
  projected graph/event windows to a 240 KiB target while leaving the standalone
  state, graph, and readiness APIs intact;
- UI polling is recursive and cannot overlap.

Configuration knobs:

```text
DINOBRAIN_SEMANTIC_BATCH_SIZE=4
DINOBRAIN_SEMANTIC_MAX_INPUT_CHARS=2000
DINOBRAIN_OBSERVATORY_SOURCE_STAT_TTL_MS=1000
DINOBRAIN_OBSERVATORY_GENERATION_VERIFY_TTL_MS=30000
```

## Measured Result

Current-vault `status:refresh` measurements on 2026-07-11:

| Run | Peak process RSS | Peak system RAM | Elapsed | Result |
| --- | ---: | ---: | ---: | --- |
| Before batching | 3.38 GiB | 17.09 GiB | 24.5 s | evidence published; pre-existing audit drift blocked exit |
| Batch 16 | 1.40 GiB | 15.21 GiB | 19.3 s | healthy |
| Batch 4 | 666 MiB | 14.55 GiB | 18.3 s | healthy |

The 64 MiB SQLite generation regression showed an RSS increase of about
1.2 MiB, below its 96 MiB ceiling. The parity fixture Observatory used about
119 MiB RSS and stayed below its 256 MiB ceiling. The current-vault combined
snapshot measured 238.7 KiB after bounded projection.

These are regression baselines, not universal hardware guarantees. Re-run the
same commands after changing the model, batch size, corpus size, or shard
format.
