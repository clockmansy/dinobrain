#Requires -Version 5.1
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$AppPath,
  [Parameter(Mandatory = $true)][string]$VaultPath,
  [Parameter(Mandatory = $true)][string]$NodeExe,
  [string]$TaskName = "DinoBrain Local Encrypted Backup",
  [ValidatePattern("^([01]\d|2[0-3]):[0-5]\d$")][string]$DailyAt = "03:30"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$app = [System.IO.Path]::GetFullPath($AppPath)
$vault = [System.IO.Path]::GetFullPath($VaultPath)
$node = [System.IO.Path]::GetFullPath($NodeExe)
$cycle = Join-Path $app "scripts\run-local-backup-cycle.ps1"
if (-not (Test-Path -LiteralPath $cycle -PathType Leaf)) { throw "Backup cycle script not found: $cycle" }

$taskArguments = @(
  "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden",
  "-File", ('"{0}"' -f $cycle),
  "-AppPath", ('"{0}"' -f $app),
  "-VaultPath", ('"{0}"' -f $vault),
  "-NodeExe", ('"{0}"' -f $node)
) -join " "
$action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument $taskArguments
$trigger = New-ScheduledTaskTrigger -Daily -At $DailyAt
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Hours 4)
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Description "Encrypted local DinoBrain backup with authenticated restore verification" -Force | Out-Null
Write-Host "Scheduled daily encrypted backup: $TaskName at $DailyAt"
