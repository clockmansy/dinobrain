# Evidence-Bearing Knowledge Graph

## Authority

OBS-02 uses two generated artifacts:

- `.dino/index/evidence-graph.sqlite`: canonical node, edge, source, and
  contribution index;
- `.dino/state/evidence_graph_status.json`: count parity, relation support,
  incremental-build, integrity, and memory evidence.

The Observatory reads the SQLite file from the current immutable status
generation. The older Wiki graph remains only as a degraded fallback.

## Stable Identity

File-backed nodes derive their id from the normalized vault path. External
sources derive their id from the normalized URI and Git commits use the commit
SHA. Rebuilding or changing a label does not change node identity.

Every node and edge records an exact `evidence_path`. A focused graph query can
therefore walk from a used memory to the task, Context Pack, trace, audit,
review, candidate, source chunk, and source snapshot that support it.

## Required Relations

The graph contract supports these typed relations:

| Relation | Meaning |
| --- | --- |
| `source_to_chunk` | Durable source snapshot or URI produced a bounded chunk |
| `chunk_to_claim` | Source chunk supports a claim record |
| `correction_to_rule` | Reviewed user correction became a behavior rule |
| `candidate_to_review` | Candidate is bound to its review record |
| `predecessor_to_successor` | Lifecycle predecessor was replaced or promoted |
| `context_provided` | A task received a Context Pack or memory item |
| `memory_declared_used` | A terminal trace or audit declared memory use |
| `memory_observed_used` | Independent audit observed memory use |
| `task_to_trace` | Durable task has its terminal trace |
| `sync_to_commit` | Scoped sync produced a concrete Git commit |

An empty current-vault relation is not fabricated. The contract remains
supported and the status report records whether each relation is observed.

## Operational Lanes

The graph always exposes `active`, `stale`, `blocked`, `reviewer_pending`,
`verifier_pending`, and `main_pending` lane hubs. Nodes link to a lane only when
their persisted state supplies evidence for that classification.

The Observatory provides lane, relation, lifecycle, and provenance filters.
Selecting a node and using `Trace` requests a bounded three-hop evidence view.
The HTTP API supports the same behavior:

```text
/api/graph?focus=<stable-node-id>
/api/graph?lane=reviewer_pending
/api/graph?edge_type=memory_observed_used
/api/graph?lifecycle=accepted&provenance=verified_summary
```

## Incremental And Memory Contract

The builder bulk-clones the previous contribution database and replaces only
changed or removed sources. Normal refresh uses size and mtime to reuse
unchanged sources, hashes changed sources, validates SQLite integrity, and
atomically replaces the index. Completion audit sets
`DINOBRAIN_EVIDENCE_GRAPH_VERIFY_HASHES=1`, which streams SHA-256 over every
source without reparsing unchanged records.

Current-vault evidence on 2026-07-11:

- 5,911 source files;
- 6,438 stable nodes;
- 16,559 edges, including 16,040 non-taxonomy evidence edges;
- zero parse or count-parity failures;
- initial full build peak RSS about 119 MiB;
- unchanged incremental rebuild about 1.57 seconds with about 40 MiB retained
  RSS delta.

These values are evidence for this vault, not fixed product limits.

## Verification

```powershell
npm run graph:evidence
npm run graph:evidence:verify
npm run observatory:verify
npm run status:generation:verify
npm run readiness:verify
```

`graph:evidence:verify` proves all required relations, all six lanes, focused
lineage traversal, stable ids, exact count parity, metadata reuse, full-hash
completion mode, one-source incremental replacement, and malformed-source
fail-closed behavior.
