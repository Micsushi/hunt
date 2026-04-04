# Hunt

Automated job scraper. Scrapes LinkedIn and Indeed every 10 minutes and stores results in a SQLite DB

## Setup (Ubuntu)

```bash
git clone <repo> ~/hunt && cd ~/hunt
python3 -m venv venv && source venv/bin/activate
pip install -r scraper/requirements.txt
```

Edit `hunt.service` — set `User=` to your server username, then:

```bash
sudo cp hunt.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable hunt
sudo systemctl start hunt
```

Check logs: `sudo journalctl -u hunt -f`

## Manual run

```bash
source venv/bin/activate
python scraper/scraper.py        # single run
python scraper/runner.py         # continuous loop
```

## Config

Edit `scraper/config.py`:
- `SEARCH_TERMS` — what to search
- `HOURS_OLD` — how far back to look (default 24h)
- `RUN_INTERVAL_SECONDS` — time between runs (default 600 = 10min)
- `WATCHLIST` — companies you want to apply to manually (flagged as `priority=1`, ignored by agents)
- `TITLE_BLACKLIST` — job titles to filter out

## Agents

See `agents/system_prompt.md` for the full agent contract (DB schema, status lifecycle, claim pattern).
