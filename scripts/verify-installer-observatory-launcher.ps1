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
  [System.IO.File]::WriteAllText((Join-Path $appPath "scripts\start-codex-live-proof.ps1"), "# test`n")
  [System.IO.File]::WriteAllText((Join-Path $appPath "scripts\start-client-mcp-proof.ps1"), "# test`n")
  [System.IO.File]::WriteAllText((Join-Path $appPath "scripts\install-codex-managed-hook.ps1"), "# test`n")
  [System.IO.File]::WriteAllText((Join-Path $appPath "scripts\start-private-backup.ps1"), "# test`n")
  [System.IO.File]::WriteAllText((Join-Path $appPath "scripts\start-private-restore.ps1"), "# test`n")
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

  $diagnoseLaunchers = @(New-DinoBrainHookDiagnoseLauncher -InstallRoot $installRoot -AppPath $appPath -VaultPath $vaultPath -NodeRoot $nodeRoot -ConfigPath (Join-Path $temp "config.toml") -HooksPath (Join-Path $temp "hooks.json") -RequirementsPath (Join-Path $temp "requirements.toml"))
  if ($diagnoseLaunchers.Count -ne 2) {
    throw "Expected 2 hook diagnose launchers, got $($diagnoseLaunchers.Count)"
  }
  foreach ($launcher in $diagnoseLaunchers) {
    $text = [System.IO.File]::ReadAllText($launcher)
    if ($text -notmatch "diagnose-codex-hook\.ps1") {
      throw "Hook diagnose launcher does not call diagnose-codex-hook.ps1: $launcher"
    }
  }

  $approvalLaunchers = @(New-DinoBrainHookApprovalLauncher -InstallRoot $installRoot -AppPath $appPath -ConfigPath (Join-Path $temp "config.toml") -HooksPath (Join-Path $temp "hooks.json") -RequirementsPath (Join-Path $temp "requirements.toml"))
  if ($approvalLaunchers.Count -ne 2) {
    throw "Expected 2 hook approval launchers, got $($approvalLaunchers.Count)"
  }
  foreach ($launcher in $approvalLaunchers) {
    $text = [System.IO.File]::ReadAllText($launcher)
    if ($text -notmatch "start-codex-hook-approval\.ps1" -or $text -notmatch "RestartStaleCodex") {
      throw "Hook approval launcher does not run the approval flow: $launcher"
    }
  }

  $liveProofLaunchers = @(New-DinoBrainLiveProofLauncher -InstallRoot $installRoot -AppPath $appPath -VaultPath $vaultPath -NodeRoot $nodeRoot -ConfigPath (Join-Path $temp "config.toml") -HooksPath (Join-Path $temp "hooks.json") -RequirementsPath (Join-Path $temp "requirements.toml"))
  if ($liveProofLaunchers.Count -ne 2) {
    throw "Expected 2 live proof launchers, got $($liveProofLaunchers.Count)"
  }
  foreach ($launcher in $liveProofLaunchers) {
    $text = [System.IO.File]::ReadAllText($launcher)
    if ($text -notmatch "start-codex-live-proof\.ps1" -or $text -notmatch "node\.exe") {
      throw "Live proof launcher does not run the proof flow: $launcher"
    }
    if (-not $text.Contains($vaultPath) -or -not $text.Contains($appPath)) {
      throw "Live proof launcher does not contain expected app/data paths: $launcher"
    }
  }

  $directMcpProofLaunchers = @(New-DinoBrainDirectMcpProofLauncher -InstallRoot $installRoot -AppPath $appPath -VaultPath $vaultPath -NodeRoot $nodeRoot)
  if ($directMcpProofLaunchers.Count -ne 4) {
    throw "Expected 4 direct MCP proof launchers, got $($directMcpProofLaunchers.Count)"
  }
  foreach ($launcher in $directMcpProofLaunchers) {
    $text = [System.IO.File]::ReadAllText($launcher)
    if ($text -notmatch "start-client-mcp-proof\.ps1" -or $text -notmatch " -Agent (codex|claude)") {
      throw "Direct MCP proof launcher does not run the challenge flow: $launcher"
    }
    if (-not $text.Contains($vaultPath) -or -not $text.Contains($appPath) -or -not $text.Contains($nodeRoot)) {
      throw "Direct MCP proof launcher does not contain expected app/data/node paths: $launcher"
    }
  }

  $managedHookLaunchers = @(New-DinoBrainManagedHookLauncher -InstallRoot $installRoot -AppPath $appPath -VaultPath $vaultPath -RequirementsPath (Join-Path $temp "requirements.toml") -ManagedDir (Join-Path $temp "managed-hooks"))
  if ($managedHookLaunchers.Count -ne 2) {
    throw "Expected 2 managed hook launchers, got $($managedHookLaunchers.Count)"
  }
  foreach ($launcher in $managedHookLaunchers) {
    $text = [System.IO.File]::ReadAllText($launcher)
    if ($text -notmatch "install-codex-managed-hook\.ps1" -or $text -notmatch " -Elevate") {
      throw "Managed hook launcher does not run the elevated managed hook installer: $launcher"
    }
    if (-not $text.Contains($vaultPath) -or -not $text.Contains($appPath)) {
      throw "Managed hook launcher does not contain expected app/data paths: $launcher"
    }
  }

  $privateRecoveryLaunchers = @(New-DinoBrainPrivateRecoveryLaunchers -InstallRoot $installRoot -AppPath $appPath -VaultPath $vaultPath -NodeRoot $nodeRoot)
  if ($privateRecoveryLaunchers.Count -ne 4) {
    throw "Expected 4 private recovery launchers, got $($privateRecoveryLaunchers.Count)"
  }
  foreach ($launcher in $privateRecoveryLaunchers) {
    $text = [System.IO.File]::ReadAllText($launcher)
    if ($launcher -match "Backup" -and ($text -notmatch "start-private-backup\.ps1" -or $text -notmatch "IncludeCredentials")) {
      throw "Private backup launcher is incomplete: $launcher"
    }
    if ($launcher -match "Restore" -and ($text -notmatch "start-private-restore\.ps1" -or $text -notmatch "IncludeUserConfig")) {
      throw "Private restore launcher is incomplete: $launcher"
    }
    if (-not $text.Contains($vaultPath) -or -not $text.Contains($nodeRoot)) {
      throw "Private recovery launcher does not contain expected vault/node paths: $launcher"
    }
  }

  $uninstallLaunchers = @(New-DinoBrainUninstallLauncher -InstallRoot $installRoot -AppPath $appPath -VaultPath $vaultPath -ToolsDir (Split-Path -Parent $nodeRoot) -ConfigPath (Join-Path $temp "config.toml") -HooksPath (Join-Path $temp "hooks.json") -RequirementsPath (Join-Path $temp "requirements.toml") -ManagedHookDir (Join-Path $temp "managed-hooks") -ClaudeCommand "claude")
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
