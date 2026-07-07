#Requires -Version 5.1
[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$root = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$installScript = Join-Path $root "install.ps1"
$source = [System.IO.File]::ReadAllText($installScript)
$start = $source.IndexOf("function ConvertTo-TomlString")
$end = $source.IndexOf("function Set-DinoBrainClaudeCodeConfig")
if ($start -lt 0 -or $end -lt 0 -or $end -le $start) {
  throw "Could not locate installer hook functions."
}

$functions = $source.Substring($start, $end - $start)
Invoke-Expression $functions

$temp = Join-Path ([System.IO.Path]::GetTempPath()) ("dinobrain-hook-verify-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Force -Path $temp | Out-Null
try {
  $cases = @(
    @{
      Name = "empty"
      Json = "{}"
    },
    @{
      Name = "array"
      Json = '{"hooks":{"UserPromptSubmit":[{"hooks":[{"type":"command","command":"echo old","timeout":5}]}]}}'
    },
    @{
      Name = "two-groups"
      Json = '{"hooks":{"UserPromptSubmit":[{"hooks":[{"type":"command","command":"echo first","timeout":5}]},{"hooks":[{"type":"command","command":"echo second","timeout":5}]}]}}'
    },
    @{
      Name = "single-object"
      Json = '{"hooks":{"UserPromptSubmit":{"hooks":[{"type":"command","command":"echo old","timeout":5}]}}}'
    },
    @{
      Name = "mixed-dinobrain"
      Json = '{"hooks":{"UserPromptSubmit":[{"hooks":[{"type":"command","command":"echo old","timeout":5},{"type":"command","command":"powershell dinobrain-user-prompt-hook.ps1","statusMessage":"Loading DinoBrain context"}]}]}}'
    },
    @{
      Name = "existing-dinobrain"
      Json = '{"hooks":{"UserPromptSubmit":[{"hooks":[{"type":"command","command":"powershell dinobrain-user-prompt-hook.ps1","statusMessage":"Loading DinoBrain context"}]}]}}'
    }
  )

  foreach ($case in $cases) {
    $hooksPath = Join-Path $temp "$($case.Name)-hooks.json"
    [System.IO.File]::WriteAllText($hooksPath, $case.Json, [System.Text.UTF8Encoding]::new($false))
    Set-DinoBrainCodexUserHook -HooksPath $hooksPath -AppPath (Join-Path $temp "dinobrain") -VaultPath (Join-Path $temp "dinobrain-data")
    $raw = [System.IO.File]::ReadAllText($hooksPath)
    $parsed = $raw | ConvertFrom-Json
    $groups = @($parsed.hooks.UserPromptSubmit)
    if ($groups.Count -lt 1) {
      throw "No UserPromptSubmit groups written for case $($case.Name)"
    }
    $text = $raw
    if ($text -notmatch "dinobrain-user-prompt-hook\.ps1") {
      throw "DinoBrain hook missing for case $($case.Name)"
    }
    if ($text -notmatch "DINOBRAIN_HOOK_AUTO_SYNC") {
      throw "DinoBrain hook auto-sync env missing for case $($case.Name)"
    }
    if ($text -notmatch "DINOBRAIN_AUTO_COMPOUND") {
      throw "DinoBrain hook auto-compound env missing for case $($case.Name)"
    }
    $dinoHookCount = 0
    foreach ($group in $groups) {
      foreach ($hook in @($group.hooks)) {
        $hookText = $hook | ConvertTo-Json -Depth 20 -Compress
        if ($hookText -match "dinobrain-user-prompt-hook\.ps1") {
          $dinoHookCount += 1
        }
      }
    }
    if ($dinoHookCount -ne 1) {
      throw "Unexpected DinoBrain hook count for case $($case.Name): $dinoHookCount"
    }
    if (($case.Name -eq "array" -or $case.Name -eq "single-object" -or $case.Name -eq "mixed-dinobrain") -and $text -notmatch "echo old") {
      throw "Existing non-DinoBrain hook was not preserved for case $($case.Name)"
    }
    if ($case.Name -eq "two-groups") {
      if ($groups.Count -ne 2) {
        throw "Two existing UserPromptSubmit groups should remain two groups after merge"
      }
      $firstGroupText = $groups[0] | ConvertTo-Json -Depth 20 -Compress
      $secondGroupText = $groups[1] | ConvertTo-Json -Depth 20 -Compress
      if ($firstGroupText -notmatch "echo first" -or $firstGroupText -notmatch "dinobrain-user-prompt-hook\.ps1") {
        throw "DinoBrain hook was not merged into the first existing UserPromptSubmit group"
      }
      if ($secondGroupText -notmatch "echo second" -or $secondGroupText -match "dinobrain-user-prompt-hook\.ps1") {
        throw "DinoBrain hook should not be appended as a separate later group"
      }
    }
    if ($case.Name -eq "mixed-dinobrain" -and $groups.Count -ne 1) {
      throw "Mixed DinoBrain group should keep the non-Dino hook in the same first group"
    }
  }

  $claudeSettingsPath = Join-Path $temp "claude-settings.json"
  [System.IO.File]::WriteAllText($claudeSettingsPath, '{"hooks":{"UserPromptSubmit":[{"matcher":"","hooks":[{"type":"command","command":"echo claude-old"}]}]}}', [System.Text.UTF8Encoding]::new($false))
  Set-DinoBrainClaudeUserHook -SettingsPath $claudeSettingsPath -AppPath (Join-Path $temp "dinobrain") -VaultPath (Join-Path $temp "dinobrain-data")
  $claudeRaw = [System.IO.File]::ReadAllText($claudeSettingsPath)
  $claudeParsed = $claudeRaw | ConvertFrom-Json
  $claudeGroups = @($claudeParsed.hooks.UserPromptSubmit)
  if ($claudeGroups.Count -lt 1) {
    throw "No Claude UserPromptSubmit groups written"
  }
  if ($claudeRaw -notmatch "dinobrain-user-prompt-hook\.ps1") {
    throw "Claude DinoBrain UserPromptSubmit hook missing"
  }
  if ($claudeRaw -notmatch "DINOBRAIN_AUTO_COMPOUND") {
    throw "Claude DinoBrain hook auto-compound env missing"
  }
  if ($claudeRaw -notmatch "echo claude-old") {
    throw "Existing Claude non-DinoBrain hook was not preserved"
  }
  $claudeFirstGroupText = $claudeGroups[0] | ConvertTo-Json -Depth 20 -Compress
  if ($claudeFirstGroupText -notmatch "echo claude-old" -or $claudeFirstGroupText -notmatch "dinobrain-user-prompt-hook\.ps1") {
    throw "Claude DinoBrain hook was not merged into the first existing UserPromptSubmit group"
  }

  $configPath = Join-Path $temp "config.toml"
  [System.IO.File]::WriteAllText($configPath, "[features]`r`nhooks = false`r`njs_repl = false`r`n", [System.Text.UTF8Encoding]::new($false))
  Set-DinoBrainCodexConfig `
    -ConfigPath $configPath `
    -NodeExe (Join-Path $temp "node.exe") `
    -ServerEntry (Join-Path $temp "dinobrain\dist\index.js") `
    -VaultPath (Join-Path $temp "dinobrain-data") `
    -EnableHooks
  $configText = [System.IO.File]::ReadAllText($configPath)
  if ($configText -notmatch "(?m)^hooks = true\r?$") {
    throw "Codex hooks feature was not enabled in config.toml"
  }
  if ($configText -notmatch "(?m)^js_repl = false\r?$") {
    throw "Existing features setting was not preserved in config.toml"
  }
  if ($configText -notmatch "\[mcp_servers\.dinobrain\]") {
    throw "DinoBrain MCP config was not written"
  }
  foreach ($envName in @("DINOBRAIN_AUTO_GROWTH", "DINOBRAIN_AUTO_COMPOUND", "DINOBRAIN_AUTO_SYNC")) {
    if ($configText -notmatch "(?m)^$envName = `"1`"\r?$") {
      throw "DinoBrain MCP env missing: $envName"
    }
  }
  foreach ($envName in @("DINOBRAIN_AUTO_SYNC_ALLOW_CONDITIONAL", "DINOBRAIN_AUTO_SYNC_PUSH")) {
    if ($configText -notmatch "(?m)^$envName = `"0`"\r?$") {
      throw "DinoBrain MCP safe auto-sync env missing: $envName"
    }
  }
  Assert-DinoBrainNoBareCarriageReturnFile -Path $configPath

  $malformedConfigPath = Join-Path $temp "malformed-config.toml"
  $cr = [string][char]13
  $lf = [string][char]10
  $malformedConfig = "[features]$cr$cr$lf" + "hooks = false$cr" + "js_repl = false$lf"
  [System.IO.File]::WriteAllText($malformedConfigPath, $malformedConfig, [System.Text.UTF8Encoding]::new($false))
  Set-DinoBrainCodexConfig `
    -ConfigPath $malformedConfigPath `
    -NodeExe (Join-Path $temp "node.exe") `
    -ServerEntry (Join-Path $temp "dinobrain\dist\index.js") `
    -VaultPath (Join-Path $temp "dinobrain-data") `
    -EnableHooks
  Assert-DinoBrainNoBareCarriageReturnFile -Path $malformedConfigPath
  $malformedConfigText = [System.IO.File]::ReadAllText($malformedConfigPath)
  Assert-DinoBrainCodexConfigTomlShape -Text $malformedConfigText -ConfigPath $malformedConfigPath
  if ($malformedConfigText -match "`r(?!`n)") {
    throw "Malformed config rewrite left a bare carriage return"
  }

  $handshakeApp = Join-Path $temp "handshake-app"
  $handshakeScripts = Join-Path $handshakeApp "scripts"
  $handshakeData = Join-Path $temp "handshake-data"
  $fakeNode = Join-Path $temp "node.exe"
  New-Item -ItemType Directory -Force -Path $handshakeScripts, $handshakeData | Out-Null
  New-Item -ItemType File -Force -Path $fakeNode | Out-Null
  $fakeHook = @'
$ErrorActionPreference = "Stop"
$inputText = [Console]::In.ReadToEnd()
if ($inputText -notmatch "DinoBrain installer hook handshake") {
  throw "missing installer handshake prompt"
}
if ([string]::IsNullOrWhiteSpace($env:DINOBRAIN_DATA_DIR)) {
  throw "missing DINOBRAIN_DATA_DIR"
}
if ([string]::IsNullOrWhiteSpace($env:DINOBRAIN_NODE_EXE)) {
  throw "missing DINOBRAIN_NODE_EXE"
}
if ($env:DINOBRAIN_HOOK_PROJECT -ne "dinobrain-installer") {
  throw "missing installer hook project"
}
if ($env:DINOBRAIN_HOOK_IMPORT_SESSION -ne "0") {
  throw "installer handshake should disable session import"
}
@{
  hookSpecificOutput = @{
    hookEventName = "UserPromptSubmit"
    additionalContext = "DinoBrain OS preflight completed for this Codex prompt.`nhook_report: reports/live-hooks/installer-handshake.json"
  }
} | ConvertTo-Json -Depth 8 -Compress
'@
  [System.IO.File]::WriteAllText((Join-Path $handshakeScripts "dinobrain-user-prompt-hook.ps1"), $fakeHook, [System.Text.UTF8Encoding]::new($false))
  Invoke-DinoBrainCodexHookHandshake -AppPath $handshakeApp -VaultPath $handshakeData -NodeExe $fakeNode

  Write-Host "installer hook verification ok"
} finally {
  Remove-Item -LiteralPath $temp -Recurse -Force -ErrorAction SilentlyContinue
}
