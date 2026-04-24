"""Tests for component_settings and linkedin_accounts tables."""

import os
import sqlite3

import pytest


@pytest.fixture
def db(tmp_path):
    db_file = tmp_path / "test.db"
    os.environ["HUNT_DB_PATH"] = str(db_file)
    os.environ.pop("HUNT_DB_URL", None)
    from hunter.db import init_db, get_connection

    init_db(maintenance=False)
    conn = get_connection()
    yield conn
    conn.close()
    os.environ.pop("HUNT_DB_PATH", None)


def test_component_settings_table_exists(db):
    rows = db.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='component_settings'"
    ).fetchall()
    assert len(rows) == 1


def test_component_settings_insert_and_read(db):
    db.execute(
        """
        INSERT INTO component_settings (component, key, value, value_type, secret, updated_by)
        VALUES (?, ?, ?, ?, ?, ?)
        """,
        ("C1", "enrichment_batch_limit", "25", "int", 0, "test"),
    )
    db.commit()
    row = db.execute(
        "SELECT * FROM component_settings WHERE component = ? AND key = ?",
        ("C1", "enrichment_batch_limit"),
    ).fetchone()
    assert row is not None
    assert row["value"] == "25"
    assert row["value_type"] == "int"
    assert row["secret"] == 0


def test_component_settings_primary_key_conflict(db):
    db.execute(
        "INSERT INTO component_settings (component, key, value, value_type, updated_by) VALUES (?,?,?,?,?)",
        ("C2", "model_name", "gemma2:9b", "string", "test"),
    )
    db.commit()
    with pytest.raises(sqlite3.IntegrityError):
        db.execute(
            "INSERT INTO component_settings (component, key, value, value_type, updated_by) VALUES (?,?,?,?,?)",
            ("C2", "model_name", "other", "string", "test"),
        )
        db.commit()


def test_component_settings_upsert(db):
    db.execute(
        "INSERT INTO component_settings (component, key, value, value_type, updated_by) VALUES (?,?,?,?,?)",
        ("C0", "admin_password", "old", "secret", "test"),
    )
    db.commit()
    db.execute(
        """
        INSERT INTO component_settings (component, key, value, value_type, updated_by)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(component, key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by
        """,
        ("C0", "admin_password", "new", "secret", "operator"),
    )
    db.commit()
    row = db.execute(
        "SELECT value, updated_by FROM component_settings WHERE component = ? AND key = ?",
        ("C0", "admin_password"),
    ).fetchone()
    assert row["value"] == "new"
    assert row["updated_by"] == "operator"


def test_linkedin_accounts_table_exists(db):
    rows = db.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='linkedin_accounts'"
    ).fetchall()
    assert len(rows) == 1


def test_linkedin_accounts_insert_and_read(db):
    db.execute(
        """
        INSERT INTO linkedin_accounts (username, password_encrypted, display_name, active, auth_state)
        VALUES (?, ?, ?, ?, ?)
        """,
        ("user@example.com", "enc_token_here", "Test User", 1, "unknown"),
    )
    db.commit()
    row = db.execute(
        "SELECT * FROM linkedin_accounts WHERE username = ?", ("user@example.com",)
    ).fetchone()
    assert row is not None
    assert row["display_name"] == "Test User"
    assert row["active"] == 1
    assert row["auth_state"] == "unknown"


def test_linkedin_accounts_username_unique(db):
    db.execute(
        "INSERT INTO linkedin_accounts (username, active) VALUES (?, ?)",
        ("dup@example.com", 1),
    )
    db.commit()
    with pytest.raises(sqlite3.IntegrityError):
        db.execute(
            "INSERT INTO linkedin_accounts (username, active) VALUES (?, ?)",
            ("dup@example.com", 1),
        )
        db.commit()


def test_linkedin_accounts_defaults(db):
    db.execute(
        "INSERT INTO linkedin_accounts (username) VALUES (?)",
        ("defaults@example.com",),
    )
    db.commit()
    row = db.execute(
        "SELECT * FROM linkedin_accounts WHERE username = ?", ("defaults@example.com",)
    ).fetchone()
    assert row["active"] == 1
    assert row["auth_state"] == "unknown"
    assert row["password_encrypted"] is None
