#Requires -Version 5.1
[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$root = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$approvalScript = Join-Path $root "scripts\start-codex-hook-approval.ps1"
if (-not (Test-Path -LiteralPath $approvalScript)) {
  throw "Approval script missing: $approvalScript"
}

$temp = Join-Path ([System.IO.Path]::GetTempPath()) ("dinobrain-hook-approval-verify-" + [guid]::NewGuid().ToString("N"))
try {
  $appPath = Join-Path $temp "dinobrain"
  $codexDir = Join-Path $temp ".codex"
  New-Item -ItemType Directory -Force -Path $appPath, $codexDir | Out-Null
  $hooksPath = Join-Path $codexDir "hooks.json"
  $configPath = Join-Path $codexDir "config.toml"
  $requirementsPath = Join-Path $codexDir "requirements.toml"
  [System.IO.File]::WriteAllText($hooksPath, '{"hooks":{"UserPromptSubmit":[]}}', [System.Text.UTF8Encoding]::new($false))
  [System.IO.File]::WriteAllText($configPath, "[features]`r`nhooks = true`r`n", [System.Text.UTF8Encoding]::new($false))
  [System.IO.File]::WriteAllText($requirementsPath, "[features]`r`nhooks = true`r`n", [System.Text.UTF8Encoding]::new($false))

  $output = & powershell.exe `
    -NoProfile `
    -ExecutionPolicy Bypass `
    -File $approvalScript `
    -AppPath $appPath `
    -HooksPath $hooksPath `
    -ConfigPath $configPath `
    -RequirementsPath $requirementsPath `
    -NoRestart `
    -NoOpen `
    -NoUi `
    -Json
  if ($LASTEXITCODE -ne 0) {
    throw "Approval script exited with $LASTEXITCODE"
  }

  $json = ($output -join "`n") | ConvertFrom-Json
  if ($json.ok -ne $true) {
    throw "Approval report was not ok."
  }
  if ($json.user_trust_required -ne $true) {
    throw "Approval flow must preserve user trust requirement."
  }
  if ($json.clipboard_hint -ne "/hooks") {
    throw "Approval flow did not report the /hooks clipboard hint."
  }
  if ($json.started_via -ne "") {
    throw "Approval verification should not launch Codex."
  }

  Write-Host "codex hook approval verification ok"
} finally {
  Remove-Item -LiteralPath $temp -Recurse -Force -ErrorAction SilentlyContinue
}
