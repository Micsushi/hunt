$ErrorActionPreference = "Continue"
Set-Location (Join-Path $PSScriptRoot "..\..") -ErrorAction Stop

if (Test-Path ".venv\Scripts\python.exe") {
    & ".venv\Scripts\python.exe" "scripts\uictl.py" @args
}
elseif (Test-Path "venv\Scripts\python.exe") {
    & "venv\Scripts\python.exe" "scripts\uictl.py" @args
}
else {
    python "scripts\uictl.py" @args
}
exit $LASTEXITCODE

