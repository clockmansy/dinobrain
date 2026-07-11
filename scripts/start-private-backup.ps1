#Requires -Version 5.1
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$AppPath,
  [Parameter(Mandatory = $true)][string]$VaultPath,
  [Parameter(Mandatory = $true)][string]$NodeExe,
  [string]$KeyFile = "",
  [string]$OutputPath = "",
  [switch]$IncludeUserConfig,
  [switch]$IncludeCredentials,
  [switch]$IncludeLocalBackups
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$app = [System.IO.Path]::GetFullPath($AppPath)
$vault = [System.IO.Path]::GetFullPath($VaultPath)
$node = [System.IO.Path]::GetFullPath($NodeExe)
$runner = Join-Path $app "dist\run-private-backup.js"
if (-not (Test-Path -LiteralPath $node -PathType Leaf)) { throw "Node runtime not found: $node" }
if (-not (Test-Path -LiteralPath $runner -PathType Leaf)) { throw "Private backup CLI not built: $runner" }
if (-not (Test-Path -LiteralPath $vault -PathType Container)) { throw "DinoBrain data vault not found: $vault" }

$documents = [Environment]::GetFolderPath("MyDocuments")
if ([string]::IsNullOrWhiteSpace($documents)) { $documents = $env:USERPROFILE }
$backupRoot = Join-Path $documents "DinoBrain Backups"
if ([string]::IsNullOrWhiteSpace($KeyFile)) { $KeyFile = Join-Path $documents "DinoBrain Recovery Key.txt" }
if ([string]::IsNullOrWhiteSpace($OutputPath)) {
  $OutputPath = Join-Path $backupRoot ("DinoBrain-Private-Backup-{0}.dinobrain" -f (Get-Date -Format "yyyyMMdd-HHmmss"))
}
$key = [System.IO.Path]::GetFullPath($KeyFile)
$output = [System.IO.Path]::GetFullPath($OutputPath)
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $output) | Out-Null

if (-not (Test-Path -LiteralPath $key -PathType Leaf)) {
  & $node $runner keygen --key-file $key --protect-root $app --protect-root $vault --protect-root (Split-Path -Parent $output)
  if ($LASTEXITCODE -ne 0) { throw "Recovery key generation failed with exit code $LASTEXITCODE." }
  Write-Warning "A new recovery key was created. Move a copy to a separate secure device. DinoBrain cannot recover the backup without it."
}

$arguments = @(
  $runner, "create",
  "--app-root", $app,
  "--data-root", $vault,
  "--output", $output,
  "--key-file", $key
)
if ($IncludeUserConfig) { $arguments += "--include-user-config" }
if ($IncludeCredentials) { $arguments += "--include-credentials" }
if ($IncludeLocalBackups) { $arguments += "--include-local-backups" }
& $node @arguments
if ($LASTEXITCODE -ne 0) { throw "Private backup failed with exit code $LASTEXITCODE." }

Write-Host ""
Write-Host "Encrypted private backup created: $output"
Write-Host "Recovery key file: $key"
Write-Warning "Do not store the only copy of the recovery key beside the backup or only on this PC."
