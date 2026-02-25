@echo off
py -3.13 -m venv venv
call venv\Scripts\activate.bat
pip install -r requirements.txt
pip install python-jobspy --no-deps
echo Setup complete! Run "run.bat" to start scraping.
pause
