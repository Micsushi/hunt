# C1 (Hunter) : Discovery and Enrichment

Code lives in `hunter/`. CLI: `./hunter.sh <cmd>` (Windows: `.\hunter.ps1 <cmd>`). See `docs/CLI_CONVENTIONS.md`.

## Goal

Continuously discover job postings, enrich them with full descriptions and external apply URLs, and classify Easy Apply jobs so they never reach downstream automation.

## Locked Decisions

- `job_url` is the listing URL and dedupe key — never the apply destination
- `apply_url` is the best-known external ATS URL
- `status` is application lifecycle only — enrichment state lives in `enrichment_status`
- LinkedIn Easy Apply: `apply_type = easy_apply`, `auto_apply_eligible = 0`, never retried by automation
- External apply: `apply_type = external_apply`, `auto_apply_eligible = 1`
- Newly discovered LinkedIn rows outrank old backlog rows in post-scrape enrichment queue
- Read-only queue tools must not mutate queue state
- Terminal failures like `job_removed` are recorded, not retried
- LinkedIn enrichment runs before Indeed in every batch
- Default batch size: **25** rows (LinkedIn-safe)
- C1 must remain runnable and testable from terminal without C0/C2/C3/C4
- Deployment: separate Ansible stage from C2/C3/C4 — see `docs/deployment.md`

## Feature Status

### Done

- [x] JobSpy discovery — LinkedIn + Indeed
- [x] Discovery lane title filter (`hunter/search_lanes.py`) — trims rows not matching engineering/product/data lane
- [x] LinkedIn Playwright enrichment (single-job worker, `hunter/enrich_linkedin.py`)
- [x] Easy Apply detection + `apply_type` classification
- [x] External apply URL capture + `apply_host` + `ats_type` detection
- [x] LinkedIn auth state management + auto-relogin (`hunter/linkedin_session.py`)
- [x] Batch enrichment with retry/backoff policy (`hunter/enrichment_policy.py`)
- [x] Stale `processing` row recovery
- [x] Source-aware enrichment queue — LinkedIn-first dispatch (`hunter/enrichment_dispatch.py`)
- [x] Indeed enrichment — HTTP path + browser fallback (`hunter/enrich_indeed.py`)
- [x] Shared browser runtime across sources (`hunter/browser_runtime.py`)
- [x] `--ui-verify-blocked` headful rerun for blocked rows
- [x] Post-scrape enrichment inside main scrape flow
- [x] Failure artifact capture — screenshot, HTML, text (`last_artifact_*` fields)
- [x] Machine-readable queue health JSON (`scripts/queue_health.py`)
- [x] C0 control plane exposes C1 queue health, filter/sort, artifact links, and source-aware views (`backend/app.py`)
- [x] `clean-lane-mismatch` — removes stored rows whose title doesn't match category lane
- [x] `hunter retry` / `requeue-enrich` — requeues retryable failed rows
- [x] `hunter backfill` / `drain` — controlled batch drain with checkpoint
- [x] `hunter apply-prep <id>` — C4 shared apply-prep shim

### In Progress / Needs Work

- [ ] **server2 production validation** — finish backlog drain, watch LinkedIn rate limits
- [ ] **Observe one real blocked artifact** end-to-end (screenshot saved, HTML saved, control-plane links work)
- [ ] **Steady-state timer validation** — watch one full scrape + post-scrape enrichment cycle, confirm queue counts stable
- [ ] **Ansible Stage 6 clean deploy** — reproducible without manual container repair

Recommended finish sequence:
1. `./hunter.sh retry` then `./hunter.sh clean-lane-mismatch --apply`
2. `DISPLAY=:98 ./hunter.sh drain` (default 25-row batches)
3. If LinkedIn stays sensitive: `DISPLAY=:98 ./hunter.sh backfill 100 --source indeed --ui-verify-blocked --yes`
4. Once backlog is stable: `./hunter.sh auto-on` then `./hunter.sh auto-status`

### Bugs / Known Issues

- [!] **LinkedIn rate limiting on large batches** — keep default batch size at 25; override with care. Mixing sources aggressively in one batch can trigger this.
- [!] **Lane mismatch rows in DB** — legacy rows from before lane filter existed. Run `./hunter.sh clean-lane-mismatch --apply` to purge.

## Component Contract

**C1 writes to DB:**
- `jobs` table (discovery fields, enrichment fields, failure artifact fields)
- `runtime_state` (`linkedin_auth_state`, `linkedin_auth_error`, `review_audit_log`)
- `linkedin_accounts.auth_state` + `last_auth_at` after each auth attempt

**C1 reads from DB:**
- `component_settings` for its own settings (search terms, batch size, lanes, intervals)
- `linkedin_accounts` to select the active account for enrichment

**C1 service API** (called by C0 backend, not the frontend directly):

| Endpoint | Purpose |
|---|---|
| `POST /scrape` | Trigger one discovery run |
| `POST /enrich` | Trigger one enrichment batch (accepts `limit`, `source`) |
| `POST /accounts/{id}/reauth` | Trigger LinkedIn re-auth for a specific account |
| `GET /queue` | Return queue health JSON |
| `GET /status` | Health check — online/offline |

**Standalone behavior:** C1 discovery/enrichment runs from CLI against the DB. C0 is optional convenience.

**C1 does not:** submit applications, make resume decisions, depend on C0, or block on C2/C3/C4 state.

**LinkedIn multi-account:** C1 reads from `linkedin_accounts` table (managed via C0 UI). `LINKEDIN_EMAIL` / `LINKEDIN_PASSWORD` env vars are a legacy fallback for single-account setups.

## Related

- `runbook.md` : operational how-to (start, drain, recover, auth)
- `api.md` : C1 service API contract
- `docs/deployment.md` : server2 layout, Ansible, env vars
- `docs/DATA_MODEL.md` : full field reference including `linkedin_accounts`
- `docs/SETTINGS_AND_SECRETS.md` : LinkedIn credential and setting rules
- `hunter/` : implementation
