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
  [string]$ClaudeCommand = "claude",
  [ValidateSet("local", "project", "user")]
  [string]$ClaudeScope = "user",
  [switch]$SkipCodexConfig,
  [switch]$SkipCodexHookConfig,
  [switch]$SkipClaudeCodeConfig,
  [switch]$SkipVerify,
  [switch]$Force
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Get-DefaultInstallRoot {
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

function Get-FullPath {
  param([Parameter(Mandatory = $true)][string]$PathValue)
  $expanded = [Environment]::ExpandEnvironmentVariables($PathValue)
  if ([System.IO.Path]::IsPathRooted($expanded)) {
    return [System.IO.Path]::GetFullPath($expanded)
  }
  return [System.IO.Path]::GetFullPath((Join-Path (Get-Location).Path $expanded))
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
    $content = [System.IO.File]::ReadAllText($ConfigPath)
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
    ""
  ) -join "`r`n"

  $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($ConfigPath, $content + $block, $utf8NoBom)
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
  return "powershell.exe -NoProfile -ExecutionPolicy Bypass -Command `"& { `$env:DINOBRAIN_DATA_DIR = $vaultLiteral; & $hookLiteral }`""
}

function Test-DinoBrainHookGroup {
  param([AllowNull()][object]$Group)
  if ($null -eq $Group) { return $false }
  $text = ($Group | ConvertTo-Json -Depth 20 -Compress)
  return $text -match "dinobrain-user-prompt-hook\.ps1" -or $text -match "Loading DinoBrain context"
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
    $groups = @(@($config["hooks"]["UserPromptSubmit"]) | Where-Object { -not (Test-DinoBrainHookGroup $_) })
  }

  $command = New-DinoBrainCodexHookCommand -AppPath $AppPath -VaultPath $VaultPath
  $groups += [ordered]@{
    hooks = @(
      [ordered]@{
        type = "command"
        command = $command
        commandWindows = $command
        timeout = 30
        statusMessage = "Loading DinoBrain context"
      }
    )
  }
  $config["hooks"]["UserPromptSubmit"] = @($groups)

  $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($HooksPath, ($config | ConvertTo-Json -Depth 40) + "`r`n", $utf8NoBom)
  if ($backupPath) {
    Write-Host "Codex user hooks backup: $backupPath"
  }
  Write-Host "Codex user hook registered: $HooksPath"
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
  $env:DINOBRAIN_DATA_DIR = $VaultPath
  $env:DINOBRAIN_NODE_EXE = $NodeExe
  $env:DINOBRAIN_HOOK_PROJECT = "dinobrain-installer"
  $env:DINOBRAIN_HOOK_IMPORT_SESSION = "0"
  $env:DINOBRAIN_HOOK_CONTEXT_LIMIT = "3"
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
    [Parameter(Mandatory = $true)][string]$HooksPath
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
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$diagnoseScript" -AppPath "$AppPath" -VaultPath "$VaultPath" -HooksPath "$HooksPath" -ConfigPath "$ConfigPath" -NodeExe "$nodeExe"
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

function New-DinoBrainUninstallLauncher {
  param(
    [Parameter(Mandatory = $true)][string]$InstallRoot,
    [Parameter(Mandatory = $true)][string]$AppPath,
    [Parameter(Mandatory = $true)][string]$VaultPath,
    [Parameter(Mandatory = $true)][string]$ToolsDir,
    [Parameter(Mandatory = $true)][string]$ConfigPath,
    [Parameter(Mandatory = $true)][string]$HooksPath,
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
start "DinoBrain Uninstall" powershell.exe -NoProfile -ExecutionPolicy Bypass -NoExit -File "%TMP_SCRIPT%" -InstallRoot "$InstallRoot" -AppDir "$AppPath" -DataDir "$VaultPath" -ToolsDir "$ToolsDir" -CodexConfigPath "$ConfigPath" -CodexHooksPath "$HooksPath" -ClaudeCommand "$ClaudeCommand" -Purge
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
    [Parameter(Mandatory = $true)][string]$VaultPath,
    [Parameter(Mandatory = $true)][string]$ClaudeCommand,
    [switch]$RequireCodexUserHook,
    [switch]$RequireClaudeCode,
    [switch]$AllowNoGit
  )

  $npmCmd = Join-Path $NodeRoot "npm.cmd"
  $oldConfig = $env:DINOBRAIN_CODEX_CONFIG_PATH
  $oldHooks = $env:DINOBRAIN_CODEX_HOOKS_PATH
  $oldRequireHook = $env:DINOBRAIN_REQUIRE_CODEX_USER_HOOK
  $oldData = $env:DINOBRAIN_DATA_DIR
  $oldClaudeCommand = $env:DINOBRAIN_CLAUDE_COMMAND
  $oldRequireClaude = $env:DINOBRAIN_REQUIRE_CLAUDE_CODE
  $oldAllowNoGit = $env:DINOBRAIN_ALLOW_NO_GIT
  $oldPath = $env:PATH
  $env:DINOBRAIN_CODEX_CONFIG_PATH = $ConfigPath
  $env:DINOBRAIN_CODEX_HOOKS_PATH = $HooksPath
  if ($RequireCodexUserHook) { $env:DINOBRAIN_REQUIRE_CODEX_USER_HOOK = "1" } else { Remove-Item Env:\DINOBRAIN_REQUIRE_CODEX_USER_HOOK -ErrorAction SilentlyContinue }
  $env:DINOBRAIN_DATA_DIR = $VaultPath
  $env:DINOBRAIN_CLAUDE_COMMAND = $ClaudeCommand
  if ($RequireClaudeCode) { $env:DINOBRAIN_REQUIRE_CLAUDE_CODE = "1" } else { Remove-Item Env:\DINOBRAIN_REQUIRE_CLAUDE_CODE -ErrorAction SilentlyContinue }
  if ($AllowNoGit) { $env:DINOBRAIN_ALLOW_NO_GIT = "1" } else { Remove-Item Env:\DINOBRAIN_ALLOW_NO_GIT -ErrorAction SilentlyContinue }
  $env:PATH = "$NodeRoot;$oldPath"
  try {
    Invoke-NativeCommand -FilePath $npmCmd -ArgumentList @("run", "verify:os") -WorkingDirectory $AppPath
  } finally {
    if ($null -eq $oldConfig) { Remove-Item Env:\DINOBRAIN_CODEX_CONFIG_PATH -ErrorAction SilentlyContinue } else { $env:DINOBRAIN_CODEX_CONFIG_PATH = $oldConfig }
    if ($null -eq $oldHooks) { Remove-Item Env:\DINOBRAIN_CODEX_HOOKS_PATH -ErrorAction SilentlyContinue } else { $env:DINOBRAIN_CODEX_HOOKS_PATH = $oldHooks }
    if ($null -eq $oldRequireHook) { Remove-Item Env:\DINOBRAIN_REQUIRE_CODEX_USER_HOOK -ErrorAction SilentlyContinue } else { $env:DINOBRAIN_REQUIRE_CODEX_USER_HOOK = $oldRequireHook }
    if ($null -eq $oldData) { Remove-Item Env:\DINOBRAIN_DATA_DIR -ErrorAction SilentlyContinue } else { $env:DINOBRAIN_DATA_DIR = $oldData }
    if ($null -eq $oldClaudeCommand) { Remove-Item Env:\DINOBRAIN_CLAUDE_COMMAND -ErrorAction SilentlyContinue } else { $env:DINOBRAIN_CLAUDE_COMMAND = $oldClaudeCommand }
    if ($null -eq $oldRequireClaude) { Remove-Item Env:\DINOBRAIN_REQUIRE_CLAUDE_CODE -ErrorAction SilentlyContinue } else { $env:DINOBRAIN_REQUIRE_CLAUDE_CODE = $oldRequireClaude }
    if ($null -eq $oldAllowNoGit) { Remove-Item Env:\DINOBRAIN_ALLOW_NO_GIT -ErrorAction SilentlyContinue } else { $env:DINOBRAIN_ALLOW_NO_GIT = $oldAllowNoGit }
    $env:PATH = $oldPath
  }
}

if ([string]::IsNullOrWhiteSpace($InstallRoot)) { $InstallRoot = Get-DefaultInstallRoot }
if ([string]::IsNullOrWhiteSpace($ToolsDir)) { $ToolsDir = Get-DefaultToolsDir }
if ([string]::IsNullOrWhiteSpace($CodexConfigPath)) { $CodexConfigPath = Join-Path $HOME ".codex\config.toml" }
if ([string]::IsNullOrWhiteSpace($CodexHooksPath)) { $CodexHooksPath = Join-Path $HOME ".codex\hooks.json" }
if ([string]::IsNullOrWhiteSpace($AppDir)) { $AppDir = Join-Path $InstallRoot "dinobrain" }
if ([string]::IsNullOrWhiteSpace($DataDir)) { $DataDir = Join-Path $InstallRoot "dinobrain-data" }

$InstallRoot = Get-FullPath $InstallRoot
$AppDir = Get-FullPath $AppDir
$DataDir = Get-FullPath $DataDir
$ToolsDir = Get-FullPath $ToolsDir
$CodexConfigPath = Get-FullPath $CodexConfigPath
$CodexHooksPath = Get-FullPath $CodexHooksPath

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

$observatoryLaunchers = New-DinoBrainObservatoryLauncher -InstallRoot $InstallRoot -AppPath $AppDir -VaultPath $DataDir -NodeRoot $nodeRoot
$hookDiagnoseLaunchers = New-DinoBrainHookDiagnoseLauncher -InstallRoot $InstallRoot -AppPath $AppDir -VaultPath $DataDir -NodeRoot $nodeRoot -ConfigPath $CodexConfigPath -HooksPath $CodexHooksPath
$uninstallLaunchers = New-DinoBrainUninstallLauncher -InstallRoot $InstallRoot -AppPath $AppDir -VaultPath $DataDir -ToolsDir $ToolsDir -ConfigPath $CodexConfigPath -HooksPath $CodexHooksPath -ClaudeCommand $ClaudeCommand

$claudeCodeConfigured = $false
if (-not $SkipClaudeCodeConfig) {
  $claudeCodeConfigured = Set-DinoBrainClaudeCodeConfig -ClaudeCommand $ClaudeCommand -Scope $ClaudeScope -NodeExe $nodeExe -ServerEntry (Join-Path $AppDir "dist\index.js") -VaultPath $DataDir -WorkingDirectory $AppDir
}

if (-not $SkipVerify) {
  Invoke-DinoBrainVerify -NodeRoot $nodeRoot -AppPath $AppDir -ConfigPath $CodexConfigPath -HooksPath $CodexHooksPath -VaultPath $DataDir -ClaudeCommand $ClaudeCommand -RequireCodexUserHook:(-not $SkipCodexHookConfig) -RequireClaudeCode:$claudeCodeConfigured -AllowNoGit:(-not $gitAvailable)
}

Write-Host ""
Write-Host "DinoBrain install complete."
Write-Host "App: $AppDir"
Write-Host "Data: $DataDir"
Write-Host "Node: $nodeExe"
Write-Host "Codex config: $CodexConfigPath"
Write-Host "Codex user hooks: $CodexHooksPath"
foreach ($launcher in $observatoryLaunchers) {
  Write-Host "Observatory launcher: $launcher"
}
foreach ($launcher in $hookDiagnoseLaunchers) {
  Write-Host "Hook diagnose launcher: $launcher"
}
foreach ($launcher in $uninstallLaunchers) {
  Write-Host "Uninstall launcher: $launcher"
}
Write-Host "Claude Code MCP scope: $ClaudeScope"
