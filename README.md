# Hunt - Job Scraper

Scrapes job postings from multiple job boards (Indeed, LinkedIn, Glassdoor) and stores them in a local SQLite database for tracking applications.

## Setup

Requires Python 3.12 or 3.13 (3.14 is not supported due to dependency issues).

```bash
# Create a virtual environment if not on 3.12 or 3.13 already
py -3.13 -m venv venv
Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned
.\venv\Scripts\Activate

pip install -r requirements.txt
pip install python-jobspy --no-deps

# Run the scraper
python scraper.py
```
