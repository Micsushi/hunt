# Hunt : CLI conventions (`hunter` / `hunterctl` / `fletch`)

This doc is the contract for **operator-facing commands** so C1–C4 stay consistent as the repo grows.

The **Hunt** repo is the whole product; repo-root **`hunter`** launchers and **`hunterctl`** are scoped to **C1 (Hunter)** and shared operator glue, not “everything named Hunt.”

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

## Conventions for **future** C2, C3, C4 commands

When you add automation an operator runs from the repo (not the extension popup, not OpenClaw-only), follow this pattern.

1. **Implement in the correct component CLI**  
   - C1: add a subparser to **`scripts/hunterctl.py`**.  
   - C2: add a subparser to **`scripts/fletchctl.py`** (or keep delegating to **`python -m fletcher.cli`**).

2. **Name verbs for humans**  
   Prefer short verbs : **`start`**, **`stop`**, **`restart`**, **`status`**, **`logs`**, **`enrich`**, **`tailor`** (example for C2), **`apply-prep`** (C4 already). Avoid duplicating systemd unit names in user-facing docs unless explaining internals.

3. **Document in three places**  
   - **Component README** under **`docs/components/componentN/README.md`** : a **“CLI”** subsection with examples.  
   - **`docs/C1_OPERATOR_WORKFLOW.md`** only for **C1**; for C2+ add a subsection in the relevant component doc or a short **“Operator CLI”** bullet in **`docs/roadmap.md`** when the command ships.  
   - **`AGENTS.md`** : one-line mention in the repo overview if the command is part of the default workflow.

4. **Optional : thin package CLI**  
   It is fine for **`fletcher/`**, **`coordinator/`**, etc. to keep **`python -m fletcher.cli`** or **`python -m coordinator.cli`** for library-style use. The component wrapper CLI (**`fletch`**, etc.) should call those entrypoints.

5. **Windows vs Linux**  
   If a command only makes sense on the server (systemd, Docker socket), use **`_require_linux`** and print a clear Windows message (same pattern as **`hunter restart`**).

6. **Tests**  
   Prefer a small **unit test** that the parser accepts the new subcommand and the handler builds the expected argv (patch **`subprocess.run`**), when the behavior is non-trivial.

## Related docs

- **`docs/NAMING.md`** : component IDs and folder names.  
- **`docs/C1_OPERATOR_WORKFLOW.md`** : C1 cadence and **`start` / `enrich N`**.  
- **`docs/components/component1/README.md`** : full **`hunter`** command list for C1.  
- **`AGENTS.md`** : file map including **`hunterctl.py`**.
