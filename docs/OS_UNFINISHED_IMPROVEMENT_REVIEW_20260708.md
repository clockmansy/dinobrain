# DinoBrain OS Unfinished Improvement Review

Status: ten-agent consensus-approved completion contract; implementation gates still open
Date: 2026-07-08
Scope: current DinoBrain v2.2.1 app repo and `C:\Users\USER\Documents\dinobrain-data`

## Purpose

This document is the current unfinished-work contract for DinoBrain OS. It does
not claim DinoBrain is complete. It records what still has to be true before
the user can trust DinoBrain as the intended compounding LLM Wiki OS.

The target remains:

```text
fresh user prompt
-> trusted pre-response OS context
-> focused reviewed Context Pack
-> direct Codex/Claude MCP availability
-> gated work under current user instruction
-> finish trace
-> reviewed memory growth
-> source/provenance separation
-> behavior recall and correction writeback
-> answer-quality evaluation
-> policy-gated sync/recovery
-> improved future session
```

## Current Evidence Snapshot

Observed with the portable DinoBrain Node environment on 2026-07-08.

Passing or currently green:

- Real Codex Desktop pre-response hook proof is present for the current session.
- Pre-response memory context is visible before agent work.
- Direct MCP parity gate currently passes with Codex verified and Claude
  represented as `not_configured` evidence.
- Native instruction authority gate currently passes.
- Source lineage gate currently reports healthy, but see the false-green risk
  below.
- Behavior recall ledger and feedback writeback gate currently passes.
- Review queue and semantic job settlement currently passes.
- Data git safety hooks and public data safety blockers currently pass at the
  hard-blocker level.
- RAG proof/eval currently reports a real local semantic provider for the
  existing golden set:
  `huggingface_transformers_feature_extraction_v1`,
  `Xenova/all-MiniLM-L6-v2`, 384 dimensions, and
  `semantic_embedding_provider: true`.

Current hard blockers:

- `task_session_lifecycle_and_finish_gate_integrity` fails:
  `task_lifecycle_finish_gate_failed`.
- `task_lifecycle_auto_settlement_applied` fails:
  `task_lifecycle_auto_settlement_failed`.
- `verify:goal` currently reports 30 of 32 required checks passing. The two
  failing required checks are the current task lifecycle state and deterministic
  task lifecycle settlement.

Current scaffold-only evidence that must not be counted as completion:

- RAG golden-set proof has semantic embeddings, but this does not yet prove
  that every arbitrary live user prompt performs on-the-fly semantic query
  embedding and dense top-K retrieval before fallback.
- RAG eval is still deterministic/local extractive canary evidence unless a
  generated-answer, memory-on/off, Ragas-like or LLM-judge quality loop is
  added and hard-gated.
- Observatory verifier currently proves basic graph/API health, not full
  blocker-lane parity with `verify:goal`.
- Behavior recall currently risks false-green status if required trigger types
  have zero coverage without explicit `not_applicable` evidence. Current status
  can be healthy while `handoff`, `direction_change`, and `correction` counts
  are zero.
- Review and semantic backlogs can be classified and excluded, but they remain
  visible pending debt until worklist/action gates say otherwise.
- `.dino/index/operations-index.json` parse errors must be treated as
  operational blockers because they can break `finish_task` and hide trace
  failures.
- Public data posture must assume the app/data repositories are public unless a
  live GitHub visibility proof says otherwise.
- Source-lineage status can be healthy while factual project or accepted
  instance records are classified as `project_memory` or `internal_claim`
  instead of being forced through verified source support.
- Review settlement can be healthy while hundreds of manual review and
  classified semantic backlog items remain open. That is acceptable only as
  "classified pending", not final completion.

## Completion Conditions

DinoBrain can only be called the target OS when all conditions below pass on
the real app repo and real data vault.

1. `npm run verify:goal` passes.
2. `npm run status:health` reports `healthy` and uses the same blocker model as
   `verify:goal`.
3. Real Codex Desktop pre-response proof is fresh and shows hook execution
   before response, Context Pack trace, gate result, selected memory paths, and
   finish protocol.
4. Claude Code, when installed, has the same fresh live pre-response proof and
   direct MCP proof. If Claude is absent, `not_configured` must be explicit,
   fresh, and visible; it must not be treated as a real Claude-session proof.
5. Direct MCP parity remains separate from hook proof. Config-only,
   hook-only, bootstrap fallback, CLI fallback, synthetic stdio, stale proof,
   alias-only discovery, and partial tool exposure cannot pass.
6. Task lifecycle is clean: no stale active tasks, missing terminal traces,
   orphan traces, ungrounded finishes, or unapplied deterministic settlement
   repairs.
7. Source lineage covers every factual, public, external, or high-risk claim
   across Wiki, Project, Source, and accepted Instance records. `20_Wiki`-only
   coverage is not enough.
8. `anchor_only_unverified` URL records remain anchors only and never count as
   factual support.
9. Every verified factual claim resolves to source chunks or durable artifacts
   with source URI/location, bounded chunk text or bounded summary, verification
   status, and non-dangling `claim_paths`.
10. Public-data safety remains separate from source truth. Zero blockers are
    required, and degraded warning classes must either be triaged or explicitly
    accepted by policy before final readiness.
11. Real semantic retrieval participates in the default RAG path. A local
    multilingual embedding model is acceptable only if documented and proven by
    semantic canaries and by arbitrary live prompts that were not pre-embedded
    in the golden set.
12. `hybrid_contextual_v2` is completion-grade only when sparse/BM25,
    semantic dense top-K, rank fusion, reranking, provenance rerank, lifecycle
    penalties, and type budgets all report bounded contribution metrics.
13. Memory-on generated answers beat memory-off generated answers on
    representative user cases, with metrics for faithfulness, grounding,
    relevance, correctness, source support, forbidden/quarantined memory
    avoidance, latency, and noise.
14. Behavior recall writes and verifies completion, handoff, error,
    direction-change, and correction ledger entries with
    `performed` / `skipped` / `not_applicable`, reason, evidence path, conflict
    handling, and follow-up action.
    A healthy current-vault status cannot pass if required trigger counts are
    zero without explicit `not_applicable` coverage.
15. User corrections are retrieved in later relevant Context Packs, and
    contradicted older behavior memories are held, merged, demoted,
    quarantined, or deleted-candidate instead of staying equal-weight accepted
    memory.
16. Observatory exposes the same hard blockers as CLI gates. It must show
    blocked, reviewer pending, main pending, verifier pending, stale proof,
    missing tools, proof paths, invalid artifact state, and memory-use
    audit/trust score.
17. Observatory memory-audit UI must show the observable chain:
    `provided -> declared_used -> observed_used`, including missing expected
    memory and hallucinated references.
18. Invalid JSON, unreadable files, broken encoding, missing proof artifacts,
    and stale status artifacts must produce degraded/blocker states, not silent
    nulls or green rollups.
19. Install/update/new-PC recovery proves app/data ref parity, hook
    registration, guided trust flow, build/index refresh, Observatory launcher,
    uninstall/purge behavior, release manifest, ZIP/SHA/tag/asset parity, and
    version drift detection.
    These proofs must be hard-gated by `verify:goal`, not merely listed in
    installation documentation.
20. GitHub/data sync only pushes policy-approved, sanitized, reviewed or
    explicitly allowed artifacts. Raw transcripts, local caches, private
    attachments, secrets, and unreviewed candidate/review queue material remain
    blocked or local-only.
    `.dino/gates/`, `.dino/events/`, status artifacts, candidates, and review
    queue records must use one shared path-classification model across
    `git_sync`, `auto_sync`, and public-data safety checks.
21. Review backlog health is not the same as completion. Manual review,
    semantic-job, candidate, and promotion queues must be either bounded and
    explicitly classified pending, excluded from default retrieval, or resolved.
    A "healthy" action file cannot hide a large unreviewed backlog.
22. Active task accumulation must be explained. Recent active tasks need owner,
    expected-open reason, freshness window, and next action. Large active-task
    buildup without those fields is an operational blocker even when stale
    counts are zero.
23. Memory compounding must implement actual lifecycle pressure:
    merge, decay, hold, cold archive, retrieval-lane exclusion, provenance
    upgrade, contradicted-memory demotion, and promotion budgets. Candidate
    generation alone does not satisfy knowledge compounding.
24. Source truth classification must distinguish `behavior_memory`,
    `project_memory`, `internal_session_evidence`, `source_anchor_unverified`,
    `verified_source_chunk`, `verified_claim_support`, and
    `unsupported_factual_claim`. Anchor-only URLs and internal traces can never
    satisfy factual/public claim support by themselves.
25. Dynamic RAG proof must reject completion when a live prompt without a stored
    query vector falls back to lexical retrieval, unless the response is
    explicitly marked degraded and that degraded path is not counted as final
    OS readiness.

## Required Verifier Registry

The completion path must include these commands or exact equivalents:

```powershell
npm run build
npm run check
npm run audit:full-memory
npm run status:refresh
npm run status:health
npm run status:mcp-direct
npm run verify:mcp-direct
npm run verify:native-authority
npm run verify:source-lineage
npm run verify:behavior-recall
npm run verify:goal
npm run verify:codex-live:recent
npm run verify:codex-loop
npm run verify:os
npm run verify:v2
npm run verify:compounding
npm run eval:rag
npm run status:live-semantic-query
npm run verify:live-semantic-query
npm run status:answer-quality
npm run verify:answer-quality
npm run eval:behavior
npm run graph:health
npm run safety:public-data:check
npm run observatory:verify
npm run installer:verify:version
npm run installer:verify:approval
npm run installer:verify:launchers
npm run installer:verify:managed-hook
npm run uninstall:verify
npm run status:release-manifest
npm run verify:release-manifest
npm run installer:win
npm run release:win -- -SkipUpload
```

Missing named verifiers that must be added or mapped explicitly before final
completion:

- `verify:install-equivalence`
- `verify:review-backlog`
- `verify:compounding-lifecycle`

These must be included in `verify:goal` or proven equivalent by a documented
registry entry.

Existing verifier scripts that must be wired into final readiness or explicitly
mapped to an equivalent hard gate:

- `review:worklist`
- `review:worklist:actions`
- data repo public-data git-hook verification

## Remaining Work Packages

### P0-A Task Lifecycle And Finish Gate Cleanup

Current blocker:

- `task_sessions.json` reports stale active and terminal-missing-trace issues.
- `task_lifecycle_settlement.json` reports finish-gate repairs remain.
- A malformed operations index can cause `finish_task` parse failures; that is
  a lifecycle/trace integrity issue, not only an indexing nuisance.

Required work:

- Inspect the eight manual/finish-gate repair blockers.
- Reconstruct missing terminal traces only when deterministic evidence exists.
- Close abandoned diagnostic/proof tasks as blocked or abandoned, never as
  successful work.
- Add a regression that prevents future `started` task buildup from looking
  healthy.
- Make Observatory show the exact lifecycle blockers and repair class.
- Add operations-index parse validation to the same health/readiness model.

Acceptance:

- `npm run task:lifecycle` passes on the real vault.
- `npm run task:lifecycle:settle` passes on the real vault.
- Operations index parse/read status is healthy or explicitly regenerated.
- `npm run verify:goal` no longer fails lifecycle requirements.

### P0-B Health And Observatory Must Share Verify-Goal Blockers

Current risk:

- `verify:goal` correctly blocks scaffold-only RAG, but health and Observatory
  can still show local RAG artifacts as healthy at the scaffold layer.
- Observatory API does not yet expose the full direct health/client MCP blocker
  model or invalid artifact parse status.

Required work:

- Add `/api/readiness` or equivalent Observatory API that exposes
  `health_status`, `health_status.checks[]`, direct MCP client agents,
  hard-gate rows, blocker reasons, proof paths, stale timestamps, missing
  tools, warnings, parse state, and CLI parity.
- Add UI lanes for blockers, reviewer pending, main pending, and verifier
  pending.
- Add full memory-audit path visibility, not just audit score.
- Add invalid JSON/unreadable fixture tests.
- Add `verify:observatory-evidence` and wire it into `verify:goal`.

Acceptance:

- A missing/stale P0 proof is visible in CLI and Observatory.
- No green rollup is possible while `verify:goal` has a hard blocker.
- Invalid status JSON fails the Observatory evidence verifier.

### P0-C Source Lineage Coverage Expansion

Current risk:

- Source-lineage implementation may be narrower than the stated contract,
  because factual claims outside `20_Wiki` can be classified as project memory
  or internal claims.

Required work:

- Extend source-truth detection to factual/public/external/high-risk claims in
  `40_Projects`, accepted `50_Instances`, and any curated record type that can
  carry factual claims.
- Add fixtures for factual project records and accepted instance records with
  unsupported claims.
- Make source-lineage reports distinguish internal behavior guidance,
  internal-session evidence, project memory, unverified anchor, verified source
  chunk, verified claim support, and unsupported factual claim.
- Ensure public-data degraded warnings do not silently become final readiness.
- Prevent `project_memory` or `internal_claim` classification from bypassing
  source truth when the text makes factual, public, external, or high-risk
  claims.
- Add regression fixtures for:
  unsupported factual `40_Projects` records,
  unsupported factual accepted `50_Instances` records,
  anchor-only records incorrectly used as support,
  dangling `claim_paths`,
  and verified chunk support that should pass.

Acceptance:

- Factual `40_Projects` and accepted instance claims without verified support
  fail.
- Verified source chunks and claim paths pass.
- `verify:goal`, health, and Observatory reflect source-lineage blockers.
- Context Pack output separates behavior memory from verified source citation
  and verified claim support.

### P1-D Real Semantic Retrieval And Answer-Quality Eval

Current implementation note:

- `verify:live-semantic-query` and `status:live-semantic-query` now prove that
  a non-golden prompt can compute an on-the-fly semantic query vector, use dense
  top-K in the Context Pack path, and honestly fall back when semantic
  embeddings are disabled.
- `verify:answer-quality` and `status:answer-quality` now add a deterministic
  local paired judge over generated memory-on and memory-off answers with
  faithfulness, answer relevance, correctness, grounding, source support,
  forbidden-memory avoidance, noise budget, latency, and memory-lift metrics.
- These close the named live-query and local answer-quality proof gaps, but do
  not by themselves complete the broader representative-eval requirement.

Current risk:

- The golden-set RAG proof, live-query proof, and local paired answer-quality
  proof now report real semantic and memory-on/off evidence, but completion
  must still not confuse this small deterministic proof with broad Ragas or
  LLM-judge calibrated evaluation across representative user cases.

Required work:

- Configure a real semantic embedding provider or documented local multilingual
  embedding model for both record vectors and live query embeddings.
- Compute on-the-fly query embeddings for arbitrary live prompts, or use a
  real vector DB/index query. Precomputed golden query vectors alone are not
  completion evidence.
- Store bounded dense vectors and top-K retrieval evidence for each proof case.
- Keep `lexical_fallback_v2` when semantic dense retrieval is unavailable.
- Expand generated-answer memory-on/off evaluation beyond the local paired
  judge into Ragas-like or LLM-judge calibrated representative cases.
- Report contribution metrics for sparse, dense, RRF, rerank, provenance,
  lifecycle penalty, type budgets, latency, and noise.
- Remove or bound vocabulary-wide `%term%` scans, full vector loads, and whole
  vault scans from the normal prompt path.
- Expand the eval set beyond DinoBrain self-operation cases to at least 30
  representative cases covering Korean/English, paraphrase, rare exact lookup,
  negative query, source-backed factual claims, quarantined/rejected memory,
  and noisy growth cases.

Acceptance:

- Lexically different but semantically related canaries pass.
- A live prompt not present in the golden query-vector table still uses semantic
  dense top-K retrieval or records an honest degraded fallback that cannot pass
  final readiness.
- Text-hash-only vectors cannot pass completion.
- Memory-on generated answers beat memory-off on representative user cases for
  faithfulness, relevance, correctness, grounding, source support,
  forbidden-memory avoidance, latency, and noise budget.
- `verify:goal` no longer fails RAG requirements.

### P1-E Feedback, Lifecycle, And Knowledge Compounding Hygiene

Required work:

- Keep accepted memory review stricter than candidate generation.
- Prevent broad behavior rules and operational task logs from swamping Wiki,
  Source, and Project knowledge.
- Add queue cleanup for stale, duplicate, too-broad, unsupported, or
  contradicted memories.
- Ensure every correction has later retrieval evidence or a visible pending
  state.
- Require current-vault behavior recall coverage for completion, handoff,
  error, direction-change, and correction triggers, or explicit
  `not_applicable` records with reasons.
- Treat classified manual semantic jobs as pending debt until
  `review:worklist` and `review:worklist:actions` or equivalent gates show the
  backlog is bounded, clustered, excluded from default retrieval, and not
  counted as reviewed memory.
- Treat zero-count required behavior triggers as unhealthy unless there is an
  explicit `not_applicable` ledger entry with evidence and reason.
- Add active-task budget/freshness checks: owner, expected-open reason,
  next-action, and maximum allowed unexplained active count.
- Add compounding lifecycle checks for decay, merge, hold, cold archive,
  retrieval-lane exclusion, promotion budget, and contradicted-memory demotion.
- Keep real-vault status separate from temp-vault regression success. A temp
  fixture verifier cannot certify that the production vault is clean.

Acceptance:

- Review queue and semantic job settlement stay healthy.
- Review worklist/action gates are healthy or explicitly mapped to another hard
  readiness gate.
- Behavior recall proves correction retrieval and conflict demotion.
- Behavior recall proves trigger coverage, not only that the ledger file is
  syntactically valid.
- Context Packs keep operational plumbing out of default domain retrieval.
- Large manual review, semantic, or active-task backlogs are visible as blocker
  or classified-pending lanes, not hidden behind green rollups.
- Compounding reports show lifecycle pressure on stale, duplicate, too-broad,
  unsupported, contradicted, and low-use memories.

### P1-F Public Data And Sync Policy Unification

Current risk:

- The public-data verifier and `git_sync` / `auto_sync` path classifiers can
  diverge.
- The data repo can accumulate large dirty or untracked candidate/review/proof
  backlogs that are not part of a clean recovery story.

Required work:

- Use one shared classification table for public-data safety, `git_sync`, and
  `auto_sync`.
- Treat public GitHub visibility as the default risk model unless current
  visibility is proven otherwise.
- Keep raw archives local-only or blocked.
- Keep candidates and review queue out of default retrieval and out of public
  sync unless classified as curated, bounded, non-sensitive, and intended for
  public review.
- Fail readiness on invalid JSON in tracked operational indexes or status
  artifacts.
- Before release/push readiness, report data repo dirty state by class:
  syncable, conditional, blocked, local-only, untracked candidates, untracked
  review records, and invalid generated artifacts.

Acceptance:

- `npm run safety:public-data:check` passes with zero blockers under the
  portable Node environment.
- Data git hooks are installed and verified.
- `git_sync` and public-data scan classify `.dino/gates/` and similar
  operational artifacts consistently.
- Dirty/untracked data state is either clean or explicitly excluded from the
  completion claim.

### P2-F Install, Release, And New-PC Equivalence

Required work:

- Add `verify:install-equivalence` and `verify:release-manifest` or documented
  equivalents.
- Installer must run or surface all hard gates after install/update.
- Release manifest must include app commit, data commit, installer version,
  package version, ZIP path/SHA, tag target, GitHub asset evidence when upload
  exists, and verifier statuses.
- Release manifest must be written as a durable proof artifact, not only as
  release body prose.
- `verify:goal` must include install-equivalence and release-manifest status or
  a documented equivalent hard gate before final completion can be claimed.
- Hook trust must be guided and verified by live evidence, not claimed as
  automatic.
- Git-missing ZIP fallback is degraded mode only.

Acceptance:

- Fresh install reproduces app/data refs and required verifier statuses.
- Reinstall/update is idempotent and refuses unsafe overwrite.
- Uninstaller/purge verification passes.
- Git-missing fallback fails full install equivalence while passing only a
  degraded/offline install mode.

## Ten-Agent Consensus Protocol

This document cannot be marked accepted until the same document revision gets
ten non-empty `AGREE` results from independent subagents.

Rules:

1. Each reviewer must inspect memory and repository evidence, not only this
   document.
2. Each reviewer must return `AGREE` or `REVISE_REQUIRED`.
3. Empty, timed-out, or `completed=null` outputs do not count.
4. If any reviewer returns `REVISE_REQUIRED`, this document must be revised and
   all ten reviewers must be rerun against the revised document.
5. Agreement means the plan is accepted as the work contract. It does not mean
   DinoBrain is complete.

## Current Review Findings

This section records the live 2026-07-08 review round for this document family.
It supersedes earlier contradictory "consensus-approved" wording in older
drafts. Historical agreement on an older revision does not count for this
revision.

Counted current-round results so far:

| Reviewer | Lens | Verdict | Integrated finding |
| --- | --- | --- | --- |
| R1 | pre-response / fail-closed | `AGREE` | The completion bar matches the user's target if it stays evidence-first and does not claim DinoBrain is already complete |
| R2 | RAG / retrieval quality | `AGREE` | Dynamic live semantic query proof, non-golden prompt top-K, and lexical fallback disqualification are now explicit |
| R3 | lifecycle / compounding | `AGREE` | Backlog, trigger coverage, active-task buildup, real-vault status, and compounding lifecycle pressure are now explicit |
| R4 | source truth / provenance | `AGREE` | Factual claims outside `20_Wiki`, accepted instance false-greens, and Context Pack source/behavior separation are now explicit |
| R5 | behavior gates / safety | `AGREE` | Current-instruction priority, gate safety, behavior trigger coverage, memory audit visibility, and safe sync are explicit |
| R6 | Observatory / audit UI | `AGREE` | CLI/API/UI blocker parity, readiness lanes, invalid artifact handling, and audit trust/path visibility are explicit |
| R7 | install / new-PC recovery | `AGREE` | App/data ref parity, guided hook trust, release manifest, installer proofs, and degraded fallback limits are explicit |
| R8 | Codex/Claude MCP and native authority | `AGREE` | Direct MCP proof is separated from hook/config/CLI/synthetic fallback, and native authority is hard-gated |
| R9 | data hygiene / privacy / sync | `AGREE` | Public-risk default, raw transcript/secret blocking, shared path classifier, and dirty backlog reporting are explicit |
| R10 | adversarial product acceptance | `AGREE` | The plan prevents note/RAG-toy false completion and forces the desired knowledge-compounding OS contract |

Invalid or earlier reviewer outputs:

- Earlier R5 and R6 attempts returned `completed=null`; those outputs were not
  counted.
- Earlier R2, R3, and R4 `REVISE_REQUIRED` results were integrated and then
  re-reviewed as `AGREE` against this revision.

## Final Consensus Status

Consensus status: `accepted_as_work_contract`

This revision received ten non-empty `AGREE` results from independent
subagents in the same review round after all valid `REVISE_REQUIRED`
objections were integrated.

This agreement means the document is accepted as the remaining-work contract.
It does not mean DinoBrain is complete. Completion still requires the
implementation gates and verifier registry above to pass on the real app repo
and real data vault.

If this document is changed again, the ten-agent consensus protocol must be
rerun for the new revision.

## Current Conclusion

The existing completion plan is directionally correct, but current DinoBrain is
not complete. The next implementation order should be:

1. Fix task lifecycle and deterministic settlement blockers.
2. Expand source-lineage coverage beyond `20_Wiki`, including factual
   `40_Projects` and accepted instance records.
3. Strengthen behavior recall, review backlog, active-task, and compounding
   lifecycle gates so green status cannot hide missing trigger coverage or
   unresolved memory debt.
4. Extend generated-answer quality evaluation beyond the current local paired
   judge into representative memory-on/off, Ragas-like or LLM-judge evidence.
   Dynamic live-query semantic retrieval is now covered by
   `verify:live-semantic-query`, and local paired answer-quality proof is now
   covered by `verify:answer-quality`.
5. Align health and Observatory with `verify:goal` blocker semantics.
6. Add missing final verifiers for install equivalence, release manifest,
   review backlog, and compounding lifecycle, and keep Observatory evidence plus
   answer quality wired into `verify:goal`.
7. Re-run the ten-agent consensus protocol against this exact revised document.
