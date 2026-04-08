from __future__ import annotations

import sqlite3
from pathlib import Path

TERMINAL_RUN_STATUSES = frozenset({"failed", "submit_denied", "submitted"})
ACTIVE_RUN_STATUSES = frozenset(
    {
        "apply_prepared",
        "fill_requested",
        "awaiting_submit_approval",
        "submit_approved",
        "manual_review",
    }
)
EXECUTING_RUN_STATUSES = frozenset(
    {
        "apply_prepared",
        "fill_requested",
        "awaiting_submit_approval",
        "submit_approved",
    }
)
GLOBAL_HOLD_REASONS = frozenset(
    {
        "auth_required",
        "login_required",
        "captcha_challenge",
        "otp_required",
        "verification_required",
        "security_challenge",
    }
)

ORCHESTRATION_RUNS_TABLE_SQL = """
CREATE TABLE IF NOT EXISTS orchestration_runs (
    id TEXT PRIMARY KEY,
    job_id INTEGER NOT NULL,
    status TEXT NOT NULL,
    source_runtime TEXT NOT NULL,
    job_source TEXT,
    job_title TEXT,
    company TEXT,
    selected_resume_version_id TEXT,
    selected_resume_pdf_path TEXT,
    selected_resume_tex_path TEXT,
    apply_url TEXT,
    ats_type TEXT,
    apply_context_path TEXT,
    c3_apply_context_path TEXT,
    fill_result_path TEXT,
    browser_summary_path TEXT,
    decision_path TEXT,
    final_status_path TEXT,
    manual_review_required BOOLEAN NOT NULL DEFAULT 0,
    manual_review_reason TEXT,
    manual_review_flags_json TEXT DEFAULT '[]',
    submit_allowed BOOLEAN NOT NULL DEFAULT 0,
    submit_approval_id TEXT,
    started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    completed_at TEXT
)
"""

ORCHESTRATION_RUNS_MIGRATION_COLUMNS = {
    "job_source": "TEXT",
    "job_title": "TEXT",
    "company": "TEXT",
    "selected_resume_pdf_path": "TEXT",
    "selected_resume_tex_path": "TEXT",
    "c3_apply_context_path": "TEXT",
    "fill_result_path": "TEXT",
    "browser_summary_path": "TEXT",
    "decision_path": "TEXT",
    "final_status_path": "TEXT",
    "manual_review_flags_json": "TEXT DEFAULT '[]'",
    "submit_allowed": "BOOLEAN NOT NULL DEFAULT 0",
    "submit_approval_id": "TEXT",
    "updated_at": "TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP",
}

ORCHESTRATION_EVENTS_TABLE_SQL = """
CREATE TABLE IF NOT EXISTS orchestration_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    orchestration_run_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    step_name TEXT NOT NULL,
    payload_json TEXT,
    payload_path TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
)
"""

SUBMIT_APPROVALS_TABLE_SQL = """
CREATE TABLE IF NOT EXISTS submit_approvals (
    id TEXT PRIMARY KEY,
    job_id INTEGER NOT NULL,
    orchestration_run_id TEXT NOT NULL,
    approval_mode TEXT NOT NULL,
    approved_by TEXT NOT NULL,
    decision TEXT NOT NULL,
    reason TEXT,
    artifact_path TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
)
"""

SUBMIT_APPROVALS_MIGRATION_COLUMNS = {
    "artifact_path": "TEXT",
}

INDEX_STATEMENTS = (
    """
    CREATE INDEX IF NOT EXISTS idx_orchestration_runs_job_status
    ON orchestration_runs(job_id, status, started_at DESC)
    """,
    """
    CREATE INDEX IF NOT EXISTS idx_orchestration_runs_status_started
    ON orchestration_runs(status, started_at DESC)
    """,
    """
    CREATE INDEX IF NOT EXISTS idx_orchestration_events_run_created
    ON orchestration_events(orchestration_run_id, created_at ASC, id ASC)
    """,
    """
    CREATE INDEX IF NOT EXISTS idx_submit_approvals_run_created
    ON submit_approvals(orchestration_run_id, created_at DESC)
    """,
)


def get_connection(db_path: str | Path) -> sqlite3.Connection:
    path = Path(db_path).expanduser().resolve()
    if path.parent:
        path.parent.mkdir(parents=True, exist_ok=True)

    conn = sqlite3.connect(path, timeout=30.0)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA busy_timeout = 30000")
    try:
        conn.execute("PRAGMA journal_mode = WAL")
    except sqlite3.OperationalError:
        pass
    return conn


def _existing_columns(cursor: sqlite3.Cursor, table_name: str) -> set[str]:
    return {row[1] for row in cursor.execute(f"PRAGMA table_info({table_name})").fetchall()}


def _ensure_columns(cursor: sqlite3.Cursor, table_name: str, columns: dict[str, str]) -> None:
    existing = _existing_columns(cursor, table_name)
    for column_name, column_def in columns.items():
        if column_name not in existing:
            cursor.execute(f"ALTER TABLE {table_name} ADD COLUMN {column_name} {column_def}")


def init_orchestration_db(db_path: str | Path) -> None:
    conn = get_connection(db_path)
    try:
        cursor = conn.cursor()
        cursor.execute(ORCHESTRATION_RUNS_TABLE_SQL)
        cursor.execute(ORCHESTRATION_EVENTS_TABLE_SQL)
        cursor.execute(SUBMIT_APPROVALS_TABLE_SQL)
        _ensure_columns(cursor, "orchestration_runs", ORCHESTRATION_RUNS_MIGRATION_COLUMNS)
        _ensure_columns(cursor, "submit_approvals", SUBMIT_APPROVALS_MIGRATION_COLUMNS)
        for statement in INDEX_STATEMENTS:
            cursor.execute(statement)
        conn.commit()
    finally:
        conn.close()
