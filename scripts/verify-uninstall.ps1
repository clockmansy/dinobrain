#Requires -Version 5.1
[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$root = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$uninstallScript = Join-Path $root "uninstall.ps1"
if (-not (Test-Path -LiteralPath $uninstallScript)) {
  throw "uninstall.ps1 was not found."
}

$temp = Join-Path ([System.IO.Path]::GetTempPath()) ("dinobrain-uninstall-verify-" + [guid]::NewGuid().ToString("N"))
try {
  $installRoot = Join-Path $temp "install"
  $appDir = Join-Path $installRoot "dinobrain"
  $dataDir = Join-Path $installRoot "dinobrain-data"
  $toolsDir = Join-Path $temp "tools"
  $nodeRoot = Join-Path $toolsDir "node-v24.18.0-win-x64"
  $codexDir = Join-Path $temp ".codex"
  $configPath = Join-Path $codexDir "config.toml"
  $hooksPath = Join-Path $codexDir "hooks.json"

  New-Item -ItemType Directory -Force -Path $appDir, $dataDir, $nodeRoot, $codexDir | Out-Null
  [System.IO.File]::WriteAllText((Join-Path $appDir "app.txt"), "app`n", [System.Text.UTF8Encoding]::new($false))
  [System.IO.File]::WriteAllText((Join-Path $dataDir "data.txt"), "data`n", [System.Text.UTF8Encoding]::new($false))
  [System.IO.File]::WriteAllText((Join-Path $nodeRoot "node.exe"), "node`n", [System.Text.UTF8Encoding]::new($false))

  foreach ($launcherRoot in @($installRoot, $appDir)) {
    foreach ($launcherName in @("DinoBrain Observatory.cmd", "DinoBrain Hook Diagnose.cmd", "DinoBrain Codex Hook Approval.cmd", "DinoBrain Codex Live Proof.cmd", "DinoBrain Uninstall Everything.cmd")) {
      [System.IO.File]::WriteAllText((Join-Path $launcherRoot $launcherName), "@echo off`r`n", [System.Text.UTF8Encoding]::new($false))
    }
  }

  $config = @"
[features]
hooks = true

[mcp_servers.other]
command = 'other.exe'

[mcp_servers.dinobrain]
command = 'node.exe'
args = ['dist/index.js']

[mcp_servers.dinobrain.env]
DINOBRAIN_DATA_DIR = '$dataDir'
"@
  [System.IO.File]::WriteAllText($configPath, $config, [System.Text.UTF8Encoding]::new($false))
  [System.IO.File]::WriteAllText("$configPath.bak-dinobrain-test", "backup`n", [System.Text.UTF8Encoding]::new($false))

  $hooks = @{
    hooks = @{
      UserPromptSubmit = @(
        @{
          hooks = @(
            @{
              type = "command"
              command = "echo old"
              timeout = 5
            }
          )
        },
        @{
          hooks = @(
            @{
              type = "command"
              command = "powershell dinobrain-user-prompt-hook.ps1"
              statusMessage = "Loading DinoBrain context"
            }
          )
        }
      )
    }
  } | ConvertTo-Json -Depth 20
  [System.IO.File]::WriteAllText($hooksPath, $hooks, [System.Text.UTF8Encoding]::new($false))
  [System.IO.File]::WriteAllText("$hooksPath.bak-dinobrain-test", "backup`n", [System.Text.UTF8Encoding]::new($false))

  & powershell.exe `
    -NoProfile `
    -ExecutionPolicy Bypass `
    -File $uninstallScript `
    -InstallRoot $installRoot `
    -AppDir $appDir `
    -DataDir $dataDir `
    -ToolsDir $toolsDir `
    -CodexConfigPath $configPath `
    -CodexHooksPath $hooksPath `
    -ClaudeCommand "definitely-not-a-claude-command" `
    -Purge `
    -Yes
  if ($LASTEXITCODE -ne 0) {
    throw "uninstall.ps1 exited with $LASTEXITCODE"
  }

  foreach ($removedPath in @($appDir, $dataDir, $nodeRoot, $toolsDir, $installRoot)) {
    if (Test-Path -LiteralPath $removedPath) {
      throw "Expected path to be removed: $removedPath"
    }
  }

  $configText = [System.IO.File]::ReadAllText($configPath)
  if ($configText -match "\[mcp_servers\.dinobrain\]") {
    throw "DinoBrain MCP section was not removed."
  }
  if ($configText -notmatch "\[mcp_servers\.other\]") {
    throw "Non-DinoBrain MCP section was not preserved."
  }
  if (Test-Path -LiteralPath "$configPath.bak-dinobrain-test") {
    throw "DinoBrain config backup was not removed in purge."
  }

  $parsedHooks = [System.IO.File]::ReadAllText($hooksPath) | ConvertFrom-Json
  $hooksText = $parsedHooks | ConvertTo-Json -Depth 20 -Compress
  if ($hooksText -match "dinobrain-user-prompt-hook\.ps1" -or $hooksText -match "Loading DinoBrain context") {
    throw "DinoBrain hook was not removed."
  }
  if ($hooksText -notmatch "echo old") {
    throw "Non-DinoBrain hook was not preserved."
  }
  if (Test-Path -LiteralPath "$hooksPath.bak-dinobrain-test") {
    throw "DinoBrain hooks backup was not removed in purge."
  }

  Write-Host "uninstall verification ok"
} finally {
  Remove-Item -LiteralPath $temp -Recurse -Force -ErrorAction SilentlyContinue
}
