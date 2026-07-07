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
  [switch]$SkipBuild,
  [switch]$SkipUpload
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
if ([string]::IsNullOrWhiteSpace($Token) -and -not $SkipUpload) {
  throw "GitHub token missing. Set GITHUB_TOKEN or GH_TOKEN, or pass -Token."
}

if (-not $SkipBuild) {
  & (Join-Path $PSScriptRoot "build-windows-installer.ps1") -AppRef $InstallerAppRef -DataRef $DataRef -SetupVersion ([string]$package.version)
  if ($LASTEXITCODE -ne 0) { throw "Installer build failed." }
}

function Assert-DinoBrainInstallerClosedLoop {
  param([Parameter(Mandatory = $true)][string]$InstallerPath)
  $InstallerPath = [System.IO.Path]::GetFullPath($InstallerPath)
  if (-not (Test-Path -LiteralPath $InstallerPath)) {
    throw "Installer EXE not found: $InstallerPath"
  }
  $probePath = Join-Path ([System.IO.Path]::GetTempPath()) ("dinobrain-release-probe-" + [guid]::NewGuid().ToString("N") + ".ps1")
  try {
    $process = Start-Process `
      -FilePath $InstallerPath `
      -ArgumentList @("--extract-install-script", $probePath) `
      -WindowStyle Hidden `
      -Wait `
      -PassThru
    if ($process.ExitCode -ne 0) {
      throw "Installer closed-loop self-test failed with exit code $($process.ExitCode)"
    }
    if (-not (Test-Path -LiteralPath $probePath)) {
      throw "Installer closed-loop self-test did not extract install.ps1"
    }
    $probeText = [System.IO.File]::ReadAllText($probePath)
    if ($probeText -notmatch "verify:codex-loop") {
      throw "Installer install.ps1 does not include verify:codex-loop"
    }
  } finally {
    Remove-Item -LiteralPath $probePath -Force -ErrorAction SilentlyContinue
  }
}

function Assert-DinoBrainReleaseAssetClosedLoop {
  param([Parameter(Mandatory = $true)][string]$Path)
  $Path = [System.IO.Path]::GetFullPath($Path)
  $extension = [System.IO.Path]::GetExtension($Path).ToLowerInvariant()
  if ($extension -eq ".exe") {
    Assert-DinoBrainInstallerClosedLoop -InstallerPath $Path
    return
  }
  if ($extension -ne ".zip") { return }

  $probeDir = Join-Path ([System.IO.Path]::GetTempPath()) ("dinobrain-release-asset-" + [guid]::NewGuid().ToString("N"))
  try {
    Expand-Archive -LiteralPath $Path -DestinationPath $probeDir -Force
    $installer = Get-ChildItem -LiteralPath $probeDir -Recurse -Filter "DinoBrainSetup.exe" | Select-Object -First 1
    if ($null -eq $installer) {
      throw "Release ZIP does not contain DinoBrainSetup.exe: $Path"
    }
    Assert-DinoBrainInstallerClosedLoop -InstallerPath $installer.FullName
  } finally {
    Remove-Item -LiteralPath $probeDir -Recurse -Force -ErrorAction SilentlyContinue
  }
}

function New-DinoBrainReleasePackage {
  param(
    [Parameter(Mandatory = $true)][string]$InstallerPath,
    [Parameter(Mandatory = $true)][string]$PackageVersion
  )

  $InstallerPath = [System.IO.Path]::GetFullPath($InstallerPath)
  if (-not (Test-Path -LiteralPath $InstallerPath)) {
    throw "Installer EXE not found: $InstallerPath"
  }

  $artifactsDir = Join-Path $root "artifacts"
  $packageDir = Join-Path $artifactsDir "DinoBrainSetup-package"
  $zipPath = Join-Path $artifactsDir "DinoBrainSetup.zip"
  $shaPath = Join-Path $artifactsDir "DinoBrainSetup.zip.sha256"

  if (Test-Path -LiteralPath $packageDir) {
    Remove-Item -LiteralPath $packageDir -Recurse -Force
  }
  New-Item -ItemType Directory -Force -Path $packageDir | Out-Null

  Copy-Item -LiteralPath $InstallerPath -Destination (Join-Path $packageDir "DinoBrainSetup.exe") -Force
  $readme = @"
DinoBrain Windows Setup $PackageVersion

Install:
1. Extract this ZIP.
2. Run DinoBrainSetup.exe.
3. If Windows blocks the unknown publisher prompt, choose More info, then Run anyway.
4. Use DinoBrain Codex Hook Approval.cmd if it opens, or run /hooks in Codex.
5. Review and trust the DinoBrain hook when Codex asks.

Reinstall:
- Running DinoBrainSetup.exe over the same DinoBrain install folder is supported for normal updates.
- Existing app and data folders must be DinoBrain git checkouts. Non-git folders are not overwritten.

Full uninstall:
- Run DinoBrain Uninstall Everything.cmd from the install folder.
- Type DELETE DINOBRAIN when prompted.
"@
  Set-Content -LiteralPath (Join-Path $packageDir "README-INSTALL.txt") -Value $readme -Encoding ASCII

  Remove-Item -LiteralPath $zipPath -Force -ErrorAction SilentlyContinue
  Compress-Archive -Path (Join-Path $packageDir "*") -DestinationPath $zipPath -Force

  $hash = (Get-FileHash -LiteralPath $zipPath -Algorithm SHA256).Hash.ToLowerInvariant()
  Set-Content -LiteralPath $shaPath -Value "$hash  DinoBrainSetup.zip" -Encoding ASCII

  [pscustomobject]@{
    ZipPath = $zipPath
    ShaPath = $shaPath
    Sha256 = $hash
  }
}

$assetPaths = @()
if ([string]::IsNullOrWhiteSpace($AssetPath)) {
  $installerPath = Join-Path $root "artifacts\DinoBrainSetup.exe"
  $releasePackage = New-DinoBrainReleasePackage -InstallerPath $installerPath -PackageVersion ([string]$package.version)
  $assetPaths += $releasePackage.ZipPath
  $assetPaths += $releasePackage.ShaPath
  Write-Host "Packaged release ZIP: $($releasePackage.ZipPath)"
  Write-Host "ZIP SHA256: $($releasePackage.Sha256)"
} else {
  $assetPaths += [System.IO.Path]::GetFullPath($AssetPath)
}

foreach ($assetPath in $assetPaths) {
  if (-not (Test-Path -LiteralPath $assetPath)) {
    throw "Release asset not found: $assetPath"
  }
  Assert-DinoBrainReleaseAssetClosedLoop -Path $assetPath
}

if ($SkipUpload) {
  Write-Host "SkipUpload set; release assets prepared:"
  foreach ($assetPath in $assetPaths) {
    Write-Host $assetPath
  }
  return
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
Primary asset: DinoBrainSetup.zip
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

function Publish-ReleaseAsset {
  param([Parameter(Mandatory = $true)][string]$Path)

  $assetName = Split-Path -Leaf $Path
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
    -InFile $Path | Out-Null

  Write-Host "Uploaded release asset: $assetName"
}

foreach ($assetPath in $assetPaths) {
  Publish-ReleaseAsset -Path $assetPath
}
Write-Host $release.html_url
