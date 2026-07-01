#Requires -Version 5.1
[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$root = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$installScript = Join-Path $root "install.ps1"
$source = [System.IO.File]::ReadAllText($installScript)
$start = $source.IndexOf("function Invoke-NativeCommandResult")
$end = $source.IndexOf("function Get-DinoBrainGitHubToken")
if ($start -lt 0 -or $end -lt 0 -or $end -le $start) {
  throw "Could not locate installer native result function."
}

$functionBlock = $source.Substring($start, $end - $start)
Invoke-Expression $functionBlock

$powershell = (Get-Command powershell.exe -ErrorAction Stop).Source
$result = Invoke-NativeCommandResult `
  -FilePath $powershell `
  -ArgumentList @(
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
    "[Console]::Error.WriteLine('expected native stderr'); exit 7"
  ) `
  -WorkingDirectory $root

if ($result.ExitCode -ne 7) {
  throw "Expected exit code 7, got $($result.ExitCode)"
}
if ($result.Output -notmatch "expected native stderr") {
  throw "Expected stderr to be captured in output."
}

Write-Host "installer native result verification ok"
