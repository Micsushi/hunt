"""Tests for the db_compat connection factory (SQLite path only - no Postgres in CI)."""

import pytest


@pytest.fixture(autouse=True)
def clear_pg_url(monkeypatch):
    """Ensure HUNT_DB_URL is absent so all tests use the SQLite path."""
    monkeypatch.delenv("HUNT_DB_URL", raising=False)


@pytest.fixture
def tmp_db(tmp_path, monkeypatch):
    db_file = tmp_path / "compat_test.db"
    monkeypatch.setenv("HUNT_DB_PATH", str(db_file))
    # Reload module so new env var is picked up
    import importlib

    import hunter.db_compat as dc

    importlib.reload(dc)
    conn = dc.get_connection()
    conn.execute("CREATE TABLE test_tbl (id INTEGER PRIMARY KEY AUTOINCREMENT, val TEXT)")
    conn.commit()
    yield conn
    conn.close()


def test_context_manager_commits(tmp_path, monkeypatch):
    db_file = tmp_path / "ctx_test.db"
    monkeypatch.setenv("HUNT_DB_PATH", str(db_file))
    import importlib

    import hunter.db_compat as dc

    importlib.reload(dc)
    with dc.get_connection() as conn:
        conn.execute("CREATE TABLE ctx_tbl (id INTEGER PRIMARY KEY AUTOINCREMENT, val TEXT)")
        conn.execute("INSERT INTO ctx_tbl (val) VALUES (?)", ("auto_commit",))

    conn2 = dc.get_connection()
    rows = conn2.execute("SELECT * FROM ctx_tbl").fetchall()
    conn2.close()
    assert len(rows) == 1
    assert rows[0]["val"] == "auto_commit"
