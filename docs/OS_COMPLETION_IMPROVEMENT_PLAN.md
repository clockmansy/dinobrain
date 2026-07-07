# DinoBrain OS Completion Improvement Plan

Date: 2026-07-07
Status: active implementation plan
Governing document: `docs/OS_COMPLETION_CONDITIONS.md`

## Position

DinoBrain should not be called a complete OS until each mandatory gate has fresh
evidence from the real app repo, the real data vault, and at least one trusted
live Codex prompt. Current work should therefore make incomplete gates more
observable and harder to accidentally overclaim.

## Current Improvement Pass

This pass targets the biggest completion disqualifier that can be improved
without pretending live hook attention has been proven:

- Gate 1, Live Pre-Response OS Loop
- Gate 4, Retrieval Quality And Honest Mode
- Gate 5, LLM Wiki And Graph Health
- Gate 6, Memory Lifecycle And Compounding Hygiene
- Gate 12, Safety, Privacy, And Public Data
- Gate 14, Sync, Release, And Repository Hygiene
- Gate 15, Verification Registry

The user also supplied RAG methodology anchors from another OS learning pass.
Those anchors advance:

- Gate 7, Source Truth And Provenance
- Gate 8, Behavior Evaluation, as future retrieval-quality source material

The data vault may be public. Public safety can no longer rely on a tiny token
scan or private-repo assumption. The repo now has a real public-data safety
verifier:

```powershell
npm run safety:public-data
```

The verifier writes:

```text
60_Operations/public-data-safety/public-data-safety-report.json
60_Operations/public-data-safety/public-data-safety-report.md
```

The RAG source-anchor seed command is:

```powershell
npm run sources:rag:seed
```

It writes:

```text
20_Wiki/RAG-Methodology-Anchor-Catalog.md
30_Sources/chunks/<rag-anchor>.json
.dino/provenance/<rag-anchor>.json
```

These records are explicitly `anchor_only_unverified`; they preserve URLs and
methodology topics for later verified source chunking without pretending the
linked source contents were reviewed.

## Gate Map

| Gate | Current Classification | Evidence Now Required | Current Improvement |
| --- | --- | --- | --- |
| 1. Live pre-response OS loop | configured / probe-verified, not complete | fresh trusted Codex prompt creates preflight events before manual MCP calls | unchanged in this pass |
| 2. Real fail-closed behavior | partial | gate reports show missing context, forged trace, sensitivity, destructive/sync risk | covered by existing `verify:v2`; not expanded here |
| 3. Closed task lifecycle | partial | started tasks are finished, blocked, or stale-marked | current task must finish with `finish_task` |
| 4. Retrieval quality and honest mode | partial | SQLite fast path, bounded sparse/dense candidates, honest fallback mode | unchanged in this pass |
| 5. LLM Wiki and graph health | partial | current graph health agrees with current corpus and index timestamps | unchanged in this pass |
| 6. Memory lifecycle and compounding hygiene | partial | auto-compounded behavior rules are cleaned, held, merged, or reviewed | unchanged in this pass |
| 7. Source truth and provenance | improved | factual claims have durable source chunks and provenance links | RAG methodology anchors are seeded as unverified provenance candidates |
| 8. Behavior evaluation | partial | real-vault memory-on beats memory-off on representative cases | unchanged in this pass |
| 9. Memory use audit | partial | representative audits show provided, declared, and observed memory use | unchanged in this pass |
| 10. Feedback writeback | partial | corrections are retrieved later and change behavior eval | unchanged in this pass |
| 11. Observatory as evidence | partial | Observatory shows gates, audits, lifecycle, graph/index, and sync risk | unchanged in this pass |
| 12. Safety, privacy, public data | improved | real data vault scan covers public tracked data and risky local-only records | added `safety:public-data` verifier and docs |
| 13. New PC recovery | partial | fresh install passes same gates and client registration checks | unchanged in this pass |
| 14. Sync/release/repo hygiene | improved | public/private docs match actual repo visibility; dirty state documented | docs reconciled with public/private remote reality |
| 15. Verification registry | improved | completion audit names exact commands and evidence artifacts | added public-data safety command to verification docs |

## Acceptance For This Pass

This pass is complete when:

- `npm run safety:public-data:check` runs on the current real data vault.
- `npm run safety:public-data` writes the public safety report.
- `npm run sources:rag:seed` writes RAG source-anchor and provenance candidate records.
- documentation no longer assumes the data repo is private-only.
- `docs/VERIFICATION.md` lists the public-data safety check.
- `npm run check` passes after the script/package/doc changes.

This pass does not claim DinoBrain OS completion. It only removes one class of
disqualifier and adds a stronger proof artifact for future completion audits.

## 2026-07-07 Twenty-Agent RAG Audit Update

Twenty subagents independently agreed on the same seven next fixes:

1. real dense hybrid retrieval and rerank evaluation;
2. fail-closed pre-response proof for real Codex/Claude prompts;
3. lifecycle and queue cleanup;
4. source/chunk/claim provenance atomicity;
5. real behavior evaluation, not only context retrieval lift;
6. operation-log pollution control;
7. auto-sync proof and safety.

This pass implemented only the safe first slice: operation-log exclusion from
default retrieval, recent-task intent budgeting, atomic SQLite shard refresh,
Codex hook merge/stale-MCP installer fixes, pending-review growth records, and
Korean correction cue coverage.

## Remaining High-Priority Work

1. Live prompt proof: start a fresh trusted Codex thread and verify
   `codex_prompt_submitted` and `codex_preflight_completed` before manual MCP
   calls.
2. Retrieval: add real multilingual embeddings, bounded dense top-K, fusion,
   rerank canaries, and keep `lexical_fallback_v2` honest until this passes.
3. Source truth: seed real `30_Sources/chunks` and `.dino/provenance` records for
   factual claims that should survive as source-backed knowledge.
4. Behavior eval: expand `behavior-golden.json` beyond self-referential OS cases
   and require memory-on answer quality improvement on the real vault.
5. Lifecycle hygiene: reduce broad auto-compounded behavior rules and hold or
   merge weak rules so they do not dominate Wiki/Source/Project retrieval.
6. Retrieval scale proof: measure the starter SLOs on a synthetic 50k curated
   vault and confirm the prompt path remains index-backed.
7. Release parity: rebuild installer artifacts, regenerate SHA files, publish a
   release manifest, and prove app/data refs match the install artifact.
