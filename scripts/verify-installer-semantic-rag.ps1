#Requires -Version 5.1
[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$root = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$installScript = Join-Path $root "install.ps1"
$source = [System.IO.File]::ReadAllText($installScript)
$start = $source.IndexOf("function Invoke-NativeCommand")
$end = $source.IndexOf("if ([string]::IsNullOrWhiteSpace(`$InstallRoot))")
if ($start -lt 0 -or $end -lt 0 -or $end -le $start) {
  throw "Could not locate installer semantic RAG functions."
}

Invoke-Expression $source.Substring($start, $end - $start)

function New-FakeNpm {
  param(
    [Parameter(Mandatory = $true)][string]$NodeRoot,
    [Parameter(Mandatory = $true)][string]$VaultPath,
    [Parameter(Mandatory = $true)][string]$LogPath,
    [switch]$BadProvider
  )

  New-Item -ItemType Directory -Force -Path $NodeRoot, (Join-Path $VaultPath ".dino\state") | Out-Null
  $fakePs1 = Join-Path $NodeRoot "fake-npm.ps1"
  $provider = if ($BadProvider) { "local_text_hashing_v1" } else { "huggingface_transformers_feature_extraction_v1" }
  $semantic = if ($BadProvider) { '$false' } else { '$true' }
  $script = @"
`$ErrorActionPreference = "Stop"
`$log = "$($LogPath.Replace("\", "\\"))"
`$vault = "$($VaultPath.Replace("\", "\\"))"
Add-Content -LiteralPath `$log -Value ("args=" + (`$args -join " ") + ";data=" + `$env:DINOBRAIN_DATA_DIR + ";require=" + `$env:DINOBRAIN_REQUIRE_SEMANTIC_EMBEDDINGS)
if (`$args.Count -ge 2 -and `$args[0] -eq "run" -and `$args[1] -eq "rag:proof") {
  `$proof = [ordered]@{
    status = "healthy"
    dense_vector = [ordered]@{
      provider = "$provider"
      model = "Xenova/all-MiniLM-L6-v2"
      dimensions = 384
      semantic_embedding_provider = $semantic
    }
  }
  New-Item -ItemType Directory -Force -Path (Join-Path `$vault ".dino\state") | Out-Null
  `$proof | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path `$vault ".dino\state\rag_proof_status.json") -Encoding UTF8
  exit 0
}
if (`$args.Count -ge 2 -and `$args[0] -eq "run" -and `$args[1] -eq "eval:rag") {
  `$eval = [ordered]@{
    status = "healthy"
    counts = [ordered]@{ lexical_fallback = 0 }
    generated_answer_eval = [ordered]@{ status = "healthy" }
  }
  New-Item -ItemType Directory -Force -Path (Join-Path `$vault ".dino\state") | Out-Null
  `$eval | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path `$vault ".dino\state\rag_eval_status.json") -Encoding UTF8
  exit 0
}
exit 9
"@
  [System.IO.File]::WriteAllText($fakePs1, $script, [System.Text.UTF8Encoding]::new($false))
  $cmd = "@echo off`r`npowershell.exe -NoProfile -ExecutionPolicy Bypass -File ""%~dp0fake-npm.ps1"" %*`r`nexit /b %ERRORLEVEL%`r`n"
  [System.IO.File]::WriteAllText((Join-Path $NodeRoot "npm.cmd"), $cmd, [System.Text.UTF8Encoding]::new($false))
}

$temp = Join-Path ([System.IO.Path]::GetTempPath()) ("dinobrain-installer-rag-verify-" + [guid]::NewGuid().ToString("N"))
try {
  $appPath = Join-Path $temp "app"
  $vaultPath = Join-Path $temp "data"
  $nodeRoot = Join-Path $temp "node"
  $logPath = Join-Path $temp "npm.log"
  New-Item -ItemType Directory -Force -Path $appPath, $vaultPath | Out-Null
  New-FakeNpm -NodeRoot $nodeRoot -VaultPath $vaultPath -LogPath $logPath

  Invoke-DinoBrainSemanticRagPrewarm -NodeRoot $nodeRoot -AppPath $appPath -VaultPath $vaultPath
  $log = [System.IO.File]::ReadAllText($logPath)
  if ($log -notmatch "args=run rag:proof" -or $log -notmatch "args=run eval:rag") {
    throw "Installer did not run rag:proof and eval:rag."
  }
  if ($log -notmatch [regex]::Escape("data=$vaultPath") -or $log -notmatch "require=1") {
    throw "Installer semantic RAG prewarm did not set required environment."
  }

  $badVault = Join-Path $temp "bad-data"
  $badNode = Join-Path $temp "bad-node"
  $badLog = Join-Path $temp "bad-npm.log"
  New-Item -ItemType Directory -Force -Path $badVault | Out-Null
  New-FakeNpm -NodeRoot $badNode -VaultPath $badVault -LogPath $badLog -BadProvider
  $rejectedFallback = $false
  try {
    Invoke-DinoBrainSemanticRagPrewarm -NodeRoot $badNode -AppPath $appPath -VaultPath $badVault
  } catch {
    if ($_.Exception.Message -match "semantic embedding provider|local text hashing") {
      $rejectedFallback = $true
    } else {
      throw
    }
  }
  if (-not $rejectedFallback) {
    throw "Installer accepted local hashing fallback as semantic RAG proof."
  }

  if ($source -notmatch "SkipSemanticRagPrewarm") {
    throw "Installer skip switch for semantic RAG prewarm is missing."
  }
  if ($source -notmatch "DINOBRAIN_REQUIRE_SEMANTIC_EMBEDDINGS") {
    throw "Installer does not require semantic embeddings during prewarm."
  }
  Write-Host "installer semantic RAG verification ok"
} finally {
  Remove-Item -LiteralPath $temp -Recurse -Force -ErrorAction SilentlyContinue
}
