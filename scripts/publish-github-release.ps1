#Requires -Version 5.1
[CmdletBinding()]
param(
  [string]$Repository = "clockmansy/dinobrain",
  [string]$Tag = "",
  [string]$Name = "",
  [string]$TargetCommitish = "",
  [string]$InstallerAppRef = "main",
  [string]$AssetPath = "",
  [string]$Token = "",
  [string]$DataRef = "main",
  [switch]$Draft,
  [switch]$Prerelease,
  [switch]$ReplaceAsset,
  [switch]$SkipBuild
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$root = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$package = Get-Content (Join-Path $root "package.json") -Raw | ConvertFrom-Json
if ([string]::IsNullOrWhiteSpace($Tag)) { $Tag = "v$($package.version)" }
if ([string]::IsNullOrWhiteSpace($Name)) { $Name = "DinoBrain $Tag" }
if ([string]::IsNullOrWhiteSpace($TargetCommitish)) {
  $TargetCommitish = (& git -C $root rev-parse HEAD)
  if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($TargetCommitish)) {
    throw "Could not determine current git commit. Pass -TargetCommitish explicitly."
  }
}
if ([string]::IsNullOrWhiteSpace($Token)) {
  if (-not [string]::IsNullOrWhiteSpace($env:GITHUB_TOKEN)) { $Token = $env:GITHUB_TOKEN }
  elseif (-not [string]::IsNullOrWhiteSpace($env:GH_TOKEN)) { $Token = $env:GH_TOKEN }
}
if ([string]::IsNullOrWhiteSpace($Token)) {
  throw "GitHub token missing. Set GITHUB_TOKEN or GH_TOKEN, or pass -Token."
}

if (-not $SkipBuild) {
  & (Join-Path $PSScriptRoot "build-windows-installer.ps1") -AppRef $InstallerAppRef -DataRef $DataRef -SetupVersion ([string]$package.version)
  if ($LASTEXITCODE -ne 0) { throw "Installer build failed." }
}

if ([string]::IsNullOrWhiteSpace($AssetPath)) {
  $AssetPath = Join-Path $root "artifacts\DinoBrainSetup.exe"
}
$AssetPath = [System.IO.Path]::GetFullPath($AssetPath)
if (-not (Test-Path -LiteralPath $AssetPath)) {
  throw "Release asset not found: $AssetPath"
}

$headers = @{
  "Accept" = "application/vnd.github+json"
  "Authorization" = "Bearer $Token"
  "User-Agent" = "DinoBrainReleasePublisher"
  "X-GitHub-Api-Version" = "2022-11-28"
}

function Invoke-GitHubJson {
  param(
    [Parameter(Mandatory = $true)][string]$Method,
    [Parameter(Mandatory = $true)][string]$Uri,
    [AllowNull()][object]$Body = $null
  )

  $args = @{
    Method = $Method
    Uri = $Uri
    Headers = $headers
  }
  if ($null -ne $Body) {
    $args["ContentType"] = "application/json"
    $args["Body"] = ($Body | ConvertTo-Json -Depth 10)
  }
  Invoke-RestMethod @args
}

function Get-GitHubReleaseByTag {
  param([Parameter(Mandatory = $true)][string]$ReleaseTag)
  try {
    return Invoke-GitHubJson -Method "Get" -Uri "https://api.github.com/repos/$Repository/releases/tags/$ReleaseTag"
  } catch {
    $response = $_.Exception.Response
    if ($response -and [int]$response.StatusCode -eq 404) { return $null }
    throw
  }
}

$release = Get-GitHubReleaseByTag -ReleaseTag $Tag
$releaseBody = @"
DinoBrain Windows installer.

Asset source commit: $TargetCommitish
Installer app ref: $InstallerAppRef
Installer data ref: $DataRef
"@
if ($null -eq $release) {
  $release = Invoke-GitHubJson -Method "Post" -Uri "https://api.github.com/repos/$Repository/releases" -Body @{
    tag_name = $Tag
    target_commitish = $TargetCommitish
    name = $Name
    body = $releaseBody
    draft = [bool]$Draft
    prerelease = [bool]$Prerelease
  }
  Write-Host "Created GitHub release: $($release.html_url)"
} else {
  $release = Invoke-GitHubJson -Method "Patch" -Uri "https://api.github.com/repos/$Repository/releases/$($release.id)" -Body @{
    name = $Name
    body = $releaseBody
    draft = [bool]$Draft
    prerelease = [bool]$Prerelease
  }
  Write-Host "Using existing GitHub release: $($release.html_url)"
}

$assetName = Split-Path -Leaf $AssetPath
$assets = Invoke-GitHubJson -Method "Get" -Uri "https://api.github.com/repos/$Repository/releases/$($release.id)/assets"
$existingAsset = @($assets | Where-Object { $_.name -eq $assetName } | Select-Object -First 1)
if ($existingAsset.Count -gt 0) {
  if (-not $ReplaceAsset) {
    throw "Release asset already exists: $assetName. Pass -ReplaceAsset to replace it."
  }
  Invoke-GitHubJson -Method "Delete" -Uri "https://api.github.com/repos/$Repository/releases/assets/$($existingAsset[0].id)" | Out-Null
  Write-Host "Deleted existing release asset: $assetName"
}

$uploadBase = [string]$release.upload_url
$uploadBase = $uploadBase -replace "\{\?name,label\}$", ""
$encodedName = [System.Uri]::EscapeDataString($assetName)
$uploadUrl = "${uploadBase}?name=$encodedName"
Invoke-RestMethod `
  -Method Post `
  -Uri $uploadUrl `
  -Headers $headers `
  -ContentType "application/octet-stream" `
  -InFile $AssetPath | Out-Null

Write-Host "Uploaded release asset: $assetName"
Write-Host $release.html_url
