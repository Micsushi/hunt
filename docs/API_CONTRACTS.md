# Hunt API Contracts

Purpose: stable contract between C0 backend, component service APIs, and C3 extension polling. This is target v2 unless an endpoint already exists in code.

Rule: frontend calls C0 backend only. C0 backend calls component services. C3 extension calls C0 backend only.

## Auth

- Browser UI uses `hunt_session` HTTP-only cookie.
- Component-to-C0 and C0-to-component calls use a service token header:
  - Header: `Authorization: Bearer <token>`
  - Env: `HUNT_SERVICE_TOKEN`
- Local dev may disable service-token checks only with explicit dev config.

## Common Response Shapes

Health:

```json
{
  "online": true,
  "component": "c1",
  "version": "unknown",
  "db": "ok",
  "detail": null
}
```

Accepted async work:

```json
{
  "accepted": true,
  "request_id": "uuid-or-run-id",
  "status": "queued"
}
```

Error:

```json
{
  "error": {
    "code": "invalid_request",
    "message": "human-readable detail",
    "retryable": false
  }
}
```

## C0 Backend Public API

Existing C0 browse/review endpoints stay under `/api/*`. New gateway endpoints:

| Endpoint | Caller | Purpose |
|---|---|---|
| `GET /api/status` | frontend | Health for DB + C1/C2/C3/C4 |
| `GET /api/settings/{component}` | frontend, C3 | Read component settings |
| `PUT /api/settings/{component}` | frontend | Replace/update component settings |
| `GET /api/linkedin/accounts` | frontend | List LinkedIn accounts |
| `POST /api/linkedin/accounts` | frontend | Add encrypted account |
| `PATCH /api/linkedin/accounts/{id}` | frontend | Update active flag/display/status fields |
| `POST /api/linkedin/accounts/{id}/reauth` | frontend | Ask C1 to re-login account |
| `POST /api/c1/scrape` | frontend | C0 forwards to C1 `POST /scrape` |
| `POST /api/c1/enrich` | frontend | C0 forwards to C1 `POST /enrich` |
| `POST /api/c2/generate` | frontend | C0 forwards DB-backed generation to C2 |
| `POST /api/c2/generate-once` | frontend | Upload one file/job payload for one-off resume generation |
| `POST /api/c4/runs` | frontend | Start orchestration run |
| `GET /api/c4/runs` | frontend | List orchestration runs |
| `GET /api/c4/runs/{id}` | frontend | Run detail |
| `POST /api/c4/runs/{id}/approve` | frontend | Record submit approval |
| `GET /api/c3/pending-fills` | C3 extension | Poll next fill request |
| `POST /api/c3/fill-results` | C3 extension | Return fill result/evidence |

## Component Service APIs

Component services are internal. C0 backend is expected caller.

| Component | Detail doc |
|---|---|
| C1 Hunter | `docs/components/component1/api.md` |
| C2 Fletcher | `docs/components/component2/api.md` |
| C3 Executioner | `docs/components/component3/backend-contract.md` |
| C4 Coordinator | `docs/components/component4/api.md` |

## C3 Pipeline Contract

C4 creates fill request in DB. C0 exposes it to C3 through polling. C3 sends result back to C0. C0/C4 update DB lifecycle state.

C3 must not receive `HUNT_DB_URL` or direct DB credentials. This keeps browser extension deployable on local machines and avoids exposing database secrets.

## Status Semantics

`/api/status` should report:

```json
{
  "db": { "online": true, "engine": "postgres" },
  "hunter": { "online": true },
  "fletcher": { "online": false, "reason": "C2_API_URL unset" },
  "executioner": { "online": false, "reason": "no recent poll" },
  "coordinator": { "online": true }
}
```

C3 online status is heartbeat-based. Each C3 poll updates last-seen time.

