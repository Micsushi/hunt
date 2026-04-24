# C3 Backend Contract

C3 is a Chrome extension on the operator machine. It has no server container and no inbound API. It polls C0 backend for work.

## Credentials

C3 receives:

- `HUNT_BACKEND_URL`
- extension auth/session token or service token with C3-only scope

C3 must not receive:

- `HUNT_DB_URL`
- DB username/password
- LinkedIn credentials

## Poll Work

Endpoint: `GET /api/c3/pending-fills`

Caller: C3 extension.

Response when no work:

```json
{
  "items": []
}
```

Response with work:

```json
{
  "items": [
    {
      "fill_request_id": "uuid",
      "job_id": 123,
      "orchestration_run_id": "run-uuid",
      "apply_url": "https://example.workdayjobs.com/job/123",
      "ats_type": "workday",
      "resume_pdf_base64": "JVBERi0x...",
      "profile": {
        "email": "candidate@example.com"
      },
      "policy": {
        "submit_allowed": false,
        "manual_submit_required": true
      }
    }
  ]
}
```

One poll should claim or lease one request so two browser sessions do not fill same job.

## Post Result

Endpoint: `POST /api/c3/fill-results`

Request:

```json
{
  "fill_request_id": "uuid",
  "job_id": 123,
  "orchestration_run_id": "run-uuid",
  "status": "filled",
  "submitted": false,
  "manual_review_required": true,
  "manual_review_reasons": ["submit_confirmation_required"],
  "generated_answers": [
    {
      "field_label": "Why are you interested?",
      "answer": "..."
    }
  ],
  "evidence": {
    "screenshot_paths": [],
    "log_path": null
  },
  "error": null
}
```

Valid `status`: `filled`, `blocked`, `failed`, `submitted`.

DB updates are performed by C0/C4 after result receipt.

## Settings

C3 reads central settings from `GET /api/settings/c3` and merges with local extension options.

Priority:

1. Local extension options for ATS-specific field mappings.
2. Central settings for shared defaults and policy.
3. Hardcoded safe defaults.

`manual_submit_required` must default to true.

