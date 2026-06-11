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

CREATE TABLE IF NOT EXISTS review_sessions (
    token      TEXT PRIMARY KEY,
    username   TEXT    NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
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
    completed_at                TEXT,
    CONSTRAINT orchestration_runs_job_id_fkey
        FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS orchestration_events (
    id                      SERIAL PRIMARY KEY,
    orchestration_run_id    TEXT NOT NULL,
    event_type              TEXT NOT NULL,
    step_name               TEXT NOT NULL,
    payload_json            TEXT,
    payload_path            TEXT,
    created_at              TEXT NOT NULL DEFAULT to_char(CURRENT_TIMESTAMP, 'YYYY-MM-DD HH24:MI:SS'),
    CONSTRAINT orchestration_events_orchestration_run_id_fkey
        FOREIGN KEY (orchestration_run_id) REFERENCES orchestration_runs(id) ON DELETE CASCADE
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
    created_at              TEXT NOT NULL DEFAULT to_char(CURRENT_TIMESTAMP, 'YYYY-MM-DD HH24:MI:SS'),
    CONSTRAINT submit_approvals_job_id_fkey
        FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE,
    CONSTRAINT submit_approvals_orchestration_run_id_fkey
        FOREIGN KEY (orchestration_run_id) REFERENCES orchestration_runs(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS orchestration_worker_leases (
    id                          TEXT PRIMARY KEY,
    orchestration_run_id        TEXT NOT NULL,
    runtime_name                TEXT NOT NULL,
    browser_lane                TEXT,
    status                      TEXT NOT NULL,
    claimed_at                  TEXT NOT NULL DEFAULT to_char(CURRENT_TIMESTAMP, 'YYYY-MM-DD HH24:MI:SS'),
    heartbeat_at                TEXT,
    expires_at                  TEXT NOT NULL,
    completed_at                TEXT,
    worker_metadata_json        TEXT DEFAULT '{}',
    CONSTRAINT orchestration_worker_leases_orchestration_run_id_fkey
        FOREIGN KEY (orchestration_run_id) REFERENCES orchestration_runs(id) ON DELETE CASCADE
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

CREATE TABLE IF NOT EXISTS fletcher_jobs (
    queue_item_id       TEXT PRIMARY KEY,
    status              TEXT NOT NULL,
    position            INTEGER NOT NULL,
    revision            INTEGER NOT NULL DEFAULT 0,
    created_at          TEXT DEFAULT to_char(CURRENT_TIMESTAMP, 'YYYY-MM-DD HH24:MI:SS'),
    started_at          TEXT,
    finished_at         TEXT,
    input_json          TEXT NOT NULL,
    progress_json       TEXT DEFAULT '{}',
    result_json         TEXT DEFAULT '{}',
    error               TEXT,
    log_path            TEXT,
    review_id           TEXT
);

-- -----------------------------------------------------------------------
-- Agent command ledger tables
-- JSONL files remain the immutable source of truth. These tables are a
-- rebuildable Postgres search/index layer.
-- -----------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS ledger_agents (
    agent_id            TEXT PRIMARY KEY,
    component           TEXT NOT NULL DEFAULT 'c3',
    actor_json          JSONB NOT NULL DEFAULT '{}'::jsonb,
    status              TEXT NOT NULL DEFAULT 'active',
    metadata_json       JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at          TEXT NOT NULL DEFAULT to_char(CURRENT_TIMESTAMP, 'YYYY-MM-DD HH24:MI:SS'),
    updated_at          TEXT NOT NULL DEFAULT to_char(CURRENT_TIMESTAMP, 'YYYY-MM-DD HH24:MI:SS')
);

CREATE TABLE IF NOT EXISTS ledger_lanes (
    lane_id             TEXT PRIMARY KEY,
    component           TEXT NOT NULL DEFAULT 'c3',
    agent_id            TEXT,
    status              TEXT NOT NULL DEFAULT 'active',
    metadata_json       JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at          TEXT NOT NULL DEFAULT to_char(CURRENT_TIMESTAMP, 'YYYY-MM-DD HH24:MI:SS'),
    updated_at          TEXT NOT NULL DEFAULT to_char(CURRENT_TIMESTAMP, 'YYYY-MM-DD HH24:MI:SS'),
    CONSTRAINT ledger_lanes_agent_id_fkey
        FOREIGN KEY (agent_id) REFERENCES ledger_agents(agent_id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS ledger_sessions (
    session_id          TEXT PRIMARY KEY,
    component           TEXT NOT NULL DEFAULT 'c3',
    agent_id            TEXT,
    lane_id             TEXT,
    parent_session_id   TEXT,
    status              TEXT NOT NULL DEFAULT 'active',
    manifest_path       TEXT,
    metadata_json       JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at          TEXT NOT NULL DEFAULT to_char(CURRENT_TIMESTAMP, 'YYYY-MM-DD HH24:MI:SS'),
    updated_at          TEXT NOT NULL DEFAULT to_char(CURRENT_TIMESTAMP, 'YYYY-MM-DD HH24:MI:SS'),
    ended_at            TEXT,
    CONSTRAINT ledger_sessions_agent_id_fkey
        FOREIGN KEY (agent_id) REFERENCES ledger_agents(agent_id) ON DELETE SET NULL,
    CONSTRAINT ledger_sessions_lane_id_fkey
        FOREIGN KEY (lane_id) REFERENCES ledger_lanes(lane_id) ON DELETE SET NULL,
    CONSTRAINT ledger_sessions_parent_session_id_fkey
        FOREIGN KEY (parent_session_id) REFERENCES ledger_sessions(session_id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS ledger_leases (
    lease_id            TEXT PRIMARY KEY,
    component           TEXT NOT NULL DEFAULT 'c3',
    lease_type          TEXT NOT NULL,
    status              TEXT NOT NULL,
    agent_id            TEXT,
    lane_id             TEXT,
    session_id          TEXT,
    command_id          TEXT,
    claimed_at          TEXT NOT NULL DEFAULT to_char(CURRENT_TIMESTAMP, 'YYYY-MM-DD HH24:MI:SS'),
    heartbeat_at        TEXT,
    expires_at          TEXT NOT NULL,
    released_at         TEXT,
    metadata_json       JSONB NOT NULL DEFAULT '{}'::jsonb,
    CONSTRAINT ledger_leases_agent_id_fkey
        FOREIGN KEY (agent_id) REFERENCES ledger_agents(agent_id) ON DELETE SET NULL,
    CONSTRAINT ledger_leases_lane_id_fkey
        FOREIGN KEY (lane_id) REFERENCES ledger_lanes(lane_id) ON DELETE SET NULL,
    CONSTRAINT ledger_leases_session_id_fkey
        FOREIGN KEY (session_id) REFERENCES ledger_sessions(session_id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS ledger_events (
    event_id            TEXT PRIMARY KEY,
    seq                 INTEGER,
    ts                  TEXT NOT NULL,
    component           TEXT NOT NULL,
    event_type          TEXT NOT NULL,
    actor_json          JSONB NOT NULL DEFAULT '{}'::jsonb,
    agent_id            TEXT,
    lane_id             TEXT,
    session_id          TEXT,
    lease_id            TEXT,
    command_id          TEXT,
    trace_id            TEXT,
    payload_json        JSONB NOT NULL DEFAULT '{}'::jsonb,
    redaction_json      JSONB NOT NULL DEFAULT '{}'::jsonb,
    prev_hash           TEXT,
    hash                TEXT,
    jsonl_path          TEXT,
    jsonl_line_number   INTEGER,
    jsonl_byte_offset   BIGINT,
    created_at          TEXT NOT NULL DEFAULT to_char(CURRENT_TIMESTAMP, 'YYYY-MM-DD HH24:MI:SS'),
    CONSTRAINT ledger_events_agent_id_fkey
        FOREIGN KEY (agent_id) REFERENCES ledger_agents(agent_id) ON DELETE SET NULL,
    CONSTRAINT ledger_events_lane_id_fkey
        FOREIGN KEY (lane_id) REFERENCES ledger_lanes(lane_id) ON DELETE SET NULL,
    CONSTRAINT ledger_events_session_id_fkey
        FOREIGN KEY (session_id) REFERENCES ledger_sessions(session_id) ON DELETE SET NULL,
    CONSTRAINT ledger_events_lease_id_fkey
        FOREIGN KEY (lease_id) REFERENCES ledger_leases(lease_id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS ledger_probe_files (
    probe_id            TEXT PRIMARY KEY,
    component           TEXT NOT NULL DEFAULT 'c3',
    agent_id            TEXT,
    lane_id             TEXT,
    session_id          TEXT,
    command_id          TEXT,
    path                TEXT NOT NULL,
    sha256              TEXT,
    trusted             BOOLEAN NOT NULL DEFAULT FALSE,
    reviewed            BOOLEAN NOT NULL DEFAULT FALSE,
    status              TEXT NOT NULL DEFAULT 'unreviewed',
    metadata_json       JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at          TEXT NOT NULL DEFAULT to_char(CURRENT_TIMESTAMP, 'YYYY-MM-DD HH24:MI:SS'),
    updated_at          TEXT NOT NULL DEFAULT to_char(CURRENT_TIMESTAMP, 'YYYY-MM-DD HH24:MI:SS'),
    CONSTRAINT ledger_probe_files_agent_id_fkey
        FOREIGN KEY (agent_id) REFERENCES ledger_agents(agent_id) ON DELETE SET NULL,
    CONSTRAINT ledger_probe_files_lane_id_fkey
        FOREIGN KEY (lane_id) REFERENCES ledger_lanes(lane_id) ON DELETE SET NULL,
    CONSTRAINT ledger_probe_files_session_id_fkey
        FOREIGN KEY (session_id) REFERENCES ledger_sessions(session_id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS ledger_artifacts (
    artifact_id         TEXT PRIMARY KEY,
    component           TEXT NOT NULL DEFAULT 'c3',
    artifact_type       TEXT NOT NULL,
    agent_id            TEXT,
    lane_id             TEXT,
    session_id          TEXT,
    command_id          TEXT,
    event_id            TEXT,
    path                TEXT NOT NULL,
    sha256              TEXT,
    metadata_json       JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at          TEXT NOT NULL DEFAULT to_char(CURRENT_TIMESTAMP, 'YYYY-MM-DD HH24:MI:SS'),
    CONSTRAINT ledger_artifacts_agent_id_fkey
        FOREIGN KEY (agent_id) REFERENCES ledger_agents(agent_id) ON DELETE SET NULL,
    CONSTRAINT ledger_artifacts_lane_id_fkey
        FOREIGN KEY (lane_id) REFERENCES ledger_lanes(lane_id) ON DELETE SET NULL,
    CONSTRAINT ledger_artifacts_session_id_fkey
        FOREIGN KEY (session_id) REFERENCES ledger_sessions(session_id) ON DELETE SET NULL,
    CONSTRAINT ledger_artifacts_event_id_fkey
        FOREIGN KEY (event_id) REFERENCES ledger_events(event_id) ON DELETE SET NULL
);

-- -----------------------------------------------------------------------
-- Indexes
-- -----------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS idx_jobs_status     ON jobs(status);
CREATE INDEX IF NOT EXISTS idx_jobs_source     ON jobs(source);
CREATE INDEX IF NOT EXISTS idx_jobs_enrichment ON jobs(enrichment_status);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON review_sessions(expires_at);
CREATE INDEX IF NOT EXISTS idx_fletcher_jobs_status_position
    ON fletcher_jobs(status, position);

CREATE INDEX IF NOT EXISTS idx_orchestration_runs_job_status
    ON orchestration_runs(job_id, status, started_at DESC);

CREATE INDEX IF NOT EXISTS idx_orchestration_runs_status_started
    ON orchestration_runs(status, started_at DESC);

CREATE INDEX IF NOT EXISTS idx_orchestration_events_run_created
    ON orchestration_events(orchestration_run_id, created_at ASC, id ASC);

CREATE INDEX IF NOT EXISTS idx_submit_approvals_run_created
    ON submit_approvals(orchestration_run_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_worker_leases_run_status
    ON orchestration_worker_leases(orchestration_run_id, status, claimed_at DESC);

CREATE INDEX IF NOT EXISTS idx_worker_leases_status_expires
    ON orchestration_worker_leases(status, expires_at);

CREATE INDEX IF NOT EXISTS idx_ledger_events_component_created
    ON ledger_events(component, created_at);

CREATE INDEX IF NOT EXISTS idx_ledger_events_agent_id
    ON ledger_events(agent_id);

CREATE INDEX IF NOT EXISTS idx_ledger_events_lane_id
    ON ledger_events(lane_id);

CREATE INDEX IF NOT EXISTS idx_ledger_events_session_id
    ON ledger_events(session_id);

CREATE INDEX IF NOT EXISTS idx_ledger_events_command_id
    ON ledger_events(command_id);

CREATE INDEX IF NOT EXISTS idx_ledger_events_event_type
    ON ledger_events(event_type);

CREATE INDEX IF NOT EXISTS idx_ledger_leases_status_expires
    ON ledger_leases(status, expires_at);

CREATE UNIQUE INDEX IF NOT EXISTS idx_ledger_leases_one_active_lane
    ON ledger_leases(lease_type, lane_id)
    WHERE status = 'active' AND lease_type = 'lane';

CREATE UNIQUE INDEX IF NOT EXISTS idx_ledger_leases_one_active_session_mutation
    ON ledger_leases(lease_type, lane_id, session_id)
    WHERE status = 'active' AND lease_type = 'session_mutation';

CREATE INDEX IF NOT EXISTS idx_ledger_probe_files_session_trusted
    ON ledger_probe_files(session_id, trusted);

CREATE INDEX IF NOT EXISTS idx_ledger_sessions_agent_id
    ON ledger_sessions(agent_id);

CREATE INDEX IF NOT EXISTS idx_ledger_sessions_lane_id
    ON ledger_sessions(lane_id);

CREATE INDEX IF NOT EXISTS idx_ledger_lanes_agent_id
    ON ledger_lanes(agent_id);
