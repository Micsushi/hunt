# C1 (Hunter) v0.1 : operator workflow

Short description of how discovery, enrichment, and review fit together. Canonical naming: **`docs/NAMING.md`**. Deeper design: **`docs/components/component1/README.md`**.

## Cadence

On a typical deploy, **`hunter/scraper.py`** runs on a timer (often **every 10 minutes** : `RUN_INTERVAL_SECONDS` default **600** in `hunter/config.py`, or the systemd/Ansible interval you set). **`hunter/runner.py`** is the continuous loop variant.

## Discovery

- Uses the **JobSpy** library to pull recent postings from **LinkedIn** and **Indeed** for your configured search terms and locations (`hunter/config.py`).
- **Indeed** matching is broad by design (category/title filters trim obvious junk before rows enter the queue).
- Listing data from discovery is often thin : **LinkedIn listing payloads rarely carry a full description**; that is why enrichment opens each job in a browser when needed.
- New/updated rows for supported boards are written to **SQLite** with **`enrichment_status = 'pending'`** (and related apply fields) so they join the enrichment queue.

## Enrichment

- **Playwright** drives real browser sessions for **LinkedIn**; **Indeed** uses a lighter path first and can use the same browser stack for blocked/UI fixes.
- Routing is centralized in **`hunter/enrichment_dispatch.py`** : rows are processed by **`jobs.source`** (today **LinkedIn first**, then **Indeed**), up to a **batch limit** per run (`ENRICHMENT_BATCH_LIMIT` / `--enrich-limit`), not an unbounded “every pending row in the DB” sweep in one go.
- The queue includes **`pending`** rows and **failed** rows that are **due for retry** (`next_enrichment_retry_at`), not only rows inserted in the last scrape.
- **LinkedIn Easy Apply** : detected on the job page during enrichment, stored as **`apply_type = 'easy_apply'`** with **`auto_apply_eligible = 0`** so **later automation does not treat them as external-apply targets**. They are still **enriched/classified**, not skipped at discovery.
- **Auth** : only **LinkedIn** needs a saved session (storage state JSON) and/or **`LINKEDIN_EMAIL` / `LINKEDIN_PASSWORD`** auto-relogin when enabled. **Indeed does not use LinkedIn cookies**; if LinkedIn auth is bad, **Indeed can still run** in the same round.
- **Headless first** : normal passes use **headless** Chromium unless you configure headful (`ENRICHMENT_HEADFUL` / CLI).
- **Headful second pass (optional)** : when **`ENRICHMENT_UI_VERIFY_BLOCKED`** (or **`--ui-verify-blocked`**) is on, certain “blocked” or page-shape failures are **queued and rerun in a visible Chromium window**. On a headless server this usually means a **virtual display** (e.g. **Xvfb** + `DISPLAY`), not your physical monitor unless you remote into that session.

## Review

- **`review_app.py`** : FastAPI **web app** over the same SQLite DB and artifacts directory.
- Browse jobs with **filter, sort, and search**; inspect **enrichment errors**, **queue state**, and **failure artifacts** (screenshots/HTML/text when captured).

---

## Personal runbook : features not spelled out above

Use this as a checklist for notes you keep outside the repo (on-call, server-specific paths, secrets).

| Topic | Where to look |
|------|----------------|
| Env vars (`HUNT_DB_PATH`, `HUNT_ARTIFACTS_DIR`, Playwright paths, LinkedIn env) | `hunter/config.py`, `docs/LOCAL_TESTING.md` |
| Discord / structured C1 events (priority job, rate limit, automation flagged) | `hunter/c1_logging.py`, review **`/summary`** |
| LinkedIn **multi-account** rotation / blocks | `hunter/linkedin_session.py`, `.state` files |
| **Stale** `processing` row recovery | `hunter/db.py`, `ENRICHMENT_STALE_PROCESSING_MINUTES` |
| **Requeue** failed rows by error code | `scripts/huntctl.py`, `scripts/requeue_enrichment_rows.py` |
| **Queue health** / ops helpers | `scripts/queue_health.py`, `./hunt.sh queue` |
| **Indeed** title/category cleanup | launcher `clean-indeed` / `cleanup-indeed` |
| Adding a **new job board** later | `db.ENRICHMENT_SOURCE_PRIORITY` + `hunter/enrichment_dispatch.py` |
| Tests, Ruff, noisy unittest output | `docs/LOCAL_TESTING.md` §8 |
| Systemd unit names still say **`hunt-scraper`** while running C1 | `docs/NAMING.md`, Ansible `scraper.yml` |
