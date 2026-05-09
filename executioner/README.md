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

- `filler`: extension-local profile/resume, generic required-field fill for ordinary pages
- `ats_filler`: extension-local profile/resume, ATS adapter
- `db_filler`: DB/job context plus generic required-field fill
- `db_ats_filler`: DB/job context plus ATS adapter
- `c4_filler`: C4 fill request plus generic fallback
- `c4_ats_filler`: C4 fill request plus ATS adapter

Planned source layout:

- `manifest.json`
- `src/background/`
- `src/ats/generic/`
- `src/ats/workday/`
- `src/content/`
- `src/options/`
- `src/popup/`
- `src/shared/`
- `fixtures/generic/`
- `fixtures/workday/`

Implementation notes:
- keep the first milestone framework-light
- favor plain JavaScript until the extension behavior is stable
- isolate DOM selectors and field-mapping heuristics by ATS family
- keep generated-answer sanitization in shared utilities so every caller uses the same rules

Packaging:

```powershell
.\hunter.ps1 c3-ci
.\hunter.ps1 c3-package
```

The package command writes:

- `dist/c3/hunt-apply-extension-v<version>/` for Load unpacked
- `dist/c3/hunt-apply-extension-v<version>.zip` for sharing or later store upload

For another user, send the zip or unpacked folder. They can unzip it, open
`chrome://extensions`, enable Developer Mode, choose Load unpacked, and select
the unpacked extension folder.

Chrome Web Store deploy:

After you have created the developer account and item in the Chrome Developer
Dashboard, set:

```powershell
$env:CWS_PUBLISHER_ID = "<publisher-id>"
$env:CWS_EXTENSION_ID = "<extension-id>"
$env:CWS_ACCESS_TOKEN = "<oauth-access-token>"
```

Then run:

```powershell
.\hunter.ps1 c3-ci
.\hunter.ps1 c3-store-deploy --status
```

To submit the uploaded version for review, add `--publish`.
