# DinoBrain Verification

Completion authority: `docs/OS_COMPLETION_CONDITIONS.md`. This file explains
commands and artifacts, but a verifier description or isolated PASS does not
override the normative hard-gate verdict. Dated reviewer/state history is kept
in `docs/OS_COMPLETION_REVIEW_RECORD_20260710.md`.

Date: 2026-07-10

This document defines how to verify that DinoBrain is more than a note store.

The verification target has two parts:

1. Knowledge compounds: completed work can become reviewed memory, appear in a later Context Pack, and be removed if it becomes unsafe or wrong.
2. Codex can use it: the local Codex MCP configuration points at the DinoBrain server, the user-level prompt hook is registered when installed, and the configured server can list the DinoBrain tools.
3. Claude Code can use it when configured by the installer: `claude mcp list` includes the `dinobrain` MCP server.

## Commands

```powershell
npm run build
npm run check
npm run version:verify
npm run completion:audit:verify
npm run completion:audit -- --plan-only --allow-not-complete
npm run atomic:writers:verify
npm run status:generation:verify
npm run prompt:eligibility:verify
npm run pre-response:gate:verify
npm run smoke
npm run audit:full-memory
npm run audit:full-memory:verify
npm run status:refresh
npm run status:freshness
npm run status:freshness:verify
npm run review:settle
npm run review:settle:verify
npm run review:worklist
npm run review:worklist:verify
npm run review:worklist:actions
npm run review:worklist:actions:verify
npm run review:backpressure
npm run review:backpressure:verify
npm run cold:partitions
npm run cold:partitions:apply
npm run cold:partitions:verify
npm run task:lifecycle
npm run task:lifecycle:verify
npm run task:lifecycle:settle
npm run task:lifecycle:settle -- --rollback <migration-id>
npm run task:lifecycle:settle:verify
npm run sources:rag:seed
npm run session:verify
npm run session:promote
npm run safety:public-data
npm run backup:private:verify
npm run eval:context
npm run rag:proof
npm run rag:proof:verify
npm run eval:rag
npm run eval:rag:verify
npm run index:verify:sqlite
npm run index:verify:operations
npm run index:verify
npm run hooks:data:verify
npm run hook:verify
npm run verify:os
npm run verify:goal
npm run verify:codex-loop
npm run verify:codex-live:recent
npm run verify:compounding
npm run installer:verify:approval
npm run installer:verify:launchers
npm run installer:verify:managed-hook
npm run installer:verify:hooks
npm run installer:verify:claude
npm run installer:verify:native-result
npm run installer:verify:transaction
npm run clean-machine:verify
npm run installer:verify:matrix
npm run codex:hooks:managed
npm run installer:win
npm run release:win -- -ReplaceAsset
```

Use the bundled or portable Node runtime if `npm` is not on `PATH`.

`version.json` is the release-version authority. `npm run version:verify` fails
when package metadata, the package lock, installer project, OS contract,
installer builder, release publisher, Codex hook, or Observatory no longer
derive from or match that authority. `npm run build` and `npm run check` invoke
this verification before TypeScript work.

`npm run completion:audit` is the evidence-producing wrapper around the
normative command table. The current registry expands to 92 mandatory command
instances; the plan-only output is the exact authority when the registry
changes. It writes only bounded command metadata and stdout/stderr
hashes, not raw command output, under:

```text
.dino/audits/completion/<audit_run_id>/command-results.jsonl
.dino/audits/completion/<audit_run_id>/artifact-manifest.json
.dino/audits/completion/<audit_run_id>/completion-verdict.json
```

The verdict is written last with atomic replacement and is immediately
re-verified against the artifact hashes. Missing commands, partial runs,
missing external proof, stale artifacts, malformed data, warnings, dirty refs,
version drift, or generation mismatch produce `NOT_COMPLETE`.

Use `npm run completion:audit -- --plan-only --allow-not-complete` to create a
truthful baseline without executing the mandatory suite. This still records all
92 commands as `BLOCKED`; it can never certify completion. Use repeated
`--external evidence_id=.dino/proofs/...json` arguments only for hash-bound JSON
proof stored inside the data root. Run `npm run completion:audit:verify` to test
partial-run rejection, failing-command rejection, manifest integrity, tamper
detection, registry/package coverage, and normative-runner parity.

`npm run atomic:writers:verify` prevents production state writers from
reintroducing direct `fs.writeFile` publication outside the concurrency module.
It also proves that a rejected candidate preserves the previous valid file,
24 concurrent atomic replacements leave parseable complete JSON, and no temp
publication files leak.

`npm run audit:full-memory` writes `.dino/state/full_memory_manifest.json` and `.dino/state/full_memory_audit_status.json`. The manifest records every non-Git data-vault file by path, byte size, SHA-256, mtime, and parse status. The status report compares against the previous manifest and classifies drift as live OS writes, review-queue writes, audit artifacts, or unclassified content drift. Unclassified drift and parse errors must block final readiness.

`npm run audit:full-memory:verify` proves the audit can create a baseline, classify live OS drift without false failure, flag unclassified content drift, and surface JSON/JSONL parse errors.

`npm run status:refresh` rebuilds the required freshness artifacts in dependency order, then writes `.dino/state/monitoring_status.json`. Behavior-recall evidence migration status is computed before review, cold-partition, and index artifacts so its public hash-only summary is part of the same generation. The remaining order includes review settlement/worklist/backpressure, cold partitions, node and task lifecycle, Wiki/operations indexes, SQLite shards, RAG proof/eval, graph health, the evidence graph, lineage, full-memory audit, health, and freshness before one status generation is published. This prevents generated index/status churn from masquerading as unresolved stale proof.

`npm run status:freshness` writes `.dino/state/monitoring_status.json` without rebuilding dependencies. It checks whether the full-memory audit, Wiki index, operations index, SQLite shard manifest, graph-health and evidence-graph artifacts, review queue settlement, semantic job settlement, review auto-hold settlement actions, task lifecycle report, RAG proof artifacts, and RAG eval report are present and newer than their source roots. Missing required artifacts produce `degraded`; stale artifacts produce `needs_refresh`. The report carries Korean `visible_status` fields so the Observatory can show freshness without hiding stale proof.

`npm run status:freshness:verify` proves the freshness gate is healthy after all required artifacts are refreshed, remains self-reference safe after writing `monitoring_status.json`, falls to `needs_refresh` after a source change, and falls to `degraded` when required proof artifacts are missing.

`npm run review:settle` writes `.dino/state/wiki-review-queue.json`, `.dino/state/semantic_jobs.json`, and `.dino/state/review_queue_settlement_actions.json`. It does not auto-approve memory. It classifies every candidate/review item as closed, manual semantic review, auto-compounded behavior hold, legacy unreviewed hold, evidence repair, missing review, missing candidate, or unclassified. By default it is a dry-run and fails when deterministic auto-hold candidates remain. With `-- --apply`, it mutates only auto-generated behavior/legacy generated-memory candidates into `held` candidate records and `settled_hold` review records, keeps them out of default retrieval, and leaves manual semantic review/evidence-repair/mapping blockers visible.

`npm run review:worklist` writes `.dino/state/review_worklist.json` plus a public-safe summary under `60_Operations/review-worklists/`. Version 2 excludes deterministic generated holds from human review, forms exact and high-confidence near-duplicate units by semantic identity and behavior scope, and preserves source-session, contradiction, evidence, path, and SHA-256 provenance for every member. Existing pending merge reviews remain visible as review units. It never approves or mutates memory.

`npm run review:worklist:actions` writes `.dino/state/review_worklist_actions.json` plus a public-safe summary under `60_Operations/review-worklist-actions/`. By default it is a dry-run. `-- --apply-holds` cold-holds only deterministic auto-compounded or legacy generated-memory candidates. `-- --apply-merge-reviews` replaces exact/high-confidence near-duplicate members with one provenance-complete pending review under `80_Review_Queue/merge/`. Low-signal singletons stay manual. `-- --apply-all` uses both bounded classes in one hash-preconditioned node-lifecycle transaction with a Git recovery ref and exact local backup. `-- --rollback <transaction-id>` restores it. Later dry-runs retain the last successful transaction and recovery evidence.

`npm run review:backpressure` reconciles `.dino/state/review_queue_admission.json` with the worklist and writes `.dino/state/review_queue_backpressure.json`. The global hot limit is 500 units, with separate correction, merge, manual-semantic, evidence-repair, and mapping-repair budgets/SLAs. Overflow and deterministic generated memory route to cold hold. Missing or unreconciled admission state fails closed; candidate, review, admission state, and receipt commit atomically.

`npm run review:backpressure:verify` proves a 1,000-session run remains bounded, missing state fails closed, 24 parallel writers do not lose counts or collide, and an injected transaction fault rolls back exactly.

`npm run cold:partitions` dry-runs logical monthly cold partitions for completed tasks, traces, Context Packs, reports, and obsolete lifecycle rules. `npm run cold:partitions:apply` writes a hash-bound partition index transactionally without moving source truth. Normal context/search and recent operations exclude indexed paths; `search_cold_memory` is the explicit metadata lookup. `npm run cold:partitions:verify` proves all record kinds, retrieval exclusion, source preservation, rollback, and fault recovery. See `docs/REVIEW_QUEUE_BACKPRESSURE.md`.

`npm run review:settle:verify` proves this classification and safe auto-hold settlement on a temporary vault with behavior-rule, legacy, missing-evidence, missing-review, missing-candidate, and closed-review fixtures.

`npm run review:worklist:actions:verify` proves dry-run safety, public summary redaction, provenance-complete merge creation, atomic rollback, and preservation of last-apply evidence across later dry-runs.

`npm run task:lifecycle` writes `.dino/state/task_sessions.json` and `.dino/state/task_finish_grounding_classifications.jsonl`. It classifies active, stale-active, terminal, missing-trace, orphan-trace, partial-grounded, and ungrounded task finishes. The command fails when stale active tasks, missing terminal traces, orphan traces, task-id mismatches, or ungrounded finishes remain, because those block final readiness.

`npm run task:lifecycle:verify` proves the lifecycle gate on clean and dirty temporary vaults.

`npm run task:lifecycle:settle` writes `.dino/state/task_lifecycle_settlement.json`. By default it is a dry-run and fails when lifecycle blockers remain. With `-- --apply`, it creates a Git recovery ref, exact local-only backups, and a hash-chained migration ledger before mutating deterministic repair shapes. Non-user service tasks and stale no-trace user tasks are closed as blocked, stale `started` tasks may inherit an outcome only from a grounded task-matched trace, terminal tasks can be bound to an existing trace without rewriting that trace, and blocked tasks receive a reconstructed trace only when no task-matched trace exists. Post-apply lifecycle invariants must be zero or the migration rolls back automatically.

`npm run task:lifecycle:settle -- --rollback <migration-id>` verifies the immutable ledger and backup hashes, rejects conflicting external writes, restores prior files byte-for-byte, removes migration-created traces, and rebuilds lifecycle status. `npm run task:lifecycle:settle:verify` proves successful apply, exact rollback/reapply, interruption recovery, tamper-safe rollback refusal, concurrent apply serialization, terminal task/trace transaction recovery, existing-trace binding without trace mutation, and idempotent no-op apply while preserving recent active work.

`npm run soak:lifecycle:begin` starts the release-candidate lifecycle soak from a clean app worktree and blocker-free task lifecycle baseline. The descriptor and Ed25519 private key stay under the machine-local DinoBrain proof root, outside the app and data repositories. Keep the app and data Git commits unchanged for at least 24 real hours, use both real Codex and Claude clients, and create fresh direct-MCP v2 proofs near the end of the window. `npm run soak:lifecycle:show` reports the active run without exposing the private key. After the full duration, `npm run soak:lifecycle:finalize` refuses early, stale, one-client, ref-drifted, dirty-app, or lifecycle-blocked runs and writes a signed, hash-bound public proof under `60_Operations/lifecycle-soak/`. `npm run soak:lifecycle:check` is the current-vault gate, `npm run soak:lifecycle:verify` provides adversarial fixture coverage, and final certification imports the completed proof with `--external task_lifecycle_soak=<data-root>/60_Operations/lifecycle-soak/<run-id>.json`.

`npm run rag:proof` writes `.dino/evaluations/rag-golden.json`, `.dino/index/dense-vectors.json`, and `.dino/state/rag_proof_status.json` from the current reviewed behavior golden and Wiki index. Every sparse and dense row carries a bounded contextual chunk, source hash, parent record, language, lifecycle, verification, and retrieval-lane contract. A configured MiniLM provider produces semantic vectors; deterministic text hashing remains an honestly labeled fallback and cannot satisfy HG-04.

`npm run rag:proof:verify` proves that the proof builder creates explicit RAG golden cases, semantic dense vectors, contextual row metadata, and a current-vault RAG eval path that uses `rag_golden` plus `hybrid_contextual_v2`.

`npm run rag:retrieval:verify` proves independent cosine dense top-K, real-provider paraphrase and bilingual retrieval, stable rare aliases, inspectable score contributions, bounded lane diversity, and honest lexical fallback.

`npm run rag:vector:migration:verify` proves that provider, model, dimension, or vector-schema identity changes create hash-bound before/after migration artifacts and support verified rollback and reapply. `npm run rag:vector:migration:rollback -- <migration-id>` and `npm run rag:vector:migration:reapply -- <migration-id>` operate on those artifacts; `.dino/state/vector_index_migration.json` is the Observatory/readiness status surface.

`npm run eval:rag` writes `.dino/state/rag_eval_status.json` and requires an explicit version-2 `.dino/evaluations/rag-golden.json`. Behavior/context golden fallback is forbidden. The bilingual suite covers exact, paraphrase, rare exact, negative, provenance, quarantine, recency, correction, noisy growth, forbidden-memory, and current-instruction cases. Evaluation retrieval excludes recent task and judge-operation records so a copied golden prompt cannot satisfy its own test. A healthy report requires the declared recall, term, role, noise, latency, and hybrid thresholds with zero forbidden-memory returns.

`npm run status:answer-quality` requires `.dino/evaluations/answer-quality-golden.json` and a hash-bound `.dino/evaluations/answer-quality-calibration.json`. The deterministic generator receives only the current request and retrieved reviewed guidance; golden actions are judge-only labels. Completion additionally requires at least three independent LLM or Ragas judge identities, blinded and randomized arms, a durable raw review artifact, answer hashes, the combined answer/retrieval runtime hash, dense-index hash, declared disagreement bound, current-instruction safety, and RAM/latency budgets. Missing, stale, tampered, or self-derived calibration fails closed.

`npm run scale:50k` creates an isolated deterministic vault with 50,000 curated
records and 1,000 completed sessions, then exercises the real SQLite shard,
Context Pack, Wiki search, recent-task, incremental-write, graph, and
Observatory paths. It deletes the synthetic vault and writes only
`.dino/evaluations/scale-50k-status.json` to the configured data root. A
qualifying report must meet the HG-04 warm p95 targets, the three-minute cold
build target, the process-RSS/payload budgets, indexed term/graph query plans,
partition-probed dense top-K, one cached dense-index parse, and one full
status-generation verification per Observatory window. The report binds the
runtime source files, generator, hardware environment, curated corpus, session
growth, and payload by SHA-256.

`npm run scale:50k:verify` uses smaller non-qualifying fixtures to prove
deterministic generation, explicit budget failure, report tamper detection,
stale code-binding detection, bounded Observatory output, and fail-closed
behavior for an oversized unpartitioned dense index. `npm run scale:50k:check`
does not rebuild 50k records; it verifies that the current qualifying report is
healthy and still matches the current runtime code, generator, and hardware.
The completion audit imports the same report with
`--external scale_50k=<data-root>/.dino/evaluations/scale-50k-status.json`.

Resource regressions are covered by `npm run verify:live-query-cache-budget`, `npm run verify:semantic-pipeline-cache`, `npm run graph:evidence:verify`, and `npm run observatory:verify`. These verify bounded query-vector retention, one semantic pipeline construction per model/configuration, serialized inference, incremental graph updates, focused graph traversal, coalesced Observatory refreshes, bounded payloads, and non-overlapping browser polling.

`npm run eval:rag:verify` proves that lexical fallback is not treated as healthy full RAG, then proves a dense-vector fixture can pass with memory-on lift and `hybrid_contextual_v2`. This still remains scaffold health unless the dense provider is semantic and generated-answer quality metrics are present.

Completion-grade RAG has a stricter bar than scaffold health:

- `dense_vector.semantic_embedding_provider` must be `true`, or the provider must be an explicitly documented local multilingual semantic embedding model.
- `local_text_hashing_v1` cannot count as final semantic retrieval evidence.
- generated-answer memory-on/off evaluation must include faithfulness, answer relevance, correctness, grounding/source support, forbidden/quarantined-memory avoidance, latency, and noise metrics.
- final artifacts must include contribution metrics for BM25/sparse, dense top-K, RRF, reranking, provenance/root/lifecycle boosts or penalties, candidate counts, and latency.
- `npm run verify:goal` must fail the RAG completion requirement while only deterministic canaries exist, even when `rag:proof` and `eval:rag` are individually healthy.

`npm run verify:goal` includes both the regression verifiers and current-vault `audit:full-memory` / `status:refresh` / `rag:proof` / `eval:rag` gates, so final closed-loop readiness cannot bypass P0-01, P0-02, or the real RAG-eval workstream.

`npm run installer:win` builds `artifacts\DinoBrainSetup.exe` and verifies that the generated EXE can extract the embedded `install.ps1`.

`npm run release:win` requires `GITHUB_TOKEN` or `GH_TOKEN`. It rebuilds the installer, creates or reuses the GitHub release, and uploads `DinoBrainSetup.zip` plus `DinoBrainSetup.zip.sha256` as the release assets.

Use `npm run release:win -- -SkipUpload` to verify local ZIP/SHA packaging without a GitHub token.

`npm run installer:verify:approval` verifies the post-install hook approval helper without opening or restarting Codex.

`npm run installer:verify:launchers` verifies the generated Observatory, hook diagnose, hook approval, Codex live proof, Codex/Claude direct MCP proof, and purge uninstall launchers without touching the real install paths.

`npm run installer:verify:managed-hook` verifies the ProgramData managed-hook writer on temporary files: it preserves existing requirements content, installs DinoBrain exactly once, keeps an existing managed hook directory when present, and writes the wrapper script expected by Codex.

`npm run installer:verify:hooks`, `installer:verify:claude`, and
`installer:verify:native-result` cover idempotent Codex hook merging, Claude
settings/MCP wiring, native stderr/exit-code capture, and GUI consumption of the
immutable transaction result.

`npm run installer:verify:transaction` proves immutable ref freezing, exact
rollback, dirty-vault preservation, dirty-app refusal, abrupt interruption
recovery, network/build/config failure containment, no-Git degraded refusal,
and single-installer locking. `npm run clean-machine:verify` proves that a
self-reported JSON file cannot satisfy clean-machine evidence: the bundle must
carry a valid Ed25519 machine attestation, immutable Git identities, matching
encrypted restore lineage, both real-client direct/live proof bindings, and all
required capability receipts. `npm run installer:verify:matrix` runs
real isolated clean install, reinstall, update, after-config rollback, and normal
uninstall phases. It samples child-process-tree peak working set and does not
retain full install logs in memory. See `docs/TRANSACTIONAL_INSTALLER.md`.

On a newly installed Windows profile, first run `DinoBrain Private Restore.cmd`
and then run `DinoBrain Recovery Equivalence Proof.cmd`. The latter creates one
run ID, asks for one fresh challenge prompt in Codex and one in Claude Code, and
uses each same prompt to prove both `UserPromptSubmit` delivery and direct MCP
tool execution. It then runs the verification commands sequentially with output
streamed to local-only files. A successful public-safe result is written under
`60_Operations/clean-machine/`; raw logs, restore paths, and the private signing
key stay under `%LOCALAPPDATA%\DinoBrain\proofs`.

The installed Observatory launcher starts the server directly with portable
Node, a 192 MiB old-space ceiling, and a 5-second server cache against the
3-second browser poll. This avoids an idle npm parent and prevents every poll
from rebuilding state. `/api/health` exposes cache loads, bytes read, and
process memory so a high RSS watermark can be distinguished from live heap use.

`npm run codex:hooks:managed` installs or repairs the trust-free managed Codex hook path through `C:\ProgramData\OpenAI\Codex\requirements.toml`. It may request administrator permission through UAC. After it runs, fully restart Codex and create a fresh workspace thread before counting live proof.

`npm run hooks:data:verify` verifies the real `dinobrain-data` checkout has `core.hooksPath = .githooks`, then proves the hook blocks unreviewed auto-generated accepted memories and local-only event/index paths while allowing reviewed accepted memories. This is intentionally below the MCP layer so stale MCP processes cannot bypass the public-data policy by committing directly.

`npm run status:refresh` rebuilds the wiki, operations, SQLite, review, task lifecycle, graph health, evidence graph, RAG, full-memory, direct-client MCP, and freshness evidence; atomically publishes one immutable generation; and then projects health from that generation. Freshness means the status files are current; it does not mean every OS requirement is green.

`npm run status:readiness -- --allow-not-ready` prints the canonical `readiness_v2` report. `npm run readiness:verify` proves CLI/API/health/graph parity plus warning, missing, stale, malformed, mixed-generation, bounded-polling, and RAM-budget behavior. A completion-audit pointer counts only when its verdict hash and status-generation id/hash match the current immutable generation.

`npm run status:health` writes `.dino/state/health_status.json` as a projection of the canonical readiness model rather than an independent status calculator. Its 12 checks use operational gate status so evidence can be rebuilt before the final completion audit. The Observatory completion view additionally requires a generation-bound completion audit before it can render green.

`npm run status:mcp-direct` writes `.dino/state/client_mcp_direct_status.json`. It reports `verified` only when both Codex Desktop and Claude Code have fresh v2 challenge proofs. Each proof binds a one-time nonce, MCP initialize client name/version, the direct parent client executable, one MCP server instance, one task id, and server-computed hash-chain receipts for `os_begin_task`, `get_context_pack`, `wiki_search`, `search_memory`, and `finish_task`. Configuration, hooks, hand-authored JSON, a synthetic stdio client, or a deeper Codex/Claude ancestor behind a shell does not count.

`npm run verify:mcp-direct` proves the challenge protocol and status gate. It accepts only server-authenticated Codex/Claude v2 proofs and rejects legacy/self-authored JSON, missing `get_context_pack`, client process mismatch, replayed challenges, stale proofs, foreign local identities, proof tampering, receipt tampering, and one-client-only evidence. Explicit Claude `not_configured` remains visible as a low-authority local diagnostic and never satisfies release parity.

Run `npm run proof:mcp:codex` or `npm run proof:mcp:claude` after rebuilding/installing and fully restarting the target client. The corresponding installed `DinoBrain Codex MCP Proof.cmd` and `DinoBrain Claude MCP Proof.cmd` launchers do the same without requiring manual paths: they issue the challenge, copy the exact prompt, and wait until the named real client finalizes a valid receipt chain.

`npm run status:native-authority` writes `.dino/state/native_instruction_authority.json`. It scans native instruction surfaces such as `AGENTS.md`, repo `.codex` hook files, Codex config/hooks, Codex native rules/custom instruction files under `C:\Users\<you>\.codex\rules`, `instructions*`, and `custom-instructions*`, Claude settings and safe-readable Claude custom instruction/rules files when present, installer hooks, and hook approval/live-proof scripts. It stores file hashes, mtimes, line numbers, rule ids, and findings without storing raw instruction text.

`npm run verify:native-authority` proves the native authority gate with fixtures. It accepts clean user-over-memory instructions and rejects stored-memory-over-user, Codex native rules drift, Claude custom instruction drift, trusted-candidate, raw-transcript/secret-storage, broad auto-sync, and hook-trust-bypass claims.

`npm run status:source-lineage` writes `.dino/state/source_lineage_status.json`. It scans Wiki, Projects, and retrievable accepted memory, separates behavior guidance from factual/source-backed claims, and verifies fetched snapshots, bounded chunks, source/provenance/generation hash agreement, verification age, exact claim-content bindings, source URIs, and non-dangling links. Anchor-only URLs, stale support, changed claims, and internal task/trace evidence do not count as verified source truth.

`npm run verify:source-lineage` proves the source/chunk/claim lineage gate with fixtures. `npm run source:lineage:transaction:verify` additionally proves atomic publication, injected interruption rollback, 16-writer idempotency, changed-content reverification, claim tamper detection, stale support rejection, exact rollback/reapply, and tamper-safe rollback refusal. `npm run source:lineage:migrate` upgrades legacy current-vault source records; rollback and reapply accept a transaction id through their corresponding commands.

`npm run status:behavior-recall` writes `.dino/state/behavior_recall_status.json` from `.dino/state/behavior_recall_audit.jsonl`. The ledger records completion, handoff, error, direction-change, and correction recall decisions with `performed` / `skipped` / `not_applicable`, evidence paths, conflicting memories, and follow-up actions.

`npm run behavior:recall:migrate` detects stale recall evidence references and accepts only a unique task-id-matched trace. Dry-run and healthy no-op checks update local status only. `--apply` writes an immutable local migration record containing the original ledger-row hash and destination trace hash, while the syncable `60_Operations` summary contains hashes only. `npm run behavior:recall:migrate:verify` proves dry-run, apply, trace-tamper rejection, exact transaction rollback, reapply, and public-summary redaction.

`npm run verify:behavior-recall` runs a real stdio MCP correction flow. It verifies source-prompt hash binding, pre-review contradicted-rule linkage, zero mutation when conflict resolution is omitted, atomic correction promotion plus old-rule hold/demotion, later Context Pack retrieval, changed structured action, and real MCP trigger coverage for completion, handoff, error, direction change, and correction.

`npm run verify:goal` is the completion gate for the full closed-loop objective. It combines real Codex Desktop live preflight evidence, the closed-loop fixture with GitHub-style push, OS memory/retrieval/behavior verification, data Git hooks, and public-data safety into one requirement-by-requirement JSON report. The live proof window starts at the latest Codex hook config or server build timestamp, so a valid proof remains useful after the default recent-live window has passed. The goal is not complete unless this command exits successfully.

`npm run verify:codex-loop` proves the Codex closed-loop fixture end to end against a temporary Git repository and bare remote: the hook preflight injects memory, the task is finished with declared memory paths, auto-growth creates durable memory, and `auto_sync` commits and pushes policy-approved data. The fixture explicitly opts in to conditional push with `DINOBRAIN_AUTO_SYNC_ALLOW_CONDITIONAL=1` and `DINOBRAIN_AUTO_SYNC_PUSH=1`; the installed public-safe default keeps both flags at `0`.

The same verifier also checks the safety valve for read-only work: `finish_task` with `growth_policy: "trace_only"` must write the task trace but skip auto-growth, compounding, and auto-sync push even when those environment flags are enabled.

`npm run verify:codex-live -- --snippet "<prompt text>" --since "<iso timestamp>"` is stricter in a different way: it checks the real data vault and `reports/live-hooks` for a live Codex `UserPromptSubmit` event/report after the given time. It is expected to fail until a fresh trusted or managed Codex session actually dispatches the installed hook for that prompt.

`npm run verify:codex-live:recent` is the no-snippet live gate. It uses the same real-vault evidence path and fails unless a recent real Codex Desktop prompt produced a `codex_prompt_submitted` event, a matching `codex_preflight_completed` event, and a live hook report with selected memory paths. A green synthetic `hook:verify`, `verify:os`, or `verify:codex-loop` run does not replace this live proof. If the report shows `managed_prompt_hook.ok=true` but no submitted event, the managed hook is installed but Codex has not yet produced live evidence; restart Codex, create a new workspace thread after the latest `requirements.toml` write time, paste the live-proof prompt, and rerun the verifier.

`npm run verify:compounding` proves the closed behavior loop: completed task traces are distilled into accepted behavior rules, later memory search and Context Packs retrieve the promoted rule, memory-on behavior beats the memory-off baseline for the golden case, and invalid/duplicate behavior rules are held or merged.

## What `verify:os` Proves

`npm run verify:os` performs five independent checks.

### Codex MCP Integration

The script reads:

```text
C:\Users\USER\.codex\config.toml
```

It requires a `dinobrain` MCP server entry. The configured command must exist, the configured `dist/index.js` server entry must exist, and `DINOBRAIN_DATA_DIR` must point at the data vault.

Then the script starts the configured MCP command and verifies that these tools are listable:

- `start_task`
- `finish_task`
- `get_context_pack`
- `wiki_search`
- `import_session`
- `audit_memory_use`
- `git_sync`
- `auto_sync`
- `os_begin_task`
- `os_gate`
- `search_memory`
- `apply_node_lifecycle`
- `create_source_chunk`
- `record_feedback_correction`
- `evaluate_behavior`
- `run_compounding_cycle`
- `create_candidate_instance`
- `review_candidate`
- `quarantine_record`

If Codex was already running before the MCP block was added, the app may need to restart or reload before the new tool appears in future thread tool surfaces. The verifier still proves that the configured command is startable by an MCP client.

### Codex User-Level Hook Integration

The installer writes a user-level hook file:

```text
C:\Users\<you>\.codex\hooks.json
```

The hook listens for `UserPromptSubmit` and calls the installed DinoBrain PowerShell wrapper by absolute path. This makes DinoBrain preflight available outside the `dinobrain` repo after Codex reloads and the hook is trusted.

During installer verification, `DINOBRAIN_REQUIRE_CODEX_USER_HOOK=1` requires this hook to be present. Manual `npm run verify:os` reports the hook state but does not fail solely because the user-level hook is absent.

The verifier also reports `hook_runtime_config`. This catches `hooks = false` under `[features]` and `allow_managed_hooks_only = true`, either of which can make a registered user hook look installed while Codex skips it at runtime.

The verifier also reports `managed_prompt_hook`. A passing managed hook means `C:\ProgramData\OpenAI\Codex\requirements.toml` contains the DinoBrain `UserPromptSubmit` declaration and the configured managed wrapper exists. This satisfies the registration/trust-path check, but not the live-behavior check; `verify:codex-live` must still find real `codex_desktop` events.

The project hook in `.codex/hooks.json` remains for local verification and fallback. The runtime hook uses a short lock in `.dino/hook-locks` so project-level and user-level hooks do not both create task records for the same prompt.

### Claude Code MCP Integration

The installer registers a Claude Code `UserPromptSubmit` hook in `C:\Users\<you>\.claude\settings.json` so DinoBrain preflight can add context before Claude processes a prompt. When the `claude` CLI is available, the installer also registers the MCP server:

```powershell
claude mcp add --env DINOBRAIN_DATA_DIR=<vault> --transport stdio --scope user dinobrain -- <node.exe> <dist\index.js>
```

During installer verification, `DINOBRAIN_REQUIRE_CLAUDE_PROMPT_HOOK=1` requires the Claude prompt hook to be present. `DINOBRAIN_REQUIRE_CLAUDE_CODE=1` is set only after MCP registration succeeds; in that mode `verify:os` also requires `claude mcp list` to include `dinobrain`.

When running `npm run verify:os` manually on a PC without Claude Code, this check is reported as skipped and does not fail the OS verification.

### Compounding Knowledge Loop

The script creates a temporary vault and calls the DinoBrain MCP server through `StdioClientTransport`.

It verifies this sequence:

1. `start_task` records a task.
2. `finish_task` writes a trace with structured memory-use fields.
3. `create_candidate_instance` creates an evidence-backed candidate.
4. `review_candidate` approves it into `50_Instances/accepted`.
5. `get_context_pack` retrieves that accepted instance for a later related question.
6. The Context Pack trace records why the accepted instance was included.
7. `quarantine_record` quarantines that accepted instance.
8. A later `get_context_pack` no longer returns the quarantined instance.

This is the core compounding test: reviewed task knowledge must become future context, and bad memory must be removable.

### Retrieval Quality And Sync Safety

The script also runs the real data vault golden retrieval evaluator:

- target recall: `>= 0.8`
- target max noise: `<= 2`

It checks `git_sync` in the temporary vault:

- remains dry-run only
- requires manual approval
- blocks local-only secret paths
- blocks sensitive patterns
- classifies review queue paths as conditional
- classifies ordinary Wiki paths as syncable

Live hook task records under `.dino/tasks` and `.dino/context-packs` are reported as operational noise in retrieval evaluation, but they are not counted against the curated-memory noise target. They are expected to grow as the user-level hook runs.

### Session Ingest Safety

`npm run session:verify` creates a temporary vault and imports a synthetic session through MCP.

It verifies:

- redaction happens inside the `import_session` tool boundary
- raw archives are written under `10_Conversations/raw` with `raw_full_transcript_stored: false`
- candidates stay in `pending_review`
- hot/warm/cold labels are present
- raw archives, candidates, and review queue records are excluded from `wiki_search` and `get_context_pack`
- `git_sync` blocks raw archives and marks candidates/review records as conditional

### Session Knowledge Promotion

`npm run session:promote` performs the next knowledge-compounding step on the
real local Codex session history. It converts repeated session patterns into
accepted behavior/preference/decision memories and matching review records.

It verifies by construction:

- raw full transcripts are not stored
- message content is not stored
- evidence uses session refs and redacted message hashes rather than raw text
- promoted records link back to the metadata-only Codex Conversation Registry
- generated memories enter `50_Instances/accepted` so they can be indexed and
  retrieved by later Context Packs

### Public Data Safety

`npm run safety:public-data` scans the real configured data vault and writes a public-safety report under `60_Operations/public-data-safety`.

Run `npm run safety:classifier:verify` first for the deterministic SAFE-01
regression. It proves that MCP-compatible direct classification, staged Git
classification, pre-push history classification, and full-history
classification use policy `data_classification_20260712_v3`. The fixture covers
explicit path allowlisting, secrets, machine-local paths, raw transcripts,
review lineage, invalid JSON, strict UTF-8 decoding, symlinks, unsupported binary files,
the 8 MiB complete-scan limit, and a secret committed and then deleted before
push.

It verifies:

- tracked local-only paths such as `10_Conversations/raw` are blocked
- obvious secret, token, credential, private-key, and raw transcript markers are not present in public tracked data
- every pushed path has an explicit classifier rule and every supported file is fully decoded and scanned; partial scans never pass
- every unique Git-history blob is inspected, while pre-push checks the exact remote-to-local commit range supplied by Git
- accepted memories, tasks, traces, Context Packs, events, gates, audits, operations records, and currently untracked sync candidates are included in the scan scope
- candidate and review queue records are not present in the default Wiki index
- app documentation does not claim the data repo is private when GitHub reports it as public
- matched secret values are not printed in the report

The July 12 SAFE-01 remediation replaced the public data history with sanitized
root `ec9a1a5c27b082dba94de4eeecca0fe4a9238854`. A fresh clone and the real
local checkout each report 5,057 committed files, zero current/history
blockers, zero warnings, and public remote parity. The local history
realignment preserved all 28,007 worktree files and 372,849,563 bytes with the
same aggregate SHA-256 while replacing only Git HEAD/index metadata.

The first receipt-gated follow-up is data commit
`b64dd1858818a54604cce42eff8cef4419c4b0ce`. An independent fresh clone reports
5,063 committed files, zero blockers, zero warnings, two commits checked, one
sanitized root baseline, and one required receipt commit verified.

### Task-Scoped Automatic Sync

`npm run safety:task-sync:verify` runs the SAFE-02 regression against an
isolated data repository and bare Git remote. It proves that `auto_sync`
requires a task id and nonempty allowlist, then verifies that allowlist against
the server-maintained `.dino/sync-scopes` hash and lifecycle ledger.

The fixture requires all of the following:

- pending-review, unregistered, post-registration modified, and sensitive files block
- unrelated pre-staged files block instead of being swept into the commit
- a reviewed syncable task artifact is committed and pushed without sweeping neighboring files
- conditional artifacts require the exact task record and one hash-bound public receipt in the same commit
- pre-push recomputes the receipt, task binding, artifact identities, and commit trailers
- missing, forged, changed, or trailer-detached receipts block
- `os_gate` derives risk from the server-verified task allowlist, permits a clean
  scope despite unrelated dirty backlog, and blocks unregistered requested paths
- neighboring dirty backlog remains unchanged
- a second invocation returns `no_op`
- a push failure after commit returns `retry_required` with the commit SHA
- durable task records use a portable data-root reference rather than a Windows user path

The scope ledger itself is local-only and ignored by Git; the public receipt is
the portable proof that lets another clone re-evaluate the exact authorization.
The one-time sanitized root is treated as a fully scanned migration baseline;
every later commit containing conditional artifacts requires a receipt.
The real data-remote proof is commit
`b64dd1858818a54604cce42eff8cef4419c4b0ce`, containing exactly five scoped
artifacts and receipt
`60_Operations/task-sync-receipts/task-sync-receipt-a8fc8479a3939575a5e78c2299219defd676991ab4653bdd106df9d37b4272f2.json`.
The receipt file SHA-256 is
`019c9d59366411cd59dbba6c0c689822b751a7cac355741d13b7b1acaad8b895`
and its Git blob id is `5bd70cac5ede727e50deb387c45558a8c7df31bb`.
`safety:public-data:check` and encrypted restore evidence remain independent
completion gates.

### Encrypted Private Backup And Restore

`npm run backup:private:verify` runs SAFE-03 in an isolated fixture. It creates
an 8 MiB private payload, streams it through AES-256-GCM, restores it into a
fresh Git clone, and verifies both private bytes and unchanged reviewed public
memory. Wrong key, truncation, stale age, source Git mismatch, existing-target
conflict, path escape, key placement inside protected roots, archive placement
inside source roots, and accidental overwrite must all fail closed.

The verifier enforces a 192 MiB RSS delta budget and writes a hash-only status
artifact at `.dino/state/encrypted_restore_status.json`. This fixture proves the
implementation, not possession of a real off-machine archive or recovery key.
HG-09/HG-11 still require independently supplied encrypted restore and clean-PC
evidence. See `docs/PRIVATE_BACKUP_RECOVERY.md`.

### RAG Source Anchor Seeding

`npm run sources:rag:seed` records user-provided RAG methodology URLs as
anchor-only source candidates in the real data vault. It writes a catalog under
`20_Wiki`, source chunk records under `30_Sources/chunks`, and provenance links
under `.dino/provenance`.

It does not claim the external pages were read or verified. Every seeded source
record uses `verification_status: anchor_only_unverified`, so later source-truth
work must fetch bounded chunks, link concrete claims, and pass review before
using the source as factual support.

### Memory Use Audit

`npm run smoke` calls `audit_memory_use` after a completed task.

It verifies:

- a short `.dino/audits/<audit_id>.json` record is created
- the audit links provided Context Pack memories to declared `finish_task.used_memory_paths`
- the audit includes a trust score and graph health snapshot
- the audit does not need raw conversation logs

### Index And Shard Verification

The index verifiers use synthetic vaults:

- `npm run index:verify` checks the JSON Wiki graph index fallback.
- `npm run index:verify:operations` checks the JSON operations index fallback.
- `npm run index:verify:sqlite` checks routed SQLite shard retrieval for Wiki search, Context Packs, recent task lookup, and incremental task/event writes.
- `npm run graph:health:verify` checks empty graph, missing referenced path, accepted instance lineage, missing source mapping, and review queue mapping cases.
- `npm run graph:evidence:verify` checks all required typed relations, six operational lanes, focused memory lineage, stable identity, index/status count parity, incremental reuse, completion-mode full hashing, malformed fail-closed behavior, and bounded RSS.

## Evidence Quality

A green `verify:os` run is stronger than the smoke test because it validates the full feedback loop, not only individual tool behavior.

It does not prove that every future Codex answer will automatically call DinoBrain. It proves that Codex is configured with a working DinoBrain MCP server, the user-level Codex hook is registered when required, and that an MCP client can retrieve reviewed memories through that server.

The current `eval:behavior` gate checks both context retrieval and an explicit structured action contract. When a golden case supplies `memory_off_action` and `expected_memory_on_action`, a retrieved accepted record must provide the expected memory-on action, the action must differ from the baseline, and its source path must be visible. This still is not a generated-answer faithfulness grader, so representative answer relevance/correctness/faithfulness remain a separate RAG acceptance gate.

`verify:codex-loop` proves the hook/growth/sync loop can complete and push when invoked. `verify:codex-live` is the evidence gate for an actual Codex app session: it fails unless the real hook emitted live preflight events and a live hook report for the target prompt.

## Codex Hook Verification

`npm run hook:verify` simulates a Codex `UserPromptSubmit` event against a temporary vault.

It verifies:

- `.codex/hooks.json` contains a `UserPromptSubmit` hook.
- the hook wrapper can start the DinoBrain preflight script.
- `start_task` creates a task.
- `get_context_pack` creates a trace and returns relevant memory.
- `import_session` creates a local-only prompt archive and pending review candidates.
- the hook returns `hookSpecificOutput.additionalContext`.
- the final `additionalContext` SHA-256 matches the last delivery-ready event.
- events are ordered as `codex_prompt_submitted`, `task_started`,
  `context_pack_created`, `os_begin_task_completed`, then
  `codex_preflight_completed`.
- the PowerShell wrapper fails closed with a blocking hook decision when Node cannot be found.

`npm run pre-response:gate:verify` exercises the independent action policy in
separate temporary vaults. It proves that forged context declarations, missing
or stale traces, an actually disabled required MCP tool, destructive requests,
sensitive persistence, and policy-blocked DinoBrain data sync fail closed. It
also proves that redacted sensitive assistance remains available without
session growth/sync and that the hook's delivery nonce and context hash match
the final ordered event. This fixture proof does not replace the fresh Codex and
Claude live-client evidence required by HG-01.

`npm run verify:codex-loop` extends this from hook preflight to the complete Codex loop. It creates a temporary data vault and a temporary bare Git remote, runs the hook, writes a proof artifact, calls `finish_task`, and asserts that both the preflight records and the finish/growth records are pushed to the remote under explicit conditional-push opt-in.

`npm run verify:codex-live` does not simulate Codex. It reads the real `.dino/events/*.jsonl` files plus `reports/live-hooks/*.json` and fails unless the selected prompt snippet has a matching `codex_prompt_submitted` event, `codex_preflight_completed` event, and live hook report with selected memory paths. On Windows it also reports stale Codex and DinoBrain MCP processes whose start time predates `hooks.json` or `dist/index.js`, so a missing live event can be separated from hook registration failures.

The same live verifier reports the user-level hook trust surface. If the
DinoBrain `UserPromptSubmit` hook is registered but no visible `trusted_hash`
or hook `state` is present and no live event appears, the failure is classified
as a likely `/hooks` trust-review blocker instead of a stale-thread-only
problem. Codex may store trust outside `hooks.json`, so the decisive proof is
still the real live event pair plus the hook report.

`npm run verify:codex-live` also reports whether the current `CODEX_THREAD_ID` was created before `hooks.json` was updated. That stale-thread condition means the next proof attempt must happen in a fresh Codex Desktop thread, not the old long-running thread.

If `verify:codex-live` reports fresh threads after `hooks.json` but still has no `codex_prompt_submitted` event, a new Codex thread existed but did not dispatch the user-level `UserPromptSubmit` hook. Do not count `send_message_to_thread`, app-tool delegation, or background thread messages as live proof. The proof prompt must be pasted manually into a trusted Codex Desktop workspace thread after `/hooks` approval.

`npm run codex:live-proof` wraps the live proof into an operator flow. It opens a separate proof window, restarts stale Codex/MCP processes through the approval helper, copies a unique proof prompt to the clipboard, and polls `verify:codex-live` until a fresh Codex Desktop thread emits the real `codex_desktop` preflight evidence. The npm command returns once the proof window has started.
