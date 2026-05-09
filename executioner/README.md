# executioner (C3)

This directory contains the Chrome extension source for **C3 (Executioner)** (formerly `apply_extension/`).

Current scope:
- standalone browser autofill tool first
- DB/C4 job-context fill later through explicit routes
- Chrome only
- generic required-field fill first, Workday as the first ATS-specific adapter

Current implementation:
- local profile, resume, settings, and apply-context storage
- standalone generic fill for obvious required identity/contact/job-context fields
- Workday form fill, resume upload, and generated-answer support
- route names for standalone, DB-backed, and C4-backed generic or ATS-specific fills
- append-only attempt logging and generated-answer history
- explicit per-job apply-context priming for C2 and C4 handoff

Design goals:
- useful manually without C0, C1, C2, C4, or OpenClaw
- later able to consume Hunt job context and C2 resume outputs
- generic fill can act as fallback when an ATS adapter does not understand a field
- structured so ATS-specific behavior lives in adapters instead of one giant script

Fill routes:

- `standalone_generic`: extension-local profile/resume, generic required-field fill
- `standalone_ats_specific`: extension-local profile/resume, ATS adapter
- `db_generic`: DB/job context plus generic required-field fill
- `db_ats_specific`: DB/job context plus ATS adapter
- `c4_generic`: C4 fill request plus generic fallback
- `c4_ats_specific`: C4 fill request plus ATS adapter

Planned source layout:

- `manifest.json`
- `src/background/`
- `src/ats/generic/`
- `src/ats/workday/`
- `src/content/`
- `src/options/`
- `src/popup/`
- `src/shared/`
- `fixtures/workday/`

Implementation notes:
- keep the first milestone framework-light
- favor plain JavaScript until the extension behavior is stable
- isolate DOM selectors and field-mapping heuristics by ATS family
- keep generated-answer sanitization in shared utilities so every caller uses the same rules
