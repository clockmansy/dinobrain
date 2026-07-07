# DinoBrain OS Completion Conditions

Status: accepted by 16/16 reviewer final consensus
Date: 2026-07-07
Target: DinoBrain OS v2.2.x

## Purpose

DinoBrain is complete only when it behaves as a local-first memory OS for Codex
and Claude Code, not merely as a note vault, MCP helper, demo graph, or task log.

The user direction recovered from the DinoBrain memories is:

```text
User sessions are the root source.
The OS retrieves relevant reviewed memory before work.
The agent acts with current user instructions taking priority.
The result is recorded.
Useful decisions are reviewed, cleaned up, and made easier to retrieve next time.
Bad, stale, noisy, unsafe, or ungrounded memory is held, merged, excluded, or removed.
The next session measurably behaves better.
```

The practical target is not model-weight learning. The target is an inspectable
closed loop:

```text
fresh user prompt
-> trusted pre-response OS preflight
-> focused Context Pack
-> gated action
-> finish trace
-> reviewed memory growth
-> lifecycle cleanup
-> behavior evaluation
-> policy-gated sync/recovery
-> improved future session
```

## Non-Goals

- Not raw transcript storage.
- Not a decorative graph or branding exercise.
- Not an excuse to bypass Codex or Claude hook trust.
- Not external source truth merely because an internal task trace says so.
- Not full autonomy merely because tools are listable or a synthetic verifier passes.
- Not public-data safety based only on a token-pattern scan.

## Definitions

- **Complete**: all mandatory gates in this document pass on the real local app
  repo and real data vault, with fresh evidence.
- **Configured**: files/settings exist, but live behavior has not been observed.
- **Probe-verified**: a simulator or direct command worked, but a fresh trusted
  user prompt has not proven the loop.
- **Live-verified**: a fresh trusted Codex/Claude prompt produced the expected
  pre-response events before manual MCP calls.
- **Accepted memory**: reusable DinoBrain memory that passed the required
  review/evidence gates for its type.
- **Behavior memory**: a user/agent preference, correction, or operating rule
  derived from prior work. It can guide behavior, but it is not external fact.
- **Source truth**: evidence from durable source chunks, external documents, or
  independently verifiable artifacts.
- **Context Pack**: the focused memory bundle supplied before work, with reasons,
  retrieval mode, candidate source, and trace path.
- **Proof artifact**: command output, repo state, live event log, trace, audit,
  screenshot, source chunk, or verifier report that independently supports a
  completion claim.

## Mandatory Gates

### 1. Live Pre-Response OS Loop

Completion requires live proof from a fresh trusted Codex and, where installed,
Claude Code session:

- `UserPromptSubmit` hook runs before the model response.
- `codex_prompt_submitted` and `codex_preflight_completed` or equivalent events
  are written before any manual MCP call.
- `os_begin_task` is the default v2 entrypoint.
- `start_task + get_context_pack` is only fallback behavior when injected
  preflight is absent.
- The injected context includes task id, Context Pack trace, gate result,
  retrieval mode, `fail_closed`, selected memory paths, and finish protocol.
- Current user instructions always outrank stored memory.

Disqualifier: calling DinoBrain configured or complete from config files,
simulated hooks, or old probe logs alone.

### 2. Real Fail-Closed Behavior

DinoBrain must fail closed, or at minimum constrain action with explicit safe
instructions, when:

- OS context is unavailable.
- Context Pack trace is missing or forged.
- duplicate hook locks exist without a concrete sibling preflight report.
- required OS tools are unavailable.
- prompt content is sensitive.
- destructive, sync, release, or backup risk is detected.

Gate reports must be inspectable, and Observatory must show blocked, degraded,
or pending states instead of flattening them into ordinary activity.

### 3. Closed Task Lifecycle

For normal nontrivial work:

- A task is started before implementation or analysis.
- A Context Pack trace is created.
- Work can perform narrow `search_memory` / `wiki_search` lookups when the pack
  is not enough.
- `finish_task` records summary, outcome, changed files, decisions, next steps,
  context pack paths, used memory paths, and remaining work.
- Started tasks are finished, blocked, or explicitly marked stale.

Disqualifier: many stale `started` tasks counted as live health.

### 4. Retrieval Quality And Honest Mode

DinoBrain must retrieve meaningful information quickly as the data grows:

- `get_context_pack` and `wiki_search` use the live SQLite wiki and operations
  shards when available.
- live `wiki.sqlite`, `operations.sqlite`, and manifest files are fresh.
- normal prompt paths do not full-scan the vault except as visible degraded mode.
- sparse and dense candidate generation is bounded and index-backed at scale.
- sparse retrieval does not rely on leading-wildcard term scans or other
  vocabulary-wide scans on normal prompt paths.
- dense retrieval uses top-K bounded vector retrieval and does not load or
  expose every vector as a prompt-path candidate.
- retrieval mode is honest: `hybrid_contextual_v2` only when a usable dense
  vector index/provider participates; otherwise report `lexical_fallback_v2`.
- BM25/sparse, dense, RRF, provenance, root-intent, and lifecycle reasons are
  inspectable.
- broad operational behavior rules cannot swamp durable Wiki, Source, and
  Project records.
- type budgets, noise gates, and recency/provenance rules are enforced.

Starter SLOs to make concrete before completion:

- preflight Context Pack p95 under 700 ms on a warm index.
- `wiki_search` p95 under 300 ms at 50k curated records.
- recent task lookup under 50 ms.
- incremental operation write under 50 ms.
- full shard rebuild under 3 minutes at 50k curated records.

### 5. LLM Wiki And Graph Health

The graph is complete only when it is operationally useful:

- graph contains records, folders, tags, kinds, wikilinks, provenance links,
  lifecycle/quarantine edges, and usage links from traces/context packs.
- graph health is generated from the current corpus, not stale indexes.
- graph health fails or degrades when accepted counts, source/provenance counts,
  referenced paths, or index timestamps disagree.
- Observatory shows generated timestamps, index source, record/node/edge counts,
  degraded status, and stale state.

Disqualifier: `status: healthy` while accepted memory counts or index counts are
obviously stale.

### 6. Memory Lifecycle And Compounding Hygiene

DinoBrain must prove learning rather than accumulation:

- completed traces produce task memories and behavior candidates.
- auto-compounded rules are not treated as fully reviewed accepted memory unless
  they pass strict promotion gates.
- weak, duplicate, stale, too-broad, unsafe, or evidence-poor rules are held,
  merged, demoted, quarantined, or deleted-candidate.
- lifecycle actions are visible in review records and graph health.
- one-off facts like release tags, commit hashes, visibility toggles, and
  machine-specific token workarounds expire or remain task history rather than
  becoming permanent behavioral gravity.
- accepted behavior memory cannot dominate retrieval lanes for Wiki, Source,
  and Project knowledge.
- cold or old operational data, including tasks, traces, context packs,
  compounding reports, and broad behavior rules, is partitioned, compacted, or
  archived by project, time, and temperature so it cannot grow into prompt-path
  latency or ranking pressure.

Disqualifier: large-scale auto-promotion with no cleanup evidence.

### 7. Source Truth And Provenance

DinoBrain must separate "memory says this happened" from "this claim is
externally or durably supported":

- behavior memories may be trace-backed internal guidance.
- factual, public, external, or high-risk claims require durable source chunks.
- `30_Sources/chunks/*` and `.dino/provenance/*` exist for factual claims.
- source records include source URI or location, chunk text or bounded summary,
  last verified date, source status, and claim links.
- Context Packs distinguish accepted memories from source citations.
- trust scores measure evidence-chain quality, not truth itself.

Disqualifier: all accepted claims point only to internal traces while the system
claims source-truth completion.

### 8. Behavior Evaluation

Completion requires proof that memory improves behavior:

- live `behavior-golden.json` exists with representative, non-self-referential
  user cases.
- context golden sets cover semantic paraphrase, rare exact lookup, negative
  queries, provenance, quarantine, recency, noisy growth, and public-data safety.
- memory-on beats memory-off on behavior quality.
- behavior evaluation measures answer quality, not only expected memory-path
  retrieval.
- Ragas-like or equivalent metrics cover context precision/recall,
  faithfulness/grounding, answer relevance, and answer correctness.
- recall, noise, latency, freshness, and candidate-count budgets fail hard.
- synthetic verifiers are paired with real-vault verification.

Disqualifier: claiming behavior improvement from a temp-vault or release-parity
case alone.

### 9. Memory Use Audit

DinoBrain cannot prove private model attention, but it must prove the observable
chain:

```text
provided -> declared_used -> observed_used
```

Completion requires:

- audits for representative completed, partial, blocked, hook-preflight,
  verifier, source/provenance, and correction-learning tasks.
- audits record provided memory, declared-used memory, observed-used memory,
  missing expected memory, hallucinated references, graph-health snapshot,
  verdict, and trust score.
- audit logs stay short and never store raw transcripts.
- Observatory shows recent audit state and degraded trust.

### 10. Feedback Writeback

When the user corrects DinoBrain:

- correction is captured as a reviewed behavior memory or explicit candidate.
- current user instruction remains higher priority than stored memory.
- later Context Packs retrieve the correction in relevant cases.
- behavior evaluation proves the correction changes future behavior.
- contradicted older memories are held, merged, or demoted.

### 11. Observatory As Evidence

Observatory is complete only if it shows the OS, not decoration:

- live tasks and stale tasks.
- prompt/preflight events.
- Context Packs and read traces.
- gate reports and fail-closed/degraded state.
- memory audits and trust scores.
- lifecycle status and review queues.
- graph/index health.
- sync/public-data risk.
- verifier/main/reviewer/pending/blocked lanes.

The graph design should be semantic and operational. Visual metaphors are not a
completion condition.

### 12. Safety, Privacy, And Public Data

Because the data repo was made public, completion requires a public-data safety
review deeper than token-marker scanning:

- scan accepted memories, task summaries, traces, context packs, events, gates,
  audits, and operations records.
- raw full conversations, raw personal files, secrets, tokens, private
  attachments, and machine-local caches remain local-only or blocked.
- candidates and review queues stay out of default retrieval until reviewed.
- public/private documentation is reconciled with actual GitHub visibility.
- sync policy and AGENTS protocol are reconciled: read-only review modes must not
  mutate or auto-sync data.
- auto-sync, if enabled, only moves policy-approved records with sensitivity
  scanning and explicit classification.

Disqualifier: public-safe claim based only on a minimal token/private-key scan.

### 13. New PC Recovery And Installer Equivalence

A fresh PC install is complete only when:

- installer clones or updates both repos at intended refs.
- portable Node is installed or found.
- app builds and indexes refresh.
- Codex MCP, Codex hook, Claude MCP, and Claude hook are registered where clients
  exist.
- hook trust flow is guided but not bypassed.
- Observatory and diagnostics launchers are created.
- reinstall/update is idempotent and refuses unsafe overwrite.
- version drift between local app, GitHub app, installer, and data contract is
  detected.
- restored machine passes the same OS gates and verification commands.

### 14. Sync, Release, And Repository Hygiene

Completion claims require:

- app repo and data repo local/remote parity, or explicitly documented dirty
  state.
- no untracked operational artifact required to prove the claim.
- release ZIP, SHA, tag, and GitHub release asset align with the OS version.
- loose EXE, ZIP, SHA files, installer embedded version, release tag, and GitHub
  release asset are not stale or contradictory.
- GitHub Actions or release workflow evidence exists when release automation is
  claimed.
- data sync policy decides what happens to compounding reports, indexes, traces,
  and public-safety artifacts.

### 15. Verification Registry

The final completion audit must identify exact commands and evidence. At
minimum, the registry must include:

- `npm run hook:verify`
- `npm run flow:audit`
- `npm run verify:os`
- `npm run verify:v2`
- `npm run verify:compounding`
- context retrieval evaluation on the real vault
- behavior evaluation on the real vault
- SQLite/wiki shard verification on the real vault
- graph health verification on the real vault
- session ingest verification
- memory audit verification
- installer version alignment verification
- installer hook verification
- installer Observatory launcher verification
- fresh live Codex prompt proof after hook trust/reload
- Claude proof when Claude Code is installed
- public-data safety report

Synthetic fixture tests are necessary but not sufficient.

## Automatic Disqualifiers

DinoBrain is not complete if any of these are true:

- completion relies on `finish_task` summaries as proof of their own correctness.
- latest proof is synthetic-only.
- latest live Context Packs still use degraded retrieval without saying so.
- graph health is stale or false-green.
- live wiki shard/manifest is missing while fast path is claimed.
- accepted factual claims lack source chunks/provenance.
- behavior golden cases are absent or self-referential only.
- auto-compounded rules are treated as reviewed without independent gates.
- broad behavior rules swamp Wiki/Source/Project knowledge.
- stale started tasks are presented as healthy live activity.
- public data safety is not reviewed after making the data repo public.
- public/private docs contradict actual repository visibility.
- release checksums or installer artifacts contradict each other.
- hook trust is bypassed or claimed as automatic approval.
- model attention is claimed without observable memory-use evidence.

## Current Evidence Snapshot

This snapshot is not a completion proof. It explains why the current state should
be treated as a strong foundation, not complete OS.

- app version: `2.2.1`
- app HEAD observed by reviewers: `8c8d194 fix: harden Codex config line ending writes`
- data HEAD observed by reviewers: `4def30a data: auto sync task-20260706-161251-Completion-Reviewer-10-data`
- app dirty state: untracked `.codex-remote-attachments/`
- data dirty state: untracked `.dino/compounding/`
- accepted memory count observed by reviewers: about 171-172 records
- behavior rules observed by reviewers: about 164, mostly auto-generated
- source chunks observed: none beyond README scaffolding
- provenance directory observed: absent
- live `wiki.sqlite` observed: absent
- SQLite operations shard observed: present
- graph-health observed: stale or false-green
- recent Context Packs observed: mostly `lexical_fallback_v2`
- memory audit coverage observed: one audit
- public data safety: only minimal token-marker scan was previously performed

## Reviewer Consensus Log

Sixteen independent reviewer opinions were required before this document could
move from draft to accepted. All sixteen reviewers agreed to the latest document
after the data architecture/performance objection was incorporated.

| # | Lens | Status | Position |
| --- | --- | --- | --- |
| 1 | User intent | final agree | Latest document accepted |
| 2 | OS loop/enforcement | final agree | Latest document accepted |
| 3 | Retrieval/LLM Wiki | final agree | Latest document accepted |
| 4 | Lifecycle/compounding | final agree | Latest document accepted |
| 5 | Provenance/source truth | final agree | Latest document accepted |
| 6 | Behavior evaluation | final agree | Latest document accepted |
| 7 | Safety/privacy/public data | final agree | Latest document accepted |
| 8 | Install/new PC recovery | final agree | Latest document accepted |
| 9 | Observatory/UI/graph | final agree | Latest document accepted |
| 10 | Data architecture/performance | final agree | Latest document accepted after bounded/index-backed and cold-data partition conditions were added |
| 11 | Agent/tool contract | final agree | Latest document accepted |
| 12 | Product acceptance | final agree | Latest document accepted |
| 13 | Documentation/spec | final agree | Latest document accepted |
| 14 | Verification/CI/release | final agree | Latest document accepted |
| 15 | Skeptical/adversarial | final agree | Latest document accepted |
| 16 | Integrator/consensus | final agree | Latest document accepted |

## 2026-07-07 RAG OS Consensus Refresh

Twenty subagents re-audited DinoBrain against the user's desired LLM Wiki OS and
external RAG methodology. All twenty agreed that the next completion plan must
center on seven fixes:

1. real dense hybrid retrieval and rerank evaluation;
2. fail-closed live pre-response proof;
3. lifecycle and queue cleanup;
4. atomic source/chunk/claim provenance;
5. memory-on/off answer-quality evaluation;
6. operation-log pollution control;
7. auto-sync proof and safety.

The current local pass improved operation-log exclusion, SQLite shard refresh,
hook merge reliability, stale MCP cleanup, pending-review growth records, and
Korean correction cue coverage. It still does not complete DinoBrain OS because
live Codex Desktop proof, true dense retrieval, behavior answer-quality eval,
and public/private sync boundaries remain open.

Final historical consensus: 16/16 reviewers agreed to the completion-conditions
document. Current RAG OS consensus: 20/20 subagents agreed on the seven-fix
implementation plan above.
