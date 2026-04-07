@echo off
cd /d "%~dp0\..\.."
py -3.13 -m venv venv
call venv\Scripts\activate.bat
pip install -r hunter\requirements.txt
pip install python-jobspy --no-deps
echo Setup complete! Run "tools\\legacy\\run.bat" to start scraping.
pause
