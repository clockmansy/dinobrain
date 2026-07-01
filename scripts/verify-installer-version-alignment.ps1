#Requires -Version 5.1
[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
  Write-Host "installer version alignment verification skipped: git missing"
  exit 0
}

$root = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$installScript = Join-Path $root "install.ps1"
$source = [System.IO.File]::ReadAllText($installScript)
$start = $source.IndexOf("function Test-Command")
$end = $source.IndexOf("function Install-PortableNode")
if ($start -lt 0 -or $end -lt 0 -or $end -le $start) {
  throw "Could not locate installer git/version functions."
}

$functions = $source.Substring($start, $end - $start)
Invoke-Expression $functions

function Invoke-TestGit {
  param(
    [Parameter(Mandatory = $true)][string[]]$ArgumentList,
    [Parameter(Mandatory = $true)][string]$WorkingDirectory
  )
  Push-Location $WorkingDirectory
  try {
    $quotedArgs = $ArgumentList | ForEach-Object {
      if ($_ -match '[\s"]') {
        '"' + ($_ -replace '"', '\"') + '"'
      } else {
        $_
      }
    }
    $output = cmd /d /c "git $($quotedArgs -join ' ') 2>&1"
    $exitCode = $LASTEXITCODE
  } finally {
    Pop-Location
  }
  if ($output) {
    $output | Out-Host
  }
  if ($exitCode -ne 0) {
    throw "git $($ArgumentList -join ' ') failed with $exitCode"
  }
}

$temp = Join-Path ([System.IO.Path]::GetTempPath()) ("dinobrain-version-align-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Force -Path $temp | Out-Null
try {
  $origin = Join-Path $temp "origin.git"
  $work = Join-Path $temp "work"
  $target = Join-Path $temp "target"
  Invoke-TestGit -ArgumentList @("init", "--bare", $origin) -WorkingDirectory $temp
  Invoke-TestGit -ArgumentList @("clone", $origin, $work) -WorkingDirectory $temp
  Invoke-TestGit -ArgumentList @("-C", $work, "checkout", "-b", "main") -WorkingDirectory $temp
  Invoke-TestGit -ArgumentList @("-C", $work, "config", "user.email", "verify@example.invalid") -WorkingDirectory $temp
  Invoke-TestGit -ArgumentList @("-C", $work, "config", "user.name", "DinoBrain Verify") -WorkingDirectory $temp
  [System.IO.File]::WriteAllText((Join-Path $work "README.md"), "one`n", [System.Text.UTF8Encoding]::new($false))
  Invoke-TestGit -ArgumentList @("-C", $work, "add", "README.md") -WorkingDirectory $temp
  Invoke-TestGit -ArgumentList @("-C", $work, "commit", "-m", "one") -WorkingDirectory $temp
  Invoke-TestGit -ArgumentList @("-C", $work, "push", "-u", "origin", "main") -WorkingDirectory $temp

  Sync-DinoBrainRepo -Name "test-app" -RepoUrl $origin -TargetDir $target -Ref "main"
  Assert-DinoBrainRepoAligned -Name "test-app" -TargetDir $target -Ref "main"

  [System.IO.File]::WriteAllText((Join-Path $work "README.md"), "two`n", [System.Text.UTF8Encoding]::new($false))
  Invoke-TestGit -ArgumentList @("-C", $work, "commit", "-am", "two") -WorkingDirectory $temp
  Invoke-TestGit -ArgumentList @("-C", $work, "push", "origin", "main") -WorkingDirectory $temp

  $driftDetected = $false
  try {
    Assert-DinoBrainRepoAligned -Name "test-app" -TargetDir $target -Ref "main"
  } catch {
    if ($_.Exception.Message -match "version drift detected") {
      $driftDetected = $true
    } else {
      throw
    }
  }
  if (-not $driftDetected) {
    throw "Expected version drift to be detected."
  }

  Sync-DinoBrainRepo -Name "test-app" -RepoUrl $origin -TargetDir $target -Ref "main"
  Assert-DinoBrainRepoAligned -Name "test-app" -TargetDir $target -Ref "main"

  Write-Host "installer version alignment verification ok"
} finally {
  Remove-Item -LiteralPath $temp -Recurse -Force -ErrorAction SilentlyContinue
}
