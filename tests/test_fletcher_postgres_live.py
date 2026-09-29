from __future__ import annotations

import os

import pytest

from fletcher.db import list_jobs_ready_for_resume


@pytest.mark.skipif(
    not os.getenv("HUNT_TEST_POSTGRES_URL"),
    reason="set HUNT_TEST_POSTGRES_URL to run the real PostgreSQL regression",
)
def test_fresh_boolean_defaults_execute_against_real_postgres(monkeypatch):
    from fletcher.db import RESUME_VERSIONS_TABLE_SQL
    from hunter.db import (
        COMPONENT_SETTINGS_TABLE_SQL,
        JOBS_TABLE_SQL,
        LINKEDIN_ACCOUNTS_TABLE_SQL,
    )
    from hunter.db_compat import get_connection

    monkeypatch.setenv("HUNT_DB_URL", os.environ["HUNT_TEST_POSTGRES_URL"])
    conn = get_connection()
    try:
        # Temporary tables exercise fresh DDL without touching existing data.
        for ddl in (
            JOBS_TABLE_SQL,
            COMPONENT_SETTINGS_TABLE_SQL,
            LINKEDIN_ACCOUNTS_TABLE_SQL,
            RESUME_VERSIONS_TABLE_SQL,
        ):
            conn.execute(ddl.replace("CREATE TABLE IF NOT EXISTS", "CREATE TEMP TABLE"))
        conn.execute("INSERT INTO jobs (title, job_url) VALUES ('test', 'test')")
        conn.execute("INSERT INTO component_settings (component, key) VALUES ('test', 'test')")
        conn.execute("INSERT INTO linkedin_accounts (username) VALUES ('test')")
        conn.execute(
            "INSERT INTO resume_versions (resume_attempt_id, tex_path, content_hash) "
            "VALUES (1, 'test', 'test')"
        )
        for table, column, expected in (
            ("jobs", "priority", False),
            ("component_settings", "secret", False),
            ("linkedin_accounts", "active", True),
            ("resume_versions", "is_latest_generated", False),
            ("resume_versions", "is_latest_useful", False),
            ("resume_versions", "is_selected_for_c3", False),
        ):
            assert conn.execute(f"SELECT {column} FROM {table}").fetchone()[column] is expected
    finally:
        conn.rollback()
        conn.close()


@pytest.mark.skipif(
    not os.getenv("HUNT_TEST_POSTGRES_URL"),
    reason="set HUNT_TEST_POSTGRES_URL to run the real PostgreSQL regression",
)
def test_ready_resume_query_executes_against_real_postgres(monkeypatch):
    monkeypatch.setenv("HUNT_DB_URL", os.environ["HUNT_TEST_POSTGRES_URL"])

    rows = list_jobs_ready_for_resume(limit=1, only_missing=True)

    assert isinstance(rows, list)
    assert len(rows) <= 1
