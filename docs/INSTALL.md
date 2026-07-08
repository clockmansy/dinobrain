# DinoBrain Install

Date: 2026-07-01

This document explains how to install DinoBrain on a Windows PC.

The installer is idempotent. Running it again updates existing repos, reinstalls dependencies, rebuilds the MCP server, refreshes SQLite shards, refreshes the Codex MCP config block, registers a Codex user-level `UserPromptSubmit` hook, registers Claude Code when its CLI is installed, and runs verification.

## Prerequisites

- Windows PowerShell 5.1 or newer
- `git` on `PATH`
- GitHub access to both repos. Public repos need ordinary network access; private repos require credentials with read permission:
  - `clockmansy/dinobrain`
  - `clockmansy/dinobrain-data`
- Codex installed or a writable Codex config path at:
  - `C:\Users\<you>\.codex\config.toml`
- Optional: Claude Code CLI on `PATH` as `claude`

The installer downloads portable Node.js into the user profile. It does not require global Node.js.

If Claude Code is installed after DinoBrain, rerun `.\setup.ps1` from the DinoBrain repo to register the same local MCP server with Claude Code.

After install, the installer creates a double-click launcher in both:

```text
<install-root>\DinoBrain Observatory.cmd
<install-root>\dinobrain\DinoBrain Observatory.cmd
<install-root>\DinoBrain Codex Live Proof.cmd
<install-root>\dinobrain\DinoBrain Codex Live Proof.cmd
<install-root>\DinoBrain Codex Managed Hook Admin.cmd
<install-root>\dinobrain\DinoBrain Codex Managed Hook Admin.cmd
```

Run either `DinoBrain Observatory.cmd` launcher to open the live Observatory at `http://127.0.0.1:3847/`. The page includes a live LLM Wiki graph view backed by the SQLite/JSON Wiki index, plus task, context pack, trace, and memory audit logs.

Run `DinoBrain Codex Live Proof.cmd` after install/update when you need to prove
that a freshly restarted Codex Desktop session is dispatching the real
`UserPromptSubmit` hook. It restarts stale Codex/MCP processes, guides the
required `/hooks` trust step, copies a unique proof prompt, and watches
`verify:codex-live` until the real `codex_desktop` preflight event appears.

## Fresh Install

Recommended path from a release asset:

```powershell
.\DinoBrainSetup.exe
```

`DinoBrainSetup.exe` is a Windows GUI bootstrapper. It contains the current `install.ps1`, lets the user choose the install root and client registration options, streams install logs, then calls the same idempotent installer described below. It still requires network access because the underlying installer clones GitHub repositories and downloads portable Node.js.

You should not need to type install paths by hand. The setup window now pre-fills the install root from, in order: `DINOBRAIN_INSTALL_ROOT`, `DINOBRAIN_DATA_DIR`, an existing Codex `DINOBRAIN_DATA_DIR` config, an already detected `dinobrain`/`dinobrain-data` pair under common locations, or the user's Documents folder. Use **Auto** to restore that recommendation or **Browse** to pick a parent folder. If you accidentally pick the `dinobrain` or `dinobrain-data` folder itself, the installer treats its parent as the install root and previews the final app/data paths before running.

The EXE embeds default refs at build time. By default `npm run installer:win` sets the app ref to `main`, so a release installer updates the local app checkout to the current GitHub `main` instead of pinning the PC to the installer build commit. The data repo also defaults to `main` unless `-DataRef` is passed during build.

After cloning or updating, the installer fetches GitHub again and verifies that each git checkout matches the requested remote ref. If local `dinobrain` or `dinobrain-data` differs from `origin/<ref>`, installation stops instead of leaving Codex connected to a stale app/data pair. Explicit tag or commit refs are still allowed for rollback/recovery, but they are reported as pinned and will not track `origin/main`.

Git is required for the full closed loop: repo updates, `git_sync`, scoped `auto_sync`, and GitHub push recovery. If Git is not installed, the installer can perform a degraded fresh install by downloading GitHub ZIP archives, but Git-backed update/sync/push verification will not be equivalent until Git is installed and the folders are converted to normal checkouts. For private repos in no-Git mode, enter a GitHub token in the setup window or set `DINOBRAIN_GITHUB_TOKEN`, `GITHUB_TOKEN`, or `GH_TOKEN` before launching the installer. Existing non-git install folders are not overwritten in no-Git mode.

Running the installer over the same install root is supported when the existing `dinobrain` and `dinobrain-data` folders are Git repositories created by DinoBrain. The installer fetches the requested refs, rebuilds the app, refreshes indexes, rewrites the DinoBrain Codex/Claude registrations, and recreates launchers. It does not delete the data vault during reinstall. If an existing target folder is not a Git checkout, or points at a different origin URL without `-Force`, installation stops instead of overwriting it.

From a downloaded `install.ps1`:

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

When running PowerShell directly, `-InstallRoot` may be a parent folder or an existing `dinobrain` / `dinobrain-data` folder; the script normalizes app/data folders back to their parent install root before creating default paths.

From an already cloned DinoBrain repo:

```powershell
.\setup.ps1
```

Default locations:

```text
C:\Users\<you>\Documents\dinobrain
C:\Users\<you>\Documents\dinobrain-data
C:\Users\<you>\AppData\Local\DinoBrain\tools\node-v24.18.0-win-x64
```

## Build The Windows EXE

Build a self-contained Windows installer from this repo:

```powershell
npm run installer:win
```

Build a deliberately pinned installer with explicit refs:

```powershell
$ref = (git rev-parse HEAD)
powershell -ExecutionPolicy Bypass -File .\scripts\build-windows-installer.ps1 `
  -AppRef $ref `
  -DataRef main
```

Output:

```text
artifacts\DinoBrainSetup.exe
```

The build uses `installer\DinoBrainSetup`, embeds the repo's current `install.ps1`, publishes a single-file `win-x64` executable, then self-tests that the EXE can extract the embedded installer. The release script wraps that EXE in `artifacts\DinoBrainSetup.zip` with a short install readme and SHA256 file, because the ZIP is the preferred GitHub Release asset for installation on another PC.

The EXE runs without requiring .NET on the target PC because it is published self-contained. It does not remove SmartScreen warnings by itself; production distribution still needs code signing if that matters.

## Publish The Release Asset

Set a token with permission to create releases and upload release assets, then run:

```powershell
$env:GITHUB_TOKEN="<token-with-repo-release-access>"
npm run release:win -- -Tag v2.2.1 -ReplaceAsset
```

This script builds `artifacts\DinoBrainSetup.exe`, packages `artifacts\DinoBrainSetup.zip`, writes `artifacts\DinoBrainSetup.zip.sha256`, creates or reuses the GitHub release for the tag, deletes old matching assets when `-ReplaceAsset` is passed, and uploads the ZIP plus SHA256 file. The upload follows GitHub's release asset API: create or retrieve the release, then upload raw binary data to the release `upload_url`.

## What Install Does

1. Clones or updates `dinobrain`.
2. Clones or updates `dinobrain-data`.
3. Configures `dinobrain-data` with `core.hooksPath = .githooks` so Git blocks local-only files and unreviewed auto-generated accepted memories even if an older MCP process tries to commit them.
4. Downloads portable Node.js if missing.
5. Runs `npm install`.
6. Runs `npm run build`.
7. Runs `npm run index:sqlite`.
8. Runs `npm run hooks:data:verify`.
9. Registers DinoBrain in Codex `config.toml`:

```toml
[mcp_servers.dinobrain]
args = ['C:\Users\<you>\Documents\dinobrain\dist\index.js']
command = 'C:\Users\<you>\AppData\Local\DinoBrain\tools\node-v24.18.0-win-x64\node.exe'
startup_timeout_sec = 120

[mcp_servers.dinobrain.env]
DINOBRAIN_DATA_DIR = 'C:\Users\<you>\Documents\dinobrain-data'
DINOBRAIN_AUTO_GROWTH = '1'
DINOBRAIN_AUTO_COMPOUND = '1'
DINOBRAIN_AUTO_SYNC = '1'
DINOBRAIN_AUTO_SYNC_ALLOW_CONDITIONAL = '0'
DINOBRAIN_AUTO_SYNC_PUSH = '0'
```

`DINOBRAIN_AUTO_SYNC=1` keeps the sync policy evaluator active, but the default
installed posture is public-safe: prompt-derived conditional artifacts are not
auto-committed and hook preflight does not auto-push unless you explicitly opt
in with `DINOBRAIN_AUTO_SYNC_ALLOW_CONDITIONAL=1` and
`DINOBRAIN_AUTO_SYNC_PUSH=1`.

10. Registers Codex prompt hooks.

The preferred path is a Codex managed hook in:

```text
C:\ProgramData\OpenAI\Codex\requirements.toml
C:\ProgramData\OpenAI\Codex\DinoBrainHooks\dinobrain-managed-user-prompt-hook.ps1
```

Codex treats hooks declared through managed requirements as policy-managed hooks, so this is the trust-free install path. The installer tries to write the managed hook directly. If the current process cannot write ProgramData, it still creates `DinoBrain Codex Managed Hook Admin.cmd`; run that launcher as administrator to install the managed hook later.

The installer also registers a user-level fallback prompt hook at `C:\Users\<you>\.codex\hooks.json`.

This hook calls:

```powershell
C:\Users\<you>\Documents\dinobrain\scripts\dinobrain-user-prompt-hook.ps1
```

Because this fallback is a user-level hook, Codex can run the DinoBrain preflight from any workspace after Codex reloads and the hook is trusted. The installer also makes sure `[features] hooks = true` is present in `C:\Users\<you>\.codex\config.toml` when hook registration is enabled. The hook records only bounded, redacted prompt previews and Context Pack trace metadata into the local data vault.

The Codex config writer normalizes line endings to CRLF, rejects bare carriage return bytes after writing, and validates the DinoBrain TOML block before reporting success. This prevents hidden `\r` bytes in `config.toml` from breaking Codex startup.

11. Runs a Codex hook handshake.

The installer immediately simulates a `UserPromptSubmit` event through the same PowerShell hook wrapper that Codex will call. This proves the installed hook can start DinoBrain preflight, use the portable Node runtime, reach the data vault, and return `hookSpecificOutput.additionalContext` without requiring a manual first hook run. The handshake is tagged as `dinobrain-installer` and disables session import so it does not create review candidates from the synthetic prompt.

This handshake proves the wrapper path but it is not live Codex Desktop proof. After hook registration, the installer creates `DinoBrain Codex Hook Approval.cmd`, `DinoBrain Codex Managed Hook Admin.cmd`, and `DinoBrain Codex Live Proof.cmd`.

Use the managed-hook admin launcher when ProgramData registration was skipped or failed. Use the approval helper only for the user-level fallback hook; it restarts stale Codex desktop processes when they were already running before `hooks.json` changed, launches Codex again, copies `/hooks` to the clipboard, and shows the approval steps. The final trust/approve click for user hooks still has to be done by the user in Codex.

After a managed hook or user hook changes, fully restart Codex and run the live proof in a newly created Codex Desktop workspace thread. Threads created before the latest `hooks.json` or `requirements.toml` write time are not accepted as proof.

12. Registers DinoBrain in Claude Code. The installer writes a user-level `UserPromptSubmit` hook to `C:\Users\<you>\.claude\settings.json` so Claude Code can receive DinoBrain pre-response context before it processes a prompt. When `claude` is available, it also registers the DinoBrain MCP server:

```powershell
claude mcp add `
  --env DINOBRAIN_DATA_DIR=C:\Users\<you>\Documents\dinobrain-data `
  --transport stdio `
  --scope user `
  dinobrain `
  -- C:\Users\<you>\AppData\Local\DinoBrain\tools\node-v24.18.0-win-x64\node.exe C:\Users\<you>\Documents\dinobrain\dist\index.js
```

13. Runs `npm run verify:os`.
14. Runs `npm run verify:codex-loop` against a temporary data vault and bare Git remote to prove the Codex hook, Context Pack, finish_task, auto-growth, and auto-sync push path can close end to end.
15. Creates `DinoBrain Observatory.cmd` launchers for the live graph and operations view.
16. Creates `DinoBrain Hook Diagnose.cmd` launchers that verify the installed hook file, Codex hook feature setting, stale Codex processes, and the real PowerShell wrapper probe.
17. Creates `DinoBrain Codex Hook Approval.cmd` launchers that restart stale Codex desktop sessions, open Codex, copy `/hooks`, and guide the user through the required hook trust prompt.
18. Creates `DinoBrain Codex Live Proof.cmd` launchers that combine stale-process restart, hook trust guidance, a unique proof prompt, and live `codex_desktop` verification.
19. Creates `DinoBrain Uninstall Everything.cmd` launchers that run the purge uninstaller from a temporary script copy so the app folder can remove itself.

`hooks:data:verify` proves the data repo Git hook is configured and blocks unreviewed auto-generated accepted memories plus local-only event/index paths at commit/push time. This is the last safety line for stale MCP processes that were started before an update. `verify:os` uses the configured MCP command, checks the Codex user-level hook registration, lists the DinoBrain tools, checks the compounding memory loop, runs retrieval evaluation, and checks sync safety. `verify:codex-loop` proves the invoked Codex loop can push policy-approved data to a remote. The separate hook handshake is the live wrapper smoke test for the installed user-level hook command.

The repository also contains a project Codex hook at `.codex/hooks.json` for repo-local verification and fallback. The runtime hook has duplicate protection so a trusted project hook and a trusted user-level hook do not create duplicate task records for the same prompt.

Codex requires you to review and trust hooks before they run in a live session. The installer can restart/reopen Codex and put `/hooks` on the clipboard, but it cannot and should not click the trust approval for you. Once trusted, you should not need to manually force a first DinoBrain hook run; the installer already exercised the wrapper path.

If live prompts still do not trigger DinoBrain, run `DinoBrain Hook Diagnose.cmd` from the install folder. If the probe passes but live Codex prompts are silent, open `/hooks` in Codex, trust the DinoBrain `UserPromptSubmit` hook, then start a new thread.

From the app repo, the same diagnose and approval flow is:

```powershell
npm run codex:hooks:diagnose
npm run codex:hooks:approval
npm run codex:live-proof
```

`codex:live-proof` opens a separate proof window and then returns. Keep that
window open while you approve the hook, start a fresh Codex thread, and paste
the proof prompt copied to your clipboard.

The fresh thread matters. Threads that were created before the DinoBrain
`hooks.json` update can continue without the new pre-response hook even after
the Codex process itself has been restarted.

To prove a fresh Codex app session actually dispatched the hook for a real prompt, run:

```powershell
npm run verify:goal
npm run verify:codex-live:recent
npm run verify:codex-live -- --snippet "unique prompt text" --since "2026-07-07T00:00:00Z"
```

`verify:goal` is the full closed-loop completion gate. It fails until the real
Codex Desktop live preflight evidence exists, even if the synthetic hook and
closed-loop fixture tests pass.

`verify:codex-live:recent` is the no-snippet live proof. It fails when the latest work only passed synthetic hook simulations and no recent real Codex Desktop prompt produced matching hook events plus a live report.

If the verifier sees a fresh Codex thread but no live hook event, do not use a delegated/app-tool message as evidence. Open or create a trusted Codex Desktop workspace thread, approve DinoBrain in `/hooks` if prompted, paste the proof prompt manually, and run the verifier again.

## Custom Paths

```powershell
.\install.ps1 `
  -InstallRoot "D:\AI" `
  -ToolsDir "D:\AI\tools" `
  -CodexConfigPath "$HOME\.codex\config.toml" `
  -CodexHooksPath "$HOME\.codex\hooks.json" `
  -ClaudeScope user
```

Skip either client registration when testing:

```powershell
.\install.ps1 -SkipCodexConfig -SkipCodexHookConfig -SkipClaudeCodeConfig
```

Skip the post-install Codex restart and hook approval helper:

```powershell
.\install.ps1 -SkipCodexRestartFlow
```

Use a non-default Claude Code command name or path:

```powershell
.\install.ps1 -ClaudeCommand "C:\Tools\Claude\claude.exe"
```

Custom repo sources are supported for testing or forks:

```powershell
.\install.ps1 `
  -AppRepo "https://github.com/clockmansy/dinobrain.git" `
  -DataRepo "https://github.com/clockmansy/dinobrain-data.git"
```

## Update

```powershell
.\update.ps1
```

This uses the same idempotent flow as install:

- `git fetch`
- `git pull --ff-only`
- `npm install`
- `npm run build`
- Codex MCP config refresh
- Codex user-level hook refresh
- Claude Code MCP registration when `claude` is available
- `npm run verify:os`
- `npm run verify:codex-loop`

## Reinstall

```powershell
.\reinstall.ps1
```

Reinstall is the same as install, but passes `-Force` so a changed repo origin URL can be repaired.

The reinstall path is safe for normal updates over an existing DinoBrain install. It does not remove `dinobrain-data`; it updates the Git checkout and re-indexes it. If you have local uncommitted tracked changes that conflict with Git checkout or pull, Git stops the reinstall before overwriting them.

## Uninstall

Default uninstall removes the Codex MCP registration, removes the Codex user-level hook registration, removes the Claude Code MCP registration when `claude` is available, and creates config backups:

```powershell
.\uninstall.ps1
```

Remove app files as well:

```powershell
.\uninstall.ps1 -RemoveAppRepo -RemovePortableNode -Force
```

Remove the data vault only when you intentionally want to delete local DinoBrain data:

```powershell
.\uninstall.ps1 -RemoveDataRepo -Force
```

Full purge removes app files, the data vault, portable Node, DinoBrain launchers, and DinoBrain-created Codex config/hook backups. It prompts for `DELETE DINOBRAIN` unless `-Yes` is passed:

```powershell
.\uninstall.ps1 -Purge
```

The Windows installer also creates `DinoBrain Uninstall Everything.cmd` in the install root and app folder. It runs the same `-Purge` path from a temporary script copy so the app folder can delete itself.

The uninstall script refuses to remove broad paths such as the home directory, Documents directory, or drive root.

## Verification

After install, run:

```powershell
npm run verify:os
npm run verify:codex-loop
npm run hooks:data:verify
npm run hook:verify
npm run verify:codex-live:recent
npm run verify:codex-live -- --snippet "unique prompt text" --since "2026-07-07T00:00:00Z"
npm run observatory
```

When testing with a non-default Codex config path:

```powershell
$env:DINOBRAIN_CODEX_CONFIG_PATH = "C:\temp\codex\config.toml"
$env:DINOBRAIN_DATA_DIR = "C:\temp\dinobrain-data"
npm run verify:os
npm run verify:codex-loop
```
