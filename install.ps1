#Requires -Version 5.1
[CmdletBinding()]
param(
  [string]$InstallRoot = "",
  [string]$AppRepo = "https://github.com/clockmansy/dinobrain.git",
  [string]$DataRepo = "https://github.com/clockmansy/dinobrain-data.git",
  [string]$AppRef = "main",
  [string]$DataRef = "main",
  [string]$GitHubToken = "",
  [string]$AppDir = "",
  [string]$DataDir = "",
  [string]$NodeVersion = "24.18.0",
  [string]$ToolsDir = "",
  [string]$CodexConfigPath = "",
  [string]$CodexHooksPath = "",
  [string]$CodexRequirementsPath = "",
  [string]$CodexManagedHookDir = "",
  [string]$ClaudeSettingsPath = "",
  [string]$ClaudeCommand = "claude",
  [ValidateSet("local", "project", "user")]
  [string]$ClaudeScope = "user",
  [switch]$SkipCodexConfig,
  [switch]$SkipCodexHookConfig,
  [switch]$SkipCodexManagedHookConfig,
  [switch]$SkipCodexRestartFlow,
  [switch]$SkipClaudeCodeConfig,
  [switch]$SkipSemanticRagPrewarm,
  [switch]$SkipVerify,
  [switch]$Force
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Get-DefaultInstallRoot {
  if (-not [string]::IsNullOrWhiteSpace($env:DINOBRAIN_INSTALL_ROOT)) {
    return (Resolve-DinoBrainInstallRoot $env:DINOBRAIN_INSTALL_ROOT)
  }
  if (-not [string]::IsNullOrWhiteSpace($env:DINOBRAIN_DATA_DIR)) {
    return (Resolve-DinoBrainInstallRoot $env:DINOBRAIN_DATA_DIR)
  }

  $codexDataDir = Get-DinoBrainConfiguredDataDir
  if (-not [string]::IsNullOrWhiteSpace($codexDataDir)) {
    return (Resolve-DinoBrainInstallRoot $codexDataDir)
  }

  foreach ($candidate in Get-DinoBrainInstallRootCandidates) {
    if (Test-DinoBrainInstallRoot $candidate) {
      return (Get-FullPath $candidate)
    }
  }

  $documents = [Environment]::GetFolderPath("MyDocuments")
  if ([string]::IsNullOrWhiteSpace($documents)) {
    return (Join-Path $HOME "Documents")
  }
  return $documents
}

function Get-DefaultToolsDir {
  if (-not [string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) {
    return (Join-Path $env:LOCALAPPDATA "DinoBrain\tools")
  }
  return (Join-Path $HOME "AppData\Local\DinoBrain\tools")
}

function Get-DefaultProgramData {
  if (-not [string]::IsNullOrWhiteSpace($env:ProgramData)) {
    return $env:ProgramData
  }
  return "C:\ProgramData"
}

function Get-FullPath {
  param([Parameter(Mandatory = $true)][string]$PathValue)
  $expanded = [Environment]::ExpandEnvironmentVariables($PathValue)
  if ([System.IO.Path]::IsPathRooted($expanded)) {
    return [System.IO.Path]::GetFullPath($expanded)
  }
  return [System.IO.Path]::GetFullPath((Join-Path (Get-Location).Path $expanded))
}

function Resolve-DinoBrainInstallRoot {
  param([Parameter(Mandatory = $true)][string]$PathValue)

  $full = Get-FullPath $PathValue.Trim().Trim('"')
  $trimmed = $full.TrimEnd([char[]]@('\', '/'))
  $leaf = Split-Path -Leaf $trimmed
  if ($leaf -ieq "dinobrain" -or $leaf -ieq "dinobrain-data") {
    $parent = Split-Path -Parent $trimmed
    if (-not [string]::IsNullOrWhiteSpace($parent)) {
      return $parent
    }
  }
  return $full
}

function Test-DinoBrainInstallRoot {
  param([Parameter(Mandatory = $true)][string]$PathValue)
  $root = Get-FullPath $PathValue
  return (Test-Path -LiteralPath (Join-Path $root "dinobrain")) -or (Test-Path -LiteralPath (Join-Path $root "dinobrain-data"))
}

function Get-DinoBrainConfiguredDataDir {
  $configPath = Join-Path $HOME ".codex\config.toml"
  if (-not (Test-Path -LiteralPath $configPath)) {
    return ""
  }
  try {
    $text = [System.IO.File]::ReadAllText($configPath)
    $match = [regex]::Match($text, 'DINOBRAIN_DATA_DIR\s*=\s*[''"]([^''"]+)[''"]', [System.Text.RegularExpressions.RegexOptions]::IgnoreCase)
    if ($match.Success) {
      return [Environment]::ExpandEnvironmentVariables($match.Groups[1].Value)
    }
  } catch {
    return ""
  }
  return ""
}

function Get-DinoBrainInstallRootCandidates {
  $items = New-Object System.Collections.Generic.List[string]
  $documents = [Environment]::GetFolderPath("MyDocuments")
  if ([string]::IsNullOrWhiteSpace($documents)) {
    $documents = Join-Path $HOME "Documents"
  }
  $items.Add($documents)
  $items.Add((Join-Path $documents "DinoBrain"))
  $items.Add($HOME)

  foreach ($drive in [System.IO.DriveInfo]::GetDrives()) {
    if (-not $drive.IsReady) { continue }
    $items.Add((Join-Path $drive.RootDirectory.FullName "dino"))
    $items.Add((Join-Path $drive.RootDirectory.FullName "DinoBrain"))
  }

  return $items | Where-Object { -not [string]::IsNullOrWhiteSpace($_) } | Select-Object -Unique
}

function Assert-Command {
  param([Parameter(Mandatory = $true)][string]$Name)
  if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
    throw "Required command not found on PATH: $Name"
  }
}

function Test-Command {
  param([Parameter(Mandatory = $true)][string]$Name)
  return [bool](Get-Command $Name -ErrorAction SilentlyContinue)
}

function Expand-DinoBrainZip {
  param(
    [Parameter(Mandatory = $true)][string]$ArchivePath,
    [Parameter(Mandatory = $true)][string]$DestinationPath
  )

  $archive = [System.IO.Path]::GetFullPath($ArchivePath)
  $destination = [System.IO.Path]::GetFullPath($DestinationPath)
  if (-not (Test-Path -LiteralPath $archive -PathType Leaf)) { throw "ZIP archive not found: $archive" }
  New-Item -ItemType Directory -Force -Path $destination | Out-Null
  $destinationPrefix = $destination.TrimEnd([char[]]@('\', '/')) + [System.IO.Path]::DirectorySeparatorChar
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $zip = [System.IO.Compression.ZipFile]::OpenRead($archive)
  try {
    foreach ($entry in $zip.Entries) {
      if ([string]::IsNullOrWhiteSpace([string]$entry.FullName)) { continue }
      $entryPath = ([string]$entry.FullName).Replace('/', [System.IO.Path]::DirectorySeparatorChar)
      $target = [System.IO.Path]::GetFullPath((Join-Path $destination $entryPath))
      if (-not $target.StartsWith($destinationPrefix, [StringComparison]::OrdinalIgnoreCase)) {
        throw "ZIP entry escapes the destination root: $($entry.FullName)"
      }
      if ([string]::IsNullOrEmpty([string]$entry.Name)) {
        New-Item -ItemType Directory -Force -Path $target | Out-Null
        continue
      }
      New-Item -ItemType Directory -Force -Path (Split-Path -Parent $target) | Out-Null
      [System.IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $target, $true)
    }
  } finally {
    $zip.Dispose()
  }
}

function Invoke-NativeCommand {
  param(
    [Parameter(Mandatory = $true)][string]$FilePath,
    [Parameter(Mandatory = $true)][string[]]$ArgumentList,
    [Parameter(Mandatory = $true)][string]$WorkingDirectory
  )
  Write-Host ">> $FilePath $($ArgumentList -join ' ')"
  Push-Location $WorkingDirectory
  try {
    & $FilePath @ArgumentList
    $exitCode = $LASTEXITCODE
    if ($exitCode -ne 0) {
      throw "Command failed with exit code ${exitCode}: $FilePath $($ArgumentList -join ' ')"
    }
  } finally {
    Pop-Location
  }
}

function Invoke-NativeCommandResult {
  param(
    [Parameter(Mandatory = $true)][string]$FilePath,
    [Parameter(Mandatory = $true)][string[]]$ArgumentList,
    [Parameter(Mandatory = $true)][string]$WorkingDirectory
  )

  Push-Location $WorkingDirectory
  try {
    $oldErrorActionPreference = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    $output = & $FilePath @ArgumentList 2>&1
    return [pscustomobject]@{
      ExitCode = $LASTEXITCODE
      Output = ($output -join "`n")
    }
  } finally {
    $ErrorActionPreference = $oldErrorActionPreference
    Pop-Location
  }
}

function Get-DinoBrainGitHubToken {
  param([string]$ExplicitToken)
  if (-not [string]::IsNullOrWhiteSpace($ExplicitToken)) { return $ExplicitToken }
  if (-not [string]::IsNullOrWhiteSpace($env:DINOBRAIN_GITHUB_TOKEN)) { return $env:DINOBRAIN_GITHUB_TOKEN }
  if (-not [string]::IsNullOrWhiteSpace($env:GITHUB_TOKEN)) { return $env:GITHUB_TOKEN }
  if (-not [string]::IsNullOrWhiteSpace($env:GH_TOKEN)) { return $env:GH_TOKEN }
  return ""
}

function Get-GitHubRepoParts {
  param([Parameter(Mandatory = $true)][string]$RepoUrl)

  $trimmed = $RepoUrl.Trim()
  $match = [regex]::Match($trimmed, "^https://github\.com/([^/]+)/([^/]+?)(?:\.git)?/?$")
  if (-not $match.Success) {
    $match = [regex]::Match($trimmed, "^git@github\.com:([^/]+)/([^/]+?)(?:\.git)?$")
  }
  if (-not $match.Success) {
    throw "GitHub ZIP fallback only supports github.com repositories: $RepoUrl"
  }

  return [pscustomobject]@{
    Owner = $match.Groups[1].Value
    Repo = $match.Groups[2].Value
  }
}

function Install-GitHubArchive {
  param(
    [Parameter(Mandatory = $true)][string]$Name,
    [Parameter(Mandatory = $true)][string]$RepoUrl,
    [Parameter(Mandatory = $true)][string]$Ref,
    [Parameter(Mandatory = $true)][string]$TargetDir,
    [string]$Token = ""
  )

  if (Test-Path -LiteralPath $TargetDir) {
    throw "$Name target already exists and Git is not available for safe update: $TargetDir"
  }

  $repo = Get-GitHubRepoParts -RepoUrl $RepoUrl
  $encodedRef = [System.Uri]::EscapeDataString($Ref)
  $archiveUrl = "https://api.github.com/repos/$($repo.Owner)/$($repo.Repo)/zipball/$encodedRef"
  $tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("dinobrain-archive-" + [guid]::NewGuid().ToString("N"))
  $zipPath = Join-Path $tempRoot "$Name.zip"
  $extractDir = Join-Path $tempRoot "extract"
  $headers = @{
    "Accept" = "application/vnd.github+json"
    "User-Agent" = "DinoBrainInstaller"
    "X-GitHub-Api-Version" = "2022-11-28"
  }
  if (-not [string]::IsNullOrWhiteSpace($Token)) {
    $headers["Authorization"] = "Bearer $Token"
  }

  Write-Warning "Git was not found. Installing $Name from GitHub ZIP archive at ref '$Ref'. Git-backed sync/update will require Git later."
  New-Item -ItemType Directory -Force -Path $tempRoot, $extractDir | Out-Null
  try {
    $oldProgress = $ProgressPreference
    $ProgressPreference = "SilentlyContinue"
    try {
      Invoke-WebRequest -Uri $archiveUrl -Headers $headers -OutFile $zipPath
    } finally {
      $ProgressPreference = $oldProgress
    }
    Expand-DinoBrainZip -ArchivePath $zipPath -DestinationPath $extractDir
    $roots = @(Get-ChildItem -LiteralPath $extractDir -Directory)
    if ($roots.Count -ne 1) {
      throw "Unexpected GitHub archive shape for $Name."
    }
    $parent = Split-Path -Parent $TargetDir
    New-Item -ItemType Directory -Force -Path $parent | Out-Null
    New-Item -ItemType Directory -Force -Path $TargetDir | Out-Null
    Get-ChildItem -LiteralPath $roots[0].FullName -Force | ForEach-Object {
      Move-Item -LiteralPath $_.FullName -Destination (Join-Path $TargetDir $_.Name)
    }
  } finally {
    Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
  }
}

function Checkout-DinoBrainRef {
  param(
    [Parameter(Mandatory = $true)][string]$Name,
    [Parameter(Mandatory = $true)][string]$TargetDir,
    [Parameter(Mandatory = $true)][string]$Ref
  )

  Invoke-NativeCommand -FilePath "git" -ArgumentList @("-C", $TargetDir, "fetch", "origin", "--prune", "--tags") -WorkingDirectory $TargetDir
  $branchResult = Invoke-NativeCommandResult -FilePath "git" -ArgumentList @("-C", $TargetDir, "rev-parse", "--verify", "origin/$Ref") -WorkingDirectory $TargetDir
  if ($branchResult.ExitCode -eq 0) {
    Invoke-NativeCommand -FilePath "git" -ArgumentList @("-C", $TargetDir, "checkout", "-B", $Ref, "origin/$Ref") -WorkingDirectory $TargetDir
    Invoke-NativeCommand -FilePath "git" -ArgumentList @("-C", $TargetDir, "pull", "--ff-only", "origin", $Ref) -WorkingDirectory $TargetDir
    return
  }

  Write-Host "$Name installing detached ref: $Ref"
  Invoke-NativeCommand -FilePath "git" -ArgumentList @("-C", $TargetDir, "checkout", "--detach", $Ref) -WorkingDirectory $TargetDir
}

function Get-DinoBrainGitText {
  param(
    [Parameter(Mandatory = $true)][string]$TargetDir,
    [Parameter(Mandatory = $true)][string[]]$ArgumentList
  )
  $result = Invoke-NativeCommandResult -FilePath "git" -ArgumentList (@("-C", $TargetDir) + $ArgumentList) -WorkingDirectory $TargetDir
  if ($result.ExitCode -ne 0) {
    throw "Git command failed in ${TargetDir}: git $($ArgumentList -join ' ')`n$($result.Output)"
  }
  return ($result.Output -split "`n" | Select-Object -First 1).Trim()
}

function Test-DinoBrainRemoteBranch {
  param(
    [Parameter(Mandatory = $true)][string]$TargetDir,
    [Parameter(Mandatory = $true)][string]$Ref
  )
  $result = Invoke-NativeCommandResult -FilePath "git" -ArgumentList @("-C", $TargetDir, "rev-parse", "--verify", "origin/$Ref") -WorkingDirectory $TargetDir
  return $result.ExitCode -eq 0
}

function Assert-DinoBrainRepoAligned {
  param(
    [Parameter(Mandatory = $true)][string]$Name,
    [Parameter(Mandatory = $true)][string]$TargetDir,
    [Parameter(Mandatory = $true)][string]$Ref
  )

  if (-not (Test-Path -LiteralPath (Join-Path $TargetDir ".git"))) {
    Write-Warning "$Name is not a git checkout; version drift cannot be verified: $TargetDir"
    return
  }

  Invoke-NativeCommand -FilePath "git" -ArgumentList @("-C", $TargetDir, "fetch", "origin", "--prune", "--tags") -WorkingDirectory $TargetDir
  $head = Get-DinoBrainGitText -TargetDir $TargetDir -ArgumentList @("rev-parse", "HEAD")
  if (Test-DinoBrainRemoteBranch -TargetDir $TargetDir -Ref $Ref) {
    $remote = Get-DinoBrainGitText -TargetDir $TargetDir -ArgumentList @("rev-parse", "origin/$Ref")
    if ($head -ne $remote) {
      throw "$Name version drift detected. Local HEAD $head does not match origin/$Ref $remote. Re-run setup/update after resolving local changes."
    }
    Write-Host "$Name version aligned: HEAD=$head origin/$Ref=$remote"
    return
  }

  $expected = Get-DinoBrainGitText -TargetDir $TargetDir -ArgumentList @("rev-parse", "--verify", $Ref)
  if ($head -ne $expected) {
    throw "$Name version drift detected. Local HEAD $head does not match requested ref $Ref ($expected)."
  }
  Write-Warning "$Name is pinned to detached ref $Ref. This is reproducible, but it will not automatically track origin/main."
}

function Enable-DinoBrainDataGitHooks {
  param(
    [Parameter(Mandatory = $true)][string]$DataDir
  )

  if (-not (Test-Command "git")) {
    Write-Warning "Git is not available; DinoBrain data safety hooks cannot be configured."
    return
  }
  if (-not (Test-Path -LiteralPath (Join-Path $DataDir ".git"))) {
    Write-Warning "DinoBrain data directory is not a git checkout; safety hooks cannot be configured: $DataDir"
    return
  }

  $hookRoot = Join-Path $DataDir ".githooks"
  $requiredHooks = @(
    (Join-Path $hookRoot "pre-commit"),
    (Join-Path $hookRoot "pre-push"),
    (Join-Path $hookRoot "verify-public-data-guard.ps1")
  )
  foreach ($hook in $requiredHooks) {
    if (-not (Test-Path -LiteralPath $hook)) {
      throw "DinoBrain data safety hook is missing: $hook"
    }
  }

  Invoke-NativeCommand -FilePath "git" -ArgumentList @("-C", $DataDir, "config", "core.hooksPath", ".githooks") -WorkingDirectory $DataDir
  $configured = (& git -C $DataDir config --get core.hooksPath)
  if ($LASTEXITCODE -ne 0 -or $configured.Trim() -ne ".githooks") {
    throw "Failed to configure DinoBrain data safety hooks. Expected .githooks, got '$configured'."
  }
  Write-Host "DinoBrain data safety hooks configured: $DataDir\.githooks"
}

function Sync-DinoBrainRepo {
  param(
    [Parameter(Mandatory = $true)][string]$Name,
    [Parameter(Mandatory = $true)][string]$RepoUrl,
    [Parameter(Mandatory = $true)][string]$TargetDir,
    [Parameter(Mandatory = $true)][string]$Ref,
    [string]$Token = "",
    [switch]$AllowOriginChange
  )

  if (-not (Test-Command "git")) {
    Install-GitHubArchive -Name $Name -RepoUrl $RepoUrl -Ref $Ref -TargetDir $TargetDir -Token $Token
    return
  }

  if (Test-Path -LiteralPath $TargetDir) {
    if (-not (Test-Path -LiteralPath (Join-Path $TargetDir ".git"))) {
      throw "$Name target exists but is not a git repository: $TargetDir"
    }

    $currentOrigin = (& git -C $TargetDir remote get-url origin 2>$null)
    if ($LASTEXITCODE -ne 0) {
      throw "$Name repository has no origin remote: $TargetDir"
    }
    if ($currentOrigin -ne $RepoUrl) {
      if ($AllowOriginChange) {
        Invoke-NativeCommand -FilePath "git" -ArgumentList @("-C", $TargetDir, "remote", "set-url", "origin", $RepoUrl) -WorkingDirectory $TargetDir
      } else {
        throw "$Name origin is '$currentOrigin', expected '$RepoUrl'. Pass -Force to replace the origin URL."
      }
    }

    Checkout-DinoBrainRef -Name $Name -TargetDir $TargetDir -Ref $Ref
    return
  }

  $parent = Split-Path -Parent $TargetDir
  New-Item -ItemType Directory -Force -Path $parent | Out-Null
  Invoke-NativeCommand -FilePath "git" -ArgumentList @("clone", $RepoUrl, $TargetDir) -WorkingDirectory $parent
  Checkout-DinoBrainRef -Name $Name -TargetDir $TargetDir -Ref $Ref
}

function Write-DinoBrainAtomicJson {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)]$Value
  )

  $full = Get-FullPath $Path
  $parent = Split-Path -Parent $full
  New-Item -ItemType Directory -Force -Path $parent | Out-Null
  $temp = "$full.$PID.$([guid]::NewGuid().ToString('N')).tmp"
  $backup = "$full.$PID.$([guid]::NewGuid().ToString('N')).replace-backup"
  $json = $Value | ConvertTo-Json -Depth 20
  [System.IO.File]::WriteAllText($temp, ($json + "`r`n"), [System.Text.UTF8Encoding]::new($false))
  try {
    if (Test-Path -LiteralPath $full) {
      [System.IO.File]::Replace($temp, $full, $backup, $true)
    } else {
      [System.IO.File]::Move($temp, $full)
    }
  } finally {
    Remove-Item -LiteralPath $temp -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $backup -Force -ErrorAction SilentlyContinue
  }
}

function Test-DinoBrainPathUnderRoot {
  param(
    [Parameter(Mandatory = $true)][string]$TargetPath,
    [Parameter(Mandatory = $true)][string]$AllowedRoot
  )

  $target = Get-FullPath $TargetPath
  $root = (Get-FullPath $AllowedRoot).TrimEnd([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar)
  return $target.StartsWith(($root + [System.IO.Path]::DirectorySeparatorChar), [System.StringComparison]::OrdinalIgnoreCase)
}

function Assert-DinoBrainTransactionalSiblingPath {
  param(
    [Parameter(Mandatory = $true)][string]$CandidatePath,
    [Parameter(Mandatory = $true)][string]$TargetPath,
    [Parameter(Mandatory = $true)][ValidateSet("stage", "rollback")][string]$Kind
  )

  $candidate = Get-FullPath $CandidatePath
  $target = Get-FullPath $TargetPath
  $candidateParent = Get-FullPath (Split-Path -Parent $candidate)
  $targetParent = Get-FullPath (Split-Path -Parent $target)
  $expectedPrefix = ".dino-$Kind-"
  if ($candidateParent -ne $targetParent -or -not (Split-Path -Leaf $candidate).StartsWith($expectedPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Unsafe DinoBrain transaction path: $candidate"
  }
  return $candidate
}

function ConvertTo-DinoBrainExtendedPath {
  param([Parameter(Mandatory = $true)][string]$Path)

  $expanded = [Environment]::ExpandEnvironmentVariables($Path)
  if ($expanded.StartsWith("\\?\", [StringComparison]::Ordinal)) { return $expanded }
  $full = Get-FullPath $expanded
  if ($full.StartsWith("\\", [StringComparison]::Ordinal)) {
    return "\\?\UNC\" + $full.TrimStart([char]'\')
  }
  return "\\?\" + $full
}

function Test-DinoBrainLongPathExists {
  param([Parameter(Mandatory = $true)][string]$Path)

  $extended = ConvertTo-DinoBrainExtendedPath -Path $Path
  return [System.IO.Directory]::Exists($extended) -or [System.IO.File]::Exists($extended)
}

function Clear-DinoBrainDeleteAttributes {
  param([Parameter(Mandatory = $true)][string]$ExtendedPath)

  if ([System.IO.File]::Exists($ExtendedPath)) {
    [System.IO.File]::SetAttributes($ExtendedPath, [System.IO.FileAttributes]::Normal)
    return
  }
  if (-not [System.IO.Directory]::Exists($ExtendedPath)) { return }
  try {
    foreach ($filePath in [System.IO.Directory]::EnumerateFiles($ExtendedPath, "*", [System.IO.SearchOption]::AllDirectories)) {
      try {
        [System.IO.File]::SetAttributes($filePath, [System.IO.FileAttributes]::Normal)
      } catch [System.IO.FileNotFoundException] {
      } catch [System.IO.DirectoryNotFoundException] {
      }
    }
  } catch [System.IO.DirectoryNotFoundException] {
  }
}

function Remove-DinoBrainPathWithRetry {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [int]$Attempts = 60,
    [int]$DelayMilliseconds = 500
  )

  $full = Get-FullPath $Path
  $extended = ConvertTo-DinoBrainExtendedPath -Path $full
  $lastError = $null
  for ($attempt = 1; $attempt -le $Attempts; $attempt += 1) {
    if (-not (Test-DinoBrainLongPathExists -Path $full)) { return }
    try {
      if ([System.IO.Directory]::Exists($extended)) {
        Clear-DinoBrainDeleteAttributes -ExtendedPath $extended
        [System.IO.Directory]::Delete($extended, $true)
      } elseif ([System.IO.File]::Exists($extended)) {
        Clear-DinoBrainDeleteAttributes -ExtendedPath $extended
        [System.IO.File]::Delete($extended)
      }
      if (-not (Test-DinoBrainLongPathExists -Path $full)) { return }
    } catch {
      $lastError = $_
    }
    if ($attempt -lt $Attempts) { Start-Sleep -Milliseconds $DelayMilliseconds }
  }
  $message = if ($null -ne $lastError) { [string]$lastError } else { "path still exists" }
  throw "Could not remove path after $Attempts attempts: $full. $message"
}

function Remove-DinoBrainTransactionalSiblingPath {
  param(
    [Parameter(Mandatory = $true)][string]$CandidatePath,
    [Parameter(Mandatory = $true)][string]$TargetPath,
    [Parameter(Mandatory = $true)][ValidateSet("stage", "rollback")][string]$Kind
  )

  $safe = Assert-DinoBrainTransactionalSiblingPath -CandidatePath $CandidatePath -TargetPath $TargetPath -Kind $Kind
  if (Test-Path -LiteralPath $safe) {
    Remove-DinoBrainPathWithRetry -Path $safe
  }
}

function Copy-DinoBrainDirectoryTree {
  param(
    [Parameter(Mandatory = $true)][string]$SourcePath,
    [Parameter(Mandatory = $true)][string]$DestinationPath
  )

  $source = Get-FullPath $SourcePath
  $destination = Get-FullPath $DestinationPath
  if (-not (Test-Path -LiteralPath $source -PathType Container)) {
    throw "Directory copy source is missing: $source"
  }
  New-Item -ItemType Directory -Force -Path $destination | Out-Null
  if (Test-Command "robocopy") {
    & robocopy $source $destination /E /COPY:DAT /DCOPY:DAT /R:2 /W:1 /XJ /NFL /NDL /NJH /NJS /NP | Out-Null
    $code = $LASTEXITCODE
    if ($code -ge 8) {
      throw "robocopy failed with exit code $code while staging $source"
    }
    return
  }
  Get-ChildItem -LiteralPath $source -Force | ForEach-Object {
    Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $destination $_.Name) -Recurse -Force
  }
}

function Get-DinoBrainInstallerLauncherNames {
  return @(
    "DinoBrain Observatory.cmd",
    "DinoBrain Hook Diagnose.cmd",
    "DinoBrain Codex Hook Approval.cmd",
    "DinoBrain Codex Managed Hook Admin.cmd",
    "DinoBrain Codex Live Proof.cmd",
    "DinoBrain Codex MCP Proof.cmd",
    "DinoBrain Claude MCP Proof.cmd",
    "DinoBrain Recovery Equivalence Proof.cmd",
    "DinoBrain Windows Sandbox Proof.cmd",
    "DinoBrain Private Backup.cmd",
    "DinoBrain Private Restore.cmd",
    "DinoBrain Uninstall Everything.cmd"
  )
}

function Add-DinoBrainInstallerLocalExcludes {
  param([Parameter(Mandatory = $true)][string]$AppPath)
  $gitDir = Join-Path (Get-FullPath $AppPath) ".git"
  if (-not (Test-Path -LiteralPath $gitDir -PathType Container)) { return }
  $excludePath = Join-Path $gitDir "info\exclude"
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $excludePath) | Out-Null
  $existing = if (Test-Path -LiteralPath $excludePath) { [System.IO.File]::ReadAllText($excludePath) } else { "" }
  $lines = New-Object System.Collections.Generic.List[string]
  foreach ($launcherName in Get-DinoBrainInstallerLauncherNames) {
    $line = "/$launcherName"
    if ($existing -notmatch "(?m)^$([regex]::Escape($line))\r?$") { $lines.Add($line) }
  }
  if ($lines.Count -gt 0) {
    $prefix = if ([string]::IsNullOrEmpty($existing) -or $existing.EndsWith("`n")) { "" } else { "`r`n" }
    [System.IO.File]::AppendAllText($excludePath, ($prefix + ($lines -join "`r`n") + "`r`n"), [System.Text.UTF8Encoding]::new($false))
  }
}

function Get-DinoBrainBlockingDirtyEntries {
  param(
    [Parameter(Mandatory = $true)][string]$Name,
    [Parameter(Mandatory = $true)][string]$RepoPath
  )
  $dirty = Invoke-NativeCommandResult -FilePath "git" -ArgumentList @("-C", $RepoPath, "status", "--porcelain=v1", "--untracked-files=all") -WorkingDirectory $RepoPath
  $entries = @($dirty.Output -split "`n" | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
  if ($Name -ne "dinobrain") { return $entries }
  $managed = @(Get-DinoBrainInstallerLauncherNames)
  return @($entries | Where-Object {
    $line = [string]$_
    $relative = if ($line.Length -gt 3) { $line.Substring(3).Trim().Trim('"') } else { $line.Trim() }
    $managed -notcontains $relative.Replace('/', '\')
  })
}

function Remove-DinoBrainInstallerManagedLaunchersFromStage {
  param([Parameter(Mandatory = $true)][string]$AppPath)
  foreach ($launcherName in Get-DinoBrainInstallerLauncherNames) {
    $launcherPath = Join-Path $AppPath $launcherName
    if (Test-Path -LiteralPath $launcherPath -PathType Leaf) { Remove-Item -LiteralPath $launcherPath -Force }
  }
}

function Resolve-DinoBrainImmutableRef {
  param(
    [Parameter(Mandatory = $true)][string]$Name,
    [Parameter(Mandatory = $true)][string]$RepoUrl,
    [Parameter(Mandatory = $true)][string]$Ref,
    [string]$Token = "",
    [switch]$AllowNoGit
  )

  if (Test-Command "git") {
    $resolver = Join-Path ([System.IO.Path]::GetTempPath()) ("dinobrain-ref-" + [guid]::NewGuid().ToString("N"))
    New-Item -ItemType Directory -Force -Path $resolver | Out-Null
    try {
      Invoke-NativeCommand -FilePath "git" -ArgumentList @("init", "--quiet", $resolver) -WorkingDirectory (Split-Path -Parent $resolver)
      Invoke-NativeCommand -FilePath "git" -ArgumentList @("-C", $resolver, "config", "core.longpaths", "true") -WorkingDirectory $resolver
      Invoke-NativeCommand -FilePath "git" -ArgumentList @("-C", $resolver, "fetch", "--depth=1", $RepoUrl, $Ref) -WorkingDirectory $resolver
      $commit = Get-DinoBrainGitText -TargetDir $resolver -ArgumentList @("rev-parse", "FETCH_HEAD^{commit}")
      if ($commit -notmatch "^[0-9a-fA-F]{40}$") {
        throw "$Name immutable ref did not resolve to a full commit: $commit"
      }
      return [pscustomobject]@{
        name = $Name
        requested_ref = $Ref
        resolved_commit = $commit.ToLowerInvariant()
        resolution = "git_fetch"
        full_equivalence = $true
        resolved_at = [DateTime]::UtcNow.ToString("o")
      }
    } finally {
      Remove-Item -LiteralPath $resolver -Recurse -Force -ErrorAction SilentlyContinue
    }
  }

  if (-not $AllowNoGit) {
    throw "Git is required to resolve immutable refs for $Name."
  }
  $repo = Get-GitHubRepoParts -RepoUrl $RepoUrl
  $headers = @{
    "Accept" = "application/vnd.github+json"
    "User-Agent" = "DinoBrainInstaller"
    "X-GitHub-Api-Version" = "2022-11-28"
  }
  if (-not [string]::IsNullOrWhiteSpace($Token)) { $headers["Authorization"] = "Bearer $Token" }
  $encodedRef = [System.Uri]::EscapeDataString($Ref)
  $response = Invoke-RestMethod -Uri "https://api.github.com/repos/$($repo.Owner)/$($repo.Repo)/commits/$encodedRef" -Headers $headers
  $commit = [string]$response.sha
  if ($commit -notmatch "^[0-9a-fA-F]{40}$") {
    throw "$Name GitHub API ref did not resolve to a full commit."
  }
  return [pscustomobject]@{
    name = $Name
    requested_ref = $Ref
    resolved_commit = $commit.ToLowerInvariant()
    resolution = "github_api_archive"
    full_equivalence = $false
    resolved_at = [DateTime]::UtcNow.ToString("o")
  }
}

function Enter-DinoBrainInstallLock {
  param([Parameter(Mandatory = $true)][string]$InstallRoot)

  $stateRoot = Join-Path (Get-FullPath $InstallRoot) ".dinobrain-installer"
  New-Item -ItemType Directory -Force -Path $stateRoot | Out-Null
  $lockPath = Join-Path $stateRoot "install.lock"
  try {
    return [System.IO.File]::Open($lockPath, [System.IO.FileMode]::OpenOrCreate, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)
  } catch {
    throw "Another DinoBrain installer is active for '$InstallRoot', or its install lock cannot be opened: $lockPath"
  }
}

function Exit-DinoBrainInstallLock {
  param($LockHandle)
  if ($null -ne $LockHandle) { $LockHandle.Dispose() }
}

function ConvertFrom-DinoBrainInstallTransactionRecord {
  param(
    [Parameter(Mandatory = $true)]$Record,
    [Parameter(Mandatory = $true)][string]$TransactionRoot,
    [Parameter(Mandatory = $true)][string]$InstallRoot,
    [Parameter(Mandatory = $true)][string]$ExpectedAppPath,
    [Parameter(Mandatory = $true)][string]$ExpectedDataPath,
    [Parameter(Mandatory = $true)][string[]]$AllowedSnapshotPaths
  )

  if ([string]$Record.version -ne "dinobrain_install_transaction_v1") {
    throw "Unsupported interrupted installer journal version in $TransactionRoot"
  }
  $id = [string]$Record.transaction_id
  if ([string]::IsNullOrWhiteSpace($id) -or (Split-Path -Leaf $TransactionRoot) -ne $id) {
    throw "Interrupted installer journal identity does not match its transaction directory: $TransactionRoot"
  }

  $appPath = Get-FullPath ([string]$Record.app.target_path)
  $dataPath = Get-FullPath ([string]$Record.data.target_path)
  if ($appPath -ne (Get-FullPath $ExpectedAppPath) -or $dataPath -ne (Get-FullPath $ExpectedDataPath)) {
    throw "Interrupted transaction $id targets a different app/data path. Rerun the installer with the original paths before changing InstallRoot arguments."
  }

  $stageAppPath = Get-FullPath ([string]$Record.app.stage_path)
  $stageDataPath = Get-FullPath ([string]$Record.data.stage_path)
  $backupAppPath = Get-FullPath ([string]$Record.app.rollback_path)
  $backupDataPath = Get-FullPath ([string]$Record.data.rollback_path)
  Assert-DinoBrainTransactionalSiblingPath -CandidatePath $stageAppPath -TargetPath $appPath -Kind "stage" | Out-Null
  Assert-DinoBrainTransactionalSiblingPath -CandidatePath $stageDataPath -TargetPath $dataPath -Kind "stage" | Out-Null
  Assert-DinoBrainTransactionalSiblingPath -CandidatePath $backupAppPath -TargetPath $appPath -Kind "rollback" | Out-Null
  Assert-DinoBrainTransactionalSiblingPath -CandidatePath $backupDataPath -TargetPath $dataPath -Kind "rollback" | Out-Null

  $allowedTargets = New-Object 'System.Collections.Generic.HashSet[string]' ([System.StringComparer]::OrdinalIgnoreCase)
  foreach ($path in $AllowedSnapshotPaths) {
    if (-not [string]::IsNullOrWhiteSpace($path)) { [void]$allowedTargets.Add((Get-FullPath $path)) }
  }
  $snapshots = New-Object System.Collections.ArrayList
  foreach ($snapshot in @($Record.snapshots)) {
    $targetPath = Get-FullPath ([string]$snapshot.target_path)
    $snapshotPath = Get-FullPath ([string]$snapshot.snapshot_path)
    if (-not $allowedTargets.Contains($targetPath)) {
      throw "Interrupted transaction $id contains an unexpected snapshot target: $targetPath"
    }
    if (-not (Test-DinoBrainPathUnderRoot -TargetPath $snapshotPath -AllowedRoot $TransactionRoot)) {
      throw "Interrupted transaction $id contains an out-of-root snapshot path: $snapshotPath"
    }
    [void]$snapshots.Add([pscustomobject]@{
      target_path = $targetPath
      snapshot_path = $snapshotPath
      existed = [bool]$snapshot.existed
      is_directory = [bool]$snapshot.is_directory
    })
  }

  return @{
    Id = $id
    Root = (Get-FullPath $TransactionRoot)
    JournalPath = (Join-Path (Get-FullPath $TransactionRoot) "journal.json")
    ResultPath = (Join-Path (Get-FullPath $InstallRoot) "dinobrain-install-result.json")
    AppPath = $appPath
    DataPath = $dataPath
    StageAppPath = $stageAppPath
    StageDataPath = $stageDataPath
    BackupAppPath = $backupAppPath
    BackupDataPath = $backupDataPath
    AppResolution = [pscustomobject]@{
      requested_ref = [string]$Record.app.requested_ref
      resolved_commit = [string]$Record.app.resolved_commit
      resolution = [string]$Record.app.resolution
      full_equivalence = ([string]$Record.app.resolution -eq "git_fetch")
    }
    DataResolution = [pscustomobject]@{
      requested_ref = [string]$Record.data.requested_ref
      resolved_commit = [string]$Record.data.resolved_commit
      resolution = [string]$Record.data.resolution
      full_equivalence = ([string]$Record.data.resolution -eq "git_fetch")
    }
    OriginalAppExists = [bool]$Record.app.original_existed
    OriginalDataExists = [bool]$Record.data.original_existed
    AppPromoted = [bool]$Record.app.promoted
    DataPromoted = [bool]$Record.data.promoted
    Snapshots = $snapshots
    StageVerified = [bool]$Record.stage_verified
    VerificationSkipped = [bool]$Record.verification_skipped
    RecoveredFromInterrupt = $true
    RecoveryQuarantinePaths = (New-Object System.Collections.ArrayList)
    Status = [string]$Record.status
    StartedAt = [string]$Record.started_at
    FinishedAt = $null
    Error = [string]$Record.error
  }
}

function Recover-DinoBrainInterruptedInstallTransactions {
  param(
    [Parameter(Mandatory = $true)][string]$InstallRoot,
    [Parameter(Mandatory = $true)][string]$ExpectedAppPath,
    [Parameter(Mandatory = $true)][string]$ExpectedDataPath,
    [Parameter(Mandatory = $true)][string[]]$AllowedSnapshotPaths
  )

  $transactionsRoot = Join-Path (Get-FullPath $InstallRoot) ".dinobrain-installer\transactions"
  if (-not (Test-Path -LiteralPath $transactionsRoot -PathType Container)) { return }
  foreach ($directory in @(Get-ChildItem -LiteralPath $transactionsRoot -Directory -ErrorAction Stop | Sort-Object Name)) {
    $journalPath = Join-Path $directory.FullName "journal.json"
    if (-not (Test-Path -LiteralPath $journalPath -PathType Leaf)) { continue }
    $record = Get-Content -LiteralPath $journalPath -Raw | ConvertFrom-Json
    if ([string]$record.status -in @("complete", "rolled_back")) { continue }
    Write-Warning "Recovering interrupted DinoBrain install transaction $($record.transaction_id) from status '$($record.status)'."
    $transaction = ConvertFrom-DinoBrainInstallTransactionRecord -Record $record -TransactionRoot $directory.FullName -InstallRoot $InstallRoot -ExpectedAppPath $ExpectedAppPath -ExpectedDataPath $ExpectedDataPath -AllowedSnapshotPaths $AllowedSnapshotPaths
    Rollback-DinoBrainInstallTransaction -Transaction $transaction -ErrorRecord "recovered interrupted transaction from status '$($record.status)'"
  }
}

function New-DinoBrainInstallTransaction {
  param(
    [Parameter(Mandatory = $true)][string]$InstallRoot,
    [Parameter(Mandatory = $true)][string]$AppPath,
    [Parameter(Mandatory = $true)][string]$VaultPath,
    [Parameter(Mandatory = $true)]$AppResolution,
    [Parameter(Mandatory = $true)]$DataResolution
  )

  $id = "install-$([DateTime]::UtcNow.ToString('yyyyMMdd-HHmmssfff'))-$([guid]::NewGuid().ToString('N'))"
  $shortId = [guid]::NewGuid().ToString("N").Substring(0, 12)
  $root = Join-Path (Get-FullPath $InstallRoot) ".dinobrain-installer\transactions\$id"
  New-Item -ItemType Directory -Force -Path $root | Out-Null
  $transaction = @{
    Id = $id
    Root = $root
    JournalPath = (Join-Path $root "journal.json")
    ResultPath = (Join-Path (Get-FullPath $InstallRoot) "dinobrain-install-result.json")
    AppPath = (Get-FullPath $AppPath)
    DataPath = (Get-FullPath $VaultPath)
    StageAppPath = (Join-Path (Split-Path -Parent (Get-FullPath $AppPath)) (".dino-stage-app-$shortId"))
    StageDataPath = (Join-Path (Split-Path -Parent (Get-FullPath $VaultPath)) (".dino-stage-data-$shortId"))
    BackupAppPath = (Join-Path (Split-Path -Parent (Get-FullPath $AppPath)) (".dino-rollback-app-$shortId"))
    BackupDataPath = (Join-Path (Split-Path -Parent (Get-FullPath $VaultPath)) (".dino-rollback-data-$shortId"))
    AppResolution = $AppResolution
    DataResolution = $DataResolution
    OriginalAppExists = (Test-Path -LiteralPath $AppPath)
    OriginalDataExists = (Test-Path -LiteralPath $VaultPath)
    AppPromoted = $false
    DataPromoted = $false
    Snapshots = (New-Object System.Collections.ArrayList)
    StageVerified = $false
    VerificationSkipped = $false
    RecoveredFromInterrupt = $false
    RecoveryQuarantinePaths = (New-Object System.Collections.ArrayList)
    Status = "preparing"
    StartedAt = [DateTime]::UtcNow.ToString("o")
    FinishedAt = $null
    Error = $null
  }
  Update-DinoBrainInstallTransactionJournal -Transaction $transaction
  return $transaction
}

function Get-DinoBrainInstallTransactionRecord {
  param([Parameter(Mandatory = $true)][hashtable]$Transaction)
  return [ordered]@{
    version = "dinobrain_install_transaction_v1"
    transaction_id = $Transaction.Id
    status = $Transaction.Status
    started_at = $Transaction.StartedAt
    finished_at = $Transaction.FinishedAt
    app = [ordered]@{
      requested_ref = $Transaction.AppResolution.requested_ref
      resolved_commit = $Transaction.AppResolution.resolved_commit
      resolution = $Transaction.AppResolution.resolution
      target_path = $Transaction.AppPath
      original_existed = $Transaction.OriginalAppExists
      promoted = $Transaction.AppPromoted
      stage_path = $Transaction.StageAppPath
      rollback_path = $Transaction.BackupAppPath
    }
    data = [ordered]@{
      requested_ref = $Transaction.DataResolution.requested_ref
      resolved_commit = $Transaction.DataResolution.resolved_commit
      resolution = $Transaction.DataResolution.resolution
      target_path = $Transaction.DataPath
      original_existed = $Transaction.OriginalDataExists
      promoted = $Transaction.DataPromoted
      stage_path = $Transaction.StageDataPath
      rollback_path = $Transaction.BackupDataPath
    }
    stage_verified = $Transaction.StageVerified
    verification_skipped = $Transaction.VerificationSkipped
    full_equivalence = ($Transaction.AppResolution.full_equivalence -and $Transaction.DataResolution.full_equivalence -and $Transaction.StageVerified -and -not $Transaction.VerificationSkipped)
    snapshot_count = $Transaction.Snapshots.Count
    snapshots = @($Transaction.Snapshots | ForEach-Object {
      [ordered]@{
        target_path = $_.target_path
        snapshot_path = $_.snapshot_path
        existed = $_.existed
        is_directory = $_.is_directory
      }
    })
    recovered_from_interrupt = $Transaction.RecoveredFromInterrupt
    recovery_quarantine_paths = @($Transaction.RecoveryQuarantinePaths)
    error = $Transaction.Error
  }
}

function Update-DinoBrainInstallTransactionJournal {
  param([Parameter(Mandatory = $true)][hashtable]$Transaction)
  Write-DinoBrainAtomicJson -Path $Transaction.JournalPath -Value (Get-DinoBrainInstallTransactionRecord -Transaction $Transaction)
}

function Write-DinoBrainInstallTransactionResult {
  param([Parameter(Mandatory = $true)][hashtable]$Transaction)
  $record = Get-DinoBrainInstallTransactionRecord -Transaction $Transaction
  Write-DinoBrainAtomicJson -Path $Transaction.ResultPath -Value $record
  Write-Host ("DinoBrain install transaction: " + ($record | ConvertTo-Json -Depth 10 -Compress))
}

function Save-DinoBrainInstallSnapshot {
  param(
    [Parameter(Mandatory = $true)][hashtable]$Transaction,
    [Parameter(Mandatory = $true)][string]$TargetPath,
    [switch]$AllowDirectory
  )

  $target = Get-FullPath $TargetPath
  $exists = Test-Path -LiteralPath $target
  $isDirectory = $exists -and (Test-Path -LiteralPath $target -PathType Container)
  if ($isDirectory -and -not $AllowDirectory) {
    throw "Directory snapshot requires explicit approval: $target"
  }
  if ($isDirectory -and (Split-Path -Leaf $target) -ne "DinoBrainHooks") {
    throw "Refusing to snapshot unexpected installer-managed directory: $target"
  }
  $index = $Transaction.Snapshots.Count
  $snapshot = Join-Path $Transaction.Root "snapshots\$index"
  if ($exists) {
    if ($isDirectory) {
      Copy-DinoBrainDirectoryTree -SourcePath $target -DestinationPath $snapshot
    } else {
      New-Item -ItemType Directory -Force -Path (Split-Path -Parent $snapshot) | Out-Null
      Copy-Item -LiteralPath $target -Destination $snapshot -Force
    }
  }
  [void]$Transaction.Snapshots.Add([pscustomobject]@{
    target_path = $target
    snapshot_path = $snapshot
    existed = $exists
    is_directory = $isDirectory
  })
  Update-DinoBrainInstallTransactionJournal -Transaction $Transaction
}

function Restore-DinoBrainInstallSnapshots {
  param([Parameter(Mandatory = $true)][hashtable]$Transaction)

  $rollbackCurrentRoot = Join-Path $Transaction.Root "rollback-current"
  for ($index = $Transaction.Snapshots.Count - 1; $index -ge 0; $index -= 1) {
    $entry = $Transaction.Snapshots[$index]
    $target = [string]$entry.target_path
    if (Test-Path -LiteralPath $target) {
      $quarantine = Join-Path $rollbackCurrentRoot ([string]$index)
      New-Item -ItemType Directory -Force -Path (Split-Path -Parent $quarantine) | Out-Null
      Move-Item -LiteralPath $target -Destination $quarantine -Force
    }
    if ($entry.existed) {
      New-Item -ItemType Directory -Force -Path (Split-Path -Parent $target) | Out-Null
      if ($entry.is_directory) {
        Copy-DinoBrainDirectoryTree -SourcePath $entry.snapshot_path -DestinationPath $target
      } else {
        Copy-Item -LiteralPath $entry.snapshot_path -Destination $target -Force
      }
    }
  }
}

function New-DinoBrainStagedFileFromCurrent {
  param(
    [Parameter(Mandatory = $true)][string]$CurrentPath,
    [Parameter(Mandatory = $true)][string]$StagedPath
  )

  $current = Get-FullPath $CurrentPath
  $staged = Get-FullPath $StagedPath
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $staged) | Out-Null
  if (Test-Path -LiteralPath $current -PathType Leaf) {
    Copy-Item -LiteralPath $current -Destination $staged -Force
  } elseif (Test-Path -LiteralPath $staged) {
    Remove-Item -LiteralPath $staged -Force
  }
  return $staged
}

function Publish-DinoBrainStagedFile {
  param(
    [Parameter(Mandatory = $true)][string]$StagedPath,
    [Parameter(Mandatory = $true)][string]$TargetPath
  )

  $staged = Get-FullPath $StagedPath
  $target = Get-FullPath $TargetPath
  if (-not (Test-Path -LiteralPath $staged -PathType Leaf)) {
    throw "Staged installer file is missing: $staged"
  }
  $parent = Split-Path -Parent $target
  New-Item -ItemType Directory -Force -Path $parent | Out-Null
  $temp = "$target.$PID.$([guid]::NewGuid().ToString('N')).tmp"
  $backup = "$target.$PID.$([guid]::NewGuid().ToString('N')).replace-backup"
  Copy-Item -LiteralPath $staged -Destination $temp -Force
  try {
    Assert-DinoBrainNoBareCarriageReturnFile -Path $temp
    if (Test-Path -LiteralPath $target) {
      [System.IO.File]::Replace($temp, $target, $backup, $true)
    } else {
      [System.IO.File]::Move($temp, $target)
    }
  } finally {
    Remove-Item -LiteralPath $temp -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $backup -Force -ErrorAction SilentlyContinue
  }
}

function Checkout-DinoBrainResolvedRef {
  param(
    [Parameter(Mandatory = $true)][string]$Name,
    [Parameter(Mandatory = $true)][string]$TargetDir,
    [Parameter(Mandatory = $true)][string]$RequestedRef,
    [Parameter(Mandatory = $true)][string]$ResolvedCommit
  )

  Invoke-NativeCommand -FilePath "git" -ArgumentList @("-C", $TargetDir, "fetch", "origin", "--prune", "--tags") -WorkingDirectory $TargetDir
  $commitCheck = Invoke-NativeCommandResult -FilePath "git" -ArgumentList @("-C", $TargetDir, "cat-file", "-e", "$ResolvedCommit^{commit}") -WorkingDirectory $TargetDir
  if ($commitCheck.ExitCode -ne 0) {
    Invoke-NativeCommand -FilePath "git" -ArgumentList @("-C", $TargetDir, "fetch", "origin", $ResolvedCommit) -WorkingDirectory $TargetDir
  }
  if (Test-DinoBrainRemoteBranch -TargetDir $TargetDir -Ref $RequestedRef) {
    Invoke-NativeCommand -FilePath "git" -ArgumentList @("-C", $TargetDir, "checkout", "-B", $RequestedRef, $ResolvedCommit) -WorkingDirectory $TargetDir
    Invoke-NativeCommand -FilePath "git" -ArgumentList @("-C", $TargetDir, "branch", "--set-upstream-to", "origin/$RequestedRef", $RequestedRef) -WorkingDirectory $TargetDir
  } else {
    Invoke-NativeCommand -FilePath "git" -ArgumentList @("-C", $TargetDir, "checkout", "--detach", $ResolvedCommit) -WorkingDirectory $TargetDir
  }
  $head = Get-DinoBrainGitText -TargetDir $TargetDir -ArgumentList @("rev-parse", "HEAD")
  if ($head -ne $ResolvedCommit) {
    throw "$Name staged HEAD $head does not match resolved commit $ResolvedCommit."
  }
}

function Prepare-DinoBrainRepoStage {
  param(
    [Parameter(Mandatory = $true)][string]$Name,
    [Parameter(Mandatory = $true)][string]$RepoUrl,
    [Parameter(Mandatory = $true)][string]$TargetDir,
    [Parameter(Mandatory = $true)][string]$StageDir,
    [Parameter(Mandatory = $true)][string]$RequestedRef,
    [Parameter(Mandatory = $true)][string]$ResolvedCommit,
    [string]$Token = "",
    [switch]$AllowOriginChange,
    [switch]$AllowNoGit
  )

  Remove-DinoBrainTransactionalSiblingPath -CandidatePath $StageDir -TargetPath $TargetDir -Kind "stage"
  if (-not (Test-Command "git")) {
    if (-not $AllowNoGit) { throw "Git is required to stage $Name." }
    if (Test-Path -LiteralPath $TargetDir) {
      throw "Git is required to update an existing $Name target. The degraded immutable-archive path is fresh-install only: $TargetDir"
    }
    Install-GitHubArchive -Name $Name -RepoUrl $RepoUrl -Ref $ResolvedCommit -TargetDir $StageDir -Token $Token
    return
  }

  if (Test-Path -LiteralPath $TargetDir) {
    if (-not (Test-Path -LiteralPath (Join-Path $TargetDir ".git"))) {
      throw "$Name target exists but is not a git repository: $TargetDir"
    }
    Copy-DinoBrainDirectoryTree -SourcePath $TargetDir -DestinationPath $StageDir
  } else {
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $StageDir) | Out-Null
    Invoke-NativeCommand -FilePath "git" -ArgumentList @("-c", "core.longpaths=true", "clone", $RepoUrl, $StageDir) -WorkingDirectory (Split-Path -Parent $StageDir)
  }

  Invoke-NativeCommand -FilePath "git" -ArgumentList @("-C", $StageDir, "config", "core.longpaths", "true") -WorkingDirectory $StageDir

  $currentOrigin = (& git -C $StageDir remote get-url origin 2>$null)
  if ($LASTEXITCODE -ne 0) { throw "$Name staged repository has no origin remote: $StageDir" }
  if ($currentOrigin -ne $RepoUrl) {
    if ($AllowOriginChange) {
      Invoke-NativeCommand -FilePath "git" -ArgumentList @("-C", $StageDir, "remote", "set-url", "origin", $RepoUrl) -WorkingDirectory $StageDir
    } else {
      throw "$Name origin is '$currentOrigin', expected '$RepoUrl'. Pass -Force to replace the origin URL."
    }
  }
  $head = Get-DinoBrainGitText -TargetDir $StageDir -ArgumentList @("rev-parse", "HEAD")
  if ($head -ne $ResolvedCommit) {
    $blockingDirty = @(Get-DinoBrainBlockingDirtyEntries -Name $Name -RepoPath $StageDir)
    if ($blockingDirty.Count -gt 0) {
      $count = $blockingDirty.Count
      $examples = @($blockingDirty | Select-Object -First 10) -join "; "
      throw "$Name has $count local change(s) and cannot move from HEAD $head to immutable ref $ResolvedCommit without data loss. Blocking entries: $examples. Sync or back up those changes first."
    }
    if ($Name -eq "dinobrain") { Remove-DinoBrainInstallerManagedLaunchersFromStage -AppPath $StageDir }
  }
  Checkout-DinoBrainResolvedRef -Name $Name -TargetDir $StageDir -RequestedRef $RequestedRef -ResolvedCommit $ResolvedCommit
  if ($Name -eq "dinobrain") { Add-DinoBrainInstallerLocalExcludes -AppPath $StageDir }
}

function Move-DinoBrainPathWithRetry {
  param(
    [Parameter(Mandatory = $true)][string]$SourcePath,
    [Parameter(Mandatory = $true)][string]$DestinationPath
  )

  $lastError = $null
  for ($attempt = 1; $attempt -le 60; $attempt += 1) {
    try {
      Move-Item -LiteralPath $SourcePath -Destination $DestinationPath -Force -ErrorAction Stop
      if (-not (Test-Path -LiteralPath $SourcePath) -and (Test-Path -LiteralPath $DestinationPath)) { return }
    } catch {
      $lastError = $_
    }
    if ($attempt -lt 60) { Start-Sleep -Milliseconds 500 }
  }
  $message = if ($null -ne $lastError) { [string]$lastError } else { "source or destination state did not settle" }
  throw "Could not move path after 60 attempts: $SourcePath -> $DestinationPath. $message"
}

function Promote-DinoBrainInstallTransaction {
  param([Parameter(Mandatory = $true)][hashtable]$Transaction)

  $Transaction.Status = "promoting"
  Update-DinoBrainInstallTransactionJournal -Transaction $Transaction
  foreach ($kind in @("App", "Data")) {
    $target = [string]$Transaction["${kind}Path"]
    $stage = [string]$Transaction["Stage${kind}Path"]
    $backup = [string]$Transaction["Backup${kind}Path"]
    Assert-DinoBrainTransactionalSiblingPath -CandidatePath $stage -TargetPath $target -Kind "stage" | Out-Null
    Assert-DinoBrainTransactionalSiblingPath -CandidatePath $backup -TargetPath $target -Kind "rollback" | Out-Null
    if (-not (Test-Path -LiteralPath $stage)) { throw "$kind stage is missing: $stage" }
    if (Test-Path -LiteralPath $backup) { Remove-DinoBrainTransactionalSiblingPath -CandidatePath $backup -TargetPath $target -Kind "rollback" }
    if (Test-Path -LiteralPath $target) { Move-DinoBrainPathWithRetry -SourcePath $target -DestinationPath $backup }
    Move-DinoBrainPathWithRetry -SourcePath $stage -DestinationPath $target
    $Transaction["${kind}Promoted"] = $true
    Update-DinoBrainInstallTransactionJournal -Transaction $Transaction
  }
  $Transaction.Status = "promoted"
  Update-DinoBrainInstallTransactionJournal -Transaction $Transaction
}

function Rollback-DinoBrainInstallTransaction {
  param(
    [Parameter(Mandatory = $true)][hashtable]$Transaction,
    [Parameter(Mandatory = $true)]$ErrorRecord
  )

  $Transaction.Status = "rolling_back"
  $Transaction.Error = [string]$ErrorRecord
  Update-DinoBrainInstallTransactionJournal -Transaction $Transaction
  foreach ($kind in @("Data", "App")) {
    $target = [string]$Transaction["${kind}Path"]
    $stage = [string]$Transaction["Stage${kind}Path"]
    $backup = [string]$Transaction["Backup${kind}Path"]
    $originalExisted = [bool]$Transaction["Original${kind}Exists"]
    $quarantine = Join-Path $Transaction.Root "rollback-current\$($kind.ToLowerInvariant())"
    if (Test-Path -LiteralPath $backup) {
      if (Test-Path -LiteralPath $target) {
        New-Item -ItemType Directory -Force -Path (Split-Path -Parent $quarantine) | Out-Null
        if (Test-Path -LiteralPath $quarantine) { Remove-DinoBrainPathWithRetry -Path $quarantine }
        Move-DinoBrainPathWithRetry -SourcePath $target -DestinationPath $quarantine
        if ($Transaction.RecoveredFromInterrupt) { [void]$Transaction.RecoveryQuarantinePaths.Add($quarantine) }
      }
      Move-DinoBrainPathWithRetry -SourcePath $backup -DestinationPath $target
    } elseif (-not $originalExisted -and (Test-Path -LiteralPath $target)) {
      New-Item -ItemType Directory -Force -Path (Split-Path -Parent $quarantine) | Out-Null
      if (Test-Path -LiteralPath $quarantine) { Remove-DinoBrainPathWithRetry -Path $quarantine }
      Move-DinoBrainPathWithRetry -SourcePath $target -DestinationPath $quarantine
      if ($Transaction.RecoveredFromInterrupt) { [void]$Transaction.RecoveryQuarantinePaths.Add($quarantine) }
    } elseif ($originalExisted -and -not (Test-Path -LiteralPath $target)) {
      throw "Cannot roll back $kind because the original target and rollback copy are both missing: $target"
    }
    if (Test-Path -LiteralPath $stage) {
      Remove-DinoBrainTransactionalSiblingPath -CandidatePath $stage -TargetPath $target -Kind "stage"
    }
    $Transaction["${kind}Promoted"] = $false
  }
  Restore-DinoBrainInstallSnapshots -Transaction $Transaction
  $rollbackCurrentRoot = Join-Path $Transaction.Root "rollback-current"
  if ($Transaction.RecoveredFromInterrupt -and (Test-Path -LiteralPath $rollbackCurrentRoot) -and -not $Transaction.RecoveryQuarantinePaths.Contains($rollbackCurrentRoot)) {
    [void]$Transaction.RecoveryQuarantinePaths.Add($rollbackCurrentRoot)
  }
  $cleanupPaths = @(
    (Join-Path $Transaction.Root "snapshots"),
    (Join-Path $Transaction.Root "verify-config"),
    (Join-Path $Transaction.Root "promotion-config")
  )
  if (-not $Transaction.RecoveredFromInterrupt) { $cleanupPaths += (Join-Path $Transaction.Root "rollback-current") }
  foreach ($internalPath in $cleanupPaths) {
    if ((Test-Path -LiteralPath $internalPath) -and (Test-DinoBrainPathUnderRoot -TargetPath $internalPath -AllowedRoot $Transaction.Root)) {
      Remove-DinoBrainPathWithRetry -Path $internalPath
    }
  }
  $Transaction.Status = "rolled_back"
  $Transaction.FinishedAt = [DateTime]::UtcNow.ToString("o")
  Update-DinoBrainInstallTransactionJournal -Transaction $Transaction
  Write-DinoBrainInstallTransactionResult -Transaction $Transaction
}

function Complete-DinoBrainInstallTransaction {
  param([Parameter(Mandatory = $true)][hashtable]$Transaction)

  foreach ($kind in @("App", "Data")) {
    $target = [string]$Transaction["${kind}Path"]
    $backup = [string]$Transaction["Backup${kind}Path"]
    if (Test-Path -LiteralPath $backup) {
      Remove-DinoBrainTransactionalSiblingPath -CandidatePath $backup -TargetPath $target -Kind "rollback"
    }
  }
  foreach ($internalPath in @(
    (Join-Path $Transaction.Root "snapshots"),
    (Join-Path $Transaction.Root "verify-config"),
    (Join-Path $Transaction.Root "promotion-config"),
    (Join-Path $Transaction.Root "rollback-current")
  )) {
    if ((Test-Path -LiteralPath $internalPath) -and (Test-DinoBrainPathUnderRoot -TargetPath $internalPath -AllowedRoot $Transaction.Root)) {
      Remove-DinoBrainPathWithRetry -Path $internalPath
    }
  }
  $Transaction.Status = "complete"
  $Transaction.FinishedAt = [DateTime]::UtcNow.ToString("o")
  Update-DinoBrainInstallTransactionJournal -Transaction $Transaction
  Write-DinoBrainInstallTransactionResult -Transaction $Transaction
}

function Invoke-DinoBrainInstallFailurePoint {
  param([Parameter(Mandatory = $true)][string]$Name)
  if ($env:DINOBRAIN_INSTALL_TEST_FAILURE_POINT -eq $Name) {
    throw "Injected DinoBrain installer failure at $Name"
  }
}

function Install-PortableNode {
  param(
    [Parameter(Mandatory = $true)][string]$Version,
    [Parameter(Mandatory = $true)][string]$DestinationRoot
  )

  $nodeRoot = Join-Path $DestinationRoot "node-v$Version-win-x64"
  $nodeExe = Join-Path $nodeRoot "node.exe"
  if (Test-Path -LiteralPath $nodeExe) {
    Write-Host "Portable Node already exists: $nodeExe"
    return $nodeRoot
  }

  New-Item -ItemType Directory -Force -Path $DestinationRoot | Out-Null
  $zipName = "node-v$Version-win-x64.zip"
  $zipUrl = "https://nodejs.org/dist/v$Version/$zipName"
  $zipPath = Join-Path ([System.IO.Path]::GetTempPath()) $zipName

  Write-Host "Downloading portable Node: $zipUrl"
  $oldProgress = $ProgressPreference
  $ProgressPreference = "SilentlyContinue"
  try {
    Invoke-WebRequest -Uri $zipUrl -OutFile $zipPath
  } finally {
    $ProgressPreference = $oldProgress
  }

  Expand-DinoBrainZip -ArchivePath $zipPath -DestinationPath $DestinationRoot
  if (-not (Test-Path -LiteralPath $nodeExe)) {
    throw "Portable Node installation failed: $nodeExe"
  }
  return $nodeRoot
}

function Get-DinoBrainVisualCppRuntimeFiles {
  return @(
    "MSVCP140.dll",
    "MSVCP140_1.dll",
    "VCRUNTIME140.dll",
    "VCRUNTIME140_1.dll"
  )
}

function Get-DinoBrainMissingVisualCppRuntimeFiles {
  param([string]$RuntimeRoot = (Join-Path $env:SystemRoot "System32"))

  $missing = @()
  foreach ($fileName in @(Get-DinoBrainVisualCppRuntimeFiles)) {
    if (-not (Test-Path -LiteralPath (Join-Path $RuntimeRoot $fileName) -PathType Leaf)) {
      $missing += $fileName
    }
  }
  return @($missing)
}

function Assert-DinoBrainMicrosoftSignedExecutable {
  param([Parameter(Mandatory = $true)][string]$Path)

  $signature = Get-AuthenticodeSignature -LiteralPath $Path
  $subject = if ($null -ne $signature.SignerCertificate) { [string]$signature.SignerCertificate.Subject } else { "" }
  $versionInfo = (Get-Item -LiteralPath $Path).VersionInfo
  if ($signature.Status -ne [System.Management.Automation.SignatureStatus]::Valid) {
    throw "Downloaded executable does not have a valid Authenticode signature: $Path ($($signature.Status))"
  }
  if ($subject -notmatch "(?:^|,\s*)CN=Microsoft Corporation(?:,|$)" -or
      $subject -notmatch "(?:^|,\s*)O=Microsoft Corporation(?:,|$)") {
    throw "Downloaded executable is not signed by Microsoft Corporation: $subject"
  }
  if ([string]$versionInfo.CompanyName -ne "Microsoft Corporation" -or
      [string]$versionInfo.OriginalFilename -ne "VC_redist.x64.exe" -or
      [string]$versionInfo.ProductName -notmatch "^Microsoft Visual C\+\+ v14 Redistributable \(x64\)") {
    throw "Downloaded Microsoft-signed executable is not the Visual C++ v14 x64 Redistributable."
  }
}

function Install-DinoBrainVisualCppRuntime {
  param(
    [string]$DownloadUri = "https://aka.ms/vc14/vc_redist.x64.exe",
    [string]$RuntimeRoot = (Join-Path $env:SystemRoot "System32")
  )

  $missing = @(Get-DinoBrainMissingVisualCppRuntimeFiles -RuntimeRoot $RuntimeRoot)
  if ($missing.Count -eq 0) {
    Write-Host "Microsoft Visual C++ x64 runtime is ready."
    return
  }
  if ($RuntimeRoot -ne (Join-Path $env:SystemRoot "System32")) {
    throw "Visual C++ runtime installation is only permitted for the Windows System32 runtime root."
  }

  $tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("dinobrain-vc-runtime-" + [guid]::NewGuid().ToString("N"))
  $installerPath = Join-Path $tempRoot "vc_redist.x64.exe"
  $logPath = Join-Path $tempRoot "vc-redist-install.log"
  New-Item -ItemType Directory -Force -Path $tempRoot | Out-Null
  try {
    Write-Host "Installing required Microsoft Visual C++ x64 runtime: $($missing -join ', ')"
    $oldProgress = $ProgressPreference
    $ProgressPreference = "SilentlyContinue"
    try {
      Invoke-WebRequest -UseBasicParsing -Uri $DownloadUri -OutFile $installerPath
    } finally {
      $ProgressPreference = $oldProgress
    }
    Assert-DinoBrainMicrosoftSignedExecutable -Path $installerPath

    $arguments = @("/install", "/quiet", "/norestart", "/log", ('"' + $logPath + '"'))
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($identity)
    $isAdministrator = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
    if ($isAdministrator) {
      $process = Start-Process -FilePath $installerPath -ArgumentList $arguments -Wait -PassThru -WindowStyle Hidden
    } else {
      Write-Host "Windows approval is required once to install the Microsoft Visual C++ runtime."
      $process = Start-Process -FilePath $installerPath -ArgumentList $arguments -Verb RunAs -Wait -PassThru
    }

    if ($process.ExitCode -notin @(0, 1638, 3010)) {
      $tail = if (Test-Path -LiteralPath $logPath) { (Get-Content -LiteralPath $logPath -Tail 30) -join "`n" } else { "installer log unavailable" }
      throw "Microsoft Visual C++ runtime installation failed with exit code $($process.ExitCode).`n$tail"
    }

    $missingAfter = @(Get-DinoBrainMissingVisualCppRuntimeFiles -RuntimeRoot $RuntimeRoot)
    if ($missingAfter.Count -gt 0) {
      throw "Microsoft Visual C++ runtime installation completed but required files are still missing: $($missingAfter -join ', ')"
    }
    Write-Host "Microsoft Visual C++ x64 runtime installed and verified."
  } finally {
    Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
  }
}

function Assert-DinoBrainSemanticNativeRuntime {
  param(
    [Parameter(Mandatory = $true)][string]$NodeRoot,
    [Parameter(Mandatory = $true)][string]$AppPath
  )

  $nodeExe = Join-Path $NodeRoot "node.exe"
  Invoke-NativeCommand -FilePath $nodeExe -ArgumentList @(
    "-e",
    "require('onnxruntime-node'); process.stdout.write('semantic-native-runtime-ok')"
  ) -WorkingDirectory $AppPath
}

function Invoke-WithPortableNode {
  param(
    [Parameter(Mandatory = $true)][string]$NodeRoot,
    [Parameter(Mandatory = $true)][string]$FilePath,
    [Parameter(Mandatory = $true)][string[]]$ArgumentList,
    [Parameter(Mandatory = $true)][string]$WorkingDirectory
  )

  $oldPath = $env:PATH
  $env:PATH = "$NodeRoot;$oldPath"
  try {
    Invoke-NativeCommand -FilePath $FilePath -ArgumentList $ArgumentList -WorkingDirectory $WorkingDirectory
  } finally {
    $env:PATH = $oldPath
  }
}

function ConvertTo-TomlString {
  param([Parameter(Mandatory = $true)][string]$Value)
  if ($Value -notmatch "'") {
    return "'$Value'"
  }
  $escaped = $Value.Replace("\", "\\").Replace('"', '\"')
  return '"' + $escaped + '"'
}

function ConvertTo-Hashtable {
  param([AllowNull()][object]$Value)
  if ($null -eq $Value) { return $null }
  if ($Value -is [string]) { return $Value }
  if ($Value -is [System.Collections.IDictionary]) {
    $result = [ordered]@{}
    foreach ($key in $Value.Keys) {
      $result[$key] = ConvertTo-Hashtable $Value[$key]
    }
    return $result
  }
  if ($Value -is [System.Collections.IEnumerable] -and -not ($Value -is [string])) {
    return @($Value | ForEach-Object { ConvertTo-Hashtable $_ })
  }
  if ($Value.GetType().Name -eq "PSCustomObject") {
    $properties = @($Value.PSObject.Properties)
    $result = [ordered]@{}
    foreach ($property in $properties) {
      $result[$property.Name] = ConvertTo-Hashtable $property.Value
    }
    return $result
  }
  return $Value
}

function ConvertTo-PowerShellSingleQuotedString {
  param([Parameter(Mandatory = $true)][string]$Value)
  return "'" + $Value.Replace("'", "''") + "'"
}

function ConvertTo-DinoBrainCrLfText {
  param([AllowEmptyString()][AllowNull()][string]$Text)
  if ($null -eq $Text) { return "" }
  $normalized = $Text.Replace("`r`n", "`n").Replace("`r", "`n")
  return $normalized.Replace("`n", "`r`n")
}

function Assert-DinoBrainNoBareCarriageReturn {
  param(
    [Parameter(Mandatory = $true)][string]$Text,
    [Parameter(Mandatory = $true)][string]$Label
  )

  $match = [regex]::Match($Text, "`r(?!`n)")
  if ($match.Success) {
    throw "$Label contains a carriage return that is not followed by a newline at character offset $($match.Index)."
  }
}

function Assert-DinoBrainNoBareCarriageReturnFile {
  param([Parameter(Mandatory = $true)][string]$Path)

  $bytes = [System.IO.File]::ReadAllBytes($Path)
  for ($i = 0; $i -lt $bytes.Length; $i++) {
    if ($bytes[$i] -eq 13) {
      if ($i + 1 -ge $bytes.Length -or $bytes[$i + 1] -ne 10) {
        throw "Codex config contains a bare carriage return byte at offset $i`: $Path"
      }
    }
  }
}

function Assert-DinoBrainCodexConfigTomlShape {
  param(
    [Parameter(Mandatory = $true)][string]$Text,
    [Parameter(Mandatory = $true)][string]$ConfigPath
  )

  Assert-DinoBrainNoBareCarriageReturn -Text $Text -Label $ConfigPath
  $normalized = ConvertTo-DinoBrainCrLfText $Text
  $requiredPatterns = @(
    "(?m)^\[mcp_servers\.dinobrain\]\r?$",
    "(?m)^args\s*=\s*\[.+\]\r?$",
    "(?m)^command\s*=\s*(['""]).+\1\r?$",
    "(?m)^startup_timeout_sec\s*=\s*120\r?$",
    "(?m)^\[mcp_servers\.dinobrain\.env\]\r?$",
    "(?m)^DINOBRAIN_DATA_DIR\s*=\s*(['""]).+\1\r?$",
    "(?m)^DINOBRAIN_AUTO_GROWTH\s*=\s*(['""])0\1\r?$",
    "(?m)^DINOBRAIN_AUTO_COMPOUND\s*=\s*(['""])0\1\r?$",
    "(?m)^DINOBRAIN_AUTO_SYNC\s*=\s*(['""])0\1\r?$",
    "(?m)^DINOBRAIN_AUTO_SYNC_ALLOW_CONDITIONAL\s*=\s*(['""])0\1\r?$",
    "(?m)^DINOBRAIN_AUTO_SYNC_PUSH\s*=\s*(['""])0\1\r?$"
  )
  foreach ($pattern in $requiredPatterns) {
    if ($normalized -notmatch $pattern) {
      throw "Codex config TOML validation failed for DinoBrain block. Missing or malformed pattern: $pattern"
    }
  }
}

function Remove-TomlSection {
  param(
    [AllowEmptyString()][string]$Text,
    [Parameter(Mandatory = $true)][string]$SectionName
  )
  $escaped = [regex]::Escape($SectionName)
  $pattern = "(?ms)^\[$escaped\]\r?\n.*?(?=^\[|\z)"
  return [regex]::Replace($Text, $pattern, "").TrimEnd()
}

function Set-TomlSectionKey {
  param(
    [AllowEmptyString()][string]$Text,
    [Parameter(Mandatory = $true)][string]$SectionName,
    [Parameter(Mandatory = $true)][string]$KeyName,
    [Parameter(Mandatory = $true)][string]$Value
  )

  if ($null -eq $Text) { $Text = "" }
  $line = "$KeyName = $Value"
  $escapedSection = [regex]::Escape($SectionName)
  $sectionPattern = "(?ms)^(?<header>\[$escapedSection\]\r?\n)(?<body>.*?)(?=^\[|\z)"
  $sectionMatch = [regex]::Match($Text, $sectionPattern)
  if ($sectionMatch.Success) {
    $bodyGroup = $sectionMatch.Groups["body"]
    $body = $bodyGroup.Value
    $escapedKey = [regex]::Escape($KeyName)
    $keyPattern = [regex]"(?m)^\s*$escapedKey\s*=.*$"
    if ($keyPattern.IsMatch($body)) {
      $newBody = $keyPattern.Replace($body, $line, 1)
    } else {
      $newBody = $body
      if ($newBody.Length -gt 0 -and -not $newBody.EndsWith("`n")) {
        $newBody += "`r`n"
      }
      $newBody += "$line`r`n"
    }
    return $Text.Substring(0, $bodyGroup.Index) + $newBody + $Text.Substring($bodyGroup.Index + $bodyGroup.Length)
  }

  $prefix = ""
  if (-not [string]::IsNullOrWhiteSpace($Text)) {
    $prefix = $Text.TrimEnd() + "`r`n`r`n"
  }
  return $prefix + "[$SectionName]`r`n$line`r`n"
}

function Enable-DinoBrainCodexHookFeature {
  param([AllowEmptyString()][string]$Text)

  if ($Text -match "(?mi)^\s*allow_managed_hooks_only\s*=\s*true\s*$") {
    Write-Warning "Codex config contains allow_managed_hooks_only=true. User hooks may be skipped until that managed-only policy is removed."
  }
  return Set-TomlSectionKey -Text $Text -SectionName "features" -KeyName "hooks" -Value "true"
}

function Set-DinoBrainCodexConfig {
  param(
    [Parameter(Mandatory = $true)][string]$ConfigPath,
    [Parameter(Mandatory = $true)][string]$NodeExe,
    [Parameter(Mandatory = $true)][string]$ServerEntry,
    [Parameter(Mandatory = $true)][string]$VaultPath,
    [switch]$EnableHooks
  )

  $configDir = Split-Path -Parent $ConfigPath
  New-Item -ItemType Directory -Force -Path $configDir | Out-Null

  $content = ""
  $backupPath = $null
  if (Test-Path -LiteralPath $ConfigPath) {
    $content = ConvertTo-DinoBrainCrLfText ([System.IO.File]::ReadAllText($ConfigPath))
    $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
    $backupPath = "$ConfigPath.bak-dinobrain-$stamp"
    Copy-Item -LiteralPath $ConfigPath -Destination $backupPath
  }

  $content = Remove-TomlSection -Text $content -SectionName "mcp_servers.dinobrain"
  $content = Remove-TomlSection -Text $content -SectionName "mcp_servers.dinobrain.env"
  if ($EnableHooks) {
    $content = Enable-DinoBrainCodexHookFeature -Text $content
  }
  if (-not [string]::IsNullOrWhiteSpace($content)) {
    $content = $content.TrimEnd() + "`r`n`r`n"
  }

  $block = @(
    "[mcp_servers.dinobrain]",
    "args = [$(ConvertTo-TomlString $ServerEntry)]",
    "command = $(ConvertTo-TomlString $NodeExe)",
    "startup_timeout_sec = 120",
    "",
    "[mcp_servers.dinobrain.env]",
    "DINOBRAIN_DATA_DIR = $(ConvertTo-TomlString $VaultPath)",
    "DINOBRAIN_AUTO_GROWTH = `"0`"",
    "DINOBRAIN_AUTO_COMPOUND = `"0`"",
    "DINOBRAIN_AUTO_SYNC = `"0`"",
    "DINOBRAIN_AUTO_SYNC_ALLOW_CONDITIONAL = `"0`"",
    "DINOBRAIN_AUTO_SYNC_PUSH = `"0`"",
    ""
  ) -join "`r`n"

  $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
  $finalContent = ConvertTo-DinoBrainCrLfText ($content + $block)
  Assert-DinoBrainCodexConfigTomlShape -Text $finalContent -ConfigPath $ConfigPath
  [System.IO.File]::WriteAllText($ConfigPath, $finalContent, $utf8NoBom)
  Assert-DinoBrainNoBareCarriageReturnFile -Path $ConfigPath
  Assert-DinoBrainCodexConfigTomlShape -Text ([System.IO.File]::ReadAllText($ConfigPath)) -ConfigPath $ConfigPath
  if ($backupPath) {
    Write-Host "Codex config backup: $backupPath"
  }
  Write-Host "Codex MCP registered: $ConfigPath"
}

function New-DinoBrainCodexHookCommand {
  param(
    [Parameter(Mandatory = $true)][string]$AppPath,
    [Parameter(Mandatory = $true)][string]$VaultPath
  )

  $hookScript = Join-Path $AppPath "scripts\dinobrain-user-prompt-hook.ps1"
  $hookLiteral = ConvertTo-PowerShellSingleQuotedString $hookScript
  $vaultLiteral = ConvertTo-PowerShellSingleQuotedString $VaultPath
  return "powershell.exe -NoProfile -ExecutionPolicy Bypass -Command `"& { `$env:DINOBRAIN_DATA_DIR = $vaultLiteral; `$env:DINOBRAIN_AUTO_GROWTH = '0'; `$env:DINOBRAIN_AUTO_COMPOUND = '0'; `$env:DINOBRAIN_AUTO_SYNC = '0'; `$env:DINOBRAIN_AUTO_SYNC_ALLOW_CONDITIONAL = '0'; `$env:DINOBRAIN_AUTO_SYNC_PUSH = '0'; `$env:DINOBRAIN_HOOK_AUTO_SYNC = '0'; `$env:DINOBRAIN_HOOK_IMPORT_SESSION = '0'; `$env:DINOBRAIN_HOOK_CONTEXT_LIMIT = '3'; `$env:DINOBRAIN_HOOK_LEASE_SECONDS = '3600'; `$env:DINOBRAIN_HOOK_SOFT_TIMEOUT_MS = '6000'; `$env:DINOBRAIN_HOOK_TIMEOUT_SECONDS = '8'; & $hookLiteral }`""
}

function Test-DinoBrainHookGroup {
  param([AllowNull()][object]$Group)
  if ($null -eq $Group) { return $false }
  $text = ($Group | ConvertTo-Json -Depth 20 -Compress)
  return $text -match "dinobrain-user-prompt-hook\.ps1" -or $text -match "Loading DinoBrain context"
}

function Test-DinoBrainHookRecord {
  param([AllowNull()][object]$Hook)
  if ($null -eq $Hook) { return $false }
  $text = ($Hook | ConvertTo-Json -Depth 20 -Compress)
  return $text -match "dinobrain-user-prompt-hook\.ps1" -or $text -match "Loading DinoBrain context"
}

function Get-UserPromptSubmitGroupsWithoutDinoBrain {
  param([AllowNull()][object]$Groups)

  $result = @()
  foreach ($group in @($Groups)) {
    if ($null -eq $group) { continue }
    $groupTable = ConvertTo-Hashtable $group
    if (-not ($groupTable -is [System.Collections.IDictionary])) { continue }

    $keptHooks = @()
    if ($groupTable.Contains("hooks") -and $null -ne $groupTable["hooks"]) {
      foreach ($hook in @($groupTable["hooks"])) {
        if (-not (Test-DinoBrainHookRecord $hook)) {
          $keptHooks += (ConvertTo-Hashtable $hook)
        }
      }
    }

    if ($keptHooks.Count -gt 0) {
      $groupTable["hooks"] = @($keptHooks)
      $result += $groupTable
    }
  }

  return @($result)
}

function Remove-DinoBrainCodexUserHookRecords {
  param([Parameter(Mandatory = $true)][string]$HooksPath)

  if (-not (Test-Path -LiteralPath $HooksPath)) { return $false }
  $raw = [System.IO.File]::ReadAllText($HooksPath)
  if ([string]::IsNullOrWhiteSpace($raw)) { return $false }
  $config = ConvertTo-Hashtable ($raw | ConvertFrom-Json)
  if (-not ($config -is [System.Collections.IDictionary]) -or -not $config.Contains("hooks")) { return $false }
  $hooks = $config["hooks"]
  if (-not ($hooks -is [System.Collections.IDictionary]) -or -not $hooks.Contains("UserPromptSubmit")) { return $false }

  $originalGroups = @($hooks["UserPromptSubmit"])
  if (-not (@($originalGroups | Where-Object { Test-DinoBrainHookGroup $_ }).Count -gt 0)) { return $false }
  $remainingGroups = @(Get-UserPromptSubmitGroupsWithoutDinoBrain -Groups $originalGroups)
  if ($remainingGroups.Count -gt 0) {
    $hooks["UserPromptSubmit"] = $remainingGroups
  } else {
    $hooks.Remove("UserPromptSubmit")
  }

  $backupPath = "$HooksPath.bak-dinobrain-managed-only-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
  Copy-Item -LiteralPath $HooksPath -Destination $backupPath -Force
  $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($HooksPath, (($config | ConvertTo-Json -Depth 40) + "`r`n"), $utf8NoBom)
  Write-Host "Removed duplicate DinoBrain user hook; managed hook is authoritative: $HooksPath"
  Write-Host "Codex user hooks backup: $backupPath"
  return $true
}

function Add-HookToFirstUserPromptSubmitGroup {
  param(
    [AllowNull()][object[]]$Groups,
    [Parameter(Mandatory = $true)][object]$HookRecord,
    [Parameter(Mandatory = $true)][object]$FallbackGroup
  )

  $normalized = New-Object System.Collections.ArrayList
  foreach ($group in @($Groups)) {
    if ($null -ne $group) {
      $normalized.Add((ConvertTo-Hashtable $group)) | Out-Null
    }
  }

  if ($normalized.Count -gt 0) {
    $first = ConvertTo-Hashtable $normalized[0]
    $existingHooks = @()
    if ($first.Contains("hooks") -and $null -ne $first["hooks"]) {
      $existingHooks = @($first["hooks"])
    }
    $first["hooks"] = @($existingHooks + $HookRecord)
    $normalized[0] = $first
    return @($normalized.ToArray())
  }

  return @($FallbackGroup)
}

function Set-DinoBrainCodexUserHook {
  param(
    [Parameter(Mandatory = $true)][string]$HooksPath,
    [Parameter(Mandatory = $true)][string]$AppPath,
    [Parameter(Mandatory = $true)][string]$VaultPath
  )

  $hooksDir = Split-Path -Parent $HooksPath
  New-Item -ItemType Directory -Force -Path $hooksDir | Out-Null

  $config = [ordered]@{}
  $backupPath = $null
  if (Test-Path -LiteralPath $HooksPath) {
    $raw = [System.IO.File]::ReadAllText($HooksPath)
    if (-not [string]::IsNullOrWhiteSpace($raw)) {
      $config = ConvertTo-Hashtable ($raw | ConvertFrom-Json)
    }
    $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
    $backupPath = "$HooksPath.bak-dinobrain-$stamp"
    Copy-Item -LiteralPath $HooksPath -Destination $backupPath
  }

  if (-not $config.Contains("hooks") -or $null -eq $config["hooks"]) {
    $config["hooks"] = [ordered]@{}
  }
  if (-not ($config["hooks"] -is [System.Collections.IDictionary])) {
    throw "Codex hooks file has an invalid 'hooks' shape: $HooksPath"
  }

  $groups = @()
  if ($config["hooks"].Contains("UserPromptSubmit") -and $null -ne $config["hooks"]["UserPromptSubmit"]) {
    $groups = Get-UserPromptSubmitGroupsWithoutDinoBrain -Groups $config["hooks"]["UserPromptSubmit"]
  }

  $command = New-DinoBrainCodexHookCommand -AppPath $AppPath -VaultPath $VaultPath
  $hookRecord = [ordered]@{
    type = "command"
    command = $command
    commandWindows = $command
    timeout = 12
    statusMessage = "Loading DinoBrain context"
  }
  $fallbackGroup = [ordered]@{ hooks = @($hookRecord) }
  $groups = Add-HookToFirstUserPromptSubmitGroup -Groups $groups -HookRecord $hookRecord -FallbackGroup $fallbackGroup
  $config["hooks"]["UserPromptSubmit"] = @($groups)

  $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($HooksPath, ($config | ConvertTo-Json -Depth 40) + "`r`n", $utf8NoBom)
  if ($backupPath) {
    Write-Host "Codex user hooks backup: $backupPath"
  }
  Write-Host "Codex user hook registered: $HooksPath"
}

function Set-DinoBrainClaudeUserHook {
  param(
    [Parameter(Mandatory = $true)][string]$SettingsPath,
    [Parameter(Mandatory = $true)][string]$AppPath,
    [Parameter(Mandatory = $true)][string]$VaultPath
  )

  $settingsDir = Split-Path -Parent $SettingsPath
  New-Item -ItemType Directory -Force -Path $settingsDir | Out-Null

  $config = [ordered]@{}
  $backupPath = $null
  if (Test-Path -LiteralPath $SettingsPath) {
    $raw = [System.IO.File]::ReadAllText($SettingsPath)
    if (-not [string]::IsNullOrWhiteSpace($raw)) {
      $config = ConvertTo-Hashtable ($raw | ConvertFrom-Json)
    }
    $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
    $backupPath = "$SettingsPath.bak-dinobrain-$stamp"
    Copy-Item -LiteralPath $SettingsPath -Destination $backupPath
  }

  if (-not $config.Contains("hooks") -or $null -eq $config["hooks"]) {
    $config["hooks"] = [ordered]@{}
  }
  if (-not ($config["hooks"] -is [System.Collections.IDictionary])) {
    throw "Claude Code settings file has an invalid 'hooks' shape: $SettingsPath"
  }

  $groups = @()
  if ($config["hooks"].Contains("UserPromptSubmit") -and $null -ne $config["hooks"]["UserPromptSubmit"]) {
    $groups = Get-UserPromptSubmitGroupsWithoutDinoBrain -Groups $config["hooks"]["UserPromptSubmit"]
  }

  $command = New-DinoBrainCodexHookCommand -AppPath $AppPath -VaultPath $VaultPath
  $hookRecord = [ordered]@{
    type = "command"
    command = $command
    timeout = 12
  }
  $fallbackGroup = [ordered]@{
    matcher = ""
    hooks = @($hookRecord)
  }
  $groups = Add-HookToFirstUserPromptSubmitGroup -Groups $groups -HookRecord $hookRecord -FallbackGroup $fallbackGroup
  $config["hooks"]["UserPromptSubmit"] = @($groups)

  $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($SettingsPath, ($config | ConvertTo-Json -Depth 40) + "`r`n", $utf8NoBom)
  if ($backupPath) {
    Write-Host "Claude Code settings backup: $backupPath"
  }
  Write-Host "Claude Code UserPromptSubmit hook registered: $SettingsPath"
}

function ConvertTo-NativeQuotedArgument {
  param([Parameter(Mandatory = $true)][string]$Value)
  return '"' + ($Value -replace '"', '\"') + '"'
}

function Invoke-DinoBrainCodexHookHandshake {
  param(
    [Parameter(Mandatory = $true)][string]$AppPath,
    [Parameter(Mandatory = $true)][string]$VaultPath,
    [Parameter(Mandatory = $true)][string]$NodeExe
  )

  $hookScript = Join-Path $AppPath "scripts\dinobrain-user-prompt-hook.ps1"
  if (-not (Test-Path -LiteralPath $hookScript)) {
    throw "Codex user hook script not found for handshake: $hookScript"
  }

  $payload = [ordered]@{
    hookEventName = "UserPromptSubmit"
    prompt = "DinoBrain installer hook handshake. Confirm the user-level Codex hook can run DinoBrain preflight without a manual first hook."
    cwd = $AppPath
  } | ConvertTo-Json -Depth 8 -Compress

  $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
  $processInfo = New-Object System.Diagnostics.ProcessStartInfo
  $processInfo.FileName = "powershell.exe"
  $processInfo.Arguments = "-NoProfile -ExecutionPolicy Bypass -File " + (ConvertTo-NativeQuotedArgument $hookScript)
  $processInfo.WorkingDirectory = $AppPath
  $processInfo.UseShellExecute = $false
  $processInfo.RedirectStandardInput = $true
  $processInfo.RedirectStandardOutput = $true
  $processInfo.RedirectStandardError = $true
  $processInfo.CreateNoWindow = $true
  try { $processInfo.StandardInputEncoding = $utf8NoBom } catch {}
  try { $processInfo.StandardOutputEncoding = $utf8NoBom } catch {}
  try { $processInfo.StandardErrorEncoding = $utf8NoBom } catch {}

  Write-Host ">> powershell.exe -NoProfile -ExecutionPolicy Bypass -File $hookScript"
  $oldData = $env:DINOBRAIN_DATA_DIR
  $oldNode = $env:DINOBRAIN_NODE_EXE
  $oldProject = $env:DINOBRAIN_HOOK_PROJECT
  $oldImport = $env:DINOBRAIN_HOOK_IMPORT_SESSION
  $oldLimit = $env:DINOBRAIN_HOOK_CONTEXT_LIMIT
  $oldLaunchKind = $env:DINOBRAIN_HOOK_LAUNCH_KIND
  $env:DINOBRAIN_DATA_DIR = $VaultPath
  $env:DINOBRAIN_NODE_EXE = $NodeExe
  $env:DINOBRAIN_HOOK_PROJECT = "dinobrain-installer"
  $env:DINOBRAIN_HOOK_IMPORT_SESSION = "0"
  $env:DINOBRAIN_HOOK_CONTEXT_LIMIT = "3"
  $env:DINOBRAIN_HOOK_LAUNCH_KIND = "installer_handshake"
  try {
    $process = [System.Diagnostics.Process]::Start($processInfo)
    $process.StandardInput.Write($payload)
    $process.StandardInput.Close()
    $stdout = $process.StandardOutput.ReadToEnd()
    $stderr = $process.StandardError.ReadToEnd()
    $process.WaitForExit()
  } finally {
    if ($null -eq $oldData) { Remove-Item Env:\DINOBRAIN_DATA_DIR -ErrorAction SilentlyContinue } else { $env:DINOBRAIN_DATA_DIR = $oldData }
    if ($null -eq $oldNode) { Remove-Item Env:\DINOBRAIN_NODE_EXE -ErrorAction SilentlyContinue } else { $env:DINOBRAIN_NODE_EXE = $oldNode }
    if ($null -eq $oldProject) { Remove-Item Env:\DINOBRAIN_HOOK_PROJECT -ErrorAction SilentlyContinue } else { $env:DINOBRAIN_HOOK_PROJECT = $oldProject }
    if ($null -eq $oldImport) { Remove-Item Env:\DINOBRAIN_HOOK_IMPORT_SESSION -ErrorAction SilentlyContinue } else { $env:DINOBRAIN_HOOK_IMPORT_SESSION = $oldImport }
    if ($null -eq $oldLimit) { Remove-Item Env:\DINOBRAIN_HOOK_CONTEXT_LIMIT -ErrorAction SilentlyContinue } else { $env:DINOBRAIN_HOOK_CONTEXT_LIMIT = $oldLimit }
    if ($null -eq $oldLaunchKind) { Remove-Item Env:\DINOBRAIN_HOOK_LAUNCH_KIND -ErrorAction SilentlyContinue } else { $env:DINOBRAIN_HOOK_LAUNCH_KIND = $oldLaunchKind }
  }

  if ($process.ExitCode -ne 0) {
    throw "Codex user hook handshake failed with exit code $($process.ExitCode): $stderr"
  }
  if ([string]::IsNullOrWhiteSpace($stdout)) {
    throw "Codex user hook handshake produced no output."
  }

  try {
    $hookOutput = $stdout | ConvertFrom-Json
  } catch {
    throw "Codex user hook handshake returned invalid JSON: $($_.Exception.Message)"
  }

  $additionalContext = [string]$hookOutput.hookSpecificOutput.additionalContext
  if ($hookOutput.hookSpecificOutput.hookEventName -ne "UserPromptSubmit" -or $additionalContext -notmatch "DinoBrain OS preflight completed") {
    throw "Codex user hook handshake did not complete DinoBrain preflight: $additionalContext"
  }

  if (-not [string]::IsNullOrWhiteSpace($stderr)) {
    Write-Warning "Codex user hook handshake stderr: $stderr"
  }
  Write-Host "Codex user hook handshake verified."
}

function New-DinoBrainObservatoryLauncher {
  param(
    [Parameter(Mandatory = $true)][string]$InstallRoot,
    [Parameter(Mandatory = $true)][string]$AppPath,
    [Parameter(Mandatory = $true)][string]$VaultPath,
    [Parameter(Mandatory = $true)][string]$NodeRoot
  )

  $launcherScript = Join-Path $AppPath "scripts\start-dinobrain-observatory.ps1"
  if (-not (Test-Path -LiteralPath $launcherScript)) {
    Write-Warning "Observatory launcher script not found: $launcherScript"
    return @()
  }

  $launcherPaths = @(
    (Join-Path $InstallRoot "DinoBrain Observatory.cmd"),
    (Join-Path $AppPath "DinoBrain Observatory.cmd")
  )
  $content = @"
@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$launcherScript" -DataDir "$VaultPath" -NodeRoot "$NodeRoot"
if errorlevel 1 pause
"@

  $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
  foreach ($launcherPath in $launcherPaths) {
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $launcherPath) | Out-Null
    [System.IO.File]::WriteAllText($launcherPath, $content, $utf8NoBom)
    Write-Host "Observatory launcher created: $launcherPath"
  }
  return $launcherPaths
}

function New-DinoBrainHookDiagnoseLauncher {
  param(
    [Parameter(Mandatory = $true)][string]$InstallRoot,
    [Parameter(Mandatory = $true)][string]$AppPath,
    [Parameter(Mandatory = $true)][string]$VaultPath,
    [Parameter(Mandatory = $true)][string]$NodeRoot,
    [Parameter(Mandatory = $true)][string]$ConfigPath,
    [Parameter(Mandatory = $true)][string]$HooksPath,
    [Parameter(Mandatory = $true)][string]$RequirementsPath
  )

  $diagnoseScript = Join-Path $AppPath "scripts\diagnose-codex-hook.ps1"
  if (-not (Test-Path -LiteralPath $diagnoseScript)) {
    Write-Warning "Hook diagnose script not found: $diagnoseScript"
    return @()
  }

  $nodeExe = Join-Path $NodeRoot "node.exe"
  $launcherPaths = @(
    (Join-Path $InstallRoot "DinoBrain Hook Diagnose.cmd"),
    (Join-Path $AppPath "DinoBrain Hook Diagnose.cmd")
  )
  $content = @"
@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$diagnoseScript" -AppPath "$AppPath" -VaultPath "$VaultPath" -HooksPath "$HooksPath" -ConfigPath "$ConfigPath" -RequirementsPath "$RequirementsPath" -NodeExe "$nodeExe"
pause
"@

  $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
  foreach ($launcherPath in $launcherPaths) {
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $launcherPath) | Out-Null
    [System.IO.File]::WriteAllText($launcherPath, $content, $utf8NoBom)
    Write-Host "Hook diagnose launcher created: $launcherPath"
  }
  return $launcherPaths
}

function New-DinoBrainHookApprovalLauncher {
  param(
    [Parameter(Mandatory = $true)][string]$InstallRoot,
    [Parameter(Mandatory = $true)][string]$AppPath,
    [Parameter(Mandatory = $true)][string]$ConfigPath,
    [Parameter(Mandatory = $true)][string]$HooksPath,
    [Parameter(Mandatory = $true)][string]$RequirementsPath
  )

  $approvalScript = Join-Path $AppPath "scripts\start-codex-hook-approval.ps1"
  if (-not (Test-Path -LiteralPath $approvalScript)) {
    Write-Warning "Hook approval script not found: $approvalScript"
    return @()
  }

  $launcherPaths = @(
    (Join-Path $InstallRoot "DinoBrain Codex Hook Approval.cmd"),
    (Join-Path $AppPath "DinoBrain Codex Hook Approval.cmd")
  )
  $content = @"
@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -NoExit -File "$approvalScript" -AppPath "$AppPath" -HooksPath "$HooksPath" -ConfigPath "$ConfigPath" -RequirementsPath "$RequirementsPath" -RestartStaleCodex -RestartStaleMcp
"@

  $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
  foreach ($launcherPath in $launcherPaths) {
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $launcherPath) | Out-Null
    [System.IO.File]::WriteAllText($launcherPath, $content, $utf8NoBom)
    Write-Host "Hook approval launcher created: $launcherPath"
  }
  return $launcherPaths
}

function New-DinoBrainLiveProofLauncher {
  param(
    [Parameter(Mandatory = $true)][string]$InstallRoot,
    [Parameter(Mandatory = $true)][string]$AppPath,
    [Parameter(Mandatory = $true)][string]$VaultPath,
    [Parameter(Mandatory = $true)][string]$NodeRoot,
    [Parameter(Mandatory = $true)][string]$ConfigPath,
    [Parameter(Mandatory = $true)][string]$HooksPath,
    [Parameter(Mandatory = $true)][string]$RequirementsPath
  )

  $proofScript = Join-Path $AppPath "scripts\start-codex-live-proof.ps1"
  if (-not (Test-Path -LiteralPath $proofScript)) {
    Write-Warning "Live proof script not found: $proofScript"
    return @()
  }

  $nodeExe = Join-Path $NodeRoot "node.exe"
  $launcherPaths = @(
    (Join-Path $InstallRoot "DinoBrain Codex Live Proof.cmd"),
    (Join-Path $AppPath "DinoBrain Codex Live Proof.cmd")
  )
  $content = @"
@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -NoExit -File "$proofScript" -AppPath "$AppPath" -VaultPath "$VaultPath" -HooksPath "$HooksPath" -ConfigPath "$ConfigPath" -RequirementsPath "$RequirementsPath" -NodeExe "$nodeExe"
"@

  $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
  foreach ($launcherPath in $launcherPaths) {
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $launcherPath) | Out-Null
    [System.IO.File]::WriteAllText($launcherPath, $content, $utf8NoBom)
    Write-Host "Codex live proof launcher created: $launcherPath"
  }
  return $launcherPaths
}

function New-DinoBrainDirectMcpProofLauncher {
  param(
    [Parameter(Mandatory = $true)][string]$InstallRoot,
    [Parameter(Mandatory = $true)][string]$AppPath,
    [Parameter(Mandatory = $true)][string]$VaultPath,
    [Parameter(Mandatory = $true)][string]$NodeRoot
  )

  $proofScript = Join-Path $AppPath "scripts\start-client-mcp-proof.ps1"
  if (-not (Test-Path -LiteralPath $proofScript)) {
    Write-Warning "Direct MCP proof script not found: $proofScript"
    return @()
  }

  $nodeExe = Join-Path $NodeRoot "node.exe"
  $launcherPaths = @()
  foreach ($agent in @("codex", "claude")) {
    $displayName = if ($agent -eq "codex") { "Codex" } else { "Claude" }
    $content = @"
@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -NoExit -File "$proofScript" -Agent $agent -AppPath "$AppPath" -VaultPath "$VaultPath" -NodeExe "$nodeExe"
"@
    foreach ($basePath in @($InstallRoot, $AppPath)) {
      $launcherPath = Join-Path $basePath ("DinoBrain {0} MCP Proof.cmd" -f $displayName)
      New-Item -ItemType Directory -Force -Path (Split-Path -Parent $launcherPath) | Out-Null
      $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
      [System.IO.File]::WriteAllText($launcherPath, $content, $utf8NoBom)
      Write-Host "$displayName direct MCP proof launcher created: $launcherPath"
      $launcherPaths += $launcherPath
    }
  }
  return $launcherPaths
}

function New-DinoBrainCleanMachineProofLauncher {
  param(
    [Parameter(Mandatory = $true)][string]$InstallRoot,
    [Parameter(Mandatory = $true)][string]$AppPath,
    [Parameter(Mandatory = $true)][string]$VaultPath,
    [Parameter(Mandatory = $true)][string]$NodeRoot
  )

  $proofScript = Join-Path $AppPath "scripts\start-clean-machine-equivalence-proof.ps1"
  if (-not (Test-Path -LiteralPath $proofScript)) {
    Write-Warning "Recovery-equivalence proof script not found: $proofScript"
    return @()
  }

  $nodeExe = Join-Path $NodeRoot "node.exe"
  $installResultPath = Join-Path $InstallRoot "dinobrain-install-result.json"
  $launcherPaths = @(
    (Join-Path $InstallRoot "DinoBrain Recovery Equivalence Proof.cmd"),
    (Join-Path $AppPath "DinoBrain Recovery Equivalence Proof.cmd")
  )
  $content = @"
@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -NoExit -File "$proofScript" -Mode both_clients -AppPath "$AppPath" -VaultPath "$VaultPath" -NodeExe "$nodeExe" -InstallResultPath "$installResultPath"
"@

  $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
  foreach ($launcherPath in $launcherPaths) {
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $launcherPath) | Out-Null
    [System.IO.File]::WriteAllText($launcherPath, $content, $utf8NoBom)
    Write-Host "Recovery-equivalence proof launcher created: $launcherPath"
  }
  return $launcherPaths
}

function New-DinoBrainWindowsSandboxProofLauncher {
  param(
    [Parameter(Mandatory = $true)][string]$InstallRoot,
    [Parameter(Mandatory = $true)][string]$AppPath
  )

  $proofScript = Join-Path $AppPath "scripts\start-windows-sandbox-clean-machine-proof.ps1"
  if (-not (Test-Path -LiteralPath $proofScript)) {
    Write-Warning "Windows Sandbox proof script not found: $proofScript"
    return @()
  }

  $launcherPaths = @(
    (Join-Path $InstallRoot "DinoBrain Windows Sandbox Proof.cmd"),
    (Join-Path $AppPath "DinoBrain Windows Sandbox Proof.cmd")
  )
  $content = @"
@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -NoExit -File "$proofScript"
"@
  $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
  foreach ($launcherPath in $launcherPaths) {
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $launcherPath) | Out-Null
    [System.IO.File]::WriteAllText($launcherPath, $content, $utf8NoBom)
    Write-Host "Windows Sandbox proof launcher created: $launcherPath"
  }
  return $launcherPaths
}

function Invoke-DinoBrainCodexManagedHookInstall {
  param(
    [Parameter(Mandatory = $true)][string]$AppPath,
    [Parameter(Mandatory = $true)][string]$VaultPath,
    [Parameter(Mandatory = $true)][string]$RequirementsPath,
    [Parameter(Mandatory = $true)][string]$ManagedDir
  )

  $managedHookScript = Join-Path $AppPath "scripts\install-codex-managed-hook.ps1"
  if (-not (Test-Path -LiteralPath $managedHookScript)) {
    Write-Warning "Codex managed hook installer was not found: $managedHookScript"
    return $false
  }

  $result = Invoke-NativeCommandResult -FilePath "powershell.exe" -ArgumentList @(
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    $managedHookScript,
    "-AppPath",
    $AppPath,
    "-VaultPath",
    $VaultPath,
    "-RequirementsPath",
    $RequirementsPath,
    "-ManagedDir",
    $ManagedDir,
    "-Json"
  ) -WorkingDirectory $AppPath

  if ($result.ExitCode -ne 0) {
    Write-Warning "Codex managed hook install was skipped or failed. Run DinoBrain Codex Managed Hook Admin.cmd to install the policy-trusted hook. $($result.Output)"
    return $false
  }

  Write-Host "Codex managed hook installed: $RequirementsPath"
  return $true
}

function New-DinoBrainManagedHookLauncher {
  param(
    [Parameter(Mandatory = $true)][string]$InstallRoot,
    [Parameter(Mandatory = $true)][string]$AppPath,
    [Parameter(Mandatory = $true)][string]$VaultPath,
    [Parameter(Mandatory = $true)][string]$RequirementsPath,
    [Parameter(Mandatory = $true)][string]$ManagedDir
  )

  $managedHookScript = Join-Path $AppPath "scripts\install-codex-managed-hook.ps1"
  if (-not (Test-Path -LiteralPath $managedHookScript)) {
    Write-Warning "Codex managed hook installer not found: $managedHookScript"
    return @()
  }

  $launcherPaths = @(
    (Join-Path $InstallRoot "DinoBrain Codex Managed Hook Admin.cmd"),
    (Join-Path $AppPath "DinoBrain Codex Managed Hook Admin.cmd")
  )
  $content = @"
@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -NoExit -File "$managedHookScript" -AppPath "$AppPath" -VaultPath "$VaultPath" -RequirementsPath "$RequirementsPath" -ManagedDir "$ManagedDir" -Elevate
"@

  $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
  foreach ($launcherPath in $launcherPaths) {
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $launcherPath) | Out-Null
    [System.IO.File]::WriteAllText($launcherPath, $content, $utf8NoBom)
    Write-Host "Codex managed hook launcher created: $launcherPath"
  }
  return $launcherPaths
}

function Start-DinoBrainHookApprovalLauncher {
  param([Parameter(Mandatory = $true)][string[]]$LauncherPaths)

  if ($LauncherPaths.Count -lt 1 -or [string]::IsNullOrWhiteSpace($LauncherPaths[0])) {
    Write-Warning "Hook approval launcher was not created. Open Codex manually, run /hooks, and trust DinoBrain."
    return
  }

  try {
    Start-Process -FilePath $LauncherPaths[0] -WindowStyle Normal | Out-Null
    Write-Host "Hook approval flow started: $($LauncherPaths[0])"
  } catch {
    Write-Warning "Could not start hook approval flow: $($_.Exception.Message)"
  }
}

function New-DinoBrainPrivateRecoveryLaunchers {
  param(
    [Parameter(Mandatory = $true)][string]$InstallRoot,
    [Parameter(Mandatory = $true)][string]$AppPath,
    [Parameter(Mandatory = $true)][string]$VaultPath,
    [Parameter(Mandatory = $true)][string]$NodeRoot
  )

  $backupScript = Join-Path $AppPath "scripts\start-private-backup.ps1"
  $restoreScript = Join-Path $AppPath "scripts\start-private-restore.ps1"
  if (-not (Test-Path -LiteralPath $backupScript) -or -not (Test-Path -LiteralPath $restoreScript)) {
    Write-Warning "Private backup/restore scripts were not found under $AppPath."
    return @()
  }

  $nodeExe = Join-Path $NodeRoot "node.exe"
  $launchers = @()
  foreach ($basePath in @($InstallRoot, $AppPath)) {
    $backupLauncher = Join-Path $basePath "DinoBrain Private Backup.cmd"
    $restoreLauncher = Join-Path $basePath "DinoBrain Private Restore.cmd"
    $backupContent = @"
@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -NoExit -File "$backupScript" -AppPath "$AppPath" -VaultPath "$VaultPath" -NodeExe "$nodeExe" -IncludeUserConfig -IncludeCredentials
"@
    $restoreContent = @"
@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -NoExit -File "$restoreScript" -AppPath "$AppPath" -VaultPath "$VaultPath" -NodeExe "$nodeExe" -IncludeUserConfig
"@
    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    foreach ($pair in @(@($backupLauncher, $backupContent), @($restoreLauncher, $restoreContent))) {
      New-Item -ItemType Directory -Force -Path (Split-Path -Parent $pair[0]) | Out-Null
      [System.IO.File]::WriteAllText($pair[0], $pair[1], $utf8NoBom)
      Write-Host "Private recovery launcher created: $($pair[0])"
      $launchers += $pair[0]
    }
  }
  return $launchers
}

function New-DinoBrainUninstallLauncher {
  param(
    [Parameter(Mandatory = $true)][string]$InstallRoot,
    [Parameter(Mandatory = $true)][string]$AppPath,
    [Parameter(Mandatory = $true)][string]$VaultPath,
    [Parameter(Mandatory = $true)][string]$ToolsDir,
    [Parameter(Mandatory = $true)][string]$ConfigPath,
    [Parameter(Mandatory = $true)][string]$HooksPath,
    [Parameter(Mandatory = $true)][string]$RequirementsPath,
    [Parameter(Mandatory = $true)][string]$ManagedHookDir,
    [Parameter(Mandatory = $true)][string]$ClaudeCommand
  )

  $uninstallScript = Join-Path $AppPath "uninstall.ps1"
  if (-not (Test-Path -LiteralPath $uninstallScript)) {
    Write-Warning "Uninstall script not found: $uninstallScript"
    return @()
  }

  $launcherPaths = @(
    (Join-Path $InstallRoot "DinoBrain Uninstall Everything.cmd"),
    (Join-Path $AppPath "DinoBrain Uninstall Everything.cmd")
  )
  $content = @"
@echo off
setlocal
set "TMP_SCRIPT=%TEMP%\DinoBrainUninstall-%RANDOM%-%RANDOM%.ps1"
copy /Y "$uninstallScript" "%TMP_SCRIPT%" >nul
start "DinoBrain Uninstall" powershell.exe -NoProfile -ExecutionPolicy Bypass -NoExit -File "%TMP_SCRIPT%" -InstallRoot "$InstallRoot" -AppDir "$AppPath" -DataDir "$VaultPath" -ToolsDir "$ToolsDir" -CodexConfigPath "$ConfigPath" -CodexHooksPath "$HooksPath" -CodexRequirementsPath "$RequirementsPath" -CodexManagedHookDir "$ManagedHookDir" -ClaudeCommand "$ClaudeCommand" -Purge
"@

  $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
  foreach ($launcherPath in $launcherPaths) {
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $launcherPath) | Out-Null
    [System.IO.File]::WriteAllText($launcherPath, $content, $utf8NoBom)
    Write-Host "Uninstall launcher created: $launcherPath"
  }
  return $launcherPaths
}

function Set-DinoBrainClaudeCodeConfig {
  param(
    [Parameter(Mandatory = $true)][string]$ClaudeCommand,
    [Parameter(Mandatory = $true)][string]$Scope,
    [Parameter(Mandatory = $true)][string]$NodeExe,
    [Parameter(Mandatory = $true)][string]$ServerEntry,
    [Parameter(Mandatory = $true)][string]$VaultPath,
    [Parameter(Mandatory = $true)][string]$WorkingDirectory
  )

  $command = Get-Command $ClaudeCommand -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $command) {
    Write-Warning "Claude Code CLI not found on PATH: $ClaudeCommand. Install Claude Code, then rerun setup.ps1 to register DinoBrain."
    return $false
  }

  $claudeExe = if (-not [string]::IsNullOrWhiteSpace($command.Source)) { $command.Source } else { $ClaudeCommand }
  $removeResult = Invoke-NativeCommandResult -FilePath $claudeExe -ArgumentList @("mcp", "remove", "dinobrain") -WorkingDirectory $WorkingDirectory
  if ($removeResult.ExitCode -eq 0) {
    Write-Host "Removed previous Claude Code MCP registration: dinobrain"
  }

  Invoke-NativeCommand -FilePath $claudeExe -ArgumentList @(
    "mcp",
    "add",
    "--env",
    "DINOBRAIN_DATA_DIR=$VaultPath",
    "--transport",
    "stdio",
    "--scope",
    $Scope,
    "dinobrain",
    "--",
    $NodeExe,
    $ServerEntry
  ) -WorkingDirectory $WorkingDirectory | Out-Host

  $listResult = Invoke-NativeCommandResult -FilePath $claudeExe -ArgumentList @("mcp", "list") -WorkingDirectory $WorkingDirectory
  if ($listResult.ExitCode -ne 0 -or $listResult.Output -notmatch "(?i)\bdinobrain\b") {
    throw "Claude Code MCP registration did not appear in 'claude mcp list'."
  }

  Write-Host "Claude Code MCP registered: dinobrain (scope=$Scope)"
  return $true
}

function Invoke-DinoBrainVerify {
  param(
    [Parameter(Mandatory = $true)][string]$NodeRoot,
    [Parameter(Mandatory = $true)][string]$AppPath,
    [Parameter(Mandatory = $true)][string]$ConfigPath,
    [Parameter(Mandatory = $true)][string]$HooksPath,
    [Parameter(Mandatory = $true)][string]$RequirementsPath,
    [Parameter(Mandatory = $true)][string]$VaultPath,
    [Parameter(Mandatory = $true)][string]$ClaudeCommand,
    [Parameter(Mandatory = $true)][string]$ClaudeSettingsPath,
    [switch]$RequireCodexUserHook,
    [switch]$RequireCodexManagedHook,
    [switch]$RequireClaudeCode,
    [switch]$RequireClaudePromptHook,
    [switch]$AllowNoGit
  )

  $npmCmd = Join-Path $NodeRoot "npm.cmd"
  $oldConfig = $env:DINOBRAIN_CODEX_CONFIG_PATH
  $oldHooks = $env:DINOBRAIN_CODEX_HOOKS_PATH
  $oldRequirements = $env:DINOBRAIN_CODEX_REQUIREMENTS_PATH
  $oldRequireHook = $env:DINOBRAIN_REQUIRE_CODEX_USER_HOOK
  $oldRequireManagedHook = $env:DINOBRAIN_REQUIRE_CODEX_MANAGED_HOOK
  $oldData = $env:DINOBRAIN_DATA_DIR
  $oldClaudeCommand = $env:DINOBRAIN_CLAUDE_COMMAND
  $oldClaudeSettings = $env:DINOBRAIN_CLAUDE_SETTINGS_PATH
  $oldRequireClaude = $env:DINOBRAIN_REQUIRE_CLAUDE_CODE
  $oldRequireClaudeHook = $env:DINOBRAIN_REQUIRE_CLAUDE_PROMPT_HOOK
  $oldAllowNoGit = $env:DINOBRAIN_ALLOW_NO_GIT
  $oldPath = $env:PATH
  $env:DINOBRAIN_CODEX_CONFIG_PATH = $ConfigPath
  $env:DINOBRAIN_CODEX_HOOKS_PATH = $HooksPath
  $env:DINOBRAIN_CODEX_REQUIREMENTS_PATH = $RequirementsPath
  if ($RequireCodexUserHook) { $env:DINOBRAIN_REQUIRE_CODEX_USER_HOOK = "1" } else { Remove-Item Env:\DINOBRAIN_REQUIRE_CODEX_USER_HOOK -ErrorAction SilentlyContinue }
  if ($RequireCodexManagedHook) { $env:DINOBRAIN_REQUIRE_CODEX_MANAGED_HOOK = "1" } else { Remove-Item Env:\DINOBRAIN_REQUIRE_CODEX_MANAGED_HOOK -ErrorAction SilentlyContinue }
  $env:DINOBRAIN_DATA_DIR = $VaultPath
  $env:DINOBRAIN_CLAUDE_COMMAND = $ClaudeCommand
  $env:DINOBRAIN_CLAUDE_SETTINGS_PATH = $ClaudeSettingsPath
  if ($RequireClaudeCode) { $env:DINOBRAIN_REQUIRE_CLAUDE_CODE = "1" } else { Remove-Item Env:\DINOBRAIN_REQUIRE_CLAUDE_CODE -ErrorAction SilentlyContinue }
  if ($RequireClaudePromptHook) { $env:DINOBRAIN_REQUIRE_CLAUDE_PROMPT_HOOK = "1" } else { Remove-Item Env:\DINOBRAIN_REQUIRE_CLAUDE_PROMPT_HOOK -ErrorAction SilentlyContinue }
  if ($AllowNoGit) { $env:DINOBRAIN_ALLOW_NO_GIT = "1" } else { Remove-Item Env:\DINOBRAIN_ALLOW_NO_GIT -ErrorAction SilentlyContinue }
  $env:PATH = "$NodeRoot;$oldPath"
  try {
    Invoke-NativeCommand -FilePath $npmCmd -ArgumentList @("run", "verify:os") -WorkingDirectory $AppPath
    Invoke-NativeCommand -FilePath $npmCmd -ArgumentList @("run", "verify:codex-loop") -WorkingDirectory $AppPath
  } finally {
    if ($null -eq $oldConfig) { Remove-Item Env:\DINOBRAIN_CODEX_CONFIG_PATH -ErrorAction SilentlyContinue } else { $env:DINOBRAIN_CODEX_CONFIG_PATH = $oldConfig }
    if ($null -eq $oldHooks) { Remove-Item Env:\DINOBRAIN_CODEX_HOOKS_PATH -ErrorAction SilentlyContinue } else { $env:DINOBRAIN_CODEX_HOOKS_PATH = $oldHooks }
    if ($null -eq $oldRequirements) { Remove-Item Env:\DINOBRAIN_CODEX_REQUIREMENTS_PATH -ErrorAction SilentlyContinue } else { $env:DINOBRAIN_CODEX_REQUIREMENTS_PATH = $oldRequirements }
    if ($null -eq $oldRequireHook) { Remove-Item Env:\DINOBRAIN_REQUIRE_CODEX_USER_HOOK -ErrorAction SilentlyContinue } else { $env:DINOBRAIN_REQUIRE_CODEX_USER_HOOK = $oldRequireHook }
    if ($null -eq $oldRequireManagedHook) { Remove-Item Env:\DINOBRAIN_REQUIRE_CODEX_MANAGED_HOOK -ErrorAction SilentlyContinue } else { $env:DINOBRAIN_REQUIRE_CODEX_MANAGED_HOOK = $oldRequireManagedHook }
    if ($null -eq $oldData) { Remove-Item Env:\DINOBRAIN_DATA_DIR -ErrorAction SilentlyContinue } else { $env:DINOBRAIN_DATA_DIR = $oldData }
    if ($null -eq $oldClaudeCommand) { Remove-Item Env:\DINOBRAIN_CLAUDE_COMMAND -ErrorAction SilentlyContinue } else { $env:DINOBRAIN_CLAUDE_COMMAND = $oldClaudeCommand }
    if ($null -eq $oldClaudeSettings) { Remove-Item Env:\DINOBRAIN_CLAUDE_SETTINGS_PATH -ErrorAction SilentlyContinue } else { $env:DINOBRAIN_CLAUDE_SETTINGS_PATH = $oldClaudeSettings }
    if ($null -eq $oldRequireClaude) { Remove-Item Env:\DINOBRAIN_REQUIRE_CLAUDE_CODE -ErrorAction SilentlyContinue } else { $env:DINOBRAIN_REQUIRE_CLAUDE_CODE = $oldRequireClaude }
    if ($null -eq $oldRequireClaudeHook) { Remove-Item Env:\DINOBRAIN_REQUIRE_CLAUDE_PROMPT_HOOK -ErrorAction SilentlyContinue } else { $env:DINOBRAIN_REQUIRE_CLAUDE_PROMPT_HOOK = $oldRequireClaudeHook }
    if ($null -eq $oldAllowNoGit) { Remove-Item Env:\DINOBRAIN_ALLOW_NO_GIT -ErrorAction SilentlyContinue } else { $env:DINOBRAIN_ALLOW_NO_GIT = $oldAllowNoGit }
    $env:PATH = $oldPath
  }
}

function Invoke-DinoBrainSemanticRagPrewarm {
  param(
    [Parameter(Mandatory = $true)][string]$NodeRoot,
    [Parameter(Mandatory = $true)][string]$AppPath,
    [Parameter(Mandatory = $true)][string]$VaultPath
  )

  $npmCmd = Join-Path $NodeRoot "npm.cmd"
  $oldDataRoot = $env:DINOBRAIN_DATA_DIR
  $oldRequireSemantic = $env:DINOBRAIN_REQUIRE_SEMANTIC_EMBEDDINGS
  $oldPath = $env:PATH
  $env:DINOBRAIN_DATA_DIR = $VaultPath
  $env:DINOBRAIN_REQUIRE_SEMANTIC_EMBEDDINGS = "1"
  $env:PATH = "$NodeRoot;$oldPath"
  try {
    Invoke-WithPortableNode -NodeRoot $NodeRoot -FilePath $npmCmd -ArgumentList @("run", "rag:proof") -WorkingDirectory $AppPath
    Invoke-WithPortableNode -NodeRoot $NodeRoot -FilePath $npmCmd -ArgumentList @("run", "eval:rag") -WorkingDirectory $AppPath

    $proofPath = Join-Path $VaultPath ".dino\state\rag_proof_status.json"
    $evalPath = Join-Path $VaultPath ".dino\state\rag_eval_status.json"
    if (-not (Test-Path -LiteralPath $proofPath)) {
      throw "Semantic RAG proof status was not created: $proofPath"
    }
    if (-not (Test-Path -LiteralPath $evalPath)) {
      throw "Semantic RAG eval status was not created: $evalPath"
    }
    $proof = Get-Content -LiteralPath $proofPath -Raw | ConvertFrom-Json
    $eval = Get-Content -LiteralPath $evalPath -Raw | ConvertFrom-Json
    if ($proof.status -ne "healthy") {
      throw "Semantic RAG proof is not healthy: $($proof.status)"
    }
    if ($proof.dense_vector.semantic_embedding_provider -ne $true) {
      throw "Semantic RAG proof did not use a semantic embedding provider."
    }
    if ($proof.dense_vector.provider -eq "local_text_hashing_v1") {
      throw "Semantic RAG proof fell back to local text hashing."
    }
    if ($eval.status -ne "healthy") {
      throw "Semantic RAG eval is not healthy: $($eval.status)"
    }
    if ($eval.counts.lexical_fallback -ne 0) {
      throw "Semantic RAG eval still used lexical fallback."
    }
    if ($eval.generated_answer_eval.status -ne "healthy") {
      throw "Generated-answer RAG eval is not healthy: $($eval.generated_answer_eval.status)"
    }
    Write-Host "Semantic RAG proof/eval ready: provider=$($proof.dense_vector.provider), model=$($proof.dense_vector.model)"
  } finally {
    if ($null -eq $oldDataRoot) { Remove-Item Env:\DINOBRAIN_DATA_DIR -ErrorAction SilentlyContinue } else { $env:DINOBRAIN_DATA_DIR = $oldDataRoot }
    if ($null -eq $oldRequireSemantic) { Remove-Item Env:\DINOBRAIN_REQUIRE_SEMANTIC_EMBEDDINGS -ErrorAction SilentlyContinue } else { $env:DINOBRAIN_REQUIRE_SEMANTIC_EMBEDDINGS = $oldRequireSemantic }
    $env:PATH = $oldPath
  }
}

if ([string]::IsNullOrWhiteSpace($InstallRoot)) { $InstallRoot = Get-DefaultInstallRoot }
if ([string]::IsNullOrWhiteSpace($ToolsDir)) { $ToolsDir = Get-DefaultToolsDir }
if ([string]::IsNullOrWhiteSpace($CodexConfigPath)) { $CodexConfigPath = Join-Path $HOME ".codex\config.toml" }
if ([string]::IsNullOrWhiteSpace($CodexHooksPath)) { $CodexHooksPath = Join-Path $HOME ".codex\hooks.json" }
if ([string]::IsNullOrWhiteSpace($CodexRequirementsPath)) { $CodexRequirementsPath = Join-Path (Get-DefaultProgramData) "OpenAI\Codex\requirements.toml" }
if ([string]::IsNullOrWhiteSpace($CodexManagedHookDir)) { $CodexManagedHookDir = Join-Path (Get-DefaultProgramData) "OpenAI\Codex\DinoBrainHooks" }
if ([string]::IsNullOrWhiteSpace($ClaudeSettingsPath)) { $ClaudeSettingsPath = Join-Path $HOME ".claude\settings.json" }

$rawInstallRoot = $InstallRoot
$InstallRoot = Resolve-DinoBrainInstallRoot $InstallRoot
if ($InstallRoot -ne (Get-FullPath $rawInstallRoot)) {
  Write-Host "DinoBrain install root normalized: $rawInstallRoot -> $InstallRoot"
}

if ([string]::IsNullOrWhiteSpace($AppDir)) { $AppDir = Join-Path $InstallRoot "dinobrain" }
if ([string]::IsNullOrWhiteSpace($DataDir)) { $DataDir = Join-Path $InstallRoot "dinobrain-data" }

$InstallRoot = Get-FullPath $InstallRoot
$AppDir = Get-FullPath $AppDir
$DataDir = Get-FullPath $DataDir
$ToolsDir = Get-FullPath $ToolsDir
$CodexConfigPath = Get-FullPath $CodexConfigPath
$CodexHooksPath = Get-FullPath $CodexHooksPath
$CodexRequirementsPath = Get-FullPath $CodexRequirementsPath
$CodexManagedHookDir = Get-FullPath $CodexManagedHookDir
$ClaudeSettingsPath = Get-FullPath $ClaudeSettingsPath

Write-Host "DinoBrain install root: $InstallRoot"
Write-Host "App repo target: $AppDir"
Write-Host "Data repo target: $DataDir"
Write-Host "Tools target: $ToolsDir"
Write-Host "App ref: $AppRef"
Write-Host "Data ref: $DataRef"

$gitAvailable = Test-Command "git"
$archiveToken = Get-DinoBrainGitHubToken -ExplicitToken $GitHubToken
$transaction = $null
$nodeRoot = $null
$expectedNodeRoot = $null
$nodeRootExisted = $false
$installLock = Enter-DinoBrainInstallLock -InstallRoot $InstallRoot
try {
  $allowedSnapshotPaths = @(
    $CodexConfigPath,
    $CodexHooksPath,
    $CodexRequirementsPath,
    $CodexManagedHookDir,
    $ClaudeSettingsPath,
    (Join-Path $HOME ".claude.json")
  )
  $allowedSnapshotPaths += @(Get-DinoBrainInstallerLauncherNames | ForEach-Object { Join-Path $InstallRoot $_ })
  Recover-DinoBrainInterruptedInstallTransactions -InstallRoot $InstallRoot -ExpectedAppPath $AppDir -ExpectedDataPath $DataDir -AllowedSnapshotPaths $allowedSnapshotPaths

  if (-not $gitAvailable) {
    Write-Warning "Git was not found on PATH. DinoBrain will use immutable GitHub archives, but this degraded path does not count as clean-machine equivalence."
  }

  $appResolution = Resolve-DinoBrainImmutableRef -Name "dinobrain" -RepoUrl $AppRepo -Ref $AppRef -Token $archiveToken -AllowNoGit:(-not $gitAvailable)
  $dataResolution = Resolve-DinoBrainImmutableRef -Name "dinobrain-data" -RepoUrl $DataRepo -Ref $DataRef -Token $archiveToken -AllowNoGit:(-not $gitAvailable)
  Write-Host "Resolved app ref: $AppRef -> $($appResolution.resolved_commit)"
  Write-Host "Resolved data ref: $DataRef -> $($dataResolution.resolved_commit)"

  $transaction = New-DinoBrainInstallTransaction -InstallRoot $InstallRoot -AppPath $AppDir -VaultPath $DataDir -AppResolution $appResolution -DataResolution $dataResolution
  Prepare-DinoBrainRepoStage -Name "dinobrain" -RepoUrl $AppRepo -TargetDir $AppDir -StageDir $transaction.StageAppPath -RequestedRef $AppRef -ResolvedCommit $appResolution.resolved_commit -Token $archiveToken -AllowOriginChange:$Force -AllowNoGit:(-not $gitAvailable)
  Prepare-DinoBrainRepoStage -Name "dinobrain-data" -RepoUrl $DataRepo -TargetDir $DataDir -StageDir $transaction.StageDataPath -RequestedRef $DataRef -ResolvedCommit $dataResolution.resolved_commit -Token $archiveToken -AllowOriginChange:$Force -AllowNoGit:(-not $gitAvailable)
  if ($gitAvailable) {
    Enable-DinoBrainDataGitHooks -DataDir $transaction.StageDataPath
  }

  $expectedNodeRoot = Join-Path $ToolsDir "node-v$NodeVersion-win-x64"
  $nodeRootExisted = Test-Path -LiteralPath $expectedNodeRoot
  $nodeRoot = Install-PortableNode -Version $NodeVersion -DestinationRoot $ToolsDir
  $nodeExe = Join-Path $nodeRoot "node.exe"
  $npmCmd = Join-Path $nodeRoot "npm.cmd"

  if (-not $SkipSemanticRagPrewarm) {
    Install-DinoBrainVisualCppRuntime
  }

  Invoke-WithPortableNode -NodeRoot $nodeRoot -FilePath $npmCmd -ArgumentList @("install") -WorkingDirectory $transaction.StageAppPath
  if (-not $SkipSemanticRagPrewarm) {
    Assert-DinoBrainSemanticNativeRuntime -NodeRoot $nodeRoot -AppPath $transaction.StageAppPath
  }
  Invoke-WithPortableNode -NodeRoot $nodeRoot -FilePath $npmCmd -ArgumentList @("run", "build") -WorkingDirectory $transaction.StageAppPath
  $oldDataRoot = $env:DINOBRAIN_DATA_DIR
  $env:DINOBRAIN_DATA_DIR = $transaction.StageDataPath
  try {
    Invoke-WithPortableNode -NodeRoot $nodeRoot -FilePath $npmCmd -ArgumentList @("run", "index:sqlite") -WorkingDirectory $transaction.StageAppPath
    if (-not $SkipSemanticRagPrewarm) {
      Invoke-DinoBrainSemanticRagPrewarm -NodeRoot $nodeRoot -AppPath $transaction.StageAppPath -VaultPath $transaction.StageDataPath
    }
    if ($gitAvailable) {
      Invoke-WithPortableNode -NodeRoot $nodeRoot -FilePath $npmCmd -ArgumentList @("run", "hooks:data:verify") -WorkingDirectory $transaction.StageAppPath
    }
  } finally {
    if ($null -eq $oldDataRoot) { Remove-Item Env:\DINOBRAIN_DATA_DIR -ErrorAction SilentlyContinue } else { $env:DINOBRAIN_DATA_DIR = $oldDataRoot }
  }

  $verifyRoot = Join-Path $transaction.Root "verify-config"
  $verifyConfigPath = New-DinoBrainStagedFileFromCurrent -CurrentPath $CodexConfigPath -StagedPath (Join-Path $verifyRoot "config.toml")
  $verifyHooksPath = New-DinoBrainStagedFileFromCurrent -CurrentPath $CodexHooksPath -StagedPath (Join-Path $verifyRoot "hooks.json")
  $verifyRequirementsPath = New-DinoBrainStagedFileFromCurrent -CurrentPath $CodexRequirementsPath -StagedPath (Join-Path $verifyRoot "requirements.toml")
  $verifyClaudeSettingsPath = New-DinoBrainStagedFileFromCurrent -CurrentPath $ClaudeSettingsPath -StagedPath (Join-Path $verifyRoot "claude-settings.json")
  if (-not $SkipCodexConfig) {
    Set-DinoBrainCodexConfig -ConfigPath $verifyConfigPath -NodeExe $nodeExe -ServerEntry (Join-Path $transaction.StageAppPath "dist\index.js") -VaultPath $transaction.StageDataPath -EnableHooks:(-not $SkipCodexHookConfig)
  }
  if (-not $SkipCodexHookConfig) {
    Set-DinoBrainCodexUserHook -HooksPath $verifyHooksPath -AppPath $transaction.StageAppPath -VaultPath $transaction.StageDataPath
    Invoke-DinoBrainCodexHookHandshake -AppPath $transaction.StageAppPath -VaultPath $transaction.StageDataPath -NodeExe $nodeExe
  }
  if (-not $SkipClaudeCodeConfig) {
    Set-DinoBrainClaudeUserHook -SettingsPath $verifyClaudeSettingsPath -AppPath $transaction.StageAppPath -VaultPath $transaction.StageDataPath
  }
  if (-not $SkipVerify) {
    Invoke-DinoBrainVerify -NodeRoot $nodeRoot -AppPath $transaction.StageAppPath -ConfigPath $verifyConfigPath -HooksPath $verifyHooksPath -RequirementsPath $verifyRequirementsPath -VaultPath $transaction.StageDataPath -ClaudeCommand $ClaudeCommand -ClaudeSettingsPath $verifyClaudeSettingsPath -RequireCodexUserHook:(-not $SkipCodexHookConfig) -RequireClaudePromptHook:(-not $SkipClaudeCodeConfig) -AllowNoGit:(-not $gitAvailable)
    $transaction.StageVerified = $true
  } else {
    $transaction.VerificationSkipped = $true
  }
  Update-DinoBrainInstallTransactionJournal -Transaction $transaction

  $promotionRoot = Join-Path $transaction.Root "promotion-config"
  $promotionConfigPath = New-DinoBrainStagedFileFromCurrent -CurrentPath $CodexConfigPath -StagedPath (Join-Path $promotionRoot "config.toml")
  $promotionHooksPath = New-DinoBrainStagedFileFromCurrent -CurrentPath $CodexHooksPath -StagedPath (Join-Path $promotionRoot "hooks.json")
  $promotionClaudeSettingsPath = New-DinoBrainStagedFileFromCurrent -CurrentPath $ClaudeSettingsPath -StagedPath (Join-Path $promotionRoot "claude-settings.json")
  if (-not $SkipCodexConfig) {
    Set-DinoBrainCodexConfig -ConfigPath $promotionConfigPath -NodeExe $nodeExe -ServerEntry (Join-Path $AppDir "dist\index.js") -VaultPath $DataDir -EnableHooks:(-not $SkipCodexHookConfig)
    Save-DinoBrainInstallSnapshot -Transaction $transaction -TargetPath $CodexConfigPath
  }
  if (-not $SkipCodexHookConfig) {
    Set-DinoBrainCodexUserHook -HooksPath $promotionHooksPath -AppPath $AppDir -VaultPath $DataDir
    Save-DinoBrainInstallSnapshot -Transaction $transaction -TargetPath $CodexHooksPath
  }
  if (-not $SkipClaudeCodeConfig) {
    Set-DinoBrainClaudeUserHook -SettingsPath $promotionClaudeSettingsPath -AppPath $AppDir -VaultPath $DataDir
    Save-DinoBrainInstallSnapshot -Transaction $transaction -TargetPath $ClaudeSettingsPath
    Save-DinoBrainInstallSnapshot -Transaction $transaction -TargetPath (Join-Path $HOME ".claude.json")
  }
  if (-not $SkipCodexHookConfig -and -not $SkipCodexManagedHookConfig) {
    Save-DinoBrainInstallSnapshot -Transaction $transaction -TargetPath $CodexRequirementsPath
    Save-DinoBrainInstallSnapshot -Transaction $transaction -TargetPath $CodexManagedHookDir -AllowDirectory
  }
  foreach ($launcherName in Get-DinoBrainInstallerLauncherNames) {
    Save-DinoBrainInstallSnapshot -Transaction $transaction -TargetPath (Join-Path $InstallRoot $launcherName)
  }

  Invoke-DinoBrainInstallFailurePoint -Name "after_stage_build"
  Promote-DinoBrainInstallTransaction -Transaction $transaction
  if ($gitAvailable) { Enable-DinoBrainDataGitHooks -DataDir $DataDir }
  $oldFinalDataRoot = $env:DINOBRAIN_DATA_DIR
  $env:DINOBRAIN_DATA_DIR = $DataDir
  try {
    Write-Host "Publishing final-path DinoBrain indexes, evidence graph, and atomic status generation"
    $refreshStartedAt = [DateTime]::UtcNow.AddSeconds(-2)
    $oldPortablePath = $env:PATH
    $env:PATH = "$nodeRoot;$oldPortablePath"
    try {
      $refreshResult = Invoke-NativeCommandResult -FilePath $npmCmd -ArgumentList @("run", "status:refresh") -WorkingDirectory $AppDir
    } finally {
      $env:PATH = $oldPortablePath
    }
    if (-not [string]::IsNullOrWhiteSpace([string]$refreshResult.Output)) { Write-Host $refreshResult.Output }
    if ($refreshResult.ExitCode -notin @(0, 1)) {
      throw "Final-path status refresh failed before publication with exit code $($refreshResult.ExitCode)."
    }
    $requiredFinalArtifacts = @(
      (Join-Path $DataDir ".dino\index\evidence-graph.sqlite"),
      (Join-Path $DataDir ".dino\state\evidence_graph_status.json"),
      (Join-Path $DataDir ".dino\state\current-status-generation.json")
    )
    foreach ($requiredArtifact in $requiredFinalArtifacts) {
      if (-not (Test-Path -LiteralPath $requiredArtifact -PathType Leaf)) {
        throw "Final-path graph/status artifact was not created: $requiredArtifact"
      }
    }
    $generationPointer = Get-Content -LiteralPath (Join-Path $DataDir ".dino\state\current-status-generation.json") -Raw | ConvertFrom-Json
    $graphStatus = Get-Content -LiteralPath (Join-Path $DataDir ".dino\state\evidence_graph_status.json") -Raw | ConvertFrom-Json
    if ([string]::IsNullOrWhiteSpace([string]$generationPointer.generation_id) -or [DateTime]::Parse([string]$generationPointer.generated_at).ToUniversalTime() -lt $refreshStartedAt) {
      throw "Final-path status generation was not freshly published by this installation."
    }
    if ([string]$graphStatus.status -ne "healthy" -or [DateTime]::Parse([string]$graphStatus.generated_at).ToUniversalTime() -lt $refreshStartedAt) {
      throw "Final-path evidence graph was not freshly rebuilt as healthy by this installation."
    }
    if ($refreshResult.ExitCode -eq 1) {
      Write-Warning "Final-path graph and status generation were published, but non-graph readiness checks still need attention. Observatory will show those checks separately."
    }
  } finally {
    if ($null -eq $oldFinalDataRoot) { Remove-Item Env:\DINOBRAIN_DATA_DIR -ErrorAction SilentlyContinue } else { $env:DINOBRAIN_DATA_DIR = $oldFinalDataRoot }
  }
  Invoke-DinoBrainInstallFailurePoint -Name "after_promote"

  if (-not $SkipCodexConfig) { Publish-DinoBrainStagedFile -StagedPath $promotionConfigPath -TargetPath $CodexConfigPath }
  if (-not $SkipCodexHookConfig) {
    Publish-DinoBrainStagedFile -StagedPath $promotionHooksPath -TargetPath $CodexHooksPath
    Invoke-DinoBrainCodexHookHandshake -AppPath $AppDir -VaultPath $DataDir -NodeExe $nodeExe
  }
  if (-not $SkipClaudeCodeConfig) { Publish-DinoBrainStagedFile -StagedPath $promotionClaudeSettingsPath -TargetPath $ClaudeSettingsPath }

$codexManagedHookConfigured = $false
if (-not $SkipCodexHookConfig -and -not $SkipCodexManagedHookConfig) {
  $codexManagedHookConfigured = Invoke-DinoBrainCodexManagedHookInstall -AppPath $AppDir -VaultPath $DataDir -RequirementsPath $CodexRequirementsPath -ManagedDir $CodexManagedHookDir
  if ($codexManagedHookConfigured) {
    [void](Remove-DinoBrainCodexUserHookRecords -HooksPath $CodexHooksPath)
  }
}

$observatoryLaunchers = New-DinoBrainObservatoryLauncher -InstallRoot $InstallRoot -AppPath $AppDir -VaultPath $DataDir -NodeRoot $nodeRoot
$hookDiagnoseLaunchers = New-DinoBrainHookDiagnoseLauncher -InstallRoot $InstallRoot -AppPath $AppDir -VaultPath $DataDir -NodeRoot $nodeRoot -ConfigPath $CodexConfigPath -HooksPath $CodexHooksPath -RequirementsPath $CodexRequirementsPath
$hookApprovalLaunchers = @()
if (-not $SkipCodexHookConfig) {
  $hookApprovalLaunchers = New-DinoBrainHookApprovalLauncher -InstallRoot $InstallRoot -AppPath $AppDir -ConfigPath $CodexConfigPath -HooksPath $CodexHooksPath -RequirementsPath $CodexRequirementsPath
}
$managedHookLaunchers = @()
if (-not $SkipCodexHookConfig -and -not $SkipCodexManagedHookConfig -and -not $codexManagedHookConfigured) {
  $managedHookLaunchers = New-DinoBrainManagedHookLauncher -InstallRoot $InstallRoot -AppPath $AppDir -VaultPath $DataDir -RequirementsPath $CodexRequirementsPath -ManagedDir $CodexManagedHookDir
}
$liveProofLaunchers = New-DinoBrainLiveProofLauncher -InstallRoot $InstallRoot -AppPath $AppDir -VaultPath $DataDir -NodeRoot $nodeRoot -ConfigPath $CodexConfigPath -HooksPath $CodexHooksPath -RequirementsPath $CodexRequirementsPath
$directMcpProofLaunchers = New-DinoBrainDirectMcpProofLauncher -InstallRoot $InstallRoot -AppPath $AppDir -VaultPath $DataDir -NodeRoot $nodeRoot
$cleanMachineProofLaunchers = New-DinoBrainCleanMachineProofLauncher -InstallRoot $InstallRoot -AppPath $AppDir -VaultPath $DataDir -NodeRoot $nodeRoot
$windowsSandboxProofLaunchers = New-DinoBrainWindowsSandboxProofLauncher -InstallRoot $InstallRoot -AppPath $AppDir
$privateRecoveryLaunchers = New-DinoBrainPrivateRecoveryLaunchers -InstallRoot $InstallRoot -AppPath $AppDir -VaultPath $DataDir -NodeRoot $nodeRoot
$uninstallLaunchers = New-DinoBrainUninstallLauncher -InstallRoot $InstallRoot -AppPath $AppDir -VaultPath $DataDir -ToolsDir $ToolsDir -ConfigPath $CodexConfigPath -HooksPath $CodexHooksPath -RequirementsPath $CodexRequirementsPath -ManagedHookDir $CodexManagedHookDir -ClaudeCommand $ClaudeCommand

$claudeCodeConfigured = $false
$claudePromptHookConfigured = $false
if (-not $SkipClaudeCodeConfig) {
  $claudePromptHookConfigured = $true
  $claudeCodeConfigured = Set-DinoBrainClaudeCodeConfig -ClaudeCommand $ClaudeCommand -Scope $ClaudeScope -NodeExe $nodeExe -ServerEntry (Join-Path $AppDir "dist\index.js") -VaultPath $DataDir -WorkingDirectory $AppDir
}

Invoke-DinoBrainInstallFailurePoint -Name "after_config"
if (-not $SkipVerify) {
  Invoke-DinoBrainVerify -NodeRoot $nodeRoot -AppPath $AppDir -ConfigPath $CodexConfigPath -HooksPath $CodexHooksPath -RequirementsPath $CodexRequirementsPath -VaultPath $DataDir -ClaudeCommand $ClaudeCommand -ClaudeSettingsPath $ClaudeSettingsPath -RequireCodexUserHook:(-not $SkipCodexHookConfig -and -not $codexManagedHookConfigured) -RequireCodexManagedHook:$codexManagedHookConfigured -RequireClaudeCode:$claudeCodeConfigured -RequireClaudePromptHook:$claudePromptHookConfigured -AllowNoGit:(-not $gitAvailable)
}

Complete-DinoBrainInstallTransaction -Transaction $transaction
} catch {
  $originalError = $_
  if ($null -ne $transaction) {
    try {
      Rollback-DinoBrainInstallTransaction -Transaction $transaction -ErrorRecord $originalError
    } catch {
      $rollbackError = $_
      $transaction.Status = "rollback_failed"
      $transaction.Error = "install_error=$originalError; rollback_error=$rollbackError"
      $transaction.FinishedAt = [DateTime]::UtcNow.ToString("o")
      try {
        Update-DinoBrainInstallTransactionJournal -Transaction $transaction
        Write-DinoBrainInstallTransactionResult -Transaction $transaction
      } catch {
        Write-Warning "Could not persist rollback failure result: $_"
      }
      Write-Warning "DinoBrain installer rollback failed: $rollbackError"
    }
  }
  if (-not $nodeRootExisted -and -not [string]::IsNullOrWhiteSpace([string]$expectedNodeRoot) -and (Test-Path -LiteralPath $expectedNodeRoot)) {
    $safeNodeRoot = Get-FullPath $expectedNodeRoot
    if ((Test-DinoBrainPathUnderRoot -TargetPath $safeNodeRoot -AllowedRoot $ToolsDir) -and (Split-Path -Leaf $safeNodeRoot) -eq "node-v$NodeVersion-win-x64") {
      Remove-Item -LiteralPath $safeNodeRoot -Recurse -Force
    }
  }
  throw $originalError
} finally {
  Exit-DinoBrainInstallLock -LockHandle $installLock
}

if (-not $SkipCodexHookConfig -and -not $SkipCodexRestartFlow) {
  Start-DinoBrainHookApprovalLauncher -LauncherPaths $hookApprovalLaunchers
}

Write-Host ""
Write-Host "DinoBrain install complete."
Write-Host "App: $AppDir"
Write-Host "Data: $DataDir"
Write-Host "Node: $nodeExe"
Write-Host "Codex config: $CodexConfigPath"
Write-Host "Codex user hooks: $CodexHooksPath"
Write-Host "Codex managed requirements: $CodexRequirementsPath"
Write-Host "Codex managed hook configured: $codexManagedHookConfigured"
Write-Host "Claude Code settings: $ClaudeSettingsPath"
foreach ($launcher in $observatoryLaunchers) {
  Write-Host "Observatory launcher: $launcher"
}
foreach ($launcher in $hookDiagnoseLaunchers) {
  Write-Host "Hook diagnose launcher: $launcher"
}
foreach ($launcher in $hookApprovalLaunchers) {
  Write-Host "Hook approval launcher: $launcher"
}
foreach ($launcher in $managedHookLaunchers) {
  Write-Host "Managed hook admin launcher: $launcher"
}
foreach ($launcher in $liveProofLaunchers) {
  Write-Host "Codex live proof launcher: $launcher"
}
foreach ($launcher in $directMcpProofLaunchers) {
  Write-Host "Direct MCP proof launcher: $launcher"
}
foreach ($launcher in $cleanMachineProofLaunchers) {
  Write-Host "Recovery-equivalence proof launcher: $launcher"
}
foreach ($launcher in $windowsSandboxProofLaunchers) {
  Write-Host "Windows Sandbox proof launcher: $launcher"
}
foreach ($launcher in $privateRecoveryLaunchers) {
  Write-Host "Private recovery launcher: $launcher"
}
foreach ($launcher in $uninstallLaunchers) {
  Write-Host "Uninstall launcher: $launcher"
}
Write-Host "Claude Code MCP scope: $ClaudeScope"
