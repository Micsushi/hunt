# C3 (Executioner) : Browser Autofill Extension

Code lives in `executioner/`. Chrome extension — no server-side process. Repo-level operator commands go through `hunter` CLI. See `docs/CLI_CONVENTIONS.md`.

## Goal

Chrome extension that autofills external job application forms. Must work standalone (no C1/C2/C4 required) and also accept explicit apply-context payloads from C4 for queue-driven orchestration.

## Locked Decisions

- Chrome extension only
- Workday first — harden before widening ATS coverage
- Standalone/manual use is always required
- Auto-fill on page load + manual click-to-fill both supported
- Generated paragraph answers must be stored for review
- Long dash character is stripped from generated text
- OTP, CAPTCHA, protected verification flows → manual handoff, not automation
- No autonomous submit decisions — submit is always a separate explicit step
- `priority = 1` jobs are manual-only, same as all components
- C3 must remain directly usable without C0/C4
- Deployment: separate from C1/C2/C4 — see `docs/deployment.md`

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

**C3 receives from C4 (queue-driven path):**
- `apply_url` (resolved, not job board URL)
- Selected resume bytes or cached C3 payload (not just a path)
- `ats_type`
- Per-job context (`c3_apply_context.json` written by `hunter apply-prep`)

**C3 hands off to C4:**
- Fill result summary
- Generated answers used
- Evidence paths (screenshots, HTML)
- Manual-review flags
- Attempt status

**Standalone mode:** user is signed in, extension uses last provided resume, no C1/C2/C4 needed.

## Related

- `runbook.md` : operational how-to (install, load, test)
- `design.md` : architecture, data model, rollout notes
- `executioner/` : implementation
- `docs/components/component4/README.md` : C4 orchestration contract
