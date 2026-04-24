# C1 (Hunter) : Runbook

Operational how-to for discovery, enrichment, and recovery. For server2 layout and Ansible deploy: `docs/deployment.md`. For what's implemented and what's broken: `README.md`.

## CLI

Windows: `.\hunter.ps1 <cmd>` | Linux: `./hunter.sh <cmd>` | Legacy alias: `hunt`

## Common Commands

| Command | What it does |
|---|---|
| `hunter start` | Linux: enable + start systemd timer. Windows: one discovery run. |
| `hunter stop` | Linux: disable systemd timer. |
| `hunter restart` | Linux: daemon-reload + restart timer + Xvfb. |
| `hunter queue` | Queue health summary |
| `hunter jobs --source all --limit 20` | List jobs across sources |
| `hunter job <id>` | Inspect one job |
| `hunter enrich 25` | Enrich batch of 25 (all sources) |
| `hunter enrich 25 --source linkedin` | LinkedIn only |
| `hunter enrich 25 --source indeed` | Indeed only |
| `hunter retry` | Requeue retryable failed rows |
| `hunter backfill` | Controlled drain, 25 rows/batch, checkpoint after each |
| `hunter backfill 50` | Same but 50 rows/batch |
| `hunter backfill --source indeed` | Indeed only |
| `hunter drain` | Same as `backfill-all` — drain all sources with `--ui-verify-blocked --yes` |
| `DISPLAY=:98 hunter drain` | Drain with headful fallback on Linux server |
| `hunter clean-lane-mismatch` | Preview mismatched title rows |
| `hunter clean-lane-mismatch --apply` | Delete them |
| `ui serve` | Start the C0 control plane locally |
| `hunter auto-on` | Re-enable 10-min timer |
| `hunter auto-status` | Check timer status |

## Discovery

Uses **JobSpy** for LinkedIn + Indeed. Writes rows with `enrichment_status = pending`. Discovery lane filter trims rows not matching the lane (engineering/product/data) of their search query.

Post-scrape enrichment runs automatically after discovery. Default batch limit: 25.

## Enrichment

- LinkedIn: Playwright browser session with saved auth state
- Indeed: HTTP + HTML parsing first; browser fallback for blocked rows
- `--ui-verify-blocked`: re-runs browser-fixable failures in a visible browser window
- On Linux server: needs `DISPLAY=:98` (Xvfb) for headful runs

Queue priority: newest discovered rows first, then backlog.

LinkedIn auth note: use `Sign in with email`, not Google SSO. Two login states:
- `welcome_back` — remembered account chooser
- `login_form` — plain email/password form

## Recovery Scenarios

**Row stuck in `processing`:**
```bash
hunter enrich --job-id <id> --force
```

**Re-check a blocked row in visible browser:**
```bash
hunter enrich --job-id <id> --force --ui-verify
```

**Requeue stale failed rows:**
```bash
hunter retry
```

**Drain backlog safely (LinkedIn-rate-limit aware):**
```bash
DISPLAY=:98 ./hunter.sh drain          # 25-row batches
DISPLAY=:98 ./hunter.sh drain 10       # smaller if rate-limiting
```

**Indeed separately (less LinkedIn pressure):**
```bash
DISPLAY=:98 ./hunter.sh backfill 100 --source indeed --ui-verify-blocked --yes
```

## C0 Control Plane

```bash
ui serve            # preferred
hunter review       # legacy alias
```

On server2: `https://<hunt_review_hostname>`. Shows queue state, enrichment errors, artifact links. Read-only inspection — requeue from `/ops` panel or CLI.

## Adding a New Job Board

1. Append source string to `db.ENRICHMENT_SOURCE_PRIORITY`
2. Add row to `enrichment_dispatch._REQUIRES_LINKEDIN_SESSION`
3. Extend `_run_batch_for_source`
4. Implement `process_batch` for the new source
