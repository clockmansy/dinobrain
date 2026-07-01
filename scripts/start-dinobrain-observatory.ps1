#Requires -Version 5.1
[CmdletBinding()]
param(
  [string]$DataDir = "",
  [string]$NodeRoot = "",
  [int]$Port = 3847,
  [switch]$NoBrowser
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$appRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
if ([string]::IsNullOrWhiteSpace($DataDir)) {
  $DataDir = [System.IO.Path]::GetFullPath((Join-Path $appRoot "..\dinobrain-data"))
} else {
  $DataDir = [System.IO.Path]::GetFullPath([Environment]::ExpandEnvironmentVariables($DataDir))
}

if ([string]::IsNullOrWhiteSpace($NodeRoot)) {
  $toolsDir = if (-not [string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) {
    Join-Path $env:LOCALAPPDATA "DinoBrain\tools"
  } else {
    Join-Path $HOME "AppData\Local\DinoBrain\tools"
  }
  $nodeRootItem = Get-ChildItem -LiteralPath $toolsDir -Directory -Filter "node-v*-win-x64" -ErrorAction SilentlyContinue |
    Sort-Object Name -Descending |
    Select-Object -First 1
  if (-not $nodeRootItem) {
    throw "Portable Node was not found under $toolsDir. Run DinoBrainSetup.exe first."
  }
  $NodeRoot = $nodeRootItem.FullName
} else {
  $NodeRoot = [System.IO.Path]::GetFullPath([Environment]::ExpandEnvironmentVariables($NodeRoot))
}

$npmCmd = Join-Path $NodeRoot "npm.cmd"
if (-not (Test-Path -LiteralPath $npmCmd)) {
  throw "npm.cmd was not found: $npmCmd"
}

if (-not (Test-Path -LiteralPath $DataDir)) {
  throw "DinoBrain data folder was not found: $DataDir"
}

$oldPath = $env:PATH
$oldData = $env:DINOBRAIN_DATA_DIR
$oldPort = $env:DINOBRAIN_OBSERVATORY_PORT
$env:PATH = "$NodeRoot;$oldPath"
$env:DINOBRAIN_DATA_DIR = $DataDir
$env:DINOBRAIN_OBSERVATORY_PORT = [string]$Port
$url = "http://127.0.0.1:$Port/"

try {
  Write-Host "DinoBrain Observatory"
  Write-Host "App: $appRoot"
  Write-Host "Data: $DataDir"
  Write-Host "URL: $url"
  if (-not $NoBrowser) {
    Start-Job -ScriptBlock {
      param([string]$TargetUrl)
      Start-Sleep -Milliseconds 900
      Start-Process $TargetUrl
    } -ArgumentList $url | Out-Null
  }
  Push-Location $appRoot
  try {
    & $npmCmd run observatory
    if ($LASTEXITCODE -ne 0) {
      throw "DinoBrain Observatory exited with code $LASTEXITCODE"
    }
  } finally {
    Pop-Location
  }
} finally {
  $env:PATH = $oldPath
  if ($null -eq $oldData) { Remove-Item Env:\DINOBRAIN_DATA_DIR -ErrorAction SilentlyContinue } else { $env:DINOBRAIN_DATA_DIR = $oldData }
  if ($null -eq $oldPort) { Remove-Item Env:\DINOBRAIN_OBSERVATORY_PORT -ErrorAction SilentlyContinue } else { $env:DINOBRAIN_OBSERVATORY_PORT = $oldPort }
}
