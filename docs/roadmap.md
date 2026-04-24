# Hunt : Roadmap

Automated job application pipeline. Discover → Enrich → Tailor resume → Autofill → Submit.

## Components

| ID | Name | Code | Version | Status |
|---|---|---|---|---|
| C1 | Hunter | `hunter/` | 0.1 | Stage 4 ops — server2 validation pending |
| C2 | Fletcher | `fletcher/` | 0.1 → 1.0 | LLM tailoring + candidate profile needed for v1.0 |
| C3 | Executioner | `executioner/` | 0.0 | Local only — Workday fill works, not deployed |
| C4 | Coordinator | `coordinator/` | 0.0 | Local checkpoint — not deployed, tests are placeholder |

## Current Priority

1. C1 server2 production validation (backlog drain, steady-state timer, Ansible Stage 6)
2. C2 v1.0 — fill candidate profile, wire LLM tailoring, validate C1→C2 handoff on server2
3. C3 hardening — Workday flows, resume upload gap, C4 trigger surface
4. C4 tests + hunterctl consistency + live C3 bridge
5. C4 OpenClaw/server2 integration (last)

## Cross-Component Data Flow

```
C1 (Hunter)
  → enrichment_status=done, apply_url, ats_type, description
C2 (Fletcher)
  → selected_resume_pdf_path, selected_resume_ready_for_c3
C4 (Coordinator) [apply-prep]
  → c3_apply_context.json (apply_url + resume bytes)
C3 (Executioner)
  → fill result, evidence, manual-review flags
C4 (Coordinator)
  → submit approval / manual handoff
```

## Deployment Split

Each component deploys in its own Ansible stage. Never fold a later component into an earlier stage. See `docs/deployment.md`.

## Principles

- Standalone-first: every component should be runnable and testable on its own. C0 should work from `backend/app.py` + shared DB/artifacts; C1/C2/C3 should keep direct CLI/manual paths; only C4 is intentionally coupled to other components.
- LinkedIn is highest-priority source
- LinkedIn Easy Apply is classified and excluded at C1 — never reaches C3/C4
- `priority = 1` jobs are always manual-only
- Submit is always a separate explicit decision from fill
- Do not attempt CAPTCHA/anti-bot bypass
- All code runs on both Windows (local dev) and Linux (server2)

## Component Docs

Read these to find the next thing to work on — feature status, bugs, what's in progress:

- `docs/components/component1/README.md`
- `docs/components/component2/README.md`
- `docs/components/component3/README.md`
- `docs/components/component4/README.md`
