#Requires -Version 5.1
[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$root = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$installScript = Join-Path $root "install.ps1"
$source = [System.IO.File]::ReadAllText($installScript)
$start = $source.IndexOf("function New-DinoBrainObservatoryLauncher")
$end = $source.IndexOf("function Set-DinoBrainClaudeCodeConfig")
if ($start -lt 0 -or $end -lt 0 -or $end -le $start) {
  throw "Could not locate installer launcher functions."
}

Invoke-Expression $source.Substring($start, $end - $start)

$temp = Join-Path ([System.IO.Path]::GetTempPath()) ("dinobrain-observatory-launcher-verify-" + [guid]::NewGuid().ToString("N"))
try {
  $installRoot = Join-Path $temp "root"
  $appPath = Join-Path $installRoot "dinobrain"
  $vaultPath = Join-Path $installRoot "dinobrain-data"
  $nodeRoot = Join-Path $temp "node-v24.18.0-win-x64"
  New-Item -ItemType Directory -Force -Path (Join-Path $appPath "scripts"), $vaultPath, $nodeRoot | Out-Null
  [System.IO.File]::WriteAllText((Join-Path $appPath "scripts\start-dinobrain-observatory.ps1"), "# test`n")
  [System.IO.File]::WriteAllText((Join-Path $appPath "scripts\diagnose-codex-hook.ps1"), "# test`n")
  [System.IO.File]::WriteAllText((Join-Path $appPath "scripts\start-codex-hook-approval.ps1"), "# test`n")
  [System.IO.File]::WriteAllText((Join-Path $appPath "uninstall.ps1"), "# test`n")

  $launchers = @(New-DinoBrainObservatoryLauncher -InstallRoot $installRoot -AppPath $appPath -VaultPath $vaultPath -NodeRoot $nodeRoot)
  if ($launchers.Count -ne 2) {
    throw "Expected 2 launchers, got $($launchers.Count)"
  }
  foreach ($launcher in $launchers) {
    if (-not (Test-Path -LiteralPath $launcher)) {
      throw "Launcher was not created: $launcher"
    }
    $text = [System.IO.File]::ReadAllText($launcher)
    if ($text -notmatch "start-dinobrain-observatory\.ps1") {
      throw "Launcher does not call the Observatory script: $launcher"
    }
    if (-not $text.Contains($vaultPath) -or -not $text.Contains($nodeRoot)) {
      throw "Launcher does not contain expected vault/node paths: $launcher"
    }
  }

  $diagnoseLaunchers = @(New-DinoBrainHookDiagnoseLauncher -InstallRoot $installRoot -AppPath $appPath -VaultPath $vaultPath -NodeRoot $nodeRoot -ConfigPath (Join-Path $temp "config.toml") -HooksPath (Join-Path $temp "hooks.json"))
  if ($diagnoseLaunchers.Count -ne 2) {
    throw "Expected 2 hook diagnose launchers, got $($diagnoseLaunchers.Count)"
  }
  foreach ($launcher in $diagnoseLaunchers) {
    $text = [System.IO.File]::ReadAllText($launcher)
    if ($text -notmatch "diagnose-codex-hook\.ps1") {
      throw "Hook diagnose launcher does not call diagnose-codex-hook.ps1: $launcher"
    }
  }

  $approvalLaunchers = @(New-DinoBrainHookApprovalLauncher -InstallRoot $installRoot -AppPath $appPath -ConfigPath (Join-Path $temp "config.toml") -HooksPath (Join-Path $temp "hooks.json"))
  if ($approvalLaunchers.Count -ne 2) {
    throw "Expected 2 hook approval launchers, got $($approvalLaunchers.Count)"
  }
  foreach ($launcher in $approvalLaunchers) {
    $text = [System.IO.File]::ReadAllText($launcher)
    if ($text -notmatch "start-codex-hook-approval\.ps1" -or $text -notmatch "RestartStaleCodex") {
      throw "Hook approval launcher does not run the approval flow: $launcher"
    }
  }

  $uninstallLaunchers = @(New-DinoBrainUninstallLauncher -InstallRoot $installRoot -AppPath $appPath -VaultPath $vaultPath -ToolsDir (Split-Path -Parent $nodeRoot) -ConfigPath (Join-Path $temp "config.toml") -HooksPath (Join-Path $temp "hooks.json") -ClaudeCommand "claude")
  if ($uninstallLaunchers.Count -ne 2) {
    throw "Expected 2 uninstall launchers, got $($uninstallLaunchers.Count)"
  }
  foreach ($launcher in $uninstallLaunchers) {
    $text = [System.IO.File]::ReadAllText($launcher)
    if ($text -notmatch "DinoBrainUninstall-" -or $text -notmatch " -Purge") {
      throw "Uninstall launcher does not run purge through a temp script: $launcher"
    }
    if (-not $text.Contains($appPath) -or -not $text.Contains($vaultPath)) {
      throw "Uninstall launcher does not contain expected app/data paths: $launcher"
    }
  }

  Write-Host "installer launcher verification ok"
} finally {
  Remove-Item -LiteralPath $temp -Recurse -Force -ErrorAction SilentlyContinue
}
