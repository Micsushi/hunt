# Hunt : System Roadmap

**Component IDs and code names:** C1 (Hunter), C2 (Trapper), C3 (Executioner), C4 (Coordinator). Repo layout: **`docs/NAMING.md`**.

**Operator CLI:** repo-root **`hunt` / `hunter`** → **`scripts/huntctl.py`**. Conventions and how to add C2–C4 commands: **`docs/CLI_CONVENTIONS.md`**. C1 quick reference: **`docs/C1_OPERATOR_WORKFLOW.md`**.

## Goal

Build a continuously running Linux-hosted system that can:
- discover new job postings
- enrich them with high-quality descriptions and external application URLs
- tailor a LaTeX resume to each job
- automate external job applications where the flow is stable and eligible

The system is split into four major components:
- **C1 (Hunter)** : posting discovery and enrichment (`hunter/` package)
- **C2 (Trapper)** : resume tailoring (`trapper/`)
- **C3 (Executioner)** : browser autofill and apply assistance (extension)
- **C4 (Coordinator)** : orchestration and submit control (`coordinator/`)

Current implementation priority:
1. finish C1 (Hunter) Stage 4 production validation and backlog drain on `server2`
2. keep the Ansible deployment model split by component
   - C1 (Hunter) deploys through the current Hunt-focused job-agent step
   - C2 (Trapper) should deploy in a later separate step/stage
   - C3 (Executioner) should deploy in a later separate step/stage
   - C4 (Coordinator) / OpenClaw integration should deploy in a later separate step/stage
3. continue C1 (Hunter) Stage 4 hardening and backfill work
   - drain backlog safely with the new source-aware backfill flow
   - add failure-artifact capture for blocked/security/browser-fixable rows
   - add machine-readable queue monitoring on top of the existing review app and queue helpers
   - keep Stage 6 Ansible as the deployment home for runtime paths, env vars, and operator docs
   - current implementation now covers the artifact + monitoring plumbing; the remaining work is rollout, backlog drain, and tuning
4. validate the end-to-end handoff from C1 (Hunter) to C2 (Trapper)
5. build C3 (Executioner) only on top of stable external-apply flows
6. add C4 (Coordinator) only after C3 (Executioner) contracts are dependable

Live tracker:
- `todo.md` records the current fix list and remaining sign-off work across all components

## System Principles

- LinkedIn is the highest-priority source
- LinkedIn Easy Apply jobs should be classified and excluded early
- `priority = 1` jobs remain manual-only
- downstream automation should prefer external ATS URLs over job board URLs
- do not mix enrichment lifecycle with application lifecycle
- every stage should be testable in isolation before integrating it into the runner

## Component Summary

### C1 (Hunter) : posting discovery and enrichment

Purpose:
- discover jobs continuously
- store `job_url` as the listing URL
- resolve `apply_url` as the best-known external application URL
- save a usable description
- classify Easy Apply jobs so they are never sent forward

Primary source priority:
- LinkedIn first
- other sources remain useful for breadth and cross-checking

Current status:
- discovery exists
- DB migration for enrichment exists
- LinkedIn browser enrichment exists
- the repo now supports post-scrape enrichment inside the main scrape flow
- the repo now includes Stage 3 runtime code:
  - retry/backoff policy
  - stale-processing recovery
  - retry scheduling backfill for older retryable failures
  - newest-first post-scrape enrichment queue priority
  - queue-health CLI visibility
  - a minimal review/control-plane web app
  - read-only operator tools that avoid queue-maintenance side effects
- current focus is Stage 4 production validation, backlog drain, and deployment polish on `server2`
- the repo now also includes Stage 3.2 runtime code:
  - one source-aware enrichment queue for LinkedIn and Indeed
  - an Indeed enricher built on the same claim/update/retry model
  - a multi-source dispatcher with LinkedIn-first priority
  - source-aware review-app counts and filters
  - a shared browser runtime for UI/browser fallback across supported sources
- the repo now also includes the initial Stage 4 runtime slice:
  - failure-artifact capture
  - machine-readable queue monitoring
  - review-surface artifact visibility
- deployment notes for `server2` live in `docs/components/component1/stage3_server2_plan.md`
- C1 (Hunter) deploys separately from later C2 (Trapper) and C3 (Executioner) work
- remaining sign-off work for C1 (Hunter) is operational:
  - keep discovery quality tight, especially for Indeed
  - finish backlog drain
  - observe one real artifact-producing failure end to end
  - confirm Stage 6 deploys cleanly without manual review-container repair
  - tune steady-state timer/backfill defaults on `server2`

Doc:
- `docs/components/component1/README.md`

### C2 (Trapper) : resume tailoring

Purpose:
- read the enriched description
- extract required and preferred keywords
- rewrite the resume to match the job while staying truthful
- compile LaTeX to PDF and enforce a one-page target
- save a per-job output resume without overwriting the source resume

Current status:
- an initial local runtime now exists under `trapper/`
- the OG resume source has been locked to `main.tex`
- the current local implementation covers:
  - parser and renderer code around `main.tex`
  - deterministic job classification and keyword extraction
  - attempt persistence and selected-resume DB wiring
  - compile plus one-page retry gating
  - shared apply-context fields for later C3 and C4 handoff
- detailed design notes now live in:
  - `docs/components/component2/README.md`
  - `docs/components/component2/design.md`
  - `docs/components/component2/glossary.md`
- remaining work is mostly production hardening:
  - Ollama-backed prompt execution
  - richer family-base resume curation
  - broader review-surface support

Doc:
- `docs/components/component2/README.md`

### C3 (Executioner) : browser autofill and apply assistance

Purpose:
- autofill external application forms through a browser extension
- upload the currently selected resume
- fill application fields using stored candidate data
- generate paragraph responses when needed
- later support orchestration by OpenClaw or another higher-level agent

Current status:
- an initial Chrome-extension implementation now exists under `executioner/`
- the current local implementation covers:
  - local profile, resume, settings, and per-job apply-context storage
  - Workday page detection, form fill, resume upload, and generated answers
  - append-only attempt logging and generated-answer history
  - explicit C2/C4 apply-context priming support
- should remain useful without C1 (Hunter), C2 (Trapper), or OpenClaw
- remaining work is mostly deeper grounding and wider coverage:
  - stronger answer grounding from selected resume facts
  - richer auth/account helpers
  - broader ATS support and packaging polish

Important limitation:
- anti-bot and CAPTCHA bypassing are not a supported goal
- protected flows should be marked for manual review or failure handling instead

Doc:
- `docs/components/component3/README.md`

### C4 (Coordinator) : orchestration and submit control

Purpose:
- coordinate C1 (Hunter), C2 (Trapper), and C3 (Executioner)
- decide when a job should proceed through downstream steps
- decide when C3 (Executioner) should run
- later own final submit policy and higher-level automation behavior

Current status:
- an initial local contract implementation now exists under `coordinator/`
- the current local implementation covers:
  - a shared readiness predicate over C1 and C2 state
  - one shared apply-prep command and payload builder
  - initial CLI, models, and schema contracts
  - basic orchestration-run shaping for fill-only flows
- OpenClaw is still the likely first production runtime target
- should remain separate from C3 (Executioner) so the extension stays usable manually

Doc:
- `docs/components/component4/README.md`

## Cross-Component Data Contract

C1 (Hunter) should hand off:
- job identity and metadata
- enriched description
- apply classification
- external application URL
- ATS classification

C2 (Trapper) should hand off:
- selected resume version
- selected resume PDF path
- latest useful output metadata
- structured metadata about what was changed
- validation result such as page count and compile status
- explicit selected-resume data that downstream apply flows can consume without re-deciding

C3 (Executioner) should hand off:
- account/auth status for the target site
- field mapping results
- generated responses used in the form
- fill/evidence state and review flags

C4 (Coordinator) should hand off:
- orchestration decisions
- submit/not-submit outcomes
- operator-handoff state
- explicit apply context when invoking C3 (Executioner)

## What To Watch Closely

- LinkedIn markup volatility
- ATS URL normalization
- retries and idempotency
- handoff quality between enriched descriptions and resume tailoring
- safe handling of login state and secrets on the Linux server
