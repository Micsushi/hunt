# C2 Fletcher Service API

Target v2 internal API. Called by C0 backend only.

Base URL env in C0: `C2_API_URL`.

## Auth

All requests include `Authorization: Bearer <HUNT_SERVICE_TOKEN>`.

## `GET /status`

Health check.

Response:

```json
{
  "online": true,
  "component": "c2",
  "db": "ok",
  "model_backend": "ollama"
}
```

## `POST /generate`

Generate resume for an existing DB job.

Request:

```json
{
  "job_id": 123,
  "profile_id": "default",
  "force": false
}
```

Response:

```json
{
  "accepted": true,
  "request_id": "uuid",
  "status": "queued"
}
```

## `POST /generate-once`

One-off generation from C0 file drop. Use multipart form:

| Field | Required | Purpose |
|---|---|---|
| `job_description` | yes | Text or uploaded JD file |
| `resume_source` | yes | Uploaded resume/profile file |
| `profile_id` | no | Candidate profile key |

Response includes generated artifact metadata:

```json
{
  "status": "done",
  "pdf_path": "/runtime/artifacts/fletcher/job-123/resume.pdf",
  "tex_path": "/runtime/artifacts/fletcher/job-123/resume.tex",
  "attempt_id": 55
}
```

## `GET /attempts/{id}`

Return generation attempt status.

Response:

```json
{
  "attempt_id": 55,
  "status": "done",
  "job_id": 123,
  "selected_resume_ready_for_c3": true
}
```

