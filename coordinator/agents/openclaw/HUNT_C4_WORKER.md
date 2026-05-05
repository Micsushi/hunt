# Hunt C4 OpenClaw Worker

Purpose: run one bounded C4 fill lease with OpenClaw, then stop.

Rules:
- Use only the C4 worker lease payload and HTTP endpoints.
- Do not access the Hunt database directly.
- Use `HUNT_SERVICE_TOKEN` from the environment for C4 HTTP calls. Never print it.
- Use the claimed `apply_url` only.
- Fill grounded fields, upload the selected resume when possible, and stop before final submit.
- Post the normalized result to `/workers/{lease_id}/result`.
- Do not claim a second lease after posting the result.

Recommended lane order:
- `openclaw_isolated`: fixture and first live proofs.
- `openclaw_attached`: only after isolated fixture proof, for signed-in browser sessions.

Launch through Hunt:

```powershell
.\scripts\c4_openclaw_worker.ps1 -Runtime openclaw_isolated
```

```bash
./scripts/c4_openclaw_worker.sh --runtime openclaw_isolated
```

Add `--execute-agent` only when the generated prompt and C4 lease look correct.
