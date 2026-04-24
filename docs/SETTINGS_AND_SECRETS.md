# Settings and Secrets

Purpose: one place for component settings, LinkedIn account storage, tokens, and secret-handling rules.

## Storage Model

Use one generic settings table:

```text
component_settings(component, key, value, value_type, secret, updated_at, updated_by)
```

`component` values: `c0`, `c1`, `c2`, `c3`, `c4`.

`value_type` values: `string`, `integer`, `float`, `boolean`, `json`.

`secret = 1` means value must not be returned to frontend after save. Return metadata only.

## Validation

Generic storage != unvalidated. Each component owns a settings schema in code; rejects unknown/invalid values.

Minimum validation:

| Field | Rule |
|---|---|
| `component` | must be one of `c0`..`c4` |
| `key` | lowercase snake_case |
| `value_type` | must match parser |
| `value` | must parse as declared type |
| `secret` | secrets redacted from UI responses |

## Suggested Settings

C1 Hunter:

| Key | Type | Purpose |
|---|---|---|
| `search_terms` | json | Search term list |
| `locations` | json | Search locations |
| `run_interval_seconds` | integer | Continuous/scheduled interval |
| `enrichment_batch_limit` | integer | Max rows per enrichment batch |
| `linkedin_account_id` | integer | Active LinkedIn account |

C2 Fletcher:

| Key | Type | Purpose |
|---|---|---|
| `model_backend` | string | `heuristic`, `ollama`, future backends |
| `model_name` | string | LLM model |
| `timeout_seconds` | integer | Generation timeout |
| `default_resume_profile` | string | Default candidate profile key/path |

C3 Executioner:

| Key | Type | Purpose |
|---|---|---|
| `poll_interval_seconds` | integer | Extension polling interval |
| `autofill_on_load` | boolean | Default fill behavior |
| `manual_submit_required` | boolean | Must remain true unless policy changes |
| `ats_field_mappings` | json | Shared mappings; local extension settings may override |

C4 Coordinator:

| Key | Type | Purpose |
|---|---|---|
| `max_active_runs` | integer | Usually `1` |
| `cooldown_seconds` | integer | Delay after failed/blocked runs |
| `default_resume_fallback` | string | Resume to use when C2 output absent |
| `auto_approve_submit` | boolean | Default false |

## LinkedIn Accounts

Use dedicated table:

```text
linkedin_accounts(
  id,
  email,
  password_encrypted,
  display_name,
  active,
  auth_state,
  storage_state_path,
  last_auth_at,
  last_used_at,
  cooldown_until,
  auth_error,
  created_at,
  updated_at
)
```

Rules:

- C0 UI: manage account records. C1: login/re-auth.
- Passwords encrypted at rest with `HUNT_CREDENTIAL_KEY`.
- Auth/session state files: runtime data dir, not repo checkout.
- Default: one active account unless rotation explicitly enabled.
- Locked/cooldown accounts: C1 must not select.

## Secret Env Vars

| Var | Owner | Purpose |
|---|---|---|
| `HUNT_ADMIN_PASSWORD` | C0 | UI login |
| `HUNT_SERVICE_TOKEN` | all services | Backend/component service auth |
| `HUNT_CREDENTIAL_KEY` | C0/C1 | Encrypt/decrypt LinkedIn passwords |
| `HUNT_DB_URL` | server services only | Postgres connection |
| `REVIEW_OPS_TOKEN` | C0 legacy | Old ops token during transition |

C3 extension must not receive `HUNT_DB_URL`.

## Rotation

- Rotate `HUNT_SERVICE_TOKEN` by deploying new token to all services, then restarting services.
- Rotate `HUNT_CREDENTIAL_KEY` by decrypting each secret with old key, writing with new key, then restarting C0/C1.
- After failed decrypt, do not delete credentials. Mark account `auth_state = unknown` and require operator action.

