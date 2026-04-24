@echo off
cd /d "%~dp0\..\.."
if exist ".venv\Scripts\python.exe" (
  ".venv\Scripts\python.exe" "scripts\uictl.py" %*
) else if exist "venv\Scripts\python.exe" (
  "venv\Scripts\python.exe" "scripts\uictl.py" %*
) else (
  python "scripts\uictl.py" %*
)

