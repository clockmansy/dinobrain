#Requires -Version 5.1
[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Assert-True {
  param([bool]$Condition, [string]$Message)
  if (-not $Condition) { throw $Message }
}

$root = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$installScript = Join-Path $root "install.ps1"
$source = [System.IO.File]::ReadAllText($installScript)
$start = $source.IndexOf("function Get-DinoBrainVisualCppRuntimeFiles")
$end = $source.IndexOf("function Invoke-WithPortableNode")
if ($start -lt 0 -or $end -le $start) {
  throw "Could not locate installer native runtime functions."
}
Invoke-Expression $source.Substring($start, $end - $start)

$temp = Join-Path ([System.IO.Path]::GetTempPath()) ("dinobrain-native-runtime-verify-" + [guid]::NewGuid().ToString("N"))
try {
  $runtimeRoot = Join-Path $temp "System32"
  New-Item -ItemType Directory -Force -Path $runtimeRoot | Out-Null

  $required = @(Get-DinoBrainVisualCppRuntimeFiles)
  Assert-True ($required.Count -eq 4) "Visual C++ runtime requirement count changed unexpectedly."
  $missing = @(Get-DinoBrainMissingVisualCppRuntimeFiles -RuntimeRoot $runtimeRoot)
  Assert-True ($missing.Count -eq 4) "Empty runtime fixture did not report every missing DLL."

  foreach ($fileName in $required) {
    [System.IO.File]::WriteAllBytes((Join-Path $runtimeRoot $fileName), [byte[]]@(0))
  }
  $missing = @(Get-DinoBrainMissingVisualCppRuntimeFiles -RuntimeRoot $runtimeRoot)
  Assert-True ($missing.Count -eq 0) "Complete runtime fixture was not accepted."

  Remove-Item -LiteralPath (Join-Path $runtimeRoot $required[0]) -Force
  $rejectedUnsafeRoot = $false
  try {
    Install-DinoBrainVisualCppRuntime -RuntimeRoot $runtimeRoot
  } catch {
    if ($_.Exception.Message -match "only permitted for the Windows System32 runtime root") {
      $rejectedUnsafeRoot = $true
    } else {
      throw
    }
  }
  Assert-True $rejectedUnsafeRoot "Runtime installer accepted a non-System32 destination."

  $unsigned = Join-Path $temp "unsigned.exe"
  [System.IO.File]::WriteAllText($unsigned, "not a signed executable", [System.Text.UTF8Encoding]::new($false))
  $rejectedUnsigned = $false
  try {
    Assert-DinoBrainMicrosoftSignedExecutable -Path $unsigned
  } catch {
    if ($_.Exception.Message -match "valid Authenticode signature") {
      $rejectedUnsigned = $true
    } else {
      throw
    }
  }
  Assert-True $rejectedUnsigned "Runtime installer accepted an unsigned executable."

  foreach ($needle in @(
    "https://aka.ms/vc14/vc_redist.x64.exe",
    "Get-AuthenticodeSignature",
    "CN=Microsoft Corporation",
    "O=Microsoft Corporation",
    "VC_redist.x64.exe",
    "Microsoft Visual C\+\+ v14 Redistributable",
    '"/install", "/quiet", "/norestart"',
    "-Verb RunAs",
    "require('onnxruntime-node')",
    "Install-DinoBrainVisualCppRuntime",
    "Assert-DinoBrainSemanticNativeRuntime"
  )) {
    Assert-True $source.Contains($needle) "Installer native runtime guard is missing: $needle"
  }

  Write-Host "installer native runtime verification ok"
} finally {
  Remove-Item -LiteralPath $temp -Recurse -Force -ErrorAction SilentlyContinue
}
