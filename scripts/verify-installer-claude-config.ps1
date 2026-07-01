#Requires -Version 5.1
[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$root = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$installScript = Join-Path $root "install.ps1"
$source = [System.IO.File]::ReadAllText($installScript)
$start = $source.IndexOf("function Invoke-NativeCommand")
$end = $source.IndexOf("function Invoke-DinoBrainVerify")
if ($start -lt 0 -or $end -lt 0 -or $end -le $start) {
  throw "Could not locate installer Claude config functions."
}

$functionBlock = $source.Substring($start, $end - $start)
Invoke-Expression $functionBlock

$temp = Join-Path ([System.IO.Path]::GetTempPath()) ("dinobrain-claude-verify-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Force -Path $temp | Out-Null
try {
  $fakeClaude = Join-Path $temp "claude.cmd"
  $fakeClaudeBody = @"
@echo off
if "%1"=="mcp" if "%2"=="remove" (
  echo No MCP server named "dinobrain". Configured servers: confluence, jira 1>&2
  exit /b 1
)
if "%1"=="mcp" if "%2"=="add" (
  echo Added stdio MCP server dinobrain with command node.exe
  exit /b 0
)
if "%1"=="mcp" if "%2"=="list" (
  echo confluence
  echo jira
  echo dinobrain
  exit /b 0
)
echo unexpected claude args: %* 1>&2
exit /b 2
"@
  [System.IO.File]::WriteAllText($fakeClaude, $fakeClaudeBody, [System.Text.UTF8Encoding]::new($false))

  $configured = Set-DinoBrainClaudeCodeConfig `
    -ClaudeCommand $fakeClaude `
    -Scope "user" `
    -NodeExe (Join-Path $temp "node.exe") `
    -ServerEntry (Join-Path $temp "dist\index.js") `
    -VaultPath (Join-Path $temp "data") `
    -WorkingDirectory $temp

  if (-not $configured) {
    throw "Expected fake Claude Code config to succeed."
  }
  if (-not ($configured -is [bool])) {
    throw "Expected Claude Code config to return a single bool, got $($configured.GetType().FullName)"
  }

  Write-Host "installer Claude config verification ok"
} finally {
  Remove-Item -LiteralPath $temp -Recurse -Force -ErrorAction SilentlyContinue
}
