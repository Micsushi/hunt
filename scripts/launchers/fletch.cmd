@echo off
cd /d "%~dp0\..\.."

if exist ".venv\Scripts\python.exe" (
  ".venv\Scripts\python.exe" "scripts\fletchctl.py" %*
  exit /b %ERRORLEVEL%
)
if exist "venv\Scripts\python.exe" (
  "venv\Scripts\python.exe" "scripts\fletchctl.py" %*
  exit /b %ERRORLEVEL%
)
python "scripts\fletchctl.py" %*

