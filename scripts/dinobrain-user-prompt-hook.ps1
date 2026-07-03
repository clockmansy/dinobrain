$ErrorActionPreference = "Stop"
$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[Console]::InputEncoding = $Utf8NoBom
[Console]::OutputEncoding = $Utf8NoBom
$OutputEncoding = $Utf8NoBom

function New-HookJson([string]$Message) {
  return @{
    hookSpecificOutput = @{
      hookEventName = "UserPromptSubmit"
      additionalContext = $Message
    }
  } | ConvertTo-Json -Depth 8 -Compress
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

try {
  $inputText = [Console]::In.ReadToEnd()
  $repoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
  $hookScript = Join-Path $PSScriptRoot "dinobrain-user-prompt-hook.mjs"
  $nodeExe = Find-NodeRuntime

  if (-not $nodeExe) {
    [Console]::Out.WriteLine((New-HookJson "DinoBrain OS preflight could not find a Node.js runtime. Continue with the current user request; DinoBrain memory was not loaded for this turn."))
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
  $env:DINOBRAIN_REPO_ROOT = $repoRoot
  try {
    $process = [System.Diagnostics.Process]::Start($processInfo)
    $process.StandardInput.Write($inputText)
    $process.StandardInput.Close()
    $stdout = $process.StandardOutput.ReadToEnd()
    $stderr = $process.StandardError.ReadToEnd()
    $process.WaitForExit()
  } finally {
    if ($null -eq $oldRepoRoot) { Remove-Item Env:\DINOBRAIN_REPO_ROOT -ErrorAction SilentlyContinue } else { $env:DINOBRAIN_REPO_ROOT = $oldRepoRoot }
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
  [Console]::Out.WriteLine((New-HookJson $message))
  exit 0
}
