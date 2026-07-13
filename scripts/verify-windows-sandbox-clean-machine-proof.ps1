#Requires -Version 5.1
[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$root = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$launcher = Join-Path $root "scripts\start-windows-sandbox-clean-machine-proof.ps1"
$bootstrap = Join-Path $root "scripts\windows-sandbox-clean-machine-bootstrap.ps1"
$fullProof = Join-Path $root "scripts\start-clean-machine-equivalence-proof.ps1"
$clientProof = Join-Path $root "scripts\start-client-mcp-proof.ps1"
foreach ($path in @($launcher, $bootstrap, $fullProof, $clientProof)) {
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
    [string]$KeyPath = "",
    [string]$CodexHome = "",
    [string]$ClaudeHome = "",
    [switch]$AutoRestorePrivate,
    [switch]$ReuseHostClientAuth,
    [switch]$UnattendedClientProof
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
  if ($AutoRestorePrivate) { $arguments += "-AutoRestorePrivate" }
  if ($ReuseHostClientAuth) {
    $arguments += @("-ReuseHostClientAuth", "-CodexHome", $CodexHome, "-ClaudeHome", $ClaudeHome)
  }
  if ($UnattendedClientProof) { $arguments += "-UnattendedClientProof" }
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
  param(
    [Parameter(Mandatory = $true)][object]$Result,
    [bool]$ExpectPrivate,
    [bool]$ExpectAutoRestore = $false,
    [bool]$ExpectClientAuth = $false,
    [bool]$ExpectUnattended = $false
  )
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
  Assert-True ($config.auto_restore_private -eq $ExpectAutoRestore) "Automatic private restore setting is wrong."
  Assert-True ($Result.auto_restore_private -eq $ExpectAutoRestore) "Host result omitted the automatic private restore setting."
  Assert-True ($config.client_auth_capsule_available -eq $ExpectClientAuth) "Client auth capsule availability is wrong."
  Assert-True ($config.unattended_client_proof -eq $ExpectUnattended) "Unattended client proof setting is wrong."
  Assert-True ($Result.client_auth_capsule_available -eq $ExpectClientAuth) "Host result omitted client auth capsule availability."
  Assert-True ($Result.unattended_client_proof -eq $ExpectUnattended) "Host result omitted unattended client proof setting."
  if ($ExpectPrivate) {
    $backupRoot = [System.IO.Path]::GetDirectoryName([string]$config.guest_private_backup)
    $keyRoot = [System.IO.Path]::GetDirectoryName([string]$config.guest_recovery_key)
    Assert-True (-not $backupRoot.Equals($keyRoot, [StringComparison]::OrdinalIgnoreCase)) "Private backup and recovery key share a guest root."
  }
  $configText = [System.IO.File]::ReadAllText($Result.config_path)
  Assert-True ($configText -notmatch "(?i)(github_token|gh_token|api[_-]?key|password)") "Sandbox config contains a credential field."

  [xml]$wsb = Get-Content -LiteralPath $Result.wsb_path -Raw
  Assert-True ($wsb.Configuration.Networking -eq "Enable") "Sandbox networking is not enabled."
  Assert-True ([int]$wsb.Configuration.MemoryInMB -eq 4096) "Sandbox memory is not bounded to the requested value."
  Assert-True ($wsb.Configuration.ClipboardRedirection -eq "Enable") "Sandbox clipboard is not enabled for challenge prompts."
  $mapped = @($wsb.Configuration.MappedFolders.MappedFolder)
  $exchange = @($mapped | Where-Object { $_.SandboxFolder -eq "C:\DinoBrainExchange" })
  Assert-True ($exchange.Count -eq 1 -and $exchange[0].ReadOnly -eq "false") "Writable evidence exchange mapping is missing."
  $privateBackup = @($mapped | Where-Object { $_.SandboxFolder -eq "C:\DinoBrainPrivateBackup" })
  $privateKey = @($mapped | Where-Object { $_.SandboxFolder -eq "C:\DinoBrainRecoveryKey" })
  $clientAuth = @($mapped | Where-Object { $_.SandboxFolder -eq "C:\DinoBrainClientAuth" })
  $expectedPrivateMappings = $(if ($ExpectPrivate) { 1 } else { 0 })
  Assert-True ($privateBackup.Count -eq $expectedPrivateMappings) "Private backup mapping count is wrong."
  Assert-True ($privateKey.Count -eq $expectedPrivateMappings) "Private recovery-key mapping count is wrong."
  Assert-True ($clientAuth.Count -eq $(if ($ExpectClientAuth) { 1 } else { 0 })) "Client auth capsule mapping count is wrong."
  if ($ExpectPrivate) {
    Assert-True ($privateBackup[0].ReadOnly -eq "true") "Private backup mapping is not read-only in Sandbox."
    Assert-True ($privateKey[0].ReadOnly -eq "true") "Private recovery-key mapping is not read-only in Sandbox."
  }
  if ($ExpectClientAuth) {
    Assert-True ($clientAuth[0].ReadOnly -eq "true") "Client auth capsule mapping is not read-only in Sandbox."
    Assert-True (Test-Path -LiteralPath (Join-Path $Result.run_root "private-input\client-auth\client-auth.dinobrain") -PathType Leaf) "Encrypted client auth capsule was not prepared."
    Assert-True (-not (Test-Path -LiteralPath (Join-Path $Result.run_root "private-input\client-auth\auth.json"))) "Raw Codex auth leaked beside the capsule."
    Assert-True (-not (Test-Path -LiteralPath (Join-Path $Result.run_root "private-input\client-auth\.credentials.json"))) "Raw Claude auth leaked beside the capsule."
  }
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
  [System.IO.File]::WriteAllText($key, ("fixture-key-material-" + ("k" * 64)), [System.Text.UTF8Encoding]::new($false))
  $private = Invoke-PreparedFixture -OutputRoot (Join-Path $temp "private") -BackupPath $backup -KeyPath $key
  Assert-PreparedRun -Result $private -ExpectPrivate $true
  $privateConfig = [System.IO.File]::ReadAllText($private.config_path)
  Assert-True (-not $privateConfig.Contains($backup) -and -not $privateConfig.Contains($key)) "Host private-input paths leaked into guest config."

  $autoPrivate = Invoke-PreparedFixture -OutputRoot (Join-Path $temp "auto-private") -BackupPath $backup -KeyPath $key -AutoRestorePrivate
  Assert-PreparedRun -Result $autoPrivate -ExpectPrivate $true -ExpectAutoRestore $true

  $codexHome = Join-Path $temp "auth-source\codex"
  $claudeHome = Join-Path $temp "auth-source\claude"
  New-Item -ItemType Directory -Force -Path $codexHome, $claudeHome | Out-Null
  [System.IO.File]::WriteAllText((Join-Path $codexHome "auth.json"), '{"token":"sandbox-auth-capsule-canary"}', [System.Text.UTF8Encoding]::new($false))
  [System.IO.File]::WriteAllText((Join-Path $claudeHome ".credentials.json"), '{"oauth":"sandbox-claude-auth-canary"}', [System.Text.UTF8Encoding]::new($false))
  $unattended = Invoke-PreparedFixture -OutputRoot (Join-Path $temp "unattended") -BackupPath $backup -KeyPath $key -CodexHome $codexHome -ClaudeHome $claudeHome -AutoRestorePrivate -ReuseHostClientAuth -UnattendedClientProof
  Assert-PreparedRun -Result $unattended -ExpectPrivate $true -ExpectAutoRestore $true -ExpectClientAuth $true -ExpectUnattended $true
  $capsuleBytes = [System.IO.File]::ReadAllBytes((Join-Path $unattended.run_root "private-input\client-auth\client-auth.dinobrain"))
  $capsuleText = [System.Text.Encoding]::UTF8.GetString($capsuleBytes)
  Assert-True (-not $capsuleText.Contains("sandbox-auth-capsule-canary")) "Codex auth canary is visible in the encrypted capsule."
  Assert-True (-not $capsuleText.Contains("sandbox-claude-auth-canary")) "Claude auth canary is visible in the encrypted capsule."
  Invoke-FailedLaunchFixture -OutputRoot (Join-Path $temp "launch-failure") -BackupPath $backup -KeyPath $key

  $bootstrapText = [System.IO.File]::ReadAllText($bootstrap)
  $fullProofText = [System.IO.File]::ReadAllText($fullProof)
  $clientProofText = [System.IO.File]::ReadAllText($clientProof)
  $installerText = [System.IO.File]::ReadAllText((Join-Path $root "install.ps1"))
  $matrixText = [System.IO.File]::ReadAllText((Join-Path $root "scripts\verify-clean-machine-install-matrix.ps1"))
  foreach ($needle in @(
    "Assert-FileHash",
    "System.IO.Compression.ZipFile",
    "--extract-install-script",
    "@openai/codex@",
    "@anthropic-ai/claude-code@",
    "installer:verify:matrix",
    "auto_restore_private",
    "08-private-restore",
    "09-client-auth-restore",
    "10-unattended-clean-machine-proof",
    "--include-client-auth",
    "-AllowAppUpgrade",
    "-Unattended -CodexCommand",
    "-OverwritePrivate",
    "start-clean-machine-equivalence-proof.ps1",
    "full-recovery-proof.log",
    "Tee-Object -FilePath",
    "C:\DinoBrainExchange\evidence"
  )) {
    Assert-True ($bootstrapText.Contains($needle)) "Guest bootstrap is missing required proof behavior: $needle"
  }
  Assert-True (-not $bootstrapText.Contains("Expand-Archive")) "Guest bootstrap still depends on the incomplete Windows Sandbox Archive module."
  Assert-True ($clientProofText.Contains('[switch]$NoDialog')) "Direct MCP proof launcher is missing its non-blocking dialog mode."
  Assert-True ($clientProofText.Contains('[switch]$Unattended')) "Direct MCP proof launcher is missing unattended execution."
  Assert-True ($clientProofText.Contains('--dangerously-bypass-approvals-and-sandbox')) "Isolated Codex proof does not suppress interactive approvals."
  Assert-True ($clientProofText.Contains('"--permission-mode", "dontAsk"')) "Isolated Claude proof does not suppress interactive approvals."
  Assert-True ($clientProofText.Contains('mcp__dinobrain__finalize_client_mcp_proof')) "Isolated Claude proof does not allowlist the complete challenge tool surface."
  Assert-True (-not $clientProofText.Contains('--dangerously-skip-permissions')) "Claude proof uses an unnecessarily broad permission bypass."
  Assert-True ($clientProofText.Contains('[Math]::Min(30')) "Failed unattended clients can still consume the full interactive proof timeout."
  Assert-True ($fullProofText.Contains('"-NoDialog"')) "Full recovery proof can still block behind a hidden direct-MCP dialog."
  Assert-True ($installerText.Contains("function Expand-DinoBrainZip")) "Installer is missing its module-independent ZIP extractor."
  Assert-True (-not $installerText.Contains("Expand-Archive")) "Installer still depends on the incomplete Windows Sandbox Archive module."
  Assert-True ($installerText.Contains("Install-DinoBrainVisualCppRuntime")) "Installer does not provision the semantic native runtime on a clean machine."
  Assert-True ($installerText.Contains("Assert-DinoBrainMicrosoftSignedExecutable")) "Installer does not verify the native runtime publisher."
  Assert-True ($installerText.Contains("Assert-DinoBrainSemanticNativeRuntime")) "Installer does not prove the ONNX native binding before RAG prewarm."
  Assert-True ($installerText.Contains("function Remove-DinoBrainPathWithRetry")) "Installer cleanup is not resilient to transient clean-machine file locks."
  Assert-True ($installerText.Contains("function ConvertTo-DinoBrainExtendedPath")) "Installer cleanup is not resilient to paths longer than MAX_PATH."
  Assert-True ($installerText.Contains("function Clear-DinoBrainDeleteAttributes")) "Installer cleanup does not normalize read-only rollback files."
  Assert-True ($matrixText.Contains('@("commit", "--allow-empty", "-m", "fixture: transactional installer")')) "Clean-machine matrix cannot run from an already identical release checkout."
  Assert-True ($matrixText.Contains("child_tail=")) "Clean-machine rollback failures do not preserve installer diagnostics."
  Assert-True ($bootstrapText -notmatch "(?i)(github_pat_|ghp_|sk-[A-Za-z0-9])") "Guest bootstrap contains a credential-like literal."

  [ordered]@{
    ok = $true
    proof_version = "windows_sandbox_clean_machine_proof_v1"
    plain_prepare = "pass"
    private_inputs_read_only = "pass"
    private_backup_key_roots_separated = "pass"
    auto_private_restore_configured = "pass"
    encrypted_client_auth_capsule = "pass"
    unattended_real_client_path = "pass"
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
