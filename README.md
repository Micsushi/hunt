# Hunt - Job Scraper

Scrapes job postings from multiple job boards (Indeed, LinkedIn, Glassdoor) and stores them in a local SQLite database for tracking applications.

## Project Structure

```
hunt/
  hunt.db              # SQLite database (auto-created, gitignored)
  setup.bat            # One-time setup
  run.bat              # Run scraper interactively
  run_scheduled.bat    # Run scraper via Task Scheduler
  scraper/
    scraper.py         # Main scraping logic
    db.py              # Database layer
    config.py          # Search terms, filters, watchlist
    requirements.txt   # Python dependencies
```

## Setup

Requires Python 3.12 or 3.13 (3.14 is not supported due to dependency issues).

### Windows (quick)

```bash
.\setup.bat
.\run.bat
```

### Manual setup (any OS)

```bash
# Create virtual environment
python3 -m venv venv

# Activate it
# Windows PowerShell:
.\venv\Scripts\Activate
# macOS/Linux:
source venv/bin/activate

# Install dependencies
pip install -r scraper\requirements.txt
pip install python-jobspy --no-deps

# Run the scraper
python scraper\scraper.py
```

## Scheduled Runs

To automatically scrape every day at noon, register a Windows Task Scheduler task:

```bash
schtasks /create /tn "HuntScraper" /tr "C:\path\to\hunt\run_scheduled.bat" /sc daily /st 12:00
```

Replace `C:\path\to\hunt\` with the actual path to this project.

Manage the task:

```bash
schtasks /query /tn "HuntScraper"       # Check status
schtasks /run /tn "HuntScraper"         # Run manually
schtasks /delete /tn "HuntScraper" /f   # Remove
```

> The task runs under your user account in interactive mode. Your PC must be on and you must be logged in at the scheduled time.
