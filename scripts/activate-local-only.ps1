#Requires -Version 5.1
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$AppPath,
  [Parameter(Mandatory = $true)][string]$VaultPath,
  [string]$ManagedHookPath = "",
  [bool]$SeparateRuntime = $true,
  [bool]$CreateLocalBranch = $true
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Invoke-Git {
  param([string]$Repo, [string[]]$Arguments)
  & git -C $Repo @Arguments
  if ($LASTEXITCODE -ne 0) { throw "git -C $Repo $($Arguments -join ' ') failed with exit code $LASTEXITCODE" }
}

function Get-GitText {
  param([string]$Repo, [string[]]$Arguments)
  $value = (& git -C $Repo @Arguments 2>$null)
  if ($LASTEXITCODE -ne 0) { throw "git -C $Repo $($Arguments -join ' ') failed" }
  return ([string]($value -join "`n")).Trim()
}

function Write-Utf8NoBom {
  param([string]$Path, [string]$Value)
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Path) | Out-Null
  [System.IO.File]::WriteAllText($Path, $Value, [System.Text.UTF8Encoding]::new($false))
}

function Set-PushBlocked {
  param([string]$Repo)
  & git -C $Repo config --local --unset-all remote.origin.pushurl 2>$null
  & git -C $Repo config --local --add remote.origin.pushurl "disabled://dinobrain-local-only"
  if ($LASTEXITCODE -ne 0) { throw "Could not disable origin push URL in $Repo" }

  $hooksPath = (& git -C $Repo config --local --get core.hooksPath 2>$null)
  if ([string]::IsNullOrWhiteSpace([string]$hooksPath)) { $hooksPath = Join-Path $Repo ".git\hooks" }
  elseif (-not [System.IO.Path]::IsPathRooted([string]$hooksPath)) { $hooksPath = Join-Path $Repo ([string]$hooksPath) }
  $prePush = Join-Path ([System.IO.Path]::GetFullPath([string]$hooksPath)) "pre-push"
  if ((Test-Path -LiteralPath $prePush -PathType Leaf) -and -not ([System.IO.File]::ReadAllText($prePush) -match "DINOBRAIN_LOCAL_ONLY_PUSH_BLOCK")) {
    Copy-Item -LiteralPath $prePush -Destination "$prePush.remote-capable.bak" -Force
  }
  Write-Utf8NoBom -Path $prePush -Value @'
#!/bin/sh
# DINOBRAIN_LOCAL_ONLY_PUSH_BLOCK
echo "DinoBrain local_only mode blocks every remote push." >&2
exit 1
'@
}

function Set-LocalOnlyPreCommit {
  param([string]$Repo)
  $hooksPath = (& git -C $Repo config --local --get core.hooksPath 2>$null)
  if ([string]::IsNullOrWhiteSpace([string]$hooksPath)) { $hooksPath = Join-Path $Repo ".git\hooks" }
  elseif (-not [System.IO.Path]::IsPathRooted([string]$hooksPath)) { $hooksPath = Join-Path $Repo ([string]$hooksPath) }
  $preCommit = Join-Path ([System.IO.Path]::GetFullPath([string]$hooksPath)) "pre-commit"
  if ((Test-Path -LiteralPath $preCommit -PathType Leaf) -and -not ([System.IO.File]::ReadAllText($preCommit) -match "DINOBRAIN_LOCAL_ONLY_SOURCE_GUARD")) {
    Copy-Item -LiteralPath $preCommit -Destination "$preCommit.remote-capable.bak" -Force
  }
  Write-Utf8NoBom -Path $preCommit -Value @'
#!/bin/sh
# DINOBRAIN_LOCAL_ONLY_SOURCE_GUARD
set -eu
blocked=0
git diff --cached --name-only --diff-filter=ACMR | while IFS= read -r file; do
  case "$file" in
    .dino/audits/*|.dino/compounding/*|.dino/context-packs/*|.dino/events/*|.dino/gates/*|.dino/generations/*|.dino/hook-locks/*|.dino/index/*|.dino/lifecycle/*|.dino/local-backups/*|.dino/locks/*|.dino/migrations/*|.dino/proofs/*|.dino/state/*|.dino/sync-scopes/*|.dino/tasks/*|.dino/tmp/*|.dino/traces/*|reports/live-hooks/*|10_Conversations/raw/*|30_Sources/private/*|50_Instances/raw/*|attachments/private/*|.env|.env.*|*.pem|*.key|*.p12|*.pfx)
      echo "DinoBrain local_only source guard blocks runtime/raw/secret path: $file" >&2
      blocked=1
      ;;
  esac
  if [ "$blocked" -ne 0 ]; then exit 1; fi
done
'@
}

function Add-RuntimeExcludes {
  param([string]$Repo)
  $excludePath = Join-Path $Repo ".git\info\exclude"
  $existing = if (Test-Path -LiteralPath $excludePath) { [System.IO.File]::ReadAllText($excludePath) } else { "" }
  $block = @'

# DinoBrain local_only runtime projections (rebuildable, never public)
.dino/context-packs/
.dino/audits/
.dino/compounding/
.dino/events/
.dino/gates/
.dino/generations/
.dino/hook-locks/
.dino/index/
.dino/lifecycle/
.dino/local-backups/
.dino/locks/
.dino/migrations/
.dino/proofs/
.dino/state/
.dino/sync-scopes/
.dino/tasks/
.dino/tmp/
.dino/traces/
reports/live-hooks/
'@
  if ($existing -notmatch "DinoBrain local_only runtime projections") {
    Write-Utf8NoBom -Path $excludePath -Value ($existing.TrimEnd() + $block + "`n")
  }
}

function Set-ManagedHookLocalOnly {
  param([string]$HookPath)
  if (-not (Test-Path -LiteralPath $HookPath -PathType Leaf)) { return }
  $content = [System.IO.File]::ReadAllText($HookPath)
  $settings = [ordered]@{
    DINOBRAIN_MODE = "local_only"
    DINOBRAIN_LOCAL_ONLY = "1"
    DINOBRAIN_HOOK_AUTO_SYNC = "0"
    DINOBRAIN_AUTO_SYNC = "0"
    DINOBRAIN_AUTO_SYNC_PUSH = "0"
    DINOBRAIN_HOOK_IMPORT_SESSION = "1"
    DINOBRAIN_AUTO_GROWTH = "1"
    DINOBRAIN_AUTO_COMPOUND = "1"
    DINOBRAIN_SEMANTIC_MODEL = "Xenova/paraphrase-multilingual-MiniLM-L12-v2"
  }
  foreach ($entry in $settings.GetEnumerator()) {
    $pattern = "(?m)^\`$env:$([regex]::Escape($entry.Key))\s*=.*$"
    $line = "`$env:$($entry.Key) = `"$($entry.Value)`""
    if ($content -match $pattern) { $content = [regex]::Replace($content, $pattern, $line) }
    else { $content = "$line`r`n$content" }
  }
  Write-Utf8NoBom -Path $HookPath -Value $content
}

$app = [System.IO.Path]::GetFullPath($AppPath)
$vault = [System.IO.Path]::GetFullPath($VaultPath)
if (-not (Test-Path -LiteralPath (Join-Path $app ".git") -PathType Container)) { throw "App Git repository not found: $app" }
if (-not (Test-Path -LiteralPath (Join-Path $vault ".git") -PathType Container)) { throw "Data Git repository not found: $vault" }

$appCommit = Get-GitText -Repo $app -Arguments @("rev-parse", "HEAD")
$dataCommit = Get-GitText -Repo $vault -Arguments @("rev-parse", "HEAD")

foreach ($repo in @($app, $vault)) {
  Set-PushBlocked -Repo $repo
  Add-RuntimeExcludes -Repo $repo
  if ($CreateLocalBranch) {
    $branch = Get-GitText -Repo $repo -Arguments @("branch", "--show-current")
    if ($branch -ne "local-main") {
      $exists = (& git -C $repo branch --list local-main 2>$null)
      if ([string]::IsNullOrWhiteSpace([string]$exists)) { Invoke-Git -Repo $repo -Arguments @("switch", "-c", "local-main") }
      else { Invoke-Git -Repo $repo -Arguments @("switch", "local-main") }
    }
    $previousErrorAction = $ErrorActionPreference
    $ErrorActionPreference = "SilentlyContinue"
    & git -C $repo branch --unset-upstream 2>$null | Out-Null
    $ErrorActionPreference = $previousErrorAction
    $global:LASTEXITCODE = 0
  }
}
Set-LocalOnlyPreCommit -Repo $vault

if ($SeparateRuntime) {
  $runtimeSpecs = @(
    ".dino/audits", ".dino/compounding", ".dino/context-packs", ".dino/events", ".dino/gates",
    ".dino/generations", ".dino/hook-locks", ".dino/index", ".dino/lifecycle", ".dino/local-backups",
    ".dino/locks", ".dino/migrations", ".dino/proofs", ".dino/state", ".dino/sync-scopes",
    ".dino/tasks", ".dino/tmp", ".dino/traces", "reports/live-hooks"
  )
  & git -C $vault rm -r --cached --ignore-unmatch -- @runtimeSpecs | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "Could not separate tracked runtime projections from local data source history" }
  & git -C $vault diff --cached --quiet
  if ($LASTEXITCODE -eq 1) { Invoke-Git -Repo $vault -Arguments @("commit", "-m", "local: separate runtime projections") }
  elseif ($LASTEXITCODE -ne 0) { throw "Could not inspect staged runtime separation" }
}

if ([string]::IsNullOrWhiteSpace($ManagedHookPath)) {
  $ManagedHookPath = Join-Path $env:ProgramData "OpenAI\Codex\DinoBrainHooks\dinobrain-managed-user-prompt-hook.ps1"
}
Set-ManagedHookLocalOnly -HookPath ([System.IO.Path]::GetFullPath($ManagedHookPath))

$statePath = Join-Path $vault ".dino\state\local-only-mode.json"
$record = [ordered]@{
  version = "dinobrain_local_only_v1"; enabled = $true; activated_at = [DateTime]::UtcNow.ToString("o")
  final_app_commit = $appCommit; final_data_commit = $dataCommit; push_policy = "blocked"; remote_policy = "fetch_only"
  runtime_paths = @(".dino/audits/", ".dino/compounding/", ".dino/context-packs/", ".dino/events/", ".dino/gates/", ".dino/generations/", ".dino/hook-locks/", ".dino/index/", ".dino/lifecycle/", ".dino/local-backups/", ".dino/locks/", ".dino/migrations/", ".dino/proofs/", ".dino/state/", ".dino/sync-scopes/", ".dino/tasks/", ".dino/tmp/", ".dino/traces/", "reports/live-hooks/")
  source_paths = @("15_Profile/", "20_Wiki/", "30_Sources/", "40_Projects/", "50_Instances/", "70_Error_Book/", "80_Review_Queue/", ".dino/evaluations/", ".dino/provenance/", ".dino/quarantine/")
  candidate_loop = "capture_review_required"; auto_accept = $false
}
Write-Utf8NoBom -Path $statePath -Value (($record | ConvertTo-Json -Depth 8) + "`n")

Write-Host "DinoBrain local_only mode activated."
Write-Host "Final public app commit: $appCommit"
Write-Host "Final public data commit: $dataCommit"
Write-Host "Remote push: blocked by config, pre-push hooks, MCP policy, and Observatory-visible state."
