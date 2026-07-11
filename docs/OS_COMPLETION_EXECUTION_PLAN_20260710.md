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

- FND-01 now has a typed 12-gate registry, 92 mandatory command instances,
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
  drift from the current authoritative version (`2.2.13` for this release) and
  data contract version `3`.
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
- Full-memory audit now classifies the canonical
  `60_Operations/public-data-safety/` report pair as audit output. Regression
  coverage proves those generated JSON/Markdown reports do not become false
  content drift, while ordinary Wiki changes still fail closed. The post-fix
  current-vault audit covers 12,202 files with zero parse errors and zero
  unclassified drift.
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
  It ran all 61 then-current mandatory command instances, returned
  `NOT_COMPLETE`, and now
  records HG-03 as `PASS`. It predates the qualifying RAG-04 report and must be
  rerun in the final certification phase; the external 50k-scale blocker itself
  is now closed, while release-candidate concurrency/final-generation evidence
  remains open.
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
- The 2026-07-12 verifier hardening sets the live-evidence floor to the later of
  the requested window and the current `dist/index.js` build time, requires the
  authoritative OS version on the task/context/preflight/report chain, and
  selects the newest complete valid proof rather than the first matching event.
  An isolated regression rejects both pre-build and newer wrong-version chains.

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
and Claude proof launchers issue the challenge and wait for the real client.

**Current-machine execution evidence (2026-07-11):** Codex MCP client
`0.144.0-alpha.4` and Claude Code `2.1.207` each completed the five canonical
tool calls through a server instance whose direct parent was the named client.
`status:mcp-direct` reports both agents `verified`, exact single-name discovery,
no missing tools, and `release_parity_verified: true`. Proof SHA-256 values are
`adbdef85d5cd74f51006cbd8a8b741db26a329edcda83ae1dfe5c9d4386a3dab`
for Codex and
`1636160353d5b856d80cc1c7bf6ec0733f6323c724e933aa6cca40d7f7ab7fd3`
for Claude. A fresh post-build Codex prompt also passed the ordered live-hook
verifier with OS version `2.2.13`. LOOP-03 current-machine acceptance is met;
the DIST-02 clean Windows proof remains a separate global completion gate.
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

**Maintenance evidence (2026-07-11):** later verification activity accumulated
29 stale internal/diagnostic tasks and 39 stale tasks without terminal evidence.
Migration `task-lifecycle-20260711130629561-f456b69e-1083-4432-9b51-94b5faef6a2f`
closed the 29 non-user tasks and reconstructed explicit blocked traces for the
39 evidence-free tasks. Its hash-chained ledger has 140 entries and recovery
ref; the post-apply vault has 610 tasks, 564 traces, zero stale active tasks,
zero missing/orphan trace bindings, zero ungrounded finishes, and zero remaining
settlement actions. This does not replace the pending 24-hour real-client soak.

**Maintenance evidence (2026-07-12):** one earlier goal-continuation task later
expired without a terminal trace. Reversible migration
`task-lifecycle-20260711231120984-3fa38ca9-4755-488b-a01f-e9b0d183686a`
preserved a six-entry hash ledger and recovery ref, then recorded the task as
blocked for missing terminal evidence rather than claiming completion. The
post-apply vault has zero stale active tasks, expired leases, missing/orphan
trace bindings, ungrounded finishes, auto-close candidates, or manual repair
requirements. The 24-hour real-client soak remains independently pending.

**Implementation update (2026-07-12):** the 24-hour soak is now a mechanical
external-evidence gate rather than a documentation-only promise.
`soak:lifecycle:begin` binds a clean app ref, unchanged data ref, blocker-free
baseline, machine-local Ed25519 identity, and the baseline task set.
`soak:lifecycle:finalize` cannot run before 24 real hours and requires fresh
server-validated Codex and Claude direct-MCP v2 proofs whose durable tasks were
created inside the window, zero final lifecycle blockers, immutable refs, and a
clean app worktree. It publishes only signed, hash-bound task/trace/proof
metadata under `60_Operations/lifecycle-soak/`; the completion audit validates
the signature and every referenced file hash. The adversarial verifier covers
early finalization, missing Claude, payload tamper, and referenced-proof tamper.
The implementation is complete, but the real 24-hour run remains pending until
its clock has actually elapsed and its evidence is imported.

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

**Execution evidence (2026-07-11):** `node_lifecycle_v3` now enforces all nine
states, append-only evidence-bearing history, accepted review/provenance gates,
pressure scoring, atomic multi-record writes, exact local backups, immutable
transition artifacts, Git recovery refs, tombstones, and tamper-resistant
rollback. The live 17-record accepted set was dry-run, applied, actually rolled
back across 70 paths, and reapplied: 15 records are retrievable, 2 unsupported
external RAG records are held, and lifecycle blockers are zero. A follow-up
dry-run produced zero actions while preserving the last applied transaction and
recovery ref. SQLite retrieval excluded both held records; Source Lineage is
blocker-free; Graph Health is 100; full-memory audit has zero parse errors and
zero unclassified drift. The 1,550 candidate backlog was deliberately left for
MEM-02. See `docs/MEMORY_NODE_LIFECYCLE.md`.

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

**Execution evidence (2026-07-11):** `review_worklist_v2` now clusters by
semantic identity, source session, contradiction set, and behavior scope. The
current vault dry-run found 214 deterministic holds and 37 duplicate clusters
(36 exact, 1 near) covering 687 members. One atomic 1,839-path migration held
the deterministic records, collapsed duplicate members into provenance-complete
merge reviews, and left 104 singleton promotion items plus 42 total merge
reviews: 146 hot units against a 500-unit budget, with zero unclassified debt,
zero pending deterministic holds, and zero duplicate clusters. The transaction
was actually rolled back and all 1,839 paths matched the pre-apply existence,
size, and SHA-256 manifest before final reapply. A serialized admission ledger
now enforces per-lane budgets and fails closed to cold hold; a 1,000-session
simulation admitted 197 hot and routed 803 cold, while a 24-writer race and
injected fault both preserved consistency. Logical monthly cold partitions now
cover tasks, traces, Context Packs, reports, and obsolete rules without moving
source truth; normal context and recent-operation retrieval exclude cold paths,
while `search_cold_memory` provides explicit lookup. The current vault has no
records old enough for partitioning, so its live cold index is truthfully empty.
See `docs/REVIEW_QUEUE_BACKPRESSURE.md`.

**Maintenance evidence (2026-07-11):** 50 subsequently auto-compounded behavior
rules were atomically moved to `hold` with their promotion reviews instead of
being accepted without semantic review. The current queue has 1,661 candidate/
review pairs, 1,494 closed items, 167 explicitly classified manual-review holds,
zero unclassified open items, zero deterministic auto-hold candidates, and zero
open semantic jobs. Manual review debt remains visible and is not counted as
accepted knowledge.

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

**Execution evidence (2026-07-11):** stale recall evidence is now repaired only
through immutable, hash-bound migration records. The live vault dry-run found
exactly two unique task-to-trace repairs and zero unresolved rows; apply made
behavior recall healthy, rollback restored the two original blockers, and
reapply restored healthy status with two validated migrations. The regression
suite now drives a real stdio MCP flow: a task-bound correction candidate links
its contradicted accepted rule before review, approval without an explicit
resolution performs no mutation, and approval with `demote_superseded` commits
the correction plus old-rule demotion in one lifecycle transaction. A later
Context Pack excludes the old rule, retrieves the correction, and changes the
structured action from the memory-off baseline to the reviewed expected action.
Actual MCP `finish_task` calls cover completion, handoff, error, and direction
change; the review flow supplies the correction trigger, with performed,
skipped, and not-applicable decisions all represented. MEM-03 is complete;
global completion remains open for later packages and external gates.

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

**Execution evidence (2026-07-11):** `controlled_compounding_v2` now persists
only rules repeated across at least two independently bound task/trace pairs.
Generated proposals remain outside accepted memory until an independent reviewer
attests scope and the server rechecks confidence, recurrence, prompt/trace
hashes, contradictions, and hot-rule count/topic/token budgets. Context Packs
admit at most three controlled rules, at most two per topic, within a 2,400
character budget. Retrieval/use observations now drive duplicate merge,
invalid/tampered provenance hold, 90-day unused demotion, and 365-day unused
archive actions through rollback-capable lifecycle transactions.

The stdio MCP regression proves singleton suppression, two-task recurrence,
zero-mutation scope rejection, reviewed retrieval, later Context Pack use, and
`+45` memory-on behavior lift. It also proves all four lifecycle actions,
tampered-source quarantine, exact rollback across eight primary paths, exact
reapply across ten paths, per-session and per-topic caps, and Context Pack cost
bounds. On the live vault, a 200-trace dry run created zero proposals: six
eligible signals were singletons and 198 legacy traces lacked verified
task/prompt-hash binding. Apply therefore published only a healthy bounded
status and behavior-rule index; rollback and reapply matched exact hashes.
Seven hundred thirty-five legacy generated candidates are explicitly excluded
from the controlled hot set rather than silently promoted. Observatory now
shows the controlled-compounding hard gate and current counts. MEM-04 is
complete; global completion remains open for RAG-01 and later packages.

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

Implementation evidence (2026-07-11): Wiki index v5 and SQLite shard v5 now
persist the bounded contextual row contract; `30_Sources/private` is excluded
from normal retrieval. Semantic candidates are an independent cosine top-64,
exact aliases and rare lexical terms retain priority, and every result exposes
typed sparse/BM25/dense/RRF/rerank/provenance/lifecycle/type-budget/recency/noise
contributions. Provider/model/dimension/schema changes use a serialized,
hash-verified migration with exact before/after artifacts and rollback/reapply.
`rag:retrieval:verify`, `rag:vector:migration:verify`, Wiki, SQLite, RAG proof,
RAG eval, live semantic, answer-quality, Observatory, generation, and freshness
regressions pass. Current-vault evidence is 79 public curated rows, 384-dimension
MiniLM semantic vectors, 12/12 retrieval cases, 12/12 answer-quality cases, and
an applied v1-to-v2 vector migration. RAG-01 is complete; HG-04 remains open for
RAG-03/RAG-04 external evaluation and declared 50k scale/latency evidence.

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

Implementation evidence (2026-07-11): RAG-02 now publishes source snapshots,
bounded chunks, provenance links, exact claim/evidence hashes, and immutable
generation receipts through one serialized, hash-preconditioned transaction.
Prepared transactions recover to exact prior bytes; explicit rollback/reapply,
external-tamper refusal, changed-content reverification, and 16-writer
idempotency are covered by `source:lineage:transaction:verify`. Wiki index v6,
SQLite shard v6, dense metadata, and Context Packs expose `knowledge_role` so
behavior guidance, accepted memory, source citations, verified claim support,
project context, and operations evidence remain distinct. The current-vault
migration produced 20 fetched snapshots, 20 verified chunks, 20 provenance
links, and 20 generation receipts. The full Wiki/Projects/accepted scan reports
zero unsupported factual claims, dangling links, stale support, hash mismatch,
or blockers. RAG-02 is complete; HG-05 is satisfied by current-vault and
transactional regression evidence.

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

**Implemented evidence (2026-07-11):** RAG-03 is complete for the current-vault
gate. Retrieval uses an explicit 18-case v2 golden and answer behavior uses an
independent 14-case bilingual v2 golden; neither path accepts behavior-golden
fallback. Recent task and judge records are excluded from evaluation retrieval.
The answer generator receives no expected actions, uses only the top reviewed
guidance item, removes blocked guidance sentences, and is bound to a composite
answer/retrieval runtime hash plus the dense-index hash. Seven exact-text
memory-on/off pairs were reviewed blind with randomized arms by three independent
judges. The final calibration has 21 safe votes, zero local/independent
disagreements, and a hash-bound durable review artifact. Current evidence reports
14/14 answer cases, 18/18 retrieval cases, perfect forbidden-memory and
current-instruction compliance, average memory lift 57.545, and p95 answer
evaluation latency 379 ms. `rag:proof:verify`, `eval:rag:verify`, and
`verify:answer-quality` include fallback, task-leakage, held-memory, 1,000-noise,
golden nonce, and tamper regressions.

**Maintenance evidence (2026-07-11):** the improved two-guidance answer
generator changed five sampled answer hashes, so the old three-judge artifact
correctly became stale instead of remaining green. A new reusable calibration
CLI now emits a label-free, deterministically randomized A/B packet and accepts
only packet-hash-bound, complete responses from at least three unique judges.
Ten independent agents reviewed all seven sampled pairs without source, golden,
or arm-label access. The resulting 70-vote artifact has zero unsafe votes, zero
unresolved cases, and zero local/independent disagreements. Current evidence is
14/14 behavior cases, average memory lift 53.259, p95 314 ms, and a healthy
calibration bound to the current evaluator plus the exact judge-visible request,
candidate-answer, safety, and protocol hashes. The dense-index identity remains
visible as audit metadata, but index drift no longer invalidates an independent
judgment when all sampled candidate hashes remain byte-identical. A fresh RAG
rebuild changed the audit index hash while preserving the seven candidate pairs
and decision hash exactly; calibration stayed healthy and exposed both index
match flags as false. A subsequent identical rebuild changed zero of 52 eligible
record vectors or metadata fields. Isolated regression proves label withholding,
atomic review/calibration publication, metadata-drift transparency, and tampered
packet or candidate-hash rejection.

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

**Implemented evidence (2026-07-11):** RAG-04 is complete. The deterministic
`scale_50k_v1` run generated 50,000 curated records with Wiki/Source/Project/
accepted-behavior/Operations/Error-Book and age skew plus 1,000 completed
task/trace/Context-Pack sessions in an isolated temporary vault. The qualifying
report is `.dino/evaluations/scale-50k-status.json`; it is bound to the exact
runtime code, corpus generator, environment, corpus, session growth, and report
payload hashes. On the declared 31.93 GB Windows reference machine, full shard
build was 23.855 s, warm Context Pack p95 410.995 ms, Wiki search p95 141.175 ms,
recent-task p95 20.422 ms, incremental operation write p95 32.458 ms, graph
refresh p95 174.199 ms, and Observatory polling p95 63.085 ms. Dense retrieval
probed 8/100 partitions and at most 4,000/50,000 vectors. The report observed a
1.474 GB in-process RSS peak; an external Windows process monitor observed a
2.252 GB private-memory peak. All assertions, report integrity, and current
code/generator/environment binding checks pass. `scale:50k:verify` covers
determinism, latency failure, report tamper, stale binding, oversized
unpartitioned-dense fail-closed behavior, indexed term/graph plans, payload
budget, and generation-verification reuse. Plan-only completion audit
`completion-20260711-071340132-91c0865a-c204-40c4-b24e-cd2320176799`
imported the report as `scale_50k` with `status=PASS`, zero warnings, and gates
HG-04/HG-08/HG-10; the overall audit correctly remains `NOT_COMPLETE` because
other work packages and mandatory commands were not executed in that run.

**Maintenance evidence (2026-07-11):** the report was regenerated after later
runtime changes so stale code/generator hashes cannot satisfy the gate. The new
qualifying run again covers 50,000 records and 1,000 sessions: cold build
22.109 s, Context Pack p95 480.815 ms, Wiki search p95 125.298 ms, graph refresh
p95 162.800 ms, and process RSS peak 1,726.1 MiB. All assertions and current
binding checks pass with zero verification issues; the scale worker exited and
did not remain as an additional resident process.

**Maintenance evidence (2026-07-12):** after retrieval/index source changes,
the stale code binding was rejected and the qualifying report was regenerated
sequentially. The current run covers 50,000 records and 1,000 sessions: cold
build 23.480 s, Context Pack p95 499.464 ms, Wiki search p95 134.132 ms,
graph refresh p95 180.009 ms, Observatory poll p95 60.829 ms, and process RSS
peak 1,716.5 MiB. All assertions and code/generator/environment bindings pass;
after exit, only the bounded Observatory and Codex MCP processes remained.

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

**Implemented 2026-07-12:** policy `data_classification_20260712_v3` now lives
in `src/data-classification.ts` and is consumed directly by MCP sync plus the
public-data and Git-hook CLI surfaces. Unknown paths, scans disabled by callers,
files over 8 MiB, symlinks/submodules, unsupported/binary files, invalid UTF-8, malformed JSON/JSONL,
secret and machine-local patterns, raw transcript markers, and missing review
lineage fail closed. `npm run safety:classifier:verify` proves cross-surface
parity and catches a token committed and then removed before push;
`npm run hooks:data:verify` proves the installed wrappers use the version-bound
engine. SAFE-01 implementation acceptance passes.

**Applied remediation evidence (2026-07-12):** the reversible public-history
migration now uses an isolated committed snapshot, verified mirror bundle,
per-file before/after hashes, Windows long-path checkout, unified current/staged/
history/pre-push scans, exact SHA confirmations, `force-with-lease`, and tested
remote rollback. After the first sanitized candidate, structural JSON/JSONL
redaction, filename-reference rewriting, canary masking, and executable hook
mode repair produced final root
`ec9a1a5c27b082dba94de4eeecca0fe4a9238854`. The approved force-with-lease
replacement is now the public `origin/main`; a fresh clone and the real local
checkout both pass with 5,057 committed files, zero current/history blockers,
zero warnings, and matching HEAD. Local realignment preserved 28,007 files and
372,849,563 bytes with an unchanged aggregate SHA-256. SAFE-01 acceptance is
met. HG-09 remains `NOT_COMPLETE` until SAFE-03, clean-machine, and final audit
evidence are complete. See
`docs/PUBLIC_DATA_HISTORY_MIGRATION.md`.

#### SAFE-02: Task-scoped automatic sync

**Hard gates:** HG-07, HG-09, HG-12

**Implement:**

- derive the candidate commit set from the active task trace and approved
  lifecycle actions, not the whole dirty repository;
- require a nonempty allowlist, completed sensitivity scan, reviewed state, no
  blocked path, and a durable exact-blob approval receipt for every conditional
  path;
- commit with task/evidence identity and push only when app/data ref policy is
  satisfied;
- surface no-op, blocked, committed, pushed, and retry states distinctly.

**Acceptance:** one real safe task produces a scoped commit and remote push;
neighboring dirty backlog remains untouched; injected sensitive data blocks it.

**Implemented 2026-07-11:** policy `task_sync_scope_20260711_v2` now maintains
one local-only, atomically written scope ledger per task under
`.dino/sync-scopes`. Each entry binds a repository-relative regular file to its
SHA-256, Git-filtered blob id, byte size, producing tool, and lifecycle
approval. Changed content cannot inherit a prior higher approval. `auto_sync` requires
both `task_id` and a nonempty `allowed_paths`; it intersects that request with
the server-maintained scope, rejects pending review, changed bytes, sensitive
content, unclassified paths, and any pre-staged neighboring file, then stages
only the resulting paths. Hook, task, Context Pack, gate, finish, session
import, candidate, and review writers register their own artifacts. Candidate,
review, growth, and compounding outputs remain pending until reviewed, while
system traces use the conditional opt-in policy.

`npm run safety:task-sync:verify` creates an isolated repository and bare
remote. It proves missing/empty allowlists, out-of-scope files, pending review,
post-review tampering, sensitive injection, and unrelated staged files all
block; a reviewed file is the only path committed and pushed; neighboring
dirty backlog survives; a repeated call is `no_op`; and a missing remote yields
`retry_required` with the already-created commit SHA. SAFE-02 implementation
acceptance passes.

**Strengthened 2026-07-12:** conditional commits now include one public
`task_sync_public_receipt_20260712_v1` record. It binds the task and request
hash, task-record bytes, local scope-ledger version/revision/hash, classifier
policy, and every selected artifact's path, SHA-256, Git-filtered blob id, size,
producer, and approval state. Commit trailers bind the receipt path, SHA-256,
and blob id to the resulting commit. Pre-commit independently rechecks the live
scope ledger; pre-push and full-history scans re-read the public receipt and
committed blobs without trusting caller declarations. A repository-wide lock
serializes automatic Git writes. Regressions prove valid conditional push,
missing/forged receipt rejection, task-record enforcement, post-review tamper
rejection, and detached-trailer rejection. The one-time fully scanned root is a
migration baseline; every later conditional commit is receipt-gated.

`os_gate` also accepts an exact task allowlist for publication checks and
derives its observation from the server-owned scope ledger rather than caller
self-report. It revalidates current SHA-256/Git blob/approval/classification,
reports neighboring dirty backlog as out of scope, permits only a clean exact
scope, and rejects unregistered paths. This removes the prior whole-worktree
false block without weakening fail-closed behavior.

**Real remote execution evidence (2026-07-12):** task-scoped `os_gate` selected
five approved conditional artifacts while leaving 7,741 neighboring dirty paths
out of scope. `auto_sync` committed those five artifacts plus their public
receipt and pushed data commit
`b64dd1858818a54604cce42eff8cef4419c4b0ce`. Receipt
`60_Operations/task-sync-receipts/task-sync-receipt-a8fc8479a3939575a5e78c2299219defd676991ab4653bdd106df9d37b4272f2.json`
has file SHA-256
`019c9d59366411cd59dbba6c0c689822b751a7cac355741d13b7b1acaad8b895`
and Git blob `5bd70cac5ede727e50deb387c45558a8c7df31bb`. A fresh clone at that commit
contained 5,063 committed files, zero blockers, zero warnings, and one required
receipt commit independently verified. Local and remote HEAD match and the
neighboring backlog remains unstaged. SAFE-02 acceptance and its real-push
predicate are met.

HG-09/HG-12 remain `NOT_COMPLETE` until the real encrypted restore,
clean-machine equivalence, immutable release parity, and final audit are
independently cleared.

Post-package regressions pass for `check`, `safety:task-sync:verify`, `smoke`,
`flow:audit`, `hook:verify`, `session:verify`, `pre-response:gate:verify`,
`safety:classifier:verify`, `hooks:data:verify`, `verify:v2`,
`verify:compounding`, `verify:codex-loop`, and `completion:audit:verify`.
The later DIST-01 regression pass repaired those three retrieval-noise cases by
making explicit intent lanes primary and globally limiting supplemental records
to two. `eval:context` now passes 20/20 with recall 1.0, maximum noise 2, and
average noise 1.3; `verify:os` is green. Current answer-quality retrieval also
finds all expected memories. The deterministic generator now synthesizes the
top two reviewed guidance records instead of silently using only the first;
all 14 local behavior cases pass, while the changed answer hashes correctly
leave independent judge calibration pending rather than producing a false green.

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

**Implemented 2026-07-11:** archive format `dinobrain_private_backup_v1` now
streams a hashed private inventory through AES-256-GCM with scrypt-derived keys.
The recovery key is generated outside app, vault, and archive roots; public
evidence contains only hashes, counts, algorithm identity, and resource bounds.
Restore decrypts into isolated staging, authenticates the complete archive,
checks source Git identity, age, path scope, symlinks, file limits, and existing
target conflicts, then promotes files without overwrite by default. Explicit
private overwrite creates verified rollback copies and rolls back on failure.

`DinoBrain Private Backup.cmd` and `DinoBrain Private Restore.cmd` are created
in both install and app roots. `npm run backup:private:verify` proves an 8 MiB
streaming round trip, wrong key, truncation, stale archive, source mismatch,
target conflict, key-placement, path-escape, archive-placement, no-overwrite,
CLI, and Git-clone-plus-private-restore scenarios. It writes the hash-only
`.dino/state/encrypted_restore_status.json` completion artifact. SAFE-03
implementation acceptance passes; HG-09/HG-11 remain `NOT_COMPLETE` until a
real encrypted backup is stored with an independently held key and the external
clean-machine recovery evidence is supplied.

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

**Implementation status (2026-07-11): OBS-01 implementation acceptance passed.**

- `readiness_v2` is the sole 12-gate read model for CLI, health rollup,
  Observatory API/UI, graph metadata, and graph-health metadata.
- Every gate exposes status, operational status, completion-audit status,
  reason codes, immutable proof paths, freshness, generation id, and the next
  safe command. A stable structured `parity_hash` detects consumer drift.
- The current completion audit pointer is hash-bound to one immutable status
  generation. Missing, malformed, stale, source-drifted, snapshot-tampered, or
  mixed-generation evidence cannot render green.
- `npm run readiness:verify` proves healthy, warning, missing, stale, malformed,
  mixed-generation, CLI/API/health/graph parity, UI endpoint consumption,
  bounded polling, and a fixture Observatory RSS below 256 MiB.
- Status-generation SQLite copy/hash verification is streaming. A 64 MiB
  regression fixture increased RSS by only about 1.2 MiB under the 96 MiB
  budget.
- Semantic index refresh now embeds at most four bounded inputs per inference
  batch and disposes the ONNX pipeline after refresh. On the current vault this
  reduced peak refresh RSS from 3.38 GiB to 666 MiB and reduced elapsed time
  from 24.5 seconds to 18.3 seconds.

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

**Implementation status (2026-07-11): OBS-02 implementation acceptance passed.**

- `.dino/index/evidence-graph.sqlite` is the canonical contribution-backed
  graph. Stable path/URI/commit identities survive label and incremental data
  changes.
- The graph implements source-to-chunk, chunk-to-claim, correction-to-rule,
  candidate-to-review, predecessor-to-successor, context-provided,
  declared/observed memory-use, task-to-trace, and sync-to-commit relations.
- Active, stale, blocked, reviewer-pending, verifier-pending, and main-pending
  lanes are evidence-derived. Observatory exposes lane, relation, lifecycle,
  provenance, and bounded focus traversal rather than a decorative-only view.
- Count parity compares primary graph nodes with Wiki/operations indexes and
  candidate/review/accepted/source directories. Malformed input or count drift
  makes `.dino/state/evidence_graph_status.json` non-healthy.
- The current vault contains 5,911 sources, 6,438 nodes, and 16,559 edges with
  zero parse or parity blockers. Initial build peak RSS was about 119 MiB; an
  unchanged incremental rebuild completed in about 1.57 seconds.
- Normal refresh reuses metadata-stable contributions. Completion audit forces
  streaming SHA-256 verification of every source. See
  `docs/EVIDENCE_GRAPH.md`.

OBS-02 is complete at implementation/current-vault acceptance. Global
completion remains open for clean-machine, release, and external live-client
gates.

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

**Implementation status (2026-07-11): DIST-01 implementation acceptance
passed locally.** The installer now freezes app/data refs to full SHAs before
mutation, builds and verifies sibling stages, snapshots every managed config
surface, atomically promotes repository/config changes, emits a GUI-consumed
transaction result, and separates normal uninstall from explicit purge. A
per-root file lock blocks concurrent installers. Persistent journals recover an
abrupt interruption even in the rename-before-journal window by restoring
filesystem truth and preserving replaced bytes in a recovery quarantine.
Temporary Codex/Claude config copies are removed on completion or rollback.

`installer:verify:transaction` proves exact rollback, dirty data preservation,
moving-ref freezing, dirty app refusal, abrupt recovery, and lock contention.
`installer:verify:matrix` passed clean install, reinstall, update, an
after-config failure with byte-identical app/data/config/hook rollback, and
normal uninstall; `uninstall:verify` separately covers purge. The measured
installer process-tree peak was 724.7 MiB. HG-01/HG-02/HG-11 remain open for
fresh external Codex/Claude live proof and complete recovery equivalence.

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

**Current status (2026-07-11): NOT COMPLETE.** The local isolated matrix covers
Git-backed clean install, dirty-data reinstall, immutable update, config-stage
failure rollback, and normal uninstall. It does not replace a clean Windows
profile with both real clients, the Codex-only diagnostic, a live no-Git archive
case, interrupted network/build processes, or GitHub plus encrypted local-only
restore on another machine. Those external rows must be imported as fresh
evidence before DIST-02 or HG-11 can pass.

**Implementation update (2026-07-11): the external proof runner and signed
evidence contract are implemented; the real both-client run remains pending.**
`DinoBrain Recovery Equivalence Proof.cmd` now creates one machine-local run,
reuses each client's direct-MCP challenge prompt as its live pre-response proof,
validates matching Context Pack hashes and ordered events, runs reviewed-memory,
semantic retrieval, behavior, Observatory, scoped-sync, and installer fault
checks sequentially, and signs the public-safe result with a local-only Ed25519
key. Completion audit rejects unsigned, self-reported, tampered, foreign-restore,
no-Git degraded, Codex-only, or missing-Claude evidence. The private restore
launcher now writes the required local-only receipt automatically. Local fault
regression covers pre-mutation network failure, staged-build rollback, config
interruption recovery, and no-Git fresh-only degraded behavior. DIST-02 remains
`NOT COMPLETE` until this runner returns `complete` on a clean Windows profile
with both real clients and its scoped evidence is imported.

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

**Implementation update (2026-07-12):** `release_manifest_v2` now resolves the
GitHub repository from `origin`, queries the exact release tag through the
GitHub API, and independently verifies the release target commit plus unique
ZIP/SHA asset names, sizes, and GitHub-provided SHA-256 digests against the local
package. Missing, unreachable, duplicate, stale, or mismatched remote evidence
is blocking, and `verify:goal` requires `github_release_verified=true` rather
than accepting local tag/ZIP evidence alone.

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

The foundation, task prevention, lifecycle, retrieval, safety classifier,
task-scoped real push, read model, and current-machine direct-client proof are
implemented. The next sprint is therefore limited to the remaining global
certification predicates:

1. run and settle the 24-hour real-client lifecycle soak for LOOP-04;
2. create a real encrypted private backup with the recovery key held outside
   the app/data roots, then restore it on the clean profile;
3. execute DIST-02 on a clean Windows profile with both Codex and Claude,
   including install, update, interrupted rollback, uninstall, and purge;
4. import fresh clean-machine live-hook and direct-MCP proofs without editing
   their evidence artifacts;
5. publish immutable release assets from the exact audited app/data refs and
   verify downloaded checksums;
6. rerun the mandatory command set and mechanical completion audit after every
   artifact is final.

Sprint exit is `COMPLETE` only when the final audit has no pending, stale,
warning, degraded, unknown, malformed, mixed-generation, or unresolved state.
Until then, the document must continue to report `NOT_COMPLETE` with the exact
remaining predicates.
