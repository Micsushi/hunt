# Hunt

Automated Hunt runtime. Today it primarily covers **C1 (Hunter)** discovery and enrichment, with **C2 (Trapper)**, **C3 (Executioner)**, and **C4 (Coordinator)** planned on top of the same system.

**Names and folders:** see **`docs/NAMING.md`** (C1 code is the **`hunter`** package; **`hunter/scraper.py`** is the discovery script name only).

Current focus:
- finish C1 (Hunter) first
- enrich LinkedIn jobs with full descriptions and real external application URLs
- classify LinkedIn Easy Apply jobs (`easy_apply`, not auto-apply eligible) for downstream automation

## C1 (Hunter) v0.1 : how it runs (~every 10 minutes)

**Operator-friendly narrative** (discovery → enrichment → review) lives in **`docs/C1_OPERATOR_WORKFLOW.md`**. In short:

- **Discovery** : **JobSpy** fetches recent **LinkedIn** and **Indeed** listings for your search terms; rows land in **SQLite** as **`pending`** enrichment when the board is supported. Indeed matching is loose; LinkedIn listing payloads are often thin until enrichment.
- **Enrichment** : **Playwright** (and related workers) process the queue **by `source`** (**LinkedIn first**, then **Indeed**), **in batches** per run, usually **headless**. **LinkedIn** needs **auth** (saved session and/or env credentials). **Easy Apply** is **detected and labeled** so later automation ignores it as an external apply target. Optional **headful** rerun for blocked rows when **`ENRICHMENT_UI_VERIFY_BLOCKED`** is enabled (often on **Xvfb** on servers).
- **Review** : **`review_app.py`** : filter, sort, search jobs, errors, and artifacts over the same DB.

## Component Versions

This repo is organized around four long-term components.

| Component | Name | Version | Status |
|---|---|---:|---|
| C1 (Hunter) | discovery + enrichment (`hunter/` package) | 0.1 | functional, polishing Stage 4 ops |
| C2 (Trapper) | resume tailoring (`trapper/`) | 0.0 | planned / local-only checkpoint |
| C3 (Executioner) | browser extension: autofill + apply assist | 0.0 | planned / local-only checkpoint |
| C4 (Coordinator) | orchestration + submit control (`coordinator/`) | 0.0 | planned / partial local checkpoint |

## Setup (Ubuntu)

```bash
git clone <repo> ~/hunt && cd ~/hunt
python3 -m venv venv && source venv/bin/activate
pip install -r hunter/requirements.txt
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
python hunter/scraper.py        # single run
python hunter/runner.py         # continuous loop
```

## Config

Edit `hunter/config.py`:
- `SEARCH_TERMS` : what to search
- `HOURS_OLD` : how far back to look (default 24h)
- `RUN_INTERVAL_SECONDS` : time between runs (default 600 = 10min)
- `WATCHLIST` : companies you want to apply to manually (flagged as `priority=1`, ignored by agents)
- `TITLE_BLACKLIST` : job titles to filter out

## Agents

See `agents/system_prompt.md` for the full agent contract (DB schema, status lifecycle, claim pattern).

## Planning Docs

- **Component IDs and code names:** `docs/NAMING.md` (C1 Hunter, C2 Trapper, C3 Executioner, C4 Coordinator)
- Repo-local instructions: `AGENTS.md`
- System roadmap: `docs/roadmap.md`
- Version roadmap (draft): `docs/VERSIONS.md`
- C1 operator workflow (discovery / enrichment / review): `docs/C1_OPERATOR_WORKFLOW.md`
- Local testing guide: `docs/LOCAL_TESTING.md`
- Live fix tracker: `todo.md`
- Component docs index: `docs/components/README.md`
- **C1 (Hunter)** plan: `docs/components/component1/README.md`
- **C2 (Trapper)** plan: `docs/components/component2/README.md`
- **C3 (Executioner)** plan: `docs/components/component3/README.md`
- **C4 (Coordinator)** plan: `docs/components/component4/README.md`

Repo homes by component:
- `hunter/` : **C1 (Hunter)** runtime package (discovery script: `hunter/scraper.py`)
- `trapper/` : **C2 (Trapper)** source and contracts
- `executioner/` : **C3 (Executioner)** source and fixtures
- `coordinator/` : **C4 (Coordinator)** source and contracts

Current local checkpoint for later components:
- `trapper/` now contains an initial local **C2 (Trapper)** pipeline and DB wiring
- `executioner/` now contains an initial local **C3 (Executioner)** Workday extension implementation
- `coordinator/` now contains an initial local **C4 (Coordinator)** readiness/apply-prep/runtime skeleton

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
