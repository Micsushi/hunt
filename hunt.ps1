$ErrorActionPreference = "Continue"
Set-Location $PSScriptRoot -ErrorAction Stop
& ".\scripts\launchers\hunt.ps1" @args
