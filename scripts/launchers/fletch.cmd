@echo off
cd /d "%~dp0\..\.."

if exist ".venv\Scripts\python.exe" (
  ".venv\Scripts\python.exe" "scripts\fletchctl.py" %*
) else if exist "venv\Scripts\python.exe" (
  "venv\Scripts\python.exe" "scripts\fletchctl.py" %*
) else (
  python "scripts\fletchctl.py" %*
)
exit /b %ERRORLEVEL%
