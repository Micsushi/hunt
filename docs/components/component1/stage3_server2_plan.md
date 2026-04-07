# C1 (Hunter) : Stage 3 Server2 Deployment Plan

## Naming (read this first)

- **C1 (Hunter)** is posting discovery and enrichment. Runtime code lives in the **`hunter/`** Python package (the former **`scraper/`** tree was renamed).
- **`hunter/scraper.py`** is the **discovery script** inside that package (historical filename), not a second component.
- On the server, Ansible **`playbooks/tasks/scraper.yml`** is still the filename for the **C1 (Hunter)** deploy task; systemd **`hunt-scraper.service`** / **`hunt-scraper.timer`** are **legacy unit names** that run **`python hunter/scraper.py`**.
- **C2 (Trapper)** = `trapper/`, **C3 (Executioner)** = extension, **C4 (Coordinator)** = `coordinator/`. Full table: **`docs/NAMING.md`**.

## Purpose

This document captures how **C1 (Hunter)** should run in production across the two related repos:

- Hunt repo:
  - discovery, enrichment, queue logic, and later handoff to resume/autofill/orchestration components
- `ansible_homelab` repo:
  - deployment of the Hunt runtime and related support services onto `server2`

The main goal of Stage 3 is to make **C1 (Hunter)** run continuously and safely on the job-agent server without requiring constant manual babysitting.

## Current Cross-Repo Situation

### Hunt repo

Current **C1 (Hunter)** state in this repo:
- Stage 1 is complete
- Stage 2 is complete
- Stage 3 runtime code now exists in the Hunt repo
- `hunter/scraper.py` now supports discovery followed by a post-scrape supported-source enrichment pass with LinkedIn-first priority
- `hunter/runner.py` can loop discovery + enrichment continuously
- `hunter/enrich_linkedin.py` supports:
  - one-job enrichment
  - batch enrichment
  - blocked/security statuses
  - `--ui-verify`
  - `--ui-verify-blocked`
- `hunter/enrich_indeed.py` now supports:
  - one-job enrichment
  - batch enrichment
  - an HTTP-first path
  - `--ui-verify` for a visible browser rerun
  - `--ui-verify-blocked` for browser-fixable failures after the first pass
- `hunter/browser_runtime.py` now provides the shared Playwright browser/context layer used by supported UI/browser fallback flows
- `hunter/enrichment_policy.py` now defines retry and backoff behavior for unattended runs
- `scripts/queue_health.py` now exposes queue-health checks for operators
- `review_app.py` now provides the minimal browser-facing review/control-plane service
- pending rows discovered in the current scrape are now prioritized ahead of older backlog rows
- read-only operator tooling avoids queue-maintenance side effects
- historical retryable failed rows can be seeded into the unattended retry schedule

### `ansible_homelab` repo

Relevant paths in the other repo:
- `C:\Users\sushi\Documents\Github\ansible_homelab\playbooks\job_agent\main.yml`
- `C:\Users\sushi\Documents\Github\ansible_homelab\playbooks\tasks\scraper.yml`
- `C:\Users\sushi\Documents\Github\ansible_homelab\group_vars\job_agent\vars.yml`
- `C:\Users\sushi\Documents\Github\ansible_homelab\docs\0.04-adding-a-new-service.md`
- `C:\Users\sushi\Documents\Github\ansible_homelab\docs\2.01-job-agent-plan.md`

Server target:
- `server2`
- role: `job_agent`
- user: `michael`
- IP: `10.0.0.227`
- domain base: `agent.mshi.ca`

## Existing Ansible Deployment On Server2

The current Ansible deployment for Hunt is systemd-based, not Docker-based.

Important component-scope note:
- the current `job_agent` Stage 6 deployment is the C1 (Hunter) deployment step
- later C2 (Trapper) runtime/deployment should be added as a separate Ansible step/stage
- later C3 (Executioner) runtime should be added as a separate Ansible step/stage
- later C4 (Coordinator) / OpenClaw-driven orchestration runtime should be added as a separate Ansible step/stage

From `playbooks/tasks/scraper.yml` in `ansible_homelab`:
- installs `git`, `python3-venv`, `python3-pip`, and `sqlite3`
- clones the Hunt repo to:
  - `/home/{{ username }}/hunt`
- creates the Python virtualenv at:
  - `/home/{{ username }}/hunt/.venv`
- installs Python dependencies from:
  - `{{ scraper_dir }}/hunter/requirements.txt`
- deploys:
  - `/etc/systemd/system/hunt-scraper.service`
  - `/etc/systemd/system/hunt-scraper.timer`
- runs the timer every:
  - `{{ scraper_interval_minutes }}` minutes

Important current service command:
- `ExecStart={{ scraper_dir }}/.venv/bin/python hunter/scraper.py`

Important runtime-path note:
- the live SQLite DB and Playwright browser cache should live outside the git checkout
- on `server2`, the intended runtime path is:
  - `/home/michael/data/hunt/hunt.db`
- the repo-local `~/hunt/hunt.db` may exist during manual debugging, but it is not the production runtime DB
- manual SQLite checks and debug scripts on `server2` should point at `/home/michael/data/hunt/hunt.db`

This matters because **`hunter/scraper.py`** (C1 discovery entrypoint) now triggers post-scrape enrichment by default, so the deployed service behavior has effectively become:
- discover jobs
- add/update rows in SQLite
- enrich pending LinkedIn rows

## Existing Server2 Service Model

`server2` already runs browser-facing services through Docker and Cloudflare Tunnel.

From `group_vars/job_agent/vars.yml` in `ansible_homelab`:
- `deploy_cloudflare_tunnel: true`
- `deploy_traefik: false`
- `deploy_authelia: false`

That means new browser-accessible services on `server2` should follow the existing `server2` pattern:
- Docker container
- Cloudflare Tunnel ingress rule
- Cloudflare Access protection
- optional Uptime Kuma monitor

This is different from `server1`, which uses Traefik/Authelia more directly.

## Stage 3 Runtime Model

Stage 3 should use two deployed parts on `server2`.

### Part 1 : unattended Hunt runtime

Runs on `server2` continuously.

Purpose:
- discover jobs
- enrich pending supported-source rows with a cheap first pass
- immediately rerun only browser-fixable rows with a browser-open fallback pass
- keep the browser-open fallback off the main desktop foreground

Recommended process model:
- continue using the Ansible-managed `hunt-scraper.service` / `hunt-scraper.timer`
- keep it as the unattended worker for discovery plus enrichment

Recommended behavior each cycle:
1. run discovery
2. insert/update DB rows
3. enqueue supported-source rows as `pending`
4. run a bounded first-pass enrichment batch, prioritizing the newest pending rows first and LinkedIn before other supported sources
5. immediately rerun any browser-fixable rows with the equivalent of `--ui-verify-blocked`
6. run that browser-open fallback on a separate virtual X display such as `:98`
7. stop cleanly
8. wait for the next timer tick

Why the fallback should use a separate display:
- the browser-open retry should render a real page, not stay pure headless
- it should not steal focus from the main desktop session
- `Xvfb` is acceptable even when no physical monitor is attached

### Part 2 : review/control-plane web app

Runs continuously as a separate service.

Purpose:
- expose the live queue and DB state from a browser URL
- let the operator inspect rows, descriptions, and errors
- support lightweight queue actions such as requeue

Recommended tools:
- `review_app.py`
- Docker container on `server2`
- Cloudflare Tunnel ingress
- optional Uptime Kuma monitor

### Separate manual/operator lane

Runs only when needed.

Purpose:
- resolve blocked or suspicious rows
- use visible browser interaction where human supervision is useful

Recommended tools:
- Sunshine for remote desktop access to `server2`
- `python hunter/enrich_linkedin.py --job-id <ID> --channel chrome --ui-verify`

This lane still exists, but it is no longer the only way blocked rows get a browser-open retry.

## Full Stage 1 + 2 + 3 Flow

The intended production flow is:

1. `hunt-scraper.timer` fires on `server2`
2. `hunt-scraper.service` runs `hunter/scraper.py`
3. discovery scrapes LinkedIn/Indeed/etc.
4. rows are inserted or refreshed in SQLite
5. new supported rows are left as:
   - `apply_type = 'unknown'`
   - `enrichment_status = 'pending'`
6. the same run starts a bounded post-scrape enrichment pass
7. each supported row becomes one of:
   - `done` + `easy_apply`
   - `done` + `external_apply`
   - `blocked`
   - `failed`
   - `job_removed`-style failure
8. rows that hit browser-fixable failures during the first pass can immediately get a second browser-open retry on the virtual display
9. a human later checks:
   - `blocked`
   - suspicious `done`
   - important `failed`
10. specific rows can still be rerun manually with:
   - `--force`
   - `--ui-verify`

This keeps the hot path automatic while preserving a manual lane for exceptions and debugging.

## What Stage 3 Implements In The Hunt Repo

The Hunt repo now contains the runtime code for Stage 3. The remaining work is mostly deployment rollout and operational polish in `ansible_homelab`.

### 1. Retry and backoff policy

Implemented in:
- `hunter/enrichment_policy.py`
- `hunter/db.py`
- `hunter/enrich_linkedin.py`

Recommended policy:
- `easy_apply`
  - terminal
  - do not retry
- `job_removed`
  - terminal
  - do not retry
- `security_verification`
  - do not auto-retry forever in unattended mode
  - leave as `blocked`
  - require manual or UI verification
  - do not treat as a batch hard-stop during backfill; keep draining the remaining queue
- `auth_expired`
  - stop the batch early
  - operator action required
- `rate_limited`
  - stop the batch early
  - retry on a later cycle
- `external_description_not_usable`
  - retry limited number of times
  - if still bad, leave `failed`
- `apply_button_not_found` or layout-type failures
  - retry limited number of times
  - then leave `failed`

Important implementation detail:
- older retryable failed rows can now receive `next_enrichment_retry_at` during DB maintenance so the unattended retry system applies to historical rows too

### 2. Bounded enrichment per timer cycle

Do not try to drain the entire backlog every 10 minutes.

Recommended server defaults:
- keep `ENRICH_AFTER_SCRAPE = True`
- set a bounded `ENRICHMENT_BATCH_LIMIT`
- let backlog drain across runs

This keeps the timer predictable and prevents a single large backlog from monopolizing the host.

### 3. Manual review service

The repo now includes a separate browser-facing service for queue review and operator actions.

Recommended service name:
- `hunt-review`

Recommended purpose:
- show the live job queue
- filter by:
  - `pending`
  - `processing`
  - `done`
  - `done_verified`
  - `blocked`
  - `blocked_verified`
  - `failed`
- open `job_url` and `apply_url`
- show descriptions and failure reasons
- trigger actions like:
  - requeue
  - rerun headless enrichment
  - request UI verification
  - mark skipped/manual

Current repo implementation:
- `review_app.py`
- HTML routes:
  - `/`
  - `/jobs`
  - `/jobs/{id}`
- API routes:
  - `/health`
  - `/api/summary`
  - `/api/jobs`
  - `/api/jobs/{id}`
  - `/api/jobs/{id}/requeue`

This should still be deployed as a separate service from the **C1 (Hunter)** timer (`hunt-scraper.timer`).

### 4. Queue monitoring

Current repo implementation:
- `scripts/queue_health.py`
- `hunter/db.py` queue summary helpers
- `scripts/backfill_enrichment.py` for operator-driven batch backfills across:
  - LinkedIn only
  - Indeed only
  - all supported sources together
  - selected job ids only

Implemented checks include:
- pending backlog size
- rows stuck in `processing`
- blocked count
- repeated auth failures
- recent done rate

Important behavior:
- `scripts/queue_health.py` and `review_app.py` are intended to be observational surfaces
- they now initialize the schema without performing stale-processing recovery or other queue-maintenance side effects

This can later feed:
- Uptime Kuma
- a small metrics endpoint
- or future dashboards

Stage 4 implementation note:
- `scripts/queue_health.py` now also supports `--json`
- `review_app.py` now exposes `/metrics`
- failed rows can now carry artifact paths for screenshot/HTML/text snapshots

### 5. Future handoff to C2 (Trapper) and C3 (Executioner)

Stage 3 should keep data and states clean enough for future agent workers.

Future downstream consumers will need:
- `apply_type`
- `auto_apply_eligible`
- enriched description
- `apply_url`
- stable terminal/error states

The review/control plane should eventually become the operator layer for:
- C1 (Hunter) enrichment
- C2 (Trapper) resume tailoring
- C3 (Executioner) browser autofill and evidence
- C4 (Coordinator) orchestration and submit history

## Planned Server2 Ansible Changes

These are the recommended changes in `ansible_homelab` for Stage 3.

### Hunt timer improvements

Update `playbooks/tasks/scraper.yml` so the deployed Hunt job fully supports Stage 2/3 runtime needs.

Recommended additions:
- ensure Playwright browser binaries are installed on server2
  - `python -m playwright install chromium`
- ensure the LinkedIn storage-state file exists at deploy-time or document the manual setup step clearly
- optionally add service environment variables like:
  - `LINKEDIN_STORAGE_STATE_PATH`
  - `LINKEDIN_BROWSER_CHANNEL`
- consider increasing systemd timeout if enrichment batches become longer

Important note:
- Python dependency install alone is not enough for Playwright
- browser binaries still need to be installed
- this matters even when `.venv` already contains the Playwright Python package; without the browser download, enrichment fails before it reaches LinkedIn

### LinkedIn extractor hardening note

Observed during `server2` rollout:
- some logged-in LinkedIn job pages exposed the full description in visible page text, but not under the older stable class names previously used by the extractor
- those pages still rendered a readable `About the job` section in `body.innerText`
- the LinkedIn enrichment worker now needs to treat that visible-text section as a first-class fallback before declaring the LinkedIn description missing and jumping to the external ATS page

Operational consequence:
- after deploying an extractor fix of this kind, older `failed` rows with errors such as:
  - `external_description_not_usable`
  - `external_description_not_found`
  - `apply_button_not_found`
  - some `unexpected_error` rows
  may need to be requeued to avoid keeping stale false negatives in the backlog

### Indeed apply-link hardening note

Observed during Stage 3.2 rollout:
- Indeed enrichment primarily uses HTTP + HTML parsing, but it still shares the Playwright runtime for visible-browser fallback flows
- on `server2`, missing Playwright browser binaries can therefore break both:
  - LinkedIn enrichment
  - Indeed `--ui-verify` / `--ui-verify-blocked`
- for Indeed rows, the intended stored `apply_url` is the external destination, not an Indeed-hosted intermediate link, when redirect resolution succeeds

Operational consequence:
- when reviewing older Indeed rows, treat stuck Indeed-hosted `apply_url` values as something worth spot-checking if those rows were enriched before the current redirect-resolution logic or before the shared Playwright/browser runtime was fully installed

### New review/control-plane service

Recommended new Ansible task file:
- `playbooks/tasks/hunt_review.yml`

Recommended new playbook include:
- add a new stage after scraper or after OpenClaw, depending on how you want to group operator-facing services

Recommended new vars in `group_vars/job_agent/vars.yml`:
- `deploy_hunt_review: true/false`
- `hunt_review_hostname`
- `hunt_review_port`
- `hunt_review_image` or app path, depending on whether it is containerized

Recommended ingress additions:
- add a new Cloudflare Tunnel ingress rule
- add a new Uptime Kuma monitor

Recommended hostname pattern:
- `agent-hunt.mshi.ca`
- or `agent-hunt-review.mshi.ca`

Because `server2` currently uses Cloudflare Tunnel and not Traefik/Authelia locally, the review app should follow the same `server2` model.

### Xvfb-backed UI fallback for blocked rows

Recommended additions to the Hunt deployment:
- install and manage a virtual X display such as `Xvfb :98`
- run the browser-open blocked-row fallback against that display instead of the main desktop session
- make the display configurable through env vars so the Hunt runtime can use:
  - normal headless enrichment first
  - UI fallback for blocked rows on `:98`

Why this is the preferred shape:
- it keeps the blocked-row retry closer to a real browser than pure headless mode
- it does not require a second monitor
- it still works when no monitor is physically attached to `server2`
- it avoids stealing the visible foreground on the main desktop

## Why The Review Service Should Be Separate

The review service is not just a Stage 2 helper.

It should eventually support:
- C1 (Hunter) queue review
- C2 (Trapper) outputs and failures
- C3 (Executioner) apply history and manual intervention
- future agents and ownership/state transitions

So it is better to design it now as:
- a lightweight internal control plane

rather than:
- a one-off SQLite viewer

## Notes For Future Agents

If a future agent needs to reason about deployment, these are the first places to read:

### In Hunt repo
- `hunter/scraper.py`
- `hunter/runner.py`
- `hunter/enrich_linkedin.py`
- `hunter/config.py`
- `docs/components/component1/README.md`
- this file

### In `ansible_homelab`
- `playbooks/job_agent/main.yml`
- `playbooks/tasks/scraper.yml`
- `group_vars/job_agent/vars.yml`
- `docs/0.04-adding-a-new-service.md`
- `docs/2.01-job-agent-plan.md`

Important assumption:
- the job-agent host for Hunt runtime is `server2`
- current deployment target path is `/home/michael/hunt`
- current scheduled entrypoint is `hunter/scraper.py`

## Recommended Next Implementation Order

1. Roll out the existing Stage 3 Hunt code in `ansible_homelab`
   - Playwright browser install
   - env vars
   - auth-state path expectations
   - auth-health verification with:
     - preferred on `server2`:
       - `cd ~/hunt && ./hunt.sh auth-auto-relogin --channel chrome`
     - if a visible browser is needed on `server2`:
       - real monitor session:
         - `cd ~/hunt && DISPLAY=:0 ./hunt.sh auth-auto-relogin --headful --display :0 --channel chrome`
       - `cd ~/hunt && DISPLAY=:98 ./hunt.sh auth-auto-relogin --headful --display :98 --channel chrome`
     - direct `.venv/bin/python hunter/linkedin_session.py --auto-relogin ...` on `server2` should only be used if `HUNT_DB_PATH` is exported first
   - that command should reuse the saved session first when possible, then fall back to stored credentials, and finally flip the shared auth flag used by the review app and `/metrics`
   - when debugging a flaky LinkedIn relogin flow, enable:
     - `LINKEDIN_RELOGIN_DEBUG=1`
   - the relogin worker now logs:
     - detected screen type such as `welcome_back` or `login_form`
     - which selectors/buttons were clicked
     - which fields were filled
     - redacted password fill details
   - every auth run also appends a persistent JSONL trace at `.state/linkedin_auth_trace.jsonl`
     - override path with `LINKEDIN_AUTH_TRACE_PATH`
     - trace entries include URL, screen type, visible components, clicks, fills, and final run outcome
   - latest observed `server2` auth trace confirms:
     - LinkedIn may keep the same `/login/?session_redirect=...` URL across both the welcome-back chooser and the real email/password form
     - the second screen can include `Sign in with Apple`, so the worker must only submit the exact LinkedIn `Sign in` button after it has already identified real email/password fields
     - an immediate post-submit trace snapshot can report `Execution context was destroyed` during navigation; treat the later `/feed/` snapshot and successful `run_end` record as the real success confirmation
     - if auth succeeds but `/metrics` still reports `hunt_auth_available{source="linkedin"} 0`, verify that the auth command and the review app are using the same `HUNT_DB_PATH`
     - confirmed `server2` example:
       - manual relogin updated `/home/michael/hunt/hunt.db`
       - review app metrics were reading `/home/michael/data/hunt/hunt.db`
       - rerunning through `./hunt.sh auth-auto-relogin ...` updated the runtime DB and flipped `hunt_auth_available{source="linkedin"}` back to `1`
2. Add the Xvfb-backed blocked-row UI fallback to the deployed Hunt runtime
3. Verify the deployed timer still prioritizes newest pending rows before older backlog
4. Deploy `review_app.py` as the `hunt-review` service on `server2`
5. Add monitoring wiring from the queue-health outputs into your preferred service layer
6. Only then begin wiring in broader agent orchestration for C2 (Trapper) and C3 (Executioner)

## Stage 4 Server2 Follow-Up Plan

After the current Stage 3.2 rollout is stable on `server2`, Stage 4 should build on the existing deployment shape rather than replacing it.

Keep using:
- `hunt-scraper.service` for scheduled scrape + enrich
- `hunt-scraper.timer` for unattended runs
- `hunt-xvfb.service` on `:98` for browser-open/UI fallback
- the separate `hunt-review` container for operator inspection and control

Recommended Stage 4 server work:
1. complete the backlog drain with the current `backfill` wrapper
   - preferred command family:
     - `DISPLAY=:98 ./hunt.sh backfill 100 --source all --ui-verify-blocked`
   - use prompting mode first, then `--yes` once the run behavior is trusted
2. add runtime artifact storage under `{{ scraper_runtime_dir }}`
   - example subdirectories:
     - `artifacts/screenshots`
     - `artifacts/html`
     - `artifacts/text`
   - keep artifacts outside the repo checkout so deploys remain clean
3. add any Stage 4 env vars through the existing **C1 (Hunter)** service template (`hunt-scraper.service`)
   - artifact root path
   - optional artifact retention limit
   - optional metrics/export toggle
   - current implementation now expects `HUNT_ARTIFACTS_DIR`
4. expose queue-health data in a machine-readable way that fits the existing monitoring stack
   - Uptime Kuma remains useful for up/down checks
   - richer queue-state data should come from Hunt itself, not from ad hoc journal scraping
5. document the normal operator flow in the Ansible-facing docs
   - pause auto timer
   - run backfill manually
   - inspect blocked rows in review app
   - re-enable timer when backlog drain is done

Stage 4 server success looks like:
- the backlog can be drained without timer interference
- blocked/security failures leave inspectable artifacts
- queue health is visible without tailing journals
- all required runtime paths and env vars come from Stage 6 automation, not one-off shell setup

Current Stage 4 deployment wiring:
- Stage 6 should create `{{ scraper_artifacts_dir }}`
- `hunt-scraper.service` should export:
  - `HUNT_ARTIFACTS_DIR={{ scraper_artifacts_dir }}`
- `hunt-review` should mount the same directory read-only and export:
  - `HUNT_ARTIFACTS_DIR=/app/artifacts`

Recommended C1 sign-off sequence on `server2`:
1. deploy the latest Hunt repo plus the latest Stage 6 Ansible changes
2. verify Stage 6 exports the artifact path and that the review app exposes `/metrics`
3. bulk requeue any failed/blocked rows that should be retried
4. run a manual all-source backfill until the backlog is under control
5. confirm queue health from the CLI and review app
6. re-enable the timer and watch one scheduled scrape + enrich cycle
7. if a real blocked/browser-fixable row appears, confirm artifact files are written and linked in the review app
