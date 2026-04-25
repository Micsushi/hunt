"""Tests for the db_compat connection factory (SQLite path only — no Postgres in CI)."""

import os
import sqlite3

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


def test_returns_sqlite_connection_when_no_db_url(tmp_db):
    assert isinstance(tmp_db, sqlite3.Connection)


def test_execute_returns_rows(tmp_db):
    tmp_db.execute("INSERT INTO test_tbl (val) VALUES (?)", ("hello",))
    tmp_db.commit()
    rows = tmp_db.execute("SELECT val FROM test_tbl").fetchall()
    assert len(rows) == 1
    assert rows[0]["val"] == "hello"


def test_row_factory_dict_access(tmp_db):
    tmp_db.execute("INSERT INTO test_tbl (val) VALUES (?)", ("world",))
    tmp_db.commit()
    row = tmp_db.execute("SELECT * FROM test_tbl WHERE val = ?", ("world",)).fetchone()
    assert row["val"] == "world"
    assert "id" in dict(row)


def test_lastrowid_after_insert(tmp_db):
    cur = tmp_db.execute("INSERT INTO test_tbl (val) VALUES (?)", ("ret_test",))
    tmp_db.commit()
    assert cur.lastrowid is not None
    assert isinstance(cur.lastrowid, int)


def test_context_manager_commits(tmp_path, monkeypatch):
    db_file = tmp_path / "ctx_test.db"
    monkeypatch.setenv("HUNT_DB_PATH", str(db_file))
    import importlib
    import hunter.db_compat as dc

    importlib.reload(dc)
    with dc.get_connection() as conn:
        conn.execute(
            "CREATE TABLE ctx_tbl (id INTEGER PRIMARY KEY AUTOINCREMENT, val TEXT)"
        )
        conn.execute("INSERT INTO ctx_tbl (val) VALUES (?)", ("auto_commit",))

    conn2 = dc.get_connection()
    rows = conn2.execute("SELECT * FROM ctx_tbl").fetchall()
    conn2.close()
    assert len(rows) == 1
    assert rows[0]["val"] == "auto_commit"


def test_pg_sql_placeholder_translation():
    from hunter.db_compat import _pg_sql

    result = _pg_sql("SELECT * FROM t WHERE id = ? AND name = ?")
    assert result == "SELECT * FROM t WHERE id = %s AND name = %s"


def test_pg_sql_pragma_becomes_noop():
    from hunter.db_compat import _pg_sql

    result = _pg_sql("PRAGMA journal_mode = WAL")
    assert result == "SELECT 1"


def test_pg_sql_begin_immediate():
    from hunter.db_compat import _pg_sql

    result = _pg_sql("BEGIN IMMEDIATE")
    assert "IMMEDIATE" not in result
    assert "BEGIN" in result


def test_pg_sql_autoincrement_primary_key_translation():
    from hunter.db_compat import _pg_sql

    result = _pg_sql("CREATE TABLE t (id INTEGER PRIMARY KEY AUTOINCREMENT, val TEXT)")
    assert "AUTOINCREMENT" not in result
    assert "id SERIAL PRIMARY KEY" in result


def test_get_connection_with_explicit_path(tmp_path, monkeypatch):
    monkeypatch.delenv("HUNT_DB_PATH", raising=False)
    db_file = tmp_path / "explicit.db"
    from hunter.db_compat import get_connection

    conn = get_connection(db_file)
    assert isinstance(conn, sqlite3.Connection)
    conn.close()
