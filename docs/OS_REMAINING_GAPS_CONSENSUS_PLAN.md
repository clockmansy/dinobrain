# DinoBrain OS Remaining Gaps Consensus Plan

Status: draft after reviewer round 2 revisions; P0-04 proof ingestion implemented, final ten-reviewer consensus still pending
Date: 2026-07-07
Target: DinoBrain OS v2.2.x completion hardening
Governing document: `docs/OS_COMPLETION_CONDITIONS.md`

## Final Target

DinoBrain is complete only when it acts as the long-term memory and judgment-material layer for Codex and Claude Code, while the LLM keeps final judgment authority under the current user instruction.

The target is an observable closed loop:

```text
fresh user prompt
-> trusted pre-response OS preflight
-> focused reviewed Context Pack
-> direct agent MCP availability
-> gated work
-> finish trace
-> reviewed memory growth
-> source/provenance separation
-> behavior recall and correction writeback
-> answer-quality evaluation
-> policy-gated sync/recovery
-> improved future session
```

This plan does not mark DinoBrain complete. It defines the remaining work that must be implemented before completion can be claimed.

Implementation progress:

- 2026-07-07: P0-04 direct MCP proof ingestion, `verify:mcp-direct`, `verify:goal` hard-gate wiring, and a current Codex proof plus Claude `not_configured` artifact were added. `verify:goal` now reports `codex_claude_direct_mcp_parity` as passing, while live pre-response and task lifecycle blockers remain.

## Completion Bar

Completion requires all of the following:

- `npm run verify:goal` passes on the real app repo and real data vault.
- `npm run status:health` reports `healthy`.
- direct Codex and Claude MCP parity is proven by real client proof artifacts, not config presence, hook preflight, CLI fallback, or synthetic MCP startup.
- native instruction surfaces are scanned and reconciled against OS memory authority rules.
- factual claims in Context Packs distinguish internal behavior memory from verified source-backed claim support.
- behavior recall writes a decision ledger for completion, handoff, error, and direction-change events.
- RAG quality is measured with real semantic dense retrieval and generated-answer quality evaluation, not only deterministic path/term canaries.
- Observatory exposes the same blocker state that the CLI gates use.
- public-data and sync policy gates stay green after the verification artifacts are generated.
- ten independent reviewer agents record final agreement against this document. If any reviewer returns `REVISE_REQUIRED`, this document must be revised and all ten reviewers must be rerun.

## Evidence Pack

Every reviewer must inspect, at minimum:

- `C:\Users\USER\.codex\memories\MEMORY.md`
- `docs/OS_COMPLETION_CONDITIONS.md`
- `docs/OS_COMPLETION_IMPROVEMENT_PLAN.md`
- `docs/VERIFICATION.md`
- `docs/OS_V2_CONTRACT.md`
- `docs/SYNC_POLICY.md`
- `AGENTS.md`
- `install.ps1`
- `src/client-mcp-direct-status.ts`
- `src/health-status.ts`
- `src/hybrid-retrieval.ts`
- `src/rag-proof.ts`
- `src/rag-eval.ts`
- `src/behavior-eval.ts`
- `src/compounding.ts`
- `src/index.ts`
- `scripts/dinobrain-observatory.mjs`
- `C:\Users\USER\Documents\dinobrain-data\.dino\state\client_mcp_direct_status.json`
- `C:\Users\USER\Documents\dinobrain-data\.dino\state\health_status.json`
- `C:\Users\USER\Documents\dinobrain-data\.dino\state\rag_proof_status.json`
- `C:\Users\USER\Documents\dinobrain-data\.dino\state\rag_eval_status.json`
- `C:\Users\USER\Documents\dinobrain-data\40_Projects\DinoBrain-Project-State.md`
- `C:\Users\USER\Documents\dinobrain-data\40_Projects\DinoBrain-RAG-Roadmap.md`

Reviewers must also run targeted `rg` searches for:

```text
pre-response
direct MCP
exact single-name
native instruction
AGENTS
CLAUDE
custom instruction
native_memory_drift
wrong_memory_reference
behavior recall
record_feedback_correction
answer quality
semantic_embedding_provider
anchor_only_unverified
claim_paths
provenance
```

## Work Packages

### P0-04 Direct MCP Parity Hard Gate

Problem:
`client_mcp_direct_status` currently reports `needs_recheck` for Codex and Claude and the implementation writes placeholder missing-tool reports. This is not completion evidence.

Required implementation:

- Add proof artifacts under `.dino/proofs/client-mcp/` or equivalent.
- A valid proof must record, per client:
  - `agent`: `codex` or `claude`
  - `client_surface`: the real client surface used
  - `tool_discovery_mode`: must be `exact_single_name`
  - `required_tools`: `os_begin_task`, `search_memory`, `wiki_search`, `finish_task`
  - `verified_tools`
  - `missing_tools`
  - successful call evidence for each required tool
  - `proof_source`: must not be `hook`, `bootstrap`, `cli_fallback`, or `synthetic_stdio_only`
  - `generated_at`
  - `stale_after_ms`
- `npm run status:mcp-direct` must ingest those proof artifacts instead of emitting unconditional placeholders.
- Claude Code absence must be represented as `not_configured` with evidence, not silent success.
- `npm run verify:goal` must fail while required direct MCP proof is missing or stale.
- `npm run status:health` must stay `needs_attention` while P0-04 is missing.
- Observatory must show Codex and Claude direct MCP status, missing tools, proof path, and stale state.

Acceptance tests:

- Codex direct MCP proof succeeds only when the real Codex client exposes and calls all required tools by exact single names.
- Claude direct MCP proof succeeds only when Claude Code is installed and exposes/calls all required tools by exact single names.
- Config-only, hook-only, `node dist/index.js` listTools-only, stale proof, alias-only discovery, one missing tool, Codex-only, and Claude-only cases all fail the global completion gate unless explicitly marked `not_configured` with a valid reason.

### P0-05 Native Instruction Authority Gate

Problem:
Current docs state that the current user instruction outranks stored memory, but there is no gate that scans native instruction surfaces and detects drift or conflict.

Required implementation:

- Add a native instruction scan artifact under `.dino/state/native_instruction_authority.json` or equivalent.
- Scan at least:
  - `AGENTS.md`
  - repo `.codex/` hook/bootstrap instructions
  - Codex global config/custom instruction surfaces that are safely readable
  - `CLAUDE.md` where present
  - `C:\Users\<user>\.claude\settings.json` where present
  - installer-written hook instructions
- Compare scanned rules against OS authority rules:
  - current user instruction outranks OS memory
  - OS memory is subordinate evidence
  - candidates/review queue are untrusted
  - no raw transcript or secret storage
  - no auto-sync outside scoped policy
  - no hook trust bypass claim
- On conflict, write signals such as:
  - `native_memory_drift`
  - `wrong_memory_reference_detected`
  - `unsafe_native_instruction`
  - `hook_authority_conflict`
- Add status, health, verifier, and Observatory visibility.

Acceptance tests:

- Clean AGENTS/Codex/Claude instructions produce `healthy`.
- A fixture that says stored memory outranks current user instruction fails.
- A fixture that references rejected/candidate memory as trusted fails.
- A fixture that claims automatic hook trust bypass fails.
- `verify:goal` fails while native instruction authority status is `needs_attention`.

### P0-06 Source, Chunk, And Claim Lineage Gate

Problem:
Search quality without source-truth separation creates hollow RAG: the system may retrieve fluent internal memories that are not verified factual support.

Required implementation:

- Add an explicit source/claim lineage status artifact.
- Treat `anchor_only_unverified` source records as URL anchors only, never as factual support.
- Factual or public claims must link to verified source chunks or durable local artifacts.
- Context Packs must label each item as:
  - `behavior_memory`
  - `project_memory`
  - `source_anchor_unverified`
  - `verified_source_chunk`
  - `verified_claim_support`
- Graph and health checks must fail on:
  - dangling `claim_paths`
  - missing provenance files
  - source chunks without verification status
  - factual claims backed only by internal task traces
- RAG eval must report source coverage separately from retrieval hit rate.

Acceptance tests:

- A factual claim with only an internal trace fails source-truth completion.
- `anchor_only_unverified` sources appear as anchors but do not count as support.
- A verified source chunk linked to a claim passes when provenance, source status, and claim path are all present.
- Context Pack output distinguishes behavior memory from source citation and verified claim support.

### P1-09 Behavior Recall And Feedback Writeback Ledger

Problem:
The current system can record corrections and evaluate behavior proxies, but it does not yet prove that learned behavior is automatically recalled at completion, handoff, error, or direction-change moments with performed/skipped/not_applicable evidence.

Required implementation:

- Add `behavior_recall_audit` or equivalent ledger artifacts.
- Each ledger entry must include:
  - `trigger_type`: `completion`, `handoff`, `error`, `direction_change`, or `correction`
  - `task_id`
  - `recalled_memory_paths`
  - `decision_status`: `performed`, `skipped`, or `not_applicable`
  - `reason`
  - `evidence_path`
  - `conflicting_memory_paths`
  - `followup_action`
- `record_feedback_correction` must trigger later retrieval proof and conflict handling.
- Contradicted older behavior memories must be held, merged, or demoted instead of left as equal-weight accepted memory.
- Behavior evaluation must include generated-answer quality or judge-backed metrics, not only path/term recall.

Acceptance tests:

- Completion, handoff, error, and direction-change fixtures each write a recall ledger entry.
- Missing `performed/skipped/not_applicable` plus reason fails.
- A user correction is retrieved in a later relevant Context Pack.
- A contradictory older behavior memory is held, merged, or demoted.
- Memory-on answer behavior beats memory-off on representative non-self-referential cases.

### P1-10 Real Semantic Retrieval And Answer-Quality Evaluation

Problem:
Current RAG proof can report `hybrid_ratio: 1` while using `local_text_hashing_v1` with `semantic_embedding_provider: false`. That is useful scaffolding, but not final semantic hybrid retrieval proof.

Required implementation:

- Treat `local_text_hashing_v1` as proof scaffolding only.
- Completion-grade retrieval requires a real semantic embedding provider or explicitly documented local multilingual embedding model.
- `hybrid_contextual_v2` is allowed only when semantic dense retrieval participates.
- `semantic_embedding_provider: false` must report degraded/proof-scaffold status, not final RAG health.
- Dense top-K, BM25/sparse, RRF, reranker, provenance rerank, lifecycle penalty, and type budgets must each report contribution metrics.
- Add generated-answer memory-on/off evaluation with metrics for:
  - faithfulness
  - answer relevance
  - correctness
  - grounding/source support
  - forbidden or quarantined memory avoidance
  - latency
  - noise budget

Acceptance tests:

- Dense semantic canary retrieves lexically unrelated but semantically related records.
- Lexical-only or text-hash-only runs cannot claim final `hybrid_contextual_v2`.
- Memory-on generated answers beat memory-off on representative user cases.
- Reranker and fusion contribution metrics are present and bounded.
- p95 latency and candidate-count budgets fail hard when exceeded.

### P1-11 Observatory And Health Gate Alignment

Problem:
The UI and health rollup must not hide hard blockers behind green subchecks.

Required implementation:

- `status:health`, `verify:goal`, and Observatory must use the same blocker model for:
  - direct MCP parity
  - native instruction authority
  - source/claim lineage
  - behavior recall ledger
  - semantic retrieval and answer-quality eval
  - public-data safety
- Observatory must show:
  - blocker lane
  - pending reviewer lane
  - main pending lane
  - verifier pending lane
  - recent proof paths
  - stale proof timestamps
  - memory-use audit/trust score
- `/api/state` or an equivalent Observatory API must expose:
  - `health_status.status`
  - `health_status.checks[]`
  - `client_mcp_direct_status.agents[]`
  - `visible_status`
  - `warnings`
  - `proof_path`
  - `stale_after_ms`
  - `latest_verified_at`
  - `missing_tools`
  - invalid or unreadable status artifact state
- The UI must render one hard-gate row or lane per P0/P1 blocker with:
  - status
  - blocker reason
  - proof link or missing proof text
  - stale timestamp
  - missing tool list where applicable
  - CLI/health status parity
- Status artifact hygiene must be visible: invalid JSON, unreadable files, or broken encoding must degrade or block the UI state instead of silently passing.

Acceptance tests:

- A missing P0 proof is visible in CLI and Observatory.
- No green health rollup is possible while any P0 status is missing/stale.
- The UI links to the latest proof artifact path for each hard gate.
- Observatory API test fails if CLI health says `needs_attention` but `/api/state` omits the blocker.
- Observatory UI or browser test proves the blocker lane, reviewer/main/verifier pending lanes, and memory audit trust score render.
- Invalid status JSON fixture renders degraded/blocker state and fails the Observatory verification command.

### P2-12 Release, Install, And New-PC Equivalence

Problem:
The remaining gates must survive fresh install/update flows and avoid version drift.

Required implementation:

- Installer must create or refresh all required verifier launchers.
- New-PC setup must run the same hard gates after Codex/Claude registration.
- Release manifest must include app commit, data commit, installer version, asset SHA, and required verifier status.
- Release proof artifact must include:
  - app repo commit and branch
  - data repo commit and branch
  - installer version
  - package version
  - ZIP path and SHA-256
  - tag name and tag target
  - GitHub release asset id, name, size, and hash when upload is available
  - statuses for all required installer and release verifiers
- Hook trust must be guided and verified by live evidence, not claimed as automatic approval.
- Git-missing ZIP fallback is degraded install mode only. It cannot count as full new-PC equivalence because GitHub data recovery, app/data ref parity, and normal update semantics are not proven.

Acceptance tests:

- Fresh install produces matching app/data refs.
- Codex/Claude client proof status is reproduced or explicitly marked `not_configured`.
- Release ZIP/SHA/tag/GitHub asset all match the manifest.
- Reinstall/update is idempotent and refuses unsafe overwrite.
- `installer:verify:version`, `installer:verify:approval`, `installer:verify:launchers`, `installer:verify:managed-hook`, `uninstall:verify`, `installer:win`, and local release packaging all pass before release readiness is claimed.
- Git-missing ZIP fallback reports degraded mode and fails full equivalence.

## Implementation Order

1. P0-04 direct MCP proof ingestion and verifier hard gate.
2. P0-05 native instruction authority scanner and verifier hard gate.
3. P0-06 source/chunk/claim lineage gate.
4. Wire P0-04/P0-05/P0-06 into `status:health`, `verify:goal`, and Observatory.
5. P1-09 behavior recall ledger and correction conflict handling.
6. P1-10 real semantic retrieval plus generated-answer evaluation.
7. P1-11 Observatory evidence polish and stale-proof drilldowns.
8. P2-12 installer/release/new-PC equivalence.

## Global Acceptance Tests

Completion is blocked until all of these pass on the real vault:

```powershell
npm run build
npm run check
npm run audit:full-memory
npm run status:refresh
npm run status:health
npm run status:mcp-direct
npm run verify:goal
npm run verify:codex-live:recent
npm run verify:codex-loop
npm run verify:os
npm run verify:v2
npm run verify:compounding
npm run eval:rag
npm run eval:behavior
npm run graph:health
npm run safety:public-data:check
npm run installer:verify:version
npm run installer:verify:approval
npm run installer:verify:launchers
npm run installer:verify:managed-hook
npm run uninstall:verify
npm run installer:win
npm run release:win -- -SkipUpload
```

The implementation must add equivalent verifier commands for:

```text
verify:mcp-direct
verify:native-authority
verify:source-lineage
verify:behavior-recall
verify:answer-quality
verify:observatory-evidence
verify:install-equivalence
verify:release-manifest
```

These new verifiers must be included in `verify:goal`.

## Reviewer Consensus Protocol

This plan can be marked consensus-approved only by this loop:

1. Spawn ten independent reviewer agents with different lenses.
2. Each reviewer must inspect the evidence pack and run targeted searches.
3. Each reviewer must return a structured record:
   - `reviewer_id`
   - `lens`
   - `files_read`
   - `searches_run`
   - `verdict`: `AGREE` or `REVISE_REQUIRED`
   - `objection`
   - `revision_required`
   - `final_agree`
4. If any reviewer returns `REVISE_REQUIRED`, revise this document.
5. Rerun all ten reviewers against the revised document.
6. Only ten `AGREE` results in the same round can mark this document consensus-approved.

## Round 1 Objections Integrated

| Reviewer | Lens | Verdict | Required revision integrated |
| --- | --- | --- | --- |
| R1 | user intent / completion bar | `REVISE_REQUIRED` | Added explicit consensus document structure, direct MCP hard proof, native authority signals, behavior recall trigger table, real RAG quality gates |
| R2 | direct MCP parity | `REVISE_REQUIRED` | Added proof artifact ingestion, negative tests, health/goal linkage, Observatory evidence |
| R3 | native instruction authority | `REVISE_REQUIRED` | Added P0-05 scanner, drift signals, health/goal/Observatory requirements |
| R4 | behavior recall / feedback writeback | `REVISE_REQUIRED` | Added behavior recall audit ledger, trigger coverage, conflict demotion, answer-quality eval |
| R5 | retrieval / RAG quality | `REVISE_REQUIRED` | Added semantic provider requirement, degraded text-hash status, answer-quality metrics, contribution metrics |
| R6 | source truth / provenance | `REVISE_REQUIRED` | Added explicit P0-06 source/chunk/claim lineage gate |
| R8 | Observatory / product evidence | `REVISE_REQUIRED` | Added Observatory API contract, hard-gate UI contract, negative tests, browser/product proof, invalid status artifact handling |
| R9 | install / new-PC / release parity | `REVISE_REQUIRED` | Added installer/release verifier commands, release proof artifact fields, install-equivalence/release-manifest verifiers, Git-missing ZIP degraded-only rule |

## Final Consensus Record

Pending. This section must not be filled with `AGREE` until the revised document receives ten final reviewer agreements in one round.

Current run status:

- Round 1: six reviewers returned `REVISE_REQUIRED`; all objections were integrated.
- Round 2: six reviewers returned `AGREE`; Role 8 and Role 9 returned `REVISE_REQUIRED`; both objections were integrated.
- Final retry after Role 8/9 revisions: Role 1, Role 2, Role 3, and Role 4 returned explicit `AGREE`.
- Role 5 through Role 10 final retry attempts returned empty `completed=null` outputs from the subagent tool and are not counted as agreement.
- Therefore this document is not consensus-approved yet. It remains a completion-condition draft pending a clean ten-reviewer `AGREE` round.
