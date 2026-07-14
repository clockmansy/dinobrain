# DinoBrain Local OS Observatory WP-0 Baseline

Date: 2026-07-13 (Asia/Seoul)
Scope: WP-0 only, read-only evidence collection plus this baseline report
Plan: `docs/LOCAL_OS_OBSERVATORY_COMPLETION_PLAN_20260713.md`

## 1. Outcome

WP-0 is complete. The current Observatory was inspected at desktop and narrow
viewports, its launch/API/data flow was mapped, live process/payload/latency/
memory baselines were measured, WP-1 through WP-4 ownership was frozen, and
LC-01 through LC-08 were classified from current UI, API, and source evidence.

No product implementation, existing document, data synchronization, commit,
push, release, sandbox, clean-machine, or global installation change was made.

## 2. Critical environment qualification

The live listener at `http://127.0.0.1:3847/` reported:

- `app_root`: `C:\Users\USER\Documents\dinobrain`
- `data_root`: `C:\Users\USER\Documents\dinobrain-data`
- `observatory_version`: `2026-07-11-evidence-graph-v2`

The delegated worktree is
`C:\Users\USER\.codex\worktrees\34e1\dinobrain`. Its Observatory source
exists, but its generated `dist\` directory is absent. The worktree and the
live app source are not identical:

- worktree `scripts\dinobrain-observatory.mjs` SHA-256:
  `61083B790385D12558297533D198A451E8329A3CE3F3E6AC59841E4D425C1616`
- live app `scripts\dinobrain-observatory.mjs` SHA-256:
  `AC005BCE87C1E3A4000D592F87939D63F6ED0A01C3028C13DE5BA5FEF94C71D6`
- worktree `package.json` SHA-256:
  `264C1F3D9AF05117C4C54C15A91042EFE405AB06665A52C21B9F8C10DB1B8CF6`
- live app `package.json` SHA-256:
  `A8CD4DC3A86DE42527564446D0B42B237BEDC8C3BD2E30F2E1CBD925D57AED18`

Therefore the screenshots and live runtime numbers below are evidence of the
currently running installed Observatory, not proof that the unbuilt delegated
worktree produces the same runtime. This must be resolved before final local
acceptance.

## 3. Screen evidence

Viewport screenshots were captured with Chrome through the connected
Playwright runtime, with `deviceScaleFactor=1`:

- Desktop viewport 1440x900:
  `docs\assets\observatory-baseline-desktop-1440x900.png`
- Narrow viewport 390x844:
  `docs\assets\observatory-baseline-narrow-390x844.png`

Full-page captures were inspected during WP-0 but intentionally omitted from
the integrated baseline to avoid retaining 3.5 MiB of duplicate visual data.
The two fixed-viewport captures above are the durable comparison evidence.

Observed desktop first screen:

- header, live indicator, data-root path, 11 health/status cards, five count
  cards, Knowledge Graph, and the beginning of a long event list;
- graph controls are lane/relation/lifecycle/provenance selects, search,
  Trace, and Reset;
- status cards are visually prominent but are not interactive controls;
- the graph endpoint returned an empty index, so the canvas showed the current
  orbital placeholder labels rather than a traceable evidence graph.

Observed narrow first screen:

- status cards wrap into two columns and the data-root path wraps across lines;
- count cards also wrap into two columns;
- the Knowledge Graph begins below the first viewport; its controls and the
  event/detail surfaces are below the fold;
- no horizontal overflow was observed in the DOM measurement
  (`scrollWidth=390` at a 390px viewport).

DOM evidence from the desktop page:

- buttons: `Trace`, `Reset` only;
- dialogs: `0` (`dialog` and `[role=dialog]`);
- selects: `4` graph filters;
- text inputs: `1`, placeholder `Search` (graph search);
- navigation elements: none; the page has one status/card surface rather than
  Overview/Activity/Knowledge/Settings navigation.

## 4. Launch path, endpoints, and data flow

### Launch paths

Direct runtime:

```powershell
$env:PATH = 'C:\Users\USER\AppData\Local\DinoBrain\tools\node-v24.18.0-win-x64;' + $env:PATH
$env:DINOBRAIN_DATA_DIR = 'C:\Users\USER\Documents\dinobrain-data'
$env:DINOBRAIN_OBSERVATORY_PORT = '3847'
node scripts\dinobrain-observatory.mjs --port=3847
```

PowerShell launcher:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\start-dinobrain-observatory.ps1 `
  -DataDir 'C:\Users\USER\Documents\dinobrain-data' `
  -NodeRoot 'C:\Users\USER\AppData\Local\DinoBrain\tools\node-v24.18.0-win-x64' `
  -Port 3847 -NoBrowser
```

The launcher defaults to a sibling `dinobrain-data` directory and discovers
portable Node under `%LOCALAPPDATA%\DinoBrain\tools`. It checks `/api/health`,
reuses a matching server, and otherwise starts the Node Observatory script.
The installer currently generates `DinoBrain Observatory.cmd` wrappers from
`install.ps1`; the wrapper calls the PowerShell launcher.

### API endpoints

| Endpoint | Current role | Warm payload baseline |
|---|---|---:|
| `/api/health` | version, app/data roots, graph/readiness summary, cache/resources, endpoint list | 2,929 B |
| `/api/snapshot` | compact browser refresh envelope: state, graph, readiness | 89,835 B |
| `/api/state` | bounded state projection: events, tasks, packs, traces, audits, lifecycle, sync risk | 71,434 B |
| `/api/readiness` | full readiness/gate/artifact/lanes projection | 310,480 B |
| `/api/graph` | filtered graph window | 709 B; 0 nodes / 0 edges |
| `/api/graph-health` | graph health plus readiness summary | 1,066 B |

### Data flow

1. `scripts\dinobrain-observatory.mjs` resolves the app root from its own
   location and the data root from `DINOBRAIN_DATA_DIR` or the sibling default.
2. The server imports generated `dist` readers for status generation, canonical
   readiness, and evidence graph data.
3. It reads bounded `.dino` JSON/JSONL artifacts and, when available, the
   evidence-graph SQLite shard, then projects state/snapshot/readiness/graph
   DTOs.
4. `/` serves the inline HTML/CSS/JS page. The browser polls
   `/api/snapshot` every 3,000 ms after the previous request completes.
5. Graph filter changes and Trace call `/api/graph` with query parameters;
   health and graph-health remain read-only diagnostics.

## 5. Live process, payload, latency, and memory baseline

Measurement window: 2026-07-13 21:47–21:49 KST. The port listener was the
single Observatory server process below; other Node processes on the machine
were not counted as Observatory servers.

| Metric | Baseline |
|---|---|
| Listener | `127.0.0.1:3847`, one listener |
| Server PID | `29364` |
| Start time | `2026-07-13T20:53:13.6142577+09:00` |
| Server version | `2026-07-11-evidence-graph-v2` |
| App/data roots | Documents app + Documents data root, as reported by `/api/health` |
| Duplicate server count | 0 additional listeners observed |
| Browser polling | 3,000 ms, completion-driven (`pollInFlight` guard) |

Five-request API samples after warm-up:

| Endpoint | min / median / max response time |
|---|---:|
| `/api/health` | 0.77 / 0.92 / 569.51 ms; first request was the cold outlier |
| `/api/snapshot` | 1.12 / 1.20 / 1.29 ms |
| `/api/state` | 0.99 / 1.10 / 1.24 ms |
| `/api/readiness` | 2.26 / 2.40 / 2.71 ms |
| `/api/graph` | 0.60 / 0.69 / 1.08 ms |
| `/api/graph-health` | 0.60 / 0.79 / 3.05 ms |

Three idle samples of the listener process at five-second intervals:

| Time | Working set | Private bytes | Node `rss` |
|---|---:|---:|---:|
| 21:49:20 | 119,406,592 B | 124,858,368 B | 129,798,144 B |
| 21:49:26 | 124,977,152 B | 130,715,648 B | 123,904,000 B |
| 21:49:31 | 86,417,408 B | 94,683,136 B | 86,417,408 B |

The observed idle working set stayed far below the plan's 250 MiB target, but
this is not a 60-second controlled measurement and is from the installed app
root noted above. The `/api/readiness` response is 310,480 B, above the
256 KiB resource budget; `/api/snapshot` and `/api/state` are below it.

## 6. WP-1 through WP-4 disjoint file ownership

The following ownership is frozen before implementation. A worker may read
other files but may not edit them. `package.json`, `package-lock.json`, and the
plan remain integration-owned and are not worker-owned. Workers should run
direct commands during development; package-script edits are reserved for the
main integrator.

| Package | Exclusive write files | Boundary |
|---|---|---|
| WP-1 shell/drill-down/activity | `scripts\dinobrain-observatory.mjs`; new `scripts\verify-observatory-shell.mjs` | Owns the current HTML shell, shared inspector, Activity surface, and plain-language status presentation. It must consume graph/sync adapters through imports or stable DTOs; no WP-2/WP-4 edits to the monolith. |
| WP-2 graph | new `scripts\observatory-graph.mjs`; existing `scripts\verify-observatory-live-graph.mjs` | Owns graph layout/rendering behavior and graph verifier. The main integrator performs the minimal import/adapter wiring in the WP-1-owned monolith. |
| WP-3 launcher/startup | new `installer\DinoBrainObservatoryLauncher\**`; `scripts\start-dinobrain-observatory.ps1`; `scripts\build-windows-installer.ps1`; `scripts\verify-installer-observatory-launcher.ps1`; `install.ps1`; `reinstall.ps1`; `installer\DinoBrainSetup\DinoBrainSetup.csproj`; `installer\DinoBrainSetup\Program.cs`; `installer\DinoBrainSetup\SetupForm.cs` | Owns native launcher, single-instance/health wait, install-completion launch, sign-in startup, and Codex/Claude ensure-running wiring. No Observatory UI or sync scheduler edits. |
| WP-4 bounded sync | `src\task-sync-scope.ts`; `src\public-sync-receipt.ts`; `scripts\verify-task-scoped-sync.mjs`; `docs\SYNC_POLICY.md`; new `src\observatory-sync-state.ts`; new `scripts\verify-sync-scheduler.mjs` | Owns scheduler state, queue/cadence/lock/idle/backoff/cap logic, safe manual trigger contract, and deterministic verifier. The Observatory UI consumes its read-only DTO through the WP-1 integration boundary. Existing classifier/library files are dependencies unless explicitly reassigned by a later approved plan. |

Integration-only rule: a worker may add files only inside its row. The main
integrator owns minimal imports, adapter wiring, `package.json` script wiring,
and any WP-5 repair after reviewing the worker result. No worker may commit,
push, release, sync production data, or edit another row's files.

## 7. LC-01 through LC-08 current classification

| Gate | Status | Evidence and reason |
|---|---|---|
| LC-01 Feature drill-down | **FAIL** | The page exposes only `Trace` and `Reset` buttons, zero dialogs, and no inspector. Health/feature cards are not controls; no consistent detail view or focus-return behavior exists. |
| LC-02 Activity log | **FAIL** | Events are visible on the first screen and the browser uses a 3-second snapshot poll, but required filters, text search, pause/resume, auto-scroll, row modes, copy actions, structured row detail, and the <=2-second update predicate are absent. |
| LC-03 Knowledge graph | **FAIL** | Filter/search/Trace/Reset controls and a canvas exist, but `/api/graph` reports `index_mode=missing`, 0 nodes, and 0 edges. The screenshot is an empty placeholder graph, so a named memory cannot be traced. |
| LC-04 Plain-language IA | **FAIL** | The first screen shows status, active task, counts, and attention colors, but labels are mostly English/raw paths, warnings do not give cause/consequence/next action, and there are no four stable surfaces or progressive-disclosure inspector. |
| LC-05 Native launcher | **FAIL** | Current launch is PowerShell plus generated `.cmd` wrappers. No `DinoBrain Observatory.exe` or `--ensure-running`/`--open`/`--stop`/`--status` native command surface is present in the worktree. |
| LC-06 Install-completion launch | **FAIL** | `install.ps1` creates Observatory wrappers after transaction promotion and the setup UI has a manual Open Observatory action, but no automatic post-success open/opt-out transaction behavior is evidenced. |
| LC-07 Reboot/agent start | **FAIL** | Current source has no per-user sign-in registration or Observatory `--ensure-running` repair path. The launcher is manual and no startup entry/disable setting was found. |
| LC-08 Bounded sync | **FAIL** | Existing task-scoped allowlist, hash, review, classifier, and receipt code is present, but the Observatory says `Sync unknown` and no six-hour coalescing, four-push rolling cap, idle gate, retry backoff, durable queue state, or sync settings/status surface is present in the current UI/source evidence. |

## 8. Commands and results

Portable runtime prerequisite check:

```powershell
$nodeRoot = 'C:\Users\USER\AppData\Local\DinoBrain\tools\node-v24.18.0-win-x64'
& (Join-Path $nodeRoot 'npx.cmd') --version
```

Result: `11.16.0`. The Playwright CLI package invocation itself timed out in
this environment, so Chrome was driven through the already available Node
REPL Playwright runtime and the screenshots above were successfully written.

```powershell
& (Join-Path $nodeRoot 'npm.cmd') run check
```

Result: version-authority subcheck **PASS** (`2.2.31`, aligned manifest
surfaces); full check **FAIL/blocked** because `tsc` is unavailable in the
worktree runtime (`node_modules` is not installed there).

```powershell
& (Join-Path $nodeRoot 'npm.cmd') run observatory:verify
```

Result: **FAIL/blocked** before verifier execution because the worktree lacks
`dist\status-generation.js`.

Live API and process commands used successfully:

```powershell
Invoke-RestMethod http://127.0.0.1:3847/api/health | ConvertTo-Json -Depth 20
netstat -ano | Select-String ':3847.*LISTENING'
Get-Process -Id 29364 | Select-Object Id,StartTime,WorkingSet64,PrivateMemorySize64
```

## 9. Minimum verification commands for later workers

Run from the app worktree after its generated `dist` and dependencies exist:

```powershell
$nodeRoot = 'C:\Users\USER\AppData\Local\DinoBrain\tools\node-v24.18.0-win-x64'
$env:PATH = "$nodeRoot;$env:PATH"
npm.cmd run check
node scripts\verify-observatory-shell.mjs
node scripts\verify-observatory-live-graph.mjs
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\verify-installer-observatory-launcher.ps1
node scripts\verify-sync-scheduler.mjs
node scripts\verify-task-scoped-sync.mjs
Invoke-RestMethod http://127.0.0.1:3847/api/health | ConvertTo-Json -Depth 20
netstat -ano | Select-String ':3847.*LISTENING'
```

For a local browser pass, use the two fixed viewport sizes from Section 3 and
confirm: every top-level status control opens the shared inspector; Activity
filters/search/pause/reconnect work; the graph is non-empty and selectable;
the native launcher is single-instance; and sync is a dry-run, task-scoped
operation. Do not run a real production push during these checks.

## 10. Remaining uncertainty

1. The live server is the Documents installation, not the delegated worktree;
   source and package hashes differ, and the worktree has no generated `dist`.
2. The captured live data root reports missing graph/source/recall/compound
   surfaces and 12 readiness blockers; this may be installation-data state or
   a version mismatch and needs a controlled worktree build before final gate
   decisions.
3. The current memory samples are short idle observations, not the plan's
   60-second steady-state measurement.
4. Browser CLI package installation was unavailable; screenshots were still
   captured through the existing Chrome executable and Node REPL Playwright.
5. LC status is a current baseline classification, not a claim that the
   planned implementation cannot satisfy the gate.
