# Task Lifecycle Migration And Recovery

## Purpose

LOOP-04 repairs historical task and trace debt without rewriting source history
blindly. Every real apply is a serialized, hash-bound migration with exact local
backups, an append-only hash-chained ledger, a Git recovery ref, post-migration
invariant checks, and conflict-aware rollback.

## Safety Contract

An apply must complete this sequence:

1. Rebuild the live task lifecycle report and classify every blocker.
2. Capture the data HEAD, dirty-state hash/counts, app HEAD, and full-memory
   manifest hash.
3. Create `refs/dinobrain-recovery/task-lifecycle/<migration-id>`.
4. Back up every existing task or trace used by the migration as exact bytes
   under the local-only `.dino/tmp/task-lifecycle-migrations/<migration-id>`.
5. Recheck source hashes immediately before each mutation.
6. Write every task/trace atomically under the shared task lifecycle lock.
7. Record immutable ledger entries under
   `.dino/migrations/task-lifecycle/<migration-id>/ledger`.
8. Require zero stale active tasks, missing/bad trace bindings, orphan traces,
   task/trace mismatches, and ungrounded finishes.
9. Roll back automatically on any apply or post-audit failure.

Rollback restores existing files byte-for-byte and removes traces created by
the migration. It refuses to overwrite a path whose current hash is neither
the recorded before hash, the recorded after hash, nor a file carrying that
migration's marker. This protects writes made by another process.

Terminal `finish_task` writes use the same lock and a local prepared journal.
The trace is written before the terminal task pointer. An interrupted pair is
restored to its before hashes before another terminal write can proceed.

## Classification Rules

- Non-user title, diagnostic, ambient, and internal service tasks are closed as
  `blocked`, never as completed.
- Stale user tasks without terminal evidence are recorded as
  blocked/abandoned with a reconstructed blocked trace.
- A stale started task may inherit an outcome only from an existing grounded
  task-matched trace.
- A terminal task with an existing grounded trace but a missing `trace_path`
  is bound to that trace without changing any trace byte.
- A blocked terminal task receives a reconstructed trace only when no existing
  task-matched trace is present.

## Commands

```powershell
npm run task:lifecycle:settle
npm run task:lifecycle:settle -- --apply
npm run task:lifecycle:settle -- --rollback <migration-id>
npm run task:lifecycle:settle:verify
```

The first command is a dry run. A second apply with no remaining targets is
idempotent and does not create another migration directory.

## Current Vault Evidence

The frozen pre-migration snapshot for the verified apply was:

| Metric | Before | After |
| --- | ---: | ---: |
| tasks | 548 | 548 |
| traces | 271 | 448 |
| active recent tasks | 70 | 70 |
| stale active | 195 | 0 |
| terminal trace missing | 3 | 0 |
| trace binding missing | 1 | 0 |
| blockers | 199 | 0 |
| auto-close candidates | 121 | 0 |
| manual repair required | 78 | 0 |

Action composition was 121 non-user blocked closures, 53 stale user tasks
blocked without completion evidence, 21 started tasks repaired from grounded
traces, 3 blocked trace reconstructions, and 1 existing-trace binding repair.

The first real migration
`task-lifecycle-20260710163754361-8435a30b-28a7-4557-bc82-b6d63767008a`
was applied and then rolled back with 199 files restored, 177 generated traces
removed, and zero conflicts. The current verified migration is
`task-lifecycle-20260710163835992-70e0c13b-b0d9-4d9b-ab42-4cbe93feb862` with
402 ledger entries and ledger head
`ab151d1a713922835fd38b0f5f96717252512c2d2b059f2b628bf04cbf28063f`.

After reapply, SQLite contains 548 tasks and 448 traces, graph health is
healthy, the full-memory audit has zero parse errors and zero unclassified
drift, and the public-data scan has zero blockers. Three consecutive
24-process MCP concurrency passes each produced 24 unique tasks, traces, and
Context Packs, 96 indexed events, matching SQLite counts, and zero active-task
debt.

## Remaining Gate

LOOP-04 is not fully certified until a 24-hour real-client soak adds no new
task lifecycle blocker. The implementation, migration, actual rollback, and
current-vault invariant portions are complete; the time-bound soak remains.
