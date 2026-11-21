"""Tests for component_settings and linkedin_accounts tables."""

import os
import sqlite3

import pytest


@pytest.fixture
def db(tmp_path):
    db_file = tmp_path / "test.db"
    os.environ["HUNT_DB_PATH"] = str(db_file)
    os.environ.pop("HUNT_DB_URL", None)
    import hunter.db as _db

    _db.DB_PATH = str(db_file)
    from hunter.db import get_connection, init_db

    init_db(maintenance=False)
    conn = get_connection()
    yield conn
    conn.close()
    os.environ.pop("HUNT_DB_PATH", None)


@pytest.mark.parametrize(
    "statement,initial,duplicate",
    [
        (
            "INSERT INTO component_settings (component, key, value, value_type, updated_by) VALUES (?,?,?,?,?)",
            ("C2", "model_name", "model", "string", "test"),
            ("C2", "model_name", "other", "string", "test"),
        ),
        (
            "INSERT INTO linkedin_accounts (username, active) VALUES (?, ?)",
            ("dup@example.com", 1),
            ("dup@example.com", 1),
        ),
    ],
)
def test_database_rejects_duplicate_identity(db, statement, initial, duplicate):
    db.execute(statement, initial)
    db.commit()
    with pytest.raises(sqlite3.IntegrityError):
        db.execute(statement, duplicate)
        db.commit()
