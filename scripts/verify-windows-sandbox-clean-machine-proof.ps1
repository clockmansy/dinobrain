#Requires -Version 5.1
[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$root = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$launcher = Join-Path $root "scripts\start-windows-sandbox-clean-machine-proof.ps1"
$bootstrap = Join-Path $root "scripts\windows-sandbox-clean-machine-bootstrap.ps1"
foreach ($path in @($launcher, $bootstrap)) {
  if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "Sandbox proof component missing: $path" }
}

function Assert-True {
  param([bool]$Condition, [string]$Message)
  if (-not $Condition) { throw $Message }
}

function Invoke-PreparedFixture {
  param(
    [Parameter(Mandatory = $true)][string]$OutputRoot,
    [string]$BackupPath = "",
    [string]$KeyPath = ""
  )
  $arguments = @(
    "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $launcher,
    "-ReleaseTag", "v9.9.9",
    "-OutputRoot", $OutputRoot,
    "-InstallerUri", "https://example.invalid/DinoBrainSetup.zip",
    "-InstallerSha256", ("a" * 64),
    "-ResolvedAppCommit", ("b" * 40),
    "-ResolvedDataCommit", ("c" * 40),
    "-GitInstallerUri", "https://example.invalid/PortableGit.7z.exe",
    "-GitInstallerSha256", ("d" * 64),
    "-CodexVersion", "0.144.1",
    "-ClaudeVersion", "2.1.207",
    "-DisablePrivateAutoDetect",
    "-PrepareOnly", "-AllowReleaseMismatch", "-Json"
  )
  if (-not [string]::IsNullOrWhiteSpace($BackupPath)) { $arguments += @("-PrivateBackupPath", $BackupPath) }
  if (-not [string]::IsNullOrWhiteSpace($KeyPath)) { $arguments += @("-RecoveryKeyPath", $KeyPath) }
  $output = @(& powershell.exe @arguments 2>&1)
  if ($LASTEXITCODE -ne 0) { throw "Sandbox prepare fixture failed:`n$($output -join "`n")" }
  return ($output -join "`n") | ConvertFrom-Json
}

function Invoke-FailedLaunchFixture {
  param(
    [Parameter(Mandatory = $true)][string]$OutputRoot,
    [Parameter(Mandatory = $true)][string]$BackupPath,
    [Parameter(Mandatory = $true)][string]$KeyPath
  )
  $arguments = @(
    "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $launcher,
    "-ReleaseTag", "v9.9.9",
    "-OutputRoot", $OutputRoot,
    "-InstallerUri", "https://example.invalid/DinoBrainSetup.zip",
    "-InstallerSha256", ("a" * 64),
    "-ResolvedAppCommit", ("b" * 40),
    "-ResolvedDataCommit", ("c" * 40),
    "-GitInstallerUri", "https://example.invalid/PortableGit.7z.exe",
    "-GitInstallerSha256", ("d" * 64),
    "-CodexVersion", "0.144.1",
    "-ClaudeVersion", "2.1.207",
    "-DisablePrivateAutoDetect",
    "-SandboxExecutable", (Join-Path $OutputRoot "missing-windows\WindowsSandbox.exe"),
    "-PrivateBackupPath", $BackupPath,
    "-RecoveryKeyPath", $KeyPath,
    "-AllowReleaseMismatch"
  )
  $oldErrorActionPreference = $ErrorActionPreference
  try {
    $ErrorActionPreference = "Continue"
    $output = @(& powershell.exe @arguments 2>&1)
    $launchExitCode = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $oldErrorActionPreference
  }
  Assert-True ($launchExitCode -ne 0) "Missing Windows Sandbox fixture unexpectedly succeeded."
  $latest = Get-Content -LiteralPath (Join-Path $OutputRoot "latest.json") -Raw | ConvertFrom-Json
  Assert-True ($latest.status -eq "launch_failed") "Failed Sandbox launch status was not persisted."
  Assert-True ($latest.private_input_removed -eq $true) "Failed Sandbox launch did not report private-input cleanup."
  Assert-True (-not (Test-Path -LiteralPath (Join-Path $latest.run_root "private-input"))) "Failed Sandbox launch left private inputs on disk."
}

function Assert-PreparedRun {
  param([Parameter(Mandatory = $true)][object]$Result, [bool]$ExpectPrivate)
  Assert-True ($Result.ok -eq $true -and $Result.status -eq "prepared") "Sandbox launcher did not report prepared."
  Assert-True (Test-Path -LiteralPath $Result.wsb_path -PathType Leaf) "WSB file was not created."
  Assert-True (Test-Path -LiteralPath $Result.config_path -PathType Leaf) "Sandbox config was not created."
  $config = Get-Content -LiteralPath $Result.config_path -Raw | ConvertFrom-Json
  Assert-True ($config.schema_version -eq "windows_sandbox_clean_machine_proof_v1") "Sandbox config schema is wrong."
  Assert-True ($config.app_commit -eq ("b" * 40) -and $config.data_commit -eq ("c" * 40)) "Immutable commits were not preserved."
  Assert-True ($config.installer_sha256 -eq ("a" * 64) -and $config.git_installer_sha256 -eq ("d" * 64)) "Download hashes were not preserved."
  Assert-True ($config.codex_version -eq "0.144.1" -and $config.claude_version -eq "2.1.207") "Pinned client versions were not preserved."
  Assert-True ($config.install_root -eq "C:\DinoBrainHome") "Sandbox install root collides with the installer app-directory normalization rule."
  Assert-True ($config.private_restore_available -eq $ExpectPrivate) "Private restore availability is wrong."
  $configText = [System.IO.File]::ReadAllText($Result.config_path)
  Assert-True ($configText -notmatch "(?i)(github_token|gh_token|api[_-]?key|password)") "Sandbox config contains a credential field."

  [xml]$wsb = Get-Content -LiteralPath $Result.wsb_path -Raw
  Assert-True ($wsb.Configuration.Networking -eq "Enable") "Sandbox networking is not enabled."
  Assert-True ([int]$wsb.Configuration.MemoryInMB -eq 4096) "Sandbox memory is not bounded to the requested value."
  Assert-True ($wsb.Configuration.ClipboardRedirection -eq "Enable") "Sandbox clipboard is not enabled for challenge prompts."
  $mapped = @($wsb.Configuration.MappedFolders.MappedFolder)
  $exchange = @($mapped | Where-Object { $_.SandboxFolder -eq "C:\DinoBrainExchange" })
  Assert-True ($exchange.Count -eq 1 -and $exchange[0].ReadOnly -eq "false") "Writable evidence exchange mapping is missing."
  $private = @($mapped | Where-Object { $_.SandboxFolder -eq "C:\DinoBrainPrivateInputs" })
  Assert-True ($private.Count -eq $(if ($ExpectPrivate) { 1 } else { 0 })) "Private input mapping count is wrong."
  if ($ExpectPrivate) { Assert-True ($private[0].ReadOnly -eq "true") "Private recovery inputs are not read-only in Sandbox." }
  Assert-True ([string]$wsb.Configuration.LogonCommand.Command -match "windows-sandbox-clean-machine-bootstrap\.ps1") "Sandbox bootstrap is not wired to LogonCommand."

  $copiedBootstrap = Join-Path $Result.exchange_root "windows-sandbox-clean-machine-bootstrap.ps1"
  Assert-True (Test-Path -LiteralPath $copiedBootstrap -PathType Leaf) "Guest bootstrap was not copied to the exchange."
  $actualBootstrapHash = (Get-FileHash -LiteralPath $copiedBootstrap -Algorithm SHA256).Hash.ToLowerInvariant()
  Assert-True ($actualBootstrapHash -eq $config.guest_bootstrap_sha256) "Guest bootstrap hash binding is invalid."
  $validation = @(& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $copiedBootstrap -ConfigPath $Result.config_path -ValidateOnly 2>&1)
  if ($LASTEXITCODE -ne 0) { throw "Guest bootstrap validation failed:`n$($validation -join "`n")" }
  $validated = ($validation -join "`n") | ConvertFrom-Json
  Assert-True ($validated.ok -eq $true -and $validated.run_id -eq $Result.run_id) "Guest bootstrap did not validate the prepared config."
}

$temp = Join-Path ([System.IO.Path]::GetTempPath()) ("dinobrain-sandbox-proof-verify-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Force -Path $temp | Out-Null
try {
  $plain = Invoke-PreparedFixture -OutputRoot (Join-Path $temp "plain")
  Assert-PreparedRun -Result $plain -ExpectPrivate $false

  $backup = Join-Path $temp "fixture.dinobrain"
  $key = Join-Path $temp "recovery-key.txt"
  [System.IO.File]::WriteAllText($backup, "encrypted fixture", [System.Text.UTF8Encoding]::new($false))
  [System.IO.File]::WriteAllText($key, "fixture key", [System.Text.UTF8Encoding]::new($false))
  $private = Invoke-PreparedFixture -OutputRoot (Join-Path $temp "private") -BackupPath $backup -KeyPath $key
  Assert-PreparedRun -Result $private -ExpectPrivate $true
  $privateConfig = [System.IO.File]::ReadAllText($private.config_path)
  Assert-True (-not $privateConfig.Contains($backup) -and -not $privateConfig.Contains($key)) "Host private-input paths leaked into guest config."
  Invoke-FailedLaunchFixture -OutputRoot (Join-Path $temp "launch-failure") -BackupPath $backup -KeyPath $key

  $bootstrapText = [System.IO.File]::ReadAllText($bootstrap)
  foreach ($needle in @(
    "Assert-FileHash",
    "System.IO.Compression.ZipFile",
    "--extract-install-script",
    "@openai/codex@",
    "@anthropic-ai/claude-code@",
    "installer:verify:matrix",
    "start-clean-machine-equivalence-proof.ps1",
    "C:\DinoBrainExchange\evidence"
  )) {
    Assert-True ($bootstrapText.Contains($needle)) "Guest bootstrap is missing required proof behavior: $needle"
  }
  Assert-True (-not $bootstrapText.Contains("Expand-Archive")) "Guest bootstrap still depends on the incomplete Windows Sandbox Archive module."
  Assert-True ($bootstrapText -notmatch "(?i)(github_pat_|ghp_|sk-[A-Za-z0-9])") "Guest bootstrap contains a credential-like literal."

  [ordered]@{
    ok = $true
    proof_version = "windows_sandbox_clean_machine_proof_v1"
    plain_prepare = "pass"
    private_inputs_read_only = "pass"
    immutable_refs_and_hashes = "pass"
    guest_bootstrap_hash_bound = "pass"
    credentials_excluded = "pass"
    failed_launch_private_cleanup = "pass"
  } | ConvertTo-Json -Depth 5
} finally {
  $resolvedTemp = [System.IO.Path]::GetFullPath($temp)
  $resolvedSystemTemp = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
  if ($resolvedTemp.StartsWith($resolvedSystemTemp, [StringComparison]::OrdinalIgnoreCase)) {
    Remove-Item -LiteralPath $resolvedTemp -Recurse -Force -ErrorAction SilentlyContinue
  }
}
