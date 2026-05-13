# C3 Live Artifact Summary

Updated: 2026-05-13

## Rule Applied

The vault instructions say durable agent lessons, investigations, and handoff notes belong in the vault. Repo docs should stay small and human-readable. Raw p chrome JSON dumps and console logs are temporary debugging artifacts, so the repo keeps this compact summary and the vault keeps the deeper operational memory.

## Cleaned Artifacts

- Removed `c3-live-*.json`: 13 UBC Workday live page-walk snapshots.
- Removed `console-*.log`: 10 p chrome console captures.
- Removed raw artifact size: about 2.7 MB.
- Left older `page-*.yml` snapshots alone because this cleanup targeted C3 live JSONs and console logs.

## Live Run Lessons

- UBC Workday full page walk reached Review step 6 of 6 and stopped before final Submit.
- Earlier page 4 runs failed on required equity/disclosure questions:
  - Indigenous identity.
  - Racialized / visible minority.
  - Disability.
- Workday `Save and Continue` is safe for page walking, but final Submit must remain blocked.
- Previous-worker true/false radios should choose `No` for the saved profile.
- Secondary questionnaire dropdowns need parent-chain context when visible labels are only `Select One Required`.
- Workday-rendered labels can drop an `s`, so disclosure matching needs tolerant text matching.
- Equity/disclosure questions must outrank generic location matching.
- Stale same-URL Workday tabs can make fills target old My Information pages; prefer active/newer application tabs and close stale targets during fresh smokes.

## Console Lessons

Most saved console output was Workday report-only Content Security Policy logging, not actionable extension failure.

- `Content Security Policy`: 4,233 lines.
- `Promise`: 236 lines.
- `TypeError`: 4 lines, all `undefined is not iterable`, with no useful stack in saved captures.
- `Something went wrong`: 0 lines.
- `Please refresh`: 0 lines.
- `commit_not_verified`: 0 lines.
- `workday_runtime_error`: 0 lines.

For the Workday refresh-required screen, the screenshot/page body was more useful than console logs. C3 now detects `Something went wrong` plus `Please refresh the page and then try again` and refreshes once.

## Future Artifact Policy

- Keep future raw captures only while actively debugging.
- Move durable lessons into the C3 vault status/handoff or this human summary.
- Delete bulky raw captures after the lesson is captured.
- Prefer compact smoke output by default, with verbose dumps only when actively diagnosing a failed page.
