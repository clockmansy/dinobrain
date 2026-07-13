#Requires -Version 5.1
[CmdletBinding()]
param(
  [string]$Repository = "clockmansy/dinobrain",
  [string]$DataRepository = "clockmansy/dinobrain-data",
  [string]$ReleaseTag = "",
  [ValidateRange(4096, 32768)][int]$MemoryInMB = 4096,
  [string]$OutputRoot = "",
  [string]$PrivateBackupPath = "",
  [string]$RecoveryKeyPath = "",
  [string]$InstallerUri = "",
  [string]$InstallerSha256 = "",
  [string]$ResolvedAppCommit = "",
  [string]$ResolvedDataCommit = "",
  [string]$GitInstallerUri = "",
  [string]$GitInstallerSha256 = "",
  [string]$CodexVersion = "",
  [string]$ClaudeVersion = "",
  [string]$SandboxExecutable = "",
  [string]$CodexHome = "",
  [string]$ClaudeHome = "",
  [switch]$DisablePrivateAutoDetect,
  [switch]$AutoRestorePrivate,
  [switch]$ReuseHostClientAuth,
  [switch]$UnattendedClientProof,
  [switch]$AllowReleaseMismatch,
  [switch]$PrepareOnly,
  [switch]$NoWait,
  [switch]$Json
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$root = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
$sandboxExe = $(if ([string]::IsNullOrWhiteSpace($SandboxExecutable)) {
  Join-Path $env:SystemRoot "System32\WindowsSandbox.exe"
} else {
  [System.IO.Path]::GetFullPath($SandboxExecutable)
})

function Write-Utf8Text {
  param([Parameter(Mandatory = $true)][string]$Path, [Parameter(Mandatory = $true)][string]$Text)
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Path) | Out-Null
  [System.IO.File]::WriteAllText($Path, $Text, $utf8NoBom)
}

function Write-JsonAtomic {
  param([Parameter(Mandatory = $true)][string]$Path, [Parameter(Mandatory = $true)][object]$Value)
  $tempPath = "$Path.tmp-$([guid]::NewGuid().ToString('N'))"
  Write-Utf8Text -Path $tempPath -Text (($Value | ConvertTo-Json -Depth 12) + "`n")
  Move-Item -LiteralPath $tempPath -Destination $Path -Force
}

function Remove-DirectoryWithRetry {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$AllowedRoot,
    [int]$Attempts = 60,
    [int]$DelayMilliseconds = 500
  )
  $resolvedPath = [System.IO.Path]::GetFullPath($Path)
  $resolvedRoot = [System.IO.Path]::GetFullPath($AllowedRoot).TrimEnd([char[]]@('\', '/'))
  $rootPrefix = $resolvedRoot + [System.IO.Path]::DirectorySeparatorChar
  if (-not $resolvedPath.StartsWith($rootPrefix, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to remove a directory outside the proof output root: $resolvedPath"
  }
  $lastError = ""
  for ($attempt = 1; $attempt -le $Attempts; $attempt += 1) {
    if (-not (Test-Path -LiteralPath $resolvedPath)) {
      return [pscustomobject]@{ ok = $true; attempts = $attempt - 1; error = "" }
    }
    try {
      Remove-Item -LiteralPath $resolvedPath -Recurse -Force -ErrorAction Stop
      if (-not (Test-Path -LiteralPath $resolvedPath)) {
        return [pscustomobject]@{ ok = $true; attempts = $attempt; error = "" }
      }
    } catch {
      $lastError = $_.Exception.Message
    }
    if ($attempt -lt $Attempts) { Start-Sleep -Milliseconds $DelayMilliseconds }
  }
  return [pscustomobject]@{ ok = $false; attempts = $Attempts; error = $lastError }
}

function Invoke-PublicJson {
  param([Parameter(Mandatory = $true)][string]$Uri)
  Invoke-RestMethod -Method Get -Uri $Uri -Headers @{ "User-Agent" = "DinoBrainWindowsSandboxProof" }
}

function Assert-Sha256 {
  param([Parameter(Mandatory = $true)][string]$Value, [Parameter(Mandatory = $true)][string]$Label)
  if ($Value -notmatch "^[a-fA-F0-9]{64}$") { throw "$Label must be a SHA-256 value." }
  return $Value.ToLowerInvariant()
}

function Assert-Commit {
  param([Parameter(Mandatory = $true)][string]$Value, [Parameter(Mandatory = $true)][string]$Label)
  if ($Value -notmatch "^[a-fA-F0-9]{40}$") { throw "$Label must be an immutable 40-character Git commit." }
  return $Value.ToLowerInvariant()
}

function Asset-Sha256 {
  param([Parameter(Mandatory = $true)][object]$Asset, [Parameter(Mandatory = $true)][string]$Label)
  $digest = [string]$Asset.digest
  if ($digest -notmatch "^sha256:([a-fA-F0-9]{64})$") { throw "$Label does not expose a GitHub SHA-256 digest." }
  return $Matches[1].ToLowerInvariant()
}

function Resolve-Commit {
  param([Parameter(Mandatory = $true)][string]$Repo, [Parameter(Mandatory = $true)][string]$Ref)
  $encoded = [Uri]::EscapeDataString($Ref)
  $commit = Invoke-PublicJson -Uri "https://api.github.com/repos/$Repo/commits/$encoded"
  return Assert-Commit -Value ([string]$commit.sha) -Label "$Repo ref $Ref"
}

function Resolve-RemoteInputs {
  $overrideValues = @($InstallerUri, $InstallerSha256, $ResolvedAppCommit, $ResolvedDataCommit, $GitInstallerUri, $GitInstallerSha256, $CodexVersion, $ClaudeVersion)
  $overrideCount = @($overrideValues | Where-Object { -not [string]::IsNullOrWhiteSpace([string]$_) }).Count
  if ($overrideCount -gt 0 -and $overrideCount -ne $overrideValues.Count) {
    throw "Direct metadata override requires installer URI/hash, app/data commits, Git installer URI/hash, and Codex/Claude versions together."
  }

  if ($overrideCount -eq $overrideValues.Count) {
    return [ordered]@{
      installer_uri = $InstallerUri
      installer_sha256 = Assert-Sha256 -Value $InstallerSha256 -Label "InstallerSha256"
      app_commit = Assert-Commit -Value $ResolvedAppCommit -Label "ResolvedAppCommit"
      data_commit = Assert-Commit -Value $ResolvedDataCommit -Label "ResolvedDataCommit"
      git_installer_uri = $GitInstallerUri
      git_installer_sha256 = Assert-Sha256 -Value $GitInstallerSha256 -Label "GitInstallerSha256"
      codex_version = $CodexVersion
      claude_version = $ClaudeVersion
      release_url = "override"
      release_immutable = $false
    }
  }

  $release = Invoke-PublicJson -Uri "https://api.github.com/repos/$Repository/releases/tags/$ReleaseTag"
  $installerAsset = @($release.assets | Where-Object { $_.name -eq "DinoBrainSetup.zip" } | Select-Object -First 1)
  if ($installerAsset.Count -ne 1) { throw "DinoBrainSetup.zip is missing from release $ReleaseTag." }

  $gitRelease = Invoke-PublicJson -Uri "https://api.github.com/repos/git-for-windows/git/releases/latest"
  $gitAsset = @($gitRelease.assets | Where-Object { $_.name -match "^PortableGit-.*-64-bit\.7z\.exe$" } | Select-Object -First 1)
  if ($gitAsset.Count -ne 1) { throw "Could not resolve a 64-bit PortableGit release asset." }

  $codexPackage = Invoke-PublicJson -Uri "https://registry.npmjs.org/%40openai%2Fcodex/latest"
  $claudePackage = Invoke-PublicJson -Uri "https://registry.npmjs.org/%40anthropic-ai%2Fclaude-code/latest"
  return [ordered]@{
    installer_uri = [string]$installerAsset[0].browser_download_url
    installer_sha256 = Asset-Sha256 -Asset $installerAsset[0] -Label "DinoBrainSetup.zip"
    app_commit = Resolve-Commit -Repo $Repository -Ref $ReleaseTag
    data_commit = Resolve-Commit -Repo $DataRepository -Ref "main"
    git_installer_uri = [string]$gitAsset[0].browser_download_url
    git_installer_sha256 = Asset-Sha256 -Asset $gitAsset[0] -Label $gitAsset[0].name
    codex_version = [string]$codexPackage.version
    claude_version = [string]$claudePackage.version
    release_url = [string]$release.html_url
    release_immutable = $(if ($release.PSObject.Properties.Name -contains "immutable") { [bool]$release.immutable } else { $false })
  }
}

$versionManifest = Get-Content -LiteralPath (Join-Path $root "version.json") -Raw | ConvertFrom-Json
if ([string]::IsNullOrWhiteSpace($ReleaseTag)) { $ReleaseTag = "v$([string]$versionManifest.version)" }
if ($ReleaseTag -notmatch "^v[0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9.-]+)?$") { throw "ReleaseTag is invalid: $ReleaseTag" }

$resolved = Resolve-RemoteInputs
foreach ($uriField in @("installer_uri", "git_installer_uri")) {
  if ([string]$resolved[$uriField] -notmatch "^https://") { throw "$uriField must use HTTPS." }
}

$localHead = ""
if ((Get-Command git -ErrorAction SilentlyContinue) -and (Test-Path -LiteralPath (Join-Path $root ".git") -PathType Container)) {
  $localHead = (& git -C $root rev-parse HEAD 2>$null).Trim()
}
if (-not $AllowReleaseMismatch -and $localHead -match "^[a-fA-F0-9]{40}$" -and $localHead.ToLowerInvariant() -ne $resolved.app_commit) {
  throw "Release $ReleaseTag points to $($resolved.app_commit), but this app checkout is $localHead. Publish a release for the current commit or pass -AllowReleaseMismatch for a non-certifying diagnostic."
}

if ([string]::IsNullOrWhiteSpace($OutputRoot)) {
  if ([string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) { throw "LOCALAPPDATA is required unless OutputRoot is provided." }
  $OutputRoot = Join-Path $env:LOCALAPPDATA "DinoBrain\proofs\windows-sandbox"
}
$OutputRoot = [System.IO.Path]::GetFullPath($OutputRoot)
$runId = "sandbox-$([DateTime]::UtcNow.ToString('yyyyMMdd-HHmmss'))-$([guid]::NewGuid().ToString('N').Substring(0, 12))"
$runRoot = Join-Path $OutputRoot $runId
$exchangeRoot = Join-Path $runRoot "exchange"
$privateRoot = Join-Path $runRoot "private-input"
New-Item -ItemType Directory -Force -Path $exchangeRoot | Out-Null

if (-not $DisablePrivateAutoDetect -and [string]::IsNullOrWhiteSpace($PrivateBackupPath) -and [string]::IsNullOrWhiteSpace($RecoveryKeyPath)) {
  $documents = [Environment]::GetFolderPath("MyDocuments")
  if (-not [string]::IsNullOrWhiteSpace($documents)) {
    $latestBackup = Get-ChildItem -LiteralPath (Join-Path $documents "DinoBrain Backups") -Filter "*.dinobrain" -File -ErrorAction SilentlyContinue |
      Sort-Object LastWriteTimeUtc -Descending |
      Select-Object -First 1
    $defaultKey = Join-Path $documents "DinoBrain Recovery Key.txt"
    if ($latestBackup -and (Test-Path -LiteralPath $defaultKey -PathType Leaf)) {
      $PrivateBackupPath = $latestBackup.FullName
      $RecoveryKeyPath = $defaultKey
    }
  }
}

$privateAvailable = -not [string]::IsNullOrWhiteSpace($PrivateBackupPath) -or -not [string]::IsNullOrWhiteSpace($RecoveryKeyPath)
if ($privateAvailable -and ([string]::IsNullOrWhiteSpace($PrivateBackupPath) -or [string]::IsNullOrWhiteSpace($RecoveryKeyPath))) {
  throw "PrivateBackupPath and RecoveryKeyPath must be supplied together."
}
if ($AutoRestorePrivate -and -not $privateAvailable) {
  throw "AutoRestorePrivate requires a private backup and recovery key."
}
if ($ReuseHostClientAuth -and -not $privateAvailable) {
  throw "ReuseHostClientAuth requires the recovery key used to encrypt the temporary auth capsule."
}
if ($UnattendedClientProof -and -not $ReuseHostClientAuth) {
  throw "UnattendedClientProof requires ReuseHostClientAuth."
}
if ($privateAvailable -and $NoWait) {
  throw "NoWait is not allowed with private restore inputs because the host must delete their temporary copies when Sandbox closes."
}
if ($privateAvailable) {
  $backup = [System.IO.Path]::GetFullPath($PrivateBackupPath)
  $key = [System.IO.Path]::GetFullPath($RecoveryKeyPath)
  if (-not (Test-Path -LiteralPath $backup -PathType Leaf)) { throw "Private backup not found: $backup" }
  if (-not (Test-Path -LiteralPath $key -PathType Leaf)) { throw "Recovery key not found: $key" }
  $privateBackupRoot = Join-Path $privateRoot "backup"
  $privateKeyRoot = Join-Path $privateRoot "key"
  New-Item -ItemType Directory -Force -Path $privateBackupRoot, $privateKeyRoot | Out-Null
  Copy-Item -LiteralPath $backup -Destination (Join-Path $privateBackupRoot "backup.dinobrain") -Force
  Copy-Item -LiteralPath $key -Destination (Join-Path $privateKeyRoot "recovery-key.txt") -Force
}

$clientAuthAvailable = $false
if ($ReuseHostClientAuth) {
  try {
  $resolvedCodexHome = [System.IO.Path]::GetFullPath($(if ([string]::IsNullOrWhiteSpace($CodexHome)) { Join-Path $HOME ".codex" } else { $CodexHome }))
  $resolvedClaudeHome = [System.IO.Path]::GetFullPath($(if ([string]::IsNullOrWhiteSpace($ClaudeHome)) { Join-Path $HOME ".claude" } else { $ClaudeHome }))
  $codexAuth = Join-Path $resolvedCodexHome "auth.json"
  $claudeAuth = Join-Path $resolvedClaudeHome ".credentials.json"
  if (-not (Test-Path -LiteralPath $codexAuth -PathType Leaf)) { throw "Codex auth.json is missing: $codexAuth" }
  if (-not (Test-Path -LiteralPath $claudeAuth -PathType Leaf)) { throw "Claude .credentials.json is missing: $claudeAuth" }
  $nodeCommand = Get-Command node -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $nodeCommand -and $env:LOCALAPPDATA) {
    $nodeCommand = Get-ChildItem -LiteralPath (Join-Path $env:LOCALAPPDATA "DinoBrain\tools") -Recurse -Filter "node.exe" -File -ErrorAction SilentlyContinue |
      Where-Object { $_.DirectoryName -match "node-v[^\\]+-win-x64$" } |
      Sort-Object FullName -Descending |
      Select-Object -First 1
  }
  if (-not $nodeCommand) { throw "Node.js is required to create the encrypted client-auth capsule." }
  $nodePath = [string]$(if ($nodeCommand.PSObject.Properties.Name -contains "Source") { $nodeCommand.Source } else { $nodeCommand.FullName })
  $authCapsuleRoot = Join-Path $privateRoot "client-auth"
  New-Item -ItemType Directory -Force -Path $authCapsuleRoot | Out-Null
  $authCapsule = Join-Path $authCapsuleRoot "client-auth.dinobrain"
  $privateBackupCli = Join-Path $root "dist\run-private-backup.js"
  if (-not (Test-Path -LiteralPath $privateBackupCli -PathType Leaf)) { throw "Built private backup CLI is missing: $privateBackupCli" }
  $dataRoot = [System.IO.Path]::GetFullPath((Join-Path $root "..\dinobrain-data"))
  $authOutput = @(& $nodePath $privateBackupCli create --app-root $root --data-root $dataRoot --output $authCapsule --key-file $key --client-auth-only --include-client-auth --codex-home $resolvedCodexHome --claude-home $resolvedClaudeHome 2>&1)
  if ($LASTEXITCODE -ne 0) { throw "Encrypted client-auth capsule creation failed." }
  $authResult = ($authOutput -join [Environment]::NewLine) | ConvertFrom-Json
  if ($authResult.status -ne "created" -or [int]$authResult.entry_count -ne 2) { throw "Encrypted client-auth capsule did not contain exactly both client credentials." }
  $clientAuthAvailable = $true
  } catch {
    if (Test-Path -LiteralPath $privateRoot) {
      $cleanup = Remove-DirectoryWithRetry -Path $privateRoot -AllowedRoot $OutputRoot
      if (-not $cleanup.ok) { throw "Client-auth capsule preparation failed and private-input cleanup also failed: $($cleanup.error)" }
    }
    throw
  }
}

$guestSource = Join-Path $root "scripts\windows-sandbox-clean-machine-bootstrap.ps1"
if (-not (Test-Path -LiteralPath $guestSource -PathType Leaf)) { throw "Sandbox guest bootstrap is missing: $guestSource" }
$guestTarget = Join-Path $exchangeRoot "windows-sandbox-clean-machine-bootstrap.ps1"
Copy-Item -LiteralPath $guestSource -Destination $guestTarget -Force
$guestSha256 = (Get-FileHash -LiteralPath $guestTarget -Algorithm SHA256).Hash.ToLowerInvariant()

$config = [ordered]@{
  schema_version = "windows_sandbox_clean_machine_proof_v1"
  run_id = $runId
  created_at = [DateTime]::UtcNow.ToString("o")
  release_tag = $ReleaseTag
  release_url = $resolved.release_url
  release_immutable = [bool]$resolved.release_immutable
  diagnostic_release_mismatch_allowed = [bool]$AllowReleaseMismatch
  app_repository = "https://github.com/$Repository.git"
  data_repository = "https://github.com/$DataRepository.git"
  app_commit = $resolved.app_commit
  data_commit = $resolved.data_commit
  installer_uri = $resolved.installer_uri
  installer_sha256 = $resolved.installer_sha256
  git_installer_uri = $resolved.git_installer_uri
  git_installer_sha256 = $resolved.git_installer_sha256
  codex_package = "@openai/codex"
  codex_version = $resolved.codex_version
  claude_package = "@anthropic-ai/claude-code"
  claude_version = $resolved.claude_version
  guest_bootstrap_sha256 = $guestSha256
  guest_exchange_root = "C:\DinoBrainExchange"
  private_restore_available = [bool]$privateAvailable
  auto_restore_private = [bool]$AutoRestorePrivate
  client_auth_capsule_available = [bool]$clientAuthAvailable
  unattended_client_proof = [bool]$UnattendedClientProof
  guest_private_backup = $(if ($privateAvailable) { "C:\DinoBrainPrivateBackup\backup.dinobrain" } else { $null })
  guest_recovery_key = $(if ($privateAvailable) { "C:\DinoBrainRecoveryKey\recovery-key.txt" } else { $null })
  guest_client_auth_capsule = $(if ($clientAuthAvailable) { "C:\DinoBrainClientAuth\client-auth.dinobrain" } else { $null })
  install_root = "C:\DinoBrainHome"
  client_root = "C:\DinoBrainClients"
}
$configPath = Join-Path $exchangeRoot "sandbox-proof-config.json"
Write-JsonAtomic -Path $configPath -Value $config

$escapedExchange = [System.Security.SecurityElement]::Escape($exchangeRoot)
$privateMapping = ""
if ($privateAvailable) {
  $escapedPrivateBackup = [System.Security.SecurityElement]::Escape((Join-Path $privateRoot "backup"))
  $escapedPrivateKey = [System.Security.SecurityElement]::Escape((Join-Path $privateRoot "key"))
  $privateMapping = @"
      <MappedFolder>
        <HostFolder>$escapedPrivateBackup</HostFolder>
        <SandboxFolder>C:\DinoBrainPrivateBackup</SandboxFolder>
        <ReadOnly>true</ReadOnly>
      </MappedFolder>
      <MappedFolder>
        <HostFolder>$escapedPrivateKey</HostFolder>
        <SandboxFolder>C:\DinoBrainRecoveryKey</SandboxFolder>
        <ReadOnly>true</ReadOnly>
      </MappedFolder>
"@
}
if ($clientAuthAvailable) {
  $escapedClientAuth = [System.Security.SecurityElement]::Escape((Join-Path $privateRoot "client-auth"))
  $privateMapping += @"
      <MappedFolder>
        <HostFolder>$escapedClientAuth</HostFolder>
        <SandboxFolder>C:\DinoBrainClientAuth</SandboxFolder>
        <ReadOnly>true</ReadOnly>
      </MappedFolder>
"@
}
$wsbText = @"
<Configuration>
  <VGpu>Disable</VGpu>
  <Networking>Enable</Networking>
  <MemoryInMB>$MemoryInMB</MemoryInMB>
  <AudioInput>Disable</AudioInput>
  <VideoInput>Disable</VideoInput>
  <PrinterRedirection>Disable</PrinterRedirection>
  <ClipboardRedirection>Enable</ClipboardRedirection>
  <MappedFolders>
    <MappedFolder>
      <HostFolder>$escapedExchange</HostFolder>
      <SandboxFolder>C:\DinoBrainExchange</SandboxFolder>
      <ReadOnly>false</ReadOnly>
    </MappedFolder>
$privateMapping  </MappedFolders>
  <LogonCommand>
    <Command>powershell.exe -NoProfile -ExecutionPolicy Bypass -File C:\DinoBrainExchange\windows-sandbox-clean-machine-bootstrap.ps1 -ConfigPath C:\DinoBrainExchange\sandbox-proof-config.json</Command>
  </LogonCommand>
</Configuration>
"@
$wsbPath = Join-Path $runRoot "DinoBrain Clean Machine Proof.wsb"
Write-Utf8Text -Path $wsbPath -Text $wsbText

$result = [ordered]@{
  ok = $true
  status = "prepared"
  run_id = $runId
  release_tag = $ReleaseTag
  app_commit = $resolved.app_commit
  data_commit = $resolved.data_commit
  installer_sha256 = $resolved.installer_sha256
  codex_version = $resolved.codex_version
  claude_version = $resolved.claude_version
  memory_in_mb = $MemoryInMB
  private_restore_available = [bool]$privateAvailable
  auto_restore_private = [bool]$AutoRestorePrivate
  client_auth_capsule_available = [bool]$clientAuthAvailable
  unattended_client_proof = [bool]$UnattendedClientProof
  run_root = $runRoot
  exchange_root = $exchangeRoot
  config_path = $configPath
  wsb_path = $wsbPath
  sandbox_available = (Test-Path -LiteralPath $sandboxExe -PathType Leaf)
}
Write-JsonAtomic -Path (Join-Path $runRoot "host-launch-status.json") -Value $result
Write-JsonAtomic -Path (Join-Path $OutputRoot "latest.json") -Value $result

if (-not $PrepareOnly) {
  $privateCleanupError = ""
  try {
    if (-not (Test-Path -LiteralPath $sandboxExe -PathType Leaf)) { throw "Windows Sandbox is not installed: $sandboxExe" }
    $process = Start-Process -FilePath $sandboxExe -ArgumentList ('"' + $wsbPath + '"') -PassThru
    $result["status"] = "launched"
    $result["sandbox_process_id"] = $process.Id
    Write-JsonAtomic -Path (Join-Path $runRoot "host-launch-status.json") -Value $result
    Write-JsonAtomic -Path (Join-Path $OutputRoot "latest.json") -Value $result
    if (-not $NoWait) {
      $process.WaitForExit()
      $result["status"] = "sandbox_closed"
      $result["sandbox_exit_code"] = $process.ExitCode
      $result["closed_at"] = [DateTime]::UtcNow.ToString("o")
    }
  } catch {
    $result["status"] = "launch_failed"
    $result["launch_error"] = $_.Exception.Message
    throw
  } finally {
    if ($privateAvailable -and -not $NoWait -and (Test-Path -LiteralPath $privateRoot)) {
      $cleanup = Remove-DirectoryWithRetry -Path $privateRoot -AllowedRoot $OutputRoot
      $result["private_input_removed"] = [bool]$cleanup.ok
      $result["private_input_cleanup_attempts"] = [int]$cleanup.attempts
      if (-not $cleanup.ok) {
        $privateCleanupError = [string]$cleanup.error
        $result["private_input_cleanup_error"] = $privateCleanupError
        if ($result["status"] -ne "launch_failed") { $result["status"] = "private_cleanup_failed" }
      }
    }
    Write-JsonAtomic -Path (Join-Path $runRoot "host-launch-status.json") -Value $result
    Write-JsonAtomic -Path (Join-Path $OutputRoot "latest.json") -Value $result
  }
  if (-not [string]::IsNullOrWhiteSpace($privateCleanupError)) {
    throw "Sandbox closed, but temporary private-input cleanup failed: $privateCleanupError"
  }
}

if ($Json) {
  $result | ConvertTo-Json -Depth 8
} else {
  Write-Host "DinoBrain Windows Sandbox proof: $($result.status)"
  Write-Host "Run: $runId"
  Write-Host "Release: $ReleaseTag -> $($resolved.app_commit)"
  Write-Host "Data: $($resolved.data_commit)"
  Write-Host "Sandbox config: $wsbPath"
  Write-Host "Evidence exchange: $exchangeRoot"
  if (-not $privateAvailable) {
    Write-Warning "No encrypted backup and recovery key were supplied. Install/client diagnostics can run, but full recovery equivalence will remain pending."
  }
}
