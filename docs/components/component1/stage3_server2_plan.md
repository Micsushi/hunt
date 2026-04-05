# Component 1 : Stage 3 Server2 Deployment Plan

## Purpose

This document captures how Component 1 should run in production across the two related repos:

- Hunt repo:
  - discovery, enrichment, queue logic, and later handoff to resume/apply agents
- `ansible_homelab` repo:
  - deployment of the Hunt runtime and related support services onto `server2`

The main goal of Stage 3 is to make Component 1 run continuously and safely on the job-agent server without requiring constant manual babysitting.

## Current Cross-Repo Situation

### Hunt repo

Current Component 1 state in this repo:
- Stage 1 is complete
- Stage 2 is complete
- `scraper/scraper.py` now supports discovery followed by a post-scrape LinkedIn enrichment pass
- `scraper/runner.py` can loop discovery + enrichment continuously
- `scraper/enrich_linkedin.py` supports:
  - one-job enrichment
  - batch enrichment
  - blocked/security statuses
  - `--ui-verify`
  - `--ui-verify-blocked`

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

From `playbooks/tasks/scraper.yml` in `ansible_homelab`:
- installs `git`, `python3-venv`, `python3-pip`, and `sqlite3`
- clones the Hunt repo to:
  - `/home/{{ username }}/hunt`
- creates the Python virtualenv at:
  - `/home/{{ username }}/hunt/.venv`
- installs Python dependencies from:
  - `{{ scraper_dir }}/scraper/requirements.txt`
- deploys:
  - `/etc/systemd/system/hunt-scraper.service`
  - `/etc/systemd/system/hunt-scraper.timer`
- runs the timer every:
  - `{{ scraper_interval_minutes }}` minutes

Important current service command:
- `ExecStart={{ scraper_dir }}/.venv/bin/python scraper/scraper.py`

This matters because `scraper.py` now triggers post-scrape enrichment by default, so the deployed service behavior has effectively become:
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

Stage 3 should use two runtime lanes.

### Lane 1 : unattended server lane

Runs on `server2` continuously.

Purpose:
- discover jobs
- enrich pending LinkedIn rows headlessly
- leave manual-only or blocked cases for review

Recommended process model:
- continue using the Ansible-managed `hunt-scraper.service` / `hunt-scraper.timer`
- keep it as the unattended headless worker

Recommended behavior each cycle:
1. run discovery
2. insert/update DB rows
3. enqueue LinkedIn rows as `pending`
4. run a bounded headless enrichment batch
5. stop cleanly
6. wait for the next timer tick

### Lane 2 : manual review / visible-browser lane

Runs only when needed.

Purpose:
- resolve blocked or suspicious rows
- use visible browser interaction where human supervision is useful

Recommended tools:
- Sunshine for remote desktop access to `server2`
- `python scraper/enrich_linkedin.py --job-id <ID> --channel chrome --ui-verify`

This lane should not be part of the unattended timer by default.

## Full Stage 1 + 2 + 3 Flow

The intended production flow is:

1. `hunt-scraper.timer` fires on `server2`
2. `hunt-scraper.service` runs `scraper/scraper.py`
3. discovery scrapes LinkedIn/Indeed/etc.
4. rows are inserted or refreshed in SQLite
5. new LinkedIn rows are left as:
   - `apply_type = 'unknown'`
   - `enrichment_status = 'pending'`
6. the same run starts a bounded post-scrape enrichment pass
7. each LinkedIn row becomes one of:
   - `done` + `easy_apply`
   - `done` + `external_apply`
   - `blocked`
   - `failed`
   - `job_removed`-style failure
8. a human later checks:
   - `blocked`
   - suspicious `done`
   - important `failed`
9. specific rows can be rerun with:
   - `--force`
   - `--ui-verify`

This keeps the hot path automatic while preserving a manual lane for exceptions.

## What Stage 3 Still Needs To Implement

Stage 3 is partially implemented already. The remaining work is mostly operational hardening.

### 1. Retry and backoff policy

Implement a clear retry policy by error type.

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

### 2. Bounded enrichment per timer cycle

Do not try to drain the entire backlog every 10 minutes.

Recommended server defaults:
- keep `ENRICH_AFTER_SCRAPE = True`
- set a bounded `ENRICHMENT_BATCH_LIMIT`
- let backlog drain across runs

This keeps the timer predictable and prevents a single large backlog from monopolizing the host.

### 3. Manual review service

Add a separate browser-facing service on `server2` for queue review and operator actions.

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

This should be a separate service from the scraper timer.

### 4. Queue monitoring

Add lightweight operational checks for:
- pending backlog size
- rows stuck in `processing`
- blocked count
- repeated auth failures
- recent done rate

This can later feed:
- Uptime Kuma
- a small metrics endpoint
- or future dashboards

### 5. Future handoff to Component 2 and Component 3

Stage 3 should keep data and states clean enough for future agent workers.

Future downstream consumers will need:
- `apply_type`
- `auto_apply_eligible`
- enriched description
- `apply_url`
- stable terminal/error states

The review/control plane should eventually become the operator layer for:
- Component 1 enrichment
- Component 2 resume tailoring
- Component 3 apply agents

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

## Why The Review Service Should Be Separate

The review service is not just a Stage 2 helper.

It should eventually support:
- Component 1 queue review
- Component 2 outputs and failures
- Component 3 apply history and manual intervention
- future agents and ownership/state transitions

So it is better to design it now as:
- a lightweight internal control plane

rather than:
- a one-off SQLite viewer

## Notes For Future Agents

If a future agent needs to reason about deployment, these are the first places to read:

### In Hunt repo
- `scraper/scraper.py`
- `scraper/runner.py`
- `scraper/enrich_linkedin.py`
- `scraper/config.py`
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
- current scheduled entrypoint is `scraper/scraper.py`

## Recommended Next Implementation Order

1. Harden the unattended timer deployment in `ansible_homelab`
   - Playwright browser install
   - env vars
   - auth-state path expectations
2. Finalize retry/backoff policy in Hunt
3. Add the `hunt-review` service design and minimal UI
4. Add queue-health visibility and stale `processing` handling
5. Only then begin wiring in broader agent orchestration for Component 2 and 3
