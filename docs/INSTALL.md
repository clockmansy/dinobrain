# DinoBrain Install

Date: 2026-07-01

This document explains how to install DinoBrain on a Windows PC.

The installer is idempotent. Running it again updates existing repos, reinstalls dependencies, rebuilds the MCP server, refreshes the Codex MCP config block, registers a Codex user-level `UserPromptSubmit` hook, registers Claude Code when its CLI is installed, and runs verification.

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

## Fresh Install

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

## What Install Does

1. Clones or updates `dinobrain`.
2. Clones or updates `dinobrain-data`.
3. Downloads portable Node.js if missing.
4. Runs `npm install`.
5. Runs `npm run build`.
6. Registers DinoBrain in Codex `config.toml`:

```toml
[mcp_servers.dinobrain]
args = ['C:\Users\<you>\Documents\dinobrain\dist\index.js']
command = 'C:\Users\<you>\AppData\Local\DinoBrain\tools\node-v24.18.0-win-x64\node.exe'
startup_timeout_sec = 120

[mcp_servers.dinobrain.env]
DINOBRAIN_DATA_DIR = 'C:\Users\<you>\Documents\dinobrain-data'
```

7. Registers a Codex user-level prompt hook at `C:\Users\<you>\.codex\hooks.json`.

This hook calls:

```powershell
C:\Users\<you>\Documents\dinobrain\scripts\dinobrain-user-prompt-hook.ps1
```

Because this is a user-level hook, Codex can run the DinoBrain preflight from any workspace after Codex reloads and the hook is trusted. The hook records only bounded, redacted prompt previews and Context Pack trace metadata into the local data vault.

8. Registers DinoBrain in Claude Code when `claude` is available:

```powershell
claude mcp add `
  --env DINOBRAIN_DATA_DIR=C:\Users\<you>\Documents\dinobrain-data `
  --transport stdio `
  --scope user `
  dinobrain `
  -- C:\Users\<you>\AppData\Local\DinoBrain\tools\node-v24.18.0-win-x64\node.exe C:\Users\<you>\Documents\dinobrain\dist\index.js
```

9. Runs `npm run verify:os`.

`verify:os` uses the configured MCP command, checks the Codex user-level hook registration, lists the DinoBrain tools, checks Claude Code registration when the installer configured it, checks the compounding memory loop, runs retrieval evaluation, and checks sync safety.

The repository also contains a project Codex hook at `.codex/hooks.json` for repo-local verification and fallback. The runtime hook has duplicate protection so a trusted project hook and a trusted user-level hook do not create duplicate task records for the same prompt.

Codex requires you to review and trust hooks before they run in a live session. After install, restart or reload Codex and approve the DinoBrain hook when prompted.

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
