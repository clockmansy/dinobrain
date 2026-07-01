# Memory Use Audit

Date: 2026-07-01
Status: v0 implemented

## Goal

DinoBrain cannot prove private model attention. It can prove an observable chain:

```text
provided -> declared_used -> observed_used
```

`audit_memory_use` turns that chain into a short audit instance with a trust score.

## Tool

`audit_memory_use` reads a finished task trace and its Context Pack traces.

Inputs:

- `task_id` or `trace_path`
- `expected_memory_paths`
- `observed_summary`
- `observed_artifact_paths`
- `auditor`
- `notes`

Creates:

- `.dino/audits/<audit_id>.json`
- `.dino/events/<date>.jsonl`

## Score Meaning

- `provided_memory_paths`: memories that DinoBrain actually supplied in Context Packs
- `declared_used_memory_paths`: memories the agent recorded in `finish_task.used_memory_paths`
- `observed_used_memory_paths`: declared memories that are reflected by path/title hints in the trace or observed summary
- `missing_expected_memory`: expected memories not declared as used
- `hallucinated_memory_reference`: declared memory paths that were neither provided nor present on disk
- `graph_health_snapshot`: Wiki graph/index health for referenced curated memories

The `trust_score` is evidence quality, not truth itself.

## Observatory

`npm run observatory` shows:

- memory audit count
- latest audit id
- trust score
- verdict
- graph health score

## Boundaries

Audit logs are short operational records. They must not contain raw full conversations or large response transcripts.
