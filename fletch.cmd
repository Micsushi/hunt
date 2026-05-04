@echo off
cd /d "%~dp0"
call ".\scripts\launchers\fletch.cmd" %*
exit /b %ERRORLEVEL%

