# Hunt : Deployment

Canonical reference for server2 layout, Ansible structure, env vars, and paths. All other docs refer here — do not duplicate deployment details elsewhere.

## Environments

| Environment | OS | Purpose |
|---|---|---|
| Local (Windows) | Windows 11 | Development and local testing — test here before deploying |
| server2 (Linux) | Ubuntu/Debian | Production — runs C1 continuously |

All code must run on both. Use `pathlib` and env vars — no hardcoded paths or bash-only assumptions.

---

## server2 Layout

| Resource | Path |
|---|---|
| Repo checkout | `/home/michael/hunt` |
| Python venv | `/home/michael/hunt/.venv` |
| Activate venv | `source ~/hunt/.venv/bin/activate` |
| Live DB | `/home/michael/data/hunt/hunt.db` |
| Artifacts dir | `/home/michael/data/hunt/artifacts` |
| Empty fallback DB | `/home/michael/hunt/hunt.db` |

Runtime data lives **outside** the git checkout. The git tree is code only.

---

## Key Env Vars

| Var | Purpose | server2 value |
|---|---|---|
| `HUNT_DB_PATH` | SQLite DB path | `/home/michael/data/hunt/hunt.db` |
| `HUNT_ARTIFACTS_DIR` | Artifacts root | `/home/michael/data/hunt/artifacts` |
| `HUNT_RESUME_MODEL_BACKEND` | C2 LLM backend | `ollama` |
| `HUNT_RESUME_LOG_LLM_IO` | Log LLM I/O | `1` |
| `HUNT_ADMIN_USERNAME` | C0 login username | `admin` unless overridden |
| `HUNT_ADMIN_PASSWORD` | C0 login password | set in `.env` |
| `REVIEW_OPS_TOKEN` | Optional legacy/API ops token; session auth also works | optional secret |
| `REVIEW_APP_PUBLIC_URL` | Public review hostname | e.g. `https://agent-hunt-review.mshi.ca` |
| `LINKEDIN_EMAIL` | LinkedIn auto-relogin | set in `.env` |
| `LINKEDIN_PASSWORD` | LinkedIn auto-relogin | set in `.env` |
| `DISPLAY` | Virtual display for headful enrichment | `:98` (Xvfb) |

`hunterctl` auto-targets `~/data/hunt/hunt.db` when that path exists, so manual commands align with the systemd runtime.

---

## Ollama (C2 LLM backend on server2)

| Config | Value |
|---|---|
| Model | `gemma4:e4b` |
| Timeout | `300s` |
| Enable | `HUNT_RESUME_MODEL_BACKEND=ollama` in `.env` |
| Default without var | heuristic mode |

---

## Ansible Structure

Ansible repo: `C:\Users\sushi\Documents\Github\ansible_homelab`  
Full plan: `ansible_homelab/docs/2.01-job-agent-plan.md`

Each component deploys in its own stage — never fold a later component into an earlier stage.

| Component | Ansible stage |
|---|---|
| C1 (Hunter) | job_agent Stage 6 |
| C2 (Fletcher) | separate later stage (Stage 7) |
| C3 (Executioner) | separate later stage |
| C4 (Coordinator) / OpenClaw | separate later stage |

---

## Systemd Services (C1)

| Unit | Purpose |
|---|---|
| `hunt-scraper.timer` | Scheduled C1 discovery + enrichment (default every 10 min) |
| `hunt-scraper.service` | One C1 run (triggered by timer or manual start) |
| `hunt-xvfb.service` | Xvfb virtual display on `:98` for headful enrichment |
| C0 control-plane service | Separate from scraper; deploy flags in `ansible_homelab` |

Note: unit names still say `hunt-scraper` while running C1 Hunter — historical names, see `docs/NAMING.md`.

---

## Deploy Procedure (C1, server2)

Merge changes to `main` first, then from Ansible control machine:

```bash
# Full refresh
ansible-playbook -i inventory.local playbooks/job_agent/main.yml

# After Hunt code change only
ansible-playbook -i inventory.local playbooks/job_agent/main.yml --tags stage6

# After deploy: reload systemd if units changed
sudo systemctl daemon-reload && sudo systemctl restart hunt-scraper.timer hunt-xvfb.service
```

---

## Playwright Setup

Installing the Python `playwright` package alone is not enough on Linux. Also run:

```bash
python -m playwright install chromium
```

This must be run as the runtime user so browser binaries exist in the correct Playwright cache.

---

## Smoke Test After Deploy

Run on server2 as the deploy user:

1. **Units active**: `systemctl is-active hunt-xvfb hunt-scraper.timer`
2. **Env vars present**: `systemctl cat hunt-scraper.service | grep -E 'HUNT_|REVIEW_APP_PUBLIC'`
3. **One-shot scrape**: `sudo systemctl start hunt-scraper.service` then `journalctl -u hunt-scraper.service -n 80 --no-pager`
4. **C0 control plane**: open `https://<hunt_review_hostname>` — queue loads, `/health` returns OK
5. **Metrics**: `docker exec hunt_review curl -sS http://127.0.0.1:8000/metrics | head`
6. **Queue JSON**: `./hunter.sh queue --json | head -c 2000`

---

## Headful / Xvfb (Linux server)

Normal enrichment passes run headless. When `--ui-verify-blocked` is on, blocked rows get a visible-browser rerun. On a headless server:

```bash
DISPLAY=:98 ./hunter.sh drain
```

`Xvfb :98` is managed by `hunt-xvfb.service`. Do not run headful enrichment on the main desktop foreground.
