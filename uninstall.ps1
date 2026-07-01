#Requires -Version 5.1
[CmdletBinding()]
param(
  [string]$InstallRoot = "",
  [string]$AppDir = "",
  [string]$DataDir = "",
  [string]$NodeVersion = "24.18.0",
  [string]$ToolsDir = "",
  [string]$CodexConfigPath = "",
  [string]$CodexHooksPath = "",
  [string]$ClaudeCommand = "claude",
  [switch]$SkipCodexHookConfig,
  [switch]$SkipClaudeCodeConfig,
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

function ConvertTo-Hashtable {
  param([AllowNull()][object]$Value)
  if ($null -eq $Value) { return $null }
  if ($Value -is [string]) { return $Value }
  if ($Value -is [System.Collections.IDictionary]) {
    $result = [ordered]@{}
    foreach ($key in $Value.Keys) {
      $result[$key] = ConvertTo-Hashtable $Value[$key]
    }
    return $result
  }
  if ($Value -is [System.Collections.IEnumerable] -and -not ($Value -is [string])) {
    return @($Value | ForEach-Object { ConvertTo-Hashtable $_ })
  }
  if ($Value.PSObject -and $Value.PSObject.Properties.Count -gt 0 -and $Value.GetType().Name -eq "PSCustomObject") {
    $result = [ordered]@{}
    foreach ($property in $Value.PSObject.Properties) {
      $result[$property.Name] = ConvertTo-Hashtable $property.Value
    }
    return $result
  }
  return $Value
}

function Test-DinoBrainHookGroup {
  param([AllowNull()][object]$Group)
  if ($null -eq $Group) { return $false }
  $text = ($Group | ConvertTo-Json -Depth 20 -Compress)
  return $text -match "dinobrain-user-prompt-hook\.ps1" -or $text -match "Loading DinoBrain context"
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

function Remove-DinoBrainCodexUserHook {
  param([Parameter(Mandatory = $true)][string]$HooksPath)
  if (-not (Test-Path -LiteralPath $HooksPath)) {
    Write-Host "Codex user hooks not found: $HooksPath"
    return
  }

  $raw = [System.IO.File]::ReadAllText($HooksPath)
  if ([string]::IsNullOrWhiteSpace($raw)) {
    Write-Host "Codex user hooks file is empty: $HooksPath"
    return
  }

  $config = ConvertTo-Hashtable ($raw | ConvertFrom-Json)
  if (-not $config.Contains("hooks") -or -not ($config["hooks"] -is [System.Collections.IDictionary])) {
    Write-Host "Codex user hooks file has no editable hooks object: $HooksPath"
    return
  }
  if (-not $config["hooks"].Contains("UserPromptSubmit")) {
    Write-Host "DinoBrain user hook was not present: $HooksPath"
    return
  }

  $originalGroups = @($config["hooks"]["UserPromptSubmit"])
  $remainingGroups = @($originalGroups | Where-Object { -not (Test-DinoBrainHookGroup $_) })
  if ($remainingGroups.Count -eq $originalGroups.Count) {
    Write-Host "DinoBrain user hook was not present: $HooksPath"
    return
  }

  if ($remainingGroups.Count -gt 0) {
    $config["hooks"]["UserPromptSubmit"] = @($remainingGroups)
  } else {
    $config["hooks"].Remove("UserPromptSubmit")
  }

  $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
  $backupPath = "$HooksPath.bak-dinobrain-uninstall-$stamp"
  Copy-Item -LiteralPath $HooksPath -Destination $backupPath
  $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($HooksPath, ($config | ConvertTo-Json -Depth 40) + "`r`n", $utf8NoBom)
  Write-Host "Removed DinoBrain Codex user hook."
  Write-Host "Codex user hooks backup: $backupPath"
}

function Remove-DinoBrainClaudeCodeConfig {
  param([Parameter(Mandatory = $true)][string]$ClaudeCommand)
  $command = Get-Command $ClaudeCommand -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $command) {
    Write-Host "Claude Code CLI not found, skipping Claude Code MCP removal: $ClaudeCommand"
    return
  }

  $claudeExe = if (-not [string]::IsNullOrWhiteSpace($command.Source)) { $command.Source } else { $ClaudeCommand }
  $argumentList = @("mcp", "remove", "dinobrain")
  $output = & $claudeExe @argumentList 2>&1
  if ($LASTEXITCODE -eq 0) {
    Write-Host "Removed Claude Code MCP registration: dinobrain"
    return
  }

  Write-Host "Claude Code MCP registration was not removed or was not present: dinobrain"
  if ($output) {
    Write-Host ($output -join "`n")
  }
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
if ([string]::IsNullOrWhiteSpace($CodexHooksPath)) { $CodexHooksPath = Join-Path $HOME ".codex\hooks.json" }
if ([string]::IsNullOrWhiteSpace($AppDir)) { $AppDir = Join-Path $InstallRoot "dinobrain" }
if ([string]::IsNullOrWhiteSpace($DataDir)) { $DataDir = Join-Path $InstallRoot "dinobrain-data" }

$AppDir = Get-FullPath $AppDir
$DataDir = Get-FullPath $DataDir
$ToolsDir = Get-FullPath $ToolsDir
$CodexConfigPath = Get-FullPath $CodexConfigPath
$CodexHooksPath = Get-FullPath $CodexHooksPath
$nodeRoot = Join-Path $ToolsDir "node-v$NodeVersion-win-x64"

Remove-DinoBrainCodexConfig -ConfigPath $CodexConfigPath
if (-not $SkipCodexHookConfig) {
  Remove-DinoBrainCodexUserHook -HooksPath $CodexHooksPath
}
if (-not $SkipClaudeCodeConfig) {
  Remove-DinoBrainClaudeCodeConfig -ClaudeCommand $ClaudeCommand
}

if (($RemoveAppRepo -or $RemoveDataRepo -or $RemovePortableNode) -and -not $Force) {
  throw "Pass -Force to remove files from disk. Without remove flags, uninstall only unregisters MCP integrations."
}

if ($RemoveAppRepo) { Remove-InstallPath -TargetPath $AppDir -Label "DinoBrain app repo" }
if ($RemoveDataRepo) { Remove-InstallPath -TargetPath $DataDir -Label "DinoBrain data repo" }
if ($RemovePortableNode) { Remove-InstallPath -TargetPath $nodeRoot -Label "DinoBrain portable Node" }

Write-Host "DinoBrain uninstall complete."
