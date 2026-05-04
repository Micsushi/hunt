# C1 Local Runbook

Human/operator runbook for local C1 work. This is the supported path when you want to run scrape or enrich from your own machine instead of `server2`.

## What this covers

- saving or checking a local LinkedIn browser session
- switching between headless and headful enrichment
- running headed Linux sessions through Xvfb
- running scrape and enrich locally on Windows with `hunter.ps1` or `hunter.cmd`
- proving that a real Easy Apply row stays excluded from C4

## Prerequisites

- repo checked out locally
- Python environment installed: `.venv` or `venv`
- Playwright browsers installed
- local `.env` filled in if you need custom paths, service token, or Discord webhook
- LinkedIn auth state saved to `.state/linkedin_auth_state.json` if you want LinkedIn enrichment

## Save or check a local browser session

Check whether a saved auth state already exists:

```powershell
.\hunter.ps1 auth-check
```

If auth is missing or stale, save a fresh one in a visible Chrome window:

```powershell
.\hunter.ps1 auth-save
```

Windows cmd version:

```bat
hunter.cmd auth-check
hunter.cmd auth-save
```

Linux/macOS version:

```bash
./hunter.sh auth-check
./hunter.sh auth-save
```

## Headless and headful runs

Default enrichment is headless. Use this for normal unattended checks:

```powershell
.\hunter.ps1 enrich 10 --source linkedin
```

Use headful when you need to watch the browser or debug a blocked row:

```powershell
.\hunter.ps1 enrich 10 --source linkedin --headful
```

Use a one-row visible verification pass when you already know the job id:

```powershell
.\hunter.ps1 enrich --source linkedin --job-id 123 --ui-verify
```

If you want discovery without immediately opening browsers:

```powershell
.\hunter.ps1 scrape --skip-enrichment
```

If you want discovery plus a bounded local enrichment pass:

```powershell
.\hunter.ps1 scrape --limit 5
```

## Linux Xvfb

Use Xvfb when the machine has no desktop but you still need headed Chromium.

One-off shell:

```bash
xvfb-run -a ./hunter.sh enrich 10 --source linkedin --headful
```

Persistent display:

```bash
Xvfb :98 -screen 0 1920x1080x24 &
export DISPLAY=:98
./hunter.sh auth-save
./hunter.sh enrich 10 --source linkedin --headful
```

If the repo is running on the server-shaped systemd setup, you can inspect the service with:

```bash
./hunter.sh xvfb-status
```

## Windows local scrape and enrich

PowerShell path:

```powershell
.\hunter.ps1 queue
.\hunter.ps1 scrape --skip-enrichment
.\hunter.ps1 jobs --source linkedin --status pending --limit 10
.\hunter.ps1 enrich 5 --source linkedin --headful
```

cmd path:

```bat
hunter.cmd queue
hunter.cmd scrape --skip-enrichment
hunter.cmd jobs --source linkedin --status pending --limit 10
hunter.cmd enrich 5 --source linkedin --headful
```

This is local-only. You do not need to deploy to `server2` just to test C1 scraping or enrichment behavior on your own machine.

## Real Easy Apply proof

This is the shortest honest proof that Easy Apply is detected by C1 and excluded by C4.

1. Run a real LinkedIn scrape or identify a real pending LinkedIn row:

```powershell
.\hunter.ps1 scrape --skip-enrichment
.\hunter.ps1 jobs --source linkedin --status pending --limit 20
```

2. Pick a real LinkedIn job id that is known to be Easy Apply and enrich it in a visible browser:

```powershell
.\hunter.ps1 enrich --source linkedin --job-id 123 --ui-verify
```

3. Verify the Stage 2 fields:

```powershell
.\hunter.ps1 verify 123 --expect-type easy_apply
```

4. Verify that C4 still excludes it:

```powershell
.\hunter.ps1 verify-easy-apply 123
.\hunter.ps1 c4-ready 123
```

Expected result:

- `verify` passes with `apply_type=easy_apply`
- `auto_apply_eligible=0`
- no external `apply_url`
- `verify-easy-apply` passes
- `c4-ready` reports `ready=false` and `reason=easy_apply_excluded`
