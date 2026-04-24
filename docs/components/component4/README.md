# C4 (Coordinator) : Orchestration and Submit Control

Code lives in `coordinator/`. CLI: shared `hunter apply-prep <id>` plus prefixed `hunter c4-*` wrappers and the direct `python -m coordinator.cli` entrypoint. See `docs/CLI_CONVENTIONS.md`.

## Goal

Coordinate C1→C2→C3 into end-to-end apply runs. Decide job progression, C3 fill timing, submit gating. Route blocked flows to manual review. OpenClaw: planned first production runtime.

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

**C4 reads from DB:**
- `jobs` — reads C1/C2 handoff fields to determine readiness
- `component_settings` for its own settings (run limits, cooldowns, auto-approve policy)

**C4 writes to DB:**
- `orchestration_runs`, `orchestration_events`, `submit_approvals`
- Lifecycle status updates when acting as orchestrator (`claimed`, `failed`, `skipped`, and final applied/submitted state through backend-owned write path)

**C4 service API** (called by C0 backend):

| Endpoint | Purpose |
|---|---|
| `POST /run` | Start an orchestration run for a `job_id` |
| `GET /runs` | List recent runs with status |
| `GET /runs/{id}` | Single run detail |
| `POST /runs/{id}/approve` | Submit approval — creates `submit_approvals` record |
| `POST /runs/{id}/fill-result` | C3 posts fill result here after completing a fill |
| `GET /status` | Health check — online/offline |

**C3 fill-request queue (C4 → C3):**
C4 writes fill requests to DB. C3 polls `GET /api/c3/pending-fills` via C0 backend. C4 never calls C3 directly — C0 mediates. C3 needs no inbound port.

**C4 hands off to C3** via `c3_apply_context.json`:
- `apply_url` (resolved)
- `resume_bytes` (base64 PDF)
- `ats_type`
- `job_id`
- `orchestration_run_id` (triggers pipeline mode in C3)

**Coupling rule:** C4 depends on other components by design. C1/C2/C3 must not depend on C4 to perform their own standalone work or testing.

**Default-resume rule:** if `selected_resume_ready_for_c3 = 0` (C2 not deployed or generation failed), C4 falls back to a configured default resume rather than blocking the run.

## Related

- `runbook.md` : operational how-to (apply-prep, run status, manual review)
- `design.md` : architecture, research notes, implementation checkpoint
- `api.md` : C4 service API contract
- `hunter-coordinator-plan.md` : Hunter→Coordinator seam planning
- `hunter-coordinator-ops.md` : server2 runtime and monitoring
- `coordinator/` : implementation
- `docs/DATA_MODEL.md` : orchestration_runs / orchestration_events / submit_approvals schema
