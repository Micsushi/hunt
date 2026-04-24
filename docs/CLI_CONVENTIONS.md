# Hunt : CLI conventions (`hunter` / `hunterctl` / `fletch`)

Contract for operator-facing commands — keeps C1–C4 consistent as repo grows.

`hunter` launchers + `hunterctl` are scoped to **C1 (Hunter)** and shared operator glue — not “everything named Hunt.”

## Entry points

| Path | Role |
|------|------|
| **`./ui.sh`**, **`./ui.ps1`**, **`ui.cmd`** | **C0 canonical** repo-root launchers (POSIX / Windows). |
| **`./hunter.sh`**, **`./hunter.ps1`**, **`hunter.cmd`** | **C1 canonical** repo-root launchers (POSIX / Windows). |
| **`./fletch.sh`**, **`./fletch.ps1`**, **`fletch.cmd`** | **C2 canonical** repo-root launchers (POSIX / Windows). |
| **`scripts/uictl.py`** | C0 Python CLI implementation : `ui.*` launchers invoke this. |
| **`scripts/launchers/hunter.sh`** | Used by repo-root **`hunter.sh`** : picks venv Python, `cd` to repo root. |
| **`scripts/hunterctl.py`** | C1 Python CLI implementation : `hunter.*` launchers invoke this. |
| **`scripts/fletchctl.py`** | C2 Python CLI implementation : `fletch.*` launchers invoke this (delegates to `python -m fletcher.cli`). |
| **`./hunt.sh`**, **`./hunt.ps1`**, **`hunt.cmd`** | **Legacy alias** : same CLI as **`hunter.*`** (product name collision avoided in new docs). |
| **`scripts/huntctl.py`** | **Compatibility forwarder** to **`hunterctl.py`** (old scripts and muscle memory). |

**Rule:** `ui` commands are **C0-only**. `hunter` commands are **C1-only**. C2 operator commands live under **`fletch`**.

## C0 (UI / control plane) commands today

| Command | Purpose |
|---------|---------|
| **`ui serve`** | Build frontend if needed, then start the C0 control plane backend + SPA server. |
| **`ui build`** | Compile the React frontend into `frontend/dist/`. |
| **`hunter review`** | Legacy alias for **`ui serve`**. |
| **`hunter build-ui`** | Legacy alias for **`ui build`**. |

## C1 (Hunter) commands today

C1 is the most mature surface. Short narrative : **`docs/C1_OPERATOR_WORKFLOW.md`**.

| Command | Purpose |
|---------|---------|
| **`hunter start`** | Linux : enable + start **`hunt-scraper.timer`**. Windows : one **`hunter/scraper.py`** run. |
| **`hunter stop`** | Linux : disable + stop the timer. |
| **`hunter restart`** | Linux : **`daemon-reload`**, restart **`hunt-xvfb`**, restart **`hunt-scraper.timer`**. |
| **`hunter enrich N`** | Positional batch size (same as **`--limit N`**). Often **`hunter enrich 50 --source all`**. |
| **`hunter scrape`**, **`hunter queue`**, … | See **`hunter --help`** or **`docs/components/component1/README.md`** (Command Reference). |
| **`fletch run …`** | Delegate to **`python -m fletcher.cli …`** (C2). Example: `fletch run generate-job 123`. |
| **`fletch tests`** | Run C2 unit tests (including review/diff helpers). |

**`hunt <verb>`** is identical (legacy launcher). Legacy subcommand names remain valid (**`timer-start`**, **`auto-on`**, **`svc-start`**, etc.) but **prefer `start` / `stop` / `restart`** in new docs.

## Component Service APIs vs CLI

C1–C4 expose both a **CLI** (operator/terminal) and a **service API** (called by C0 backend only). Separate surfaces:

| Surface | Caller | Lives in |
|---|---|---|
| CLI (`hunter`, `fletch`, etc.) | operator, terminal, scripts | `scripts/hunterctl.py`, `scripts/fletchctl.py`, etc. |
| Service API (HTTP) | C0 `backend/app.py` only | each component's FastAPI/Flask app |

Frontend never calls service APIs directly. New UI-accessible operator action: implement as CLI command in `*ctl.py` + service API endpoint in component HTTP layer.

## Conventions for **future** C2, C3, C4 commands

New repo-level operator automation: follow this pattern.

1. **Correct CLI** — C1: subparser in `scripts/hunterctl.py`. C2: subparser in `scripts/fletchctl.py`.

2. **Short verbs** — `start`, `stop`, `restart`, `status`, `logs`, `enrich`, `tailor`, `apply-prep`. No systemd unit name duplication in user-facing docs.

3. **Docs: three places** — component README `docs/components/componentN/README.md` (CLI subsection + examples); C1 only in `docs/C1_OPERATOR_WORKFLOW.md`; `AGENTS.md` one-liner if part of default workflow.

4. **Thin package CLI optional** — `fletcher/`, `coordinator/` etc. can keep `python -m fletcher.cli` for library use; wrapper CLI (`fletch`) calls those.

5. **Windows vs Linux** — server-only commands (systemd, Docker): use `_require_linux`, print clear Windows message.

6. **Tests** — small unit test: parser accepts subcommand, handler builds expected argv (patch `subprocess.run`).

## Related docs

- **`docs/NAMING.md`** : component IDs and folder names.  
- **`docs/C1_OPERATOR_WORKFLOW.md`** : C1 cadence and **`start` / `enrich N`**.  
- **`docs/components/component1/README.md`** : full **`hunter`** command list for C1.  
- **`AGENTS.md`** : file map including **`hunterctl.py`**.
