#Requires -Version 5.1
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$AppPath,
  [Parameter(Mandatory = $true)][string]$VaultPath,
  [Parameter(Mandatory = $true)][string]$NodeExe,
  [string]$KeyFile = "",
  [string]$BackupRoot = "",
  [ValidateRange(1, 3650)][int]$MaxAgeDays = 90,
  [ValidateRange(1, 3650)][int]$KeepLatest = 30,
  [switch]$IncludeUserConfig,
  [switch]$IncludeCredentials
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$app = [System.IO.Path]::GetFullPath($AppPath)
$vault = [System.IO.Path]::GetFullPath($VaultPath)
$node = [System.IO.Path]::GetFullPath($NodeExe)
$documents = [Environment]::GetFolderPath("MyDocuments")
if ([string]::IsNullOrWhiteSpace($documents)) { $documents = $env:USERPROFILE }
if ([string]::IsNullOrWhiteSpace($BackupRoot)) { $BackupRoot = Join-Path $documents "DinoBrain Backups" }
if ([string]::IsNullOrWhiteSpace($KeyFile)) { $KeyFile = Join-Path $documents "DinoBrain Recovery Key.txt" }
$backupDir = [System.IO.Path]::GetFullPath($BackupRoot)
$key = [System.IO.Path]::GetFullPath($KeyFile)
$archive = Join-Path $backupDir ("DinoBrain-Private-Backup-{0}.dinobrain" -f (Get-Date -Format "yyyyMMdd-HHmmss"))
$createScript = Join-Path $app "scripts\start-private-backup.ps1"
$runner = Join-Path $app "dist\run-private-backup.js"
if (-not (Test-Path -LiteralPath $createScript -PathType Leaf)) { throw "Backup script not found: $createScript" }
if (-not (Test-Path -LiteralPath $runner -PathType Leaf)) { throw "Private backup CLI not built: $runner" }
New-Item -ItemType Directory -Force -Path $backupDir | Out-Null

$createArguments = @(
  "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $createScript,
  "-AppPath", $app, "-VaultPath", $vault, "-NodeExe", $node,
  "-KeyFile", $key, "-OutputPath", $archive
)
if ($IncludeUserConfig) { $createArguments += "-IncludeUserConfig" }
if ($IncludeCredentials) { $createArguments += "-IncludeCredentials" }
& powershell.exe @createArguments
if ($LASTEXITCODE -ne 0) { throw "Encrypted backup creation failed with exit code $LASTEXITCODE." }

$verifyOutput = & $node $runner verify --app-root $app --data-root $vault --archive $archive --key-file $key --max-age-days ([string]$MaxAgeDays)
if ($LASTEXITCODE -ne 0) { throw "Encrypted backup verification failed with exit code $LASTEXITCODE." }
$verification = ($verifyOutput -join "`n") | ConvertFrom-Json
if (-not $verification.ok -or [string]$verification.status -ne "verified") { throw "Encrypted backup did not return a verified result." }

$statusPath = Join-Path $vault ".dino\state\private-backup-status.json"
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $statusPath) | Out-Null
$status = [ordered]@{
  version = "dinobrain_private_backup_status_v1"
  status = "verified"
  verified_at = [string]$verification.verified_at
  archive_path = $archive
  archive_sha256 = [string]$verification.archive_sha256
  archive_size_bytes = [long]$verification.archive_size_bytes
  restored_entry_count = [int]$verification.restored_entry_count
  restored_plaintext_bytes = [long]$verification.restored_plaintext_bytes
  source_identity = $verification.source_identity
  destructive_restore = $false
  recovery_key_separate = $true
}
$temporaryStatus = "$statusPath.$PID.tmp"
$status | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $temporaryStatus -Encoding UTF8
Move-Item -LiteralPath $temporaryStatus -Destination $statusPath -Force

$archives = @(Get-ChildItem -LiteralPath $backupDir -Filter "DinoBrain-Private-Backup-*.dinobrain" -File | Sort-Object LastWriteTime -Descending)
if ($archives.Count -gt $KeepLatest) {
  foreach ($old in $archives[$KeepLatest..($archives.Count - 1)]) {
    Remove-Item -LiteralPath $old.FullName -Force
  }
}

Write-Host "Encrypted backup created and restore-verified: $archive"
Write-Host "Verification status: $statusPath"
