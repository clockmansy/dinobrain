#Requires -Version 5.1
[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$root = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$installScript = Join-Path $root "install.ps1"
$source = [System.IO.File]::ReadAllText($installScript)
$start = $source.IndexOf("function Get-DefaultInstallRoot")
$end = $source.IndexOf("function Assert-Command")
if ($start -lt 0 -or $end -lt 0 -or $end -le $start) {
  throw "Could not locate installer path helper functions."
}

$functionBlock = $source.Substring($start, $end - $start)
Invoke-Expression $functionBlock

function Assert-Equal {
  param(
    [Parameter(Mandatory = $true)][string]$Actual,
    [Parameter(Mandatory = $true)][string]$Expected,
    [Parameter(Mandatory = $true)][string]$Label
  )
  if ($Actual -ne $Expected) {
    throw "$Label failed. Expected '$Expected', got '$Actual'."
  }
}

$oldInstallRoot = $env:DINOBRAIN_INSTALL_ROOT
$oldDataRoot = $env:DINOBRAIN_DATA_DIR
$temp = Join-Path ([System.IO.Path]::GetTempPath()) ("dinobrain-path-ux-" + [guid]::NewGuid().ToString("N"))
try {
  $installRoot = Join-Path $temp "DinoRoot"
  $appPath = Join-Path $installRoot "dinobrain"
  $dataPath = Join-Path $installRoot "dinobrain-data"
  New-Item -ItemType Directory -Force -Path $appPath, $dataPath | Out-Null

  Assert-Equal `
    -Actual (Resolve-DinoBrainInstallRoot $appPath) `
    -Expected $installRoot `
    -Label "app folder normalization"

  Assert-Equal `
    -Actual (Resolve-DinoBrainInstallRoot $dataPath) `
    -Expected $installRoot `
    -Label "data folder normalization"

  $env:DINOBRAIN_INSTALL_ROOT = $appPath
  Remove-Item Env:\DINOBRAIN_DATA_DIR -ErrorAction SilentlyContinue
  Assert-Equal `
    -Actual (Get-DefaultInstallRoot) `
    -Expected $installRoot `
    -Label "explicit install root recommendation"

  Remove-Item Env:\DINOBRAIN_INSTALL_ROOT -ErrorAction SilentlyContinue
  $env:DINOBRAIN_DATA_DIR = $dataPath
  Assert-Equal `
    -Actual (Get-DefaultInstallRoot) `
    -Expected $installRoot `
    -Label "data dir recommendation"

  $setupFormPath = Join-Path $root "installer\DinoBrainSetup\SetupForm.cs"
  $setupForm = [System.IO.File]::ReadAllText($setupFormPath)
  foreach ($required in @("GetRecommendedInstallRoot", "NormalizeInstallRootInput", "UpdateInstallPathPreview", "No typing needed")) {
    if (-not $setupForm.Contains($required)) {
      throw "SetupForm.cs is missing required path UX marker: $required"
    }
  }

  Write-Host "installer path UX verification ok"
} finally {
  if ($null -eq $oldInstallRoot) { Remove-Item Env:\DINOBRAIN_INSTALL_ROOT -ErrorAction SilentlyContinue } else { $env:DINOBRAIN_INSTALL_ROOT = $oldInstallRoot }
  if ($null -eq $oldDataRoot) { Remove-Item Env:\DINOBRAIN_DATA_DIR -ErrorAction SilentlyContinue } else { $env:DINOBRAIN_DATA_DIR = $oldDataRoot }
  Remove-Item -LiteralPath $temp -Recurse -Force -ErrorAction SilentlyContinue
}
