# Hunt : CLI conventions (`hunter` / `hunterctl`)

This doc is the contract for **operator-facing commands** so C1–C4 stay consistent as the repo grows.

The **Hunt** repo is the whole product; repo-root **`hunter`** launchers and **`hunterctl`** are scoped to **C1 (Hunter)** and shared operator glue, not “everything named Hunt.”

## Entry points

| Path | Role |
|------|------|
| **`./hunter.sh`**, **`./hunter.ps1`**, **`hunter.cmd`** | **Canonical** repo-root launchers (POSIX / Windows). |
| **`scripts/launchers/hunter.sh`** | Used by repo-root **`hunter.sh`** : picks venv Python, `cd` to repo root. |
| **`scripts/hunterctl.py`** | Single Python CLI implementation : all launchers invoke this with passthrough args. |
| **`./hunt.sh`**, **`./hunt.ps1`**, **`hunt.cmd`** | **Legacy alias** : same CLI as **`hunter.*`** (product name collision avoided in new docs). |
| **`scripts/huntctl.py`** | **Compatibility forwarder** to **`hunterctl.py`** (old scripts and muscle memory). |

**Rule:** Do not add a second parallel CLI framework. New verbs go into **`scripts/hunterctl.py`** (or a module it calls).

## C1 (Hunter) commands today

C1 is the most mature surface. Short narrative : **`docs/C1_OPERATOR_WORKFLOW.md`**.

| Command | Purpose |
|---------|---------|
| **`hunter start`** | Linux : enable + start **`hunt-scraper.timer`**. Windows : one **`hunter/scraper.py`** run. |
| **`hunter stop`** | Linux : disable + stop the timer. |
| **`hunter restart`** | Linux : **`daemon-reload`**, restart **`hunt-xvfb`**, restart **`hunt-scraper.timer`**. |
| **`hunter enrich N`** | Positional batch size (same as **`--limit N`**). Often **`hunter enrich 50 --source all`**. |
| **`hunter scrape`**, **`hunter queue`**, **`hunter review`**, … | See **`hunter --help`** or **`docs/components/component1/README.md`** (Command Reference). |

**`hunt <verb>`** is identical (legacy launcher). Legacy subcommand names remain valid (**`timer-start`**, **`auto-on`**, **`svc-start`**, etc.) but **prefer `start` / `stop` / `restart`** in new docs.

## Conventions for **future** C2, C3, C4 commands

When you add automation an operator runs from the repo (not the extension popup, not OpenClaw-only), follow this pattern.

1. **Implement in `hunterctl`**  
   Add a **`argparse`** subparser under **`build_parser()`** in **`scripts/hunterctl.py`**, with a **`cmd_*`** handler that builds argv and calls **`_run([PYTHON, …])`** (or **`subprocess`** for non-Python steps). Keep Linux-only server actions behind **`_require_linux`** when appropriate.

2. **Name verbs for humans**  
   Prefer short verbs : **`start`**, **`stop`**, **`restart`**, **`status`**, **`logs`**, **`enrich`**, **`tailor`** (example for C2), **`apply-prep`** (C4 already). Avoid duplicating systemd unit names in user-facing docs unless explaining internals.

3. **Document in three places**  
   - **Component README** under **`docs/components/componentN/README.md`** : a **“CLI”** subsection with examples.  
   - **`docs/C1_OPERATOR_WORKFLOW.md`** only for **C1**; for C2+ add a subsection in the relevant component doc or a short **“Operator CLI”** bullet in **`docs/roadmap.md`** when the command ships.  
   - **`AGENTS.md`** : one-line mention in the repo overview if the command is part of the default workflow.

4. **Optional : thin package CLI**  
   It is fine for **`fletcher/`**, **`coordinator/`**, etc. to keep **`python -m fletcher.cli`** or **`python -m coordinator.cli`** for library-style use. **`hunterctl`** should call those entrypoints so operators only learn **`hunter …`** (or legacy **`hunt …`**).

5. **Windows vs Linux**  
   If a command only makes sense on the server (systemd, Docker socket), use **`_require_linux`** and print a clear Windows message (same pattern as **`hunter restart`**).

6. **Tests**  
   Prefer a small **unit test** that the parser accepts the new subcommand and the handler builds the expected argv (patch **`subprocess.run`**), when the behavior is non-trivial.

## Related docs

- **`docs/NAMING.md`** : component IDs and folder names.  
- **`docs/C1_OPERATOR_WORKFLOW.md`** : C1 cadence and **`start` / `enrich N`**.  
- **`docs/components/component1/README.md`** : full **`hunter`** command list for C1.  
- **`AGENTS.md`** : file map including **`hunterctl.py`**.
