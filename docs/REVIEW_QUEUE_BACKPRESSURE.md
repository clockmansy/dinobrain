# Review Queue Backpressure And Cold Partitions

Date: 2026-07-11
Status: MEM-02 implemented and migrated on the current vault

## Purpose

MEM-02 keeps session-derived memory from growing the hot review and retrieval
surfaces without bound. It does not auto-approve memory. It classifies the
queue, collapses duplicates into provenance-complete review units, sends
deterministic or overflow material to cold hold, and keeps old operational
records searchable outside the normal prompt path.

## Review Worklist

`review_worklist_v2` builds deterministic review units from four dimensions:

- semantic identity: exact normalized claim first, then same-kind and
  same-scope token Jaccard similarity at `0.90` or above;
- source session: every source session reference remains attached to the
  member and cluster;
- contradiction set: explicit contradicted record and conflict references are
  retained rather than merged away;
- behavior scope: behavior rules from different scopes do not become one
  near-duplicate cluster.

Every member stores its candidate/review paths, pre-transition SHA-256 values,
evidence paths, source session references, contradiction references, decision
class, type, tags, behavior scope, and semantic identity hash. Existing pending
merge reviews count as review units. Deterministic generated-memory holds are
excluded from the human worklist.

The worklist never approves, rejects, or mutates memory. Its local state is:

```text
.dino/state/review_worklist.json
```

The public-safe aggregate stores counts and hashes only:

```text
60_Operations/review-worklists/
```

## Settlement Transaction

`review:worklist:actions` is dry-run by default. `-- --apply-all` performs only
two mutation classes:

1. deterministic auto-compounded/legacy generated records become `held` and
   `cold`;
2. exact or high-confidence near-duplicate member records become `held`, their
   promotion reviews become `merged`, and one pending merge review is created
   with every member's provenance and source hash.

Low-signal singletons remain manual review work. They are not auto-held merely
because a heuristic assigns low priority.

Before applying, the command verifies every source hash and requires a Git
recovery ref. All candidate, promotion-review, and merge-review writes commit
through one node-lifecycle transaction with exact local backups. Any stale
source hash aborts the whole batch. The transaction can be restored with:

```powershell
npm run review:worklist:actions -- --rollback <transaction-id>
```

Dry runs preserve the last successful transaction id/path, recovery ref, and
apply time in `.dino/state/review_worklist_actions.json`. If an older state
file lacks those fields, the builder recovers them from the latest public-safe
operations summary.

## Queue Budgets

`review_queue_policy_v1` admits one review unit at a time under a serialized
state lock. Candidate, review, admission state, and receipt are one atomic
node-lifecycle batch. Missing, malformed, or unreconciled admission state fails
closed to `cold_hold`.

| Lane | Hot budget | SLA | Overflow |
|---|---:|---:|---|
| correction | 40 | 24 h | cold hold |
| merge review | 160 | 168 h | cold hold |
| manual semantic | 300 | 336 h | cold hold |
| evidence repair | 80 | 168 h | cold hold |
| mapping repair | 40 | 72 h | cold hold |
| deterministic hold | 0 | 0 h | cold hold |

The global hot-review limit is 500 units. A queue with unresolved deterministic
holds, unclassified debt, duplicate clusters, inconsistent admission state, or
an exceeded budget enters `cold_only`. New growth then remains durable but does
not expand the hot review surface.

Artifacts:

```text
.dino/state/review_queue_backpressure.json
.dino/state/review_queue_admission.json
.dino/review-admissions/YYYY-MM/
```

Admission receipts and queue state are local/conditional data, not public Wiki
content.

## Cold Partitions

Cold partitioning is a logical, hash-bound index. Source truth is never moved
or overwritten. This preserves task/trace links and makes rollback exact while
still removing cold paths from ordinary retrieval and recent-operations lists.

Default retention:

| Kind | Retention |
|---|---:|
| completed/blocked task | 90 days |
| trace | 90 days |
| Context Pack | 30 days |
| operational report | 180 days |
| archived/demoted/deletion lifecycle rule | immediate |

Each entry contains the relative source path, kind, `YYYY-MM` partition,
source time, SHA-256, byte size, and reason code. Apply requires a Git recovery
ref and uses the same transactional store. Normal Context Packs, Wiki search,
and recent operations exclude indexed cold paths. `search_cold_memory` is the
explicit metadata-only lookup path.

Artifacts:

```text
.dino/index/cold-partitions.json
.dino/state/cold_partitions.json
60_Operations/cold-partitions/
```

## Verification

```powershell
npm run review:worklist:verify
npm run review:worklist:actions:verify
npm run review:backpressure:verify
npm run cold:partitions:verify
npm run index:verify:operations
npm run index:verify:concurrency
npm run status:freshness:verify
npm run observatory:verify
```

The backpressure verifier runs 1,000 simulated session admissions, 24 parallel
writers, missing-state fail-closed behavior, and injected transaction failure.
The cold-partition verifier covers all five record kinds, hot-retrieval
exclusion, explicit cold search, unchanged source truth, rollback, and fault
recovery.

## Current Vault Evidence

The 2026-07-11 migration was reviewed as a dry-run before mutation:

- 214 deterministic holds;
- 37 duplicate clusters, including 36 exact and 1 near cluster;
- 687 duplicate member records collapsed into 37 merge reviews;
- 104 remaining promotion items plus 42 total pending merge reviews;
- 146 hot review units, below the 500-unit global budget;
- zero deterministic holds pending, zero duplicate clusters pending, zero
  unclassified review debt;
- 1,447 cold candidates and `growth_mode: normal` after reconciliation.

The first 1,839-path apply was rolled back and compared against a pre-apply
manifest. Existence, byte size, and SHA-256 matched for all paths with zero
mismatches. The migration was then reapplied. The final transaction is retained
in the worklist-action state and its public-safe operations summary.

No current task, trace, Context Pack, report, or obsolete accepted rule exceeded
the cold-retention policy, so the live cold index currently has zero entries.
The verifier proves non-empty partition behavior on fixtures without inventing
fake production history.
