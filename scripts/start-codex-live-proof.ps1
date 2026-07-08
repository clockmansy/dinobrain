#Requires -Version 5.1
[CmdletBinding()]
param(
  [string]$AppPath = "",
  [string]$VaultPath = "",
  [string]$HooksPath = "",
  [string]$ConfigPath = "",
  [string]$RequirementsPath = "",
  [string]$NodeExe = "",
  [string]$Snippet = "",
  [int]$TimeoutSeconds = 3600,
  [int]$PollSeconds = 5,
  [switch]$Detached,
  [switch]$SkipApproval,
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

function Get-DefaultProgramData {
  if (-not [string]::IsNullOrWhiteSpace($env:ProgramData)) { return $env:ProgramData }
  return "C:\ProgramData"
}

function Find-PortableNode {
  if (-not [string]::IsNullOrWhiteSpace($NodeExe)) {
    $resolved = Resolve-DefaultPath $NodeExe
    if (Test-Path -LiteralPath $resolved) { return $resolved }
  }
  if ($env:LOCALAPPDATA) {
    $candidate = Join-Path $env:LOCALAPPDATA "DinoBrain\tools\node-v24.18.0-win-x64\node.exe"
    if (Test-Path -LiteralPath $candidate) { return $candidate }
  }
  $command = Get-Command node -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($command -and -not [string]::IsNullOrWhiteSpace($command.Source)) {
    return [string]$command.Source
  }
  return ""
}

function Show-Info {
  param([Parameter(Mandatory = $true)][string]$Message)
  if ($Json) { return }
  try {
    Add-Type -AssemblyName System.Windows.Forms
    [System.Windows.Forms.MessageBox]::Show(
      $Message,
      "DinoBrain Live Proof",
      [System.Windows.Forms.MessageBoxButtons]::OK,
      [System.Windows.Forms.MessageBoxIcon]::Information
    ) | Out-Null
  } catch {
    Write-Host $Message
  }
}

function Set-ClipboardSafe {
  param([Parameter(Mandatory = $true)][string]$Text)
  $script:LastClipboardError = ""
  try {
    Set-Clipboard -Value $Text -ErrorAction Stop
    return $true
  } catch {
    $script:LastClipboardError = $_.Exception.Message
  }

  $clip = Join-Path $env:SystemRoot "System32\clip.exe"
  if (Test-Path -LiteralPath $clip) {
    $errorPath = Join-Path ([System.IO.Path]::GetTempPath()) ("dinobrain-clip-" + [guid]::NewGuid().ToString("N") + ".err")
    $oldErrorActionPreference = $ErrorActionPreference
    try {
      $ErrorActionPreference = "Continue"
      $Text | & $clip 2> $errorPath
      $exitCode = $LASTEXITCODE
      if ($exitCode -eq 0) {
        return $true
      }
      $clipError = ""
      if (Test-Path -LiteralPath $errorPath) {
        $clipError = ([System.IO.File]::ReadAllText($errorPath)).Trim()
      }
      $script:LastClipboardError = (($script:LastClipboardError, "clip.exe exit $exitCode $clipError") | Where-Object { -not [string]::IsNullOrWhiteSpace($_) }) -join "; "
    } catch {
      $script:LastClipboardError = (($script:LastClipboardError, ("clip.exe failed: " + $_.Exception.Message)) | Where-Object { -not [string]::IsNullOrWhiteSpace($_) }) -join "; "
    } finally {
      $ErrorActionPreference = $oldErrorActionPreference
      Remove-Item -LiteralPath $errorPath -Force -ErrorAction SilentlyContinue
    }
  }

  $textPath = Join-Path ([System.IO.Path]::GetTempPath()) ("dinobrain-clipboard-" + [guid]::NewGuid().ToString("N") + ".txt")
  $oldClipboardTextFile = $env:DINOBRAIN_CLIPBOARD_TEXT_FILE
  try {
    [System.IO.File]::WriteAllText($textPath, $Text, [System.Text.Encoding]::UTF8)
    $env:DINOBRAIN_CLIPBOARD_TEXT_FILE = $textPath
    $staCommand = @"
Add-Type -AssemblyName System.Windows.Forms
`$text = [System.IO.File]::ReadAllText(`$env:DINOBRAIN_CLIPBOARD_TEXT_FILE, [System.Text.Encoding]::UTF8)
[System.Windows.Forms.Clipboard]::SetText(`$text)
"@
    $staOutput = & powershell.exe -NoProfile -STA -ExecutionPolicy Bypass -Command $staCommand 2>&1
    $staExit = $LASTEXITCODE
    if ($staExit -eq 0) {
      return $true
    }
    $script:LastClipboardError = (($script:LastClipboardError, ("STA clipboard exit $staExit " + (($staOutput | Out-String).Trim()))) | Where-Object { -not [string]::IsNullOrWhiteSpace($_) }) -join "; "
  } catch {
    $script:LastClipboardError = (($script:LastClipboardError, ("STA clipboard failed: " + $_.Exception.Message)) | Where-Object { -not [string]::IsNullOrWhiteSpace($_) }) -join "; "
  } finally {
    if ($null -eq $oldClipboardTextFile) {
      Remove-Item Env:\DINOBRAIN_CLIPBOARD_TEXT_FILE -ErrorAction SilentlyContinue
    } else {
      $env:DINOBRAIN_CLIPBOARD_TEXT_FILE = $oldClipboardTextFile
    }
    Remove-Item -LiteralPath $textPath -Force -ErrorAction SilentlyContinue
  }

  return $false
}

function Write-LiveProofPromptFile {
  param(
    [Parameter(Mandatory = $true)][string]$AppPath,
    [Parameter(Mandatory = $true)][string]$Snippet,
    [Parameter(Mandatory = $true)][string]$Prompt
  )

  $reportDir = Join-Path $AppPath "reports\live-hooks"
  New-Item -ItemType Directory -Force -Path $reportDir | Out-Null
  $safeSnippet = ($Snippet -replace '[^A-Za-z0-9._-]+', '-').Trim("-")
  if ($safeSnippet.Length -gt 96) {
    $safeSnippet = $safeSnippet.Substring(0, 96)
  }
  $promptPath = Join-Path $reportDir ("pending-" + $safeSnippet + ".txt")
  Set-Content -LiteralPath $promptPath -Value $Prompt -Encoding ASCII
  return $promptPath
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

function Get-CodexThreadFreshness {
  param(
    [Parameter(Mandatory = $true)][string]$UserHooksPath,
    [Parameter(Mandatory = $true)][string]$RequirementsConfigPath
  )

  $threadId = [string]$env:CODEX_THREAD_ID
  $threadCreatedAt = Get-CodexThreadCreatedAt -ThreadId $threadId
  $hooksWriteTime = if (Test-Path -LiteralPath $UserHooksPath) { (Get-Item -LiteralPath $UserHooksPath).LastWriteTimeUtc } else { $null }
  $requirementsWriteTime = if (Test-Path -LiteralPath $RequirementsConfigPath) { (Get-Item -LiteralPath $RequirementsConfigPath).LastWriteTimeUtc } else { $null }
  $promptHookWriteTime = $hooksWriteTime
  if ($requirementsWriteTime -and ((-not $promptHookWriteTime) -or $requirementsWriteTime -gt $promptHookWriteTime)) {
    $promptHookWriteTime = $requirementsWriteTime
  }
  $stale = [bool](
    -not [string]::IsNullOrWhiteSpace($threadId) -and
    $null -ne $threadCreatedAt -and
    $null -ne $promptHookWriteTime -and
    $threadCreatedAt -lt $promptHookWriteTime
  )

  return [ordered]@{
    current_thread_id = if ([string]::IsNullOrWhiteSpace($threadId)) { $null } else { $threadId }
    current_thread_created_at = if ($threadCreatedAt) { $threadCreatedAt.ToString("o") } else { $null }
    hooks_write_time = if ($hooksWriteTime) { $hooksWriteTime.ToString("o") } else { $null }
    requirements_write_time = if ($requirementsWriteTime) { $requirementsWriteTime.ToString("o") } else { $null }
    prompt_hook_write_time = if ($promptHookWriteTime) { $promptHookWriteTime.ToString("o") } else { $null }
    current_thread_stale_for_hooks = $stale
  }
}

function Join-ProcessArgumentLine {
  param([Parameter(Mandatory = $true)][string[]]$Arguments)
  $quoted = foreach ($argument in $Arguments) {
    if ($argument -match '^[A-Za-z0-9_:=/\\.\-]+$') {
      $argument
    } else {
      '"' + ($argument -replace '\\(?=")', '\\' -replace '"', '\"') + '"'
    }
  }
  return ($quoted -join " ")
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

$node = Find-PortableNode
if ([string]::IsNullOrWhiteSpace($node)) {
  throw "Node.js was not found. Install or repair DinoBrain portable Node first."
}

$verifyScript = Join-Path $AppPath "scripts\verify-codex-live-preflight.mjs"
$approvalScript = Join-Path $AppPath "scripts\start-codex-hook-approval.ps1"
if (-not (Test-Path -LiteralPath $verifyScript)) {
  throw "Live verifier missing: $verifyScript"
}
if (-not $SkipApproval -and -not (Test-Path -LiteralPath $approvalScript)) {
  throw "Hook approval script missing: $approvalScript"
}

$since = (Get-Date).ToUniversalTime().ToString("o")
if ([string]::IsNullOrWhiteSpace($Snippet)) {
  $Snippet = "DinoBrain live proof " + (Get-Date).ToUniversalTime().ToString("yyyyMMdd-HHmmss") + " " + ([guid]::NewGuid().ToString("N").Substring(0, 8))
}
$prompt = @"
$Snippet

This is a DinoBrain live hook proof prompt. Please reply with one short sentence after the pre-response OS context is loaded.
"@
$prompt = $prompt.Trim()
$promptPath = Write-LiveProofPromptFile -AppPath $AppPath -Snippet $Snippet -Prompt $prompt
$threadFreshness = Get-CodexThreadFreshness -UserHooksPath $HooksPath -RequirementsConfigPath $RequirementsPath

if ($Detached -and -not $Json) {
  $childArgs = @(
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
    "-HooksPath",
    $HooksPath,
    "-ConfigPath",
    $ConfigPath,
    "-RequirementsPath",
    $RequirementsPath,
    "-NodeExe",
    $node,
    "-Snippet",
    $Snippet,
    "-TimeoutSeconds",
    [string]$TimeoutSeconds,
    "-PollSeconds",
    [string]$PollSeconds
  )
  if ($SkipApproval) {
    $childArgs += "-SkipApproval"
  }

  Start-Process -FilePath "powershell.exe" -ArgumentList (Join-ProcessArgumentLine $childArgs) -WindowStyle Normal | Out-Null
  $clipboardOk = Set-ClipboardSafe -Text $prompt
  Write-Host "DinoBrain live proof started in a new window."
  Write-Host "Proof snippet: $Snippet"
  Write-Host "Prompt copied to clipboard: $clipboardOk"
  Write-Host "Prompt file: $promptPath"
  if (-not $clipboardOk) {
    Write-Host "Clipboard error: $script:LastClipboardError"
    Write-Host "Prompt text:"
    Write-Host $prompt
  }
  if ($threadFreshness.current_thread_stale_for_hooks) {
    Write-Host "Current thread warning: this Codex thread predates hooks.json; paste the proof prompt into a fresh Codex Desktop thread."
  }
  exit 0
}

if (-not $SkipApproval) {
  & powershell.exe `
    -NoProfile `
    -ExecutionPolicy Bypass `
    -File $approvalScript `
    -AppPath $AppPath `
    -HooksPath $HooksPath `
    -ConfigPath $ConfigPath `
    -RequirementsPath $RequirementsPath `
    -RestartStaleCodex `
    -RestartStaleMcp `
    -NoUi
}

$clipboardOk = Set-ClipboardSafe -Text $prompt
$clipboardInstruction = if ($clipboardOk) {
  "Paste the proof prompt now copied to your clipboard."
} else {
  "Clipboard copy failed. Copy the proof prompt from this file instead: $promptPath"
}
$threadWarning = ""
if ($threadFreshness.current_thread_stale_for_hooks) {
  $threadWarning = @"

Important:
The Codex thread that launched this proof was created before hooks.json changed.
Use a fresh Codex Desktop thread for the pasted prompt, or the verifier will keep failing without a live UserPromptSubmit event.
"@
}
$instruction = @"
DinoBrain live proof is waiting.

1. If Codex still shows the DinoBrain UserPromptSubmit hook as untrusted, type /hooks and approve it.
2. Start a new Codex thread after any restart or approval.
3. $clipboardInstruction
4. This window will keep checking for the real codex_desktop preflight event.
$threadWarning

Proof snippet:
$Snippet
"@
Show-Info -Message $instruction

$deadline = (Get-Date).AddSeconds([Math]::Max(1, $TimeoutSeconds))
$lastOutput = ""
$ok = $false
$attempts = 0
while ((Get-Date) -lt $deadline) {
  $attempts += 1
  $oldErrorActionPreference = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  try {
    $output = & $node $verifyScript --snippet $Snippet --since $since 2>&1
    $exit = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $oldErrorActionPreference
  }
  $lastOutput = ($output -join "`n")
  if ($exit -eq 0) {
    $ok = $true
    break
  }
  if (-not $Json) {
    Write-Host ("[{0}] Waiting for live Codex proof attempt {1}; verifier still failing." -f (Get-Date).ToString("HH:mm:ss"), $attempts)
  }
  Start-Sleep -Seconds ([Math]::Max(1, $PollSeconds))
}

$report = [ordered]@{
  ok = $ok
  generated_at = (Get-Date).ToUniversalTime().ToString("o")
  app_path = $AppPath
  vault_path = $VaultPath
  hooks_path = $HooksPath
  config_path = $ConfigPath
  requirements_path = $RequirementsPath
  snippet = $Snippet
  prompt_copied_to_clipboard = $clipboardOk
  clipboard_error = if ($clipboardOk) { "" } else { $script:LastClipboardError }
  prompt_path = $promptPath
  prompt_text = $prompt
  since = $since
  attempts = $attempts
  timeout_seconds = $TimeoutSeconds
  thread_freshness = $threadFreshness
  last_verifier_output = $lastOutput
}

if ($Json) {
  $report | ConvertTo-Json -Depth 8
  exit ($(if ($ok) { 0 } else { 1 }))
}

if ($ok) {
  Write-Host ""
  Write-Host "DinoBrain live Codex proof passed."
  Write-Host $lastOutput
  exit 0
}

Write-Host ""
Write-Host "DinoBrain live Codex proof did not pass before timeout."
Write-Host "Last verifier output:"
Write-Host $lastOutput
exit 1
