$ErrorActionPreference = "Stop"
$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[Console]::InputEncoding = $Utf8NoBom
[Console]::OutputEncoding = $Utf8NoBom
$OutputEncoding = $Utf8NoBom

function New-HookJson([string]$Message, [switch]$Block, [string]$Reason = "") {
  $payload = @{
    hookSpecificOutput = @{
      hookEventName = "UserPromptSubmit"
      additionalContext = $Message
    }
  }
  if ($Block) {
    $payload.decision = "block"
    $payload.reason = if ($Reason) { $Reason } else { "DinoBrain OS preflight failed before context injection." }
  }
  return $payload | ConvertTo-Json -Depth 8 -Compress
}

function Find-NodeRuntime {
  $candidates = @()
  if ($env:DINOBRAIN_NODE_EXE) {
    $candidates += $env:DINOBRAIN_NODE_EXE
  }
  if ($env:LOCALAPPDATA) {
    $candidates += (Join-Path $env:LOCALAPPDATA "DinoBrain\tools\node-v24.18.0-win-x64\node.exe")
  }
  $candidates += "node.exe"
  $candidates += "node"

  foreach ($candidate in $candidates) {
    if (-not $candidate) {
      continue
    }
    if (Test-Path -LiteralPath $candidate) {
      return (Resolve-Path -LiteralPath $candidate).Path
    }
    $command = Get-Command $candidate -ErrorAction SilentlyContinue
    if ($command) {
      return $command.Source
    }
  }

  return $null
}

function Quote-Argument([string]$Value) {
  return '"' + ($Value -replace '"', '\"') + '"'
}

function Get-ProcessRecord([int]$ProcessId) {
  if ($ProcessId -le 0) {
    return $null
  }
  try {
    $process = Get-CimInstance Win32_Process -Filter "ProcessId=$ProcessId" -ErrorAction Stop
    if ($null -eq $process) {
      return $null
    }
    return [ordered]@{
      process_id = [int]$process.ProcessId
      parent_process_id = [int]$process.ParentProcessId
      name = [string]$process.Name
      command_line = [string]$process.CommandLine
    }
  } catch {
    return [ordered]@{
      process_id = $ProcessId
      parent_process_id = $null
      name = $null
      command_line = $null
      error = $_.Exception.Message
    }
  }
}

function Get-HookLauncherProvenance {
  $current = Get-ProcessRecord -ProcessId $PID
  $parent = if ($null -ne $current -and $null -ne $current.parent_process_id) { Get-ProcessRecord -ProcessId ([int]$current.parent_process_id) } else { $null }
  $grandparent = if ($null -ne $parent -and $null -ne $parent.parent_process_id) { Get-ProcessRecord -ProcessId ([int]$parent.parent_process_id) } else { $null }
  $parentText = @(
    if ($null -ne $parent) { $parent.name }
    if ($null -ne $parent) { $parent.command_line }
    if ($null -ne $grandparent) { $grandparent.name }
    if ($null -ne $grandparent) { $grandparent.command_line }
  ) -join " "

  $derivedLaunchKind = if ($parentText -match "(?i)(^|[\\\s])codex(\.exe)?([\\\s]|$)|OpenAI[\\/]Codex") { "codex_desktop" } else { "manual_probe" }
  $requestedLaunchKind = $env:DINOBRAIN_HOOK_LAUNCH_KIND
  $launchKind = $derivedLaunchKind
  $launchKindOverrideIgnored = $false
  if (-not [string]::IsNullOrWhiteSpace($requestedLaunchKind)) {
    if ($requestedLaunchKind -eq "codex_desktop" -and $derivedLaunchKind -ne "codex_desktop") {
      $launchKindOverrideIgnored = $true
    } elseif ($requestedLaunchKind -ne "codex_desktop") {
      $launchKind = $requestedLaunchKind
    }
  }

  return ([ordered]@{
    launch_kind = $launchKind
    launch_kind_source = if ($launchKind -eq $derivedLaunchKind) { "process_ancestry" } else { "explicit_non_codex_override" }
    requested_launch_kind = $requestedLaunchKind
    launch_kind_override_ignored = $launchKindOverrideIgnored
    wrapper_process = $current
    parent_process = $parent
    grandparent_process = $grandparent
  } | ConvertTo-Json -Depth 8 -Compress)
}

try {
  $inputText = [Console]::In.ReadToEnd()
  $repoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
  $hookScript = Join-Path $PSScriptRoot "dinobrain-user-prompt-hook.mjs"
  $nodeExe = Find-NodeRuntime

  if (-not $nodeExe) {
    [Console]::Out.WriteLine((New-HookJson "DinoBrain OS preflight could not find a Node.js runtime. FAIL-CLOSED: do not perform substantial work because DinoBrain memory was not loaded for this Codex turn. Install/repair the DinoBrain Node runtime, then start a new trusted Codex session." -Block -Reason "DinoBrain OS preflight could not find a Node.js runtime."))
    exit 0
  }

  $processInfo = New-Object System.Diagnostics.ProcessStartInfo
  $processInfo.FileName = $nodeExe
  $processInfo.Arguments = Quote-Argument $hookScript
  $processInfo.WorkingDirectory = $repoRoot
  $processInfo.UseShellExecute = $false
  $processInfo.RedirectStandardInput = $true
  $processInfo.RedirectStandardOutput = $true
  $processInfo.RedirectStandardError = $true
  $processInfo.CreateNoWindow = $true
  try { $processInfo.StandardInputEncoding = $Utf8NoBom } catch {}
  try { $processInfo.StandardOutputEncoding = $Utf8NoBom } catch {}
  try { $processInfo.StandardErrorEncoding = $Utf8NoBom } catch {}

  $oldRepoRoot = $env:DINOBRAIN_REPO_ROOT
  $oldLaunchProvenance = $env:DINOBRAIN_HOOK_LAUNCH_PROVENANCE
  $env:DINOBRAIN_REPO_ROOT = $repoRoot
  $env:DINOBRAIN_HOOK_LAUNCH_PROVENANCE = Get-HookLauncherProvenance
  try {
    $process = [System.Diagnostics.Process]::Start($processInfo)
    $process.StandardInput.Write($inputText)
    $process.StandardInput.Close()
    $stdout = $process.StandardOutput.ReadToEnd()
    $stderr = $process.StandardError.ReadToEnd()
    $process.WaitForExit()
  } finally {
    if ($null -eq $oldRepoRoot) { Remove-Item Env:\DINOBRAIN_REPO_ROOT -ErrorAction SilentlyContinue } else { $env:DINOBRAIN_REPO_ROOT = $oldRepoRoot }
    if ($null -eq $oldLaunchProvenance) { Remove-Item Env:\DINOBRAIN_HOOK_LAUNCH_PROVENANCE -ErrorAction SilentlyContinue } else { $env:DINOBRAIN_HOOK_LAUNCH_PROVENANCE = $oldLaunchProvenance }
  }

  if (-not $stdout) {
    $message = "DinoBrain OS preflight wrapper produced no hook JSON."
    if ($stderr) {
      $message = $message + " stderr: " + ($stderr -replace "\s+", " ").Trim()
    }
    [Console]::Out.WriteLine((New-HookJson ($message + " FAIL-CLOSED: do not perform substantial work because no DinoBrain Context Pack was injected for this Codex turn.") -Block -Reason $message))
    exit 0
  }

  if ($process.ExitCode -ne 0) {
    $message = "DinoBrain OS preflight node hook exited with code $($process.ExitCode)."
    if ($stderr) {
      $message = $message + " stderr: " + ($stderr -replace "\s+", " ").Trim()
    }
    [Console]::Out.WriteLine((New-HookJson ($message + " FAIL-CLOSED: do not perform substantial work because no DinoBrain Context Pack was injected for this Codex turn.") -Block -Reason $message))
    exit 0
  }

  if ($stdout) {
    [Console]::Out.Write($stdout)
  }
  if ($stderr) {
    [Console]::Error.Write($stderr)
  }
  exit $process.ExitCode
} catch {
  $message = "DinoBrain OS preflight failed in the PowerShell wrapper: " + $_.Exception.Message
  [Console]::Out.WriteLine((New-HookJson ($message + " FAIL-CLOSED: do not perform substantial work because no DinoBrain Context Pack was injected for this Codex turn.") -Block -Reason $message))
  exit 0
}
