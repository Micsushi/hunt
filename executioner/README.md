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
- generic descriptor matching over type/autocomplete/data attributes/name/id/labels/placeholders/nearby text
- Fill required fields only setting, with optional-known-field fill when disabled
- field inventory logging on fill attempts for detected descriptors, requiredness, skip reasons, and value sources
- automatic JSON log export through Chrome Downloads after fill attempts, enabled by default for C3 testing
- Workday resume upload now scans enabled file inputs even when hidden behind the upload/drop zone and logs missing resume data as manual review
- Options saves default resume PDFs directly to extension storage and shows top-right success/warning toasts
- Content pages can show top-right Hunt toasts for fill results and missing-resume warnings
- browser-backed basic generic fixture test for the standalone `filler` path
- C4 polling/postback scaffold: settings, `chrome.alarms`, one-shot poll, result postback, and lightweight status heartbeat
- detected-page consent prompt for likely signup, application, and ATS pages; manual Fill Current Page remains available on any active tab
- same-application step detection so Workday/ATS pages can re-prompt after Next/Continue without a full reload
- popup Fill Current Page and Clear Current Page dismiss existing Hunt in-page prompts/toasts before running
- Workday form fill, resume upload, and generated-answer support
- ATS detection and support matrix for Greenhouse, Workday, Lever, Ashby, Workable, SmartRecruiters, and enterprise ATS backlog systems
- Hootsuite-style embedded Greenhouse routing through frame URL and embedded selector signals
- React Select-style dropdown commit verification, realistic pointer/key event sequences, stale menu closing, and Clear Current Page cleanup
- LLM help flow for unresolved required fixed-choice fields with recomputed pending counts after verified browser commits
- C3 gap report command for local JSONL logs: `python scripts\c3_gap_report.py --limit 3 --include-fields`
- controlled browser launcher for local extension testing: `powershell -NoProfile -ExecutionPolicy Bypass -File scripts\launch_c3_chrome.ps1`
- controlled browser placement override: `HUNT_C3_CHROME_WINDOW_POSITION=x,y` and `HUNT_C3_CHROME_WINDOW_SIZE=width,height`; by default it tries a non-primary monitor
- route names for standalone, DB-backed, and C4-backed generic or ATS-specific fills
- step-class autofill pipeline in `src/background/fill-runner.js` for tab resolution, ATS detection, route selection, adapter fill, LLM staging, persistence, and response building
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
- treat C4 polling/postback as incomplete until a loaded-extension browser smoke proves it
- treat broad all-site prompt detection as incomplete until noisy-site and fixture testing proves the signal is acceptable

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

Change summary:

See `docs\C3_CHANGES_SO_FAR.md` for the human-readable C3 autofill process,
current status, verification commands, and known limits.
