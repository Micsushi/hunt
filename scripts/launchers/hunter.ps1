$ErrorActionPreference = "Continue"
Set-Location (Join-Path $PSScriptRoot "..\..") -ErrorAction Stop

if (Test-Path ".venv\Scripts\python.exe") {
    & ".venv\Scripts\python.exe" "scripts\hunterctl.py" @args
}
elseif (Test-Path "venv\Scripts\python.exe") {
    & "venv\Scripts\python.exe" "scripts\hunterctl.py" @args
}
else {
    python "scripts\hunterctl.py" @args
}
exit $LASTEXITCODE
