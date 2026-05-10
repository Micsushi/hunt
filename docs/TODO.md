# Hunt : TODO

Work in progress and polish backlog. See `docs/roadmap.md` for the status of each component.

## Current State Snapshot

This is your current confidence snapshot (subjective, as of 2026-05-08). The backlog is longer than this confidence view:

- C0: mostly done
- C1 / Hunter: about 95% done
- C2 / Fletcher: about 90% done
- C3: generic `filler` exists and passes basic plus Greenhouse-like browser-backed fixture tests; the loaded Chrome extension, C4 bridge, and live ATS paths are not tested end to end yet
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
- [x] Verify C3 formatting and tests with `python ci.py c3` on 2026-05-10
- [x] Add C3 Options import from TeX resume to prefill profile basics and report remaining blanks
- [x] Add C3 Activity Log for extension state changes and fill attempts, with JSON export and clear controls
- [x] Add `filler` route that uses only extension-local profile/default resume storage for ordinary pages
- [x] Add named fill routes: `filler`, `ats_filler`, `db_filler`, `db_ats_filler`, `c4_filler`, `c4_ats_filler`
- [x] Add generic field-rule lists for profile fields, job-context fields, resume upload phrases, required markers, and exclusions
- [x] Add generic descriptor matching over input type, autocomplete, data-testid, data-automation-id, name, id, aria-label, placeholder, and nearby label/container text
- [x] Harden generic descriptor matching for Greenhouse-like hosted career pages: sibling label text, wrapper text, contenteditable textboxes, React-safe value setting, and hidden resume file inputs behind Attach buttons
- [x] Harden shared profile matching so contaminated descriptors like `last name ... first name` choose `profile:lastName`, and Workday inventory logs exact profile value sources instead of generic `profile`
- [x] Make popup/manual fills run inside same-tab iframes and choose the best frame result. This covers custom Greenhouse embeds such as Hootsuite, where the visible application form lives in a `job-boards.greenhouse.io` iframe inside a Webflow parent page
- [x] Compact C3 popup layout so added status notifications do not create a full popup scrollbar. Popup now uses a wider fixed body, clipped status text, denser two-column detail grids, ellipsized values, and compact action buttons
- [x] Add first safety guardrails from live screenshots: do not upload resume into cover-letter inputs, stop after one resume upload per fill run, skip Workday address-line/postal/work-history/education profile fills, and skip generated answers for Workday work-history/education textareas
- [x] Replace popup `Clear Context` with `Clear Current Page`, which clears form fields/selections/files on the active tab across frames without clearing saved job context/profile/resume. Remove `Poll C4 Once` from the popup; C4 polling remains in Options
- [x] Add Fill required fields only setting. Default is on; when off, generic filler fills optional fields it can confidently match and still skips unknown/dangerous fields
- [x] Log generic field inventory on fill attempts: kind, tag/type, name, id, descriptor text, required flag, filled status, value source, skip reason, and screen rectangle
- [x] Add local backend debug log sink for C3 testing. Extension activity/fill results can post to `/api/c3/debug-log`; backend appends JSONL to `logs/c3_extension_debug.jsonl`, which Codex can inspect directly
- [x] Disable automatic log downloads by default. Keep Download JSON logs after fills and Export Logs Now as manual backup paths
- [x] Add generic support for Greenhouse/React-style combobox selects. City/location, legal work authorization, sponsorship/relocation, and salary-comfort questions now commit a dropdown option instead of only typing into the internal input
- [x] Prevent generic profile-location matching from answering legal/work-authorization questions just because the label contains the word `location`
- [x] Improve Clear Current Page for uploaded file cards by clicking visible remove/delete controls near uploaded file/resume/cover-letter rows, not only clearing file inputs
- [x] Add C3 profile fields for reusable application answers: co-op terms completed, Summer 2026 availability, interview-window availability, expected graduation year, and previous employers
- [x] Fill Hootsuite/Greenhouse-style custom dropdowns from those structured profile fields when saved; leave them manual when the fact is unknown
- [ ] Validate detected-page prompt on likely signup/application/ATS pages. Code scaffold injects a Hunt prompt on all URLs when page text/form signals look relevant, but this still needs loaded-extension testing
- [x] Add `hunter.ps1 c3-package` to create a downloadable zip and unpacked extension folder under `dist/c3/`
- [x] Add `hunter.ps1 c3-store-deploy` to upload an existing C3 item through the Chrome Web Store API v2
- [ ] Validate extension-side C0/C4 polling in a real loaded Chrome extension. Code scaffold exists for polling `/api/c3/pending-fills`, opening one apply URL, filling, and posting back, but it has not been browser-smoked
- [ ] Validate C3 settings for backend URL, service token, polling enabled/disabled, poll interval, heartbeat interval, and one-active-run lock in real Options UI
- [ ] Validate MV3 `chrome.alarms` polling worker wakeups in a real loaded extension session
- [ ] Validate real extension postback to `/api/c3/fill-result` with run id, status, final URL, filled fields, missing required fields, generated answers used, resume upload status, manual-review flags, screenshots, and HTML evidence
- [ ] Add stale-run handling: if a fill starts but the tab closes, login blocks, or the browser crashes, post a failed/manual-review result instead of leaving the C4 run stuck
- [ ] Validate C3 heartbeat/status reporting. Code scaffold posts `/api/c3/status`, but C0 does not yet show extension online/offline clearly
- [ ] Validate `<all_urls>` manifest scope for C3 testing. It enables prompt detection/manual fill on ordinary sites, but prompt noise and privacy posture still need review before release packaging

Browser proof and test gaps:
- [ ] Add a cross-platform `python smoke.py c3` entrypoint. `docs/LOCAL_POSTGRES_SMOKES.md` currently says no C3 smoke exists
- [ ] Add Playwright persistent-context harness that loads the unpacked extension, seeds profile/settings/apply context, opens fixture pages, clicks Fill, and asserts field values
- [ ] Add local safe fixture pages for Workday-like, Lever-like, Ashby-like, non-job profile/contact forms, and richer custom-widget cases. Basic generic application, Greenhouse-like hosted careers, generic signup/account, and simple two-step fixtures exist
- [x] Add first browser-backed generic required-field fixture and test
- [x] Add browser-backed Greenhouse-like generic fixture and test for sibling labels, required stars, contenteditable links, and hidden resume upload input
- [ ] Manually load the unpacked Chrome extension, import `main.tex`, add missing phone, run `filler` against `executioner/fixtures/generic/basic_required.html`, inspect fields, and export Activity Log evidence
- [ ] Manually retest `filler` on `careers.hootsuite.com` or another Greenhouse-style hosted careers page after reloading the unpacked extension. Confirm First Name, Last Name, Email, LinkedIn if present, and Resume/CV fill; confirm Preferred First Name and Phone follow the required-only setting
- [ ] After iframe patch, confirm Hootsuite popup fill records a nonzero frame result and latest attempt field inventory comes from the Greenhouse iframe rather than the parent Webflow page
- [ ] Manually test Fill required fields only on/off. Confirm optional known fields fill only when off, and unknown optional questions stay blank
- [ ] Manually inspect exported Activity Log/latest attempt data and confirm field inventory includes labels/descriptors, ids, required flags, skip reasons, and filled value sources
- [ ] Manually test Local debug log sink from C3 Options: start backend, save Backend URL/service token, click Test Log Sink, and confirm `logs/c3_extension_debug.jsonl` receives an entry
- [ ] Manually run one fixture or live safe fill with Local debug log sink enabled and confirm the JSONL includes activity, detection, field inventory, fill result, and selected route
- [ ] Manually retest Hootsuite custom select questions after 2026-05-10 structured answer patch. Expected: city/province selects `Elsewhere in Canada` for an Edmonton profile when exact Edmonton is unavailable; legal eligibility selects `Yes`; salary comfort selects `Yes`; co-op terms, term availability, interview availability, graduation year, and previous employer fill only after their profile fields are saved
- [ ] Manually retest Clear Current Page on Hootsuite/Greenhouse after 2026-05-10 uploaded-file clear patch. Expected: uploaded resume/cover-letter file cards are removed when the page exposes visible remove/delete buttons
- [ ] Manually test Download JSON logs after fills as an optional backup: enable it, run one fixture fill, and confirm a JSON file appears under the Chrome Downloads folder prefix, default `hunt-c3-logs/`
- [x] Replace C3 log export blob URL with a service-worker-safe JSON data URL and add export success/failure feedback. Retest loaded extension: expected folder is Chrome Downloads `hunt-c3-logs/`
- [ ] Manually test `filler` against `executioner/fixtures/generic/signup_account.html`; confirm known contact fields fill and username/password stay empty
- [ ] Manually test `filler` against `executioner/fixtures/generic/two_step_application.html`; confirm current-step fields fill, no automatic next/review click happens, and second-step fields require a second manual fill after navigation
- [ ] Manually test the auto prompt: open signup/account, generic application, and ATS-like pages and confirm the prompt appears only on relevant pages, dismiss works, and Fill known fields uses the current tab
- [ ] Add fixture coverage for text inputs, selects, custom comboboxes, radio groups, checkboxes, textareas, file uploads, required-field errors, multi-page forms, and final review pages
- [ ] Add screenshot + HTML snapshot assertions so failures produce useful artifacts instead of only "fill failed"
- [ ] Add API-level smoke that creates a C4 run, requests fill, lets the extension poll it, fills a local fixture page, posts the result, and verifies the run reaches `awaiting_submit_approval` or `manual_review`

Generic top-down fill gaps:
- [x] Add first generic required-field pass for normal HTML inputs/selects/radio groups/file inputs using labels, placeholders, aria labels, surrounding text, and required markers
- [x] Support generic sibling/wrapper labels and hidden resume file inputs common on hosted careers pages
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
- [ ] Validate Workday resume upload after 2026-05-10 patch: default resume must be saved in Options; adapter now scans hidden enabled file inputs and logs `resume_upload:missing_resume_data` when no PDF is cached
- [ ] Retest Workday My Information after 2026-05-10 profile matcher patch. Previously popup `Fill Current Page` used `ats_filler` and could fill Last Name as `Michael` because nearby descriptor text also contained First Name
- [ ] Retest Workday after 2026-05-10 safety guardrails. Previous screenshot showed `Edmonton, AB` incorrectly placed in address lines, postal code, job title, company, and work location; role description got a generic generated answer; resume uploaded multiple times
- [ ] Add explicit C3 profile fields for street address, city, province/state, postal code, phone number, phone device type, school, degree, field of study, graduation date, work history, and cover letter before enabling those fill targets
- [ ] Validate Options resume save after 2026-05-10 patch: saving now writes the PDF directly to extension storage, preserves cached PDF on metadata edits, and shows top-right toast success/failure
- [ ] Validate extension toasts: Options save/warning toasts appear top-right, and page-level missing-resume/fill-result toasts appear top-right on ATS pages
- [ ] Handle Workday custom widgets, including comboboxes, search/dropdown pickers, repeated forms, date pickers, checkbox groups, file-drop upload zones without file inputs, and validation banners
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
- [ ] Add C3 answer-decision backend route so the extension sends unresolved required questions to backend instead of calling models directly
- [ ] Reuse `fletcher.llm.client.generate_json` for C3 fixed-choice and paragraph-answer decisions, with deterministic validators after every model response
- [ ] Add C3 LLM provider status endpoint that reports selected provider, Ollama reachability, and cloud blocked/ready state without exposing secrets
- [ ] Add C3 answer prompt cases: profile fact to option, yes/no policy, location option resolver, generated paragraph, sensitive/optional skip, and site memory
- [ ] Add C3 answer settings: enable LLM fallback, allow cloud providers for C3, allow generated paragraphs, confidence threshold, and medium-confidence review behavior
- [ ] Store generated-answer history by normalized question hash so repeated employer questions can reuse reviewed answers

Account, auth, and manual-control gaps:
- [ ] Account creation support: extension fills known signup fields, then pauses for the operator to complete email/SMS verification manually
- [ ] Detect CAPTCHA, bot checks, MFA prompts, account locks, and access-control pages; stop and surface them clearly in C0
- [ ] Keep final submit approval human-gated. C3 should fill and stop at review/submit until a narrow future allowlist exists
- [ ] Add operator controls: pause polling, cancel active fill, retry current fill, clear active context, open evidence, and mark manual review resolved
- [ ] Add signed Chrome Web Store/release-channel packaging after the standalone fixture smoke is passing

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
