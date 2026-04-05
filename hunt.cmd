@echo off
cd /d "%~dp0"
if exist ".venv\Scripts\python.exe" (
  ".venv\Scripts\python.exe" "scripts\huntctl.py" %*
) else if exist "venv\Scripts\python.exe" (
  "venv\Scripts\python.exe" "scripts\huntctl.py" %*
) else (
  python "scripts\huntctl.py" %*
)
