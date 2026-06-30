#Requires -Version 5.1
[CmdletBinding()]
param(
  [string]$InstallRoot = "",
  [string]$AppRepo = "https://github.com/clockmansy/dinobrain.git",
  [string]$DataRepo = "https://github.com/clockmansy/dinobrain-data.git",
  [string]$AppDir = "",
  [string]$DataDir = "",
  [string]$NodeVersion = "24.18.0",
  [string]$ToolsDir = "",
  [string]$CodexConfigPath = "",
  [switch]$SkipCodexConfig,
  [switch]$SkipVerify,
  [switch]$Force
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Get-DefaultInstallRoot {
  $documents = [Environment]::GetFolderPath("MyDocuments")
  if ([string]::IsNullOrWhiteSpace($documents)) {
    return (Join-Path $HOME "Documents")
  }
  return $documents
}

function Get-DefaultToolsDir {
  if (-not [string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) {
    return (Join-Path $env:LOCALAPPDATA "DinoBrain\tools")
  }
  return (Join-Path $HOME "AppData\Local\DinoBrain\tools")
}

function Get-FullPath {
  param([Parameter(Mandatory = $true)][string]$PathValue)
  $expanded = [Environment]::ExpandEnvironmentVariables($PathValue)
  if ([System.IO.Path]::IsPathRooted($expanded)) {
    return [System.IO.Path]::GetFullPath($expanded)
  }
  return [System.IO.Path]::GetFullPath((Join-Path (Get-Location).Path $expanded))
}

function Assert-Command {
  param([Parameter(Mandatory = $true)][string]$Name)
  if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
    throw "Required command not found on PATH: $Name"
  }
}

function Invoke-NativeCommand {
  param(
    [Parameter(Mandatory = $true)][string]$FilePath,
    [Parameter(Mandatory = $true)][string[]]$ArgumentList,
    [Parameter(Mandatory = $true)][string]$WorkingDirectory
  )
  Write-Host ">> $FilePath $($ArgumentList -join ' ')"
  Push-Location $WorkingDirectory
  try {
    & $FilePath @ArgumentList
    $exitCode = $LASTEXITCODE
    if ($exitCode -ne 0) {
      throw "Command failed with exit code ${exitCode}: $FilePath $($ArgumentList -join ' ')"
    }
  } finally {
    Pop-Location
  }
}

function Sync-DinoBrainRepo {
  param(
    [Parameter(Mandatory = $true)][string]$Name,
    [Parameter(Mandatory = $true)][string]$RepoUrl,
    [Parameter(Mandatory = $true)][string]$TargetDir,
    [switch]$AllowOriginChange
  )

  if (Test-Path -LiteralPath $TargetDir) {
    if (-not (Test-Path -LiteralPath (Join-Path $TargetDir ".git"))) {
      throw "$Name target exists but is not a git repository: $TargetDir"
    }

    $currentOrigin = (& git -C $TargetDir remote get-url origin 2>$null)
    if ($LASTEXITCODE -ne 0) {
      throw "$Name repository has no origin remote: $TargetDir"
    }
    if ($currentOrigin -ne $RepoUrl) {
      if ($AllowOriginChange) {
        Invoke-NativeCommand -FilePath "git" -ArgumentList @("-C", $TargetDir, "remote", "set-url", "origin", $RepoUrl) -WorkingDirectory $TargetDir
      } else {
        throw "$Name origin is '$currentOrigin', expected '$RepoUrl'. Pass -Force to replace the origin URL."
      }
    }

    Invoke-NativeCommand -FilePath "git" -ArgumentList @("-C", $TargetDir, "fetch", "origin", "--prune") -WorkingDirectory $TargetDir
    Invoke-NativeCommand -FilePath "git" -ArgumentList @("-C", $TargetDir, "pull", "--ff-only", "origin", "main") -WorkingDirectory $TargetDir
    return
  }

  $parent = Split-Path -Parent $TargetDir
  New-Item -ItemType Directory -Force -Path $parent | Out-Null
  Invoke-NativeCommand -FilePath "git" -ArgumentList @("clone", $RepoUrl, $TargetDir) -WorkingDirectory $parent
}

function Install-PortableNode {
  param(
    [Parameter(Mandatory = $true)][string]$Version,
    [Parameter(Mandatory = $true)][string]$DestinationRoot
  )

  $nodeRoot = Join-Path $DestinationRoot "node-v$Version-win-x64"
  $nodeExe = Join-Path $nodeRoot "node.exe"
  if (Test-Path -LiteralPath $nodeExe) {
    Write-Host "Portable Node already exists: $nodeExe"
    return $nodeRoot
  }

  New-Item -ItemType Directory -Force -Path $DestinationRoot | Out-Null
  $zipName = "node-v$Version-win-x64.zip"
  $zipUrl = "https://nodejs.org/dist/v$Version/$zipName"
  $zipPath = Join-Path ([System.IO.Path]::GetTempPath()) $zipName

  Write-Host "Downloading portable Node: $zipUrl"
  $oldProgress = $ProgressPreference
  $ProgressPreference = "SilentlyContinue"
  try {
    Invoke-WebRequest -Uri $zipUrl -OutFile $zipPath
  } finally {
    $ProgressPreference = $oldProgress
  }

  Expand-Archive -Path $zipPath -DestinationPath $DestinationRoot -Force
  if (-not (Test-Path -LiteralPath $nodeExe)) {
    throw "Portable Node installation failed: $nodeExe"
  }
  return $nodeRoot
}

function Invoke-WithPortableNode {
  param(
    [Parameter(Mandatory = $true)][string]$NodeRoot,
    [Parameter(Mandatory = $true)][string]$FilePath,
    [Parameter(Mandatory = $true)][string[]]$ArgumentList,
    [Parameter(Mandatory = $true)][string]$WorkingDirectory
  )

  $oldPath = $env:PATH
  $env:PATH = "$NodeRoot;$oldPath"
  try {
    Invoke-NativeCommand -FilePath $FilePath -ArgumentList $ArgumentList -WorkingDirectory $WorkingDirectory
  } finally {
    $env:PATH = $oldPath
  }
}

function ConvertTo-TomlString {
  param([Parameter(Mandatory = $true)][string]$Value)
  if ($Value -notmatch "'") {
    return "'$Value'"
  }
  $escaped = $Value.Replace("\", "\\").Replace('"', '\"')
  return '"' + $escaped + '"'
}

function Remove-TomlSection {
  param(
    [AllowEmptyString()][string]$Text,
    [Parameter(Mandatory = $true)][string]$SectionName
  )
  $escaped = [regex]::Escape($SectionName)
  $pattern = "(?ms)^\[$escaped\]\r?\n.*?(?=^\[|\z)"
  return [regex]::Replace($Text, $pattern, "").TrimEnd()
}

function Set-DinoBrainCodexConfig {
  param(
    [Parameter(Mandatory = $true)][string]$ConfigPath,
    [Parameter(Mandatory = $true)][string]$NodeExe,
    [Parameter(Mandatory = $true)][string]$ServerEntry,
    [Parameter(Mandatory = $true)][string]$VaultPath
  )

  $configDir = Split-Path -Parent $ConfigPath
  New-Item -ItemType Directory -Force -Path $configDir | Out-Null

  $content = ""
  $backupPath = $null
  if (Test-Path -LiteralPath $ConfigPath) {
    $content = [System.IO.File]::ReadAllText($ConfigPath)
    $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
    $backupPath = "$ConfigPath.bak-dinobrain-$stamp"
    Copy-Item -LiteralPath $ConfigPath -Destination $backupPath
  }

  $content = Remove-TomlSection -Text $content -SectionName "mcp_servers.dinobrain"
  $content = Remove-TomlSection -Text $content -SectionName "mcp_servers.dinobrain.env"
  if (-not [string]::IsNullOrWhiteSpace($content)) {
    $content = $content.TrimEnd() + "`r`n`r`n"
  }

  $block = @(
    "[mcp_servers.dinobrain]",
    "args = [$(ConvertTo-TomlString $ServerEntry)]",
    "command = $(ConvertTo-TomlString $NodeExe)",
    "startup_timeout_sec = 120",
    "",
    "[mcp_servers.dinobrain.env]",
    "DINOBRAIN_DATA_DIR = $(ConvertTo-TomlString $VaultPath)",
    ""
  ) -join "`r`n"

  $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($ConfigPath, $content + $block, $utf8NoBom)
  if ($backupPath) {
    Write-Host "Codex config backup: $backupPath"
  }
  Write-Host "Codex MCP registered: $ConfigPath"
}

function Invoke-DinoBrainVerify {
  param(
    [Parameter(Mandatory = $true)][string]$NodeRoot,
    [Parameter(Mandatory = $true)][string]$AppPath,
    [Parameter(Mandatory = $true)][string]$ConfigPath,
    [Parameter(Mandatory = $true)][string]$VaultPath
  )

  $npmCmd = Join-Path $NodeRoot "npm.cmd"
  $oldConfig = $env:DINOBRAIN_CODEX_CONFIG_PATH
  $oldData = $env:DINOBRAIN_DATA_DIR
  $oldPath = $env:PATH
  $env:DINOBRAIN_CODEX_CONFIG_PATH = $ConfigPath
  $env:DINOBRAIN_DATA_DIR = $VaultPath
  $env:PATH = "$NodeRoot;$oldPath"
  try {
    Invoke-NativeCommand -FilePath $npmCmd -ArgumentList @("run", "verify:os") -WorkingDirectory $AppPath
  } finally {
    if ($null -eq $oldConfig) { Remove-Item Env:\DINOBRAIN_CODEX_CONFIG_PATH -ErrorAction SilentlyContinue } else { $env:DINOBRAIN_CODEX_CONFIG_PATH = $oldConfig }
    if ($null -eq $oldData) { Remove-Item Env:\DINOBRAIN_DATA_DIR -ErrorAction SilentlyContinue } else { $env:DINOBRAIN_DATA_DIR = $oldData }
    $env:PATH = $oldPath
  }
}

if ([string]::IsNullOrWhiteSpace($InstallRoot)) { $InstallRoot = Get-DefaultInstallRoot }
if ([string]::IsNullOrWhiteSpace($ToolsDir)) { $ToolsDir = Get-DefaultToolsDir }
if ([string]::IsNullOrWhiteSpace($CodexConfigPath)) { $CodexConfigPath = Join-Path $HOME ".codex\config.toml" }
if ([string]::IsNullOrWhiteSpace($AppDir)) { $AppDir = Join-Path $InstallRoot "dinobrain" }
if ([string]::IsNullOrWhiteSpace($DataDir)) { $DataDir = Join-Path $InstallRoot "dinobrain-data" }

$InstallRoot = Get-FullPath $InstallRoot
$AppDir = Get-FullPath $AppDir
$DataDir = Get-FullPath $DataDir
$ToolsDir = Get-FullPath $ToolsDir
$CodexConfigPath = Get-FullPath $CodexConfigPath

Write-Host "DinoBrain install root: $InstallRoot"
Write-Host "App repo target: $AppDir"
Write-Host "Data repo target: $DataDir"
Write-Host "Tools target: $ToolsDir"

Assert-Command "git"

Sync-DinoBrainRepo -Name "dinobrain" -RepoUrl $AppRepo -TargetDir $AppDir -AllowOriginChange:$Force
Sync-DinoBrainRepo -Name "dinobrain-data" -RepoUrl $DataRepo -TargetDir $DataDir -AllowOriginChange:$Force

$nodeRoot = Install-PortableNode -Version $NodeVersion -DestinationRoot $ToolsDir
$nodeExe = Join-Path $nodeRoot "node.exe"
$npmCmd = Join-Path $nodeRoot "npm.cmd"

Invoke-WithPortableNode -NodeRoot $nodeRoot -FilePath $npmCmd -ArgumentList @("install") -WorkingDirectory $AppDir
Invoke-WithPortableNode -NodeRoot $nodeRoot -FilePath $npmCmd -ArgumentList @("run", "build") -WorkingDirectory $AppDir

if (-not $SkipCodexConfig) {
  Set-DinoBrainCodexConfig -ConfigPath $CodexConfigPath -NodeExe $nodeExe -ServerEntry (Join-Path $AppDir "dist\index.js") -VaultPath $DataDir
}

if (-not $SkipVerify) {
  Invoke-DinoBrainVerify -NodeRoot $nodeRoot -AppPath $AppDir -ConfigPath $CodexConfigPath -VaultPath $DataDir
}

Write-Host ""
Write-Host "DinoBrain install complete."
Write-Host "App: $AppDir"
Write-Host "Data: $DataDir"
Write-Host "Node: $nodeExe"
Write-Host "Codex config: $CodexConfigPath"
