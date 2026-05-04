Set-Location $PSScriptRoot -ErrorAction Stop
& ".\scripts\launchers\ui.ps1" @args
exit $LASTEXITCODE

