"""Deploy readiness checks for Postgres migration/runtime dependencies."""

from __future__ import annotations

import sys
import types
from pathlib import Path

import httpx
import pytest
from fastapi import HTTPException

from backend import gateway
from scripts import migrate_sqlite_to_postgres as migration


class FakeCursor:
    def __init__(self):
        self.statements: list[str] = []

    def execute(self, statement: str, params=None):
        self.statements.append(statement)


class FakePgConn:
    def __init__(self):
        self.cursor_obj = FakeCursor()

    def cursor(self):
        return self.cursor_obj


def test_migration_does_not_disable_postgres_triggers(monkeypatch, tmp_path):
    sqlite_path = tmp_path / "source.db"

    import sqlite3

    sqlite_conn = sqlite3.connect(sqlite_path)
    sqlite_conn.row_factory = sqlite3.Row
    sqlite_conn.execute("CREATE TABLE jobs (id INTEGER PRIMARY KEY, title TEXT)")
    sqlite_conn.execute("INSERT INTO jobs (id, title) VALUES (?, ?)", (1, "Engineer"))
    sqlite_conn.commit()

    inserted = {}

    def fake_execute_values(cur, statement, records):
        inserted["statement"] = statement
        inserted["records"] = records

    fake_extras = types.ModuleType("psycopg2.extras")
    fake_extras.execute_values = fake_execute_values
    fake_psycopg2 = types.ModuleType("psycopg2")
    fake_psycopg2.extras = fake_extras
    monkeypatch.setitem(sys.modules, "psycopg2", fake_psycopg2)
    monkeypatch.setitem(sys.modules, "psycopg2.extras", fake_extras)

    pg_conn = FakePgConn()
    migration._migrate_table(sqlite_conn, pg_conn, "jobs", dry_run=False)

    statements = "\n".join(pg_conn.cursor_obj.statements).upper()
    assert "DISABLE TRIGGER" not in statements
    assert "ENABLE TRIGGER" not in statements
    assert inserted["records"] == [(1, "Engineer")]


def test_postgres_driver_declared_in_runtime_requirements():
    requirements = Path("hunter/requirements.txt").read_text(encoding="utf-8")
    assert "psycopg2-binary" in requirements


def test_form_parser_declared_in_runtime_requirements():
    requirements = Path("hunter/requirements.txt").read_text(encoding="utf-8")
    assert "python-multipart" in requirements


class FakeTimeoutClient:
    def __init__(self, timeout):
        self.timeout = timeout

    async def __aenter__(self):
        return self

    async def __aexit__(self, exc_type, exc_val, exc_tb):
        return False

    async def get(self, url, headers):
        raise httpx.ReadTimeout("timed out")


class FakeNonJsonClient:
    def __init__(self, timeout):
        self.timeout = timeout

    async def __aenter__(self):
        return self

    async def __aexit__(self, exc_type, exc_val, exc_tb):
        return False

    async def get(self, url, headers):
        return httpx.Response(502, text="<html>bad gateway</html>")


@pytest.mark.anyio
async def test_gateway_timeout_returns_service_unavailable(monkeypatch):
    monkeypatch.setattr(gateway.httpx, "AsyncClient", FakeTimeoutClient)

    with pytest.raises(HTTPException) as exc:
        await gateway._proxy_get("http://service/status")

    assert exc.value.status_code == 503
    assert "Service unavailable" in exc.value.detail


@pytest.mark.anyio
async def test_gateway_non_json_upstream_returns_bad_gateway(monkeypatch):
    monkeypatch.setattr(gateway.httpx, "AsyncClient", FakeNonJsonClient)

    response = await gateway._proxy_get("http://service/status")

    assert response.status_code == 502
    assert b"non-JSON" in response.body
