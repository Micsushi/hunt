# Hunt : Data Model

Logical schema — describes meaning, not storage implementation. Backend is currently SQLite; fields and semantics here remain stable across backend changes (e.g. Postgres/Supabase). Implementation lives in `hunter/db.py`, `fletcher/db.py`, `coordinator/db.py`.

When fields are added or semantics change: update this file as part of the same task.

---

## Entity: Job

Primary record. Written by C1, enriched by C1, then extended by C2 and C4.

### Discovery fields (C1 writes on scrape)

| Field | Type | Purpose | Valid values |
|---|---|---|---|
| `id` | integer, PK | internal row identity | auto |
| `job_url` | string, unique | listing URL — dedupe key | any URL |
| `title` | string | job title | free text |
| `company` | string | company name | free text |
| `location` | string | location string from board | free text |
| `source` | string | which board discovered this | `linkedin`, `indeed` |
| `date_posted` | string | posting date from board | ISO date or board-native string |
| `date_scraped` | string | when C1 wrote this row | ISO datetime UTC |
| `is_remote` | boolean | board-reported remote flag | 0 / 1 |
| `level` | string | seniority level from board | free text |
| `category` | string | search lane / role category | `engineering`, `product`, `data` |
| `description` | string | raw description at discovery | free text |
| `priority` | boolean | manual-apply flag | `0` = automation eligible, `1` = manual only |
| `status` | string | **application lifecycle** — not enrichment | `new`, `claimed`, `applied`, `failed`, `skipped` |
| `operator_notes` | string | human freeform notes | free text |
| `operator_tag` | string | human freeform tag | free text |

### Enrichment fields (C1 writes during enrichment)

| Field | Type | Purpose | Valid values |
|---|---|---|---|
| `apply_url` | string | best known external apply URL | external ATS URL |
| `apply_type` | string | how this job is applied to | `external_apply`, `easy_apply`, `unknown` |
| `auto_apply_eligible` | boolean | whether downstream automation may act | `1` only when `apply_type = external_apply` |
| `apply_host` | string | hostname of external apply destination | e.g. `greenhouse.io` |
| `ats_type` | string | detected ATS platform | `greenhouse`, `lever`, `workday`, `ashby`, `smartrecruiters`, `jobvite`, `icims`, `bamboohr`, `unknown` |
| `enrichment_status` | string | enrichment lifecycle | `pending`, `processing`, `done`, `failed` |
| `enrichment_attempts` | integer | total enrichment attempt count | 0+ |
| `enriched_at` | string | timestamp of last successful enrichment | ISO datetime UTC |
| `last_enrichment_error` | string | error code from last failure | free text / error code |
| `last_enrichment_started_at` | string | claim timestamp for stale-processing recovery | ISO datetime UTC |
| `next_enrichment_retry_at` | string | scheduled next retry | ISO datetime UTC |

### Failure artifact fields (C1 writes on blocked/failed enrichment)

| Field | Type | Purpose |
|---|---|---|
| `last_artifact_dir` | string | directory containing artifacts for last failure |
| `last_artifact_screenshot_path` | string | screenshot at time of failure |
| `last_artifact_html_path` | string | page HTML at time of failure |
| `last_artifact_text_path` | string | page text at time of failure |

### Resume fields — latest attempt (C2 writes)

| Field | Type | Purpose | Valid values |
|---|---|---|---|
| `resume_status` | string | resume generation lifecycle | `pending`, `processing`, `done`, `failed` |
| `latest_resume_attempt_id` | integer | FK to `resume_attempts.id` | |
| `latest_resume_version_id` | string | FK to `resume_versions.id` | |
| `latest_resume_pdf_path` | string | path to latest generated PDF | |
| `latest_resume_tex_path` | string | path to latest generated TeX | |
| `latest_resume_keywords_path` | string | path to keywords JSON | |
| `latest_resume_job_description_path` | string | path to saved JD text | |
| `latest_resume_family` | string | role family used | `software`, `pm`, `data`, `general` |
| `latest_resume_job_level` | string | seniority level used | |
| `latest_resume_model` | string | model backend used | `ollama`, `heuristic` |
| `latest_resume_generated_at` | string | when latest resume was generated | ISO datetime UTC |
| `latest_resume_fallback_used` | boolean | whether heuristic fallback was used | 0 / 1 |
| `latest_resume_flags` | string | JSON concern flags from generation | JSON array |
| `latest_resume_jd_usable` | integer | whether JD was usable for tailoring | `1` = yes, `0` = no |
| `latest_resume_jd_usable_reason` | string | reason if JD unusable | free text |

### Resume fields — selected version (C2 writes, C3/C4 consume)

These are the handoff fields. C3 and C4 read these; they should not recompute them.

| Field | Type | Purpose |
|---|---|---|
| `selected_resume_version_id` | string | which resume version is selected for apply |
| `selected_resume_pdf_path` | string | path to selected PDF |
| `selected_resume_tex_path` | string | path to selected TeX |
| `selected_resume_selected_at` | string | when this version was selected |
| `selected_resume_ready_for_c3` | boolean | C2 sign-off that C3 may use this resume |

---

## Entity: resume_attempts

One row per C2 generation attempt for a job. Written by C2.

| Field | Type | Purpose | Valid values |
|---|---|---|---|
| `id` | integer, PK | | auto |
| `job_id` | integer | FK to `jobs.id` | |
| `attempt_type` | string | what triggered this attempt | free text |
| `status` | string | outcome | `done`, `failed`, `skipped` |
| `latest_result_kind` | string | type of output produced | |
| `role_family` | string | family used for base resume | `software`, `pm`, `data`, `general` |
| `job_level` | string | seniority level used | |
| `base_resume_name` | string | which base resume was used | |
| `source_resume_type` | string | source type | |
| `source_resume_path` | string | path to source TeX | |
| `fallback_used` | boolean | heuristic fallback was used | 0 / 1 |
| `model_backend` | string | backend used | `ollama`, `heuristic` |
| `model_name` | string | model identifier | e.g. `gemma4:e4b` |
| `prompt_version` | string | prompt template version | |
| `concern_flags` | string | JSON flags from generation | JSON array |
| `jd_usable` | integer | JD quality gate | `1` / `0` |
| `jd_usable_reason` | string | reason if not usable | free text |
| `job_description_hash` | string | SHA-256 of JD for skip-regen checks | hex string |
| `job_description_path` | string | path to saved JD | |
| `keywords_path` | string | path to keywords JSON | |
| `structured_output_path` | string | path to structured LLM output | |
| `tex_path` | string | path to output TeX | |
| `pdf_path` | string | path to output PDF | |
| `compile_log_path` | string | path to LaTeX compile log | |
| `metadata_path` | string | path to attempt metadata JSON | |
| `created_at` | string | | ISO datetime UTC |

---

## Entity: resume_versions

Compiled, content-hashed resume snapshots. One attempt may produce multiple versions. Written by C2.

| Field | Type | Purpose | Valid values |
|---|---|---|---|
| `id` | integer, PK | | auto |
| `job_id` | integer | FK to `jobs.id` | |
| `resume_attempt_id` | integer | FK to `resume_attempts.id` | |
| `source_type` | string | where this version came from | |
| `label` | string | human-readable label | |
| `pdf_path` | string | path to PDF | |
| `tex_path` | string | path to TeX | |
| `content_hash` | string | SHA-256 of content for dedup | hex string |
| `is_latest_generated` | boolean | most recently generated version for this job | 0 / 1 |
| `is_latest_useful` | boolean | most recently useful (non-fallback) version | 0 / 1 |
| `is_selected_for_c3` | boolean | currently selected for downstream apply | 0 / 1 |
| `created_at` | string | | ISO datetime UTC |

---

## Entity: orchestration_runs

One row per C4 orchestration attempt for a job. Written by C4.

| Field | Type | Purpose | Valid values |
|---|---|---|---|
| `id` | string, PK | UUID | |
| `job_id` | integer | FK to `jobs.id` | |
| `status` | string | run lifecycle | `apply_prepared`, `fill_requested`, `awaiting_submit_approval`, `submit_approved`, `submitted`, `failed`, `skipped`, `manual_review` |
| `source_runtime` | string | what triggered this run | |
| `browser_lane` | string | C3 browser execution lane requested for this run | `isolated`, `attached`, or empty |
| `job_source` | string | board source of job | |
| `job_title` | string | snapshot of job title | |
| `company` | string | snapshot of company | |
| `selected_resume_version_id` | string | resume version used | |
| `selected_resume_pdf_path` | string | | |
| `selected_resume_tex_path` | string | | |
| `apply_url` | string | resolved apply URL used | |
| `ats_type` | string | ATS type at time of run | |
| `apply_context_path` | string | path to apply context JSON | |
| `c3_apply_context_path` | string | path to C3-ready context JSON | |
| `fill_result_path` | string | path to C3 fill result JSON | |
| `browser_summary_path` | string | path to browser session summary | |
| `decision_path` | string | path to submit decision artifact | |
| `final_status_path` | string | path to final status artifact | |
| `manual_review_required` | boolean | run needs human review | 0 / 1 |
| `manual_review_reason` | string | why manual review was triggered | free text |
| `manual_review_flags_json` | string | structured flags | JSON array |
| `submit_allowed` | boolean | submit approval granted | 0 / 1 |
| `submit_approval_id` | string | FK to `submit_approvals.id` | |
| `started_at` | string | | ISO datetime UTC |
| `updated_at` | string | | ISO datetime UTC |
| `completed_at` | string | | ISO datetime UTC |

---

## Entity: orchestration_events

Append-only event log for each orchestration run. Written by C4.

| Field | Type | Purpose |
|---|---|---|
| `id` | integer, PK | auto |
| `orchestration_run_id` | string | FK to `orchestration_runs.id` |
| `event_type` | string | event kind |
| `step_name` | string | pipeline step that emitted this event |
| `payload_json` | string | inline JSON payload (small events) |
| `payload_path` | string | path to external payload file (large events) |
| `created_at` | string | ISO datetime UTC |

---

## Entity: submit_approvals

Explicit submit approval decisions. Written by C4 operator or automation. One approval per orchestration run.

| Field | Type | Purpose | Valid values |
|---|---|---|---|
| `id` | string, PK | UUID | |
| `job_id` | integer | FK to `jobs.id` | |
| `orchestration_run_id` | string | FK to `orchestration_runs.id` | |
| `approval_mode` | string | how approval was granted | `manual`, `auto` |
| `approved_by` | string | who approved | user or system identifier |
| `decision` | string | the decision | `approved`, `rejected` |
| `reason` | string | optional reason | free text |
| `artifact_path` | string | path to approval artifact | |
| `created_at` | string | | ISO datetime UTC |

---

## Entity: review_sessions

Single-admin C0 control-plane web sessions. Written by C0.

| Field | Type | Purpose | Valid values |
|---|---|---|---|
| `token` | string, PK | random session token stored in `hunt_session` cookie | URL-safe token |
| `username` | string | authenticated operator username | |
| `created_at` | integer | Unix timestamp when session was created | |
| `expires_at` | integer | Unix timestamp when session expires | |

---

## Entity: runtime_state

Key-value store for singleton runtime flags. Used by C1 for auth state and audit log. Written by C1.

| Key | Purpose | Valid values |
|---|---|---|
| `linkedin_auth_state` | LinkedIn session health | `ok`, `expired`, `unknown` |
| `linkedin_auth_error` | last LinkedIn auth error message | free text |
| `review_audit_log` | JSON log of operator review actions | JSON array |

---

## Entity: component_settings

Key-value settings per component. Written and read by the C0 backend on behalf of each component. Components pull their settings at startup or on demand via the backend API. The C0 UI provides a settings panel for each component.

Unique constraint on `(component, key)`.

| Field | Type | Purpose | Valid values |
|---|---|---|---|
| `id` | integer, PK | auto | |
| `component` | string | which component owns this setting | `c0`, `c1`, `c2`, `c3`, `c4` |
| `key` | string | setting name | free text |
| `value` | string | setting value; parse according to `value_type` | free text |
| `value_type` | string | parser/validator hint | `string`, `integer`, `float`, `boolean`, `json` |
| `secret` | boolean | redact value from UI responses after save | 0 / 1 |
| `updated_at` | string | when last changed | ISO datetime UTC |
| `updated_by` | string | operator/service that changed value | username or service name |

---

## Entity: linkedin_accounts

LinkedIn credentials for C1 discovery and enrichment. Managed from the C0 UI. Multiple accounts supported to rotate sessions or recover from auth failures.

| Field | Type | Purpose | Valid values |
|---|---|---|---|
| `id` | integer, PK | auto | |
| `email` | string, unique | LinkedIn login email | email address |
| `password_encrypted` | string | encrypted credential | AES-encrypted; key from env var |
| `display_name` | string | human label for this account | free text |
| `active` | boolean | whether C1 currently uses this account | 0 / 1 |
| `auth_state` | string | current session health | `ok`, `expired`, `unknown`, `locked` |
| `storage_state_path` | string | Playwright auth/session state path outside repo checkout | filesystem path |
| `last_auth_at` | string | timestamp of last successful auth | ISO datetime UTC |
| `last_used_at` | string | timestamp of last enrichment/search use | ISO datetime UTC |
| `cooldown_until` | string | account unavailable until this time | ISO datetime UTC |
| `auth_error` | string | most recent auth error | free text |
| `created_at` | string | | ISO datetime UTC |
| `updated_at` | string | | ISO datetime UTC |

See `docs/SETTINGS_AND_SECRETS.md` for validation, redaction, encryption, and rotation rules.
