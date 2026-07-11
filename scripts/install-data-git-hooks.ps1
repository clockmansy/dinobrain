param(
  [string]$DataDir = "",
  [string]$AppDir = "",
  [string]$NodePath = ""
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
if ([string]::IsNullOrWhiteSpace($AppDir)) {
  $AppDir = Split-Path -Parent $PSScriptRoot
}
$AppDir = Get-FullPath $AppDir

$hookDir = Join-Path $DataDir ".githooks"
$preCommit = Join-Path $hookDir "pre-commit"
$prePush = Join-Path $hookDir "pre-push"
$guard = Join-Path $hookDir "verify-public-data-guard.ps1"

if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
  throw "Git is required to install DinoBrain data safety hooks."
}
if (-not (Test-Path -LiteralPath (Join-Path $DataDir ".git"))) {
  throw "DinoBrain data directory is not a git checkout: $DataDir"
}
foreach ($required in @($preCommit, $prePush, $guard)) {
  if (-not (Test-Path -LiteralPath $required)) {
    throw "Missing DinoBrain data safety hook file: $required"
  }
}

$gitDirText = (& git -C $DataDir rev-parse --git-dir)
if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($gitDirText)) {
  throw "Unable to resolve DinoBrain data Git directory: $DataDir"
}
$gitDir = $gitDirText.Trim()
if (-not [System.IO.Path]::IsPathRooted($gitDir)) {
  $gitDir = Join-Path $DataDir $gitDir
}
$gitDir = Get-FullPath $gitDir

if ([string]::IsNullOrWhiteSpace($NodePath)) {
  $nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
  if ($nodeCommand) {
    $NodePath = $nodeCommand.Source
  } else {
    $toolRoot = Join-Path $env:LOCALAPPDATA "DinoBrain\tools"
    if (Test-Path -LiteralPath $toolRoot) {
      $candidate = Get-ChildItem -LiteralPath $toolRoot -Filter node.exe -Recurse -File -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTimeUtc -Descending |
        Select-Object -First 1
      if ($candidate) { $NodePath = $candidate.FullName }
    }
  }
}
if ([string]::IsNullOrWhiteSpace($NodePath) -or -not (Test-Path -LiteralPath $NodePath)) {
  throw "Node.js is required for the unified DinoBrain data classifier."
}
$NodePath = Get-FullPath $NodePath

$classifierCli = Join-Path $AppDir "scripts\classify-data-git-surface.mjs"
$classifierRuntime = Join-Path $AppDir "dist\data-classification.js"
foreach ($required in @($classifierCli, $classifierRuntime)) {
  if (-not (Test-Path -LiteralPath $required)) {
    throw "Missing built DinoBrain data classifier file: $required"
  }
}

$policyVersion = (& $NodePath $classifierCli --print-policy-version)
if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($policyVersion)) {
  throw "Unable to read the DinoBrain data classifier policy version."
}
$policyVersion = $policyVersion.Trim()

$classifierConfigPath = Join-Path $gitDir "dinobrain-classifier.json"
$classifierConfig = [ordered]@{
  version = 1
  policy_version = $policyVersion
  node_path = $NodePath
  classifier_cli = $classifierCli
  app_root = $AppDir
  configured_at = [DateTime]::UtcNow.ToString("o")
}
$configJson = ($classifierConfig | ConvertTo-Json -Depth 4) -replace "`r`n", "`n" -replace "`r", "`n"
$configTemp = "$classifierConfigPath.tmp-$PID-$([Guid]::NewGuid().ToString('N'))"
[System.IO.File]::WriteAllText($configTemp, "$configJson`n", (New-Object System.Text.UTF8Encoding($false)))
Move-Item -LiteralPath $configTemp -Destination $classifierConfigPath -Force

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
  policy_version = $policyVersion
  classifier_config = $classifierConfigPath
  classifier_cli = $classifierCli
  node_path = $NodePath
  pre_commit = $preCommit
  pre_push = $prePush
} | ConvertTo-Json -Depth 4
