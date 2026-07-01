# Session Ingest

Date: 2026-07-01
Status: v0 implemented

## Goal

DinoBrain can use chat sessions as the root source of knowledge without turning the data vault into a slow raw transcript dump.

The rule is:

```text
session source -> redacted local-only archive -> pending candidates -> manual review -> accepted memory
```

Raw session material is not part of default retrieval. Only reviewed, accepted records can become ordinary Context Pack input.

## Tool

`import_session` accepts either:

- `messages`: role/content records
- `transcript`: a single text block

It writes:

- `10_Conversations/raw/<session_id>.json`
- `50_Instances/candidates/<candidate_id>.json`
- `80_Review_Queue/promotion/<candidate_id>.json`
- `.dino/events/<date>.jsonl`

## Raw Retention

The tool supports two retention modes:

- `redacted_excerpt`: stores bounded redacted previews plus hashes and metadata
- `metadata_only`: stores hashes, roles, timestamps, and character counts only

It does not store unredacted full transcripts. The archive records `raw_full_transcript_stored: false`.

`10_Conversations/raw/` is local-only and `git_sync` classifies it as blocked.

## Codex Hook Integration

The Codex `UserPromptSubmit` hook calls `import_session` automatically by default after it redacts and bounds the submitted user prompt.

This means a live Codex prompt creates:

- a task record
- a Context Pack trace
- a local-only session archive
- zero or more pending review candidates

The hook does not capture the later assistant response. End-of-work results still belong in `finish_task` until a separate response/trace capture path is implemented.

Controls:

- `DINOBRAIN_HOOK_IMPORT_SESSION=0`
- `DINOBRAIN_HOOK_RAW_RETENTION=metadata_only`
- `DINOBRAIN_HOOK_SESSION_MAX_CANDIDATES=<number>`

## Extraction

The v0 extractor is deterministic and conservative. It looks for simple cues and creates review candidates with:

- `status: pending_review`
- `auto_promote: false`
- `promotion_blockers: ["manual_review_required", "session_extraction_v0"]`
- evidence pointing back to the redacted local-only archive

Candidate categories:

- `user_preference`
- `project_decision`
- `project_state`
- `how_to`
- `error_fix`
- `idea`

Temperature labels:

- `hot`: current user preferences, current project state, direct user decisions
- `warm`: how-to notes, fix notes, general project decisions
- `cold`: ideas and raw session archives

## Retrieval Boundary

Before review, imported records remain outside default retrieval:

- `get_context_pack` does not search `10_Conversations/raw`, `50_Instances/candidates`, or `80_Review_Queue`.
- `wiki_search` searches the curated roots only.
- approval through `review_candidate` copies a candidate into `50_Instances/accepted`, which can then be indexed.

## Verification

```powershell
npm run build
npm run session:verify
```

The verifier proves:

- `import_session` is listable through MCP
- obvious secret patterns are redacted before any archive/candidate/review file is written
- raw archives are cold and local-only
- candidates are pending review and hot/warm/cold labeled
- raw/candidate/review paths do not appear in `wiki_search` or `get_context_pack`
- `git_sync` blocks raw archives and marks candidates/review files as conditional
