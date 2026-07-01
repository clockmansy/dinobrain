# DinoBrain MVP Plan v0.1

Date: 2026-07-01

Rule: Do only the work written in this plan. If the plan needs to change, update the plan first and get approval before doing implementation work.

## Current State

- GitHub private repos are created:
  - `clockmansy/dinobrain`: app and MCP server repo
  - `clockmansy/dinobrain-data`: data vault repo
- Local repos are connected:
  - `C:\Users\USER\Documents\dinobrain`
  - `C:\Users\USER\Documents\dinobrain-data`
- Both repos are empty and on `main`.
- The handoff zip is reference material, not the final app structure.

## Final Goal

DinoBrain is a local-first second-brain OS that Codex and Claude can access through MCP.

The core value is not storing notes. The core value is selecting the right memories for the next session, explaining why they were selected, and safely removing memories that turn out to be wrong.

## MVP Goals

1. Record task start and finish.
2. Generate a focused Context Pack for the current task.
3. Search Wiki, Source, Project, and Instance records narrowly.
4. Create promotion candidates from completed work.
5. Show trace logs explaining why a memory was used.
6. Classify safe data for git sync.
7. Import chat sessions as safe source material and extract reviewable LLM Wiki candidates.

## Repository Roles

### `dinobrain`

- MCP server
- Policy modules
- Context Pack generator
- Wiki search
- Trace console
- Tests and evaluation harness

### `dinobrain-data`

- `00_Home`
- `10_Conversations`
- `20_Wiki`
- `30_Sources`
- `40_Projects`
- `50_Instances`
- `60_Operations`
- `70_Error_Book`
- `80_Review_Queue`
- `.dino`

## Non-Goals

- Do not auto-scan personal document folders.
- Do not upload raw full conversation logs to GitHub.
- Do not auto-promote external facts.
- Do not store secrets, tokens, or API keys.
- Do not build the DinoBrain Observatory visual UI first.
- Do not let multiple role threads write directly to shared files.
- Do not carry the old bridge prototype into the final architecture.

## Phase 1: Foundation

Goal: Make each repo's purpose and boundaries clear.

Tasks:

- Add README, plan, and architecture documents to `dinobrain`.
- Add the initial vault folder structure to `dinobrain-data`.
- Document sync policy.
- Document sensitivity policy.
- Create the first commit and push.

Completion criteria:

- Both repos have initial files on `main`.
- The plan clearly states which data may be synced to GitHub.

## Phase 2: MCP Server Skeleton

Goal: Make the MCP tools callable.

Initial tools:

- `start_task`
- `finish_task`
- `get_context_pack`
- `wiki_search`
- `git_sync` as dry-run only

Completion criteria:

- MCP Inspector or an MCP client can list the tools.
- Calling `start_task` creates a task record in the data repo.
- Calling `finish_task` creates a trace/event log entry.

## Phase 3: Context Pack v0

Goal: Avoid reading the whole vault at session start. Retrieve only the relevant context.

Initial ranking inputs:

- File name
- Frontmatter
- Title
- Summary
- Tags
- Recent task records

Completion criteria:

- A user question returns a Standard Pack.
- The trace log records why each item was included.
- Irrelevant files are not pulled in aggressively.

## Phase 4: Search Quality Evaluation

Goal: Measure retrieval quality instead of trusting intuition.

Tasks:

- Create 20 golden questions.
- Manually assign the notes that should appear for each question.
- Add a script that measures recall and noise.

Completion criteria:

- Target Standard Pack recall is at least `0.8`.
- Target irrelevant-note noise is at most `2` notes per pack.

## Phase 5: Promotion and Demotion Policy

Goal: Promote useful knowledge and make incorrect knowledge recoverable.

Tasks:

- Create candidate instances.
- Require evidence snippets.
- Require `confidence` and `last_verified`.
- Add Review Queue flow.
- Design demote/quarantine behavior.

Completion criteria:

- Claims without evidence are not auto-promoted.
- Quarantined notes are excluded from Context Packs.

## Phase 6: Git Sync

Goal: Sync only safe data.

Initial behavior:

- `git_sync` is dry-run only.
- It reports changed files.
- It runs sensitivity checks.
- It explains which files are syncable or blocked.

Later behavior:

- Commit after manual approval.
- Push after the commit policy is stable.

## Phase 7: Session Ingest and LLM Wiki Growth

Goal: Use user/agent sessions as the root source of knowledge without making the vault slow or unsafe.

Initial behavior:

- `import_session` stores redacted local-only session archives under `10_Conversations/raw`.
- The Codex `UserPromptSubmit` hook calls `import_session` with the redacted user prompt by default.
- Raw full conversation logs are not stored in git.
- The extractor creates pending candidates under `50_Instances/candidates`.
- Each candidate has evidence, sensitivity, confidence, and hot/warm/cold temperature.
- Review records are written under `80_Review_Queue/promotion`.
- Raw archives, candidates, and review queue records are excluded from `wiki_search` and `get_context_pack`.
- `finish_task` records structured memory-use paths so later graph/index work can know which memories were actually used.

Completion criteria:

- Redaction happens inside the MCP tool boundary.
- `git_sync` blocks raw session archives.
- Candidates are never auto-promoted.
- Reviewed accepted instances remain the only imported session knowledge that can enter default retrieval.
- Completed task traces preserve `used_memory_paths` and `context_pack_paths`.

## Work Rules

- Do not do work outside this plan.
- If new work is needed, propose a plan change first.
- Prefer records and policies before implementation.
- Each phase must meet its completion criteria before the next phase starts.
- Check sensitivity before adding files to either repo.

## Immediate Next Steps

1. Save this plan as `PLAN.md` in `dinobrain`.
2. Review and approve Phase 1 scope.
3. Create the initial `dinobrain-data` vault structure.
4. Add README and policy documents.
5. Commit and push the initial repo state.
