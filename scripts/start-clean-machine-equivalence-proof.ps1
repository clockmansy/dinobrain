#Requires -Version 5.1
[CmdletBinding()]
param(
  [ValidateSet("both_clients", "codex_only")]
  [string]$Mode = "both_clients",
  [string]$AppPath = "",
  [string]$VaultPath = "",
  [string]$NodeExe = "",
  [string]$InstallResultPath = "",
  [string]$RestoreReceiptPath = "",
  [string]$ResumeRunId = "",
  [string]$CodexCommand = "",
  [string]$ClaudeCommand = "",
  [ValidateRange(60, 7200)][int]$ClientProofTimeoutSeconds = 3600,
  [switch]$Unattended,
  [switch]$SkipCodexProof,
  [switch]$SkipClaudeProof,
  [switch]$SkipVerificationCommands
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Resolve-ProofPath {
  param([Parameter(Mandatory = $true)][string]$Value)
  $expanded = [Environment]::ExpandEnvironmentVariables($Value)
  if ([System.IO.Path]::IsPathRooted($expanded)) { return [System.IO.Path]::GetFullPath($expanded) }
  return [System.IO.Path]::GetFullPath((Join-Path (Get-Location).Path $expanded))
}

function Find-ProofNode {
  if (-not [string]::IsNullOrWhiteSpace($NodeExe)) {
    $candidate = Resolve-ProofPath $NodeExe
    if (Test-Path -LiteralPath $candidate -PathType Leaf) { return $candidate }
  }
  if ($env:LOCALAPPDATA) {
    $candidate = Join-Path $env:LOCALAPPDATA "DinoBrain\tools\node-v24.18.0-win-x64\node.exe"
    if (Test-Path -LiteralPath $candidate -PathType Leaf) { return $candidate }
  }
  $command = Get-Command node -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($command -and $command.Source) { return [string]$command.Source }
  throw "Node.js was not found. Repair the DinoBrain installation first."
}

function Invoke-ProofNodeJson {
  param([Parameter(Mandatory = $true)][string[]]$Arguments)
  $oldPreference = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  try {
    $output = @(& $script:Node $script:Runner @Arguments 2>&1)
    $exitCode = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $oldPreference
  }
  $text = $output -join [Environment]::NewLine
  if ($exitCode -ne 0) {
    try { $parsedFailure = $text | ConvertFrom-Json } catch { $parsedFailure = $null }
    $message = if ($parsedFailure -and $parsedFailure.error) { [string]$parsedFailure.error } else { $text }
    throw "Clean-machine proof command failed with exit code $exitCode. $message"
  }
  try { return $text | ConvertFrom-Json } catch { throw "Clean-machine proof command returned invalid JSON: $text" }
}

if ([string]::IsNullOrWhiteSpace($AppPath)) {
  $AppPath = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
} else {
  $AppPath = Resolve-ProofPath $AppPath
}
if ([string]::IsNullOrWhiteSpace($VaultPath)) {
  $VaultPath = [System.IO.Path]::GetFullPath((Join-Path $AppPath "..\dinobrain-data"))
} else {
  $VaultPath = Resolve-ProofPath $VaultPath
}
$script:Node = Find-ProofNode
$env:PATH = "$(Split-Path -Parent $script:Node);$env:PATH"
$script:Runner = Join-Path $AppPath "dist\run-clean-machine-equivalence.js"
$clientProofScript = Join-Path $AppPath "scripts\start-client-mcp-proof.ps1"
if (-not (Test-Path -LiteralPath $script:Runner -PathType Leaf)) { throw "Clean-machine proof CLI is not built: $script:Runner" }
if (-not (Test-Path -LiteralPath $clientProofScript -PathType Leaf)) { throw "Direct MCP proof script is missing: $clientProofScript" }
if ($Unattended) {
  if ([string]::IsNullOrWhiteSpace($CodexCommand) -or -not (Test-Path -LiteralPath (Resolve-ProofPath $CodexCommand) -PathType Leaf)) {
    throw "Unattended proof requires a real CodexCommand executable."
  }
  if ($Mode -eq "both_clients" -and ([string]::IsNullOrWhiteSpace($ClaudeCommand) -or -not (Test-Path -LiteralPath (Resolve-ProofPath $ClaudeCommand) -PathType Leaf))) {
    throw "Unattended both-client proof requires a real ClaudeCommand executable."
  }
}

if ([string]::IsNullOrWhiteSpace($InstallResultPath)) {
  $InstallResultPath = Join-Path (Split-Path -Parent $AppPath) "dinobrain-install-result.json"
} else {
  $InstallResultPath = Resolve-ProofPath $InstallResultPath
}
if ([string]::IsNullOrWhiteSpace($RestoreReceiptPath)) {
  if ($env:LOCALAPPDATA) {
    $RestoreReceiptPath = Join-Path $env:LOCALAPPDATA "DinoBrain\proofs\private-restore\latest.json"
  } else {
    $RestoreReceiptPath = Join-Path $HOME ".local\state\dinobrain\proofs\private-restore\latest.json"
  }
} else {
  $RestoreReceiptPath = Resolve-ProofPath $RestoreReceiptPath
}

if ($Mode -eq "both_clients") {
  if (-not (Test-Path -LiteralPath $InstallResultPath -PathType Leaf)) {
    throw "Transactional install result is required: $InstallResultPath"
  }
  if (-not (Test-Path -LiteralPath $RestoreReceiptPath -PathType Leaf)) {
    throw "Encrypted restore receipt is required: $RestoreReceiptPath. Run DinoBrain Private Restore.cmd first."
  }
  if (-not (Get-Command claude -ErrorAction SilentlyContinue)) {
    throw "Claude Code is not installed or not on PATH. Both-client equivalence cannot pass. Use -Mode codex_only only for a local diagnostic."
  }
}

$runId = $ResumeRunId
if ([string]::IsNullOrWhiteSpace($runId)) {
  $beginArguments = @(
    "begin",
    "--app-root", $AppPath,
    "--data-root", $VaultPath,
    "--mode", $Mode
  )
  if (Test-Path -LiteralPath $InstallResultPath -PathType Leaf) { $beginArguments += @("--install-result", $InstallResultPath) }
  if (Test-Path -LiteralPath $RestoreReceiptPath -PathType Leaf) { $beginArguments += @("--restore-receipt", $RestoreReceiptPath) }
  $begin = Invoke-ProofNodeJson -Arguments $beginArguments
  $runId = [string]$begin.run_id
  Write-Host ""
  Write-Host "DinoBrain clean-machine proof started: $runId"
  Write-Host "Installed app commit: $($begin.installed_app_commit)"
  Write-Host "Installed data commit: $($begin.installed_data_commit)"
} else {
  $shown = Invoke-ProofNodeJson -Arguments @("show", "--run-id", $runId)
  $Mode = [string]$shown.descriptor.mode
  Write-Host "Resuming DinoBrain clean-machine proof: $runId"
}

$clientFailures = New-Object System.Collections.Generic.List[string]
foreach ($agent in @("codex", "claude")) {
  if ($agent -eq "claude" -and $Mode -eq "codex_only") { continue }
  if ($agent -eq "codex" -and $SkipCodexProof) { continue }
  if ($agent -eq "claude" -and $SkipClaudeProof) { continue }
  Write-Host ""
  Write-Host "Starting $agent direct MCP plus live pre-response proof."
  if ($Unattended) {
    Write-Host "Launching the real $agent client non-interactively inside the isolated proof machine."
  } else {
    Write-Host "Paste the copied challenge into a fresh $agent session. The same prompt proves both paths."
  }
  $oldPreference = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  try {
    $clientArguments = @(
      "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $clientProofScript,
      "-Agent", $agent,
      "-AppPath", $AppPath,
      "-VaultPath", $VaultPath,
      "-NodeExe", $script:Node,
      "-TimeoutSeconds", [string]$ClientProofTimeoutSeconds,
      "-NoDialog"
    )
    if ($Unattended) {
      $clientArguments += @(
        "-Unattended",
        "-CodexCommand", $CodexCommand,
        "-ClaudeCommand", $ClaudeCommand,
        "-ClientLogRoot", (Join-Path $VaultPath ".dino\proofs\client-mcp\unattended-logs")
      )
    }
    & powershell.exe @clientArguments
    $clientExit = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $oldPreference
  }
  if ($clientExit -ne 0) {
    $clientFailures.Add("$agent proof exited with code $clientExit")
    Write-Warning "$agent proof did not complete. The final evidence will remain blocked; resume run $runId after repairing the client."
  }
}

Write-Host ""
Write-Host "Running sequential recovery-equivalence checks. Output is streamed to local-only logs to keep RAM bounded."
$finalArguments = @("finalize", "--run-id", $runId)
if ($SkipVerificationCommands) { $finalArguments += "--skip-commands" }
$oldPreference = $ErrorActionPreference
$ErrorActionPreference = "Continue"
try {
  $finalOutput = @(& $script:Node $script:Runner @finalArguments 2>&1)
  $finalExit = $LASTEXITCODE
} finally {
  $ErrorActionPreference = $oldPreference
}
$finalText = $finalOutput -join [Environment]::NewLine
try { $final = $finalText | ConvertFrom-Json } catch { throw "Final clean-machine proof returned invalid JSON: $finalText" }

Write-Host ""
Write-Host "DinoBrain recovery-equivalence status: $($final.status)"
Write-Host "Evidence: $($final.evidence_path)"
if ($final.resource_usage.peak_process_tree_working_set_mib) {
  Write-Host "Peak verification process-tree RAM: $($final.resource_usage.peak_process_tree_working_set_mib) MiB"
}
if (@($final.blockers).Count -gt 0) {
  Write-Host "Remaining blockers:"
  @($final.blockers) | ForEach-Object { Write-Host "- $_" }
}
if ($clientFailures.Count -gt 0) {
  Write-Host "Client proof failures:"
  $clientFailures | ForEach-Object { Write-Host "- $_" }
}
if ($finalExit -ne 0 -or -not $final.ok) {
  Write-Warning "Clean-machine equivalence is not complete. Resume with: powershell -File `"$PSCommandPath`" -ResumeRunId $runId"
  exit 1
}

Write-Host "Clean-machine recovery equivalence verified."
