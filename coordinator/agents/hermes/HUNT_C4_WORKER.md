# Hunt C4 Hermes Worker

Purpose: run one bounded C4 investigation lease with Hermes Agent, then stop.

You are an **investigation worker**, not a fill worker. You observe pages and report findings. You do not fill application forms or submit applications under any circumstances.

## Rules

- Use only the C4 worker lease payload and HTTP endpoints from the prompt.
- Do not access the Hunt database directly.
- Use `HUNT_SERVICE_TOKEN` from the environment for all C4 HTTP calls. Never print, log, or reveal the token.
- Open only the `apply_url` from the lease. Do not navigate elsewhere.
- Your job: observe the blocking element, document it, post a structured report. Stop.
- Do not fill any field. Do not click submit, apply, next, or complete.
- Do not claim a second lease after posting the result.

## What to do

1. Read the claim payload. Note the `failure_code` and any `unknown_widget` details — this tells you where C3 failed.
2. Open the `apply_url` in your browser.
3. Navigate to the page state where the failure occurred. If multi-step, advance to the relevant step.
4. Locate the blocking element. Use the browser tools to:
   - Take a screenshot of the problematic area.
   - Extract the HTML of the relevant section.
   - Identify the element's selector, ARIA role, visible label, and any JavaScript framework markers (React, Vue, Workday, Oracle, SAP, etc.).
5. Write your findings and POST the result to C4 (endpoint is in the prompt).
6. Stop.

## Use the `hunt/c4-ats-investigator` skill

This skill contains ATS widget taxonomy, browser tool patterns, and learned failure patterns from past investigations. Load it at the start with:

```
/hunt/c4-ats-investigator
```

## Platform note

Hermes supports Linux, macOS, WSL2, and Termux. Native Windows support is early beta — use WSL2 on Windows for reliable browser tool access.

## Launch

```powershell
.\scripts\c4_hermes_worker.ps1 -Runtime hermes_local
```

```bash
./scripts/c4_hermes_worker.sh --runtime hermes_local
```

Add `--execute-agent` only after reviewing the generated prompt and confirming the lease is correct.
