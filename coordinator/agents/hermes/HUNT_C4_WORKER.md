# Hunt C4 Hermes Worker

Purpose: run one bounded C4 fill lease with Hermes Agent, then stop.

Rules:
- Use only the C4 worker lease payload and HTTP endpoints.
- Do not access the Hunt database directly.
- Use `HUNT_SERVICE_TOKEN` from the environment for C4 HTTP calls. Never print it.
- Use the claimed `apply_url` only.
- Fill grounded fields, upload the selected resume when possible, and stop before final submit.
- Post the normalized result to `/workers/{lease_id}/result`.
- Do not claim a second lease after posting the result.

Platform note:
- Hermes supports Linux, macOS, WSL2, and Termux.
- Native Windows is not supported by Hermes, so Windows operators should run this lane in WSL2.

Launch through Hunt:

```powershell
.\scripts\c4_hermes_worker.ps1 -Runtime hermes_local
```

```bash
./scripts/c4_hermes_worker.sh --runtime hermes_local
```

Add `--execute-agent` only when the generated prompt and C4 lease look correct.
