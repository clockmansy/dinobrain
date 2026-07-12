#Requires -Version 5.1
[CmdletBinding()]
param(
  [string]$AppPath = "",
  [string]$VaultPath = "",
  [string]$HooksPath = "",
  [string]$ConfigPath = "",
  [string]$RequirementsPath = "",
  [string]$NodeExe = "",
  [switch]$Json
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Resolve-DefaultPath {
  param([Parameter(Mandatory = $true)][string]$PathValue)
  return [System.IO.Path]::GetFullPath([Environment]::ExpandEnvironmentVariables($PathValue))
}

function Get-DefaultProgramData {
  if (-not [string]::IsNullOrWhiteSpace($env:ProgramData)) { return $env:ProgramData }
  return "C:\ProgramData"
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

function Get-DinoBrainHookRecord {
  param([AllowNull()][object]$HookConfig)
  if ($null -eq $HookConfig) { return $null }
  if ($null -eq $HookConfig.PSObject.Properties["hooks"]) { return $null }
  if ($null -eq $HookConfig.hooks.PSObject.Properties["UserPromptSubmit"]) { return $null }
  $groups = @($HookConfig.hooks.UserPromptSubmit)
  foreach ($group in $groups) {
    if ($null -eq $group -or $null -eq $group.PSObject.Properties["hooks"]) { continue }
    foreach ($hook in @($group.hooks)) {
      $text = $hook | ConvertTo-Json -Depth 20 -Compress
      if ($text -match "dinobrain-user-prompt-hook\.ps1" -or $text -match "Loading DinoBrain context") {
        return $hook
      }
    }
  }
  return $null
}

function Get-ObjectPropertyValue {
  param(
    [AllowNull()][object]$ObjectValue,
    [Parameter(Mandatory = $true)][string]$PropertyName
  )
  if ($null -eq $ObjectValue) { return $null }
  $property = $ObjectValue.PSObject.Properties[$PropertyName]
  if ($null -eq $property) { return $null }
  return $property.Value
}

function Get-CodexThreadCreatedAt {
  param([AllowEmptyString()][string]$ThreadId)

  $match = [regex]::Match($ThreadId, "^([0-9a-fA-F]{8})-([0-9a-fA-F]{4})-")
  if (-not $match.Success) { return $null }

  try {
    $millis = [Convert]::ToInt64(($match.Groups[1].Value + $match.Groups[2].Value), 16)
    return [DateTimeOffset]::FromUnixTimeMilliseconds($millis).UtcDateTime
  } catch {
    return $null
  }
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
  $oldLaunchKind = $env:DINOBRAIN_HOOK_LAUNCH_KIND
  $env:DINOBRAIN_DATA_DIR = $Vault
  if (-not [string]::IsNullOrWhiteSpace($Node)) {
    $env:DINOBRAIN_NODE_EXE = $Node
  }
  $env:DINOBRAIN_HOOK_IMPORT_SESSION = "0"
  $env:DINOBRAIN_HOOK_PROJECT = "dinobrain-hook-diagnose"
  $env:DINOBRAIN_HOOK_LAUNCH_KIND = "diagnostic_probe"
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
    if ($null -eq $oldLaunchKind) { Remove-Item Env:\DINOBRAIN_HOOK_LAUNCH_KIND -ErrorAction SilentlyContinue } else { $env:DINOBRAIN_HOOK_LAUNCH_KIND = $oldLaunchKind }
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
if ([string]::IsNullOrWhiteSpace($RequirementsPath)) {
  $RequirementsPath = Resolve-DefaultPath (Join-Path (Get-DefaultProgramData) "OpenAI\Codex\requirements.toml")
} else {
  $RequirementsPath = Resolve-DefaultPath $RequirementsPath
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

$managedHookPresent = $false
if (Test-Path -LiteralPath $RequirementsPath) {
  try {
    $requirementsText = [System.IO.File]::ReadAllText($RequirementsPath)
    $requirementsHooksSection = Get-TomlSection -Text $requirementsText -SectionName "hooks"
    $managedDir = ConvertFrom-TomlString (Get-TomlValue -Section $requirementsHooksSection -KeyName "windows_managed_dir")
    $managedHookPresent = ($requirementsText -match "dinobrain-managed-user-prompt-hook\.ps1" -or $requirementsText -match "dinobrain-user-prompt-hook\.ps1") -and $requirementsText -match "\[\[hooks\.UserPromptSubmit\]\]"
    $wrapperPath = $null
    if (-not [string]::IsNullOrWhiteSpace($managedDir)) {
      $wrapperPath = Join-Path (Resolve-DefaultPath $managedDir) "dinobrain-managed-user-prompt-hook.ps1"
    }
    if ($managedHookPresent -and $wrapperPath -and (Test-Path -LiteralPath $wrapperPath)) {
      Add-Check $checks "codex_managed_hook" "pass" "DinoBrain managed UserPromptSubmit hook is installed through requirements.toml" @{ requirements_path = $RequirementsPath; managed_dir = $managedDir; wrapper_path = $wrapperPath }
    } elseif ($managedHookPresent) {
      Add-Check $checks "codex_managed_hook" "warn" "DinoBrain managed hook is declared, but the managed wrapper was not found" @{ requirements_path = $RequirementsPath; managed_dir = $managedDir; wrapper_path = $wrapperPath }
    } else {
      Add-Check $checks "codex_managed_hook" "warn" "No DinoBrain managed hook found in requirements.toml; user hook still needs /hooks trust" @{ requirements_path = $RequirementsPath }
    }
  } catch {
    Add-Check $checks "codex_managed_hook" "warn" "Could not inspect Codex managed requirements" @{ requirements_path = $RequirementsPath; error = $_.Exception.Message }
  }
} else {
  Add-Check $checks "codex_managed_hook" "warn" "Codex managed requirements.toml was not found; user hook still needs /hooks trust" @{ requirements_path = $RequirementsPath }
}

$hookCommand = ""
if (Test-Path -LiteralPath $HooksPath) {
  $hookJson = Read-JsonSafe -PathValue $HooksPath
  if ($hookJson.Ok) {
    $hookRecord = Get-DinoBrainHookRecord -HookConfig $hookJson.Value
    $hookCommand = Get-HookCommand -HookConfig $hookJson.Value
    if ([string]::IsNullOrWhiteSpace($hookCommand)) {
      if ($managedHookPresent) {
        Add-Check $checks "codex_user_hook" "pass" "Duplicate DinoBrain user hook is intentionally absent; the managed hook is authoritative" @{ hooks_path = $HooksPath; managed_hook_present = $true }
      } else {
        Add-Check $checks "codex_user_hook" "fail" "DinoBrain UserPromptSubmit hook is not registered" @{ hooks_path = $HooksPath }
      }
    } else {
      Add-Check $checks "codex_user_hook" "pass" "DinoBrain UserPromptSubmit hook is registered" @{ hooks_path = $HooksPath; command = $hookCommand }
      $state = Get-ObjectPropertyValue -ObjectValue $hookRecord -PropertyName "state"
      $trustedHash = Get-ObjectPropertyValue -ObjectValue $hookRecord -PropertyName "trusted_hash"
      if ($null -eq $trustedHash -and $null -ne $state) {
        $trustedHash = Get-ObjectPropertyValue -ObjectValue $state -PropertyName "trusted_hash"
      }
      $stateEnabled = Get-ObjectPropertyValue -ObjectValue $hookRecord -PropertyName "enabled"
      if ($null -eq $stateEnabled -and $null -ne $state) {
        $stateEnabled = Get-ObjectPropertyValue -ObjectValue $state -PropertyName "enabled"
      }
      if ($stateEnabled -eq $false) {
        Add-Check $checks "codex_user_hook_trust" "fail" "DinoBrain UserPromptSubmit hook is disabled by persisted hook state" @{ hooks_path = $HooksPath; state_enabled = $stateEnabled }
      } elseif ([string]::IsNullOrWhiteSpace([string]$trustedHash) -and -not $managedHookPresent) {
        Add-Check $checks "codex_user_hook_trust" "warn" "DinoBrain hook is registered, but no visible trusted_hash/state is present in hooks.json; Codex may skip it until /hooks trusts the current command hash" @{ hooks_path = $HooksPath; state_enabled = $stateEnabled; trusted_hash_present = $false }
      } elseif ([string]::IsNullOrWhiteSpace([string]$trustedHash) -and $managedHookPresent) {
        Add-Check $checks "codex_user_hook_trust" "pass" "User hook trust metadata is absent, but a managed DinoBrain hook is configured as the trust-free pre-response path" @{ hooks_path = $HooksPath; trusted_hash_present = $false; managed_hook_present = $true }
      } else {
        Add-Check $checks "codex_user_hook_trust" "pass" "DinoBrain hook has visible persisted trust metadata" @{ hooks_path = $HooksPath; state_enabled = $stateEnabled; trusted_hash_present = $true }
      }
    }
  } else {
    Add-Check $checks "codex_user_hook" ($(if ($managedHookPresent) { "warn" } else { "fail" })) "hooks.json is invalid JSON" @{ hooks_path = $HooksPath; error = $hookJson.Error; managed_hook_present = $managedHookPresent }
  }
} else {
  Add-Check $checks "codex_user_hook" ($(if ($managedHookPresent) { "pass" } else { "fail" })) ($(if ($managedHookPresent) { "hooks.json is absent; the managed DinoBrain hook is authoritative" } else { "hooks.json was not found" })) @{ hooks_path = $HooksPath; managed_hook_present = $managedHookPresent }
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
  $requirementsWriteTime = if (Test-Path -LiteralPath $RequirementsPath) { (Get-Item -LiteralPath $RequirementsPath).LastWriteTime } else { $null }
  $promptHookWriteTime = $hooksWriteTime
  if ($requirementsWriteTime -and ((-not $promptHookWriteTime) -or $requirementsWriteTime -gt $promptHookWriteTime)) {
    $promptHookWriteTime = $requirementsWriteTime
  }
  $oldProcesses = @()
  if ($promptHookWriteTime) {
    $oldProcesses = @($runningCodex | Where-Object {
      try { $_.StartTime -lt $promptHookWriteTime } catch { $false }
    })
  }
  if ($oldProcesses.Count -gt 0) {
    Add-Check $checks "codex_reload" "warn" "Codex was already running before prompt hook config changed; restart Codex before live proof" @{
      hooks_write_time = if ($hooksWriteTime) { $hooksWriteTime.ToUniversalTime().ToString("o") } else { $null }
      requirements_write_time = if ($requirementsWriteTime) { $requirementsWriteTime.ToUniversalTime().ToString("o") } else { $null }
      prompt_hook_write_time = if ($promptHookWriteTime) { $promptHookWriteTime.ToUniversalTime().ToString("o") } else { $null }
      old_process_count = $oldProcesses.Count
    }
  } else {
    Add-Check $checks "codex_reload" "pass" "No stale Codex process detected"
  }
} catch {
  Add-Check $checks "codex_reload" "warn" "Could not inspect Codex process start times" @{ error = $_.Exception.Message }
}

try {
  $currentThreadId = [string]$env:CODEX_THREAD_ID
  $threadCreatedAt = Get-CodexThreadCreatedAt -ThreadId $currentThreadId
  $hooksWriteTimeUtc = if (Test-Path -LiteralPath $HooksPath) { (Get-Item -LiteralPath $HooksPath).LastWriteTimeUtc } else { $null }
  $requirementsWriteTimeUtc = if (Test-Path -LiteralPath $RequirementsPath) { (Get-Item -LiteralPath $RequirementsPath).LastWriteTimeUtc } else { $null }
  $promptHookWriteTimeUtc = $hooksWriteTimeUtc
  if ($requirementsWriteTimeUtc -and ((-not $promptHookWriteTimeUtc) -or $requirementsWriteTimeUtc -gt $promptHookWriteTimeUtc)) {
    $promptHookWriteTimeUtc = $requirementsWriteTimeUtc
  }
  if ([string]::IsNullOrWhiteSpace($currentThreadId)) {
    Add-Check $checks "codex_thread_freshness" "pass" "No CODEX_THREAD_ID is present in this shell; thread freshness check skipped"
  } elseif ($null -eq $threadCreatedAt -or $null -eq $promptHookWriteTimeUtc) {
    Add-Check $checks "codex_thread_freshness" "warn" "Could not compare the current Codex thread with hooks.json" @{
      current_thread_id = $currentThreadId
      current_thread_created_at = if ($threadCreatedAt) { $threadCreatedAt.ToString("o") } else { $null }
      hooks_write_time = if ($hooksWriteTimeUtc) { $hooksWriteTimeUtc.ToString("o") } else { $null }
      requirements_write_time = if ($requirementsWriteTimeUtc) { $requirementsWriteTimeUtc.ToString("o") } else { $null }
    }
  } elseif ($threadCreatedAt -lt $promptHookWriteTimeUtc) {
    Add-Check $checks "codex_thread_freshness" "warn" "Current Codex thread was created before prompt hook config changed; live proof must use a fresh Codex Desktop thread" @{
      current_thread_id = $currentThreadId
      current_thread_created_at = $threadCreatedAt.ToString("o")
      hooks_write_time = if ($hooksWriteTimeUtc) { $hooksWriteTimeUtc.ToString("o") } else { $null }
      requirements_write_time = if ($requirementsWriteTimeUtc) { $requirementsWriteTimeUtc.ToString("o") } else { $null }
      prompt_hook_write_time = $promptHookWriteTimeUtc.ToString("o")
    }
  } else {
    Add-Check $checks "codex_thread_freshness" "pass" "Current Codex thread was created after prompt hook config changed" @{
      current_thread_id = $currentThreadId
      current_thread_created_at = $threadCreatedAt.ToString("o")
      hooks_write_time = if ($hooksWriteTimeUtc) { $hooksWriteTimeUtc.ToString("o") } else { $null }
      requirements_write_time = if ($requirementsWriteTimeUtc) { $requirementsWriteTimeUtc.ToString("o") } else { $null }
      prompt_hook_write_time = $promptHookWriteTimeUtc.ToString("o")
    }
  }
} catch {
  Add-Check $checks "codex_thread_freshness" "warn" "Could not inspect current Codex thread freshness" @{ error = $_.Exception.Message }
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
  if ($managedHookPresent) {
    $nextSteps += "The managed DinoBrain hook is healthy and requires no user trust approval. If Codex predates this configuration, fully restart it and use a fresh thread."
  } else {
    $nextSteps += "Open Codex, run /hooks, trust the DinoBrain fallback user hook if it is pending, then start a new thread and send a prompt."
  }
} else {
  if ($failCount -gt 0) {
    $nextSteps += "Fix any FAIL rows first."
  } else {
    $nextSteps += "No FAIL rows were found; resolve the WARN rows before counting live Codex prompts as proof."
  }
  if (@($checks | Where-Object { $_.name -eq "codex_user_hook_trust" -and $_.status -eq "warn" }).Count -gt 0) {
    $nextSteps += "Run /hooks in Codex and trust the DinoBrain UserPromptSubmit hook for the current command hash, then use a fresh Codex Desktop workspace thread for live proof."
  }
  if (@($checks | Where-Object { $_.name -eq "codex_managed_hook" -and $_.status -eq "warn" }).Count -gt 0) {
    $nextSteps += "For a trust-free supported path, run npm run codex:hooks:managed or DinoBrain Codex Managed Hook Admin.cmd, then restart Codex and rerun live proof."
  }
  $nextSteps += $(if ($managedHookPresent) { "If only codex_reload is WARN, fully quit Codex and open it again." } else { "If only codex_reload is WARN, run DinoBrain Codex Hook Approval.cmd or fully quit Codex and open it again." })
  $nextSteps += "If codex_thread_freshness is WARN, run the live proof in a new Codex Desktop thread created after the latest hook config reload."
  $nextSteps += $(if ($managedHookPresent) { "If hook_probe is PASS but live prompts do not trigger, reinstall the managed hook, fully restart Codex, and retry in a fresh thread." } else { "If hook_probe is PASS but live prompts do not trigger, run DinoBrain Codex Hook Approval.cmd or open /hooks in Codex and trust the fallback UserPromptSubmit hook." })
}

$report = [ordered]@{
  ok = ($failCount -eq 0)
  generated_at = (Get-Date).ToUniversalTime().ToString("o")
  app_path = $AppPath
  vault_path = $VaultPath
  hooks_path = $HooksPath
  config_path = $ConfigPath
  requirements_path = $RequirementsPath
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
