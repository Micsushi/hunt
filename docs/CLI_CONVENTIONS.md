# Hunt : CLI conventions (`hunt` / `hunter` / `huntctl`)

This doc is the contract for **operator-facing commands** so C1–C4 stay consistent as the repo grows.

## Entry points

| Path | Role |
|------|------|
| **`./hunt.sh`**, **`./hunt.ps1`**, **`hunt.cmd`** | Repo-root launchers (POSIX / Windows). |
| **`./hunter.sh`**, **`./hunter.ps1`**, **`hunter.cmd`** | Same as **`hunt.*`** : alias for muscle memory. |
| **`scripts/huntctl.py`** | Single Python CLI implementation : all launchers invoke this with passthrough args. |
| **`scripts/launchers/hunt.sh`** | Used by repo-root **`hunt.sh`** : picks venv Python, `cd` to repo root. |

**Rule:** Do not add a second parallel CLI framework. New verbs go into **`scripts/huntctl.py`** (or a module it calls).

## C1 (Hunter) commands today

C1 is the most mature surface. Short narrative : **`docs/C1_OPERATOR_WORKFLOW.md`**.

| Command | Purpose |
|---------|---------|
| **`hunt start`** | Linux : enable + start **`hunt-scraper.timer`**. Windows : one **`hunter/scraper.py`** run. |
| **`hunt stop`** | Linux : disable + stop the timer. |
| **`hunt restart`** | Linux : **`daemon-reload`**, restart **`hunt-xvfb`**, restart **`hunt-scraper.timer`**. |
| **`hunt enrich N`** | Positional batch size (same as **`--limit N`**). Often **`hunt enrich 50 --source all`**. |
| **`hunt scrape`**, **`hunt queue`**, **`hunt review`**, … | See **`hunt --help`** or **`docs/components/component1/README.md`** (Command Reference). |

Legacy names remain valid (**`timer-start`**, **`auto-on`**, **`svc-start`**, etc.) but **prefer `start` / `stop` / `restart`** in new docs.

## Conventions for **future** C2, C3, C4 commands

When you add automation an operator runs from the repo (not the extension popup, not OpenClaw-only), follow this pattern.

1. **Implement in `huntctl`**  
   Add a **`argparse`** subparser under **`build_parser()`** in **`scripts/huntctl.py`**, with a **`cmd_*`** handler that builds argv and calls **`_run([PYTHON, …])`** (or **`subprocess`** for non-Python steps). Keep Linux-only server actions behind **`_require_linux`** when appropriate.

2. **Name verbs for humans**  
   Prefer short verbs : **`start`**, **`stop`**, **`restart`**, **`status`**, **`logs`**, **`enrich`**, **`tailor`** (example for C2), **`apply-prep`** (C4 already). Avoid duplicating systemd unit names in user-facing docs unless explaining internals.

3. **Document in three places**  
   - **Component README** under **`docs/components/componentN/README.md`** : a **“CLI”** subsection with examples.  
   - **`docs/C1_OPERATOR_WORKFLOW.md`** only for **C1**; for C2+ add a subsection in the relevant component doc or a short **“Operator CLI”** bullet in **`docs/roadmap.md`** when the command ships.  
   - **`AGENTS.md`** : one-line mention in the repo overview if the command is part of the default workflow.

4. **Optional : thin package CLI**  
   It is fine for **`trapper/`**, **`coordinator/`**, etc. to keep **`python -m trapper.cli`** or **`python -m coordinator.cli`** for library-style use. **`huntctl`** should call those entrypoints so operators only learn **`hunt …`**.

5. **Windows vs Linux**  
   If a command only makes sense on the server (systemd, Docker socket), use **`_require_linux`** and print a clear Windows message (same pattern as **`hunt restart`**).

6. **Tests**  
   Prefer a small **unit test** that the parser accepts the new subcommand and the handler builds the expected argv (patch **`subprocess.run`**), when the behavior is non-trivial.

## Related docs

- **`docs/NAMING.md`** : component IDs and folder names.  
- **`docs/C1_OPERATOR_WORKFLOW.md`** : C1 cadence and **`start` / `enrich N`**.  
- **`docs/components/component1/README.md`** : full **`hunt`** command list for C1.  
- **`AGENTS.md`** : file map including **`huntctl.py`**.
