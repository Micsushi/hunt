Set-Location $PSScriptRoot -ErrorAction Stop
& ".\scripts\launchers\fletch.ps1" @args
exit $LASTEXITCODE

