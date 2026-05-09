# Hunt : TODO

Work in progress and polish backlog. See `docs/roadmap.md` for the status of each component.

## Current State Snapshot

This is your current confidence snapshot (subjective, as of 2026-05-08). The backlog is longer than this confidence view:

- C0: mostly done
- C1 / Hunter: about 95% done
- C2 / Fletcher: about 90% done
- C3: not tested end to end yet
- C4: API/state-machine scaffold exists; live browser/agent execution not proven yet

Use that snapshot as the reality check when reading the detailed lists below.

## Foundation 

- [x] Postgres schema defined in `schema/postgres_schema.sql`

## Cross-Component

Things that cut across all services.

- [x] Operator status page - shows what is up or broken across C0-C4 in one view

## C0 : Dashboard and Control Panel

C0 is the web interface and API gateway. The frontend is a React single-page app; the backend is a Python/FastAPI server that proxies requests to C1-C4.

- [x] Primary operator pages are in the React app; `/legacy/*` server-rendered routes still exist as fallback while they are retired
- [x] Settings UI: expose C1 configurable values (watchlist, title blacklist, search terms, locations, run interval, enrichment limits, etc.) as editable fields in the web UI - changes persist to a config file on disk so they survive restarts and don't require code changes

## C1 : Hunter (job scraper and enricher)

C1 scrapes LinkedIn for job listings and enriches them with full job descriptions. Runs as a service on server2 and as a CLI tool locally.

- [x] Validate a full production cycle on server2: scrape -> enrich -> write artifacts -> drain queue -> confirm scheduler holds steady
- [x] Confirm the C1 CLI works standalone on both Windows and Linux without Docker (entry points exist: hunter.ps1, hunter.sh, hunter.cmd - needs a real test run on each platform)
- [x] Add API endpoint tests: status, queue, scrape, enrich, auth failure handling, and duplicate-run prevention (covered in `tests/test_component1_service_api.py`)
- [x] Add structured log events for scrape start/end, enrich batch summary, retry exhaustion, and artifact writes (auth pauses and rate limiting already notify via Discord/C1Logger)
- [x] LinkedIn auth handling: per-account state tracking (active / blocked / cooling down) in `linkedin_session.py`; C0 LinkedIn accounts page handles reauth
- [x] Account rotation: `rotate_linkedin_account()` finds next non-blocked account and auto-relogs; blocked accounts cool down for 7 days
- [x] Discord alert for high job-failure rate (fires on high actionable-failure batches with cooldown to avoid Discord spam)
- [ ] Verify Easy Apply filtering with a real live C1 run (use `docs/C1_LOCAL_RUNBOOK.md` plus `hunter verify-easy-apply <job_id>` once a real Easy Apply row exists)
- [x] Write a runbook for: setting up a local browser session, switching between headless/headful mode, and running Xvfb on Linux
- [x] Document a Windows-friendly path to run scrape/enrich locally without deploying to server2 (`docs/C1_LOCAL_RUNBOOK.md`)
- [x] Hunter CLI: status, auth, scrape, enrich, requeue, smoke test, and 60+ other operator commands all implemented in hunterctl.py
- [x] Move watchlist, title blacklist, and search terms out of `config.py` into a user-editable config file (JSON/TOML); C1 reads from file at runtime so changes via settings UI take effect without code deploys
- [x] README: clear, short commands for every key operator action - deploy C0+C1 with Docker, run locally without containers, run tests, start services; add CLI entry points to PATH where needed so commands are one-liners
- [x] Persist local Docker auth state and artifacts through `.hunt-state/` and `.hunt-data/` mounts so local C1 restarts do not lose the saved browser session
- [x] Cover browser-useful C1 operations in the UI: drain, requeue/retry, config edits, Easy Apply verification, and Discord webhook test

## C2 : Fletcher (resume tailor)

C2 takes a job description and a base resume, then generates a tailored resume using an LLM. Runs as a service (Ollama-backed) and through the C0 web UI.

- [ ] Before changing Fletcher review UI, PDF import/export, or LLM provider support, check `docs/superpowers/plans/2026-05-05-c2-review-workspace-pdf-llm-providers.md`
- [x] Confirm the Option B web UI path end-to-end at the C0 API/UI level: C0 page -> queue endpoint -> background worker -> review workspace/history
- [x] Accept resume input as PDF or LaTeX source for Option B. Text-based PDFs import through `pdfminer.six`; scanned PDFs remain unsupported
- [x] Accept a job description as the tailoring target for Option B pasted-JD runs and Option A job-linked runs
- [ ] Accept a raw list of keywords as the tailoring target without a job description
- [ ] Accept a candidate profile separately, or derive it from the resume if none is provided
- [x] Option A master resume YAML path: select a role-family/base resume from `fletcher/master_resume.yaml`, generate from C1 job data, and reuse the ad-hoc pipeline
- [x] Option to add a summary section when the base resume doesn't have one through the `with_summary` review version
- [x] Show the generated summary for review before accepting it through the `with_summary` review workspace
- [x] Show a full resume preview before the user accepts the generated output
- [x] Nice to have: show a diff between the original and tailored resume
- [x] Nice to have: undo changes to individual resume sections through segment/block revert and whole-version reset
- [ ] Nice to have: regenerate individual sections independently instead of the whole resume at once
- [ ] Auto-run: automatically generate tailored resumes for jobs C1 finds and queues, without manual triggers
- [ ] Fill in `fletcher/candidate_profile.md` with real work history and profile info - this is the grounding context the LLM uses for all generation
- [x] Wire actual LLM tailoring for bullet points, keyword extraction, summaries, rewrite validation, and provider-routed JSON calls. Quality tuning remains ongoing
- [x] Support external LLM API keys and provider selection in C2 settings/API scaffolding. Cloud use still requires explicit confirmation and quality smoke tests
- [ ] Evaluate which free OpenRouter models work best as fallbacks
- [ ] Evaluate Google free-tier API as an option
- [ ] Decide whether using multiple OpenRouter accounts to stay under rate limits is acceptable
- [ ] Validate the C1 -> C2 handoff on server2 using real enriched job data
- [ ] Improve generated resume quality with real candidate profile grounding and live reviewed outputs
- [x] Add finer-grained queue progress beyond coarse status: backend milestone groups, persisted visible progress, restart recovery, and completion drain/hold
- [x] Persist Option A completions into job-linked resume attempts/versions and update job latest/selected resume columns for C3 handoff
- [x] Add starting resume artifacts (`starting.pdf` / `starting.tex`) to runs, history rows, detail modal, and batch ZIP downloads
- [x] Add Fletcher history search, newest-finished ordering, compact rows, selectable batch ZIP downloads, and delete finished history rows
- [x] Add queue recovery for backend/container restarts: interrupted running rows requeue with previous-step metadata
- [x] Add clear-generated-resumes operator action that removes generated job-linked attempts/history/artifacts while skipping active runs
- [x] Expand review inspector from one best keyword match to supported, rewrite-added, and other keyword groups with high-confidence candidate chips

## C3 : Executioner (browser form filler)

C3 is a Chrome extension for browser-side form filling. Its first usable mode is standalone: it uses profile and resume data stored inside the extension and can fill obvious required fields on ordinary web forms without C0-C4 running. The later DB/C4 modes add job-specific context and generated C2 resumes, then post results back to the pipeline. ATS = applicant tracking system (for example Workday, Greenhouse, Lever) - the software companies use to manage applications.

Current gap inventory:
- [x] Add safe layered C3 test runbook in `docs/C3_TESTING_RUNBOOK.md`
- [x] Verify C3 formatting and tests with `python ci.py c3` on 2026-05-09
- [x] Add C3 Options import from TeX resume to prefill profile basics and report remaining blanks
- [x] Add C3 Activity Log for extension state changes and fill attempts, with JSON export and clear controls
- [x] Add standalone generic required-field fill route that uses only extension-local profile/default resume storage
- [x] Add named fill routes: `standalone_generic`, `standalone_ats_specific`, `db_generic`, `db_ats_specific`, `c4_generic`, `c4_ats_specific`
- [x] Add generic field-rule lists for profile fields, job-context fields, resume upload phrases, required markers, and exclusions
- [ ] Add extension-side C0/C4 polling. Today the extension supports manual context import and manual fill, but it does not yet poll `/api/c3/pending-fills` on its own
- [ ] Add C3 settings for backend URL, service token, polling enabled/disabled, poll interval, and one-active-run lock
- [ ] Add MV3 `chrome.alarms` polling worker so the service worker can wake up reliably and check for pending fill requests
- [ ] Add real extension postback to `/api/c3/fill-result` with run id, status, final URL, filled fields, missing required fields, generated answers used, resume upload status, manual-review flags, screenshots, and HTML evidence
- [ ] Add stale-run handling: if a fill starts but the tab closes, login blocks, or the browser crashes, post a failed/manual-review result instead of leaving the C4 run stuck
- [ ] Add C3 heartbeat/status reporting so C0 can distinguish "extension offline" from "no pending fills"
- [ ] Expand `manifest.json` host permissions beyond Workday only when adapters are actually implemented. The registry currently lists more ATS families than the manifest can inject into

Browser proof and test gaps:
- [ ] Add a cross-platform `python smoke.py c3` entrypoint. `docs/LOCAL_POSTGRES_SMOKES.md` currently says no C3 smoke exists
- [ ] Add Playwright persistent-context harness that loads the unpacked extension, seeds profile/settings/apply context, opens fixture pages, clicks Fill, and asserts field values
- [ ] Add local safe fixture pages for Workday-like, Greenhouse-like, Lever-like, Ashby-like, generic HTML application forms, generic signup/account forms, and non-job profile/contact forms
- [ ] Add fixture coverage for text inputs, selects, custom comboboxes, radio groups, checkboxes, textareas, file uploads, required-field errors, multi-page forms, and final review pages
- [ ] Add screenshot + HTML snapshot assertions so failures produce useful artifacts instead of only "fill failed"
- [ ] Add API-level smoke that creates a C4 run, requests fill, lets the extension poll it, fills a local fixture page, posts the result, and verifies the run reaches `awaiting_submit_approval` or `manual_review`

Generic top-down fill gaps:
- [x] Add first generic required-field pass for normal HTML inputs/selects/radio groups/file inputs using labels, placeholders, aria labels, surrounding text, and required markers
- [x] Fill matched generic fields one field or one field group at a time with a short delay
- [ ] Add a fuller page inventory object that records field signatures, nearby section text, validation messages, existing values, and nearby navigation buttons
- [ ] Re-observe the page after each generic field write so dynamic validation and newly revealed fields are handled safely
- [ ] Add an LLM field-decision step for ambiguous fields: classify the field/question, choose a value or skip action, cite the source used, and return confidence
- [x] Use deterministic profile/job-context matching before any LLM path for obvious fields like name, email, phone, links, job title, company, job URL, apply URL, and resume upload
- [ ] Support paragraph-question answers such as "Why this company?" by grounding in company name, job description, candidate profile, selected resume facts, and reviewed answer history
- [ ] Add generic account/signup support through the same filler: fill known signup/contact/profile fields, stop for email/SMS verification, CAPTCHA, MFA, account lock, payment, or final irreversible actions
- [ ] Add required/optional policy: required fields are answered when policy and available context allow it; optional fields are skipped by default unless configured otherwise
- [ ] Add EEO/demographic policy: optional EEO/demographic fields are skipped; required EEO/demographic fields are answered only from explicit operator-configured preferences, otherwise manual review
- [ ] Add a confidence gate for LLM decisions: high confidence can fill, medium confidence can fill but flag review, low confidence skips or stops for manual review based on requiredness
- [ ] Store field decisions and outcomes so repeated websites and repeated questions get faster and safer over time

Adapter architecture gaps:
- [x] Start restructuring around a generic filler plus ATS-specific adapters
- [ ] Define adapter methods: detect page state, inventory fields, fill current step, detect required/missing fields, click next, detect submit/review page, collect evidence, and return normalized result
- [x] Treat the generic fallback adapter as the first proof target for normal HTML forms that do not need ATS-specific widgets
- [x] Add a route classifier so generic fill can be standalone, DB-backed, or C4-backed, and ATS-specific fill can use the same source split
- [ ] Add a canonical field registry with field ids, label synonyms, confidence score, value source, and manual-review behavior
- [ ] Add manual mapping memory: when the operator fixes a field mapping, store host/form-signature/field-signature mapping for future runs
- [ ] Add safe retry/stuck recovery: wait for framework hydration, retry failed field set once, detect no-progress loops, then stop and flag manual review
- [ ] Keep adapter behavior deterministic by default. Use LLMs only for custom questions or low-confidence label interpretation after deterministic matching fails

Workday gaps:
- [ ] Harden Workday multi-page flow: fill current step, save evidence, click next, wait for the next step, repeat until the review/submit page
- [ ] Identify all visible required fields before filling and again after each next-page click
- [ ] Handle Workday custom widgets, including comboboxes, search/dropdown pickers, repeated forms, date pickers, checkbox groups, and validation banners
- [ ] Avoid double-filling already completed Workday fields when autofill-on-load fires after navigation
- [ ] Detect Workday account/login/signup pages and pause cleanly for operator action when auth is required
- [ ] Detect final submit/review page and stop before final submission unless a later explicit allowlist says otherwise

ATS coverage gaps:
- [ ] Prove generic top-down fill on fixture websites before relying on ATS-specific expansion
- [ ] Add Greenhouse adapter after the generic filler and Workday have browser-backed passing smokes
- [ ] Add Lever adapter after Greenhouse
- [ ] Add Ashby adapter after Lever
- [ ] Add SmartRecruiters, iCIMS, Jobvite, BambooHR, Workable, Taleo/Oracle, ADP, UKG, Pinpoint, Recruitee, Dover, and JazzHR to the detection/backlog list
- [ ] Keep `hunter/url_utils.py`, `executioner/src/ats/registry.js`, manifest host permissions, and C1 enrichment `ats_type` values in sync
- [ ] Track support levels per target: generic-fill supported, detected only, fixture-smoked, live-smoked, multi-page supported, resume upload supported, account creation supported, custom questions supported

Profile, resume, and answer gaps:
- [ ] Use the same candidate profile as Fletcher for generated paragraph answers so C2 resumes and C3 answers stay consistent
- [ ] Expand the profile model for C3 fields: preferred name, legal name, email, phone, address, links, work authorization, sponsorship, relocation, salary expectations, education, work history, skills, pronouns, and voluntary EEO fields where the operator chooses to store them
- [ ] Add selected-resume context beyond the PDF upload: summary, skills, education, recent projects, and source facts that answer generation can cite
- [ ] For fields with no fixed answer, generate answers only when grounded in profile/resume/JD context. No invented claims
- [ ] Add confidence and source tags to every generated answer: deterministic, profile, resume, job description, LLM, manual
- [ ] Fallback for unanswered required fields: safe deterministic answer only when policy allows it, otherwise leave blank and flag manual review
- [ ] Support external LLM API keys for answer generation using the same provider/config direction as C2
- [ ] Store generated-answer history by normalized question hash so repeated employer questions can reuse reviewed answers

Account, auth, and manual-control gaps:
- [ ] Account creation support: extension fills known signup fields, then pauses for the operator to complete email/SMS verification manually
- [ ] Detect CAPTCHA, bot checks, MFA prompts, account locks, and access-control pages; stop and surface them clearly in C0
- [ ] Keep final submit approval human-gated. C3 should fill and stop at review/submit until a narrow future allowlist exists
- [ ] Add operator controls: pause polling, cancel active fill, retry current fill, clear active context, open evidence, and mark manual review resolved
- [ ] Package the extension for repeatable install/update instead of relying only on Chrome "load unpacked" dev mode

## C4 : Coordinator (run orchestrator)
Reality check: C4 has a real DB-backed state machine, API/CLI surface, C3 bridge tests, submit approval flow, and a Postgres smoke. Do not treat it as finished automation until a real browser-backed worker completes a fill and C4 can recover stale runs.

C4 manages application runs - it decides when a job is ready to apply for, requests a browser fill from C3, waits for the result, and handles the final submit approval step.

- [x] Document the current C4 state machine, readiness gates, API, CLI, artifacts, and current gaps in `docs/C4_COORDINATOR.md`
- [x] Add detailed C4 long-running agent plan with OpenClaw and Hermes research in `docs/superpowers/plans/2026-05-05-c4-long-running-agent-orchestration.md`
- [x] Add HTTP endpoint for the service-level `request_fill` transition: `POST /runs/{run_id}/request-fill`
- [x] Update `scripts/smoke_coordinator_e2e.sh` so it uses public C4 HTTP routes for request-fill instead of mutating `orchestration_runs` directly
- [x] Add worker lease, heartbeat, and result routes so C3/OpenClaw/Hermes can claim exactly one fill and stale workers can be recovered
- [x] Add stale-run reconciliation for timed-out fill workers, old leases, and submit-approved runs that were never confirmed submitted
- [x] Add OpenClaw/Hermes one-shot launcher that claims one lease, writes bounded prompt/result artifacts, and only runs an external agent with explicit `--execute-agent`
- [ ] C0 UI pages for C4 are already built - validate run queue, run detail, approvals, and event log against a real C4 run
- [ ] Validate and document the fill-request HTTP flow (`/run`, `/runs`, `/c3/pending-fills`, `/c3/fill-result`) so operators can use it confidently from C0 and scripts
- [ ] Validate the full C3 bridge with a real browser session, not just the fake API-level fill used in smoke tests
- [ ] Validate submit approval end-to-end: approve a run and confirm the final artifact is written with real fill evidence attached
- [ ] Unattended guardrails: limit to one active run at a time, cap retries, add cooldown periods, auto-recover stale runs that get stuck
- [ ] Show a ready/not-ready explanation in C0 using C4 reason codes - operator should be able to see exactly why a job isn't being run yet
- [ ] More tests for readiness checks and state transitions
- [ ] Document the server2 runtime environment so C4 CLI, API, and one-shot agent worker behave the same way on both Windows and Linux
- [ ] Pilot OpenClaw as a Windows/WSL2/Linux C4 worker using an isolated browser profile first, then an attached user profile only after the fixture smoke passes
- [ ] Pilot Hermes as a WSL2/Linux/server2 C4 worker. Native Windows is not supported by Hermes, so Windows machines should use WSL2 for this lane
- [ ] Keep final submit human-gated for every runtime lane until a separate narrow submit allowlist is designed and tested

## Deployment / Server2

Smoke tests are quick end-to-end checks that confirm a deployment is working. Run these after any significant change or deploy.

- [ ] **Local full-stack smoke**: spin up `docker-compose.pipeline.yml` (Postgres + C0 + C1 + C2 + C4 + frontend) and verify the pipeline works end to end
- [ ] **Server2 C0 smoke**: dashboard loads, job queue browses, artifacts resolve
- [ ] **Server2 C1 smoke**: scrape and enrich run against production DB, scheduler stays steady
- [ ] **Server2 C2 smoke**: generate a tailored resume using a real C1-enriched job
- [ ] **Server2 C3 smoke**: extension polls C0, fills one safe test application page, posts the result back
- [ ] **Server2 C4 smoke**: a real run moves through the full state machine: apply-prepared -> fill-requested -> awaiting-submit-approval -> approved/denied
- [ ] Ansible v2 deploy stages are tracked in a separate repo - update deployment docs here when those land
