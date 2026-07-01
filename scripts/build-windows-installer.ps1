#Requires -Version 5.1
[CmdletBinding()]
param(
  [string]$Configuration = "Release",
  [string]$Runtime = "win-x64",
  [string]$OutputDir = ""
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$root = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$project = Join-Path $root "installer\DinoBrainSetup\DinoBrainSetup.csproj"
if ([string]::IsNullOrWhiteSpace($OutputDir)) {
  $OutputDir = Join-Path $root "artifacts"
}
$OutputDir = [System.IO.Path]::GetFullPath($OutputDir)
$publishDir = Join-Path $OutputDir "DinoBrainSetup-$Runtime"
$finalExe = Join-Path $OutputDir "DinoBrainSetup.exe"

if (-not (Get-Command dotnet -ErrorAction SilentlyContinue)) {
  throw "dotnet SDK is required to build DinoBrainSetup.exe"
}

New-Item -ItemType Directory -Force -Path $publishDir | Out-Null
New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null

Write-Host "Publishing DinoBrainSetup.exe"
Write-Host "Project: $project"
Write-Host "Runtime: $Runtime"
Write-Host "Output: $publishDir"

dotnet publish $project `
  --configuration $Configuration `
  --runtime $Runtime `
  --self-contained true `
  -p:PublishSingleFile=true `
  -p:IncludeNativeLibrariesForSelfExtract=true `
  -p:EnableCompressionInSingleFile=true `
  -p:DebugType=none `
  -p:DebugSymbols=false `
  --output $publishDir
if ($LASTEXITCODE -ne 0) {
  throw "dotnet publish failed with exit code $LASTEXITCODE"
}

$publishedExe = Join-Path $publishDir "DinoBrainSetup.exe"
if (-not (Test-Path -LiteralPath $publishedExe)) {
  throw "Published EXE not found: $publishedExe"
}
Copy-Item -LiteralPath $publishedExe -Destination $finalExe -Force

$probePath = Join-Path ([System.IO.Path]::GetTempPath()) ("dinobrain-install-probe-" + [guid]::NewGuid().ToString("N") + ".ps1")
try {
  $process = Start-Process `
    -FilePath $finalExe `
    -ArgumentList @("--extract-install-script", $probePath) `
    -WindowStyle Hidden `
    -Wait `
    -PassThru
  if ($process.ExitCode -ne 0) {
    throw "Installer self-test failed with exit code $($process.ExitCode)"
  }
  if (-not (Test-Path -LiteralPath $probePath)) {
    throw "Installer self-test did not extract install.ps1"
  }
  $probeText = [System.IO.File]::ReadAllText($probePath)
  if ($probeText -notmatch "DinoBrain install complete") {
    throw "Extracted install.ps1 did not look like the DinoBrain installer"
  }
} finally {
  Remove-Item -LiteralPath $probePath -Force -ErrorAction SilentlyContinue
}

Write-Host ""
Write-Host "Built installer:"
Write-Host $finalExe
