#Requires -Version 5.1
[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$root = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$dataRootValue = $env:DINOBRAIN_DATA_DIR
if ([string]::IsNullOrWhiteSpace($dataRootValue)) { $dataRootValue = Join-Path $root "..\dinobrain-data" }
$dataRoot = [System.IO.Path]::GetFullPath($dataRootValue)
$nodeVersion = "24.18.0"
$toolsDir = Join-Path $env:LOCALAPPDATA "DinoBrain\tools"
$nodeRoot = Join-Path $toolsDir "node-v$nodeVersion-win-x64"
if (-not (Test-Path -LiteralPath (Join-Path $nodeRoot "node.exe"))) {
  throw "Portable Node is required for the isolated install matrix: $nodeRoot"
}
if (-not (Test-Path -LiteralPath (Join-Path $dataRoot ".git"))) {
  throw "DinoBrain data repo is required for the isolated install matrix: $dataRoot"
}

function Invoke-MatrixGit {
  param([string]$WorkingDirectory, [string[]]$Arguments)
  $oldPreference = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  try {
    $output = @(& git -C $WorkingDirectory @Arguments 2>&1)
    $exitCode = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $oldPreference
  }
  if ($exitCode -ne 0) { throw "git $($Arguments -join ' ') failed:`n$($output -join "`n")" }
  return $output
}

function Write-MatrixText {
  param([string]$Path, [string]$Text)
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Path) | Out-Null
  [System.IO.File]::WriteAllText($Path, $Text, [System.Text.UTF8Encoding]::new($false))
}

function Get-MatrixManifest {
  param([string]$Path)
  if (-not (Test-Path -LiteralPath $Path)) { return "missing" }
  $rootPath = [System.IO.Path]::GetFullPath($Path)
  $rows = @(foreach ($file in Get-ChildItem -LiteralPath $rootPath -File -Recurse -Force | Sort-Object FullName) {
    $relative = $file.FullName.Substring($rootPath.Length).TrimStart('\').Replace('\', '/')
    "$relative|$($file.Length)|$((Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant())"
  })
  return ($rows -join "`n")
}

function Assert-Matrix {
  param([bool]$Condition, [string]$Message)
  if (-not $Condition) { throw $Message }
}

function Get-MatrixProcessTreeWorkingSet {
  param([int]$RootProcessId)

  $rows = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Select-Object ProcessId, ParentProcessId)
  $ids = New-Object 'System.Collections.Generic.HashSet[int]'
  [void]$ids.Add($RootProcessId)
  $changed = $true
  while ($changed) {
    $changed = $false
    foreach ($row in $rows) {
      if ($ids.Contains([int]$row.ParentProcessId) -and $ids.Add([int]$row.ProcessId)) {
        $changed = $true
      }
    }
  }

  $workingSet = [int64]0
  foreach ($processId in $ids) {
    $process = Get-Process -Id $processId -ErrorAction SilentlyContinue
    if ($null -ne $process) { $workingSet += [int64]$process.WorkingSet64 }
  }
  return $workingSet
}

function ConvertTo-MatrixProcessArgument {
  param([string]$Value)
  return '"' + $Value.Replace('"', '\"') + '"'
}

function Invoke-IsolatedInstaller {
  param(
    [string]$InstallScript,
    [string[]]$Arguments,
    [string]$FailurePoint = "",
    [switch]$ExpectFailure
  )
  $oldFailurePoint = $env:DINOBRAIN_INSTALL_TEST_FAILURE_POINT
  if ([string]::IsNullOrWhiteSpace($FailurePoint)) {
    Remove-Item Env:\DINOBRAIN_INSTALL_TEST_FAILURE_POINT -ErrorAction SilentlyContinue
  } else {
    $env:DINOBRAIN_INSTALL_TEST_FAILURE_POINT = $FailurePoint
  }
  $oldPreference = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  $stdoutPath = Join-Path ([System.IO.Path]::GetTempPath()) ("dinobrain-matrix-" + [guid]::NewGuid().ToString("N") + ".stdout.log")
  $stderrPath = Join-Path ([System.IO.Path]::GetTempPath()) ("dinobrain-matrix-" + [guid]::NewGuid().ToString("N") + ".stderr.log")
  $stopwatch = [System.Diagnostics.Stopwatch]::StartNew()
  $peakWorkingSet = [int64]0
  try {
    $processArguments = @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $InstallScript) + $Arguments
    $argumentLine = ($processArguments | ForEach-Object { ConvertTo-MatrixProcessArgument $_ }) -join " "
    $process = Start-Process -FilePath "powershell.exe" -ArgumentList $argumentLine -PassThru -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath
    $processHandle = $process.Handle
    while (-not $process.HasExited) {
      $workingSet = Get-MatrixProcessTreeWorkingSet -RootProcessId $process.Id
      if ($workingSet -gt $peakWorkingSet) { $peakWorkingSet = $workingSet }
      Start-Sleep -Milliseconds 1000
      $process.Refresh()
    }
    $process.WaitForExit()
    $workingSet = Get-MatrixProcessTreeWorkingSet -RootProcessId $process.Id
    if ($workingSet -gt $peakWorkingSet) { $peakWorkingSet = $workingSet }
    $exitCode = $process.ExitCode
    $output = @()
    if (Test-Path -LiteralPath $stdoutPath) { $output += @(Get-Content -LiteralPath $stdoutPath -Tail 80) }
    if (Test-Path -LiteralPath $stderrPath) { $output += @(Get-Content -LiteralPath $stderrPath -Tail 80) }
  } finally {
    $stopwatch.Stop()
    $ErrorActionPreference = $oldPreference
    if ($null -eq $oldFailurePoint) { Remove-Item Env:\DINOBRAIN_INSTALL_TEST_FAILURE_POINT -ErrorAction SilentlyContinue } else { $env:DINOBRAIN_INSTALL_TEST_FAILURE_POINT = $oldFailurePoint }
    Remove-Item -LiteralPath $stdoutPath, $stderrPath -Force -ErrorAction SilentlyContinue
  }
  if ($ExpectFailure) {
    if ($exitCode -eq 0) { throw "Installer unexpectedly succeeded at failure point $FailurePoint" }
  } elseif ($exitCode -ne 0) {
    throw "Installer failed with exit code $exitCode`n$(@($output | Select-Object -Last 80) -join "`n")"
  }
  return [pscustomobject]@{
    ExitCode = $exitCode
    Tail = @($output | Select-Object -Last 30)
    ElapsedMs = $stopwatch.ElapsedMilliseconds
    PeakWorkingSetMb = [math]::Round($peakWorkingSet / 1MB, 1)
  }
}

$temp = Join-Path $HOME ("dbm-" + [guid]::NewGuid().ToString("N").Substring(0, 10))
New-Item -ItemType Directory -Force -Path $temp | Out-Null
try {
  $appSeed = Join-Path $temp "app-seed"
  $appOrigin = Join-Path $temp "app-origin.git"
  Invoke-MatrixGit -WorkingDirectory $temp -Arguments @("clone", $root, $appSeed) | Out-Null
  $overlayPaths = @(
    "docs/INSTALL.md",
    "docs/OS_COMPLETION_CONDITIONS.md",
    "docs/OS_COMPLETION_EXECUTION_PLAN_20260710.md",
    "docs/TRANSACTIONAL_INSTALLER.md",
    "docs/VERIFICATION.md",
    "install.ps1",
    "installer/DinoBrainSetup/SetupForm.cs",
    "package.json",
    "scripts/build-windows-installer.ps1",
    "scripts/verify-answer-quality.mjs",
    "src/hybrid-retrieval.ts",
    "src/answer-quality.ts",
    "src/completion-registry.ts",
    "scripts/verify-contextual-hybrid-retrieval.mjs",
    "scripts/verify-installer-native-result.ps1",
    "scripts/verify-installer-transaction.ps1",
    "scripts/verify-uninstall.ps1",
    "scripts/verify-clean-machine-install-matrix.ps1",
    "uninstall.ps1"
  )
  foreach ($relativePath in $overlayPaths) {
    $sourcePath = Join-Path $root $relativePath
    $targetPath = Join-Path $appSeed $relativePath
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $targetPath) | Out-Null
    Copy-Item -LiteralPath $sourcePath -Destination $targetPath -Force
  }
  Invoke-MatrixGit -WorkingDirectory $appSeed -Arguments @("config", "user.email", "installer-matrix@example.invalid") | Out-Null
  Invoke-MatrixGit -WorkingDirectory $appSeed -Arguments @("config", "user.name", "DinoBrain Installer Matrix") | Out-Null
  Invoke-MatrixGit -WorkingDirectory $appSeed -Arguments (@("add", "--") + $overlayPaths) | Out-Null
  Invoke-MatrixGit -WorkingDirectory $appSeed -Arguments @("commit", "-m", "fixture: transactional installer") | Out-Null
  Invoke-MatrixGit -WorkingDirectory $temp -Arguments @("clone", "--bare", $appSeed, $appOrigin) | Out-Null
  Invoke-MatrixGit -WorkingDirectory $appSeed -Arguments @("remote", "set-url", "origin", $appOrigin) | Out-Null

  $installRoot = Join-Path $temp "install"
  $userRoot = Join-Path $temp "user"
  $codexConfig = Join-Path $userRoot ".codex\config.toml"
  $codexHooks = Join-Path $userRoot ".codex\hooks.json"
  $codexRequirements = Join-Path $temp "programdata\requirements.toml"
  $managedHookDir = Join-Path $temp "programdata\DinoBrainHooks"
  $claudeSettings = Join-Path $userRoot ".claude\settings.json"
  Write-MatrixText -Path $codexConfig -Text "model = 'matrix-test'`r`n"
  Write-MatrixText -Path $codexHooks -Text "{}`r`n"

  $installArguments = @(
    "-InstallRoot", $installRoot,
    "-AppRepo", $appOrigin,
    "-DataRepo", $dataRoot,
    "-AppRef", "main",
    "-DataRef", "main",
    "-ToolsDir", $toolsDir,
    "-CodexConfigPath", $codexConfig,
    "-CodexHooksPath", $codexHooks,
    "-CodexRequirementsPath", $codexRequirements,
    "-CodexManagedHookDir", $managedHookDir,
    "-ClaudeSettingsPath", $claudeSettings,
    "-SkipCodexManagedHookConfig",
    "-SkipCodexRestartFlow",
    "-SkipClaudeCodeConfig"
  )

  $installScript = Join-Path $root "install.ps1"
  Write-Host "[matrix 1/5] clean install"
  $clean = Invoke-IsolatedInstaller -InstallScript $installScript -Arguments $installArguments
  $resultPath = Join-Path $installRoot "dinobrain-install-result.json"
  $cleanResult = Get-Content -LiteralPath $resultPath -Raw | ConvertFrom-Json
  Assert-Matrix ($cleanResult.status -eq "complete") "clean install did not complete"
  Assert-Matrix ($cleanResult.full_equivalence -eq $true) "clean install did not prove git-backed stage verification"
  Assert-Matrix (Test-Path -LiteralPath (Join-Path $installRoot "dinobrain\dist\index.js")) "clean install did not promote the built app"
  Assert-Matrix (Test-Path -LiteralPath (Join-Path $installRoot "dinobrain-data\.git")) "clean install did not promote the data repo"

  $localDataPath = Join-Path $installRoot "dinobrain-data\local-user-state.txt"
  Write-MatrixText -Path $localDataPath -Text "preserve across reinstall`n"
  Write-Host "[matrix 2/5] reinstall with local data"
  $reinstall = Invoke-IsolatedInstaller -InstallScript $installScript -Arguments $installArguments
  $reinstallResult = Get-Content -LiteralPath $resultPath -Raw | ConvertFrom-Json
  Assert-Matrix ($reinstallResult.status -eq "complete") "reinstall did not complete"
  Assert-Matrix (Test-Path -LiteralPath $localDataPath) "reinstall discarded local data state"

  $marker = Join-Path $appSeed "docs\transaction-update-marker.txt"
  Write-MatrixText -Path $marker -Text "transactional update v2`n"
  Invoke-MatrixGit -WorkingDirectory $appSeed -Arguments @("add", "docs/transaction-update-marker.txt") | Out-Null
  Invoke-MatrixGit -WorkingDirectory $appSeed -Arguments @("commit", "-m", "fixture: installer update") | Out-Null
  Invoke-MatrixGit -WorkingDirectory $appSeed -Arguments @("push", "origin", "main") | Out-Null
  $updateCommit = (& git -C $appSeed rev-parse HEAD).Trim()
  Write-Host "[matrix 3/5] immutable update"
  $update = Invoke-IsolatedInstaller -InstallScript $installScript -Arguments $installArguments
  $updateResult = Get-Content -LiteralPath $resultPath -Raw | ConvertFrom-Json
  Assert-Matrix ($updateResult.app.resolved_commit -eq $updateCommit) "update did not promote the newly resolved immutable commit"
  Assert-Matrix (Test-Path -LiteralPath (Join-Path $installRoot "dinobrain\docs\transaction-update-marker.txt")) "update marker was not promoted"
  Assert-Matrix (Test-Path -LiteralPath $localDataPath) "update discarded local data state"

  $appBeforeFailure = Get-MatrixManifest (Join-Path $installRoot "dinobrain")
  $dataBeforeFailure = Get-MatrixManifest (Join-Path $installRoot "dinobrain-data")
  $configBeforeFailure = [System.IO.File]::ReadAllText($codexConfig)
  $hooksBeforeFailure = [System.IO.File]::ReadAllText($codexHooks)
  Write-Host "[matrix 4/5] induced failure and byte-exact rollback"
  $failed = Invoke-IsolatedInstaller -InstallScript $installScript -Arguments $installArguments -FailurePoint "after_config" -ExpectFailure
  $failedResult = Get-Content -LiteralPath $resultPath -Raw | ConvertFrom-Json
  Assert-Matrix ($failedResult.status -eq "rolled_back") "injected failure did not report rolled_back"
  Assert-Matrix ((Get-MatrixManifest (Join-Path $installRoot "dinobrain")) -eq $appBeforeFailure) "app bytes changed after rollback"
  Assert-Matrix ((Get-MatrixManifest (Join-Path $installRoot "dinobrain-data")) -eq $dataBeforeFailure) "data bytes changed after rollback"
  Assert-Matrix ([System.IO.File]::ReadAllText($codexConfig) -eq $configBeforeFailure) "Codex config bytes changed after rollback"
  Assert-Matrix ([System.IO.File]::ReadAllText($codexHooks) -eq $hooksBeforeFailure) "Codex hooks bytes changed after rollback"

  Write-Host "[matrix 5/5] normal uninstall preserves repositories"
  $uninstallOutput = @(& powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $root "uninstall.ps1") -InstallRoot $installRoot -ToolsDir $toolsDir -CodexConfigPath $codexConfig -CodexHooksPath $codexHooks -CodexRequirementsPath $codexRequirements -CodexManagedHookDir $managedHookDir -SkipCodexManagedHookConfig -SkipClaudeCodeConfig 2>&1)
  if ($LASTEXITCODE -ne 0) { throw "normal uninstall failed:`n$($uninstallOutput -join "`n")" }
  Assert-Matrix (Test-Path -LiteralPath (Join-Path $installRoot "dinobrain")) "normal uninstall removed the app repo"
  Assert-Matrix (Test-Path -LiteralPath (Join-Path $installRoot "dinobrain-data")) "normal uninstall removed the data repo"
  Assert-Matrix (-not ([System.IO.File]::ReadAllText($codexConfig) -match "mcp_servers\.dinobrain")) "normal uninstall left Codex MCP registration"
  Assert-Matrix (-not ([System.IO.File]::ReadAllText($codexHooks) -match "dinobrain-user-prompt-hook")) "normal uninstall left the prompt hook"

  [pscustomobject]@{
    ok = $true
    matrix_version = "clean_machine_install_matrix_v1"
    clean_install = "pass"
    reinstall = "pass"
    update = "pass"
    induced_failure_rollback = "pass"
    normal_uninstall_preserves_data = "pass"
    purge_verifier = "scripts/verify-uninstall.ps1"
    app_commit = $updateCommit
    data_commit = $cleanResult.data.resolved_commit
    phase_elapsed_ms = [ordered]@{
      clean_install = $clean.ElapsedMs
      reinstall = $reinstall.ElapsedMs
      update = $update.ElapsedMs
      induced_failure = $failed.ElapsedMs
    }
    phase_peak_working_set_mb = [ordered]@{
      clean_install = $clean.PeakWorkingSetMb
      reinstall = $reinstall.PeakWorkingSetMb
      update = $update.PeakWorkingSetMb
      induced_failure = $failed.PeakWorkingSetMb
    }
    peak_working_set_mb = (@($clean.PeakWorkingSetMb, $reinstall.PeakWorkingSetMb, $update.PeakWorkingSetMb, $failed.PeakWorkingSetMb) | Measure-Object -Maximum).Maximum
  } | ConvertTo-Json -Depth 6
} finally {
  Remove-Item -LiteralPath $temp -Recurse -Force -ErrorAction SilentlyContinue
}
