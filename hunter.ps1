Set-Location $PSScriptRoot -ErrorAction Stop
& ".\scripts\launchers\hunter.ps1" @args
exit $LASTEXITCODE
