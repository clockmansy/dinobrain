# DinoBrain OS Completion Conditions

Status: normative completion contract
Revision: 2026-07-10
Authority: this document defines the only valid `COMPLETE` verdict
Review history: `docs/OS_COMPLETION_REVIEW_RECORD_20260710.md`
Execution plan: `docs/OS_COMPLETION_EXECUTION_PLAN_20260710.md`

## Completion Rule

DinoBrain is complete only when it operates as a local-first memory OS for
Codex and Claude Code:

```text
user session
-> trusted pre-response OS context
-> evidence-aware agent action
-> finished task trace
-> reviewed memory growth and cleanup
-> measurable behavior improvement
-> policy-gated backup and recovery
-> better next session
```

The target is not model-weight training. It is an inspectable closed loop in
which current user instructions always outrank stored memory.

The final verdict is mechanical:

```text
COMPLETE = every hard gate is PASS
           and every mandatory command exits 0
           and every required artifact is fresh, parseable, and coherent
           and no automatic disqualifier is present
```

`WARN`, `DEGRADED`, `PENDING`, `UNKNOWN`, stale evidence, missing evidence, or
an unexplained dirty state cannot be converted to `PASS` by reviewer judgment.
An unavailable optional client can be `NOT_APPLICABLE` only for the local run;
release-level completion still requires proof from at least one clean machine
with both Codex and Claude Code installed.

## Evidence Contract

One completion claim must bind all evidence to one audit run. The evidence pack
must record:

- unique `audit_run_id`, start time, finish time, and auditor;
- exact app commit, data commit, package version, installer version, and release
  candidate tag;
- app and data dirty-state classification;
- every command, exit code, start/end time, and output artifact path;
- SHA-256 and generated time for every required JSON, JSONL, SQLite, release,
  live-hook, and recovery artifact;
- one result for every hard gate: `PASS`, `FAIL`, `BLOCKED`, or justified
  `NOT_APPLICABLE`;
- final verdict and the exact failing predicates when the verdict is not
  `COMPLETE`.

The durable evidence pack location is:

```text
.dino/audits/completion/<audit_run_id>/completion-verdict.json
.dino/audits/completion/<audit_run_id>/command-results.jsonl
.dino/audits/completion/<audit_run_id>/artifact-manifest.json
```

`completion-verdict.json` is the gate/result summary, `command-results.jsonl`
is the bounded command ledger, and `artifact-manifest.json` binds every proof
artifact to path, SHA-256, size, generated time, and producing command.

Evidence is valid only when all of the following are true:

1. **Fresh**: generated after the app build and after the newest relevant data
   source mutation in the same run. Live prompt proof must be no older than 24
   hours at verdict time.
2. **Coherent**: app/data commits, index generations, record counts, release
   versions, and artifact hashes agree across the evidence pack.
3. **Independent**: a task summary, status label, or self-authored trace cannot
   prove its own correctness without a verifier or independently inspectable
   source artifact.
4. **Atomic**: readers never observe a partially published JSON, SQLite, graph,
   status, or completion evidence generation.
5. **Bounded**: the normal prompt, graph, status, and Observatory paths have
   explicit work and latency bounds as the vault grows.

The completion evidence pack is itself invalid if a required file cannot be
strictly decoded, parsed, hashed, or mapped to the recorded audit run.

### Canonical Evidence Runner

`npm run completion:audit` executes the mandatory command registry and writes
the three evidence-pack files above. The typed registry must match the command
order in the Canonical PowerShell Runner: 76 base commands, three independent
24-client concurrency runs, and `verify:goal` last. The audit runner is not a
row in its own command ledger.

The runner stores bounded command metadata, byte counts, and stdout/stderr
SHA-256 values without persisting raw command output. It writes the verdict
last and immediately verifies every manifest hash. `--plan-only` and `--only`
are diagnostic modes; every unexecuted mandatory command is recorded as
`BLOCKED`, so those modes cannot produce `COMPLETE`.

`npm run completion:audit:verify` must pass before the runner itself is trusted.
It verifies registry/document parity, required package scripts, partial-run
rejection, failed-command rejection, evidence integrity, and tamper detection.

## Hard Gates

### HG-01: Live Pre-Response And Fail-Closed Loop

PASS requires:

- a fresh trusted Codex Desktop prompt writes `codex_prompt_submitted` followed
  by `codex_preflight_completed` before model work or manual MCP calls;
- the injected context contains task id, Context Pack trace, selected memory
  paths, gate status, `fail_closed`, and finish protocol;
- missing context, missing tools, forged traces, sensitive input, destructive
  actions, sync/release risk, and unverifiable duplicate-hook execution produce
  a visible block or constrained safe action;
- a machine with Claude Code installed proves the equivalent pre-response path;
- configuration, synthetic hook probes, and old reports are not substituted for
  current live proof.

Required evidence:

- recent live-hook report and matching ordered events;
- `npm run verify:codex-live:recent`;
- `npm run verify:codex-mcp-preflight`;
- Claude live proof from the release-equivalence machine.

### HG-02: Direct MCP Parity And Native Authority

PASS requires:

- Codex and Claude Code directly expose and invoke `os_begin_task`,
  `finish_task`, `get_context_pack`, `wiki_search`, and `search_memory`;
- CLI, hook, bootstrap, or synthetic server fallback is not counted as direct
  client MCP proof;
- each client proof is bound to a fresh one-time challenge, MCP initialize
  name/version, the direct parent client executable, one server instance, one
  task id, and server-computed receipts for all five canonical tool calls;
- `not_configured` is a local diagnostic only and cannot satisfy release parity;
- native Codex and Claude instruction surfaces are scanned without storing raw
  private instruction text;
- unresolved `native_memory_drift`, wrong-memory references, or instruction
  conflicts block the gate.

Required evidence:

- `.dino/state/client_mcp_direct_status.json` with both clients verified by v2
  challenge proofs;
- `.dino/state/native_instruction_authority.json` with no blocking drift;
- `npm run verify:mcp-direct` and `npm run verify:native-authority`.

### HG-03: Closed Task Lifecycle And Observable Memory Use

PASS requires:

- every nontrivial task has start, Context Pack, gate, finish trace, and terminal
  status;
- no stale active task, orphan trace, missing terminal trace, task-id mismatch,
  or ungrounded finish remains;
- representative completed, partial, blocked, verifier, correction, and
  handoff tasks record provided, declared-used, and observed-used memory;
- audit records remain bounded and contain no raw transcripts or secrets.

Required evidence:

- `.dino/state/task_sessions.json`;
- `.dino/state/task_lifecycle_settlement.json`;
- `.dino/state/task_finish_grounding_classifications.jsonl`;
- representative `.dino/audits/*.json` records;
- task lifecycle and memory-audit verifier success.

### HG-04: Retrieval Quality, Scale, And Answer Quality

PASS requires:

- normal prompt paths use current SQLite/index-backed sparse and semantic dense
  top-K retrieval with bounded candidate generation;
- BM25/sparse, dense, RRF, rerank, provenance, lifecycle, type-budget, and noise
  contributions are inspectable;
- `hybrid_contextual_v2` is reported only when a real semantic provider/index
  participates; lexical or text-hash fallback is honest and cannot satisfy this
  completion gate;
- representative Korean/English, paraphrase, rare exact, negative, provenance,
  quarantine, recency, and noisy-growth cases pass;
- generated memory-on answers beat memory-off answers for faithfulness,
  relevance, correctness, grounding, source support, and forbidden-memory
  avoidance;
- answer evaluation uses an explicit v2 golden, excludes recent task/judge text,
  and is calibrated against at least three blinded independent judges with
  golden, answer, combined runtime, dense-index, and review-artifact hashes;
- current-instruction and forbidden-memory safety are perfect, judge
  disagreement stays within the declared bound, and stale/tampered calibration
  fails closed;
- query vectors, semantic model pipelines, and Observatory refresh state are
  bounded; overlapping refreshes or per-query pipeline construction fail the
  resource regression gate;
- warm p95 targets pass: Context Pack under 700 ms, `wiki_search` under 300 ms
  at 50k curated records, recent-task lookup under 50 ms, incremental operation
  write under 50 ms, and full 50k shard rebuild under 3 minutes.

Required evidence:

- `.dino/state/rag_proof_status.json`;
- `.dino/state/rag_eval_status.json`;
- `.dino/state/live_semantic_query_status.json`;
- `.dino/state/answer_quality_status.json`;
- `.dino/evaluations/answer-quality-calibration.json`;
- the calibration's hash-bound independent review artifact under
  `60_Operations/rag-evaluation/`;
- `.dino/state/vector_index_migration.json`;
- `.dino/evaluations/scale-50k-status.json` with `status=healthy`,
  `qualifying=true`, zero failed assertions, and current code/generator/
  environment bindings;
- current-vault and scale-test reports, not fixture reports alone.

### HG-05: Durable Source, Chunk, Claim, And Provenance Lineage

PASS requires:

- factual, public, external, or high-risk claims in Wiki, Projects, and accepted
  memory map to verified durable source chunks and provenance records;
- source URI/location, bounded source body, verification status/date, claim
  paths, and non-dangling links are present;
- anchor-only URLs and internal task traces are not treated as verified source
  truth;
- Context Packs distinguish behavior guidance, accepted memory, source citation,
  and verified claim support.

Required evidence:

- `.dino/state/source_lineage_status.json` with zero unsupported factual claims,
  dangling claims, or anchor-only false support;
- `npm run verify:source-lineage`, `npm run source:lineage:transaction:verify`,
  plus current-vault lineage generation evidence.

### HG-06: Memory Lifecycle, Review, And Compounding Hygiene

PASS requires:

- candidates remain excluded until review;
- duplicate, stale, weak, broad, contradicted, unsupported, sensitive, and
  low-use records are merged, held, quarantined, demoted, archived, or proposed
  for deletion;
- review, semantic-job, active-task, and compounding backlogs are bounded and
  classified;
- auto-compounded rules are never presented as independently reviewed memory;
- operational plumbing cannot swamp Wiki, Source, or Project retrieval lanes;
- cold tasks, traces, packs, reports, and rules are partitioned or archived so
  growth does not create prompt-path latency or ranking pressure.

Required evidence:

- `.dino/state/wiki-review-queue.json`;
- `.dino/state/semantic_jobs.json`;
- `.dino/state/review_worklist.json`;
- `.dino/state/review_worklist_actions.json`;
- lifecycle/compounding reports with zero unexplained blockers.

### HG-07: Feedback Writeback And Behavior Improvement

PASS requires:

- direct user corrections become reviewed behavior memory or an explicit
  pending candidate;
- later relevant Context Packs retrieve the correction;
- contradicted older behavior is held, merged, or demoted;
- completion, handoff, error, direction-change, and correction triggers record
  `performed`, justified `skipped`, or evidence-backed `not_applicable`;
- representative behavior evaluation proves that memory changes future behavior
  for the better.

Required evidence:

- `.dino/state/behavior_recall_audit.jsonl`;
- `.dino/state/behavior_recall_evidence_migration.json` plus immutable local
  migration records binding old evidence references to task-matched trace hashes;
- `.dino/state/behavior_recall_status.json`;
- `.dino/state/controlled_compounding_status.json`, proving recurring proposals,
  independent promotion gates, lifecycle pressure, and bounded hot-rule cost;
- behavior golden/evaluation reports and `npm run verify:behavior-recall`.

### HG-08: Graph, Observatory, Health, And Evidence Coherence

PASS requires:

- graph nodes and edges cover records, folders, tags, kinds, Wiki links,
  provenance, lifecycle, quarantine, Context Pack use, and trace use;
- graph health is generated from the current corpus and agrees with index and
  accepted/source counts;
- Observatory shows live/stale tasks, preflight events, Context Packs, memory
  use, gates, review/lifecycle, graph/index freshness, sync risk, and
  verifier/main/reviewer/pending/blocked lanes;
- CLI, API, health rollup, and Observatory show the same blocker status;
- polling, graph assembly, and artifact reads are bounded and cannot perform an
  unbounded full-vault scan per refresh;
- stale, malformed, generation-mismatched, or warning-bearing mandatory
  evidence cannot render green.

Required evidence:

- `.dino/index/graph-health.json`;
- `.dino/state/current-status-generation.json` plus the immutable manifest;
- `.dino/state/current-completion-audit.json` bound to that generation;
- `.dino/state/health_status.json`;
- `.dino/state/monitoring_status.json`;
- Observatory verification plus current screenshot/API evidence.

### HG-09: Privacy, Public Sync, Backup, And Restore Safety

PASS requires:

- one classification policy governs public-data scanning, `git_sync`,
  `auto_sync`, and data Git hooks;
- raw conversations, personal files, secrets, credentials, attachments, local
  caches, and unreviewed candidates do not enter public history;
- scanning covers the full tracked vault and Git history, not token patterns
  alone;
- push requires a nonempty allowlist, mandatory sensitivity scan, and zero
  unresolved conditional/blocked paths;
- local-only data has encrypted backup and a tested restore path; GitHub clone
  alone is not accepted as full recovery;
- app/data visibility and documentation agree with the real remotes.

Required evidence:

- public-data safety report with zero blockers or degraded warnings;
- `git_sync` classification and verified data Git hooks;
- encrypted backup/restore drill report bound to the audit run.

### HG-10: Data Integrity, Atomic Publication, Concurrency, And Performance

PASS requires:

- every manifest-listed file is present, byte-readable, hash-matched, strictly
  decoded where applicable, and parseable as JSON/JSONL/SQLite where applicable;
- SQLite header, page, quick-check, integrity-check, and foreign-key checks pass;
- derived indexes self-recover without changing source task/trace/pack/event
  truth;
- atomic publication prevents mixed generations and partial reads;
- at least 24 independent MCP processes can start and finish identical requests
  while JSON and SQLite rebuilds overlap, with unique IDs, zero lost records,
  zero leaked locks, zero `SQLITE_BUSY`, and zero fail-closed results caused by
  writer contention;
- the concurrency test passes three consecutive runs for the release candidate.

Required evidence:

- `.dino/state/full_memory_manifest.json`;
- `.dino/state/full_memory_audit_status.json`;
- operations/wiki/SQLite manifests and integrity output;
- three `DINOBRAIN_CONCURRENCY_CLIENTS=24` verifier results.

### HG-11: Installer, Clean-Machine Recovery, Versioning, And Rollback

PASS requires:

- a clean Windows machine installs intended immutable app/data refs and portable
  runtime without preexisting local Codex contamination;
- Codex and Claude MCP plus hooks are registered when the clients exist;
- hook trust is guided and proven live, never silently bypassed;
- reinstall/update is idempotent and refuses unsafe overwrite;
- config writes preserve valid TOML/JSON and normalized line endings;
- version drift among package, installer, app commit, data contract, tag, ZIP,
  checksum, and GitHub asset is a hard failure;
- failed install/update has transactional rollback, and uninstall/purge behavior
  is verified;
- the restored machine reproduces the same behavior gates and reviewed memory
  policy, including local-only backup restoration where required.

Required evidence:

- clean-machine install, update, rollback, uninstall, and both-client live proof;
- `.dino/state/release_manifest_status.json` bound to exact commits and assets;
- all installer and uninstall verifier results.

### HG-12: Repository, Release, And Final Aggregate Parity

PASS requires:

- app and data local HEADs equal the remote refs named in the evidence pack;
- dirty state is empty or every path is explicitly classified and excluded from
  the completion claim;
- tag, package version, installer version, ZIP, SHA-256, GitHub release asset,
  app commit, and data commit agree;
- no required proof artifact is untracked or available only in a reviewer chat;
- `npm run verify:goal` exits 0 after every preceding hard gate passes;
- the final evidence pack contains no `WARN`, `DEGRADED`, `PENDING`, `UNKNOWN`,
  stale artifact, malformed artifact, or unresolved blocker.

Required evidence:

- clean/parity Git reports for both repositories;
- release manifest and GitHub release evidence;
- final `verify:goal` report and completion evidence pack.

## Executable Decision Table

Run from the app repository with the Node runtime selected by the installer.
Fixture verifiers prove regression coverage only; their PASS does not replace
the current-vault artifacts named above.

| Phase | Exact command | Hard-gate effect |
| --- | --- | --- |
| Build | `npm run build` | Blocks every gate on failure |
| Current evidence | `npm run status:refresh` | Rebuilds the current-vault evidence generation |
| Full vault | `npm run audit:full-memory` | HG-10 requires zero missing/hash/parse/integrity blockers |
| Completion runner | `npm run completion:audit:verify` | HG-08/HG-10/HG-12 require ledger, manifest, verdict, and tamper-detection integrity |
| Atomic writers | `npm run atomic:writers:verify` | HG-03/HG-10 require zero direct production state writers and valid concurrent publication |
| Status generation | `npm run status:generation:verify` | HG-08/HG-10/HG-12 require crash-safe pointer publication and zero mixed-generation reads |
| Readiness parity | `npm run readiness:verify` | HG-08/HG-12 require identical gate status, reason, proof, freshness, generation, and next action across CLI/API/UI/graph/health |
| Prompt eligibility | `npm run prompt:eligibility:verify` | HG-01/HG-03/HG-06 require zero durable internal jobs, idempotent duplicate hooks, lease ownership, and visible timeout blocking |
| Pre-response action gate | `npm run pre-response:gate:verify` | HG-01/HG-02/HG-09 require OS-observed context/tool/freshness/sensitivity/sync evidence, ordered delivery, and fail-closed risk fixtures |
| Freshness | `npm run status:freshness:verify` | HG-08/HG-12 require fresh coherent evidence |
| JSON index | `npm run index:verify:operations` | HG-10 requires valid incremental and self-recovery behavior |
| SQLite | `npm run index:verify:sqlite` | HG-04/HG-10 require valid shards and incremental rows |
| Concurrency | `$env:DINOBRAIN_CONCURRENCY_CLIENTS='24'; npm run index:verify:concurrency` | HG-10; run three times |
| Task lifecycle | `npm run task:lifecycle` | HG-03 requires zero current-vault blockers |
| Lifecycle regression | `npm run task:lifecycle:verify` | HG-03 regression coverage |
| Lifecycle settlement | `npm run task:lifecycle:settle` | HG-03 requires no pending deterministic repair |
| Settlement regression | `npm run task:lifecycle:settle:verify` | HG-03 regression coverage |
| Real-client lifecycle soak | `npm run soak:lifecycle:check` | HG-03/HG-10 require fresh signed, hash-bound 24-hour Codex+Claude evidence with immutable refs and zero new blockers |
| Lifecycle soak regression | `npm run soak:lifecycle:verify` | Rejects early, one-client, payload-tampered, and referenced-file-tampered evidence |
| Memory lifecycle | `npm run memory:lifecycle` | HG-05/HG-06/HG-10 require a healthy current-vault lifecycle report |
| Memory lifecycle regression | `npm run memory:lifecycle:verify` | HG-05/HG-06/HG-10 require atomic, reversible, idempotent transitions |
| Review settlement | `npm run review:settle` | HG-06 requires bounded classified queues |
| Review worklist | `npm run review:worklist` | HG-06 requires explicit remaining work |
| Review actions | `npm run review:worklist:actions` | HG-06 requires safe actions or justified manual debt |
| Review regressions | `npm run review:settle:verify` | HG-06 regression coverage |
| Review regressions | `npm run review:worklist:verify` | HG-06 regression coverage |
| Review regressions | `npm run review:worklist:actions:verify` | HG-06 regression coverage |
| Review backpressure | `npm run review:backpressure` | HG-04/HG-06 require bounded hot review debt |
| Review backpressure regression | `npm run review:backpressure:verify` | HG-04/HG-06/HG-10 admission, concurrency, and rollback coverage |
| Cold partitions | `npm run cold:partitions` | HG-04/HG-06 require no eligible cold records in hot retrieval |
| Cold partition regression | `npm run cold:partitions:verify` | HG-04/HG-06/HG-10 partition, exclusion, and rollback coverage |
| Direct MCP | `npm run status:mcp-direct` | HG-02 current-client status |
| Direct MCP regression | `npm run verify:mcp-direct` | HG-02 regression coverage |
| Native authority | `npm run status:native-authority` | HG-02 current instruction-drift status |
| Native regression | `npm run verify:native-authority` | HG-02 regression coverage |
| Source lineage | `npm run status:source-lineage` | HG-05 current-vault lineage status |
| Lineage regression | `npm run verify:source-lineage` | HG-05 regression coverage |
| Lineage transaction | `npm run source:lineage:transaction:verify` | HG-05/HG-10 atomic publication, recovery, concurrency, tamper, rollback, and reapply proof |
| Behavior recall | `npm run status:behavior-recall` | HG-07 current trigger and correction status |
| Controlled compounding | `npm run status:compounding` | HG-06/HG-07 current recurrence, review, lifecycle, and budget status |
| Recall evidence migration | `npm run behavior:recall:migrate` | HG-07/HG-10 immutable stale-reference repair status |
| Recall migration regression | `npm run behavior:recall:migrate:verify` | HG-07/HG-10 apply, tamper, rollback, and reapply proof |
| Recall regression | `npm run verify:behavior-recall` | HG-07 regression coverage |
| RAG proof | `npm run rag:proof` | HG-04 current proof generation |
| RAG evaluation | `npm run eval:rag` | HG-04 current retrieval evaluation |
| Live semantic | `npm run status:live-semantic-query` | HG-04 arbitrary-query semantic status |
| Answer quality | `npm run status:answer-quality` | HG-04 memory-on/off generated-answer status |
| RAG regressions | `npm run rag:proof:verify` | HG-04 regression coverage |
| Contextual hybrid retrieval | `npm run rag:retrieval:verify` | HG-04/HG-05 independent dense top-K, exact alias, score contribution, and lane-budget coverage |
| Vector migration | `npm run rag:vector:migration:verify` | HG-04/HG-10 provider/model/dimension migration, rollback, and tamper coverage |
| RAG regressions | `npm run eval:rag:verify` | HG-04 regression coverage |
| RAG regressions | `npm run verify:live-semantic-query` | HG-04 regression coverage |
| RAG regressions | `npm run verify:answer-quality` | HG-04 regression coverage |
| Query cache budget | `npm run verify:live-query-cache-budget` | HG-04/HG-10 bounded live-query memory |
| Semantic pipeline cache | `npm run verify:semantic-pipeline-cache` | HG-04/HG-10 one model pipeline per process/config |
| 50k scale regression | `npm run scale:50k:verify` | HG-04/HG-08/HG-10 deterministic, adversarial, bounded-work coverage |
| 50k scale current proof | `npm run scale:50k:check` | HG-04/HG-08/HG-10 require a qualifying hash-bound 50k/1,000-session report |
| Observatory resource regression | `npm run observatory:verify` | HG-08/HG-10 coalesced refresh and bounded payload proof |
| Graph | `npm run graph:health` | HG-08 current graph evidence |
| Graph regression | `npm run graph:health:verify` | HG-08 regression coverage |
| Evidence graph | `npm run graph:evidence` | HG-05/HG-06/HG-08 canonical typed lineage and lane evidence |
| Evidence graph regression | `npm run graph:evidence:verify` | HG-05/HG-06/HG-08/HG-10 stable identity, incremental update, focused traversal, count parity, and bounded-memory coverage |
| Session ingest | `npm run session:verify` | HG-03/HG-06/HG-09 ingestion safety |
| Unified data classifier | `npm run safety:classifier:verify` | HG-09/HG-10 cross-surface parity, complete scans, and history-injected secret rejection |
| Task-scoped sync | `npm run safety:task-sync:verify` | HG-07/HG-09/HG-12 authoritative task scope, review/hash binding, neighboring backlog isolation, real remote push, and retry-state proof |
| Encrypted private restore | `npm run backup:private:verify` | HG-09/HG-11 authenticated local-only inventory, bounded streaming, fail-closed restore, and Git-clone recovery proof |
| Public safety | `npm run safety:public-data:check` | HG-09 requires zero blockers/warnings |
| Data hooks | `npm run hooks:data:verify` | HG-09 push-policy enforcement |
| OS regression | `npm run verify:os` | HG-01 through HG-09 regression coverage |
| OS v2 regression | `npm run verify:v2` | HG-01 through HG-07 regression coverage |
| Flow regression | `npm run flow:audit` | HG-01/HG-03 closed-loop fixture |
| Compounding | `npm run verify:compounding` | HG-06/HG-07 regression coverage |
| Live Codex | `npm run verify:codex-live:recent` | HG-01 fresh real prompt proof |
| Codex MCP | `npm run verify:codex-mcp-preflight` | HG-01/HG-02 direct preflight proof |
| Release manifest | `npm run status:release-manifest` | HG-11/HG-12 current release parity |
| Release regression | `npm run verify:release-manifest` | HG-11/HG-12 regression coverage |
| Installer version | `npm run installer:verify:version` | HG-11 immutable version parity |
| Installer path | `npm run installer:verify:path-ux` | HG-11 path/reinstall behavior |
| Hook approval | `npm run installer:verify:approval` | HG-01/HG-11 trust flow |
| Observatory launcher | `npm run installer:verify:launchers` | HG-08/HG-11 launcher evidence |
| Windows Sandbox proof | `npm run installer:verify:sandbox-proof` | HG-09/HG-11 disposable clean-machine evidence path |
| Managed hook | `npm run installer:verify:managed-hook` | HG-01/HG-11 managed hook evidence |
| Semantic install | `npm run installer:verify:semantic-rag` | HG-04/HG-11 semantic setup evidence |
| User hook merge | `npm run installer:verify:hooks` | HG-01/HG-11 idempotent coexistence with existing hooks |
| Claude install | `npm run installer:verify:claude` | HG-02/HG-11 Claude settings and MCP registration fixture |
| Native/result contract | `npm run installer:verify:native-result` | HG-11 child exit capture and GUI transaction-result enforcement |
| Installer transaction | `npm run installer:verify:transaction` | HG-10/HG-11 immutable refs, rollback, interruption recovery, and install locking |
| Recovery evidence | `npm run clean-machine:verify` | HG-01/HG-02/HG-09/HG-11 signed clean-machine bundle and anti-forgery checks |
| Isolated install matrix | `npm run installer:verify:matrix` | HG-11 clean/reinstall/update/failure/uninstall fixture; external both-client proof still required |
| Uninstall | `npm run uninstall:verify` | HG-11 uninstall/purge evidence |
| Final aggregate | `npm run verify:goal` | HG-12; run last and only after all rows above pass |

## Canonical PowerShell Runner

The following runner executes the repository-local mandatory suite. It does not
replace the external clean-machine, Claude live, encrypted restore, or GitHub
release evidence required by HG-01, HG-09, HG-11, and HG-12.

```powershell
$ErrorActionPreference = 'Stop'
$commands = @(
  'npm run build',
  'npm run completion:audit:verify',
  'npm run atomic:writers:verify',
  'npm run status:generation:verify',
  'npm run readiness:verify',
  'npm run prompt:eligibility:verify',
  'npm run pre-response:gate:verify',
  'npm run audit:full-memory',
  'npm run status:freshness:verify',
  'npm run index:verify:operations',
  'npm run index:verify:sqlite',
  'npm run task:lifecycle',
  'npm run task:lifecycle:verify',
  'npm run task:lifecycle:settle',
  'npm run task:lifecycle:settle:verify',
  'npm run soak:lifecycle:check',
  'npm run soak:lifecycle:verify',
  'npm run memory:lifecycle',
  'npm run memory:lifecycle:verify',
  'npm run review:settle',
  'npm run review:worklist',
  'npm run review:worklist:actions',
  'npm run review:settle:verify',
  'npm run review:worklist:verify',
  'npm run review:worklist:actions:verify',
  'npm run review:backpressure',
  'npm run review:backpressure:verify',
  'npm run cold:partitions',
  'npm run cold:partitions:verify',
  'npm run status:mcp-direct',
  'npm run verify:mcp-direct',
  'npm run status:native-authority',
  'npm run verify:native-authority',
  'npm run status:source-lineage',
  'npm run verify:source-lineage',
  'npm run source:lineage:transaction:verify',
  'npm run status:behavior-recall',
  'npm run status:compounding',
  'npm run behavior:recall:migrate',
  'npm run behavior:recall:migrate:verify',
  'npm run verify:behavior-recall',
  'npm run rag:proof',
  'npm run eval:rag',
  'npm run status:live-semantic-query',
  'npm run status:answer-quality',
  'npm run rag:proof:verify',
  'npm run rag:retrieval:verify',
  'npm run rag:vector:migration:verify',
  'npm run eval:rag:verify',
  'npm run verify:live-semantic-query',
  'npm run verify:live-query-cache-budget',
  'npm run verify:semantic-pipeline-cache',
  'npm run verify:answer-quality',
  'npm run scale:50k:verify',
  'npm run scale:50k:check',
  'npm run observatory:verify',
  'npm run graph:health',
  'npm run graph:health:verify',
  'npm run graph:evidence',
  'npm run graph:evidence:verify',
  'npm run session:verify',
  'npm run safety:classifier:verify',
  'npm run safety:task-sync:verify',
  'npm run backup:private:verify',
  'npm run safety:public-data:check',
  'npm run hooks:data:verify',
  'npm run verify:os',
  'npm run verify:v2',
  'npm run flow:audit',
  'npm run verify:compounding',
  'npm run verify:codex-live:recent',
  'npm run verify:codex-mcp-preflight',
  'npm run status:release-manifest',
  'npm run verify:release-manifest',
  'npm run installer:verify:version',
  'npm run installer:verify:path-ux',
  'npm run installer:verify:approval',
  'npm run installer:verify:launchers',
  'npm run installer:verify:sandbox-proof',
  'npm run installer:verify:managed-hook',
  'npm run installer:verify:semantic-rag',
  'npm run installer:verify:hooks',
  'npm run installer:verify:claude',
  'npm run installer:verify:native-result',
  'npm run installer:verify:transaction',
  'npm run clean-machine:verify',
  'npm run installer:verify:matrix',
  'npm run uninstall:verify'
)

foreach ($command in $commands) {
  & powershell -NoProfile -Command $command
  if ($LASTEXITCODE -ne 0) { throw "Completion gate failed: $command" }
}

1..3 | ForEach-Object {
  $env:DINOBRAIN_CONCURRENCY_CLIENTS = '24'
  npm run index:verify:concurrency
  if ($LASTEXITCODE -ne 0) { throw "Concurrency gate failed on run $_" }
}

npm run status:refresh
if ($LASTEXITCODE -ne 0) { throw 'Final status generation failed: status:refresh' }

npm run verify:goal
if ($LASTEXITCODE -ne 0) { throw 'Final aggregate gate failed: verify:goal' }
```

The completion audit runner performs one internal status refresh after its
command ledger is durably written. This finalization refresh is not a substitute
for the mandatory `status:refresh` command; it prevents the audit's own ledger
from making the published generation stale before artifact inspection.

## Automatic Disqualifiers

The verdict is not `COMPLETE` if any of these is true:

- a mandatory command is missing, skipped, nonzero, or fixture-only;
- evidence is stale, malformed, mixed-generation, self-referential, or not
  bound to the audit commits;
- a mandatory artifact contains warning, degraded, pending, unknown, or blocker
  state;
- live pre-response proof is absent or hook trust was bypassed;
- Codex/Claude direct MCP parity is inferred from configuration or fallback;
- semantic retrieval or answer-quality completion relies on lexical/text-hash
  scaffolding alone;
- factual claims lack verified source/chunk/claim lineage;
- stale tasks, ungrounded finishes, unreviewed growth, review debt, or broad
  behavior rules are hidden by a green rollup;
- graph, health, freshness, CLI, API, and Observatory disagree;
- public safety ignores Git history, full-vault content, sensitivity, or sync
  policy;
- backup/recovery omits encrypted local-only data;
- concurrent writers lose, duplicate, corrupt, or partially publish records;
- clean-machine install, rollback, uninstall, or both-client proof is absent;
- app/data commits, versions, tag, ZIP, checksum, and GitHub asset disagree;
- required proof exists only in chat, an untracked file, or a reviewer claim.

Historical state snapshots and reviewer votes are deliberately non-normative
and live only in `docs/OS_COMPLETION_REVIEW_RECORD_20260710.md` and the older
dated planning documents it references.
