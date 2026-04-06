$ErrorActionPreference = "Stop"
Set-Location (Join-Path $PSScriptRoot "..\..")

if (Test-Path ".venv\Scripts\python.exe") {
    & ".venv\Scripts\python.exe" "scripts\huntctl.py" @args
}
elseif (Test-Path "venv\Scripts\python.exe") {
    & "venv\Scripts\python.exe" "scripts\huntctl.py" @args
}
else {
    python "scripts\huntctl.py" @args
}
