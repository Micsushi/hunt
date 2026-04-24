# C4 Coordinator Service API

Target v2 internal API. Called by C0 backend only.

Base URL env in C0: `C4_API_URL`.

## Auth

All requests include `Authorization: Bearer <HUNT_SERVICE_TOKEN>`.

## `GET /status`

Health check.

Response:

```json
{
  "online": true,
  "component": "c4",
  "db": "ok",
  "active_runs": 0
}
```

## `POST /run`

Start orchestration for one job.

Request:

```json
{
  "job_id": 123,
  "mode": "human_in_loop",
  "browser_lane": "default"
}
```

Response:

```json
{
  "accepted": true,
  "run_id": "run-uuid",
  "status": "queued"
}
```

C4 validates ready-to-apply predicate before creating fill request.

## `GET /runs`

List recent runs.

Query params:

| Name | Purpose |
|---|---|
| `status` | Optional status filter |
| `limit` | Default 50 |

## `GET /runs/{id}`

Return run detail, events, submit approval status, and latest C3 result.

## `POST /runs/{id}/approve`

Approve submit step.

Request:

```json
{
  "approved": true,
  "note": "Reviewed form; okay to submit"
}
```

Creates or updates `submit_approvals`.

## `POST /runs/{id}/fill-result`

Internal endpoint for C0 to forward C3 results when C4 owns run state transitions.

Normally C3 posts to C0 `/api/c3/fill-results`; C0 may either update DB directly or forward to this endpoint depending on implementation.

## Lifecycle Ownership

C4 owns orchestration state. C0/backend owns DB writes when acting as gateway. C3 reports facts only.

`jobs.status` updates should happen in one backend-owned place after submit/final decision, not inside browser extension code.

