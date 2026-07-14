# DinoBrain Local OS and Observatory Completion Plan

Status: DRAFT - implementation requires user approval
Date: 2026-07-13
Target: local product completion before distribution certification
Baseline: DinoBrain v2.2.31

## 1. Objective

Complete the DinoBrain experience on the current PC before spending more time on
clean-machine certification. The local product must make the OS visible,
understandable, easy to launch, and predictable about GitHub synchronization.

The completion target is not "more code" or "more test time." It is the eight
user outcomes in section 4, proven by bounded local evidence.

## 2. Scope Lock

This plan includes:

1. interactive Observatory feature drill-down;
2. an always-visible and readable live activity log;
3. a clearer Obsidian-style knowledge graph;
4. plain-language feature explanations and next actions;
5. a proper Windows Observatory executable;
6. automatic Observatory launch after successful installation;
7. reliable background startup after reboot, with Codex/Claude self-repair;
8. a visible, bounded GitHub data synchronization policy.

This plan explicitly excludes:

- Windows Sandbox runs;
- clean-machine equivalence certification;
- the 24-hour lifecycle soak;
- final GitHub release certification;
- broad commits of the existing DinoBrain data worktree;
- unrelated MCP, RAG, memory-lifecycle, or retrieval refactors;
- speculative architecture rewrites that are not needed for the eight outcomes.

Those distribution gates resume only after this local candidate is accepted and
frozen.

## 3. Current Baseline

- The Codex pre-response path works on the current PC, but occasional cooperative
  timeout remains visible and must not block ordinary conversation.
- The app repository is aligned with `origin/main` at the current baseline.
- The data repository has a large mixed runtime backlog. It must be classified,
  not bulk committed or deleted.
- The Observatory already exposes health chips, state details, recent events,
  and a canvas knowledge graph, but the surfaces are weakly connected.
- The current launcher is script-oriented. It does not yet feel like a normal
  Windows application lifecycle.
- Existing sync behavior is safe by default but is not understandable to the
  user from the Observatory.

## 4. Local Completion Gates

### LC-01: Feature drill-down

Every top-level health/feature control is keyboard- and mouse-activatable.
Activation opens one consistent inspector that shows:

- what the feature does;
- current status in plain Korean;
- important current values;
- why the status was assigned;
- evidence paths or recent related events;
- the safe next action when attention is needed.

Acceptance:

- every visible top-level feature opens a non-empty detail view;
- the selected feature is visibly identified;
- Escape and a close button dismiss the inspector;
- focus returns to the invoking control;
- no feature requires reading raw JSON to understand its state.

### LC-02: Always-available activity log

The main Observatory includes a persistent Activity surface instead of showing
logs only when a particular block happens to render them.

Required controls:

- All, Task, Hook, Memory, Sync, Warning/Error filters;
- text search;
- pause/resume live updates;
- auto-scroll toggle;
- compact and expanded row modes;
- copy one event and copy visible events;
- clear visual distinction between normal, warning, blocked, and failed events.

Acceptance:

- the log is visible from the first screen without navigating to a hidden page;
- new events appear within two seconds under normal local operation;
- at least 500 recent rows can be browsed without unbounded DOM or RAM growth;
- an event row can open its structured detail without exposing secrets;
- reconnecting after a server restart does not require a page refresh.

### LC-03: Knowledge graph usability

The graph is an evidence navigation tool, not decoration.

Required behavior:

- initial fit-to-view with meaningful cluster spacing;
- zoom, pan, fit, reset, search, and type/lifecycle filters;
- selected node remains anchored while its neighbors and evidence path highlight;
- unrelated nodes dim instead of disappearing abruptly;
- labels use collision limits and semantic zoom;
- a node inspector explains type, lifecycle, provenance, recent use, and links;
- subtle motion indicates new activity without continuously disturbing the layout;
- reduced-motion preference disables nonessential animation.

Acceptance:

- a user can find a named memory and trace how it reached a task;
- selection, reset, and filters do not resize the page;
- node labels remain readable at desktop and narrow widths;
- the graph does not render blank and remains interactive after live updates;
- the default view is understandable without a dinosaur-shaped layout.

### LC-04: Plain-language information architecture

The first screen answers four questions in order:

1. Is DinoBrain working now?
2. What is it doing now?
3. What memory did the current task use?
4. Is anything waiting for me?

Acceptance:

- status names include short Korean explanations;
- warnings state cause, consequence, and next action;
- advanced evidence stays available through progressive disclosure;
- operational surfaces remain compact and scan-friendly;
- no explanatory marketing section or decorative card stack is added.

### LC-05: Native Windows launcher

Produce a small `DinoBrain Observatory.exe` instead of requiring the user to
understand Node, PowerShell, ports, or repository folders.

Launcher responsibilities:

- discover the installed app and data roots;
- enforce one Observatory server instance per user;
- start the server in the background when needed;
- wait for a health endpoint with a bounded timeout;
- open the Observatory URL on explicit launch;
- report a useful error when startup fails;
- support `--ensure-running`, `--open`, `--stop`, and `--status` modes;
- write bounded local logs under `%LOCALAPPDATA%\DinoBrain\logs`.

Acceptance:

- double-click opens a working Observatory without a console window;
- repeated launches do not create duplicate Node servers or browser tabs;
- normal startup completes within five seconds on the current PC;
- failure leaves a readable local diagnostic and no orphan child process.

Implementation preference: a small self-contained .NET launcher. Do not add
Electron, a browser framework, or another large runtime.

### LC-06: Install-completion launch

After a successful install or update, the installer starts the native launcher
once and opens Observatory. A failed or rolled-back install must not launch it.

Acceptance:

- launch occurs only after the final successful transaction receipt;
- reinstall remains idempotent;
- installer UI reports whether Observatory started;
- a `Do not open now` option remains available for unattended or scripted use.

### LC-07: Reboot and agent-start behavior

Default local policy:

- register one per-user background start entry at Windows sign-in;
- start only the Observatory server, not a browser window;
- Codex and Claude integration perform a fast idempotent `--ensure-running`
  repair if the background start did not survive;
- prompt handling never waits indefinitely for the Observatory UI;
- an Observatory failure never blocks the user's conversation.

Acceptance:

- after reboot/sign-in, the server is available without manual setup;
- starting Codex or Claude repairs a missing server without duplicates;
- the ensure-running check has a strict local timeout and degrades non-blockingly;
- startup can be disabled from installer settings and Observatory settings;
- no administrator privilege is required for the per-user startup path.

### LC-08: Bounded GitHub data synchronization

Local writes and GitHub pushes are separate concerns. Memory can be recorded
locally immediately; GitHub must not receive a push for every prompt.

Recommended default policy:

- queue only task-scoped files that pass the existing safety classifier;
- coalesce queued work for six hours;
- allow at most four automatic pushes in any rolling 24-hour window;
- require ten minutes of user idle time before an automatic push;
- skip when offline, conflicted, blocked, sensitive, or a prior sync is running;
- retry with 15-minute, 1-hour, then 6-hour backoff;
- never stage unrelated dirty backlog;
- keep `Sync now` as an explicit safe-scoped action;
- keep broad/manual recovery sync separate and approval-gated.

The Observatory must show:

- last successful sync;
- last attempt and result;
- next eligible automatic sync;
- queued safe-file count;
- blocked/conditional count and reason;
- current branch and remote parity;
- whether automatic sync is enabled;
- a safe-scoped `Sync now` command.

Acceptance:

- no prompt causes an immediate GitHub push by default;
- a simulated day cannot exceed four automatic pushes;
- queued files survive app restart;
- concurrent agents produce one sync attempt through a lock;
- a sensitive or unrelated path never enters the staged set;
- all sync state is understandable from Observatory without reading Git output.

## 5. Information Architecture Target

The Observatory uses four stable surfaces:

1. `Overview`: current OS status, active task, memory used, and attention items;
2. `Activity`: persistent live log with filters and structured event detail;
3. `Knowledge`: the full-width graph and selected-node evidence inspector;
4. `Settings`: startup behavior, sync cadence, data/app roots, and diagnostics.

Top-level health controls remain visible as a compact status rail. They are
commands that open the shared inspector, not passive cards.

Desktop target:

- compact header and status rail;
- main working surface;
- optional right-side inspector;
- persistent resizable Activity dock.

Narrow target:

- one-column working surface;
- inspector becomes a bottom sheet;
- Activity becomes a fixed-height drawer;
- graph controls wrap without overlapping the canvas.

## 6. Bounded Work Packages

### WP-0: Baseline and contract freeze

Timebox: 45 minutes
Write scope: plan/test notes only

- capture current desktop and narrow screenshots;
- map current Observatory endpoints and launch paths;
- record current process, payload, and response-time baselines;
- identify the exact files each later package may edit.

Exit: one baseline report and no implementation changes.

### WP-1: Observatory shell, drill-down, and Activity

Timebox: 90 minutes
Primary scope: `scripts/dinobrain-observatory.mjs` and one focused verifier

- implement the four-surface navigation;
- make health controls interactive;
- add the shared inspector;
- add the persistent bounded Activity dock and reconnect behavior;
- add plain-language status definitions.

Exit: LC-01, LC-02, and LC-04 pass locally.

### WP-2: Knowledge graph interaction and visual cleanup

Timebox: 90 minutes
Primary scope: graph rendering inside the Observatory and its verifier

- stabilize layout and semantic zoom;
- add pan/zoom/fit and clear selection behavior;
- add evidence-path highlighting and node detail;
- reduce label and edge noise;
- verify reduced-motion and narrow layout.

Exit: LC-03 passes locally in captured desktop and narrow states.

### WP-3: Native launcher and startup lifecycle

Timebox: 90 minutes
Primary scope: native launcher project, startup script/library, installer wiring,
and focused launcher verifiers

- build the native launcher;
- add single-instance and health-wait behavior;
- wire successful install completion;
- register per-user sign-in startup;
- add Codex/Claude non-blocking ensure-running repair.

Exit: LC-05, LC-06, and LC-07 pass on the current PC and temporary test roots.

### WP-4: Bounded sync scheduler and visibility

Timebox: 90 minutes
Primary scope: task-scoped sync scheduler/state, settings, Observatory sync view,
and deterministic dry-run tests

- persist queue and cadence state atomically;
- implement lock, coalescing, cap, idle gate, and backoff;
- expose read-only status and safe manual trigger;
- prove no unrelated data backlog is staged.

Exit: LC-08 passes against a temporary local Git remote. No production push is
required for this package.

### WP-5: Local release-candidate verification

Timebox: 90 minutes
Write scope: fixes only for failed local acceptance criteria

- run targeted verifiers once per package;
- run `npm run check` once after integration;
- run the Observatory verifier once after integration;
- verify desktop and narrow screenshots;
- measure startup, duplicate process behavior, payload, and steady-state memory;
- write the local completion report.

Exit: LC-01 through LC-08 pass, or the report lists exact remaining predicates.

## 7. Time and Scope Control

These controls are part of the definition of done.

1. Implementation does not begin before this document is approved.
2. Total implementation is limited to WP-0 through WP-5. A seventh package
   requires a new user-approved plan revision.
3. Each package stops at its timebox. Unfinished work becomes an explicit
   remaining predicate; the agent does not silently extend the package.
4. At most four project worker threads may run concurrently. The complete plan
   may create at most five delegated tasks in two waves: one short baseline task,
   then four bounded domain tasks. No recursive worker threads and no consensus
   loop.
5. Worker-thread assignments must have distinct write scopes. They receive the
   accepted WP-0 baseline and only the repository slices needed for their
   package; they do not all reread the entire repository.
6. The same failing verifier may receive at most two repair attempts in one
   package. After the second failure, stop and report root cause and options.
7. Visual refinement is limited to three screenshot/fix cycles: desktop,
   narrow, and final regression.
8. No Sandbox, clean-machine, or 24-hour soak command may run in this plan.
9. No broad `git add`, data-repository cleanup, or release upload occurs without
   a separate gate and user-visible scope.
10. Once the acceptance criteria pass, stop. Do not add unrelated refactors,
    decorative features, or additional proof layers.

## 8. Resource Budgets

- Observatory API snapshot: keep the existing 256 KiB hard budget.
- Visible Activity DOM: maximum 500 rows; older history uses paging or a bounded
  window.
- Knowledge graph default window: keep a bounded node/edge window and load more
  only through explicit filters.
- Duplicate servers: zero.
- Idle Observatory CPU: target below 1% average after stabilization.
- Observatory server working set: target below 250 MiB after 60 seconds on the
  current PC.
- Startup: target five seconds or less.
- Hook/agent ensure-running path: strict timeout; failure is non-blocking.
- Automatic GitHub pushes: maximum four per rolling 24 hours by default.

Missing a budget is a finding to explain, not permission to run unbounded tests.

## 9. Local Verification Matrix

Required local checks:

- TypeScript and version authority: `npm run check`;
- targeted Observatory UI/data verifier;
- browser screenshots at approximately 1440x900 and 390x844;
- every health control opens meaningful detail;
- Activity filters, search, pause, reconnect, and bounded history;
- graph nonblank pixel check, zoom/pan/selection/filter/reset, and reduced motion;
- native launcher start/status/stop and duplicate-process prevention;
- install-success launch using a temporary install root;
- sign-in startup registration/unregistration without elevation;
- Codex/Claude ensure-running timeout and idempotency;
- sync scheduler deterministic clock test for the six-hour cadence and daily cap;
- sync safety test using a temporary local bare remote;
- no secrets in logs, settings, or queued sync metadata.

Not required in this phase:

- Sandbox;
- real clean PC;
- 24-hour wait;
- final release ZIP;
- production GitHub data push.

## 10. Multi-Agent Execution and Model Routing

The expensive model is the reviewer and integrator, not the default worker.
Model choice follows task risk and complexity instead of using the strongest
model for every operation.

### 10.1 Model policy

| Role | Default model | Allowed work | Timebox |
|---|---|---|---:|
| Main reviewer/integrator | `gpt-5.6-sol`, `ultra` | architecture decisions, shared contracts, conflict resolution, final diff review, integration wiring, and exact-blocker debugging | 60 minutes per integration pass |
| Short evidence worker | `gpt-5.6-luna`, `high` | inventory, screenshots, endpoint/file mapping, acceptance checklist, static verification, and concise evidence reports | 30 minutes |
| Normal implementation worker | `gpt-5.6-terra`, `high` | bounded feature implementation with an isolated file scope and focused tests | 75 minutes |
| Complex interaction worker | `gpt-5.6-terra`, `xhigh` | graph interaction, concurrency, atomic state, or other locally complex behavior | 90 minutes |

`Sol Ultra` does not repeat inventory, write routine tests, or redo accepted
worker implementation. It is used only for integration and review. A precise
blocker may be escalated to `Sol high` or `Sol Ultra` only after the owning
worker's initial attempt and one correction attempt both fail.

### 10.2 Named delegated tasks

Wave A creates one read-only baseline task:

1. `[DinoBrain] 00 Baseline and Acceptance` — `Luna high`; captures screenshots,
   maps endpoints and launch paths, records resource baselines, and freezes the
   file ownership table for WP-1 through WP-4.

After the main reviewer accepts that baseline, Wave B creates at most four
bounded implementation tasks:

1. `[DinoBrain] 10 UX and Activity` — `Terra high`; drill-down, inspector,
   Activity dock, filters, and plain-language status presentation;
2. `[DinoBrain] 20 Knowledge Graph` — `Terra xhigh`; graph layout, zoom, pan,
   selection, evidence paths, visual density, reduced motion, and graph tests;
3. `[DinoBrain] 30 Windows Launcher` — `Terra high`; native launcher,
   single-instance lifecycle, install completion launch, sign-in startup, and
   non-blocking Codex/Claude ensure-running behavior;
4. `[DinoBrain] 40 Sync Scheduler` — `Terra xhigh`; queue state, lock,
   coalescing, cadence, daily cap, backoff, safe manual sync, and deterministic
   tests against a temporary remote.

These are persistent, user-visible Codex project threads. Each active package
runs in an isolated Codex worktree so it can finish independently without
interrupting the main checkout or another worker. The main reviewer creates or
activates them only after this plan is approved.

### 10.3 Ownership and integration rules

- WP-0 freezes exact file paths before Wave B starts.
- No two workers may edit the same file.
- The main checkout is the integration authority; worker worktrees never merge
  themselves into it.
- Shared entrypoints and shared data contracts belong to the main integrator.
- When the current Observatory is monolithic, workers create isolated modules
  or return a patch plus integration instructions; they do not race on the
  monolithic entrypoint.
- The main integrator may make minimal imports, contract adapters, and conflict
  fixes, and imports only reviewed worker diffs into the main checkout. New
  feature logic stays with the owning worker.
- Workers may not commit, push, release, alter production data, or broaden their
  assigned scope.

### 10.4 Worker return contract

Every delegated task returns exactly:

1. outcome and acceptance criteria addressed;
2. changed files and why each changed;
3. commands/tests run and their result;
4. screenshot or runtime evidence when applicable;
5. known gaps and explicit integration instructions.

The main reviewer inspects the diff and reruns only the targeted verifier. A
rejected result receives one bounded correction request. If it still fails, the
package stops with the exact root cause and options; a new agent tree is not
created.

### 10.5 Efficiency stop rules

- Maximum concurrent subagents: four.
- Maximum delegated tasks for this plan: five.
- Maximum waves: two.
- Maximum worker attempts per package: two, including the correction.
- No worker may delegate again or request a consensus panel.
- A completed worker is closed before any replacement is considered.
- Passing work is integrated once and is not reopened for optional polish.
- The main reviewer stops when LC-01 through LC-08 pass or the package timebox
  expires with a documented remaining predicate.

## 11. Decision Points for User Approval

The recommended defaults are:

1. Startup: background server at Windows sign-in, no automatic browser window;
2. Agent repair: Codex/Claude ensure the server is running, but never block chat;
3. Install completion: open Observatory once, with an opt-out for scripted use;
4. Sync cadence: six-hour coalescing, maximum four automatic pushes per day;
5. Manual sync: safe task-scoped files only;
6. UI: Overview, Activity, Knowledge, Settings plus one shared inspector;
7. Distribution: defer Sandbox, 24-hour soak, and release until local approval;
8. Model routing: `Luna high` for the baseline, `Terra high/xhigh` for bounded
   implementation, and `Sol Ultra` only for integration and final review.

Implementation starts only after these defaults are approved or edited.

## 12. Local Definition of Done

The local version is complete when:

- LC-01 through LC-08 pass;
- there is no known local P0 or P1 usability defect in the eight outcomes;
- the app starts and repairs itself without duplicate processes;
- the user can understand status, memory use, activity, graph relations, and sync
  timing from the Observatory;
- targeted tests and one final local integration pass succeed;
- the local completion report names every deferred distribution predicate;
- implementation stops without running Sandbox or extending scope.

Only then may a separate distribution-certification plan resume clean-machine,
24-hour soak, immutable release, and final completion audit work.
