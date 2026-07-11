#Requires -Version 5.1
[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$root = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$installScript = Join-Path $root "install.ps1"
$source = [System.IO.File]::ReadAllText($installScript)
$start = $source.IndexOf("function Get-FullPath")
$end = $source.IndexOf("function Install-PortableNode")
if ($start -lt 0 -or $end -le $start) {
  throw "Could not locate installer transaction functions."
}
Invoke-Expression $source.Substring($start, $end - $start)

function Invoke-TestGit {
  param(
    [Parameter(Mandatory = $true)][string]$WorkingDirectory,
    [Parameter(Mandatory = $true)][string[]]$Arguments
  )
  $oldPreference = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  try {
    & git -C $WorkingDirectory @Arguments 2>&1 | Out-Null
    $exitCode = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $oldPreference
  }
  if ($exitCode -ne 0) { throw "git $($Arguments -join ' ') failed in $WorkingDirectory" }
}

function Write-TestText {
  param([string]$Path, [string]$Text)
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Path) | Out-Null
  [System.IO.File]::WriteAllText($Path, $Text, [System.Text.UTF8Encoding]::new($false))
}

function New-TestRemote {
  param([string]$Base, [string]$Name)
  $seed = Join-Path $Base "$Name-seed"
  $origin = Join-Path $Base "$Name-origin.git"
  New-Item -ItemType Directory -Force -Path $seed | Out-Null
  Invoke-TestGit -WorkingDirectory $Base -Arguments @("init", $seed)
  Invoke-TestGit -WorkingDirectory $seed -Arguments @("checkout", "-b", "main")
  Invoke-TestGit -WorkingDirectory $seed -Arguments @("config", "user.email", "installer-test@example.invalid")
  Invoke-TestGit -WorkingDirectory $seed -Arguments @("config", "user.name", "DinoBrain Installer Test")
  Write-TestText -Path (Join-Path $seed "state.txt") -Text "$Name-v1`n"
  Invoke-TestGit -WorkingDirectory $seed -Arguments @("add", "state.txt")
  Invoke-TestGit -WorkingDirectory $seed -Arguments @("commit", "-m", "v1")
  $commit = (& git -C $seed rev-parse HEAD).Trim()
  Invoke-TestGit -WorkingDirectory $Base -Arguments @("init", "--bare", $origin)
  Invoke-TestGit -WorkingDirectory $seed -Arguments @("remote", "add", "origin", $origin)
  Invoke-TestGit -WorkingDirectory $seed -Arguments @("push", "-u", "origin", "main")
  Invoke-TestGit -WorkingDirectory $origin -Arguments @("symbolic-ref", "HEAD", "refs/heads/main")
  return [pscustomobject]@{ Seed = $seed; Origin = $origin; Commit = $commit }
}

function Add-TestRemoteCommit {
  param([Parameter(Mandatory = $true)]$Remote, [string]$Text)
  Write-TestText -Path (Join-Path $Remote.Seed "state.txt") -Text $Text
  Invoke-TestGit -WorkingDirectory $Remote.Seed -Arguments @("add", "state.txt")
  Invoke-TestGit -WorkingDirectory $Remote.Seed -Arguments @("commit", "-m", $Text.Trim())
  Invoke-TestGit -WorkingDirectory $Remote.Seed -Arguments @("push", "origin", "main")
  return (& git -C $Remote.Seed rev-parse HEAD).Trim()
}

function Get-TreeManifest {
  param([string]$Path)
  if (-not (Test-Path -LiteralPath $Path)) { return "missing" }
  $rows = foreach ($file in Get-ChildItem -LiteralPath $Path -File -Recurse -Force | Sort-Object FullName) {
    $relative = $file.FullName.Substring((Get-FullPath $Path).Length).TrimStart('\').Replace('\', '/')
    "$relative|$($file.Length)|$((Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant())"
  }
  return ($rows -join "`n")
}

function Assert-Equal {
  param($Actual, $Expected, [string]$Message)
  if ($Actual -ne $Expected) { throw "$Message`nExpected: $Expected`nActual: $Actual" }
}

if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
  throw "git is required for installer transaction verification"
}

$temp = Join-Path ([System.IO.Path]::GetTempPath()) ("dinobrain-installer-transaction-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Force -Path $temp | Out-Null
try {
  $appRemote = New-TestRemote -Base $temp -Name "app"
  $dataRemote = New-TestRemote -Base $temp -Name "data"
  $installRoot = Join-Path $temp "existing-install"
  $appTarget = Join-Path $installRoot "dinobrain"
  $dataTarget = Join-Path $installRoot "dinobrain-data"
  New-Item -ItemType Directory -Force -Path $installRoot | Out-Null
  Invoke-TestGit -WorkingDirectory $installRoot -Arguments @("clone", $appRemote.Origin, $appTarget)
  Invoke-TestGit -WorkingDirectory $installRoot -Arguments @("clone", $dataRemote.Origin, $dataTarget)
  Write-TestText -Path (Join-Path $dataTarget "local-untracked.txt") -Text "must survive rollback and reinstall`n"
  $configPath = Join-Path $temp "user\config.toml"
  Write-TestText -Path $configPath -Text "existing=true`n"
  $appBefore = Get-TreeManifest $appTarget
  $dataBefore = Get-TreeManifest $dataTarget
  $configBefore = [System.IO.File]::ReadAllText($configPath)

  $appResolution = Resolve-DinoBrainImmutableRef -Name "app" -RepoUrl $appRemote.Origin -Ref "main"
  $dataResolution = Resolve-DinoBrainImmutableRef -Name "data" -RepoUrl $dataRemote.Origin -Ref "main"
  $transaction = New-DinoBrainInstallTransaction -InstallRoot $installRoot -AppPath $appTarget -VaultPath $dataTarget -AppResolution $appResolution -DataResolution $dataResolution
  Prepare-DinoBrainRepoStage -Name "app" -RepoUrl $appRemote.Origin -TargetDir $appTarget -StageDir $transaction.StageAppPath -RequestedRef "main" -ResolvedCommit $appResolution.resolved_commit
  Prepare-DinoBrainRepoStage -Name "data" -RepoUrl $dataRemote.Origin -TargetDir $dataTarget -StageDir $transaction.StageDataPath -RequestedRef "main" -ResolvedCommit $dataResolution.resolved_commit
  if (-not (Test-Path -LiteralPath (Join-Path $transaction.StageDataPath "local-untracked.txt"))) {
    throw "dirty local data was not preserved in the staged copy"
  }
  Write-TestText -Path (Join-Path $transaction.StageAppPath "build-proof.txt") -Text "verified stage`n"
  Write-TestText -Path (Join-Path $transaction.StageDataPath ".dino\index\stage-proof.txt") -Text "verified index`n"
  Save-DinoBrainInstallSnapshot -Transaction $transaction -TargetPath $configPath
  Promote-DinoBrainInstallTransaction -Transaction $transaction
  Write-TestText -Path $configPath -Text "mutated=true`n"
  Rollback-DinoBrainInstallTransaction -Transaction $transaction -ErrorRecord "injected failure after config"
  Assert-Equal (Get-TreeManifest $appTarget) $appBefore "app tree did not roll back byte-for-byte"
  Assert-Equal (Get-TreeManifest $dataTarget) $dataBefore "data tree did not roll back byte-for-byte"
  Assert-Equal ([System.IO.File]::ReadAllText($configPath)) $configBefore "config did not roll back byte-for-byte"
  $rollbackResult = Get-Content -LiteralPath $transaction.ResultPath -Raw | ConvertFrom-Json
  Assert-Equal $rollbackResult.status "rolled_back" "rollback result status mismatch"

  $frozenResolution = Resolve-DinoBrainImmutableRef -Name "app" -RepoUrl $appRemote.Origin -Ref "main"
  $newCommit = Add-TestRemoteCommit -Remote $appRemote -Text "app-v2`n"
  if ($newCommit -eq $frozenResolution.resolved_commit) { throw "fixture branch did not move" }
  $frozenRoot = Join-Path $temp "frozen-install"
  $frozenApp = Join-Path $frozenRoot "dinobrain"
  $frozenData = Join-Path $frozenRoot "dinobrain-data"
  $latestDataResolution = Resolve-DinoBrainImmutableRef -Name "data" -RepoUrl $dataRemote.Origin -Ref "main"
  $frozenTransaction = New-DinoBrainInstallTransaction -InstallRoot $frozenRoot -AppPath $frozenApp -VaultPath $frozenData -AppResolution $frozenResolution -DataResolution $latestDataResolution
  Prepare-DinoBrainRepoStage -Name "app" -RepoUrl $appRemote.Origin -TargetDir $frozenApp -StageDir $frozenTransaction.StageAppPath -RequestedRef "main" -ResolvedCommit $frozenResolution.resolved_commit
  Prepare-DinoBrainRepoStage -Name "data" -RepoUrl $dataRemote.Origin -TargetDir $frozenData -StageDir $frozenTransaction.StageDataPath -RequestedRef "main" -ResolvedCommit $latestDataResolution.resolved_commit
  Assert-Equal ((& git -C $frozenTransaction.StageAppPath rev-parse HEAD).Trim()) $frozenResolution.resolved_commit "stage followed a moving branch instead of the frozen commit"
  $frozenTransaction.StageVerified = $true
  Promote-DinoBrainInstallTransaction -Transaction $frozenTransaction
  Complete-DinoBrainInstallTransaction -Transaction $frozenTransaction
  Assert-Equal ((& git -C $frozenApp rev-parse HEAD).Trim()) $frozenResolution.resolved_commit "promoted app commit mismatch"
  Assert-Equal ((& git -C $frozenData rev-parse HEAD).Trim()) $latestDataResolution.resolved_commit "promoted data commit mismatch"
  $completeResult = Get-Content -LiteralPath $frozenTransaction.ResultPath -Raw | ConvertFrom-Json
  Assert-Equal $completeResult.status "complete" "complete result status mismatch"
  if (-not $completeResult.full_equivalence) { throw "verified git-backed transaction did not report full equivalence" }

  $interruptedRoot = Join-Path $temp "interrupted-install"
  $interruptedApp = Join-Path $interruptedRoot "dinobrain"
  $interruptedData = Join-Path $interruptedRoot "dinobrain-data"
  New-Item -ItemType Directory -Force -Path $interruptedRoot | Out-Null
  Invoke-TestGit -WorkingDirectory $interruptedRoot -Arguments @("clone", $appRemote.Origin, $interruptedApp)
  Invoke-TestGit -WorkingDirectory $interruptedRoot -Arguments @("clone", $dataRemote.Origin, $interruptedData)
  $interruptedAppBefore = Get-TreeManifest $interruptedApp
  $interruptedDataBefore = Get-TreeManifest $interruptedData
  $interruptedConfig = Join-Path $temp "interrupted-user\config.toml"
  Write-TestText -Path $interruptedConfig -Text "original-interrupted-config=true`n"
  $interruptedConfigBefore = [System.IO.File]::ReadAllText($interruptedConfig)
  $interruptedAppResolution = Resolve-DinoBrainImmutableRef -Name "app" -RepoUrl $appRemote.Origin -Ref "main"
  $interruptedDataResolution = Resolve-DinoBrainImmutableRef -Name "data" -RepoUrl $dataRemote.Origin -Ref "main"
  $interruptedTransaction = New-DinoBrainInstallTransaction -InstallRoot $interruptedRoot -AppPath $interruptedApp -VaultPath $interruptedData -AppResolution $interruptedAppResolution -DataResolution $interruptedDataResolution
  Prepare-DinoBrainRepoStage -Name "app" -RepoUrl $appRemote.Origin -TargetDir $interruptedApp -StageDir $interruptedTransaction.StageAppPath -RequestedRef "main" -ResolvedCommit $interruptedAppResolution.resolved_commit
  Prepare-DinoBrainRepoStage -Name "data" -RepoUrl $dataRemote.Origin -TargetDir $interruptedData -StageDir $interruptedTransaction.StageDataPath -RequestedRef "main" -ResolvedCommit $interruptedDataResolution.resolved_commit
  Save-DinoBrainInstallSnapshot -Transaction $interruptedTransaction -TargetPath $interruptedConfig
  Write-TestText -Path (Join-Path $interruptedTransaction.Root "verify-config\temporary-secret.txt") -Text "remove after recovery`n"
  Write-TestText -Path (Join-Path $interruptedTransaction.Root "promotion-config\temporary-secret.txt") -Text "remove after recovery`n"
  Move-Item -LiteralPath $interruptedApp -Destination $interruptedTransaction.BackupAppPath
  Move-Item -LiteralPath $interruptedTransaction.StageAppPath -Destination $interruptedApp
  Write-TestText -Path $interruptedConfig -Text "mutated-interrupted-config=true`n"
  Recover-DinoBrainInterruptedInstallTransactions -InstallRoot $interruptedRoot -ExpectedAppPath $interruptedApp -ExpectedDataPath $interruptedData -AllowedSnapshotPaths @($interruptedConfig)
  Assert-Equal (Get-TreeManifest $interruptedApp) $interruptedAppBefore "interrupted promotion did not restore the app byte-for-byte"
  Assert-Equal (Get-TreeManifest $interruptedData) $interruptedDataBefore "interrupted promotion changed the untouched data target"
  Assert-Equal ([System.IO.File]::ReadAllText($interruptedConfig)) $interruptedConfigBefore "interrupted config snapshot was not restored byte-for-byte"
  if (Test-Path -LiteralPath (Join-Path $interruptedTransaction.Root "snapshots")) { throw "interrupted snapshot copies were not removed after restore" }
  if (Test-Path -LiteralPath (Join-Path $interruptedTransaction.Root "verify-config")) { throw "interrupted verify config copies were not removed" }
  if (Test-Path -LiteralPath (Join-Path $interruptedTransaction.Root "promotion-config")) { throw "interrupted promotion config copies were not removed" }
  $interruptedResult = Get-Content -LiteralPath $interruptedTransaction.ResultPath -Raw | ConvertFrom-Json
  Assert-Equal $interruptedResult.status "rolled_back" "interrupted transaction did not settle as rolled_back"
  if (-not $interruptedResult.recovered_from_interrupt) { throw "interrupted transaction recovery was not recorded" }
  if (@($interruptedResult.recovery_quarantine_paths).Count -lt 1) { throw "interrupted promoted bytes were not preserved in recovery quarantine" }
  Recover-DinoBrainInterruptedInstallTransactions -InstallRoot $interruptedRoot -ExpectedAppPath $interruptedApp -ExpectedDataPath $interruptedData -AllowedSnapshotPaths @($interruptedConfig)

  $lock = Enter-DinoBrainInstallLock -InstallRoot $interruptedRoot
  $secondLockBlocked = $false
  $secondLock = $null
  try {
    try { $secondLock = Enter-DinoBrainInstallLock -InstallRoot $interruptedRoot } catch { $secondLockBlocked = $true }
    if ($null -ne $secondLock) { Exit-DinoBrainInstallLock -LockHandle $secondLock }
  } finally {
    Exit-DinoBrainInstallLock -LockHandle $lock
  }
  if (-not $secondLockBlocked) { throw "concurrent installer lock did not fail closed" }

  $dirtyRoot = Join-Path $temp "dirty-update"
  $dirtyApp = Join-Path $dirtyRoot "dinobrain"
  $dirtyData = Join-Path $dirtyRoot "dinobrain-data"
  New-Item -ItemType Directory -Force -Path $dirtyRoot | Out-Null
  Invoke-TestGit -WorkingDirectory $dirtyRoot -Arguments @("clone", $appRemote.Origin, $dirtyApp)
  Invoke-TestGit -WorkingDirectory $dirtyApp -Arguments @("checkout", $frozenResolution.resolved_commit)
  Write-TestText -Path (Join-Path $dirtyApp "local-change.txt") -Text "do not discard`n"
  $dirtyBefore = Get-TreeManifest $dirtyApp
  $latestAppResolution = Resolve-DinoBrainImmutableRef -Name "app" -RepoUrl $appRemote.Origin -Ref "main"
  $dirtyTransaction = New-DinoBrainInstallTransaction -InstallRoot $dirtyRoot -AppPath $dirtyApp -VaultPath $dirtyData -AppResolution $latestAppResolution -DataResolution $latestDataResolution
  $blocked = $false
  try {
    Prepare-DinoBrainRepoStage -Name "app" -RepoUrl $appRemote.Origin -TargetDir $dirtyApp -StageDir $dirtyTransaction.StageAppPath -RequestedRef "main" -ResolvedCommit $latestAppResolution.resolved_commit
  } catch {
    $blocked = $_.Exception.Message -match "local change"
  }
  if (-not $blocked) { throw "dirty app update was not blocked" }
  Rollback-DinoBrainInstallTransaction -Transaction $dirtyTransaction -ErrorRecord "expected dirty update refusal"
  Assert-Equal (Get-TreeManifest $dirtyApp) $dirtyBefore "dirty app target changed despite fail-closed staging"

  [pscustomobject]@{
    ok = $true
    rollback_exact = $true
    dirty_data_preserved = $true
    moving_branch_frozen = $true
    dirty_update_fail_closed = $true
    new_install_complete = $true
    interrupted_recovery_exact = $true
    concurrent_installer_blocked = $true
    app_commit = $frozenResolution.resolved_commit
    moved_branch_commit = $newCommit
  } | ConvertTo-Json -Depth 5
} finally {
  Remove-Item -LiteralPath $temp -Recurse -Force -ErrorAction SilentlyContinue
}
