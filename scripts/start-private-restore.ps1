#Requires -Version 5.1
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$AppPath,
  [Parameter(Mandatory = $true)][string]$VaultPath,
  [Parameter(Mandatory = $true)][string]$NodeExe,
  [string]$KeyFile = "",
  [string]$ArchivePath = "",
  [ValidateRange(1, 3650)][int]$MaxAgeDays = 90,
  [switch]$IncludeUserConfig,
  [switch]$OverwritePrivate,
  [switch]$Yes
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$app = [System.IO.Path]::GetFullPath($AppPath)
$vault = [System.IO.Path]::GetFullPath($VaultPath)
$node = [System.IO.Path]::GetFullPath($NodeExe)
$runner = Join-Path $app "dist\run-private-backup.js"
if (-not (Test-Path -LiteralPath $node -PathType Leaf)) { throw "Node runtime not found: $node" }
if (-not (Test-Path -LiteralPath $runner -PathType Leaf)) { throw "Private restore CLI not built: $runner" }
if (-not (Test-Path -LiteralPath $vault -PathType Container)) { throw "DinoBrain data vault not found: $vault" }

$documents = [Environment]::GetFolderPath("MyDocuments")
if ([string]::IsNullOrWhiteSpace($documents)) { $documents = $env:USERPROFILE }
if ([string]::IsNullOrWhiteSpace($KeyFile)) { $KeyFile = Join-Path $documents "DinoBrain Recovery Key.txt" }
if ([string]::IsNullOrWhiteSpace($ArchivePath)) {
  $latest = Get-ChildItem -LiteralPath (Join-Path $documents "DinoBrain Backups") -Filter "*.dinobrain" -File -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1
  if ($latest) { $ArchivePath = $latest.FullName }
}
if ([string]::IsNullOrWhiteSpace($ArchivePath)) { $ArchivePath = Read-Host "Encrypted .dinobrain backup path" }
if ([string]::IsNullOrWhiteSpace($KeyFile) -or -not (Test-Path -LiteralPath $KeyFile -PathType Leaf)) {
  $KeyFile = Read-Host "Recovery key file path"
}
$archive = [System.IO.Path]::GetFullPath($ArchivePath)
$key = [System.IO.Path]::GetFullPath($KeyFile)
if (-not (Test-Path -LiteralPath $archive -PathType Leaf)) { throw "Encrypted backup not found: $archive" }
if (-not (Test-Path -LiteralPath $key -PathType Leaf)) { throw "Recovery key not found: $key" }

& $node $runner inspect --archive $archive
if ($LASTEXITCODE -ne 0) { throw "Backup inspection failed with exit code $LASTEXITCODE." }

if (-not $Yes) {
  Write-Host ""
  Write-Host "Restore target: $vault"
  Write-Host "Existing private files are blocked unless -OverwritePrivate is explicitly used."
  $confirmation = Read-Host "Type RESTORE DINOBRAIN to continue"
  if ($confirmation -cne "RESTORE DINOBRAIN") { throw "Restore cancelled." }
}

$arguments = @(
  $runner, "restore", "--apply",
  "--app-root", $app,
  "--data-root", $vault,
  "--archive", $archive,
  "--key-file", $key,
  "--max-age-days", [string]$MaxAgeDays
)
if ($IncludeUserConfig) { $arguments += "--include-user-config" }
if ($OverwritePrivate) { $arguments += "--overwrite-private" }
& $node @arguments
if ($LASTEXITCODE -ne 0) { throw "Private restore failed with exit code $LASTEXITCODE." }

Write-Host "Encrypted private restore completed. Restart Codex and Claude Code before using restored configuration."
