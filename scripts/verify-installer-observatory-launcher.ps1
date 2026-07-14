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
  [System.IO.File]::WriteAllText((Join-Path $appPath "scripts\dinobrain-observatory.mjs"), "// test`n")
  [System.IO.File]::WriteAllText((Join-Path $appPath "DinoBrain Observatory.exe"), "test launcher")
  [System.IO.File]::WriteAllText((Join-Path $appPath "scripts\diagnose-codex-hook.ps1"), "# test`n")
  [System.IO.File]::WriteAllText((Join-Path $appPath "scripts\start-codex-hook-approval.ps1"), "# test`n")
  [System.IO.File]::WriteAllText((Join-Path $appPath "scripts\start-codex-live-proof.ps1"), "# test`n")
  [System.IO.File]::WriteAllText((Join-Path $appPath "scripts\start-client-mcp-proof.ps1"), "# test`n")
  [System.IO.File]::WriteAllText((Join-Path $appPath "scripts\start-clean-machine-equivalence-proof.ps1"), "# test`n")
  [System.IO.File]::WriteAllText((Join-Path $appPath "scripts\start-windows-sandbox-clean-machine-proof.ps1"), "# test`n")
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
    if ($text -notmatch "DinoBrain Observatory\.exe" -or $text -notmatch "--open") {
      throw "Launcher does not call the native Observatory executable: $launcher"
    }
    if (-not $text.Contains($appPath)) {
      throw "Launcher does not contain expected app path: $launcher"
    }
  }

  $nativeSource = Join-Path $temp "native-launcher.exe"
  [System.IO.File]::WriteAllText($nativeSource, "native launcher")
  $installedNative = Install-DinoBrainObservatoryNativeLauncher -AppPath $appPath -SourcePath $nativeSource
  if ($installedNative -ne (Join-Path $appPath "DinoBrain Observatory.exe") -or -not (Test-Path -LiteralPath $installedNative)) {
    throw "Native Observatory launcher was not installed into the app root"
  }

  $lockedTarget = Join-Path $appPath "DinoBrain Observatory.exe"
  [System.IO.File]::WriteAllText($lockedTarget, "known-good-launcher")
  $lock = [System.IO.File]::Open($lockedTarget, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::None)
  $replacementFailed = $false
  try {
    try { Install-DinoBrainObservatoryNativeLauncher -AppPath $appPath -SourcePath $nativeSource | Out-Null } catch { $replacementFailed = $true }
    if (-not $replacementFailed) {
      throw "Locked native launcher replacement did not preserve the known-good executable"
    }
  } finally { $lock.Dispose() }
  if ([System.IO.File]::ReadAllText($lockedTarget) -ne "known-good-launcher") { throw "Locked native launcher replacement did not preserve the known-good executable" }
  if (@(Get-ChildItem -LiteralPath $appPath -Filter "DinoBrain Observatory.exe.new-*" -ErrorAction SilentlyContinue).Count -ne 0) { throw "Locked native launcher replacement left a temporary file behind" }
  $installedNative = Install-DinoBrainObservatoryNativeLauncher -AppPath $appPath -SourcePath $nativeSource
  if ([System.IO.File]::ReadAllText($installedNative) -ne "native launcher") { throw "Native launcher replacement did not complete after the lock was released" }

  $hookCommandSource = [System.IO.File]::ReadAllText($installScript)
  if ($hookCommandSource -notmatch "--ensure-running" -or $hookCommandSource -notmatch 'Start-Process -FilePath \$launcherLiteral' -or $hookCommandSource -notmatch "--app-root" -or $hookCommandSource -notmatch "--data-dir") {
    throw "Codex/Claude hook command does not contain the non-blocking Observatory repair"
  }
  if ($hookCommandSource.IndexOf('`$env:DINOBRAIN_DATA_DIR = $vaultLiteral') -gt $hookCommandSource.IndexOf('Start-Process -FilePath $launcherLiteral')) {
    throw "Codex/Claude hook command starts the launcher before setting DINOBRAIN_DATA_DIR"
  }
  if ($hookCommandSource -notmatch "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run" -or $hookCommandSource -notmatch "SkipObservatoryStartup") {
    throw "Installer does not contain per-user Observatory startup registration and opt-out"
  }
  $launcherProject = Join-Path $root "installer\DinoBrainObservatoryLauncher\DinoBrainObservatoryLauncher.csproj"
  $projectText = [System.IO.File]::ReadAllText($launcherProject)
  if ($projectText -notmatch "SelfContained" -or $projectText -notmatch "PublishSingleFile") {
    throw "Native launcher project is not configured for self-contained single-file publishing"
  }
  if ($hookCommandSource -notmatch 'Save-DinoBrainInstallSnapshot -Transaction \$transaction -TargetPath \(Join-Path \$AppDir "DinoBrain Observatory.exe"\)' -or $hookCommandSource.LastIndexOf('Complete-DinoBrainInstallTransaction -Transaction $transaction') -gt $hookCommandSource.LastIndexOf('$postCommitObservatoryStartup =')) {
    throw "Native launcher snapshot or post-commit startup ordering is missing"
  }
  $nativeProgram = [System.IO.File]::ReadAllText((Join-Path $root "installer\DinoBrainObservatoryLauncher\Program.cs"))
  if ($nativeProgram -notmatch 'TryClaimBrowserOpen\(TimeSpan\.FromSeconds\(3\)\)' -or $nativeProgram -notmatch 'StopProcessTree\(hostProcess' -or $nativeProgram -notmatch 'HasExactPort') {
    throw "Native launcher does not contain debounce, timeout cleanup, and exact port matching safeguards"
  }
  if ($nativeProgram -notmatch 'new Semaphore\(1, 1,' -or $nativeProgram -match 'ReleaseMutex\(') {
    throw "Native launcher start serialization is not safe across async continuations"
  }
  $setupProjectText = [System.IO.File]::ReadAllText((Join-Path $root "installer\DinoBrainSetup\DinoBrainSetup.csproj"))
  $buildScriptText = [System.IO.File]::ReadAllText((Join-Path $root "scripts\build-windows-installer.ps1"))
  if ($setupProjectText -notmatch 'PublishObservatoryLauncher[\s\S]+--no-restore' -or $buildScriptText -notmatch 'dotnet restore \$launcherProject --runtime \$Runtime') {
    throw "Installer build does not explicitly restore the launcher once before offline nested publish"
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

  $cleanMachineProofLaunchers = @(New-DinoBrainCleanMachineProofLauncher -InstallRoot $installRoot -AppPath $appPath -VaultPath $vaultPath -NodeRoot $nodeRoot)
  if ($cleanMachineProofLaunchers.Count -ne 2) {
    throw "Expected 2 recovery-equivalence proof launchers, got $($cleanMachineProofLaunchers.Count)"
  }
  foreach ($launcher in $cleanMachineProofLaunchers) {
    $text = [System.IO.File]::ReadAllText($launcher)
    if ($text -notmatch "start-clean-machine-equivalence-proof\.ps1" -or $text -notmatch " -Mode both_clients") {
      throw "Recovery-equivalence proof launcher is incomplete: $launcher"
    }
    if (-not $text.Contains($vaultPath) -or -not $text.Contains($appPath) -or -not $text.Contains($nodeRoot)) {
      throw "Recovery-equivalence launcher does not contain expected app/data/node paths: $launcher"
    }
  }

  $windowsSandboxProofLaunchers = @(New-DinoBrainWindowsSandboxProofLauncher -InstallRoot $installRoot -AppPath $appPath)
  if ($windowsSandboxProofLaunchers.Count -ne 2) {
    throw "Expected 2 Windows Sandbox proof launchers, got $($windowsSandboxProofLaunchers.Count)"
  }
  foreach ($launcher in $windowsSandboxProofLaunchers) {
    $text = [System.IO.File]::ReadAllText($launcher)
    if ($text -notmatch "start-windows-sandbox-clean-machine-proof\.ps1") {
      throw "Windows Sandbox proof launcher is incomplete: $launcher"
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
