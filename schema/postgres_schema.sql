-- Hunt full PostgreSQL schema
-- Applied during container smoke tests and first-run server setup.
-- Idempotent: uses IF NOT EXISTS.

CREATE TABLE IF NOT EXISTS jobs (
    id                              SERIAL PRIMARY KEY,
    title                           TEXT NOT NULL,
    company                         TEXT,
    location                        TEXT,
    job_url                         TEXT UNIQUE NOT NULL,
    apply_url                       TEXT,
    description                     TEXT,
    source                          TEXT,
    date_posted                     TEXT,
    is_remote                       BOOLEAN,
    status                          TEXT DEFAULT 'new',
    date_scraped                    TEXT DEFAULT to_char(CURRENT_TIMESTAMP, 'YYYY-MM-DD HH24:MI:SS'),
    level                           TEXT,
    priority                        BOOLEAN DEFAULT FALSE,
    category                        TEXT,
    apply_type                      TEXT,
    auto_apply_eligible             BOOLEAN,
    enrichment_status               TEXT,
    enrichment_attempts             INTEGER DEFAULT 0,
    enriched_at                     TEXT,
    last_enrichment_error           TEXT,
    apply_host                      TEXT,
    ats_type                        TEXT,
    last_enrichment_started_at      TEXT,
    next_enrichment_retry_at        TEXT,
    last_artifact_dir               TEXT,
    last_artifact_screenshot_path   TEXT,
    last_artifact_html_path         TEXT,
    last_artifact_text_path         TEXT,
    latest_resume_job_description_path TEXT,
    latest_resume_flags             TEXT,
    latest_resume_jd_usable         INTEGER,
    latest_resume_jd_usable_reason  TEXT,
    selected_resume_version_id      TEXT,
    selected_resume_pdf_path        TEXT,
    selected_resume_tex_path        TEXT,
    selected_resume_selected_at     TEXT,
    selected_resume_ready_for_c3    BOOLEAN,
    operator_notes                  TEXT,
    operator_tag                    TEXT
);

CREATE TABLE IF NOT EXISTS runtime_state (
    key         TEXT PRIMARY KEY,
    value       TEXT,
    updated_at  TEXT DEFAULT to_char(CURRENT_TIMESTAMP, 'YYYY-MM-DD HH24:MI:SS')
);

CREATE TABLE IF NOT EXISTS component_settings (
    component   TEXT NOT NULL,
    key         TEXT NOT NULL,
    value       TEXT,
    value_type  TEXT NOT NULL DEFAULT 'string',
    secret      BOOLEAN NOT NULL DEFAULT FALSE,
    updated_at  TEXT NOT NULL DEFAULT to_char(CURRENT_TIMESTAMP, 'YYYY-MM-DD HH24:MI:SS'),
    updated_by  TEXT,
    PRIMARY KEY (component, key)
);

CREATE TABLE IF NOT EXISTS linkedin_accounts (
    id                  SERIAL PRIMARY KEY,
    username            TEXT NOT NULL UNIQUE,
    password_encrypted  TEXT,
    display_name        TEXT,
    active              BOOLEAN NOT NULL DEFAULT TRUE,
    auth_state          TEXT NOT NULL DEFAULT 'unknown',
    last_auth_check     TEXT,
    last_auth_error     TEXT,
    created_at          TEXT NOT NULL DEFAULT to_char(CURRENT_TIMESTAMP, 'YYYY-MM-DD HH24:MI:SS'),
    updated_at          TEXT NOT NULL DEFAULT to_char(CURRENT_TIMESTAMP, 'YYYY-MM-DD HH24:MI:SS')
);

CREATE TABLE IF NOT EXISTS orchestration_runs (
    id                          TEXT PRIMARY KEY,
    job_id                      INTEGER NOT NULL,
    status                      TEXT NOT NULL,
    source_runtime              TEXT NOT NULL,
    browser_lane                TEXT,
    job_source                  TEXT,
    job_title                   TEXT,
    company                     TEXT,
    selected_resume_version_id  TEXT,
    selected_resume_pdf_path    TEXT,
    selected_resume_tex_path    TEXT,
    apply_url                   TEXT,
    ats_type                    TEXT,
    apply_context_path          TEXT,
    c3_apply_context_path       TEXT,
    fill_result_path            TEXT,
    browser_summary_path        TEXT,
    decision_path               TEXT,
    final_status_path           TEXT,
    manual_review_required      BOOLEAN NOT NULL DEFAULT FALSE,
    manual_review_reason        TEXT,
    manual_review_flags_json    TEXT DEFAULT '[]',
    submit_allowed              BOOLEAN NOT NULL DEFAULT FALSE,
    submit_approval_id          TEXT,
    started_at                  TEXT NOT NULL DEFAULT to_char(CURRENT_TIMESTAMP, 'YYYY-MM-DD HH24:MI:SS'),
    updated_at                  TEXT NOT NULL DEFAULT to_char(CURRENT_TIMESTAMP, 'YYYY-MM-DD HH24:MI:SS'),
    completed_at                TEXT
);

CREATE TABLE IF NOT EXISTS orchestration_events (
    id                      SERIAL PRIMARY KEY,
    orchestration_run_id    TEXT NOT NULL,
    event_type              TEXT NOT NULL,
    step_name               TEXT NOT NULL,
    payload_json            TEXT,
    payload_path            TEXT,
    created_at              TEXT NOT NULL DEFAULT to_char(CURRENT_TIMESTAMP, 'YYYY-MM-DD HH24:MI:SS')
);

CREATE TABLE IF NOT EXISTS submit_approvals (
    id                      TEXT PRIMARY KEY,
    job_id                  INTEGER NOT NULL,
    orchestration_run_id    TEXT NOT NULL,
    approval_mode           TEXT NOT NULL,
    approved_by             TEXT NOT NULL,
    decision                TEXT NOT NULL,
    reason                  TEXT,
    artifact_path           TEXT,
    created_at              TEXT NOT NULL DEFAULT to_char(CURRENT_TIMESTAMP, 'YYYY-MM-DD HH24:MI:SS')
);

-- -----------------------------------------------------------------------
-- C2 Fletcher tables
-- -----------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS resume_attempts (
    id                      SERIAL PRIMARY KEY,
    job_id                  INTEGER,
    attempt_type            TEXT,
    status                  TEXT,
    latest_result_kind      TEXT,
    role_family             TEXT,
    job_level               TEXT,
    base_resume_name        TEXT,
    source_resume_type      TEXT,
    source_resume_path      TEXT,
    fallback_used           BOOLEAN,
    model_backend           TEXT,
    model_name              TEXT,
    prompt_version          TEXT,
    concern_flags           TEXT,
    job_description_path    TEXT,
    keywords_path           TEXT,
    structured_output_path  TEXT,
    tex_path                TEXT,
    pdf_path                TEXT,
    compile_log_path        TEXT,
    metadata_path           TEXT,
    jd_usable               INTEGER,
    jd_usable_reason        TEXT,
    job_description_hash    TEXT,
    created_at              TEXT DEFAULT to_char(CURRENT_TIMESTAMP, 'YYYY-MM-DD HH24:MI:SS')
);

CREATE TABLE IF NOT EXISTS resume_versions (
    id                      SERIAL PRIMARY KEY,
    job_id                  INTEGER,
    resume_attempt_id       INTEGER NOT NULL,
    source_type             TEXT,
    label                   TEXT,
    pdf_path                TEXT,
    tex_path                TEXT NOT NULL,
    content_hash            TEXT NOT NULL,
    created_at              TEXT DEFAULT to_char(CURRENT_TIMESTAMP, 'YYYY-MM-DD HH24:MI:SS'),
    is_latest_generated     BOOLEAN DEFAULT FALSE,
    is_latest_useful        BOOLEAN DEFAULT FALSE,
    is_selected_for_c3      BOOLEAN DEFAULT FALSE
);

-- -----------------------------------------------------------------------
-- Indexes
-- -----------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS idx_jobs_status     ON jobs(status);
CREATE INDEX IF NOT EXISTS idx_jobs_source     ON jobs(source);
CREATE INDEX IF NOT EXISTS idx_jobs_enrichment ON jobs(enrichment_status);

CREATE INDEX IF NOT EXISTS idx_orchestration_runs_job_status
    ON orchestration_runs(job_id, status, started_at DESC);

CREATE INDEX IF NOT EXISTS idx_orchestration_runs_status_started
    ON orchestration_runs(status, started_at DESC);

CREATE INDEX IF NOT EXISTS idx_orchestration_events_run_created
    ON orchestration_events(orchestration_run_id, created_at ASC, id ASC);

CREATE INDEX IF NOT EXISTS idx_submit_approvals_run_created
    ON submit_approvals(orchestration_run_id, created_at DESC);
