# Hunt

Automated Hunt runtime. Today it primarily covers Component 1 discovery and enrichment, with later Components 2 through 4 planned on top of the same system.

Current focus:
- finish Component 1 first
- enrich LinkedIn jobs with full descriptions and real external application URLs
- classify and exclude LinkedIn Easy Apply jobs

## Setup (Ubuntu)

```bash
git clone <repo> ~/hunt && cd ~/hunt
python3 -m venv venv && source venv/bin/activate
pip install -r scraper/requirements.txt
```

Edit `tools/legacy/hunt.service`: set `User=` to your server username, then:

```bash
sudo cp tools/legacy/hunt.service /etc/systemd/system/hunt.service
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
- `SEARCH_TERMS` : what to search
- `HOURS_OLD` : how far back to look (default 24h)
- `RUN_INTERVAL_SECONDS` : time between runs (default 600 = 10min)
- `WATCHLIST` : companies you want to apply to manually (flagged as `priority=1`, ignored by agents)
- `TITLE_BLACKLIST` : job titles to filter out

## Agents

See `agents/system_prompt.md` for the full agent contract (DB schema, status lifecycle, claim pattern).

## Planning Docs

- Repo-local instructions: `AGENTS.md`
- System roadmap: `docs/roadmap.md`
- Component docs index: `docs/components/README.md`
- Component 1 LinkedIn enrichment plan: `docs/components/component1/README.md`
- Component 2 resume tailoring plan: `docs/components/component2/README.md`
- Component 3 browser autofill plan: `docs/components/component3/README.md`
- Component 4 orchestration plan: `docs/components/component4/README.md`

Repo homes for later components:
- `resume_tailor/` for Component 2 source and contracts
- `apply_extension/` for Component 3 source and fixtures
- `orchestration/` for Component 4 source and contracts

## Legacy Helpers

Older one-off setup and run helpers now live under:
- `tools/legacy/run.bat`
- `tools/legacy/run.sh`
- `tools/legacy/run_scheduled.bat`
- `tools/legacy/setup.bat`
- `tools/legacy/hunt.service`

The preferred modern entrypoints are:
- `.\hunt.ps1`
- `hunt.cmd`
- `./hunt.sh`
