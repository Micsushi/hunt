# C4 (Coordinator) : Runbook

Operational how-to for orchestration. For feature status and known issues: `README.md`. For server2 layout: `docs/deployment.md`.

Unlike C0/C1/C2/C3, C4 is not standalone end-to-end: useful orchestration requires upstream C1/C2 data and downstream C3 integration.

## CLI

`hunter <cmd>` or `python -m coordinator.cli <cmd>`

| Command | What it does |
|---|---|
| `hunter apply-prep <job_id>` | Resolve DB row → write apply_context + c3_apply_context + create orchestration run |
| `python -m coordinator.cli apply-prep --job-id <id>` | Same, direct |
| `hunter jobs --status ready` | List jobs passing the ready-to-apply predicate |

## Apply-Prep Flow

```bash
hunter apply-prep <job_id>
```

Produces (in artifacts dir):
- `apply_context.json` — C4 orchestration context
- `c3_apply_context.json` — C3-ready payload with resolved apply URL + resume

Check output to confirm:
- `apply_url` is an external ATS URL (not a LinkedIn/Indeed URL)
- `selected_resume_pdf_path` exists on disk
- `selected_resume_ready_for_c3 = true`

## Checking Orchestration Runs

```bash
# Not yet in hunterctl — query DB directly for now:
python -c "
import sqlite3, json, os
db = os.environ.get('HUNT_DB_PATH', 'hunt.db')
conn = sqlite3.connect(db)
conn.row_factory = sqlite3.Row
rows = conn.execute('SELECT id, job_id, status, started_at FROM orchestration_runs ORDER BY started_at DESC LIMIT 10').fetchall()
for r in rows: print(dict(r))
"
```

## Manual Review Routing

When a run is flagged for manual review:
1. Check `manual_review_reason` on the run record
2. Inspect fill result artifacts at `fill_result_path`
3. Inspect browser summary at `browser_summary_path`
4. Resolve manually, then update run status

Common review triggers:
- Login required / CAPTCHA / OTP
- Unsupported ATS step
- Low-confidence generated answers
- Resume upload failure
- Missing required fields after fill

## Submit Approval

Submit is never automatic at current stage. Every submit requires an explicit approval record in `submit_approvals`. Do not submit without one.

Future: per-ATS allowlists and bounded unattended submit for narrow known-good flows.
