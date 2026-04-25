# Hunt : TODO

In-flight work and polish backlog. See `docs/roadmap.md` for component status.

## Current Foundation

- [x] Core Postgres schema exists in `schema/postgres_schema.sql`
- [x] SQLite fallback / Postgres compatibility layer exists via `hunter/db_compat.py`
- [x] C1, C2, and C4 expose FastAPI service APIs with shared bearer-token auth
- [x] C0 backend mounts gateway routes under `/api/gateway/*`
- [x] Service Dockerfiles exist for review/backend, frontend, hunter, fletcher, and coordinator
- [x] Pipeline compose exists as `docker-compose.pipeline.yml`
- [x] C4 local Postgres e2e smoke exists: `scripts/smoke_coordinator_e2e.sh`
- [x] Server2 C4 API-level bridge was validated through run creation, pending-fill polling, fake fill-result writeback, and submit deny
- [x] More tests: Python suite and C4 smoke coverage are in place

## Cross-Component Polish

- [ ] Add a clear operator status surface that shows what is working and what is broken across C0-C4
- [ ] Keep `docs/roadmap.md`, this TODO, and `docs/LOCAL_POSTGRES_SMOKES.md` current after each deployment milestone
- [ ] Add one command for local all-component smoke on Windows and Linux
- [ ] Add one command or runbook path for deploying from Windows to server2
- [ ] Decide final production shape for `Dockerfile.review` vs separate backend/frontend containers
- [ ] Validate `docker-compose.pipeline.yml` as the standard local compose path, or add a root `docker-compose.yml` wrapper
- [ ] Add service-level structured logs and correlation IDs for scrape, enrich, generate, fill, run, and approval flows
- [ ] Add Discord notifications for important operator events: auth expired, scrape/enrich failed, C4 approval waiting, run failed, smoke failed
- [ ] Add release checklist: local tests, local smoke, server smoke, docs update, vault update

## C0 : Frontend / Control Plane Polish

- [ ] Fully convert the frontend to the SPA for all operator workflows still using old backend-rendered pages
- [ ] Add dashboard health cards for DB, C1, C2, C3 heartbeat, C4, queue age, and latest errors
- [ ] Wire Ops page buttons to C1 gateway routes for trigger scrape, trigger enrich, queue/status, and account reauth
- [ ] Add settings UI backed by `component_settings`, with secret values redacted
- [ ] Add LinkedIn account UI backed by `linkedin_accounts`: create, activate/deactivate, status, auth error, reauth
- [ ] Add C2 page that calls the Fletcher service rather than showing a stub
- [ ] Add C4 page for runs, run detail, pending approvals, approve/deny, and run events
- [ ] Add C3 status surface: last poll, pending fills, last result, extension version
- [ ] Add better failure visibility: failed rows grouped by source/error, recent artifacts, and next retry
- [ ] Run C0 local smoke against Postgres plus live C1/C2/C4 services
- [ ] Run C0 server2 smoke against production Postgres and component service URLs

## C1 : Hunter Polish

- [ ] Validate real server2 C1 production cycle against Postgres: scrape, enrich, artifacts, queue drain, steady scheduler
- [ ] Confirm C1 works as a standalone product from CLI on Windows and Linux
- [ ] Add C1 service endpoint tests for status, queue, scrape, enrich, auth failure, and duplicate-run guard
- [ ] Improve C1 monitoring: structured events for scrape start/end, enrich batch summary, auth pauses, retry exhaustion, and artifact writes
- [ ] Improve LinkedIn auth: account-aware storage state, active/locked/cooldown states, clearer reauth flow from C0
- [ ] Add account rotation policy for multiple LinkedIn accounts, including backoff after auth or rate-limit trouble
- [ ] Add Discord notification hooks for auth trouble, persistent rate limit, and high failure rate
- [ ] Verify Easy Apply classification and exclusion still hold after live C1 runs
- [ ] Add runbook for local browser/session setup, headless/headful recovery, and Xvfb server flow
- [ ] Add Windows-friendly local run path for discovery/enrichment without deployment
- [ ] Polish standalone operator UX: `hunter` CLI should expose obvious status, auth, scrape, enrich, requeue, and smoke commands

## C2 : Fletcher Polish

- [ ] Make the web version work through C0 + C2 service
- [ ] Support dropping a resume as PDF, LaTeX, or plain text
- [ ] Support dropping keywords or a job description
- [ ] Support dropping a profile, or deriving profile context from the resume when no profile is supplied
- [ ] Add option to include a summary when the base resume lacks one
- [ ] Show generated summary before inserting it
- [ ] Show resume preview before accepting generated output
- [ ] Nice to have: show a diff between original and generated resume
- [ ] Nice to have: allow undo for specific resume sections
- [ ] Nice to have: split resume into components that can be regenerated independently
- [ ] Make auto-run generation work against C1 output and selected jobs
- [ ] Fill and curate `fletcher/candidate_profile.md` with real profile/history
- [ ] Wire LLM tailoring for grounded bullet and section rewriting
- [ ] Support external LLM API keys instead of self-host-only Ollama
- [ ] Evaluate OpenRouter free-model fallback order
- [ ] Evaluate Google free-tier API options
- [ ] Decide whether multi-account OpenRouter use is acceptable and worth supporting
- [ ] Validate C1 -> C2 handoff on server2 with real enriched job descriptions

## C3 : Executioner Polish

- [ ] Structure extension code so adding ATS adapters is straightforward
- [ ] Harden Workday flow: multi-page navigation, next-page handling, auto-fill-on-load, and evidence persistence
- [ ] Identify all required fields before filling, then fill with known profile/resume facts where possible
- [ ] For fields without fixed answers, use LLM-assisted selection only when grounded in the Fletcher profile/resume context
- [ ] Add no-LLM fallback for checkbox/select/paragraph fields using deterministic defaults and manual-review flags
- [ ] Use the same candidate profile context as Fletcher for generated paragraph answers
- [ ] Support external LLM keys for answer generation where configured
- [ ] Add account creation/login support only for normal user-driven signup flows, with manual handoff for email/SMS codes
- [ ] Do not bypass CAPTCHA, bot detection, MFA, or access controls; detect these states and stop for manual action
- [ ] Validate live extension polling from C0/C4 pending-fill queue
- [ ] Validate live fill-result postback through C0 into C4/run state
- [ ] Package extension for repeatable local install/update

## C4 : Coordinator Polish

- [ ] Add better documentation for prompts, agent roles, and how orchestration decisions are made
- [ ] Build C0 UI for run queue, run detail, events, and submit approvals
- [ ] Add HTTP endpoint for request-fill so operators do not need a correctly-env'd CLI fallback
- [ ] Validate live C3 bridge in a real browser session, not only API-level fake fill results
- [ ] Validate submit approval and final-status artifacts with real fill evidence
- [ ] Add unattended guardrails: one active run limit, retry budget, cooldowns, and stale-run recovery
- [ ] Add ready/not-ready explanation in UI using C4 reason codes
- [ ] Add richer tests for readiness predicates and state transitions
- [ ] Document server2 runtime env for C4 API and CLI parity

## Deployment / Server2

- [ ] Local all-component smoke: `docker-compose.pipeline.yml` with Postgres, C0, C1, C2, C4, frontend
- [ ] Server2 C0 + Postgres smoke: dashboard loads, queue browses, artifacts resolve
- [ ] Server2 C1 smoke: scrape/enrich against production DB, scheduler steady-state
- [ ] Server2 C2 smoke: generate-ready with real C1 jobs
- [ ] Server2 C3 smoke: extension polls C0, fills one safe test application page, posts result
- [ ] Server2 C4 smoke: real run moves through apply-prepared -> fill-requested -> awaiting-submit-approval -> approved/denied
- [ ] Ansible v2 stages remain outside this repo; update deployment docs when those tasks land
