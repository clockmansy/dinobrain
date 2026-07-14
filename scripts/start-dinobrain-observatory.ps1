#Requires -Version 5.1
[CmdletBinding()]
param(
  [string]$DataDir = "",
  [string]$NodeRoot = "",
  [int]$Port = 3847,
  [ValidateRange(128, 1024)][int]$MaxOldSpaceMb = 192,
  [switch]$NoBrowser
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$ExpectedObservatoryVersion = "2026-07-14-local-only-v1"

function Get-PortOwnerProcess {
  param([Parameter(Mandatory = $true)][int]$LocalPort)
  $connection = Get-NetTCPConnection -LocalPort $LocalPort -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $connection) {
    return $null
  }
  $process = Get-CimInstance Win32_Process -Filter "ProcessId=$($connection.OwningProcess)" -ErrorAction SilentlyContinue
  return [pscustomobject]@{
    ProcessId = $connection.OwningProcess
    CommandLine = if ($process) { [string]$process.CommandLine } else { "" }
  }
}

function Test-CurrentObservatory {
  param(
    [Parameter(Mandatory = $true)][string]$BaseUrl,
    [Parameter(Mandatory = $true)][string]$ExpectedDataDir,
    [Parameter(Mandatory = $true)][string]$ExpectedVersion
  )
  try {
    $health = Invoke-RestMethod -Uri "$BaseUrl/api/health" -TimeoutSec 2 -ErrorAction Stop
    if (-not $health.ok -or [string]$health.observatory_version -ne $ExpectedVersion) {
      return $false
    }
    $actualDataDir = [System.IO.Path]::GetFullPath([string]$health.data_root)
    return $actualDataDir -ieq $ExpectedDataDir
  } catch {
    return $false
  }
}

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

$nodeExe = Join-Path $NodeRoot "node.exe"
if (-not (Test-Path -LiteralPath $nodeExe)) {
  throw "node.exe was not found: $nodeExe"
}
$observatoryScript = Join-Path $appRoot "scripts\dinobrain-observatory.mjs"
if (-not (Test-Path -LiteralPath $observatoryScript)) { throw "Observatory script was not found: $observatoryScript" }

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
  $portOwner = Get-PortOwnerProcess -LocalPort $Port
  if ($portOwner) {
    if (Test-CurrentObservatory -BaseUrl $url -ExpectedDataDir $DataDir -ExpectedVersion $ExpectedObservatoryVersion) {
      Write-Host "Current DinoBrain Observatory is already running on $url"
      if (-not $NoBrowser) {
        Start-Process $url
      }
      return
    }
    if ($portOwner.CommandLine -match "dinobrain-observatory\.mjs") {
      Write-Warning "Stale DinoBrain Observatory is already using port $Port. Restarting it with the current app."
      Stop-Process -Id $portOwner.ProcessId -Force -ErrorAction Stop
      Start-Sleep -Milliseconds 700
    } else {
      throw "Port $Port is already in use by process $($portOwner.ProcessId): $($portOwner.CommandLine)"
    }
  }
  if (-not $NoBrowser) {
    Start-Job -ScriptBlock {
      param([string]$TargetUrl)
      Start-Sleep -Milliseconds 900
      Start-Process $TargetUrl
    } -ArgumentList $url | Out-Null
  }
  Push-Location $appRoot
  try {
    & $nodeExe "--max-old-space-size=$MaxOldSpaceMb" "--max-semi-space-size=8" $observatoryScript "--port=$Port"
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
