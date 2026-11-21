from __future__ import annotations

import os

import pytest

from fletcher.db import list_jobs_ready_for_resume


@pytest.mark.skipif(
    not os.getenv("HUNT_TEST_POSTGRES_URL"),
    reason="set HUNT_TEST_POSTGRES_URL to run the real PostgreSQL regression",
)
def test_ready_resume_query_executes_against_real_postgres(monkeypatch):
    monkeypatch.setenv("HUNT_DB_URL", os.environ["HUNT_TEST_POSTGRES_URL"])

    rows = list_jobs_ready_for_resume(limit=1, only_missing=True)

    assert isinstance(rows, list)
    assert len(rows) <= 1
