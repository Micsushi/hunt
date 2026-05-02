# Hunt : TODO

Work in progress and polish backlog. See `docs/roadmap.md` for the status of each component.

## Current State Snapshot

This is your current confidence snapshot (subjective, as of 2026-05-01). The backlog is longer than this confidence view:

- C0: mostly done
- C1: about 70% done
- C2: about 30% working
- C3: not tested end to end yet
- C4: not really implemented end to end yet

Use that snapshot as the reality check when reading the detailed lists below.

## Foundation 

- [x] Postgres schema defined in `schema/postgres_schema.sql`

## Cross-Component

Things that cut across all services.

- [x] Operator status page — shows what is up or broken across C0-C4 in one view

## C0 : Dashboard and Control Panel

C0 is the web interface and API gateway. The frontend is a React single-page app; the backend is a Python/FastAPI server that proxies requests to C1-C4.

- [x] Primary operator pages are in the React app; `/legacy/*` server-rendered routes still exist as fallback while they are retired

## C1 : Hunter (job scraper and enricher)

C1 scrapes LinkedIn for job listings and enriches them with full job descriptions. Runs as a service on server2 and as a CLI tool locally.

- [x] Validate a full production cycle on server2: scrape → enrich → write artifacts → drain queue → confirm scheduler holds steady
- [ ] Confirm the C1 CLI works standalone on both Windows and Linux without Docker (entry points exist: hunter.ps1, hunter.sh, hunter.cmd — needs a real test run on each platform)
- [ ] Add API endpoint tests: status, queue, scrape, enrich, auth failure handling, and duplicate-run prevention (service.py has all 5 endpoints; no test coverage yet)
- [ ] Add structured log events for scrape start/end, enrich batch summary, retry exhaustion, and artifact writes (auth pauses and rate limiting already notify via Discord/C1Logger)
- [x] LinkedIn auth handling: per-account state tracking (active / blocked / cooling down) in `linkedin_session.py`; C0 LinkedIn accounts page handles reauth
- [x] Account rotation: `rotate_linkedin_account()` finds next non-blocked account and auto-relogs; blocked accounts cool down for 7 days
- [ ] Discord alert for high job-failure rate (auth trouble, rate limiting, and automation detection already send alerts)
- [ ] Verify Easy Apply filtering with a real live C1 run (code exists: easy_apply sets auto_apply_eligible=0 and excludes from C4 queue)
- [ ] Write a runbook for: setting up a local browser session, switching between headless/headful mode, and running Xvfb on Linux
- [ ] Document a Windows-friendly path to run scrape/enrich locally without deploying to server2 (hunter.ps1 and hunter.cmd exist; no written guide yet)
- [x] Hunter CLI: status, auth, scrape, enrich, requeue, smoke test, and 60+ other operator commands all implemented in hunterctl.py

## C2 : Fletcher (resume tailor)

C2 takes a job description and a base resume, then generates a tailored resume using an LLM. Runs as a service (Ollama-backed) and through the C0 web UI.

- [ ] Confirm the web UI end-to-end: C0 page → C0 gateway → C2 service → tailored resume back in the browser
- [ ] Accept resume input as PDF, LaTeX source, or plain text (currently limited)
- [ ] Accept a job description or a list of keywords as the tailoring target
- [ ] Accept a candidate profile separately, or derive it from the resume if none is provided
- [ ] Option to add a summary section when the base resume doesn't have one
- [ ] Show the generated summary for review before inserting it into the resume
- [ ] Show a full resume preview before the user accepts the generated output
- [ ] Nice to have: show a diff between the original and tailored resume
- [ ] Nice to have: undo changes to individual resume sections
- [ ] Nice to have: regenerate individual sections independently instead of the whole resume at once
- [ ] Auto-run: automatically generate tailored resumes for jobs C1 finds and queues, without manual triggers
- [ ] Fill in `fletcher/candidate_profile.md` with real work history and profile info — this is the grounding context the LLM uses for all generation
- [ ] Wire actual LLM tailoring for bullet points and section rewrites (currently uses basic prompts)
- [ ] Support external LLM API keys (e.g. OpenRouter, Google) so the service doesn't require a self-hosted Ollama instance
- [ ] Evaluate which free OpenRouter models work best as fallbacks
- [ ] Evaluate Google free-tier API as an option
- [ ] Decide whether using multiple OpenRouter accounts to stay under rate limits is acceptable
- [ ] Validate the C1 → C2 handoff on server2 using real enriched job data

## C3 : Executioner (browser form filler)

C3 is a Chrome extension that polls C4 for pending fill jobs, fills out job application forms automatically, and posts the result back. ATS = applicant tracking system (e.g. Workday, Greenhouse, Lever) — the software companies use to manage applications.

- [ ] Restructure the extension so adding support for a new ATS is straightforward — one adapter file per ATS
- [ ] Harden the Workday flow: handle multi-page forms, move to the next page automatically, fill fields on load, and save evidence (screenshots/HTML) for each step
- [ ] Before filling, identify all required fields and fill anything that has a known answer from the candidate profile or resume
- [ ] For fields with no fixed answer, use LLM generation only when it can be grounded in the profile/resume context — no hallucinating answers
- [ ] Fallback for fields the LLM can't confidently answer: use safe deterministic defaults and flag them for manual review
- [ ] Use the same candidate profile as Fletcher for all generated paragraph answers so answers are consistent across the pipeline
- [ ] Support external LLM API keys for answer generation (same as C2)
- [ ] Account creation support: extension fills the signup form, then pauses and waits for the operator to complete email/SMS verification manually before continuing
- [ ] Phase 2 account creation: auto-retrieve verification codes from email so signup is fully unattended
- [ ] Bot detection and CAPTCHA: use fingerprint spoofing, human-like timing, and CAPTCHA solver integration (e.g. 2captcha) where possible
- [ ] Detect MFA prompts and account locks; surface them clearly in C0 when they can't be bypassed automatically
- [ ] Validate live polling: extension picks up a real pending fill from the C4 queue through C0
- [ ] Validate live postback: extension submits a real fill result and C4 updates the run state correctly
- [ ] Package the extension for repeatable install and update (not just "load unpacked" in Chrome dev mode)

## C4 : Coordinator (run orchestrator)
Reality check: C4 has scaffolding and some smoke/API-level pieces, but it is still early. Do not treat it as a finished orchestration component yet.

C4 manages application runs — it decides when a job is ready to apply for, requests a browser fill from C3, waits for the result, and handles the final submit approval step.

- [ ] Document how C4 makes decisions: what prompts it uses, what each agent role does, and how the state machine transitions work
- [ ] C0 UI pages for C4 are already built — validate run queue, run detail, approvals, and event log against a real C4 run
- [ ] Validate and document the fill-request HTTP flow (`/run`, `/runs`, `/c3/pending-fills`, `/c3/fill-result`) so operators can use it confidently from C0 and scripts
- [ ] Validate the full C3 bridge with a real browser session, not just the fake API-level fill used in smoke tests
- [ ] Validate submit approval end-to-end: approve a run and confirm the final artifact is written with real fill evidence attached
- [ ] Unattended guardrails: limit to one active run at a time, cap retries, add cooldown periods, auto-recover stale runs that get stuck
- [ ] Show a ready/not-ready explanation in C0 using C4 reason codes — operator should be able to see exactly why a job isn't being run yet
- [ ] More tests for readiness checks and state transitions
- [ ] Document the server2 runtime environment so C4 CLI and API behave the same way on both Windows and Linux

## Deployment / Server2

Smoke tests are quick end-to-end checks that confirm a deployment is working. Run these after any significant change or deploy.

- [ ] **Local full-stack smoke**: spin up `docker-compose.pipeline.yml` (Postgres + C0 + C1 + C2 + C4 + frontend) and verify the pipeline works end to end
- [ ] **Server2 C0 smoke**: dashboard loads, job queue browses, artifacts resolve
- [ ] **Server2 C1 smoke**: scrape and enrich run against production DB, scheduler stays steady
- [ ] **Server2 C2 smoke**: generate a tailored resume using a real C1-enriched job
- [ ] **Server2 C3 smoke**: extension polls C0, fills one safe test application page, posts the result back
- [ ] **Server2 C4 smoke**: a real run moves through the full state machine: apply-prepared → fill-requested → awaiting-submit-approval → approved/denied
- [ ] Ansible v2 deploy stages are tracked in a separate repo — update deployment docs here when those land
