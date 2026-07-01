# DinoBrain Install

Date: 2026-07-01

This document explains how to install DinoBrain on a Windows PC.

The installer is idempotent. Running it again updates existing repos, reinstalls dependencies, rebuilds the MCP server, refreshes SQLite shards, refreshes the Codex MCP config block, registers a Codex user-level `UserPromptSubmit` hook, registers Claude Code when its CLI is installed, and runs verification.

## Prerequisites

- Windows PowerShell 5.1 or newer
- `git` on `PATH`
- GitHub access to both private repos:
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
```

Run either launcher to open the live Observatory at `http://127.0.0.1:3847/`. The page includes a live LLM Wiki graph view backed by the SQLite/JSON Wiki index, plus task, context pack, trace, and memory audit logs.

## Fresh Install

Recommended path from a release asset:

```powershell
.\DinoBrainSetup.exe
```

`DinoBrainSetup.exe` is a Windows GUI bootstrapper. It contains the current `install.ps1`, lets the user choose the install root and client registration options, streams install logs, then calls the same idempotent installer described below. It still requires network access because the underlying installer clones GitHub repositories and downloads portable Node.js.

The EXE embeds an app ref at build time. By default `npm run installer:win` sets that ref to the current git commit SHA, so a release installer keeps installing the app version it was built from even if `main` moves later. The data repo defaults to `main` unless `-DataRef` is passed during build.

Git is recommended because it enables normal repo updates and `git_sync` backup workflows. If Git is not installed, the installer can perform a fresh install by downloading GitHub ZIP archives. For private repos in no-Git mode, enter a GitHub token in the setup window or set `DINOBRAIN_GITHUB_TOKEN`, `GITHUB_TOKEN`, or `GH_TOKEN` before launching the installer. Existing non-git install folders are not overwritten in no-Git mode.

From a downloaded `install.ps1`:

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

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

Build with explicit refs:

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

The build uses `installer\DinoBrainSetup`, embeds the repo's current `install.ps1`, publishes a single-file `win-x64` executable, then self-tests that the EXE can extract the embedded installer. Upload `artifacts\DinoBrainSetup.exe` as the GitHub Release asset for installation on another PC.

The EXE runs without requiring .NET on the target PC because it is published self-contained. It does not remove SmartScreen warnings by itself; production distribution still needs code signing if that matters.

## Publish The Release Asset

Set a token with permission to create releases and upload release assets, then run:

```powershell
$env:GITHUB_TOKEN="<token-with-repo-release-access>"
npm run release:win -- -Tag v0.1.0 -ReplaceAsset
```

This script builds `artifacts\DinoBrainSetup.exe`, creates or reuses the GitHub release for the tag, deletes the old `DinoBrainSetup.exe` asset when `-ReplaceAsset` is passed, and uploads the new EXE. The upload follows GitHub's release asset API: create or retrieve the release, then upload raw binary data to the release `upload_url`.

## What Install Does

1. Clones or updates `dinobrain`.
2. Clones or updates `dinobrain-data`.
3. Downloads portable Node.js if missing.
4. Runs `npm install`.
5. Runs `npm run build`.
6. Runs `npm run index:sqlite`.
7. Registers DinoBrain in Codex `config.toml`:

```toml
[mcp_servers.dinobrain]
args = ['C:\Users\<you>\Documents\dinobrain\dist\index.js']
command = 'C:\Users\<you>\AppData\Local\DinoBrain\tools\node-v24.18.0-win-x64\node.exe'
startup_timeout_sec = 120

[mcp_servers.dinobrain.env]
DINOBRAIN_DATA_DIR = 'C:\Users\<you>\Documents\dinobrain-data'
```

8. Registers a Codex user-level prompt hook at `C:\Users\<you>\.codex\hooks.json`.

This hook calls:

```powershell
C:\Users\<you>\Documents\dinobrain\scripts\dinobrain-user-prompt-hook.ps1
```

Because this is a user-level hook, Codex can run the DinoBrain preflight from any workspace after Codex reloads and the hook is trusted. The hook records only bounded, redacted prompt previews and Context Pack trace metadata into the local data vault.

9. Runs a Codex hook handshake.

The installer immediately simulates a `UserPromptSubmit` event through the same PowerShell hook wrapper that Codex will call. This proves the installed hook can start DinoBrain preflight, use the portable Node runtime, reach the data vault, and return `hookSpecificOutput.additionalContext` without requiring a manual first hook run. The handshake is tagged as `dinobrain-installer` and disables session import so it does not create review candidates from the synthetic prompt.

This handshake does not bypass Codex hook trust. If Codex was already running while the installer wrote `hooks.json`, restart or reload Codex and approve the DinoBrain hook if prompted.

10. Registers DinoBrain in Claude Code when `claude` is available:

```powershell
claude mcp add `
  --env DINOBRAIN_DATA_DIR=C:\Users\<you>\Documents\dinobrain-data `
  --transport stdio `
  --scope user `
  dinobrain `
  -- C:\Users\<you>\AppData\Local\DinoBrain\tools\node-v24.18.0-win-x64\node.exe C:\Users\<you>\Documents\dinobrain\dist\index.js
```

11. Runs `npm run verify:os`.
12. Creates `DinoBrain Observatory.cmd` launchers for the live graph and operations view.

`verify:os` uses the configured MCP command, checks the Codex user-level hook registration, lists the DinoBrain tools, checks Claude Code registration when the installer configured it, checks the compounding memory loop, runs retrieval evaluation, and checks sync safety. The separate hook handshake is the live wrapper smoke test for the installed user-level hook command.

The repository also contains a project Codex hook at `.codex/hooks.json` for repo-local verification and fallback. The runtime hook has duplicate protection so a trusted project hook and a trusted user-level hook do not create duplicate task records for the same prompt.

Codex requires you to review and trust hooks before they run in a live session. After install, restart or reload Codex and approve the DinoBrain hook when prompted. Once trusted, you should not need to manually force a first DinoBrain hook run; the installer already exercised the wrapper path.

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

## Reinstall

```powershell
.\reinstall.ps1
```

Reinstall is the same as install, but passes `-Force` so a changed repo origin URL can be repaired.

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

The uninstall script refuses to remove broad paths such as the home directory, Documents directory, or drive root.

## Verification

After install, run:

```powershell
npm run verify:os
npm run hook:verify
npm run observatory
```

When testing with a non-default Codex config path:

```powershell
$env:DINOBRAIN_CODEX_CONFIG_PATH = "C:\temp\codex\config.toml"
$env:DINOBRAIN_DATA_DIR = "C:\temp\dinobrain-data"
npm run verify:os
```
