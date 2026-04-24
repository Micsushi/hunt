# SQLite to Postgres Migration

Purpose: move Hunt from server2 SQLite to Postgres while keeping local dev and rollback sane.

Current v1 uses SQLite via `HUNT_DB_PATH`. Target v2 uses Postgres via `HUNT_DB_URL`.

## Goals

- Preserve all existing jobs, enrichment fields, resume attempts, orchestration records, runtime state, and artifacts.
- Keep artifact files on disk under `HUNT_ARTIFACTS_DIR`.
- Allow local dev to keep SQLite fallback during transition.
- Make server2 production use Postgres only after migration validation.

## Non-Goals

- No schema redesign hidden inside migration.
- No direct browser-extension DB access.
- No hardcoded server paths in Python.

## Compatibility Phase

DB access code should choose:

1. `HUNT_DB_URL` set -> Postgres
2. else `HUNT_DB_PATH` set -> SQLite
3. else repo-local fallback only for tests/dev

During compatibility, migrations must run against both engines or have clearly separate migration paths.

## Migration Order

1. Freeze C1 timer and C0 write actions.
2. Back up SQLite DB:

```bash
sqlite3 /home/michael/data/hunt/hunt.db ".backup '/home/michael/data/hunt/hunt-$(date +%Y%m%d-%H%M%S).db'"
```

3. Create Postgres database/user with Ansible.
4. Apply Postgres schema.
5. Copy table data from SQLite to Postgres.
6. Validate row counts and sample records.
7. Point server services at `HUNT_DB_URL`.
8. Start C0 backend read-only first.
9. Start C1/C2/C4 services.
10. Re-enable scheduler.

## Validation Checklist

Compare row counts:

- `jobs`
- `resume_attempts`
- `resume_versions`
- `runtime_state`
- `orchestration_runs`
- `orchestration_events`
- `submit_approvals`
- `component_settings`
- `linkedin_accounts`

Spot-check:

- Latest LinkedIn job has same `job_url`, `apply_url`, `description`, `enrichment_status`.
- Existing generated resume artifact paths still point to readable files.
- C0 dashboard loads queue.
- C1 can insert one dry-run/test discovery row in staging or dev.
- C2 can read one enriched job and write one attempt.
- C4 can create one test orchestration run.

## Rollback

If validation fails before services are switched:

- Drop Postgres DB.
- Keep SQLite deployment unchanged.

If validation fails after switch:

1. Stop C1/C2/C4 services.
2. Stop C0 backend.
3. Restore env to `HUNT_DB_PATH`.
4. Restart v1 services.
5. Keep failed Postgres DB for inspection.

Any writes made to Postgres after cutover are not automatically copied back to SQLite. Treat rollback after writes as data-loss risk unless reverse export is performed.

## Local Dev

Windows local dev may keep SQLite until Postgres support is complete. Tests that cover DB access should run against both engines when behavior matters.

