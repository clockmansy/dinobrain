# DinoBrain Local OS Observatory Completion Report

Date: 2026-07-14 (Asia/Seoul)
App version: 2.2.32
Plan: `docs/LOCAL_OS_OBSERVATORY_COMPLETION_PLAN_20260713.md`
Scope: local implementation and deterministic verification only

## 1. Decision

The bounded local package is complete. LC-01 through LC-08 pass on the current
PC using repository, temporary-fixture, native-launcher, and standalone Edge
evidence. The plan explicitly excluded Sandbox, a clean PC, a 24-hour wait,
release upload, and production data-repository push; none was used as a local
completion dependency.

One non-blocking P1 remains: rebuilding the full evidence graph for the current
6,890-source corpus exceeded the 240-second bounded attempt. The Observatory no
longer becomes blank when that generation pointer is unavailable. It serves the
last valid canonical graph, labels it `stale_canonical_fallback`, and exposes the
stale reason. Incremental graph-build profiling belongs in a separate approved
package.

## 2. Gate Results

| Gate | Result | Local evidence |
|---|---|---|
| LC-01 Feature drill-down | PASS | Every health chip is a keyboard/mouse control. The shared inspector presents status, explanation, current values, evidence, and next action. Close and Escape return focus to the invoking chip. |
| LC-02 Activity log | PASS | Activity is on the first screen, retains a bounded 500-row DOM window, and supports category filters, search, pause/resume, follow-tail, compact/expanded modes, row detail, copy, and reconnect polling. The integrated shell verifier passed 31/31 assertions. |
| LC-03 Knowledge graph | PASS | The final visual proof rendered 340 of 7,542 nodes and 400 of 19,934 relationships. Search, type/lifecycle filters, fit/reset, pan/zoom, selection, evidence detail, semantic labels, and reduced-motion handling are wired. Invalid managed-generation metadata falls back visibly to the last canonical graph instead of a blank canvas. |
| LC-04 Plain-language IA | PASS | Overview, Activity, Knowledge, and Settings answer current health, current activity, memory use, and pending action in that order. Advanced paths remain behind inspectors. No marketing or decorative section was added. |
| LC-05 Native Windows launcher | PASS | `DinoBrain Observatory.exe` implements `--ensure-running`, `--open`, `--stop`, `--status`, startup enable/disable, bounded logs, exact-port checks, and a per-user single-start semaphore. Runtime proof completed first ensure in 1,145 ms, second ensure in 192 ms, status in 206 ms, with one unchanged listener PID. |
| LC-06 Install-completion launch | PASS | The installer launches only after the final successful transaction receipt, exposes the opt-out, reports launch outcome, and embeds/extracts the native launcher. Reinstall remains on the existing transactional path. |
| LC-07 Reboot and agent start | PASS | The installer can register a per-user sign-in entry; startup uses server-only `--ensure-running`. Codex/Claude integration uses a strict non-blocking repair timeout. Observatory failure cannot block a conversation. |
| LC-08 Bounded GitHub synchronization | PASS | In remote-capable mode, durable task-scoped queueing coalesces for six hours, waits for ten minutes of idle time, caps automatic pushes at four per rolling 24 hours, serializes attempts through a lock, and uses 15-minute/1-hour/6-hour backoff. Sensitive, blocked, conflicted, or unrelated files are excluded. In `local_only` mode, both automatic and manual remote push are disabled at scheduler, MCP, API, and UI layers. No prompt performs an immediate default push. |

## 3. Visual Evidence

Standalone system Edge was driven through Playwright with GPU disabled. The
Codex in-app browser was not used because reconnecting it had previously closed
the Codex Desktop process.

- Desktop: `docs/assets/observatory-final-desktop-1440x900.png`
- Knowledge graph: `docs/assets/observatory-final-graph.png`
- Narrow: `docs/assets/observatory-final-narrow-390x844.png`

Measured browser predicates:

- desktop: 1,440x900, 500 Activity rows, 1,364x500 graph canvas;
- narrow: 390x844, 500 Activity rows, 314x360 graph canvas;
- horizontal overflow: false at both widths;
- overflowing controls: 0;
- sibling control overlaps at narrow width: 0;
- graph color-bearing pixels: 284 sampled groups;
- console errors: 0;
- inspector open, close, and focus return: true;
- Activity filter, pause/resume, and bounded-history interactions: true.

## 4. Runtime And Resource Evidence

| Metric | Result | Budget |
|---|---:|---:|
| First native ensure-running | 1,145 ms | <= 5,000 ms |
| Repeated ensure-running | 192 ms | <= 5,000 ms |
| Native status | 206 ms | <= 5,000 ms |
| Duplicate listener created | no | zero |
| Working set after 70 minutes | 100.59 MiB | < 250 MiB |
| Private memory | 99.04 MiB | informational |
| CPU over 10 seconds | 0.43% normalized across 16 logical processors | < 1% |
| Visible Activity rows | 500 | <= 500 |
| Default graph window | 340 nodes / 400 edges | bounded |

The launcher originally used a thread-affine mutex across `await`, which could
throw `Object synchronization method was called from an unsynchronized block`.
It now uses a named semaphore and has a regression assertion for the corrected
primitive.

## 5. Verification Evidence

Passed checks:

- `npm run build`
- `npm run check`
- `npm run smoke`
- `npm run pre-response:gate:verify`
- `npm run observatory:shell:verify` (31/31)
- `npm run observatory:graph:verify`
- `npm run verify:observatory-evidence`
- `npm run sync:scheduler:verify`
- `npm run safety:task-sync:verify`
- `scripts/verify-installer-observatory-launcher.ps1`
- `dotnet build installer/DinoBrainSetup/DinoBrainSetup.csproj --configuration Release --no-restore`
- standalone Edge desktop, graph, and narrow interaction proof
- final `npm run installer:win`, including installer extraction self-tests

The final local installer artifact is intentionally ignored by Git:

- path: `artifacts/DinoBrainSetup.exe`
- size: 103,316,320 bytes (98.53 MiB)
- SHA-256: `E509FBB5D899324DEAEEA4A3B8DEE8A613E401174E085DB17CE825B3241DE92A`

## 6. Upstream v2.2.32 Integration

While the local package was being closed, upstream `main` advanced to v2.2.32
with the sealed local-only second-brain mode. The Observatory package was
rebased onto that commit instead of overwriting it.

- `local_only` status and encrypted-backup verification remain visible;
- the Sync chip becomes `PUSH BLOCKED` in local-only mode;
- Sync now and the automatic-sync toggle are disabled in the browser;
- `/api/sync/run` and attempts to enable `/api/sync/automatic` return a
  deterministic local-only block;
- MCP finish and scheduler paths do not enqueue or execute remote push work in
  local-only mode;
- remote-capable installs retain the bounded six-hour scheduler.

`npm run local-only:verify`, `npm run sync:scheduler:verify`, and
`npm run observatory:verify` passed after this integration.

## 7. OS Gate Approval Correction

`os_gate` is an internal read-only policy evaluation and must not ask the user
for approval. Its MCP registration now declares:

- `readOnlyHint: true`
- `destructiveHint: false`
- `idempotentHint: true`
- `openWorldHint: false`

The MCP smoke test asserts that exact schema. A currently running Codex process
can retain the previous tool schema until its next normal restart; no restart
was forced during this package because interrupting the user's conversation is
the larger failure. Fresh MCP sessions receive the corrected metadata.

The action parser also now ignores negated persistence phrases such as `do not
sync` and `without syncing it`, preventing a read-only request from being
misclassified as a sync action.

## 8. Explicitly Deferred

- full evidence-graph rebuild performance and incremental generation;
- clean-PC and Windows Sandbox equivalence;
- 24-hour scheduler soak;
- public release or ZIP upload;
- production GitHub data-repository push.

These are separate deployment or performance packages. They do not reopen the
accepted local LC-01 through LC-08 implementation package.
