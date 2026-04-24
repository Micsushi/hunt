# C1 Hunter Service API

Target v2 internal API. Called by C0 backend only.

Base URL env in C0: `C1_API_URL`.

## Auth

All requests include `Authorization: Bearer <HUNT_SERVICE_TOKEN>`.

## `GET /status`

Health check.

Response:

```json
{
  "online": true,
  "component": "c1",
  "db": "ok",
  "linkedin_auth_state": "ok"
}
```

## `POST /scrape`

Trigger one discovery run.

Request:

```json
{
  "terms": ["python developer"],
  "locations": ["remote"],
  "limit": 25,
  "enrich_after_scrape": true
}
```

All fields optional. Omitted fields use `component_settings`.

Response: accepted async work shape from `docs/API_CONTRACTS.md`.

## `POST /enrich`

Trigger one enrichment batch.

Request:

```json
{
  "limit": 25,
  "source": "linkedin",
  "ui_verify_blocked": false
}
```

`source` valid values: `linkedin`, `indeed`, `all`.

## `GET /queue`

Return queue health.

Response:

```json
{
  "pending": 10,
  "processing": 0,
  "done": 123,
  "failed": 4,
  "new_linkedin_pending": 3,
  "old_backlog_pending": 7
}
```

## `POST /accounts/{id}/reauth`

Trigger LinkedIn login for one stored account.

Response:

```json
{
  "accepted": true,
  "account_id": 1,
  "status": "reauth_started"
}
```

On completion C1 updates `linkedin_accounts.auth_state`, `last_auth_at`, `auth_error`, and `storage_state_path`.

