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
  [string]$CodexRequirementsPath = "",
  [string]$CodexManagedHookDir = "",
  [string]$ClaudeCommand = "claude",
  [switch]$SkipCodexHookConfig,
  [switch]$SkipCodexManagedHookConfig,
  [switch]$SkipClaudeCodeConfig,
  [switch]$RemoveAppRepo,
  [switch]$RemoveDataRepo,
  [switch]$RemovePortableNode,
  [switch]$RemoveLaunchers,
  [switch]$RemoveCodexBackups,
  [switch]$Purge,
  [switch]$Yes,
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

function Get-DefaultProgramData {
  if (-not [string]::IsNullOrWhiteSpace($env:ProgramData)) {
    return $env:ProgramData
  }
  return "C:\ProgramData"
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

function Remove-DinoBrainManagedHookBlock {
  param([AllowEmptyString()][string]$Text)
  return [regex]::Replace(
    $Text,
    "(?ms)^\s*# DinoBrain managed UserPromptSubmit begin\r?\n.*?^\s*# DinoBrain managed UserPromptSubmit end\r?\n?",
    ""
  ).TrimEnd()
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
  if ($Value.GetType().Name -eq "PSCustomObject") {
    $result = [ordered]@{}
    foreach ($property in @($Value.PSObject.Properties)) {
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

  $originalGroups = New-Object System.Collections.ArrayList
  foreach ($group in @($config["hooks"]["UserPromptSubmit"])) {
    [void]$originalGroups.Add($group)
  }
  $remainingGroups = New-Object System.Collections.ArrayList
  foreach ($group in $originalGroups) {
    if (-not (Test-DinoBrainHookGroup $group)) {
      [void]$remainingGroups.Add($group)
    }
  }
  if ($remainingGroups.Count -eq $originalGroups.Count) {
    Write-Host "DinoBrain user hook was not present: $HooksPath"
    return
  }

  if ($remainingGroups.Count -gt 0) {
    $config["hooks"]["UserPromptSubmit"] = @($remainingGroups.ToArray())
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

function Remove-DinoBrainCodexManagedHook {
  param(
    [Parameter(Mandatory = $true)][string]$RequirementsPath,
    [Parameter(Mandatory = $true)][string]$ManagedDir
  )

  if (Test-Path -LiteralPath $RequirementsPath) {
    $content = [System.IO.File]::ReadAllText($RequirementsPath)
    $updated = Remove-DinoBrainManagedHookBlock -Text $content
    if ($updated -ne $content.TrimEnd()) {
      $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
      $backupPath = "$RequirementsPath.bak-dinobrain-uninstall-$stamp"
      Copy-Item -LiteralPath $RequirementsPath -Destination $backupPath
      $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
      [System.IO.File]::WriteAllText($RequirementsPath, $updated.TrimEnd() + "`r`n", $utf8NoBom)
      Write-Host "Removed DinoBrain managed Codex hook from requirements.toml."
      Write-Host "Codex requirements backup: $backupPath"
    } else {
      Write-Host "DinoBrain managed hook block was not present: $RequirementsPath"
    }
  } else {
    Write-Host "Codex requirements not found: $RequirementsPath"
  }

  $wrapper = Join-Path $ManagedDir "dinobrain-managed-user-prompt-hook.ps1"
  if (Test-Path -LiteralPath $wrapper) {
    Write-Host "Removing DinoBrain managed hook wrapper: $wrapper"
    Remove-Item -LiteralPath $wrapper -Force
  }
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

function Remove-DinoBrainLaunchers {
  param(
    [Parameter(Mandatory = $true)][string]$InstallRootPath,
    [Parameter(Mandatory = $true)][string]$AppPath
  )

  $launcherNames = @(
    "DinoBrain Observatory.cmd",
    "DinoBrain Hook Diagnose.cmd",
    "DinoBrain Codex Hook Approval.cmd",
    "DinoBrain Codex Managed Hook Admin.cmd",
    "DinoBrain Codex Live Proof.cmd",
    "DinoBrain Uninstall Everything.cmd"
  )
  $launcherRoots = @($InstallRootPath, $AppPath)
  foreach ($rootPath in $launcherRoots) {
    if ([string]::IsNullOrWhiteSpace($rootPath)) { continue }
    foreach ($launcherName in $launcherNames) {
      $launcherPath = Join-Path $rootPath $launcherName
      if (Test-Path -LiteralPath $launcherPath) {
        Write-Host "Removing launcher: $launcherPath"
        Remove-Item -LiteralPath $launcherPath -Force
      }
    }
  }
}

function Remove-DinoBrainCodexBackups {
  param(
    [Parameter(Mandatory = $true)][string]$ConfigPath,
    [Parameter(Mandatory = $true)][string]$HooksPath,
    [Parameter(Mandatory = $true)][string]$RequirementsPath
  )

  foreach ($pathValue in @($ConfigPath, $HooksPath, $RequirementsPath)) {
    $parent = Split-Path -Parent $pathValue
    $leaf = Split-Path -Leaf $pathValue
    if (-not (Test-Path -LiteralPath $parent)) { continue }
    Get-ChildItem -LiteralPath $parent -File -Filter "$leaf.bak-dinobrain*" | ForEach-Object {
      Write-Host "Removing DinoBrain backup: $($_.FullName)"
      Remove-Item -LiteralPath $_.FullName -Force
    }
  }
}

function Remove-EmptyDirectory {
  param(
    [Parameter(Mandatory = $true)][string]$TargetPath,
    [Parameter(Mandatory = $true)][string]$Label
  )

  $full = Get-FullPath $TargetPath
  if (-not (Test-Path -LiteralPath $full)) { return }
  $items = @(Get-ChildItem -LiteralPath $full -Force -ErrorAction SilentlyContinue)
  if ($items.Count -eq 0) {
    Write-Host "Removing empty ${Label}: $full"
    Remove-Item -LiteralPath $full -Force
  }
}

function Confirm-DinoBrainPurge {
  param(
    [Parameter(Mandatory = $true)][string]$AppPath,
    [Parameter(Mandatory = $true)][string]$DataPath,
    [Parameter(Mandatory = $true)][string]$NodePath
  )

  if ($Yes) { return }

  Write-Host ""
  Write-Host "DinoBrain purge will permanently remove:"
  Write-Host "- App repo: $AppPath"
  Write-Host "- Data vault: $DataPath"
  Write-Host "- Portable Node: $NodePath"
  Write-Host "- DinoBrain launchers and DinoBrain config backups"
  Write-Host ""
  Write-Host "Codex/Claude registrations will be removed first. This cannot be undone from this machine unless your data repo has been pushed/backed up."
  $answer = Read-Host "Type DELETE DINOBRAIN to continue"
  if ($answer -ne "DELETE DINOBRAIN") {
    throw "Purge canceled."
  }
}

if ([string]::IsNullOrWhiteSpace($InstallRoot)) { $InstallRoot = Get-DefaultInstallRoot }
if ([string]::IsNullOrWhiteSpace($ToolsDir)) { $ToolsDir = Get-DefaultToolsDir }
if ([string]::IsNullOrWhiteSpace($CodexConfigPath)) { $CodexConfigPath = Join-Path $HOME ".codex\config.toml" }
if ([string]::IsNullOrWhiteSpace($CodexHooksPath)) { $CodexHooksPath = Join-Path $HOME ".codex\hooks.json" }
if ([string]::IsNullOrWhiteSpace($CodexRequirementsPath)) { $CodexRequirementsPath = Join-Path (Get-DefaultProgramData) "OpenAI\Codex\requirements.toml" }
if ([string]::IsNullOrWhiteSpace($CodexManagedHookDir)) { $CodexManagedHookDir = Join-Path (Get-DefaultProgramData) "OpenAI\Codex\DinoBrainHooks" }
if ([string]::IsNullOrWhiteSpace($AppDir)) { $AppDir = Join-Path $InstallRoot "dinobrain" }
if ([string]::IsNullOrWhiteSpace($DataDir)) { $DataDir = Join-Path $InstallRoot "dinobrain-data" }

$InstallRoot = Get-FullPath $InstallRoot
$AppDir = Get-FullPath $AppDir
$DataDir = Get-FullPath $DataDir
$ToolsDir = Get-FullPath $ToolsDir
$CodexConfigPath = Get-FullPath $CodexConfigPath
$CodexHooksPath = Get-FullPath $CodexHooksPath
$CodexRequirementsPath = Get-FullPath $CodexRequirementsPath
$CodexManagedHookDir = Get-FullPath $CodexManagedHookDir
$nodeRoot = Join-Path $ToolsDir "node-v$NodeVersion-win-x64"

if ($Purge) {
  $RemoveAppRepo = $true
  $RemoveDataRepo = $true
  $RemovePortableNode = $true
  $RemoveLaunchers = $true
  $RemoveCodexBackups = $true
  $Force = $true
}

Remove-DinoBrainCodexConfig -ConfigPath $CodexConfigPath
if (-not $SkipCodexHookConfig) {
  Remove-DinoBrainCodexUserHook -HooksPath $CodexHooksPath
}
if (-not $SkipCodexManagedHookConfig) {
  Remove-DinoBrainCodexManagedHook -RequirementsPath $CodexRequirementsPath -ManagedDir $CodexManagedHookDir
}
if (-not $SkipClaudeCodeConfig) {
  Remove-DinoBrainClaudeCodeConfig -ClaudeCommand $ClaudeCommand
}

if (($RemoveAppRepo -or $RemoveDataRepo -or $RemovePortableNode -or $RemoveLaunchers -or $RemoveCodexBackups) -and -not $Force) {
  throw "Pass -Force to remove files from disk. Without remove flags, uninstall only unregisters MCP integrations."
}

if ($Purge) {
  Confirm-DinoBrainPurge -AppPath $AppDir -DataPath $DataDir -NodePath $nodeRoot
}

if ($RemoveLaunchers) { Remove-DinoBrainLaunchers -InstallRootPath $InstallRoot -AppPath $AppDir }
if ($RemoveCodexBackups) { Remove-DinoBrainCodexBackups -ConfigPath $CodexConfigPath -HooksPath $CodexHooksPath -RequirementsPath $CodexRequirementsPath }
if ($RemoveAppRepo) { Remove-InstallPath -TargetPath $AppDir -Label "DinoBrain app repo" }
if ($RemoveDataRepo) { Remove-InstallPath -TargetPath $DataDir -Label "DinoBrain data repo" }
if ($RemovePortableNode) { Remove-InstallPath -TargetPath $nodeRoot -Label "DinoBrain portable Node" }
if ($RemovePortableNode) { Remove-EmptyDirectory -TargetPath $ToolsDir -Label "DinoBrain tools folder" }
if ($Purge) { Remove-EmptyDirectory -TargetPath $InstallRoot -Label "DinoBrain install root" }

Write-Host "DinoBrain uninstall complete."
