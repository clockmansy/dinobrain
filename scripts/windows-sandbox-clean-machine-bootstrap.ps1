#Requires -Version 5.1
[CmdletBinding()]
param(
  [string]$ConfigPath = "C:\DinoBrainExchange\sandbox-proof-config.json",
  [switch]$ValidateOnly
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)

function Write-Utf8Text {
  param([Parameter(Mandatory = $true)][string]$Path, [Parameter(Mandatory = $true)][string]$Text)
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Path) | Out-Null
  [System.IO.File]::WriteAllText($Path, $Text, $utf8NoBom)
}

function Write-GuestStatus {
  param([Parameter(Mandatory = $true)][string]$Status, [string]$Message = "", [hashtable]$Extra = @{})
  $value = [ordered]@{
    schema_version = "windows_sandbox_guest_status_v1"
    run_id = [string]$script:Config.run_id
    status = $Status
    message = $Message
    updated_at = [DateTime]::UtcNow.ToString("o")
    computer_name = $env:COMPUTERNAME
    user_name = $env:USERNAME
  }
  foreach ($key in $Extra.Keys) { $value[$key] = $Extra[$key] }
  $path = Join-Path ([string]$script:Config.guest_exchange_root) "sandbox-guest-status.json"
  $temp = "$path.tmp-$([guid]::NewGuid().ToString('N'))"
  Write-Utf8Text -Path $temp -Text (($value | ConvertTo-Json -Depth 10) + "`n")
  Move-Item -LiteralPath $temp -Destination $path -Force
}

function Assert-Sha256 {
  param([string]$Value, [string]$Label)
  if ($Value -notmatch "^[a-fA-F0-9]{64}$") { throw "$Label is not a SHA-256 value." }
}

function Assert-Commit {
  param([string]$Value, [string]$Label)
  if ($Value -notmatch "^[a-fA-F0-9]{40}$") { throw "$Label is not an immutable Git commit." }
}

function Assert-Config {
  if ($script:Config.schema_version -ne "windows_sandbox_clean_machine_proof_v1") { throw "Unsupported sandbox proof config." }
  Assert-Sha256 -Value ([string]$script:Config.installer_sha256) -Label "installer_sha256"
  Assert-Sha256 -Value ([string]$script:Config.git_installer_sha256) -Label "git_installer_sha256"
  Assert-Sha256 -Value ([string]$script:Config.guest_bootstrap_sha256) -Label "guest_bootstrap_sha256"
  Assert-Commit -Value ([string]$script:Config.app_commit) -Label "app_commit"
  Assert-Commit -Value ([string]$script:Config.data_commit) -Label "data_commit"
  foreach ($uri in @([string]$script:Config.installer_uri, [string]$script:Config.git_installer_uri)) {
    if ($uri -notmatch "^https://") { throw "Sandbox downloads must use HTTPS." }
  }
  if ([string]::IsNullOrWhiteSpace([string]$script:Config.codex_version)) { throw "codex_version is required." }
  if ([string]::IsNullOrWhiteSpace([string]$script:Config.claude_version)) { throw "claude_version is required." }
}

function Assert-FileHash {
  param([Parameter(Mandatory = $true)][string]$Path, [Parameter(Mandatory = $true)][string]$Expected, [Parameter(Mandatory = $true)][string]$Label)
  $actual = (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actual -ne $Expected.ToLowerInvariant()) { throw "$Label SHA-256 mismatch. expected=$Expected actual=$actual" }
}

function Download-Verified {
  param([string]$Uri, [string]$Destination, [string]$Sha256, [string]$Label)
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Destination) | Out-Null
  Invoke-WebRequest -UseBasicParsing -Uri $Uri -OutFile $Destination
  Assert-FileHash -Path $Destination -Expected $Sha256 -Label $Label
}

function Quote-ProcessArgument {
  param([string]$Value)
  if ($Value -notmatch '[\s"]') { return $Value }
  return '"' + ($Value -replace '"', '\"') + '"'
}

function Invoke-LoggedProcess {
  param(
    [Parameter(Mandatory = $true)][string]$FilePath,
    [Parameter(Mandatory = $true)][string[]]$Arguments,
    [Parameter(Mandatory = $true)][string]$LogName,
    [string]$WorkingDirectory = "C:\"
  )
  $logRoot = Join-Path ([string]$script:Config.guest_exchange_root) "logs"
  New-Item -ItemType Directory -Force -Path $logRoot | Out-Null
  $stdout = Join-Path $logRoot "$LogName.stdout.log"
  $stderr = Join-Path $logRoot "$LogName.stderr.log"
  $argumentLine = ($Arguments | ForEach-Object { Quote-ProcessArgument $_ }) -join " "
  $process = Start-Process -FilePath $FilePath -ArgumentList $argumentLine -WorkingDirectory $WorkingDirectory -RedirectStandardOutput $stdout -RedirectStandardError $stderr -PassThru -Wait -WindowStyle Hidden
  if ($process.ExitCode -ne 0) {
    $tail = @()
    if (Test-Path -LiteralPath $stdout) { $tail += @(Get-Content -LiteralPath $stdout -Tail 40) }
    if (Test-Path -LiteralPath $stderr) { $tail += @(Get-Content -LiteralPath $stderr -Tail 40) }
    throw "$LogName failed with exit code $($process.ExitCode).`n$($tail -join "`n")"
  }
}

function Set-UserPathPrefix {
  param([Parameter(Mandatory = $true)][string[]]$Paths)
  $prefix = @($Paths | Where-Object { -not [string]::IsNullOrWhiteSpace($_) -and (Test-Path -LiteralPath $_) }) -join ";"
  if ([string]::IsNullOrWhiteSpace($prefix)) { return }
  $env:PATH = "$prefix;$env:PATH"
  $current = [Environment]::GetEnvironmentVariable("Path", "User")
  [Environment]::SetEnvironmentVariable("Path", "$prefix;$current", "User")
}

if (-not (Test-Path -LiteralPath $ConfigPath -PathType Leaf)) { throw "Sandbox proof config is missing: $ConfigPath" }
$script:Config = Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json
Assert-Config

$selfPath = [System.IO.Path]::GetFullPath($PSCommandPath)
Assert-FileHash -Path $selfPath -Expected ([string]$script:Config.guest_bootstrap_sha256) -Label "Guest bootstrap"
if ($ValidateOnly) {
  [ordered]@{ ok = $true; schema_version = $script:Config.schema_version; run_id = $script:Config.run_id } | ConvertTo-Json
  exit 0
}

$exchangeRoot = [System.IO.Path]::GetFullPath([string]$script:Config.guest_exchange_root)
if ($exchangeRoot -ne "C:\DinoBrainExchange") { throw "Unexpected guest exchange root: $exchangeRoot" }
if ($env:USERNAME -ne "WDAGUtilityAccount") { throw "This bootstrap must run inside Windows Sandbox." }

$transcriptPath = Join-Path $exchangeRoot "logs\sandbox-bootstrap-transcript.log"
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $transcriptPath) | Out-Null
Start-Transcript -LiteralPath $transcriptPath -Force | Out-Null

try {
  Write-GuestStatus -Status "bootstrapping" -Message "Preparing pinned Git, installer, and clients."
  $workRoot = "C:\DinoBrainBootstrap"
  $gitRoot = "C:\PortableGit"
  $installRoot = [System.IO.Path]::GetFullPath([string]$script:Config.install_root)
  $clientRoot = [System.IO.Path]::GetFullPath([string]$script:Config.client_root)
  New-Item -ItemType Directory -Force -Path $workRoot, $clientRoot | Out-Null

  $gitInstaller = Join-Path $workRoot "PortableGit.7z.exe"
  Download-Verified -Uri ([string]$script:Config.git_installer_uri) -Destination $gitInstaller -Sha256 ([string]$script:Config.git_installer_sha256) -Label "PortableGit"
  Invoke-LoggedProcess -FilePath $gitInstaller -Arguments @("-y", "-o$gitRoot") -LogName "01-portable-git"
  $gitCmd = Join-Path $gitRoot "cmd"
  $gitBin = Join-Path $gitRoot "bin"
  $bashExe = Join-Path $gitBin "bash.exe"
  if (-not (Test-Path -LiteralPath (Join-Path $gitCmd "git.exe"))) { throw "PortableGit did not install git.exe." }
  if (-not (Test-Path -LiteralPath $bashExe)) { throw "PortableGit did not install bash.exe." }
  $env:CLAUDE_CODE_GIT_BASH_PATH = $bashExe
  [Environment]::SetEnvironmentVariable("CLAUDE_CODE_GIT_BASH_PATH", $bashExe, "User")
  Set-UserPathPrefix -Paths @($gitCmd, $gitBin)

  $installerZip = Join-Path $workRoot "DinoBrainSetup.zip"
  Download-Verified -Uri ([string]$script:Config.installer_uri) -Destination $installerZip -Sha256 ([string]$script:Config.installer_sha256) -Label "DinoBrain release"
  $releaseRoot = Join-Path $workRoot "release"
  Expand-Archive -LiteralPath $installerZip -DestinationPath $releaseRoot -Force
  $installerExe = Get-ChildItem -LiteralPath $releaseRoot -Recurse -Filter "DinoBrainSetup.exe" | Select-Object -First 1
  if ($null -eq $installerExe) { throw "DinoBrainSetup.exe is missing from the verified release ZIP." }
  $installScript = Join-Path $workRoot "install.ps1"
  Invoke-LoggedProcess -FilePath $installerExe.FullName -Arguments @("--extract-install-script", $installScript) -LogName "02-extract-installer"
  if (-not (Test-Path -LiteralPath $installScript -PathType Leaf)) { throw "Installer did not extract install.ps1." }

  $baseInstallArguments = @(
    "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $installScript,
    "-InstallRoot", $installRoot,
    "-AppRepo", [string]$script:Config.app_repository,
    "-DataRepo", [string]$script:Config.data_repository,
    "-AppRef", [string]$script:Config.app_commit,
    "-DataRef", [string]$script:Config.data_commit,
    "-SkipCodexRestartFlow"
  )
  Invoke-LoggedProcess -FilePath "powershell.exe" -Arguments ($baseInstallArguments + @("-SkipClaudeCodeConfig")) -LogName "03-clean-install"

  $resultPath = Join-Path $installRoot "dinobrain-install-result.json"
  $installResult = Get-Content -LiteralPath $resultPath -Raw | ConvertFrom-Json
  if ($installResult.status -ne "complete" -or $installResult.full_equivalence -ne $true) { throw "Clean install did not report full equivalence." }
  if ($installResult.app.resolved_commit -ne $script:Config.app_commit -or $installResult.data.resolved_commit -ne $script:Config.data_commit) {
    throw "Installed commits do not match the pinned sandbox config."
  }

  $nodeRoot = Get-ChildItem -LiteralPath (Join-Path $env:LOCALAPPDATA "DinoBrain\tools") -Directory -Filter "node-v*-win-x64" | Sort-Object Name -Descending | Select-Object -First 1
  if ($null -eq $nodeRoot) { throw "Portable Node was not installed." }
  $nodeExe = Join-Path $nodeRoot.FullName "node.exe"
  $npmCmd = Join-Path $nodeRoot.FullName "npm.cmd"
  Set-UserPathPrefix -Paths @($nodeRoot.FullName, $clientRoot)
  Invoke-LoggedProcess -FilePath $npmCmd -Arguments @(
    "install", "--global", "--prefix", $clientRoot, "--no-audit", "--no-fund",
    "@openai/codex@$([string]$script:Config.codex_version)",
    "@anthropic-ai/claude-code@$([string]$script:Config.claude_version)"
  ) -LogName "04-install-clients"

  $codexCmd = Join-Path $clientRoot "codex.cmd"
  $claudeCmd = Join-Path $clientRoot "claude.cmd"
  if (-not (Test-Path -LiteralPath $codexCmd)) { throw "Pinned Codex CLI was not installed." }
  if (-not (Test-Path -LiteralPath $claudeCmd)) { throw "Pinned Claude Code bootstrap was not installed." }
  Invoke-LoggedProcess -FilePath $claudeCmd -Arguments @("install", [string]$script:Config.claude_version, "--force") -LogName "05-install-claude-native"
  $nativeClaude = Join-Path $env:USERPROFILE ".local\bin\claude.exe"
  if (-not (Test-Path -LiteralPath $nativeClaude)) { throw "Claude native executable was not installed." }
  Set-UserPathPrefix -Paths @((Split-Path -Parent $nativeClaude), $clientRoot, $nodeRoot.FullName, $gitCmd, $gitBin)

  Invoke-LoggedProcess -FilePath "powershell.exe" -Arguments ($baseInstallArguments + @("-ClaudeCommand", $nativeClaude)) -LogName "06-reinstall-client-config"
  $appPath = Join-Path $installRoot "dinobrain"
  $vaultPath = Join-Path $installRoot "dinobrain-data"
  $env:DINOBRAIN_DATA_DIR = $vaultPath
  Invoke-LoggedProcess -FilePath $npmCmd -Arguments @("run", "installer:verify:matrix") -WorkingDirectory $appPath -LogName "07-install-matrix"

  $desktop = [Environment]::GetFolderPath("Desktop")
  $pathPrefix = "$(Split-Path -Parent $nativeClaude);$clientRoot;$($nodeRoot.FullName);$gitCmd;$gitBin"
  $repairInstallArguments = ($baseInstallArguments | ForEach-Object { "'" + $_.Replace("'", "''") + "'" }) -join " "
  $repairScript = Join-Path $workRoot "restore-and-repair.ps1"
  if ([bool]$script:Config.private_restore_available) {
    Write-Utf8Text -Path $repairScript -Text @"
`$ErrorActionPreference = 'Stop'
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File '$appPath\scripts\start-private-restore.ps1' -AppPath '$appPath' -VaultPath '$vaultPath' -NodeExe '$nodeExe' -ArchivePath '$([string]$script:Config.guest_private_backup)' -KeyFile '$([string]$script:Config.guest_recovery_key)' -IncludeUserConfig -Yes
if (`$LASTEXITCODE -ne 0) { throw 'Private restore failed.' }
& powershell.exe $repairInstallArguments -ClaudeCommand '$nativeClaude'
if (`$LASTEXITCODE -ne 0) { throw 'Post-restore path repair failed.' }
Write-Host 'Private restore and path repair complete.'
"@
    Write-Utf8Text -Path (Join-Path $desktop "1 Restore Private Backup.cmd") -Text @"
@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -NoExit -File "$repairScript"
"@
  } else {
    Write-Utf8Text -Path (Join-Path $desktop "1 Private Backup Required.txt") -Text "Full both-client equivalence requires an encrypted .dinobrain backup and its recovery key. Close the Sandbox and relaunch the host proof with -PrivateBackupPath and -RecoveryKeyPath.`r`n"
  }

  Write-Utf8Text -Path (Join-Path $desktop "2 Sign in Codex.cmd") -Text @"
@echo off
set "PATH=$pathPrefix;%PATH%"
cd /d "$appPath"
call "$codexCmd" login
call "$codexCmd"
"@
  Write-Utf8Text -Path (Join-Path $desktop "3 Sign in Claude.cmd") -Text @"
@echo off
set "PATH=$pathPrefix;%PATH%"
set "CLAUDE_CODE_GIT_BASH_PATH=$bashExe"
cd /d "$appPath"
"$nativeClaude"
"@

  $proofExportScript = Join-Path $workRoot "run-proof-and-export.ps1"
  Write-Utf8Text -Path $proofExportScript -Text @"
`$ErrorActionPreference = 'Stop'
`$receipt = Join-Path `$env:LOCALAPPDATA 'DinoBrain\proofs\private-restore\latest.json'
if (-not (Test-Path -LiteralPath `$receipt)) { throw 'Restore receipt missing. Run step 1 first.' }
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File '$appPath\scripts\start-clean-machine-equivalence-proof.ps1' -Mode both_clients -AppPath '$appPath' -VaultPath '$vaultPath' -NodeExe '$nodeExe' -InstallResultPath '$resultPath' -RestoreReceiptPath `$receipt
`$proofExit = `$LASTEXITCODE
`$destination = 'C:\DinoBrainExchange\evidence'
New-Item -ItemType Directory -Force -Path `$destination | Out-Null
`$source = Join-Path '$vaultPath' '60_Operations\clean-machine'
if (Test-Path -LiteralPath `$source) { Copy-Item -Path (Join-Path `$source '*') -Destination `$destination -Recurse -Force }
Copy-Item -LiteralPath '$resultPath' -Destination (Join-Path `$destination 'dinobrain-install-result.json') -Force
[ordered]@{ run_id = '$([string]$script:Config.run_id)'; proof_exit_code = `$proofExit; exported_at = [DateTime]::UtcNow.ToString('o') } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path `$destination 'sandbox-proof-export.json') -Encoding UTF8
exit `$proofExit
"@
  Write-Utf8Text -Path (Join-Path $desktop "4 Run Full Recovery Proof.cmd") -Text @"
@echo off
set "PATH=$pathPrefix;%PATH%"
set "CLAUDE_CODE_GIT_BASH_PATH=$bashExe"
powershell.exe -NoProfile -ExecutionPolicy Bypass -NoExit -File "$proofExportScript"
"@

  $readmePath = Join-Path $desktop "DinoBrain Sandbox Proof Steps.txt"
  Write-Utf8Text -Path $readmePath -Text @"
DinoBrain Windows Sandbox clean-machine proof

Pinned app commit: $([string]$script:Config.app_commit)
Pinned data commit: $([string]$script:Config.data_commit)
Installer SHA-256: $([string]$script:Config.installer_sha256)

1. Run the private restore step. If no step-1 command exists, relaunch with backup/key inputs.
2. Run '2 Sign in Codex.cmd' and complete ChatGPT sign-in.
3. Run '3 Sign in Claude.cmd' and complete Claude sign-in.
4. Run '4 Run Full Recovery Proof.cmd'. Paste each copied challenge into the matching client.
5. Wait for PASS, then close Sandbox. Public-safe evidence is copied to C:\DinoBrainExchange\evidence on the host.

The Sandbox is disposable. Do not store credentials in C:\DinoBrainExchange.
"@

  Write-GuestStatus -Status "ready_for_login" -Message "Pinned install, reinstall, client install, and isolated matrix passed." -Extra @{
    app_commit = [string]$script:Config.app_commit
    data_commit = [string]$script:Config.data_commit
    install_result = "C:\DinoBrain\dinobrain-install-result.json"
    private_restore_available = [bool]$script:Config.private_restore_available
  }
  Start-Process explorer.exe -ArgumentList ('"' + $desktop + '"') | Out-Null
  Start-Process notepad.exe -ArgumentList ('"' + $readmePath + '"') | Out-Null
} catch {
  Write-GuestStatus -Status "failed" -Message $_.Exception.Message
  $errorPath = Join-Path $exchangeRoot "SANDBOX-BOOTSTRAP-FAILED.txt"
  Write-Utf8Text -Path $errorPath -Text ($_.Exception.ToString() + "`r`n")
  try { Start-Process notepad.exe -ArgumentList ('"' + $errorPath + '"') | Out-Null } catch {}
  throw
} finally {
  try { Stop-Transcript | Out-Null } catch {}
}
