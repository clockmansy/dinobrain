# DinoBrain Memory Node Lifecycle

Status: implemented and migrated for MEM-01 on 2026-07-11.

This document defines the memory-node state machine, accepted-memory gate,
atomic storage contract, migration procedure, and rollback evidence for
DinoBrain OS v2. It does not settle the candidate backlog; that is MEM-02.

## State Contract

Every JSON memory node managed by the lifecycle layer carries:

- `node_id`;
- `lifecycle_version` (`node_lifecycle_v3`);
- `lifecycle_state` and `lifecycle_state_entered_at`;
- `lifecycle_last_transition_id`;
- append-only `lifecycle_history`;
- top-level `predecessor_paths` and `successor_paths`.

Every history entry records a UUID-backed transition ID, idempotency key,
from/to state, reason code, reason, actor, evidence paths, predecessor and
successor paths, and timestamp.

The explicit states are:

| State | Meaning |
| --- | --- |
| `candidate` | Extracted memory awaiting review |
| `review` | Evidence, scope, conflict, and sensitivity review in progress |
| `accepted` | Eligible for hot retrieval after review and provenance gates |
| `held` | Retained but excluded pending evidence or policy resolution |
| `quarantined` | Excluded because of sensitivity, contradiction, or explicit quarantine |
| `demoted` | Previously stronger memory intentionally reduced in authority |
| `archived` | Historical record retained outside active behavior |
| `deletion-proposed` | Reversible deletion awaiting final evidence-backed action |
| `deleted-tombstone` | Content removed from the active record but exact restore metadata retained |

Allowed transitions are encoded in `src/node-lifecycle.ts`. A deleted
tombstone can only return to `deletion-proposed` through the explicit
`tombstone_restored` recovery path.

## Accepted Retrieval Gate

A file under `50_Instances/accepted/` is retrievable only when all of the
following are true:

1. lifecycle history is valid and current state is `accepted`;
2. review status, reviewer, review time, source candidate, and source review
   fields are present;
3. the referenced review record exists, is approved, and binds the candidate
   and accepted target correctly;
4. at least one durable vault source exists;
5. external or factual claims point to a durable source chunk under
   `30_Sources/chunks/` or a provenance record under `.dino/provenance/`;
6. the record is neither sensitive nor quarantined.

`src/context.ts` enforces this gate before Wiki/SQLite indexing and retrieval.
Markdown Wiki records remain directly readable; quarantine for non-JSON nodes
is represented by a lifecycle sidecar under `.dino/lifecycle/nodes/` plus the
normal quarantine record.

## Lifecycle Pressure

The scorer records pressure from duplicate peers, contradictions, unsupported
accepted claims, sensitivity, broad behavior rules, low retrieval count, and
age. It recommends one of `keep`, `merge`, `hold`, `quarantine`, `archive`, or
`deletion-review`. MEM-01 records these classifications but does not bulk-settle
the 1,550-item candidate queue.

## Atomic Storage And Recovery

All multi-record lifecycle writes use one file lock and one prepared journal.
Before publication, exact before/after bytes and SHA-256 hashes are stored under
the local-only `.dino/local-backups/node-lifecycle/` directory. Target files
and immutable transition artifacts are then written with temporary-file plus
atomic rename semantics and verified hashes.

On a write fault, a prepared transaction restores exact original bytes. An
explicit rollback refuses to run if any committed target changed externally.
Deletion writes a tombstone; restore verifies the transition artifact,
transaction journal, exact backup hash, and unchanged tombstone before
recovering the original record.

Local backups are blocked by `git_sync`, `auto_sync`, `.gitignore`, the data
Git hook, public-data scanning, and the full-memory manifest.

## Operator Commands

```powershell
# Build before using the CLI
npm run build

# Read-only classification and health report
npm run memory:lifecycle

# Apply the current accepted-memory migration atomically
npm run memory:lifecycle:apply

# Exact rollback of one committed transaction
npm run memory:lifecycle:rollback -- <transaction-id>

# State-machine, fault, concurrency, migration, and rollback regression suite
npm run memory:lifecycle:verify
```

The MCP tools are:

- `apply_node_lifecycle` for dry-run, apply, and transaction rollback;
- `transition_memory_node` for one verified JSON-node transition;
- `restore_memory_node` for exact tombstone restoration.

## Live Migration Evidence

The 2026-07-11 migration used data HEAD
`7afad5c877c73baf0500e7a980c7eb5e98d7f3bf` as its Git recovery anchor.

Dry-run result:

- 17 legacy accepted records inspected;
- 15 session-derived records classified for accepted repair;
- 2 externally framed RAG records classified `held` for insufficient durable
  external provenance;
- 1,550 candidates explicitly deferred to MEM-02.

First apply and rollback proof:

- transaction `node-lifecycle-1783718406966-1257876e-9f9b-4df7-b4e0-438215f94458`;
- 17 actions applied atomically;
- explicit rollback restored 70 paths;
- all 17 accepted records returned to their exact legacy bytes;
- all 17 migration reviews and generated transition artifacts were removed.

Final reapply:

- transaction `node-lifecycle-1783718425626-fe04ddcd-00fa-43c7-be8f-4c7e0f92dc75`;
- recovery ref
  `refs/dinobrain-recovery/node-lifecycle/node-lifecycle-20260710-212025107-bf61e496-a906-49bc-9448-4f27cc20fa6a`;
- 15 retrievable accepted nodes;
- 2 held/excluded nodes;
- zero lifecycle blockers;
- 36 immutable transition artifacts and 17 migration review attestations.

Post-migration evidence:

- a second dry-run reported zero actions and preserved the last successful
  transaction and recovery ref;
- SQLite hybrid retrieval returned a migrated session memory;
- both held RAG records were absent from candidate and ranked results;
- Source Lineage reported zero blockers;
- Graph Health reported `healthy`, score 100;
- full-memory audit reported zero parse errors and zero unclassified drift;
- status freshness reported healthy and a new atomic status generation was
  published.

## Remaining Boundary

MEM-01 is complete, but the OS completion goal is not. MEM-02 must classify,
merge, hold, or cold-partition the 1,550 candidate/review records without
weakening the accepted-memory gate. Existing client proof, behavior recall,
release parity, and clean-machine evidence also remain separate hard gates.
