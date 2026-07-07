# DinoBrain RAG OS Consensus

Date: 2026-07-07
Status: active critical audit
Consensus: 20/20 subagents agree

## Verdict

DinoBrain has the right skeleton for a local-first memory OS, but it is not yet
the user's target OS: any Codex or Claude session must receive trusted
pre-response context, use a fast and meaningful LLM Wiki, write back only
reviewed knowledge, evaluate behavior improvement, and push safe recoverable
state to GitHub.

Current DinoBrain is best described as:

- configured memory OS scaffolding
- honest lexical fallback retrieval when dense vectors are absent
- useful observability and sync tools
- incomplete live hook proof, lifecycle backpressure, provenance atomicity, and
  answer-quality evaluation

## External RAG Criteria

The audit used these current methodology anchors:

- [Anthropic Contextual Retrieval](https://www.anthropic.com/engineering/contextual-retrieval):
  contextual chunk text should improve both
  embedding and BM25 retrieval, and reranking should be measured.
- [Weaviate Hybrid Search](https://docs.weaviate.io/weaviate/concepts/search/hybrid-search):
  dense vector search and BM25 keyword search should be
  fused with tunable ranking, not replaced by a lexical-only fallback.
- [Ragas metrics](https://docs.ragas.io/en/stable/concepts/metrics/available_metrics/):
  retrieval should be evaluated separately from answer quality
  with context precision/recall, response relevancy, faithfulness, noise, and
  correctness-style metrics.
- [Microsoft GraphRAG](https://microsoft.github.io/graphrag/):
  a graph layer should add entity/community/relationship
  structure when graph reasoning is claimed; a folder/tag graph alone is not
  GraphRAG.

## Seven Agreed Fixes

1. Real dense hybrid retrieval and rerank evaluation
   - Add multilingual embeddings, bounded dense top-K, BM25/sparse candidates,
     rank fusion, reranking, and retrieval canaries.
   - Keep reporting `lexical_fallback_v2` until dense canaries pass.

2. Fail-closed pre-response proof
   - Treat `configured`, `probe_verified`, and `live_proven` as separate states.
   - Do not claim OS readiness until a real `codex_desktop` prompt produces
     matching hook events and a live report.

3. Lifecycle and queue cleanup
   - Run automatic merge/hold/archive/delete-candidate passes.
   - Prevent hundreds of pending behavior rules from becoming knowledge debt.

4. Atomic source/chunk/claim provenance
   - Separate internal behavior memory from externally verified factual claims.
   - Require claim records to resolve to source chunks, provenance records, or
     explicit internal-session evidence.

5. Real behavior evaluation
   - Keep retrieval lift as a retrieval metric.
   - Add paired memory-on/memory-off answer generation and judge faithfulness,
     correctness, relevance, forbidden facets, source use, latency, and task
     success.

6. Operation-log pollution control
   - Keep `.dino/tasks`, traces, context packs, gates, events, and task
     summaries out of default LLM Wiki search.
   - Use Observatory or explicit operations search for operational state.

7. Auto-sync proof and safety
   - Default to syncing reviewed, sanitized knowledge artifacts.
   - Treat prompt-derived task/context/review logs as local-only or explicitly
     private/encrypted backup material.

## Work Completed In This Pass

- Merged DinoBrain Codex prompt hook into the first existing
  `UserPromptSubmit` hook group so Codex trust/indexing sees the hook in the
  expected slot.
- Added stale MCP runtime cleanup to the Codex hook approval launcher.
- Prevented auto-generated task-summary growth records from being marked
  accepted before review.
- Excluded task summaries and `.dino` operational files from default retrieval
  paths and tightened context evaluation so operational leakage counts as noise.
- Limited recent task injection to operation/recent-task intent.
- Rebuilt SQLite shards with an atomic temp-shard replacement path and retry,
  reducing `database is locked` failure risk.
- Added Korean correction/preference cues such as "아니야", "내가 원한 건",
  "아쉬운데", "덜어내자", and "무조건" to session/compounding extraction.

## Current Verification Snapshot

Passing locally:

- `npm run build`
- `npm run check`
- `npm run eval:context`
- `npm run eval:behavior`
- `npm run index:sqlite`
- `npm run verify:os`
- `npm run safety:public-data:check` with `blockers=0`

Still incomplete:

- `npm run verify:codex-live:recent` still requires a fresh trusted Codex
  Desktop prompt with `launch_kind=codex_desktop`.
- Dense vector index is still absent, so retrieval should not be called complete
  hybrid RAG.
- Behavior evaluation still checks context lift, not generated answer quality.
- Public-data safety still reports warnings that should be triaged before
  public release claims.
- Installed auto-sync is public-safe by default: conditional prompt-derived
  artifacts and hook preflight records are not auto-pushed unless the operator
  explicitly opts in.

## Completion Evidence Required

DinoBrain can be called the target OS only when all of these are true:

- live Codex and Claude prompt hooks are proven with fresh pre-response events;
- Context Packs use real hybrid retrieval or honestly report degraded fallback;
- source-backed claims resolve to source chunks and provenance;
- lifecycle drains candidate/review backlog instead of growing it unbounded;
- memory-on answer behavior beats memory-off on representative user tasks;
- Observatory shows live proof, graph freshness, pending taxonomy, used memory,
  gate state, and sync status;
- GitHub restore reproduces app/data/index/hook behavior without unsafe local
  `.codex` pollution.
