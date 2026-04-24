-- Hunt Postgres Schema
-- Apply with: psql $HUNT_DB_URL -f schema/postgres_schema.sql
--
-- All SERIAL columns correspond to INTEGER PRIMARY KEY AUTOINCREMENT in SQLite.
-- All TEXT timestamp columns store ISO-8601 strings (consistent with SQLite path).

-- ------------------------------------------------------------------ jobs ---
CREATE TABLE IF NOT EXISTS jobs (
    id                                      SERIAL PRIMARY KEY,
    title                                   TEXT NOT NULL,
    company                                 TEXT,
    location                                TEXT,
    job_url                                 TEXT UNIQUE NOT NULL,
    apply_url                               TEXT,
    description                             TEXT,
    source                                  TEXT,
    date_posted                             TEXT,
    is_remote                               BOOLEAN,
    status                                  TEXT DEFAULT 'new',
    date_scraped                            TEXT DEFAULT CURRENT_TIMESTAMP,
    level                                   TEXT,
    priority                                BOOLEAN DEFAULT FALSE,
    category                                TEXT,
    apply_type                              TEXT,
    auto_apply_eligible                     BOOLEAN,
    enrichment_status                       TEXT,
    enrichment_attempts                     INTEGER DEFAULT 0,
    enriched_at                             TEXT,
    last_enrichment_error                   TEXT,
    apply_host                              TEXT,
    ats_type                                TEXT,
    last_enrichment_started_at              TEXT,
    next_enrichment_retry_at                TEXT,
    last_artifact_dir                       TEXT,
    last_artifact_screenshot_path           TEXT,
    last_artifact_html_path                 TEXT,
    last_artifact_text_path                 TEXT,
    latest_resume_job_description_path      TEXT,
    latest_resume_flags                     TEXT,
    selected_resume_version_id              TEXT,
    selected_resume_pdf_path                TEXT,
    selected_resume_tex_path                TEXT,
    selected_resume_selected_at             TEXT,
    selected_resume_ready_for_c3            BOOLEAN,
    resume_status                           TEXT,
    latest_resume_attempt_id                INTEGER,
    latest_resume_version_id                TEXT,
    latest_resume_pdf_path                  TEXT,
    latest_resume_tex_path                  TEXT,
    latest_resume_keywords_path             TEXT,
    latest_resume_job_description_path2     TEXT,
    latest_resume_family                    TEXT,
    latest_resume_job_level                 TEXT,
    latest_resume_model                     TEXT,
    latest_resume_generated_at              TEXT,
    latest_resume_fallback_used             BOOLEAN,
    latest_resume_jd_usable                 INTEGER,
    latest_resume_jd_usable_reason          TEXT,
    latest_resume_structured_output_path    TEXT,
    operator_notes                          TEXT,
    operator_tag                            TEXT
);

CREATE INDEX IF NOT EXISTS idx_jobs_enrichment_status ON jobs(enrichment_status);
CREATE INDEX IF NOT EXISTS idx_jobs_source_status ON jobs(source, enrichment_status);
CREATE INDEX IF NOT EXISTS idx_jobs_job_url ON jobs(job_url);
CREATE INDEX IF NOT EXISTS idx_jobs_next_retry ON jobs(next_enrichment_retry_at)
    WHERE enrichment_status = 'failed';

-- --------------------------------------------------------- runtime_state ---
CREATE TABLE IF NOT EXISTS runtime_state (
    key         TEXT PRIMARY KEY,
    value       TEXT,
    updated_at  TEXT DEFAULT CURRENT_TIMESTAMP
);

-- ----------------------------------------------------- component_settings ---
CREATE TABLE IF NOT EXISTS component_settings (
    component   TEXT NOT NULL,
    key         TEXT NOT NULL,
    value       TEXT,
    value_type  TEXT NOT NULL DEFAULT 'string',
    secret      BOOLEAN NOT NULL DEFAULT FALSE,
    updated_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_by  TEXT,
    PRIMARY KEY (component, key)
);

-- ---------------------------------------------------- linkedin_accounts ---
CREATE TABLE IF NOT EXISTS linkedin_accounts (
    id                  SERIAL PRIMARY KEY,
    username            TEXT NOT NULL UNIQUE,
    password_encrypted  TEXT,
    display_name        TEXT,
    active              BOOLEAN NOT NULL DEFAULT TRUE,
    auth_state          TEXT NOT NULL DEFAULT 'unknown',
    last_auth_check     TEXT,
    last_auth_error     TEXT,
    created_at          TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at          TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- ---------------------------------------------------- resume_attempts (C2) ---
CREATE TABLE IF NOT EXISTS resume_attempts (
    id                      SERIAL PRIMARY KEY,
    job_id                  INTEGER REFERENCES jobs(id),
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
    created_at              TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_resume_attempts_job_id ON resume_attempts(job_id);
CREATE INDEX IF NOT EXISTS idx_resume_attempts_status ON resume_attempts(status);

-- ---------------------------------------------------- resume_versions (C2) ---
CREATE TABLE IF NOT EXISTS resume_versions (
    id                      SERIAL PRIMARY KEY,
    job_id                  INTEGER REFERENCES jobs(id),
    resume_attempt_id       INTEGER NOT NULL REFERENCES resume_attempts(id),
    source_type             TEXT,
    label                   TEXT,
    pdf_path                TEXT,
    tex_path                TEXT NOT NULL,
    content_hash            TEXT NOT NULL,
    is_latest_generated     BOOLEAN DEFAULT FALSE,
    is_latest_useful        BOOLEAN DEFAULT FALSE,
    is_selected_for_c3      BOOLEAN DEFAULT FALSE,
    created_at              TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_resume_versions_job_id ON resume_versions(job_id);
CREATE INDEX IF NOT EXISTS idx_resume_versions_latest ON resume_versions(job_id, is_latest_useful, is_selected_for_c3);

-- ----------------------------------------------- orchestration_runs (C4) ---
CREATE TABLE IF NOT EXISTS orchestration_runs (
    id                          TEXT PRIMARY KEY,
    job_id                      INTEGER NOT NULL REFERENCES jobs(id),
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
    started_at                  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at                  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    completed_at                TEXT
);

CREATE INDEX IF NOT EXISTS idx_orchestration_runs_job_status
    ON orchestration_runs(job_id, status, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_orchestration_runs_status_started
    ON orchestration_runs(status, started_at DESC);

-- -------------------------------------------- orchestration_events (C4) ---
CREATE TABLE IF NOT EXISTS orchestration_events (
    id                      SERIAL PRIMARY KEY,
    orchestration_run_id    TEXT NOT NULL REFERENCES orchestration_runs(id),
    event_type              TEXT NOT NULL,
    step_name               TEXT NOT NULL,
    payload_json            TEXT,
    payload_path            TEXT,
    created_at              TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_orchestration_events_run_created
    ON orchestration_events(orchestration_run_id, created_at ASC, id ASC);

-- ---------------------------------------------- submit_approvals (C4) ---
CREATE TABLE IF NOT EXISTS submit_approvals (
    id                      TEXT PRIMARY KEY,
    job_id                  INTEGER NOT NULL REFERENCES jobs(id),
    orchestration_run_id    TEXT NOT NULL REFERENCES orchestration_runs(id),
    approval_mode           TEXT NOT NULL,
    approved_by             TEXT NOT NULL,
    decision                TEXT NOT NULL,
    reason                  TEXT,
    artifact_path           TEXT,
    created_at              TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_submit_approvals_run_created
    ON submit_approvals(orchestration_run_id, created_at DESC);
