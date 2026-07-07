param(
  [string]$DataDir = ""
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

function Get-FullPath {
  param([Parameter(Mandatory = $true)][string]$Path)
  return [System.IO.Path]::GetFullPath($Path)
}

if ([string]::IsNullOrWhiteSpace($DataDir)) {
  if (-not [string]::IsNullOrWhiteSpace($env:DINOBRAIN_DATA_DIR)) {
    $DataDir = $env:DINOBRAIN_DATA_DIR
  } else {
    $DataDir = Join-Path (Split-Path -Parent $PSScriptRoot) "..\dinobrain-data"
  }
}

$DataDir = Get-FullPath $DataDir
$gitDir = Join-Path $DataDir ".git"
$hookDir = Join-Path $DataDir ".githooks"
$preCommit = Join-Path $hookDir "pre-commit"
$prePush = Join-Path $hookDir "pre-push"
$guard = Join-Path $hookDir "verify-public-data-guard.ps1"

if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
  throw "Git is required to install DinoBrain data safety hooks."
}
if (-not (Test-Path -LiteralPath $gitDir)) {
  throw "DinoBrain data directory is not a git checkout: $DataDir"
}
foreach ($required in @($preCommit, $prePush, $guard)) {
  if (-not (Test-Path -LiteralPath $required)) {
    throw "Missing DinoBrain data safety hook file: $required"
  }
}

& git -C $DataDir config core.hooksPath .githooks
if ($LASTEXITCODE -ne 0) {
  throw "Failed to configure core.hooksPath for $DataDir"
}

$configured = (& git -C $DataDir config --get core.hooksPath)
if ($LASTEXITCODE -ne 0 -or $configured.Trim() -ne ".githooks") {
  throw "DinoBrain data safety hooks were not configured. Expected .githooks, got '$configured'."
}

[pscustomobject]@{
  ok = $true
  data_dir = $DataDir
  hooks_path = $configured.Trim()
  pre_commit = $preCommit
  pre_push = $prePush
} | ConvertTo-Json -Depth 4
