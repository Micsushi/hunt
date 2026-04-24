# C4 (Coordinator) : Orchestration and Submit Control

Code lives in `coordinator/`. CLI: shared `hunter apply-prep <id>` plus prefixed `hunter c4-*` wrappers and the direct `python -m coordinator.cli` entrypoint. See `docs/CLI_CONVENTIONS.md`.

## Goal

Coordinate C1→C2→C3 into end-to-end apply runs. Decide when jobs proceed, when C3 fills, and when submit is allowed. Route blocked flows to manual review. OpenClaw is the planned first production runtime.

## Locked Decisions

- C4 coordinates — it does not redefine C1/C2/C3 internal contracts
- Submit is a separate explicit step from fill success — always requires an approval record
- Manual-review routing is explicit and auditable
- One active orchestration run at a time (unattended)
- C4 does not own: scraping logic, resume generation, ATS DOM selectors
- Shared `apply-prep` command is the canonical C4 seam — not ad-hoc DB queries in prompts
- C4 is intentionally coupled: it depends on C1/C2 outputs and a live C3 handoff to perform end-to-end orchestration
- Deployment: separate Ansible stage from C1/C2/C3 — see `docs/deployment.md`

## Ready-to-Apply Predicate

A job is ready for C4 when all are true:
- `enrichment_status = done`
- `apply_type = external_apply`
- `auto_apply_eligible = 1`
- `priority = 0`
- `selected_resume_ready_for_c3 = 1`
- No active manual-review hold

## Feature Status

### Done (local checkpoint, not deployed)

- [x] DB-backed readiness predicate over C1 + C2 state
- [x] Shared apply-prep command: `hunter apply-prep <id>` / `python -m coordinator.cli apply-prep`
  - Creates orchestration run
  - Writes `apply_context.json` (C4)
  - Writes `c3_apply_context.json` (C3-ready)
- [x] Fill-request → fill-result → review → submit-gate state transitions
- [x] `orchestration_runs`, `orchestration_events`, `submit_approvals` tables
- [x] Manual-review flag schema
- [x] Broader C4 tests for readiness, transitions, and scheduler guardrails
- [x] Thin `hunterctl` pass-through commands for current C4 CLI surface
- [x] Optional `browser_lane` metadata on runs and apply-prep artifacts
- [x] Expanded JSON-schema scaffolding for readiness, apply-prep, runs, events, and approvals

### In Progress / Needs Work

- [ ] **Live C3 bridge** — open browser lane, load C3 payload into live extension session, trigger fill without rebuilding context in prompt text
- [ ] **Validate apply-prep against real Hunt DB rows** on server2
- [ ] **Validate fill-request and fill-result transitions** end-to-end
- [ ] **Validate submit approval and final-status artifact writing**
- [ ] **Unattended orchestration guardrails** — one active run limit, retry budgets, cooldown after auth/anti-bot trouble, stop-the-world on broken shared dependency
- [ ] **OpenClaw/server2 integration** — separate C4 runtime storage outside repo checkout, deployment docs, Ansible stage

Recommended order:
1. Validate current C4 scaffold against real Hunt DB rows
2. Wire live C3 bridge
3. Validate end-to-end fill/review/submit-gate flow
4. Only then: OpenClaw/server2 runtime integration

### Bugs / Known Issues

- [!] **Tests are placeholder only** — actual transitions and predicate behavior untested
- [!] **Not production-deployed** — local checkpoint only; no Ansible stage yet
- [!] **hunterctl inconsistently exposes C4 commands** — `apply-prep` works; others need adding

## Component Contract

**C4 receives from C1:** `job_url`, `apply_url`, `ats_type`, `enrichment_status`, `priority`, `auto_apply_eligible`

**C4 receives from C2:** `selected_resume_version_id`, `selected_resume_pdf_path`, `selected_resume_ready_for_c3`, `latest_resume_flags`

**C4 hands off to C3:** `c3_apply_context.json` — resolved `apply_url` + selected resume bytes/path + orchestration run id

**C4 produces:** `orchestration_runs` record, `submit_approvals` record, decision/final-status artifacts

**Coupling rule:** C4 depends on other components by design. C1/C2/C3 must not depend on C4 to perform their own standalone work or testing.

## Related

- `runbook.md` : operational how-to (apply-prep, run status, manual review)
- `design.md` : architecture, research notes, implementation checkpoint
- `hunter-coordinator-plan.md` : Hunter→Coordinator seam planning
- `hunter-coordinator-ops.md` : server2 runtime and monitoring
- `coordinator/` : implementation
- `docs/DATA_MODEL.md` : orchestration_runs / orchestration_events / submit_approvals schema
