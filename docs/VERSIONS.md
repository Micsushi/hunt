# Hunt: Version Roadmap (Draft)

This document is a **planning note**: it describes likely future expansions and version milestones.
It is intentionally **non-binding** and will be refined as the system is used in production.

**Naming:** C1–C4 code names (Hunter, Trapper, Executioner, Coordinator) and repo layout (`hunter/` package, `trapper/`, `coordinator/`, etc.) are summarized in **`docs/NAMING.md`**. C1 runtime code lives in the **`hunter`** Python package; the file **`hunter/scraper.py`** is only the discovery entrypoint (historical filename), not a separate component.

## Component Versions (Code Names)

Hunt is split into four long-term components:

| Component | Name | Current version | Notes |
|---|---|---:|---|
| C1 (Hunter) | discovery + enrichment | 0.1 | Python package `hunter/`; Stage 4 ops polishing remains |
| C2 (Trapper) | resume tailoring | 0.0 | `trapper/`; local-only checkpoint: not deployed |
| C3 (Executioner) | browser autofill + apply assistance | 0.0 | extension; local-only checkpoint: not deployed |
| C4 (Coordinator) | orchestration + submit control | 0.0 | `coordinator/`; partial local checkpoint: not deployed |

## What "C1 (Hunter) v0.1" Means

C1 is considered v0.1 when it is "operationally usable" on `server2`:
- backlog can be drained safely with small-batch defaults
- blocked/browser-fixable failures leave inspectable artifacts (screenshot + html + text)
- queue health is visible in one place (CLI + JSON + review app + metrics)
- unattended timer cycles behave predictably
- deploy/update is reproducible without manual container/service repair

## Future Version Ideas (Draft)

The items below are **intended directions**, not committed scope.

### v0.2: Control plane UX and interactive review surface

Goal: make the review webapp the default operator surface for C1.

Likely expansions:
- settings view: show the active runtime knobs (sources enabled, batch sizes, intervals, retry budgets)
- interactive tables: filters, sorting, bulk actions, and per-row actions (requeue, force re-enrich, open artifacts)
- safer operator defaults surfaced in UI (LinkedIn-friendly drain sizes)
- clearer "what is running" state (timer status, auth paused/ready, last run timestamps)

Non-goals:
- multi-user accounts and per-user config (see v0.3+)
- automated apply or submit behavior (C3/C4 territory)

### v0.3: Company-first discovery lane

Goal: discover jobs from **company career pages / ATS endpoints**, not only job boards.

Likely expansions:
- a "companies" registry (target companies with canonical domains and career entrypoints)
- source connectors for common ATS families (where stable)
- improved dedup across sources into one job identity

### v0.4: Multi-user + profiles

Goal: support multiple users with separate preferences and data visibility.

Likely expansions:
- authentication + sessions
- per-user profile/config overrides (search terms, watchlists, role targets, scoring prefs later)
- ownership / isolation strategy for jobs and artifacts (shared table with owner fields vs per-user DB)

### v0.5: DB reshaping and higher-signal fields

Goal: reduce low-value fields and add higher-signal fields that improve ranking, filtering, and later automation.

Examples of higher-signal fields (subject to change):
- company canonicalization: canonical name, domain, optional company id
- richer location/remote classification (remote/hybrid/onsite + normalized geo fields)
- posting freshness: posted/first_seen/last_seen timestamps
- compensation fields when available
- stronger apply URL evidence: final resolved URL, redirect trace summary, hostname drift flags

Note: whether this is **breaking** or **non-breaking** depends on when the system is stable enough to migrate live server DBs safely.

### v0.6: Test coverage and release hardening

Goal: very high coverage on critical paths so C1 changes are safe and predictable.

Likely expansions:
- unit tests: DB helpers, enrichment policy, URL normalization, queue logic
- integration tests: temp SQLite, artifact writing, review endpoints, metrics wiring
- fixtures-based parsing tests for board/ATS HTML shapes (avoid brittle live-web tests)

## Cross-Cutting Principles (Keep)

- keep deployment split by component (C1/C2/C3/C4)
- do not attempt CAPTCHA / anti-bot bypass behavior
- keep apply-context resolution explicit and centralized (avoid rebuilding ad hoc in prompts)

