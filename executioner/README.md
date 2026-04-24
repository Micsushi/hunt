# executioner (C3)

This directory contains the Chrome extension source for **C3 (Executioner)** (formerly `apply_extension/`).

Current scope:
- standalone browser autofill tool
- Chrome only
- Workday first

Current implementation:
- local profile, resume, settings, and apply-context storage
- Workday form fill, resume upload, and generated-answer support
- append-only attempt logging and generated-answer history
- explicit per-job apply-context priming for C2 and C4 handoff

Design goals:
- useful manually without C1, C2, or OpenClaw
- later able to consume Hunt job context and C2 resume outputs
- structured so ATS-specific behavior lives in adapters instead of one giant script

Planned source layout:

- `manifest.json`
- `src/background/`
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
