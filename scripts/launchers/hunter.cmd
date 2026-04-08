@echo off
cd /d "%~dp0\..\.."
if exist ".venv\Scripts\python.exe" (
  ".venv\Scripts\python.exe" "scripts\hunterctl.py" %*
) else if exist "venv\Scripts\python.exe" (
  "venv\Scripts\python.exe" "scripts\hunterctl.py" %*
) else (
  python "scripts\hunterctl.py" %*
)
