#Requires -Version 5.1
[CmdletBinding()]
param(
  [string]$AppPath = "",
  [string]$HooksPath = "",
  [string]$ConfigPath = "",
  [switch]$RestartStaleCodex,
  [switch]$NoRestart,
  [switch]$NoOpen,
  [switch]$NoUi,
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

function Get-DinoBrainCodexGuiProcesses {
  try {
    return @(Get-Process -ErrorAction Stop | Where-Object {
      $_.ProcessName -match "^(Codex|OpenAI\.Codex)$"
    })
  } catch {
    return @()
  }
}

function Get-DinoBrainStaleCodexProcesses {
  param([Parameter(Mandatory = $true)][string]$UserHooksPath)

  $running = @(Get-DinoBrainCodexGuiProcesses)
  if (-not (Test-Path -LiteralPath $UserHooksPath)) {
    return @()
  }

  $hooksWriteTime = (Get-Item -LiteralPath $UserHooksPath).LastWriteTime
  return @($running | Where-Object {
    try { $_.StartTime -lt $hooksWriteTime } catch { $false }
  })
}

function Stop-DinoBrainCodexProcesses {
  param([Parameter(Mandatory = $true)][object[]]$Processes)

  $stopped = New-Object System.Collections.ArrayList
  foreach ($process in @($Processes)) {
    try {
      if ($process.HasExited) { continue }
      if ($process.MainWindowHandle -ne 0) {
        [void]$process.CloseMainWindow()
      }
    } catch {}
  }

  Start-Sleep -Seconds 2
  foreach ($process in @($Processes)) {
    try {
      if ($process.HasExited) { continue }
      Stop-Process -Id $process.Id -Force -ErrorAction Stop
      [void]$stopped.Add($process.Id)
    } catch {}
  }
  return @($stopped)
}

function Get-DinoBrainCodexAppId {
  try {
    $app = Get-StartApps | Where-Object {
      $_.Name -match "Codex" -or $_.AppID -match "OpenAI\.Codex"
    } | Select-Object -First 1
    if ($app) { return [string]$app.AppID }
  } catch {}
  return ""
}

function Start-DinoBrainCodex {
  $appId = Get-DinoBrainCodexAppId
  if (-not [string]::IsNullOrWhiteSpace($appId)) {
    Start-Process "shell:AppsFolder\$appId"
    return "shell:AppsFolder\$appId"
  }

  $command = Get-Command codex -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($command -and -not [string]::IsNullOrWhiteSpace($command.Source)) {
    Start-Process -FilePath $command.Source
    return $command.Source
  }

  return ""
}

function Show-DinoBrainHookApprovalInstructions {
  param([Parameter(Mandatory = $true)][string]$ApprovalText)

  if ($NoUi) { return }

  try {
    Set-Clipboard -Value "/hooks"
  } catch {}

  try {
    Add-Type -AssemblyName System.Windows.Forms
    [System.Windows.Forms.MessageBox]::Show(
      $ApprovalText,
      "DinoBrain Codex Hook Approval",
      [System.Windows.Forms.MessageBoxButtons]::OK,
      [System.Windows.Forms.MessageBoxIcon]::Information
    ) | Out-Null
  } catch {
    Write-Host $ApprovalText
  }
}

if ([string]::IsNullOrWhiteSpace($AppPath)) {
  $AppPath = Resolve-DefaultPath (Join-Path $PSScriptRoot "..")
} else {
  $AppPath = Resolve-DefaultPath $AppPath
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

$runningBefore = @(Get-DinoBrainCodexGuiProcesses)
$staleProcesses = @(Get-DinoBrainStaleCodexProcesses -UserHooksPath $HooksPath)
$stoppedIds = @()
$startedVia = ""

if ($RestartStaleCodex -and -not $NoRestart -and $staleProcesses.Count -gt 0) {
  Write-Host "Restarting Codex so it reloads DinoBrain hooks..."
  $stoppedIds = @(Stop-DinoBrainCodexProcesses -Processes $staleProcesses)
  Start-Sleep -Seconds 1
}

if (-not $NoOpen) {
  $startedVia = Start-DinoBrainCodex
  if ([string]::IsNullOrWhiteSpace($startedVia)) {
    Write-Warning "Could not launch Codex automatically. Open Codex manually."
  } else {
    Write-Host "Codex launch requested: $startedVia"
  }
}

$message = @"
DinoBrain hook approval is ready.

1. In Codex, run /hooks. The text /hooks has been copied to your clipboard.
2. Review the DinoBrain UserPromptSubmit hook.
3. Trust or approve the DinoBrain hook.
4. Start a new Codex thread and send a prompt to confirm DinoBrain preflight runs.

This does not bypass Codex hook trust. The approval click must remain a user decision.
"@
Show-DinoBrainHookApprovalInstructions -ApprovalText $message

$report = [ordered]@{
  ok = $true
  generated_at = (Get-Date).ToUniversalTime().ToString("o")
  app_path = $AppPath
  hooks_path = $HooksPath
  config_path = $ConfigPath
  running_codex_before = $runningBefore.Count
  stale_codex_before = $staleProcesses.Count
  restarted_process_ids = @($stoppedIds)
  started_via = $startedVia
  clipboard_hint = "/hooks"
  user_trust_required = $true
}

if ($Json) {
  $report | ConvertTo-Json -Depth 8
}
