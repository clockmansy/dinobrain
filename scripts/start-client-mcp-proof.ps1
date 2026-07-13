#Requires -Version 5.1
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidateSet("codex", "claude")]
  [string]$Agent,
  [string]$AppPath = "",
  [string]$VaultPath = "",
  [string]$NodeExe = "",
  [int]$TimeoutSeconds = 3600,
  [int]$PollSeconds = 5,
  [string]$CodexCommand = "",
  [string]$ClaudeCommand = "",
  [string]$ClientLogRoot = "",
  [switch]$Unattended,
  [switch]$NoDialog,
  [switch]$NoUi,
  [switch]$Json
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Resolve-FullPath {
  param([Parameter(Mandatory = $true)][string]$Value)
  $expanded = [Environment]::ExpandEnvironmentVariables($Value)
  if ([System.IO.Path]::IsPathRooted($expanded)) {
    return [System.IO.Path]::GetFullPath($expanded)
  }
  return [System.IO.Path]::GetFullPath((Join-Path (Get-Location).Path $expanded))
}

function Find-NodeExe {
  if (-not [string]::IsNullOrWhiteSpace($NodeExe)) {
    $candidate = Resolve-FullPath $NodeExe
    if (Test-Path -LiteralPath $candidate) { return $candidate }
  }
  if ($env:LOCALAPPDATA) {
    $candidate = Join-Path $env:LOCALAPPDATA "DinoBrain\tools\node-v24.18.0-win-x64\node.exe"
    if (Test-Path -LiteralPath $candidate) { return $candidate }
  }
  $command = Get-Command node -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($command -and -not [string]::IsNullOrWhiteSpace([string]$command.Source)) {
    return [string]$command.Source
  }
  throw "Node.js was not found. Repair the DinoBrain installation first."
}

function Set-ProofClipboard {
  param([Parameter(Mandatory = $true)][string]$Text)
  try {
    Set-Clipboard -Value $Text -ErrorAction Stop
    return $true
  } catch {
    $clip = Join-Path $env:SystemRoot "System32\clip.exe"
    if (Test-Path -LiteralPath $clip) {
      $clipOutput = $Text | & $clip 2>&1
      $clipExit = $LASTEXITCODE
      $null = $clipOutput
      return ($clipExit -eq 0)
    }
  }
  return $false
}

function Show-ProofInstructions {
  param([Parameter(Mandatory = $true)][string]$Message)
  if ($NoDialog -or $NoUi -or $Json) { return }
  try {
    Add-Type -AssemblyName System.Windows.Forms
    [System.Windows.Forms.MessageBox]::Show(
      $Message,
      "DinoBrain Direct MCP Proof",
      [System.Windows.Forms.MessageBoxButtons]::OK,
      [System.Windows.Forms.MessageBoxIcon]::Information
    ) | Out-Null
  } catch {
    Write-Host $Message
  }
}

function Quote-ProcessArgument {
  param([string]$Value)
  if ($Value -notmatch '[\s"]') { return $Value }
  return '"' + ($Value -replace '"', '\"') + '"'
}

function Invoke-UnattendedClient {
  param([Parameter(Mandatory = $true)][string]$PromptPath)
  if ([string]::IsNullOrWhiteSpace($ClientLogRoot)) {
    $script:ClientLogRoot = Join-Path $AppPath "reports\client-mcp-proofs\unattended"
  } else {
    $script:ClientLogRoot = Resolve-FullPath $ClientLogRoot
  }
  New-Item -ItemType Directory -Force -Path $script:ClientLogRoot | Out-Null
  $stdout = Join-Path $script:ClientLogRoot ("{0}-{1}.stdout.log" -f $Agent, $challenge.challenge_id)
  $stderr = Join-Path $script:ClientLogRoot ("{0}-{1}.stderr.log" -f $Agent, $challenge.challenge_id)

  if ($Agent -eq "codex") {
    if ([string]::IsNullOrWhiteSpace($CodexCommand)) { throw "CodexCommand is required for unattended proof." }
    $client = Resolve-FullPath $CodexCommand
    $arguments = @(
      "--dangerously-bypass-approvals-and-sandbox",
      "--dangerously-bypass-hook-trust",
      "exec",
      "--ephemeral",
      "--cd", $AppPath,
      "--json",
      "-"
    )
  } else {
    if ([string]::IsNullOrWhiteSpace($ClaudeCommand)) { throw "ClaudeCommand is required for unattended proof." }
    $client = Resolve-FullPath $ClaudeCommand
    $arguments = @(
      "-p",
      "--output-format", "json",
      "--max-turns", "40",
      "--no-session-persistence",
      "--permission-mode", "dontAsk",
      "--allowedTools",
      "mcp__dinobrain__begin_client_mcp_proof",
      "mcp__dinobrain__os_begin_task",
      "mcp__dinobrain__get_context_pack",
      "mcp__dinobrain__wiki_search",
      "mcp__dinobrain__search_memory",
      "mcp__dinobrain__finish_task",
      "mcp__dinobrain__finalize_client_mcp_proof"
    )
  }
  if (-not (Test-Path -LiteralPath $client -PathType Leaf)) { throw "Unattended client executable is missing: $client" }
  $clientArgumentLine = ($arguments | ForEach-Object { Quote-ProcessArgument $_ }) -join " "
  if ([System.IO.Path]::GetExtension($client).Equals(".cmd", [StringComparison]::OrdinalIgnoreCase)) {
    $processFile = $env:ComSpec
    $argumentLine = '/d /s /c ""' + $client + '" ' + $clientArgumentLine + '"'
  } else {
    $processFile = $client
    $argumentLine = $clientArgumentLine
  }
  $process = Start-Process -FilePath $processFile -ArgumentList $argumentLine -WorkingDirectory $AppPath -RedirectStandardInput $PromptPath -RedirectStandardOutput $stdout -RedirectStandardError $stderr -PassThru -Wait -WindowStyle Hidden
  return [ordered]@{
    exit_code = [int]$process.ExitCode
    stdout_path = $stdout
    stderr_path = $stderr
  }
}

if ([string]::IsNullOrWhiteSpace($AppPath)) {
  $AppPath = Resolve-FullPath (Join-Path $PSScriptRoot "..")
} else {
  $AppPath = Resolve-FullPath $AppPath
}
if ([string]::IsNullOrWhiteSpace($VaultPath)) {
  $VaultPath = Resolve-FullPath (Join-Path $AppPath "..\dinobrain-data")
} else {
  $VaultPath = Resolve-FullPath $VaultPath
}
$node = Find-NodeExe
$challengeScript = Join-Path $AppPath "dist\create-client-mcp-proof-challenge.js"
$statusScript = Join-Path $AppPath "dist\build-client-mcp-direct-status.js"
if (-not (Test-Path -LiteralPath $challengeScript)) { throw "Challenge builder missing: $challengeScript" }
if (-not (Test-Path -LiteralPath $statusScript)) { throw "Direct MCP status builder missing: $statusScript" }

$oldDataRoot = $env:DINOBRAIN_DATA_DIR
try {
  $env:DINOBRAIN_DATA_DIR = $VaultPath
  $ttlMinutes = [Math]::Min(60, [Math]::Max(1, [Math]::Ceiling([Math]::Max(1, $TimeoutSeconds) / 60.0)))
  $challengeOutput = & $node $challengeScript --agent $Agent --ttl-minutes $ttlMinutes 2>&1
  if ($LASTEXITCODE -ne 0) { throw "Challenge creation failed: $($challengeOutput -join [Environment]::NewLine)" }
  $challenge = ($challengeOutput -join [Environment]::NewLine) | ConvertFrom-Json

  $reportDir = Join-Path $AppPath "reports\client-mcp-proofs"
  New-Item -ItemType Directory -Force -Path $reportDir | Out-Null
  $promptPath = Join-Path $reportDir ("pending-{0}-{1}.txt" -f $Agent, $challenge.challenge_id)
  $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($promptPath, [string]$challenge.prompt, $utf8NoBom)
  $clipboardOk = if ($Json -or $NoUi -or $Unattended) { $false } else { Set-ProofClipboard -Text ([string]$challenge.prompt) }
  $unattendedRun = $null

  $clientName = if ($Agent -eq "codex") { "a fully restarted Codex Desktop task" } else { "a fresh Claude Code session" }
  $message = if ($Unattended) { @"
DinoBrain direct MCP proof is ready for $Agent.

The encrypted-auth Windows Sandbox runner will execute this challenge through the real non-interactive client.

Challenge: $($challenge.challenge_id)
Prompt file: $promptPath
"@ } else { @"
DinoBrain direct MCP proof is ready for $Agent.

1. Open $clientName after this DinoBrain build was installed.
2. Paste the proof prompt now copied to the clipboard.
3. Let the client call every named DinoBrain MCP tool and finish the challenge.
4. Keep this window open; it will verify the signed server receipt chain.

Challenge: $($challenge.challenge_id)
Prompt file: $promptPath
Clipboard copied: $clipboardOk

If begin_client_mcp_proof is not visible, fully restart the client and open a new task. Configuration or a synthetic stdio client cannot satisfy this proof.
"@ }
  Show-ProofInstructions -Message $message
  if (-not $Json) { Write-Host $message }

  if ($Unattended) {
    if (-not $Json) { Write-Host "Launching isolated unattended $Agent proof client." }
    $unattendedRun = Invoke-UnattendedClient -PromptPath $promptPath
    if ($unattendedRun.exit_code -ne 0 -and -not $Json) {
      Write-Warning "$Agent unattended client exited with code $($unattendedRun.exit_code); receipt verification will still run."
    }
  }

  $effectiveTimeoutSeconds = if ($Unattended) { [Math]::Min(30, [Math]::Max(1, $TimeoutSeconds)) } else { [Math]::Max(1, $TimeoutSeconds) }
  $deadline = (Get-Date).AddSeconds($effectiveTimeoutSeconds)
  $verified = $false
  $agentReport = $null
  while ((Get-Date) -lt $deadline) {
    $statusOutput = & $node $statusScript 2>&1
    if ($LASTEXITCODE -eq 0) {
      $statusPath = Join-Path $VaultPath ".dino\state\client_mcp_direct_status.json"
      if (Test-Path -LiteralPath $statusPath) {
        $status = Get-Content -LiteralPath $statusPath -Raw | ConvertFrom-Json
        $agentReport = $status.agents | Where-Object { $_.agent -eq $Agent } | Select-Object -First 1
        if (
          $agentReport -and
          $agentReport.status -eq "verified" -and
          $agentReport.proof_version -eq "client_mcp_direct_proof_v2" -and
          $agentReport.challenge_id -eq $challenge.challenge_id
        ) {
          $verified = $true
          break
        }
      }
    }
    Start-Sleep -Seconds ([Math]::Max(1, $PollSeconds))
  }

  $result = [ordered]@{
    ok = $verified
    agent = $Agent
    challenge_id = $challenge.challenge_id
    challenge_path = $challenge.challenge_path
    prompt_path = $promptPath
    clipboard_copied = $clipboardOk
    expires_at = $challenge.expires_at
    proof_path = if ($agentReport) { $agentReport.proof_path } else { $null }
    proof_sha256 = if ($agentReport) { $agentReport.proof_sha256 } else { $null }
    client_name = if ($agentReport) { $agentReport.client_name } else { $null }
    client_version = if ($agentReport) { $agentReport.client_version } else { $null }
    unattended = [bool]$Unattended
    unattended_client_exit_code = if ($unattendedRun) { $unattendedRun.exit_code } else { $null }
    unattended_stdout_path = if ($unattendedRun) { $unattendedRun.stdout_path } else { $null }
    unattended_stderr_path = if ($unattendedRun) { $unattendedRun.stderr_path } else { $null }
  }
  if ($Json) {
    $result | ConvertTo-Json -Depth 8
  } elseif ($verified) {
    Write-Host ""
    Write-Host "DinoBrain $Agent direct MCP proof verified."
    Write-Host "Proof: $($agentReport.proof_path)"
  } else {
    Write-Host ""
    Write-Host "DinoBrain $Agent direct MCP proof did not complete before timeout."
    Write-Host "The challenge was not converted into verified evidence."
  }
  exit ($(if ($verified) { 0 } else { 1 }))
} finally {
  if ($null -eq $oldDataRoot) {
    Remove-Item Env:\DINOBRAIN_DATA_DIR -ErrorAction SilentlyContinue
  } else {
    $env:DINOBRAIN_DATA_DIR = $oldDataRoot
  }
}
