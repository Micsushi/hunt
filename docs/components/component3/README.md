# C3 (Executioner) : Browser Autofill Extension

Code lives in `executioner/`. Chrome extension — no server-side process. Repo-level operator commands go through `hunter` CLI. See `docs/CLI_CONVENTIONS.md`.

## Goal

Chrome extension: autofill external job application forms. Works standalone (no C1/C2/C4 needed) and accepts explicit apply-context payloads from C4 for queue-driven orchestration.

## Locked Decisions

- Chrome extension only — runs on operator's local machine, not a server container
- Workday first — harden before widening ATS coverage
- Standalone/manual use is always required
- Auto-fill on page load + manual click-to-fill both supported
- Generated paragraph answers must be stored for review
- Long dash character is stripped from generated text
- OTP, CAPTCHA, protected verification flows → manual handoff, not automation
- No autonomous submit decisions — submit is always a separate explicit step
- `priority = 1` jobs are manual-only, same as all components
- C3 must remain directly usable without C0/C4
- C3 does not receive DB credentials and does not write to DB directly
- In pipeline mode, C3 posts fill results to C0; backend/C4 update job/run state
- C3 settings have two surfaces: the extension options page (local, for ATS-specific config) and the C0 settings panel (stored in `component_settings`, pulled by the extension at fill time)
- Deployment: runs on operator machine — no Ansible server stage

## Feature Status

### Done (local, not deployed)

- [x] Chrome extension scaffold (`executioner/`)
- [x] Local profile, resume, settings, per-job apply-context storage
- [x] Workday page detection
- [x] Workday form fill — text inputs, textareas, dropdowns, radio groups
- [x] Resume upload on Workday
- [x] Generated paragraph answers with storage
- [x] Append-only attempt logging
- [x] C2/C4 apply-context priming support (explicit context import)
- [x] Auto-fill on page load toggle
- [x] Manual click-to-fill

### In Progress / Needs Work

- [ ] **Stronger answer grounding** from selected resume facts — current answers weakly grounded
- [ ] **Resume upload in queue-driven mode** — plain filesystem path not enough for extension upload; needs bytes or C3-side cached file payload
- [ ] **Richer auth/account helpers** — signed-in detection; login helper flows
- [ ] **Harden Workday flows** — manual fill, auto-fill-on-load, generated-answer storage, attempt/evidence persistence all need more real-world testing
- [ ] **Define stable C4 trigger surface** — import context, request fill, read result/evidence
- [ ] **Broader ATS support** — only after Workday is stable
- [ ] **Packaging and operator polish** — load packed extension, install helper
- [ ] **Validate explicit C2/C4 handoff** — selected resume + resolved apply URL + per-job apply context

### Bugs / Known Issues

- [!] **Resume upload gap** — extension uploads from a cached file payload (embedded resume data), not a raw filesystem path. Queue-driven C4 flows must provide resume bytes or a C3-side cached copy, not just a path.
- [!] **Not production-deployed** — local-only checkpoint; no Ansible stage yet.

## Component Contract

**C3 apply context fields** (passed in `c3_apply_context.json`):

| Field | Required | Purpose |
|---|---|---|
| `apply_url` | yes | resolved external ATS URL |
| `resume_bytes` | yes | base64-encoded resume PDF |
| `ats_type` | yes | ATS platform hint |
| `job_id` | no | DB row ID for backend result correlation |
| `orchestration_run_id` | no | run ID for backend/C4 result correlation |

**C3 result write-back logic (post-fill):**
1. `HUNT_BACKEND_URL` unset? Save fill result locally, done.
2. `HUNT_BACKEND_URL` set? Post result to `POST /api/c3/fill-results`.
3. Backend/C4 updates `jobs`, `orchestration_runs`, `orchestration_events`, and `submit_approvals` as needed.

C3 never queries or writes to the DB directly.

**C3 pipeline mode (polling):**
When `HUNT_BACKEND_URL` is set, C3 polls `GET /api/c3/pending-fills` for work queued by C4. No inbound connection from server is needed — C3 opens the outbound connection.

**C3 settings sources (priority order):**
1. Extension options page (local) — ATS-specific field mappings, autofill policy
2. `component_settings` table pulled via `GET /api/settings/c3` at fill time — operator-managed defaults

**C3 hands off** fill result summary, generated answers, evidence screenshots, manual-review flags, and attempt status by posting to C0.

**Standalone mode:** `HUNT_BACKEND_URL` unset — extension uses last provided resume and context, no C1/C2/C4 needed, fill result saved locally only.

## Related

- `runbook.md` : operational how-to (install, load, test)
- `design.md` : architecture, data model, rollout notes
- `backend-contract.md` : C0 polling/result contract
- `executioner/` : implementation
- `docs/components/component4/README.md` : C4 orchestration contract
- `docs/DATA_MODEL.md` : `jobs.status` field, `orchestration_runs` schema
