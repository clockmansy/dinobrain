#Requires -Version 5.1
[CmdletBinding()]
param(
  [string]$InstallRoot = "",
  [string]$AppRepo = "https://github.com/clockmansy/dinobrain.git",
  [string]$DataRepo = "https://github.com/clockmansy/dinobrain-data.git",
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
    $output = & $FilePath @ArgumentList 2>&1
    return [pscustomobject]@{
      ExitCode = $LASTEXITCODE
      Output = ($output -join "`n")
    }
  } finally {
    Pop-Location
  }
}

function Sync-DinoBrainRepo {
  param(
    [Parameter(Mandatory = $true)][string]$Name,
    [Parameter(Mandatory = $true)][string]$RepoUrl,
    [Parameter(Mandatory = $true)][string]$TargetDir,
    [switch]$AllowOriginChange
  )

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

    Invoke-NativeCommand -FilePath "git" -ArgumentList @("-C", $TargetDir, "fetch", "origin", "--prune") -WorkingDirectory $TargetDir
    Invoke-NativeCommand -FilePath "git" -ArgumentList @("-C", $TargetDir, "pull", "--ff-only", "origin", "main") -WorkingDirectory $TargetDir
    return
  }

  $parent = Split-Path -Parent $TargetDir
  New-Item -ItemType Directory -Force -Path $parent | Out-Null
  Invoke-NativeCommand -FilePath "git" -ArgumentList @("clone", $RepoUrl, $TargetDir) -WorkingDirectory $parent
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
  if ($Value.PSObject -and $Value.PSObject.Properties.Count -gt 0 -and $Value.GetType().Name -eq "PSCustomObject") {
    $result = [ordered]@{}
    foreach ($property in $Value.PSObject.Properties) {
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

function Set-DinoBrainCodexConfig {
  param(
    [Parameter(Mandatory = $true)][string]$ConfigPath,
    [Parameter(Mandatory = $true)][string]$NodeExe,
    [Parameter(Mandatory = $true)][string]$ServerEntry,
    [Parameter(Mandatory = $true)][string]$VaultPath
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
    $groups = @($config["hooks"]["UserPromptSubmit"]) | Where-Object { -not (Test-DinoBrainHookGroup $_) }
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
  ) -WorkingDirectory $WorkingDirectory

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
    [switch]$RequireClaudeCode
  )

  $npmCmd = Join-Path $NodeRoot "npm.cmd"
  $oldConfig = $env:DINOBRAIN_CODEX_CONFIG_PATH
  $oldHooks = $env:DINOBRAIN_CODEX_HOOKS_PATH
  $oldRequireHook = $env:DINOBRAIN_REQUIRE_CODEX_USER_HOOK
  $oldData = $env:DINOBRAIN_DATA_DIR
  $oldClaudeCommand = $env:DINOBRAIN_CLAUDE_COMMAND
  $oldRequireClaude = $env:DINOBRAIN_REQUIRE_CLAUDE_CODE
  $oldPath = $env:PATH
  $env:DINOBRAIN_CODEX_CONFIG_PATH = $ConfigPath
  $env:DINOBRAIN_CODEX_HOOKS_PATH = $HooksPath
  if ($RequireCodexUserHook) { $env:DINOBRAIN_REQUIRE_CODEX_USER_HOOK = "1" } else { Remove-Item Env:\DINOBRAIN_REQUIRE_CODEX_USER_HOOK -ErrorAction SilentlyContinue }
  $env:DINOBRAIN_DATA_DIR = $VaultPath
  $env:DINOBRAIN_CLAUDE_COMMAND = $ClaudeCommand
  if ($RequireClaudeCode) { $env:DINOBRAIN_REQUIRE_CLAUDE_CODE = "1" } else { Remove-Item Env:\DINOBRAIN_REQUIRE_CLAUDE_CODE -ErrorAction SilentlyContinue }
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

Assert-Command "git"

Sync-DinoBrainRepo -Name "dinobrain" -RepoUrl $AppRepo -TargetDir $AppDir -AllowOriginChange:$Force
Sync-DinoBrainRepo -Name "dinobrain-data" -RepoUrl $DataRepo -TargetDir $DataDir -AllowOriginChange:$Force

$nodeRoot = Install-PortableNode -Version $NodeVersion -DestinationRoot $ToolsDir
$nodeExe = Join-Path $nodeRoot "node.exe"
$npmCmd = Join-Path $nodeRoot "npm.cmd"

Invoke-WithPortableNode -NodeRoot $nodeRoot -FilePath $npmCmd -ArgumentList @("install") -WorkingDirectory $AppDir
Invoke-WithPortableNode -NodeRoot $nodeRoot -FilePath $npmCmd -ArgumentList @("run", "build") -WorkingDirectory $AppDir

if (-not $SkipCodexConfig) {
  Set-DinoBrainCodexConfig -ConfigPath $CodexConfigPath -NodeExe $nodeExe -ServerEntry (Join-Path $AppDir "dist\index.js") -VaultPath $DataDir
}

if (-not $SkipCodexHookConfig) {
  Set-DinoBrainCodexUserHook -HooksPath $CodexHooksPath -AppPath $AppDir -VaultPath $DataDir
}

$claudeCodeConfigured = $false
if (-not $SkipClaudeCodeConfig) {
  $claudeCodeConfigured = Set-DinoBrainClaudeCodeConfig -ClaudeCommand $ClaudeCommand -Scope $ClaudeScope -NodeExe $nodeExe -ServerEntry (Join-Path $AppDir "dist\index.js") -VaultPath $DataDir -WorkingDirectory $AppDir
}

if (-not $SkipVerify) {
  Invoke-DinoBrainVerify -NodeRoot $nodeRoot -AppPath $AppDir -ConfigPath $CodexConfigPath -HooksPath $CodexHooksPath -VaultPath $DataDir -ClaudeCommand $ClaudeCommand -RequireCodexUserHook:(-not $SkipCodexHookConfig) -RequireClaudeCode:$claudeCodeConfigured
}

Write-Host ""
Write-Host "DinoBrain install complete."
Write-Host "App: $AppDir"
Write-Host "Data: $DataDir"
Write-Host "Node: $nodeExe"
Write-Host "Codex config: $CodexConfigPath"
Write-Host "Codex user hooks: $CodexHooksPath"
Write-Host "Claude Code MCP scope: $ClaudeScope"
