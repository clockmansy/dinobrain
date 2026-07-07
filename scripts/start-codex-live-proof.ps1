#Requires -Version 5.1
[CmdletBinding()]
param(
  [string]$AppPath = "",
  [string]$VaultPath = "",
  [string]$HooksPath = "",
  [string]$ConfigPath = "",
  [string]$NodeExe = "",
  [string]$Snippet = "",
  [int]$TimeoutSeconds = 600,
  [int]$PollSeconds = 5,
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
  try {
    Set-Clipboard -Value $Text
    return $true
  } catch {
    return $false
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

if (-not $SkipApproval) {
  & powershell.exe `
    -NoProfile `
    -ExecutionPolicy Bypass `
    -File $approvalScript `
    -AppPath $AppPath `
    -HooksPath $HooksPath `
    -ConfigPath $ConfigPath `
    -RestartStaleCodex `
    -RestartStaleMcp
}

$clipboardOk = Set-ClipboardSafe -Text $prompt
$instruction = @"
DinoBrain live proof is waiting.

1. In Codex, run /hooks and trust the DinoBrain UserPromptSubmit hook if it is pending.
2. Start a new Codex thread after the restart.
3. Paste the proof prompt now copied to your clipboard.
4. This window will keep checking for the real codex_desktop preflight event.

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
  snippet = $Snippet
  prompt_copied_to_clipboard = $clipboardOk
  since = $since
  attempts = $attempts
  timeout_seconds = $TimeoutSeconds
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
