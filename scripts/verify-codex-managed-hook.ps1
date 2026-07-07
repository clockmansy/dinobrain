#Requires -Version 5.1
[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$root = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$installer = Join-Path $root "scripts\install-codex-managed-hook.ps1"
if (-not (Test-Path -LiteralPath $installer)) {
  throw "Managed hook installer missing: $installer"
}

$temp = Join-Path ([System.IO.Path]::GetTempPath()) ("dinobrain-managed-hook-verify-" + [guid]::NewGuid().ToString("N"))
try {
  $appPath = Join-Path $temp "dinobrain"
  $vaultPath = Join-Path $temp "dinobrain-data"
  $scriptsPath = Join-Path $appPath "scripts"
  $managedDir = Join-Path $temp "managed-hooks"
  $requirementsPath = Join-Path $temp "requirements.toml"
  New-Item -ItemType Directory -Force -Path $scriptsPath, $vaultPath | Out-Null
  [System.IO.File]::WriteAllText((Join-Path $scriptsPath "dinobrain-user-prompt-hook.ps1"), "# fake hook`n", [System.Text.UTF8Encoding]::new($false))

  $output = & powershell.exe `
    -NoProfile `
    -ExecutionPolicy Bypass `
    -File $installer `
    -AppPath $appPath `
    -VaultPath $vaultPath `
    -RequirementsPath $requirementsPath `
    -ManagedDir $managedDir `
    -Json
  if ($LASTEXITCODE -ne 0) {
    throw "Managed hook installer exited with $LASTEXITCODE"
  }
  $json = ($output -join "`n") | ConvertFrom-Json
  if ($json.ok -ne $true) {
    throw "Managed hook installer did not report ok."
  }
  if (-not (Test-Path -LiteralPath $json.managed_wrapper)) {
    throw "Managed wrapper was not created: $($json.managed_wrapper)"
  }
  $requirements = [System.IO.File]::ReadAllText($requirementsPath)
  foreach ($needle in @("[features]", "hooks = true", "[hooks]", "windows_managed_dir", "[[hooks.UserPromptSubmit]]", "[[hooks.UserPromptSubmit.hooks]]", "command_windows", "dinobrain-managed-user-prompt-hook.ps1")) {
    if ($requirements -notmatch [regex]::Escape($needle)) {
      throw "requirements.toml missing expected text: $needle"
    }
  }
  if (([regex]::Matches($requirements, "DinoBrain managed UserPromptSubmit begin")).Count -ne 1) {
    throw "Expected exactly one DinoBrain managed hook block after first install."
  }

  $second = & powershell.exe `
    -NoProfile `
    -ExecutionPolicy Bypass `
    -File $installer `
    -AppPath $appPath `
    -VaultPath $vaultPath `
    -RequirementsPath $requirementsPath `
    -ManagedDir $managedDir `
    -Json
  if ($LASTEXITCODE -ne 0) {
    throw "Managed hook installer second run exited with $LASTEXITCODE"
  }
  $requirementsSecond = [System.IO.File]::ReadAllText($requirementsPath)
  if (([regex]::Matches($requirementsSecond, "DinoBrain managed UserPromptSubmit begin")).Count -ne 1) {
    throw "Managed hook installer was not idempotent."
  }

  $existingManaged = Join-Path $temp "enterprise-managed-hooks"
  New-Item -ItemType Directory -Force -Path $existingManaged | Out-Null
  $requirementsPath2 = Join-Path $temp "requirements-existing.toml"
  $existingText = @"
[features]
apps = true

[hooks]
windows_managed_dir = '$existingManaged'

"@
  [System.IO.File]::WriteAllText($requirementsPath2, $existingText, [System.Text.UTF8Encoding]::new($false))
  $third = & powershell.exe `
    -NoProfile `
    -ExecutionPolicy Bypass `
    -File $installer `
    -AppPath $appPath `
    -VaultPath $vaultPath `
    -RequirementsPath $requirementsPath2 `
    -ManagedDir (Join-Path $temp "ignored-managed-hooks") `
    -Json
  if ($LASTEXITCODE -ne 0) {
    throw "Managed hook installer existing-dir run exited with $LASTEXITCODE"
  }
  $jsonThird = ($third -join "`n") | ConvertFrom-Json
  if ($jsonThird.managed_dir -ne [System.IO.Path]::GetFullPath($existingManaged)) {
    throw "Existing windows_managed_dir was not preserved."
  }
  if (-not (Test-Path -LiteralPath (Join-Path $existingManaged "dinobrain-managed-user-prompt-hook.ps1"))) {
    throw "Managed wrapper was not written to existing managed dir."
  }
  $requirementsExisting = [System.IO.File]::ReadAllText($requirementsPath2)
  if ($requirementsExisting -notmatch "(?m)^apps = true\r?$") {
    throw "Existing feature setting was not preserved."
  }
  if ($requirementsExisting -notmatch "(?m)^hooks = true\r?$") {
    throw "Managed requirements did not pin hooks=true."
  }

  Write-Host "codex managed hook verification ok"
} finally {
  Remove-Item -LiteralPath $temp -Recurse -Force -ErrorAction SilentlyContinue
}
