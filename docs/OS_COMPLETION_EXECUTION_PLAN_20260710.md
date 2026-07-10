# DinoBrain OS Completion Execution Plan

Status: active implementation plan
Revision: 2026-07-10
Normative authority: `docs/OS_COMPLETION_CONDITIONS.md`
Review history: `docs/OS_COMPLETION_REVIEW_RECORD_20260710.md`

## 1. Objective

This plan turns the twelve normative hard gates into an implementation order.
It does not redefine completion. DinoBrain remains `NOT_COMPLETE` until the
normative contract produces one fresh, coherent evidence pack in which every
hard gate is `PASS` and no automatic disqualifier is present.

The intended product loop is:

```text
real user prompt
-> trusted pre-response context and independent gate
-> bounded evidence-aware retrieval
-> agent action
-> grounded terminal task trace
-> reviewed memory lifecycle and correction writeback
-> policy-scoped sync plus recoverable local-only backup
-> measurable improvement in the next relevant session
```

The plan is gate-driven, not feature-count-driven. A work package is complete
only when its implementation, verifier, current-vault evidence, failure drill,
and rollback behavior all pass.

## 2. Planning Baseline

The table below is the frozen 2026-07-10 planning baseline. Current execution
evidence is recorded in the progress section and must not rewrite this snapshot.

| Area | Observed state | Planning consequence |
| --- | --- | --- |
| App repository | `c64dc9b`, equal to `origin/main`; pre-existing `package-lock.json` modification | Do not include the dirty lockfile in unrelated work; require explicit dirty-state classification |
| Version authority | package `2.2.9`, OS contract `2.2.1` | Replace independent literals with one generated version source before release work |
| Data repository | local HEAD `1552e600`, one commit ahead of `origin/main`, 974 dirty/untracked paths after status refresh and backlog accumulation | Freeze and classify the data baseline before any migration or completion claim |
| Final aggregate | `npm run verify:goal` exits 1 | Current product verdict is `NOT_COMPLETE` |
| Direct MCP | 0/2 clients verified; Codex and Claude proofs stale or invalid | Build fresh direct-client proof protocol; configuration is not proof |
| Task lifecycle | 543 tasks; 192 stale active; 4 terminal tasks missing traces; 196 blockers | Stop new internal-task pollution, then settle existing debt without inventing success |
| Review lifecycle | 1,549 candidates; 1,004 classified open; 214 safe auto-hold actions; 790 manual-review items | Apply bounded lifecycle pressure and cluster the manual queue before enabling more growth |
| Behavior recall | 68 entries; one blocker caused by a removed duplicate trace path; zero correction entries | Repair evidence references and prove a real correction is later retrieved and followed |
| Retrieval | real MiniLM semantic provider active for 69 indexed records; live semantic and local answer-quality status healthy | Preserve the working path, then add explicit golden data, independent calibration, and 50k scale proof |
| Provenance | status healthy; 20 verified source chunks and four verified claim-support groups | Expand coverage and make claim support transactional before treating it as complete at scale |
| Graph | health score 90 with an accepted-source warning | Resolve lineage warning and bind graph/UI state to one evidence generation |
| Release | data HEAD not pushed, dirty app/data state, tag mismatch, stale ZIP, GitHub asset not checked | Defer release until all product gates and clean-machine tests pass |
| Completion evidence | normative paths exist only in documentation | Implement the audit-run ledger, artifact manifest, and mechanical verdict engine first |

The current `verify:goal` blockers are:

1. direct Codex/Claude MCP parity not verified;
2. behavior recall not healthy;
3. review settlement not complete;
4. task lifecycle finish gate not healthy;
5. lifecycle settlement actions not applied or resolved;
6. release manifest parity not verified.

Passing current fixture checks is useful regression evidence, but it is not a
substitute for the stronger current-vault, scale, live-client, recovery, and
release evidence required by the normative contract.

### Implementation Progress - 2026-07-11

The first foundation slice is implemented and remains intentionally
`NOT_COMPLETE`:

- FND-01 now has a typed 12-gate registry, 61 mandatory command instances,
  bounded command-result ledger, hashed artifact manifest, verdict-last atomic
  publication, post-write integrity verification, and tamper regression tests;
- the first current-vault plan-only evidence pack is
  `.dino/audits/completion/completion-20260710-143923446-3953db16-807f-4844-a012-61375cd6a544/`;
- that pack records 12 non-passing gates, 56 blocked commands, 88 manifest
  entries, current app/data dirty and remote-ref state, warning-bearing
  artifacts, and health/monitoring generation incoherence;
- a second real current-vault partial audit,
  `.dino/audits/completion/completion-20260710-143924747-29e6e124-0746-4a8c-9e2c-1c7d0f291eee/`,
  executed `npm:build` successfully, recorded the other 55 commands as
  `BLOCKED`, persisted only output byte counts and hashes, and remained
  `NOT_COMPLETE`;
- FND-03 now uses root `version.json` as the release authority for the OS
  contract, hook, Observatory, installer builder, release publisher, and release
  manifest; build/check fail when package, lock, installer, or runtime metadata
  drift from version `2.2.9` and data contract version `3`.
- FND-02 now covers production TypeScript and operational script state writers
  with common atomic helpers. Status/index output is staged under an immutable
  generation, validated by hash and format, then exposed through one atomic
  `.dino/state/current-status-generation.json` pointer. `status:refresh`, the
  completion audit, and Observatory enforce that same generation. Executable
  regressions reject source drift and snapshot tampering, preserve the prior
  pointer on pre-publication failure, and prove that mixed generations are not
  exposed.
- FND-02 strict readers now reject invalid UTF-8, bare carriage returns, unsafe
  relative paths, malformed JSON/JSONL, SQLite page/header corruption,
  `quick_check`, `integrity_check`, and foreign-key failures. The real vault was
  published as one 29-artifact generation, and the 24-client task/trace/pack/
  event plus JSON/SQLite overlap test passed three consecutive runs with no
  collisions, lost rows, active-task residue, or leaked lock.
- LOOP-01 now shares one prompt classifier between the hook and MCP server.
  Title generation, ambient suggestions, internal Codex service work, and
  diagnostic probes create zero durable tasks or Context Packs. Stable
  session-turn replays use a local receipt and return the original preflight;
  user tasks carry a lease, heartbeat, and terminal owner; duplicate finishes
  are idempotent; hook timeout produces a visible fail-closed response.
- LOOP-02 now derives Context Pack presence, task binding, byte hash, freshness,
  event order, registered tool presence, sensitivity, and DinoBrain data-sync
  risk from OS-observed state. It emits `allow`, `constrained_action`, or
  `block` with reason codes; redacts direct MCP requests before persistence;
  auto-terminals blocked preflight tasks; skips session growth/sync for
  sensitive prompts; and records `codex_preflight_completed` only after the
  report, receipt, and hashed model-context payload are ready.
- `pre-response:gate:verify` proves forged, missing, stale, missing-tool,
  sensitive-persistence, destructive, and blocked-sync failures plus safe
  sensitive assistance and strict hook event ordering in independent fixtures.
- LOOP-04 was applied to a recomputed 548-task/271-trace vault. The 199-action
  migration reached zero blockers, an actual rollback restored 199 files and
  removed 177 generated traces with zero conflicts, and a second migration
  reapplied the classification. A hash-chained ledger, exact local backup, Git
  recovery ref, shared mutation lock, terminal task/trace transaction, and
  tamper/conflict regressions now prevent the same debt pattern from recurring.
- The latest full executable audit is
  `completion-20260710-170538330-91239ab7-e2a7-4e77-b75d-bd94834d0a2e`.
  It ran all 61 mandatory command instances, returned `NOT_COMPLETE`, and now
  records HG-03 as `PASS`; HG-10 is blocked only by the external 50k-scale
  evidence requirement.
- LOOP-03 now uses a one-time challenge rather than trusting hand-authored proof
  JSON. The server binds five required calls (`os_begin_task`,
  `get_context_pack`, `wiki_search`, `search_memory`, `finish_task`) to one task,
  MCP initialize client name/version, the direct parent Codex/Claude executable,
  a server instance, a local identity key, and a hash-chained receipt ledger.
  Claude `not_configured` remains visible for local diagnosis but can no longer
  satisfy release parity.
- `verify:codex-live:recent` correctly remains non-passing after this code
  change: the current long-running task predates the hook requirements and all
  three observed MCP processes predate the rebuilt server. A restarted client,
  fresh trusted Codex task, and matching ordered delivery proof are still
  required; synthetic fixtures are not substituted for that evidence.

FND-01 is not fully closed until a full current-vault audit, fresh external
proof imports, final-generation publication, and release-candidate evidence all
pass. FND-02 now meets its local and current-vault implementation acceptance;
release-level HG-10 still requires the final release-candidate audit. LOOP-01
still requires a 24-hour real-client soak before its release acceptance can be
claimed. LOOP-02 meets fixture acceptance, while its release claim still
requires a fresh trusted Codex prompt and Claude-equivalent live proof. LOOP-03
meets its adversarial fixture acceptance, but remains release-pending until a
fresh, fully restarted Codex Desktop and a real Claude Code process each produce
a v2 challenge proof within the 24-hour window.

## 3. Implementation Principles

1. **Truth before display.** Build canonical gate and evidence state before
   changing Observatory presentation.
2. **No self-certification.** A producer cannot certify its own artifact without
   strict parsing, hashing, freshness, and an independent verifier.
3. **Source truth is append-only by default.** Derived indexes may be rebuilt;
   task, trace, source, and reviewed-memory truth may be changed only by an
   explicit evidence-backed lifecycle action.
4. **Fail closed on missing authority.** Missing context, missing direct tools,
   stale proof, malformed state, or unresolved risk cannot become a warning-only
   green path.
5. **Bound every hot path.** Prompt, retrieval, graph, health, and Observatory
   refreshes must use indexed top-K or bounded windows rather than full-vault
   scans.
6. **Separate memory temperatures.** Hot reviewed behavior and project context,
   warm source-backed knowledge, and cold operational history have different
   retention and retrieval budgets.
7. **Migrations are reversible.** Every data rewrite starts with a manifest and
   dry run, records before/after hashes, and has a tested rollback.
8. **One status vocabulary.** `PASS`, `FAIL`, `BLOCKED`, and justified
   `NOT_APPLICABLE` are the only completion statuses. Product warnings remain
   visible but cannot be silently translated to `PASS`.

## 4. Dependency Order

```text
Foundation: evidence + schema + atomic I/O + version authority
  |-- Runtime loop: prompt eligibility + fail-closed + direct MCP + task closure
  |     `-- Memory lifecycle: review pressure + correction + compounding
  |           `-- Retrieval/provenance/evaluation at scale
  |-- Safety: unified classification + scoped sync + encrypted restore
  `-- Read model: health + graph + Observatory generation parity

All product gates
  -> transactional installer and clean-machine equivalence
  -> immutable release candidate
  -> three-run concurrency and full completion audit
  -> COMPLETE or exact mechanical failure report
```

Foundation work is mandatory first. Runtime, safety, and read-model work may
then proceed in parallel, but installer/release certification starts only after
all current-vault product gates are green.

## 5. Work Packages

### Phase 0 - Trustworthy Evidence Foundation (P0, 3-5 engineer-days)

#### FND-01: Canonical gate registry and completion audit runner

**Hard gates:** all, especially HG-08, HG-10, HG-12

**Implement:**

- add one typed registry for the twelve gates, required commands, artifact
  schemas, freshness windows, and automatic disqualifiers;
- add `run-completion-audit` orchestration that allocates one UUID audit run,
  captures app/data refs before execution, runs commands without shell-string
  ambiguity, and records exact exit codes and times;
- write the three normative files under
  `.dino/audits/completion/<audit_run_id>/`;
- make the verdict evaluator consume only the captured ledger and manifest;
- represent external evidence such as clean-machine and Claude proof as signed
  or hash-bound imports, never free-text reviewer assertions.

**Primary code surfaces:** proposed `src/completion-audit.ts`,
`src/completion-evidence.ts`, `src/gate-registry.ts`,
`scripts/run-completion-audit.mjs`, `package.json`.

**Acceptance:**

- a known failing fixture creates a parseable evidence pack with `FAIL` and the
  exact predicate;
- killing the runner mid-command leaves no final verdict and no partially
  published manifest;
- editing a captured artifact after the run causes hash verification to fail;
- an old live proof, missing command, skipped command, or unknown status cannot
  produce `COMPLETE`.

#### FND-02: Atomic persistence and generation identity

**Hard gates:** HG-03, HG-08, HG-10

**Implement:**

- migrate all production JSON/status writers from direct `writeFile` to the
  existing atomic-write primitive or a single replacement abstraction;
- add generation id, schema version, producer command, source watermark, and
  generated time to every derived status/index artifact;
- publish multi-file generations through a staging directory plus final atomic
  pointer/manifest switch;
- use one lock order and bounded retry policy for JSONL, SQLite, indexes, and
  status publication;
- add strict UTF-8, JSON/JSONL, SQLite, bare-CR, and mixed-generation readers.

**Primary code surfaces:** `src/concurrency.ts`, all `src/build-*.ts` writers,
`src/refresh-status-artifacts.ts`, `src/sqlite-shards.ts`,
`src/operations-index.ts`, `scripts/dinobrain-user-prompt-hook.mjs`.

**Acceptance:**

- fault injection at every write/rename boundary never exposes partial JSON or
  mixed-generation state;
- readers reject stale or generation-mismatched artifacts;
- 24-process overlap of task writes, trace writes, JSON rebuild, and SQLite
  rebuild has zero lost records, duplicate IDs, leaked locks, or `SQLITE_BUSY`;
- the test passes three consecutive runs.

#### FND-03: Single version and release identity

**Hard gates:** HG-11, HG-12

**Implement:**

- declare one source of truth for package, OS contract, installer, and protocol
  versions;
- generate TypeScript, PowerShell, and release metadata from that source;
- fail build and installer verification when generated files drift;
- bind data-contract version separately but include it in release identity.

**Acceptance:** package, preflight `os_version`, installer UI, release manifest,
tag expectation, and evidence pack report the same release identity.

### Phase 1 - Runtime Loop Integrity (P0, 5-8 engineer-days)

#### LOOP-01: Prompt eligibility, deduplication, and one durable task

**Hard gates:** HG-01, HG-03, HG-06

**Implement:**

- classify hook launches as user-interactive, internal Codex service work,
  ambient suggestion, title generation, diagnostic probe, or unknown;
- create durable tasks only for eligible user work; keep bounded diagnostics for
  internal surfaces without feeding them into long-term memory;
- deduplicate by hook run id plus prompt hash plus client session identity;
- add task lease/heartbeat and explicit terminal ownership so one prompt cannot
  leave multiple active tasks;
- keep prompt previews redacted and bounded; never persist raw full transcripts.

**Primary code surfaces:** `scripts/dinobrain-user-prompt-hook.mjs`,
`src/index.ts`, `src/ids.ts`, `src/task-lifecycle.ts`.

**Acceptance:** real Codex prompts create exactly one task; title/ambient/internal
jobs create zero durable tasks; duplicate hook execution is idempotent; a hook
timeout produces a visible constrained state rather than silent continuation.

#### LOOP-02: Independent pre-response gate and fail-closed action policy

**Hard gates:** HG-01, HG-02, HG-09

**Implement:**

- derive context presence, tool presence, trace freshness, sensitivity, and sync
  risk from OS-observed state rather than caller self-report;
- map each risk to `allow`, `constrained_action`, or `block` with a reason code;
- prove event ordering from hook receipt through context injection and model
  availability;
- distinguish safe sensitive assistance from operations that would persist or
  sync sensitive material.

**Acceptance:** forged context, missing trace, missing required tool, stale proof,
destructive path, and blocked sync all fail closed in live and fixture tests.

#### LOOP-03: Direct Codex and Claude MCP parity proof

**Hard gates:** HG-01, HG-02, HG-11

**Implement:**

- define a proof schema containing client identity, executable/version, exact
  one-name discovery, invocation results, timestamps, nonce, and artifact hash;
- make each real client invoke `os_begin_task`, `get_context_pack`,
  `wiki_search`, `search_memory`, and `finish_task` directly;
- expire proofs after 24 hours and reject config-only, list-tools-only, renamed,
  fallback-server, and self-authored proof;
- allow local `NOT_APPLICABLE` for an absent client, but never release-level
  completion without a clean machine proving both clients.

**Acceptance:** `status:mcp-direct` reports both clients verified from fresh
proofs, and removing one tool or replaying a stale proof fails the gate.

**Implementation evidence (2026-07-11):** v2 proof challenges are one-use and
machine-local-key authenticated. The MCP server records result hashes and a
hash-chained receipt for all five canonical tool names, verifies one task binding
and call order, captures MCP `clientInfo`, and requires Codex/Claude to be the
server's direct parent process. Regression tests reject legacy/self-authored
JSON, missing `get_context_pack`, process spoofing, challenge replay, stale proof,
foreign local identity, and receipt/proof tampering. Installer-generated Codex
and Claude proof launchers issue the challenge and wait for the real client;
fresh live proofs remain pending and are not replaced by fixtures.
See `docs/DIRECT_MCP_PROOF.md` for the artifact contract and trust boundary.

#### LOOP-04: Task debt settlement and prevention

**Hard gates:** HG-03, HG-10

**Implement:**

- retain the original 543-task/196-blocker/18-auto-close audit as a frozen
  historical baseline, then recompute the live vault before every apply;
- apply only current deterministic actions with per-file before/after hashes,
  exact local backup, a Git recovery ref, and a hash-chained migration ledger;
- distinguish a missing trace from a missing task-to-trace binding, bind an
  existing grounded trace without rewriting it, and reconstruct a trace only
  when no task-matched trace exists;
- mark evidence-free stale tasks abandoned/blocked, never completed;
- record an immutable migration ledger for every changed source task or trace;
- enforce new invariants at write time so the backlog cannot recur.

**Acceptance:** zero stale active tasks, zero terminal tasks missing traces, zero
orphan/mismatched traces, zero ungrounded finishes, and no new blocker after a
24-hour real-client soak.

**Execution evidence (2026-07-10):** the live baseline was 548 tasks, 271
traces, and 199 blockers. A 199-action migration reached zero blockers, an
actual rollback restored 199 files and removed 177 generated traces with zero
conflicts, and a second migration reapplied the same classification to a
verified state. SQLite, graph, full-memory, Observatory, and public-data checks
passed after rebuild. See `docs/TASK_LIFECYCLE_MIGRATION.md`. The 24-hour
real-client soak remains pending, so LOOP-04 is not yet fully certified.

### Phase 2 - Memory Lifecycle And Knowledge Compounding (P0/P1, 5-8 engineer-days)

#### MEM-01: Full node lifecycle state machine

**Hard gates:** HG-05, HG-06, HG-07

**Implement:**

- use explicit states: candidate, review, accepted, held, quarantined, demoted,
  archived, deletion-proposed, deleted-tombstone;
- store lifecycle reason, actor, evidence, predecessor/successor, and timestamps;
- block accepted retrieval when review/provenance requirements are not met;
- score duplicate pressure, contradiction, unsupported claims, low use, age,
  sensitivity, and overly broad behavior rules;
- keep deletion reversible through tombstones and backup retention.

**Acceptance:** every accepted record has a valid review path and lifecycle
history; every transition is idempotent and verifier-readable.

#### MEM-02: Review queue backpressure and cold partitioning

**Hard gates:** HG-04, HG-06

**Implement:**

- apply the 214 deterministic auto-compounded holds after a dry-run review;
- cluster the remaining 790 manual items by semantic identity, source session,
  contradiction set, and behavior scope;
- merge exact/near duplicates before human review and preserve provenance from
  every merged candidate;
- establish queue budgets and SLAs by lane; when debt exceeds budget, pause
  growth or route new material to cold hold rather than expanding the hot index;
- archive cold tasks, traces, packs, reports, and obsolete rules into indexed
  time partitions excluded from normal prompt retrieval.

**Acceptance:** no unclassified review debt; hot retrieval excludes held/cold
records; queue growth is bounded under a 1,000-session simulation.

#### MEM-03: Correction writeback and behavior lift

**Hard gates:** HG-07

**Implement:**

- repair the current stale behavior-recall evidence reference through a
  traceable migration, not a silent path edit;
- detect explicit user correction, create a candidate, link the contradicted
  rule, and require review before durable promotion;
- demote or hold superseded behavior after promotion;
- record performed/skipped/not-applicable outcomes for completion, handoff,
  error, direction change, and correction triggers;
- add a real correction scenario proving later retrieval and changed action.

**Acceptance:** at least one end-to-end correction has source prompt metadata,
review, conflict resolution, later retrieval, and improved behavior evidence;
all trigger classes are represented without synthetic status inflation.

#### MEM-04: Controlled compounding

**Hard gates:** HG-06, HG-07

**Implement:**

- separate generated proposals from independently reviewed knowledge;
- require recurrence, confidence, scope, provenance, and contradiction checks
  before promotion;
- cap generated behavior rules per session and per topic;
- periodically merge, demote, archive, or hold low-value rules using observed
  retrieval/use data.

**Acceptance:** repeated useful corrections increase retrieval and behavior
quality while broad-rule count and prompt-token cost remain bounded.

### Phase 3 - Retrieval, Provenance, And Evaluation At Scale (P1, 6-10 engineer-days)

#### RAG-01: Contextual chunk and hybrid retrieval contract

**Hard gates:** HG-04, HG-05

**Implement:**

- persist bounded chunk context, source hash, parent record, language, lifecycle,
  and verification status with each sparse and dense row;
- preserve exact alias/rare lexical priority while using semantic dense top-K as
  an independent signal;
- expose BM25, dense cosine, RRF, rerank, provenance, lifecycle, type budget,
  recency, and noise contributions per result;
- enforce lane budgets so operational records cannot swamp Wiki, Source,
  Project, accepted behavior, or correction results;
- make provider/model/dimension changes trigger a controlled vector migration.

**Acceptance:** paraphrase and bilingual cases use real dense retrieval; exact
rare aliases remain stable; fallback is honestly labeled and cannot pass HG-04.

#### RAG-02: Transactional source/chunk/claim lineage

**Hard gates:** HG-05, HG-10

**Implement:**

- make source fetch/verification, chunk publication, provenance links, and claim
  support one recoverable transaction;
- distinguish URL anchor, fetched source, verified chunk, claim support, and
  behavior guidance in storage and Context Packs;
- reverify changed external sources by content hash and verification date;
- scan Wiki, Projects, and accepted memory for factual claims, not only existing
  claim records;
- reject dangling, anchor-only, internal-trace-only, or stale support.

**Acceptance:** zero unsupported factual claims and zero dangling links on the
current vault; interruption cannot publish half a lineage generation.

#### RAG-03: Explicit golden sets and independent answer evaluation

**Hard gates:** HG-04, HG-07

**Implement:**

- replace behavior-golden fallback with versioned retrieval and answer-quality
  golden sets covering Korean/English, paraphrase, rare exact, negative,
  provenance, quarantine, recency, correction, and noisy-growth cases;
- compare memory-on/off generated behavior, not retrieval overlap alone;
- calibrate the local deterministic judge against Ragas or an independent LLM
  judge on a sampled subset and record disagreement;
- add forbidden-memory and current-instruction-over-memory adversarial cases.

**Acceptance:** memory-on wins by predefined minimum margins without reducing
forbidden-memory avoidance; judge disagreement remains below a declared bound.

#### RAG-04: 50k scale and latency proof

**Hard gates:** HG-04, HG-08, HG-10

**Implement:**

- build a deterministic 50k-record corpus with realistic type and age skew;
- benchmark cold build, warm prompt, wiki search, recent task lookup,
  incremental write, graph refresh, and Observatory polling;
- store p50/p95/p99, memory, CPU, candidate counts, and index sizes;
- fail on unbounded scan regressions or latency-budget breaches.

**Acceptance:** all latency targets in HG-04 pass on declared reference hardware
and the report is bound to code, data generator, and environment hashes.

### Phase 4 - Privacy, Scoped Sync, Backup, And Recovery (P1, 4-7 engineer-days)

#### SAFE-01: Unified classification engine

**Hard gates:** HG-09

**Implement:**

- replace separate path rules with one versioned classifier used by public-data
  checks, `git_sync`, `auto_sync`, and data Git hooks;
- require explicit allowlist classification for every pushed path;
- scan decoded content, file type, size, path, Git history, secret patterns,
  machine-local markers, raw conversation indicators, attachments, and review
  status;
- make large or undecodable files blocking until a suitable scanner handles
  them; never treat partial scans as safe.

**Acceptance:** the same file receives the same decision in every surface;
history-injected secrets and raw transcripts are blocked before commit/push.

#### SAFE-02: Task-scoped automatic sync

**Hard gates:** HG-07, HG-09, HG-12

**Implement:**

- derive the candidate commit set from the active task trace and approved
  lifecycle actions, not the whole dirty repository;
- require a nonempty allowlist, completed sensitivity scan, reviewed state, and
  no conditional/blocked path;
- commit with task/evidence identity and push only when app/data ref policy is
  satisfied;
- surface no-op, blocked, committed, pushed, and retry states distinctly.

**Acceptance:** one real safe task produces a scoped commit and remote push;
neighboring dirty backlog remains untouched; injected sensitive data blocks it.

#### SAFE-03: Encrypted local-only backup and restore

**Hard gates:** HG-09, HG-11

**Implement:**

- define backup inventory for local-only conversations, attachments, private
  configuration, keys metadata, and excluded memory;
- use authenticated encryption with recovery-key handling outside the public
  repository;
- record hashes and restore mapping without storing secrets in evidence;
- run destructive restore drills only in an isolated test profile/machine.

**Acceptance:** GitHub clone plus encrypted restore reproduces reviewed behavior
and required local-only state; wrong key, truncated archive, and stale backup
fail visibly.

### Phase 5 - Coherent Health, Graph, And Observatory (P1, 3-6 engineer-days)

#### OBS-01: One readiness read model

**Hard gates:** HG-08, HG-12

**Implement:**

- build CLI, API, health rollup, graph, and Observatory from the same immutable
  generation manifest and gate registry;
- include gate status, reason code, proof path, freshness, generation id, and
  next safe action;
- block green rendering when mandatory evidence is warning, stale, malformed,
  missing, or generation-mismatched;
- cache bounded indexed views and avoid full-vault work on polling.

**Acceptance:** injected blocker/staleness appears identically in CLI, API, and
UI; parity verifier compares structured values rather than screenshots alone.

#### OBS-02: Evidence-bearing knowledge graph

**Hard gates:** HG-05, HG-06, HG-08

**Implement:**

- add typed edges for source-to-chunk, chunk-to-claim, correction-to-rule,
  candidate-to-review, predecessor-to-successor, context-provided,
  memory-declared-used, memory-observed-used, task-to-trace, and sync-to-commit;
- use stable node identity and incremental graph updates;
- expose lifecycle and provenance filters, not decorative layout alone;
- show active, stale, blocked, reviewer pending, verifier pending, and main
  pending lanes with exact evidence links.

**Acceptance:** selecting any used memory can trace to its source/review and the
task that consumed it; graph counts equal current index/status counts.

### Phase 6 - Installer, Clean-Machine Equivalence, And Release (P2, 6-10 engineer-days)

#### DIST-01: Transactional installer/update/uninstall

**Hard gates:** HG-01, HG-02, HG-09, HG-11

**Implement:**

- resolve intended immutable app/data refs before mutation and show them in the
  installer result;
- stage clone/update/build/config changes, verify them, then atomically promote;
- back up Codex/Claude config and normalize/validate TOML/JSON bytes before and
  after writes;
- merge hooks idempotently, guide trust approval, restart stale clients when
  safe, and prove a fresh live prompt;
- roll back every staged mutation on failure;
- separate normal uninstall from explicit data/private-backup purge.

**Acceptance:** clean install, reinstall, update, induced mid-install failure,
rollback, uninstall, and purge all pass without manual file repair.

#### DIST-02: Clean-machine recovery matrix

**Hard gates:** HG-01, HG-02, HG-09, HG-11

**Test matrix:**

- clean Windows profile with both Codex and Claude Code;
- Codex-only local diagnostic case;
- existing install update with dirty user config;
- Git missing/degraded fallback, which must not count as full equivalence;
- interrupted network/build/config write;
- new machine restored from GitHub plus encrypted local-only backup.

**Acceptance:** the both-client machine reproduces direct MCP, live pre-response,
reviewed memory policy, semantic retrieval, behavior correction, Observatory,
and scoped sync evidence from immutable refs.

#### REL-01: Immutable release parity

**Hard gates:** HG-11, HG-12

**Implement:**

- freeze app/data release commits after product gates pass;
- build installer/ZIP from the frozen app ref and record SHA-256;
- create tag and GitHub release only after local artifact verification;
- fetch the uploaded asset again and verify checksum and embedded version;
- bind app commit, data commit, versions, tag, ZIP, EXE, checksums, and remote
  URLs into the completion audit run.

**Acceptance:** no tag, asset, version, commit, or checksum drift; data HEAD is
pushed; dirty state is empty or explicitly excluded from the claim.

### Phase 7 - Final Certification (P0 release gate, 2-4 engineer-days)

#### CERT-01: Release-candidate audit

1. Freeze code and data refs.
2. Run the normative command table through the completion audit runner.
3. Run the 24-client concurrency verifier three consecutive times.
4. Import fresh Codex and Claude live proofs from the clean machine.
5. Import encrypted backup/restore and release-asset verification evidence.
6. Rehash every artifact after all commands finish.
7. Evaluate all twelve gates mechanically.
8. Publish either `COMPLETE` or the exact non-passing predicates. Never edit the
   verdict by hand.

**Acceptance:** one audit run contains no warning, degraded, pending, unknown,
stale, malformed, mixed-generation, or unresolved blocker state.

## 6. Gate-To-Work Mapping

| Hard gate | Primary work packages | Final proof |
| --- | --- | --- |
| HG-01 | LOOP-01, LOOP-02, LOOP-03, DIST-01 | fresh Codex and Claude live ordered events |
| HG-02 | LOOP-02, LOOP-03 | both-client direct tool invocation and native authority |
| HG-03 | LOOP-01, LOOP-04, FND-02 | zero lifecycle blockers plus memory-use audits |
| HG-04 | MEM-02, RAG-01, RAG-03, RAG-04 | current-vault and 50k retrieval/answer reports |
| HG-05 | MEM-01, RAG-01, RAG-02 | zero unsupported/dangling factual claims |
| HG-06 | MEM-01, MEM-02, MEM-04 | bounded classified queues and lifecycle pressure |
| HG-07 | MEM-03, MEM-04, RAG-03 | real correction recall and behavior lift |
| HG-08 | FND-01, FND-02, OBS-01, OBS-02 | CLI/API/UI/generation parity |
| HG-09 | SAFE-01, SAFE-02, SAFE-03 | full-history safety, scoped push, encrypted restore |
| HG-10 | FND-01, FND-02, LOOP-04, RAG-04 | manifest integrity and three concurrency passes |
| HG-11 | FND-03, SAFE-03, DIST-01, DIST-02 | transactional clean-machine equivalence |
| HG-12 | FND-01, FND-03, REL-01, CERT-01 | immutable remote/release/evidence parity |

## 7. Delivery Sequence

The recommended merge sequence is deliberately smaller than the phases above:

1. **PR 1 - Evidence and identity:** FND-01 plus FND-03. Introduce the gate
   registry and a failing-but-truthful completion audit before product changes.
2. **PR 2 - Atomic generation:** FND-02 and concurrency fault injection. Do not
   migrate data yet.
3. **PR 3 - Prompt/task prevention:** LOOP-01 and LOOP-02. Stop producing new
   lifecycle debt before cleaning old debt.
4. **PR 4 - Lifecycle migration:** LOOP-04 with dry-run manifest, backup, apply,
   rebuild, and rollback proof.
5. **PR 5 - Direct clients:** LOOP-03, including a real Claude-capable machine.
6. **PR 6 - Review and correction:** MEM-01 through MEM-04; settle safe holds,
   cluster manual work, and prove one correction loop.
7. **PR 7 - Provenance transaction:** RAG-02 and current-vault claim scan.
8. **PR 8 - Retrieval/eval/scale:** RAG-01, RAG-03, RAG-04.
9. **PR 9 - Safety and restore:** SAFE-01 through SAFE-03.
10. **PR 10 - Read model and Observatory:** OBS-01 and OBS-02.
11. **PR 11 - Installer and clean machine:** DIST-01 and DIST-02.
12. **PR 12 - Release certification:** REL-01 and CERT-01.

Each PR must be independently rollback-safe. No PR may change a historical
record merely to make a gate green.

## 8. Data Migration Protocol

Every migration against `dinobrain-data` follows this sequence:

1. record app/data HEADs, dirty-state classification, and a full-memory manifest;
2. create an encrypted/local backup and a separate Git recovery ref;
3. run migration in dry-run mode and emit proposed actions with reason codes;
4. sample deterministic, edge, and high-risk actions before apply;
5. apply through atomic writes with before/after hashes and migration id;
6. rebuild derived JSON, SQLite, graph, and status artifacts;
7. run full audit, lifecycle, provenance, retrieval, and safety verifiers;
8. compare counts and invariant deltas against the dry run;
9. commit only classified, reviewed, non-sensitive migration artifacts;
10. rollback automatically if parsing, invariants, or verifiers fail.

For the current backlog, do not bulk-mark 1,004 open items accepted or rejected.
Apply the 214 deterministic holds first, then cluster and review the remaining
manual work while preserving original candidate and source-session lineage.

## 9. Test Strategy

| Layer | Purpose | Minimum requirement |
| --- | --- | --- |
| Unit/property | IDs, classifiers, lifecycle transitions, gate predicates, hashes | deterministic and adversarial cases |
| Fault injection | crash between write/fsync/rename/manifest switch | no partial or false-green state |
| Fixture integration | known healthy and failing repositories | every failure predicate exercised |
| Current vault | prove real data, not scaffolding | all mandatory current-vault artifacts fresh |
| Scale | 50k curated records and 1,000-session growth | HG-04 latency and bounded-work targets |
| Concurrency | 24 independent MCP processes plus rebuilds | zero loss/duplicates/locks, three runs |
| Live clients | Codex and Claude direct invocation | fresh proof from real client surfaces |
| Clean machine | install/update/rollback/uninstall/recovery | immutable-ref equivalence |
| Release | downloaded GitHub assets | checksum/version/commit parity |

## 10. Definition Of Done For Every Work Package

A work package is done only when all are present:

- implementation and schema migration;
- regression tests for healthy, malformed, stale, adversarial, and interrupted
  cases;
- current-vault report produced after the implementation build;
- Observatory/health visibility when the state is user-relevant;
- documented rollback or recovery path;
- no raw transcript, secret, or unrelated dirty path captured;
- exact mapping to at least one hard-gate predicate;
- `npm run check` and relevant targeted verifiers passing;
- no completion claim based solely on fixture or self-reported status.

## 11. Stop-The-Line Rules

Stop implementation or release progression when any of the following occurs:

- source task/trace/accepted-memory truth would be overwritten without a
  reversible evidence-backed migration;
- a parser, hash, SQLite integrity check, or generation check fails;
- a new code path performs full-vault work on prompt or Observatory polling;
- a direct MCP proof can be generated without the named real client;
- a queue cleanup discards provenance or silently promotes generated memory;
- a sync path includes a conditional, blocked, local-only, or unscanned file;
- an installer mutation cannot be rolled back;
- a release artifact is built from a ref different from the recorded ref;
- a green UI disagrees with the canonical gate registry.

## 12. Estimated Effort And Critical Path

Estimated single-engineer effort is 34-58 engineer-days, excluding waiting for
external reviewer availability and long soak periods.

| Phase | Estimate | Critical-path note |
| --- | ---: | --- |
| Phase 0 foundation | 3-5 days | must finish first |
| Phase 1 runtime loop | 5-8 days | stops new data debt |
| Phase 2 memory lifecycle | 5-8 days | includes backlog migration |
| Phase 3 RAG/provenance/scale | 6-10 days | requires stable lifecycle/index contracts |
| Phase 4 safety/backup | 4-7 days | may parallelize after Phase 0 |
| Phase 5 Observatory | 3-6 days | starts after canonical read model exists |
| Phase 6 installer/release | 6-10 days | requires all product gates |
| Phase 7 certification | 2-4 days | includes clean-machine and three-run proof |

The fastest safe path is not to chase the current six `verify:goal` blockers in
isolation. The critical path is:

```text
completion evidence foundation
-> stop task/review pollution
-> settle lifecycle debt
-> prove direct clients and correction behavior
-> prove retrieval/provenance at scale
-> prove scoped sync and encrypted recovery
-> clean-machine installer and immutable release
-> mechanical completion audit
```

## 13. Immediate Next Sprint

The next implementation sprint should contain only these items:

1. FND-01 canonical gate registry and evidence-pack writer;
2. FND-03 single version authority to resolve `2.2.9` versus `2.2.1`;
3. FND-02 atomic migration of completion/status writers plus fault tests;
4. LOOP-01 prompt eligibility rules that stop internal Codex jobs creating
   durable tasks;
5. a dry-run lifecycle/backlog migration report, with no bulk apply yet.

Sprint exit requires a truthful completion audit that still reports
`NOT_COMPLETE`, but does so from one parseable, hash-bound audit run and no
longer creates new lifecycle pollution during normal Codex use. That foundation
makes every later green result credible.
