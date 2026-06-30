#Requires -Version 5.1
$installScript = Join-Path $PSScriptRoot "install.ps1"
& $installScript -Force @args
