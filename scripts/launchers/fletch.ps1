Set-Location (Join-Path $PSScriptRoot "..\..") -ErrorAction Stop

if (Test-Path ".venv\Scripts\python.exe") {
    & ".venv\Scripts\python.exe" "scripts\fletchctl.py" @args
}
elseif (Test-Path "venv\Scripts\python.exe") {
    & "venv\Scripts\python.exe" "scripts\fletchctl.py" @args
}
else {
    python "scripts\fletchctl.py" @args
}
exit $LASTEXITCODE

