#Requires -Version 5.1
[CmdletBinding()]
param(
  [string]$InstallRoot = "",
  [string]$AppDir = "",
  [string]$DataDir = "",
  [string]$NodeVersion = "24.18.0",
  [string]$ToolsDir = "",
  [string]$CodexConfigPath = "",
  [switch]$RemoveAppRepo,
  [switch]$RemoveDataRepo,
  [switch]$RemovePortableNode,
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

function Remove-TomlSection {
  param(
    [AllowEmptyString()][string]$Text,
    [Parameter(Mandatory = $true)][string]$SectionName
  )
  $escaped = [regex]::Escape($SectionName)
  $pattern = "(?ms)^\[$escaped\]\r?\n.*?(?=^\[|\z)"
  return [regex]::Replace($Text, $pattern, "").TrimEnd()
}

function Remove-DinoBrainCodexConfig {
  param([Parameter(Mandatory = $true)][string]$ConfigPath)
  if (-not (Test-Path -LiteralPath $ConfigPath)) {
    Write-Host "Codex config not found: $ConfigPath"
    return
  }

  $content = [System.IO.File]::ReadAllText($ConfigPath)
  $updated = Remove-TomlSection -Text $content -SectionName "mcp_servers.dinobrain"
  $updated = Remove-TomlSection -Text $updated -SectionName "mcp_servers.dinobrain.env"
  if ($updated -eq $content.TrimEnd()) {
    Write-Host "DinoBrain MCP block was not present: $ConfigPath"
    return
  }

  $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
  $backupPath = "$ConfigPath.bak-dinobrain-uninstall-$stamp"
  Copy-Item -LiteralPath $ConfigPath -Destination $backupPath
  $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($ConfigPath, $updated.TrimEnd() + "`r`n", $utf8NoBom)
  Write-Host "Removed DinoBrain MCP registration."
  Write-Host "Codex config backup: $backupPath"
}

function Assert-SafeDeleteTarget {
  param([Parameter(Mandatory = $true)][string]$TargetPath)
  $full = Get-FullPath $TargetPath
  $root = [System.IO.Path]::GetPathRoot($full)
  $homePath = Get-FullPath $HOME
  $documentsPath = Get-FullPath (Get-DefaultInstallRoot)
  if ($full -eq $root -or $full -eq $homePath -or $full -eq $documentsPath) {
    throw "Refusing to remove broad path: $full"
  }
  if ($full.Length -lt 12) {
    throw "Refusing to remove suspiciously short path: $full"
  }
  return $full
}

function Remove-InstallPath {
  param(
    [Parameter(Mandatory = $true)][string]$TargetPath,
    [Parameter(Mandatory = $true)][string]$Label
  )
  $full = Assert-SafeDeleteTarget $TargetPath
  if (-not (Test-Path -LiteralPath $full)) {
    Write-Host "${Label} not found: $full"
    return
  }
  Write-Host "Removing ${Label}: $full"
  Remove-Item -LiteralPath $full -Recurse -Force
}

if ([string]::IsNullOrWhiteSpace($InstallRoot)) { $InstallRoot = Get-DefaultInstallRoot }
if ([string]::IsNullOrWhiteSpace($ToolsDir)) { $ToolsDir = Get-DefaultToolsDir }
if ([string]::IsNullOrWhiteSpace($CodexConfigPath)) { $CodexConfigPath = Join-Path $HOME ".codex\config.toml" }
if ([string]::IsNullOrWhiteSpace($AppDir)) { $AppDir = Join-Path $InstallRoot "dinobrain" }
if ([string]::IsNullOrWhiteSpace($DataDir)) { $DataDir = Join-Path $InstallRoot "dinobrain-data" }

$AppDir = Get-FullPath $AppDir
$DataDir = Get-FullPath $DataDir
$ToolsDir = Get-FullPath $ToolsDir
$CodexConfigPath = Get-FullPath $CodexConfigPath
$nodeRoot = Join-Path $ToolsDir "node-v$NodeVersion-win-x64"

Remove-DinoBrainCodexConfig -ConfigPath $CodexConfigPath

if (($RemoveAppRepo -or $RemoveDataRepo -or $RemovePortableNode) -and -not $Force) {
  throw "Pass -Force to remove files from disk. Without remove flags, uninstall only unregisters Codex MCP."
}

if ($RemoveAppRepo) { Remove-InstallPath -TargetPath $AppDir -Label "DinoBrain app repo" }
if ($RemoveDataRepo) { Remove-InstallPath -TargetPath $DataDir -Label "DinoBrain data repo" }
if ($RemovePortableNode) { Remove-InstallPath -TargetPath $nodeRoot -Label "DinoBrain portable Node" }

Write-Host "DinoBrain uninstall complete."
