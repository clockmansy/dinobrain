#Requires -Version 5.1
[CmdletBinding()]
param(
  [string]$AppPath = "",
  [string]$VaultPath = "",
  [string]$HooksPath = "",
  [string]$ConfigPath = "",
  [string]$NodeExe = "",
  [switch]$Json
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Resolve-DefaultPath {
  param([Parameter(Mandatory = $true)][string]$PathValue)
  return [System.IO.Path]::GetFullPath([Environment]::ExpandEnvironmentVariables($PathValue))
}

function Add-Check {
  param(
    [Parameter(Mandatory = $true)][System.Collections.IList]$Checks,
    [Parameter(Mandatory = $true)][string]$Name,
    [Parameter(Mandatory = $true)][string]$Status,
    [Parameter(Mandatory = $true)][string]$Message,
    [object]$Data = $null
  )
  $Checks.Add([ordered]@{
    name = $Name
    status = $Status
    message = $Message
    data = $Data
  }) | Out-Null
}

function Read-JsonSafe {
  param([Parameter(Mandatory = $true)][string]$PathValue)
  try {
    return [pscustomobject]@{
      Ok = $true
      Value = ([System.IO.File]::ReadAllText($PathValue) | ConvertFrom-Json)
      Error = $null
    }
  } catch {
    return [pscustomobject]@{
      Ok = $false
      Value = $null
      Error = $_.Exception.Message
    }
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

function Get-HookCommand {
  param([AllowNull()][object]$HookConfig)
  if ($null -eq $HookConfig) { return "" }
  if ($null -eq $HookConfig.PSObject.Properties["hooks"]) { return "" }
  if ($null -eq $HookConfig.hooks.PSObject.Properties["UserPromptSubmit"]) { return "" }
  $groups = @($HookConfig.hooks.UserPromptSubmit)
  foreach ($group in $groups) {
    if ($null -eq $group -or $null -eq $group.PSObject.Properties["hooks"]) { continue }
    foreach ($hook in @($group.hooks)) {
      $text = $hook | ConvertTo-Json -Depth 20 -Compress
      if ($text -match "dinobrain-user-prompt-hook\.ps1" -or $text -match "Loading DinoBrain context") {
        if ($null -ne $hook.PSObject.Properties["commandWindows"] -and -not [string]::IsNullOrWhiteSpace([string]$hook.commandWindows)) {
          return [string]$hook.commandWindows
        }
        if ($null -ne $hook.PSObject.Properties["command"]) {
          return [string]$hook.command
        }
        return ""
      }
    }
  }
  return ""
}

function Invoke-HookProbe {
  param(
    [Parameter(Mandatory = $true)][string]$HookScript,
    [Parameter(Mandatory = $true)][string]$Vault,
    [Parameter(Mandatory = $true)][string]$Node
  )

  $payload = [ordered]@{
    hookEventName = "UserPromptSubmit"
    prompt = "DinoBrain live Codex hook diagnostic probe."
    cwd = $AppPath
  } | ConvertTo-Json -Depth 8 -Compress

  $processInfo = New-Object System.Diagnostics.ProcessStartInfo
  $processInfo.FileName = "powershell.exe"
  $processInfo.Arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$HookScript`""
  $processInfo.WorkingDirectory = $AppPath
  $processInfo.UseShellExecute = $false
  $processInfo.RedirectStandardInput = $true
  $processInfo.RedirectStandardOutput = $true
  $processInfo.RedirectStandardError = $true
  $processInfo.CreateNoWindow = $true

  $oldData = $env:DINOBRAIN_DATA_DIR
  $oldNode = $env:DINOBRAIN_NODE_EXE
  $oldImport = $env:DINOBRAIN_HOOK_IMPORT_SESSION
  $oldProject = $env:DINOBRAIN_HOOK_PROJECT
  $env:DINOBRAIN_DATA_DIR = $Vault
  if (-not [string]::IsNullOrWhiteSpace($Node)) {
    $env:DINOBRAIN_NODE_EXE = $Node
  }
  $env:DINOBRAIN_HOOK_IMPORT_SESSION = "0"
  $env:DINOBRAIN_HOOK_PROJECT = "dinobrain-hook-diagnose"
  try {
    $process = [System.Diagnostics.Process]::Start($processInfo)
    $process.StandardInput.Write($payload)
    $process.StandardInput.Close()
    $stdout = $process.StandardOutput.ReadToEnd()
    $stderr = $process.StandardError.ReadToEnd()
    $process.WaitForExit()
  } finally {
    if ($null -eq $oldData) { Remove-Item Env:\DINOBRAIN_DATA_DIR -ErrorAction SilentlyContinue } else { $env:DINOBRAIN_DATA_DIR = $oldData }
    if ($null -eq $oldNode) { Remove-Item Env:\DINOBRAIN_NODE_EXE -ErrorAction SilentlyContinue } else { $env:DINOBRAIN_NODE_EXE = $oldNode }
    if ($null -eq $oldImport) { Remove-Item Env:\DINOBRAIN_HOOK_IMPORT_SESSION -ErrorAction SilentlyContinue } else { $env:DINOBRAIN_HOOK_IMPORT_SESSION = $oldImport }
    if ($null -eq $oldProject) { Remove-Item Env:\DINOBRAIN_HOOK_PROJECT -ErrorAction SilentlyContinue } else { $env:DINOBRAIN_HOOK_PROJECT = $oldProject }
  }

  return [pscustomobject]@{
    ExitCode = $process.ExitCode
    Stdout = $stdout
    Stderr = $stderr
  }
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
if ([string]::IsNullOrWhiteSpace($HooksPath)) {
  $HooksPath = Resolve-DefaultPath (Join-Path $HOME ".codex\hooks.json")
} else {
  $HooksPath = Resolve-DefaultPath $HooksPath
}
if ([string]::IsNullOrWhiteSpace($ConfigPath)) {
  $ConfigPath = Resolve-DefaultPath (Join-Path $HOME ".codex\config.toml")
} else {
  $ConfigPath = Resolve-DefaultPath $ConfigPath
}
if ([string]::IsNullOrWhiteSpace($NodeExe) -and $env:LOCALAPPDATA) {
  $NodeExe = Join-Path $env:LOCALAPPDATA "DinoBrain\tools\node-v24.18.0-win-x64\node.exe"
}
if (-not [string]::IsNullOrWhiteSpace($NodeExe)) {
  $NodeExe = Resolve-DefaultPath $NodeExe
}

$checks = New-Object System.Collections.ArrayList
$hookScript = Join-Path $AppPath "scripts\dinobrain-user-prompt-hook.ps1"

Add-Check $checks "app_path" ($(if (Test-Path -LiteralPath $AppPath) { "pass" } else { "fail" })) $AppPath
Add-Check $checks "vault_path" ($(if (Test-Path -LiteralPath $VaultPath) { "pass" } else { "fail" })) $VaultPath
Add-Check $checks "hook_script" ($(if (Test-Path -LiteralPath $hookScript) { "pass" } else { "fail" })) $hookScript
Add-Check $checks "node_runtime" ($(if (-not [string]::IsNullOrWhiteSpace($NodeExe) -and (Test-Path -LiteralPath $NodeExe)) { "pass" } else { "fail" })) $NodeExe

$configText = ""
if (Test-Path -LiteralPath $ConfigPath) {
  $configText = [System.IO.File]::ReadAllText($ConfigPath)
  $features = Get-TomlSection -Text $configText -SectionName "features"
  $hooksFlag = Get-TomlValue -Section $features -KeyName "hooks"
  if ($hooksFlag -match "^(?i:false)$") {
    Add-Check $checks "codex_hooks_feature" "fail" "[features] hooks is false in config.toml" @{ config_path = $ConfigPath }
  } else {
    Add-Check $checks "codex_hooks_feature" "pass" "Codex hooks feature is not disabled" @{ config_path = $ConfigPath; hooks = $hooksFlag }
  }
  if ($configText -match "(?mi)^\s*allow_managed_hooks_only\s*=\s*true\s*$") {
    Add-Check $checks "managed_only_policy" "fail" "allow_managed_hooks_only=true will skip user hooks" @{ config_path = $ConfigPath }
  } else {
    Add-Check $checks "managed_only_policy" "pass" "No managed-only hook policy found" @{ config_path = $ConfigPath }
  }
} else {
  Add-Check $checks "codex_config" "warn" "Codex config.toml was not found" @{ config_path = $ConfigPath }
}

$hookCommand = ""
if (Test-Path -LiteralPath $HooksPath) {
  $hookJson = Read-JsonSafe -PathValue $HooksPath
  if ($hookJson.Ok) {
    $hookCommand = Get-HookCommand -HookConfig $hookJson.Value
    if ([string]::IsNullOrWhiteSpace($hookCommand)) {
      Add-Check $checks "codex_user_hook" "fail" "DinoBrain UserPromptSubmit hook is not registered" @{ hooks_path = $HooksPath }
    } else {
      Add-Check $checks "codex_user_hook" "pass" "DinoBrain UserPromptSubmit hook is registered" @{ hooks_path = $HooksPath; command = $hookCommand }
    }
  } else {
    Add-Check $checks "codex_user_hook" "fail" "hooks.json is invalid JSON" @{ hooks_path = $HooksPath; error = $hookJson.Error }
  }
} else {
  Add-Check $checks "codex_user_hook" "fail" "hooks.json was not found" @{ hooks_path = $HooksPath }
}

$codexCommand = Get-Command codex -ErrorAction SilentlyContinue | Select-Object -First 1
if ($codexCommand) {
  Add-Check $checks "codex_command" "pass" $codexCommand.Source
} else {
  Add-Check $checks "codex_command" "warn" "codex command was not found on PATH"
}

try {
  $runningCodex = @(Get-Process | Where-Object { $_.ProcessName -match "^(codex|OpenAI\.Codex)$" })
  $hooksWriteTime = if (Test-Path -LiteralPath $HooksPath) { (Get-Item -LiteralPath $HooksPath).LastWriteTime } else { $null }
  $oldProcesses = @()
  if ($hooksWriteTime) {
    $oldProcesses = @($runningCodex | Where-Object {
      try { $_.StartTime -lt $hooksWriteTime } catch { $false }
    })
  }
  if ($oldProcesses.Count -gt 0) {
    Add-Check $checks "codex_reload" "warn" "Codex was already running before hooks.json changed; restart Codex or start a new trusted session" @{ hooks_write_time = $hooksWriteTime; old_process_count = $oldProcesses.Count }
  } else {
    Add-Check $checks "codex_reload" "pass" "No stale Codex process detected"
  }
} catch {
  Add-Check $checks "codex_reload" "warn" "Could not inspect Codex process start times" @{ error = $_.Exception.Message }
}

if ((Test-Path -LiteralPath $hookScript) -and (Test-Path -LiteralPath $VaultPath)) {
  try {
    $probe = Invoke-HookProbe -HookScript $hookScript -Vault $VaultPath -Node $NodeExe
    if ($probe.ExitCode -ne 0) {
      Add-Check $checks "hook_probe" "fail" "Hook wrapper exited with $($probe.ExitCode)" @{ stderr = $probe.Stderr }
    } elseif ([string]::IsNullOrWhiteSpace($probe.Stdout)) {
      Add-Check $checks "hook_probe" "fail" "Hook wrapper produced no stdout" @{ stderr = $probe.Stderr }
    } else {
      try {
        $parsed = $probe.Stdout | ConvertFrom-Json
        $context = [string]$parsed.hookSpecificOutput.additionalContext
        if ($parsed.hookSpecificOutput.hookEventName -eq "UserPromptSubmit" -and $context -match "DinoBrain OS preflight completed") {
          Add-Check $checks "hook_probe" "pass" "Hook wrapper can run DinoBrain preflight" @{ preview = $context.Substring(0, [Math]::Min(240, $context.Length)) }
        } else {
          Add-Check $checks "hook_probe" "fail" "Hook wrapper returned JSON but did not complete DinoBrain preflight" @{ stdout = $probe.Stdout.Substring(0, [Math]::Min(600, $probe.Stdout.Length)) }
        }
      } catch {
        Add-Check $checks "hook_probe" "fail" "Hook wrapper returned invalid JSON" @{ error = $_.Exception.Message; stdout = $probe.Stdout.Substring(0, [Math]::Min(600, $probe.Stdout.Length)) }
      }
    }
  } catch {
    Add-Check $checks "hook_probe" "fail" "Hook probe could not start" @{ error = $_.Exception.Message }
  }
}

$failCount = @($checks | Where-Object { $_.status -eq "fail" }).Count
$warnCount = @($checks | Where-Object { $_.status -eq "warn" }).Count
$nextSteps = @()
if ($failCount -eq 0 -and $warnCount -eq 0) {
  $nextSteps += "Open Codex, run /hooks, trust the DinoBrain hook if it is pending, then start a new thread and send a prompt."
} else {
  $nextSteps += "Fix any FAIL rows first."
  $nextSteps += "If only codex_reload is WARN, fully quit Codex and open it again."
  $nextSteps += "If hook_probe is PASS but live prompts do not trigger, open /hooks in Codex and trust the DinoBrain UserPromptSubmit hook."
}

$report = [ordered]@{
  ok = ($failCount -eq 0)
  generated_at = (Get-Date).ToUniversalTime().ToString("o")
  app_path = $AppPath
  vault_path = $VaultPath
  hooks_path = $HooksPath
  config_path = $ConfigPath
  checks = @($checks)
  next_steps = $nextSteps
}

if ($Json) {
  $report | ConvertTo-Json -Depth 20
  exit ($(if ($report.ok) { 0 } else { 1 }))
}

Write-Host ""
Write-Host "DinoBrain Codex Hook Diagnose"
Write-Host "================================"
foreach ($check in $checks) {
  $mark = switch ($check.status) {
    "pass" { "PASS" }
    "warn" { "WARN" }
    default { "FAIL" }
  }
  Write-Host ("[{0}] {1}: {2}" -f $mark, $check.name, $check.message)
}
Write-Host ""
Write-Host "Next steps:"
foreach ($step in $nextSteps) {
  Write-Host "- $step"
}
Write-Host ""
if ($failCount -gt 0) { exit 1 }
exit 0
