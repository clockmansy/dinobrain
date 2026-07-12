#Requires -Version 5.1
[CmdletBinding()]
param(
  [string]$AppPath = "",
  [string]$VaultPath = "",
  [string]$RequirementsPath = "",
  [string]$ManagedDir = "",
  [switch]$Elevate,
  [switch]$Json
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Resolve-DefaultPath {
  param([Parameter(Mandatory = $true)][string]$PathValue)
  $expanded = [Environment]::ExpandEnvironmentVariables($PathValue)
  if ([System.IO.Path]::IsPathRooted($expanded)) {
    return [System.IO.Path]::GetFullPath($expanded)
  }
  return [System.IO.Path]::GetFullPath((Join-Path (Get-Location).Path $expanded))
}

function Get-ProgramDataPath {
  if (-not [string]::IsNullOrWhiteSpace($env:ProgramData)) { return $env:ProgramData }
  return "C:\ProgramData"
}

function Test-Administrator {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = [Security.Principal.WindowsPrincipal]::new($identity)
  return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function ConvertTo-TomlString {
  param([Parameter(Mandatory = $true)][string]$Value)
  if ($Value -notmatch "'") { return "'$Value'" }
  $escaped = $Value.Replace("\", "\\").Replace('"', '\"')
  return '"' + $escaped + '"'
}

function ConvertTo-PowerShellSingleQuotedString {
  param([Parameter(Mandatory = $true)][string]$Value)
  return "'" + $Value.Replace("'", "''") + "'"
}

function ConvertTo-DinoBrainCrLfText {
  param([AllowEmptyString()][AllowNull()][string]$Text)
  if ($null -eq $Text) { return "" }
  $normalized = $Text.Replace("`r`n", "`n").Replace("`r", "`n")
  return $normalized.Replace("`n", "`r`n")
}

function Assert-NoBareCarriageReturn {
  param(
    [Parameter(Mandatory = $true)][string]$Text,
    [Parameter(Mandatory = $true)][string]$Label
  )
  $match = [regex]::Match($Text, "`r(?!`n)")
  if ($match.Success) {
    throw "$Label contains a carriage return that is not followed by a newline at character offset $($match.Index)."
  }
}

function Get-TomlSection {
  param(
    [AllowEmptyString()][string]$Text,
    [Parameter(Mandatory = $true)][string]$SectionName
  )
  $escaped = [regex]::Escape($SectionName)
  $match = [regex]::Match($Text, "(?ms)^\[$escaped\]\r?\n(?<body>.*?)(?=^\[|\z)")
  if ($match.Success) { return $match.Groups["body"].Value }
  return ""
}

function Get-TomlValue {
  param(
    [AllowEmptyString()][string]$Section,
    [Parameter(Mandatory = $true)][string]$KeyName
  )
  $escaped = [regex]::Escape($KeyName)
  $match = [regex]::Match($Section, "(?m)^\s*$escaped\s*=\s*(?<value>.+?)\s*$")
  if ($match.Success) { return $match.Groups["value"].Value.Trim() }
  return $null
}

function ConvertFrom-TomlString {
  param([AllowNull()][string]$Value)
  if ([string]::IsNullOrWhiteSpace($Value)) { return "" }
  $trimmed = $Value.Trim()
  if ($trimmed.Length -ge 2 -and $trimmed[0] -eq "'" -and $trimmed[$trimmed.Length - 1] -eq "'") {
    return $trimmed.Substring(1, $trimmed.Length - 2)
  }
  if ($trimmed.Length -ge 2 -and $trimmed[0] -eq '"' -and $trimmed[$trimmed.Length - 1] -eq '"') {
    return $trimmed.Substring(1, $trimmed.Length - 2).Replace('\"', '"').Replace("\\", "\")
  }
  return $trimmed
}

function Set-TomlSectionKey {
  param(
    [AllowEmptyString()][string]$Text,
    [Parameter(Mandatory = $true)][string]$SectionName,
    [Parameter(Mandatory = $true)][string]$KeyName,
    [Parameter(Mandatory = $true)][string]$Value
  )

  if ($null -eq $Text) { $Text = "" }
  $line = "$KeyName = $Value"
  $escapedSection = [regex]::Escape($SectionName)
  $sectionPattern = "(?ms)^(?<header>\[$escapedSection\]\r?\n)(?<body>.*?)(?=^\[|\z)"
  $sectionMatch = [regex]::Match($Text, $sectionPattern)
  if ($sectionMatch.Success) {
    $bodyGroup = $sectionMatch.Groups["body"]
    $body = $bodyGroup.Value
    $escapedKey = [regex]::Escape($KeyName)
    $keyPattern = [regex]"(?m)^\s*$escapedKey\s*=.*$"
    if ($keyPattern.IsMatch($body)) {
      $newBody = $keyPattern.Replace($body, $line, 1)
    } else {
      $newBody = $body
      if ($newBody.Length -gt 0 -and -not $newBody.EndsWith("`n")) {
        $newBody += "`r`n"
      }
      $newBody += "$line`r`n"
    }
    return $Text.Substring(0, $bodyGroup.Index) + $newBody + $Text.Substring($bodyGroup.Index + $bodyGroup.Length)
  }

  $prefix = ""
  if (-not [string]::IsNullOrWhiteSpace($Text)) {
    $prefix = $Text.TrimEnd() + "`r`n`r`n"
  }
  return $prefix + "[$SectionName]`r`n$line`r`n"
}

function Remove-DinoBrainManagedHookBlock {
  param([AllowEmptyString()][string]$Text)
  return [regex]::Replace(
    $Text,
    "(?ms)^\s*# DinoBrain managed UserPromptSubmit begin\r?\n.*?^\s*# DinoBrain managed UserPromptSubmit end\r?\n?",
    ""
  ).TrimEnd()
}

if ([string]::IsNullOrWhiteSpace($AppPath)) {
  $AppPath = Resolve-DefaultPath (Join-Path $PSScriptRoot "..")
} else {
  $AppPath = Resolve-DefaultPath $AppPath
}
if ([string]::IsNullOrWhiteSpace($VaultPath)) {
  $VaultPath = Resolve-DefaultPath (Join-Path $AppPath "..\dinobrain-data")
} else {
  $VaultPath = Resolve-DefaultPath $VaultPath
}
if ([string]::IsNullOrWhiteSpace($RequirementsPath)) {
  $RequirementsPath = Join-Path (Get-ProgramDataPath) "OpenAI\Codex\requirements.toml"
} else {
  $RequirementsPath = Resolve-DefaultPath $RequirementsPath
}
if ([string]::IsNullOrWhiteSpace($ManagedDir)) {
  $ManagedDir = Join-Path (Get-ProgramDataPath) "OpenAI\Codex\DinoBrainHooks"
} else {
  $ManagedDir = Resolve-DefaultPath $ManagedDir
}

if ($Elevate -and -not (Test-Administrator)) {
  $args = @(
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-NoExit",
    "-File",
    $PSCommandPath,
    "-AppPath",
    $AppPath,
    "-VaultPath",
    $VaultPath,
    "-RequirementsPath",
    $RequirementsPath,
    "-ManagedDir",
    $ManagedDir
  )
  Start-Process -FilePath "powershell.exe" -ArgumentList $args -Verb RunAs | Out-Null
  if ($Json) {
    [ordered]@{
      ok = $true
      elevated = $true
      message = "Elevation requested for managed Codex hook installation."
    } | ConvertTo-Json -Depth 4
  } else {
    Write-Host "Elevation requested for managed Codex hook installation."
  }
  exit 0
}

$hookScript = Join-Path $AppPath "scripts\dinobrain-user-prompt-hook.ps1"
if (-not (Test-Path -LiteralPath $hookScript)) {
  throw "DinoBrain hook script not found: $hookScript"
}

$requirementsText = ""
$backupPath = $null
if (Test-Path -LiteralPath $RequirementsPath) {
  $requirementsText = ConvertTo-DinoBrainCrLfText ([System.IO.File]::ReadAllText($RequirementsPath))
  $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
  $backupPath = "$RequirementsPath.bak-dinobrain-$stamp"
  Copy-Item -LiteralPath $RequirementsPath -Destination $backupPath
}

$hooksSection = Get-TomlSection -Text $requirementsText -SectionName "hooks"
$existingManagedDir = ConvertFrom-TomlString (Get-TomlValue -Section $hooksSection -KeyName "windows_managed_dir")
if (-not [string]::IsNullOrWhiteSpace($existingManagedDir)) {
  $ManagedDir = Resolve-DefaultPath $existingManagedDir
}

New-Item -ItemType Directory -Force -Path $ManagedDir | Out-Null
$managedWrapper = Join-Path $ManagedDir "dinobrain-managed-user-prompt-hook.ps1"
$wrapperContent = @"
# Generated by DinoBrain. Safe to overwrite.
`$ErrorActionPreference = "Stop"
`$env:DINOBRAIN_DATA_DIR = $(ConvertTo-PowerShellSingleQuotedString $VaultPath)
`$env:DINOBRAIN_AUTO_GROWTH = "0"
`$env:DINOBRAIN_AUTO_COMPOUND = "0"
`$env:DINOBRAIN_AUTO_SYNC = "0"
`$env:DINOBRAIN_AUTO_SYNC_ALLOW_CONDITIONAL = "0"
`$env:DINOBRAIN_AUTO_SYNC_PUSH = "0"
`$env:DINOBRAIN_HOOK_AUTO_SYNC = "0"
`$env:DINOBRAIN_HOOK_IMPORT_SESSION = "0"
`$env:DINOBRAIN_HOOK_CONTEXT_LIMIT = "3"
`$env:DINOBRAIN_HOOK_LEASE_SECONDS = "3600"
`$env:DINOBRAIN_HOOK_SOFT_TIMEOUT_MS = "6000"
`$env:DINOBRAIN_HOOK_TIMEOUT_SECONDS = "8"
& $(ConvertTo-PowerShellSingleQuotedString $hookScript)
exit `$LASTEXITCODE
"@

$utf8NoBom = [System.Text.UTF8Encoding]::new($false)
[System.IO.File]::WriteAllText($managedWrapper, (ConvertTo-DinoBrainCrLfText $wrapperContent), $utf8NoBom)

$requirementsText = Remove-DinoBrainManagedHookBlock -Text $requirementsText
$requirementsText = Set-TomlSectionKey -Text $requirementsText -SectionName "features" -KeyName "hooks" -Value "true"
$requirementsText = Set-TomlSectionKey -Text $requirementsText -SectionName "hooks" -KeyName "windows_managed_dir" -Value (ConvertTo-TomlString $ManagedDir)
if (-not [string]::IsNullOrWhiteSpace($requirementsText)) {
  $requirementsText = $requirementsText.TrimEnd() + "`r`n`r`n"
}

$managedCommand = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$managedWrapper`""
$hookBlock = @(
  "# DinoBrain managed UserPromptSubmit begin",
  "[[hooks.UserPromptSubmit]]",
  'matcher = ""',
  "",
  "[[hooks.UserPromptSubmit.hooks]]",
  'type = "command"',
  "command = $(ConvertTo-TomlString $managedCommand)",
  "command_windows = $(ConvertTo-TomlString $managedCommand)",
  "timeout = 12",
  'statusMessage = "Loading DinoBrain context"',
  "# DinoBrain managed UserPromptSubmit end",
  ""
) -join "`r`n"

$finalText = ConvertTo-DinoBrainCrLfText ($requirementsText + $hookBlock)
Assert-NoBareCarriageReturn -Text $finalText -Label $RequirementsPath
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $RequirementsPath) | Out-Null
[System.IO.File]::WriteAllText($RequirementsPath, $finalText, $utf8NoBom)

$report = [ordered]@{
  ok = $true
  generated_at = (Get-Date).ToUniversalTime().ToString("o")
  requirements_path = $RequirementsPath
  managed_dir = $ManagedDir
  managed_wrapper = $managedWrapper
  backup_path = $backupPath
  hook_script = $hookScript
}

if ($Json) {
  $report | ConvertTo-Json -Depth 8
} else {
  Write-Host "DinoBrain managed Codex hook installed."
  Write-Host "Requirements: $RequirementsPath"
  Write-Host "Managed hook dir: $ManagedDir"
  Write-Host "Managed wrapper: $managedWrapper"
  if ($backupPath) { Write-Host "Backup: $backupPath" }
}
