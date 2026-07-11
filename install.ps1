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
    Expand-Archive -Path $zipPath -DestinationPath $extractDir -Force
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

  Expand-Archive -Path $zipPath -DestinationPath $DestinationRoot -Force
  if (-not (Test-Path -LiteralPath $nodeExe)) {
    throw "Portable Node installation failed: $nodeExe"
  }
  return $nodeRoot
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
    "(?m)^DINOBRAIN_AUTO_GROWTH\s*=\s*(['""])1\1\r?$",
    "(?m)^DINOBRAIN_AUTO_COMPOUND\s*=\s*(['""])1\1\r?$",
    "(?m)^DINOBRAIN_AUTO_SYNC\s*=\s*(['""])1\1\r?$",
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
    "DINOBRAIN_AUTO_GROWTH = `"1`"",
    "DINOBRAIN_AUTO_COMPOUND = `"1`"",
    "DINOBRAIN_AUTO_SYNC = `"1`"",
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
  return "powershell.exe -NoProfile -ExecutionPolicy Bypass -Command `"& { `$env:DINOBRAIN_DATA_DIR = $vaultLiteral; `$env:DINOBRAIN_AUTO_GROWTH = '1'; `$env:DINOBRAIN_AUTO_COMPOUND = '1'; `$env:DINOBRAIN_AUTO_SYNC = '1'; `$env:DINOBRAIN_AUTO_SYNC_ALLOW_CONDITIONAL = '0'; `$env:DINOBRAIN_AUTO_SYNC_PUSH = '0'; `$env:DINOBRAIN_HOOK_AUTO_SYNC = '1'; & $hookLiteral }`""
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
    timeout = 30
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
    timeout = 30
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
if (-not $gitAvailable) {
  Write-Warning "Git was not found on PATH. DinoBrain will use GitHub ZIP fallback for fresh installs. Install Git later for repo updates and git_sync backup workflows."
}

Sync-DinoBrainRepo -Name "dinobrain" -RepoUrl $AppRepo -TargetDir $AppDir -Ref $AppRef -Token $archiveToken -AllowOriginChange:$Force
Sync-DinoBrainRepo -Name "dinobrain-data" -RepoUrl $DataRepo -TargetDir $DataDir -Ref $DataRef -Token $archiveToken -AllowOriginChange:$Force
if ($gitAvailable) {
  Assert-DinoBrainRepoAligned -Name "dinobrain" -TargetDir $AppDir -Ref $AppRef
  Assert-DinoBrainRepoAligned -Name "dinobrain-data" -TargetDir $DataDir -Ref $DataRef
  Enable-DinoBrainDataGitHooks -DataDir $DataDir
}

$nodeRoot = Install-PortableNode -Version $NodeVersion -DestinationRoot $ToolsDir
$nodeExe = Join-Path $nodeRoot "node.exe"
$npmCmd = Join-Path $nodeRoot "npm.cmd"

Invoke-WithPortableNode -NodeRoot $nodeRoot -FilePath $npmCmd -ArgumentList @("install") -WorkingDirectory $AppDir
Invoke-WithPortableNode -NodeRoot $nodeRoot -FilePath $npmCmd -ArgumentList @("run", "build") -WorkingDirectory $AppDir
$oldDataRoot = $env:DINOBRAIN_DATA_DIR
$env:DINOBRAIN_DATA_DIR = $DataDir
try {
  Invoke-WithPortableNode -NodeRoot $nodeRoot -FilePath $npmCmd -ArgumentList @("run", "index:sqlite") -WorkingDirectory $AppDir
  if (-not $SkipSemanticRagPrewarm) {
    Invoke-DinoBrainSemanticRagPrewarm -NodeRoot $nodeRoot -AppPath $AppDir -VaultPath $DataDir
  }
  if ($gitAvailable) {
    Invoke-WithPortableNode -NodeRoot $nodeRoot -FilePath $npmCmd -ArgumentList @("run", "hooks:data:verify") -WorkingDirectory $AppDir
  }
} finally {
  if ($null -eq $oldDataRoot) { Remove-Item Env:\DINOBRAIN_DATA_DIR -ErrorAction SilentlyContinue } else { $env:DINOBRAIN_DATA_DIR = $oldDataRoot }
}

if (-not $SkipCodexConfig) {
  Set-DinoBrainCodexConfig -ConfigPath $CodexConfigPath -NodeExe $nodeExe -ServerEntry (Join-Path $AppDir "dist\index.js") -VaultPath $DataDir -EnableHooks:(-not $SkipCodexHookConfig)
}

if (-not $SkipCodexHookConfig) {
  Set-DinoBrainCodexUserHook -HooksPath $CodexHooksPath -AppPath $AppDir -VaultPath $DataDir
  Invoke-DinoBrainCodexHookHandshake -AppPath $AppDir -VaultPath $DataDir -NodeExe $nodeExe
}

$codexManagedHookConfigured = $false
if (-not $SkipCodexHookConfig -and -not $SkipCodexManagedHookConfig) {
  $codexManagedHookConfigured = Invoke-DinoBrainCodexManagedHookInstall -AppPath $AppDir -VaultPath $DataDir -RequirementsPath $CodexRequirementsPath -ManagedDir $CodexManagedHookDir
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
$privateRecoveryLaunchers = New-DinoBrainPrivateRecoveryLaunchers -InstallRoot $InstallRoot -AppPath $AppDir -VaultPath $DataDir -NodeRoot $nodeRoot
$uninstallLaunchers = New-DinoBrainUninstallLauncher -InstallRoot $InstallRoot -AppPath $AppDir -VaultPath $DataDir -ToolsDir $ToolsDir -ConfigPath $CodexConfigPath -HooksPath $CodexHooksPath -RequirementsPath $CodexRequirementsPath -ManagedHookDir $CodexManagedHookDir -ClaudeCommand $ClaudeCommand

$claudeCodeConfigured = $false
$claudePromptHookConfigured = $false
if (-not $SkipClaudeCodeConfig) {
  Set-DinoBrainClaudeUserHook -SettingsPath $ClaudeSettingsPath -AppPath $AppDir -VaultPath $DataDir
  $claudePromptHookConfigured = $true
  $claudeCodeConfigured = Set-DinoBrainClaudeCodeConfig -ClaudeCommand $ClaudeCommand -Scope $ClaudeScope -NodeExe $nodeExe -ServerEntry (Join-Path $AppDir "dist\index.js") -VaultPath $DataDir -WorkingDirectory $AppDir
}

if (-not $SkipVerify) {
  Invoke-DinoBrainVerify -NodeRoot $nodeRoot -AppPath $AppDir -ConfigPath $CodexConfigPath -HooksPath $CodexHooksPath -RequirementsPath $CodexRequirementsPath -VaultPath $DataDir -ClaudeCommand $ClaudeCommand -ClaudeSettingsPath $ClaudeSettingsPath -RequireCodexUserHook:(-not $SkipCodexHookConfig) -RequireCodexManagedHook:$codexManagedHookConfigured -RequireClaudeCode:$claudeCodeConfigured -RequireClaudePromptHook:$claudePromptHookConfigured -AllowNoGit:(-not $gitAvailable)
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
foreach ($launcher in $privateRecoveryLaunchers) {
  Write-Host "Private recovery launcher: $launcher"
}
foreach ($launcher in $uninstallLaunchers) {
  Write-Host "Uninstall launcher: $launcher"
}
Write-Host "Claude Code MCP scope: $ClaudeScope"
