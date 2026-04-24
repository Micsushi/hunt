# C3 (Executioner) : Runbook

Operational how-to for the browser extension. For feature status and known issues: `README.md`.

## Install Extension (Dev Mode)

1. Build or use unpacked source: `executioner/`
2. Chrome → `chrome://extensions` → Enable Developer Mode
3. Load unpacked → select `executioner/`
4. Extension icon appears in toolbar

## Setup

1. Open extension options page
2. Fill in candidate profile (name, contact, work history, skills)
3. Upload default resume PDF
4. Configure settings (auto-fill on load, answer generation policy)

## Standalone Use (Manual)

1. Navigate to a supported job application page (Workday)
2. Click extension popup → Fill
3. Review filled fields, correct any errors
4. Upload resume if prompted
5. Submit manually

## Queue-Driven Use (with C4)

1. Run `hunter apply-prep <job_id>` — writes `c3_apply_context.json`
2. C4 opens `apply_url` in browser
3. C4 loads context into extension session
4. Extension fills form using context
5. Review fill result in C4 orchestration run

## Per-Job Apply Context (Manual Import)

If C4 isn't wired yet, load context manually:
1. Run `hunter apply-prep <job_id>`
2. Open extension popup → Import Context
3. Paste or load `c3_apply_context.json`
4. Fill as normal

## Checking Attempt History

Attempt log is append-only. View from extension popup → History tab, or query:
```bash
hunter job <job_id>
```

## ATS Coverage

| ATS | Status |
|---|---|
| Workday | In progress — primary target |
| Greenhouse, Lever, Ashby, etc. | Planned — after Workday stable |
