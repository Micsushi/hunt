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


def test_migration_coerces_sqlite_booleans_for_postgres():
    columns = ["id", "title", "is_remote", "priority", "auto_apply_eligible"]
    row = {
        "id": 1,
        "title": "Engineer",
        "is_remote": 1,
        "priority": 0,
        "auto_apply_eligible": None,
    }

    assert migration._coerce_record("jobs", columns, row) == (
        1,
        "Engineer",
        True,
        False,
        None,
    )


def test_migration_skips_missing_legacy_sqlite_tables(tmp_path, capsys):
    sqlite_path = tmp_path / "legacy.db"
    import sqlite3

    sqlite_conn = sqlite3.connect(sqlite_path)
    sqlite_conn.execute("CREATE TABLE jobs (id INTEGER PRIMARY KEY, title TEXT)")
    sqlite_conn.commit()
    sqlite_conn.close()

    sqlite_conn = sqlite3.connect(sqlite_path)
    sqlite_conn.row_factory = sqlite3.Row
    pg_conn = FakePgConn()

    migration._migrate_table(
        sqlite_conn,
        pg_conn,
        "component_settings",
        dry_run=True,
    )

    sqlite_conn.close()
    assert "component_settings: missing in SQLite source (skipped)" in capsys.readouterr().out
    assert pg_conn.cursor_obj.statements == []


def test_migration_validate_treats_missing_legacy_sqlite_tables_as_zero(monkeypatch, tmp_path, capsys):
    sqlite_path = tmp_path / "legacy.db"
    import sqlite3

    sqlite_conn = sqlite3.connect(sqlite_path)
    sqlite_conn.execute("CREATE TABLE jobs (id INTEGER PRIMARY KEY, title TEXT)")
    sqlite_conn.close()

    class CountCursor:
        def __init__(self):
            self.count = 0

        def execute(self, _statement):
            self.count = 0

        def fetchone(self):
            return (self.count,)

    class CountPgConn:
        def cursor(self):
            return CountCursor()

        def close(self):
            pass

    fake_psycopg2 = types.ModuleType("psycopg2")
    fake_psycopg2.connect = lambda _url: CountPgConn()
    monkeypatch.setitem(sys.modules, "psycopg2", fake_psycopg2)

    migration._validate(str(sqlite_path), "postgresql://example")

    output = capsys.readouterr().out
    assert "component_settings" in output
    assert "All counts match." in output


def test_postgres_driver_declared_in_runtime_requirements():
    requirements = Path("hunter/requirements.txt").read_text(encoding="utf-8")
    assert "psycopg2-binary" in requirements


def test_form_parser_declared_in_runtime_requirements():
    requirements = Path("hunter/requirements.txt").read_text(encoding="utf-8")
    assert "python-multipart" in requirements


def test_fletcher_container_smoke_assets_exist():
    dockerfile = Path("Dockerfile.fletcher")
    smoke_script = Path("scripts/smoke_fletcher_container.sh")

    assert dockerfile.is_file()
    assert smoke_script.is_file()

    dockerfile_text = dockerfile.read_text(encoding="utf-8")
    assert "fletcher.service:app" in dockerfile_text
    assert "EXPOSE 8002" in dockerfile_text

    smoke_text = smoke_script.read_text(encoding="utf-8")
    assert "Dockerfile.fletcher" in smoke_text
    assert "/status" in smoke_text


def test_coordinator_container_smoke_assets_exist():
    dockerfile = Path("Dockerfile.coordinator")
    smoke_script = Path("scripts/smoke_coordinator_container.sh")

    assert dockerfile.is_file()
    assert smoke_script.is_file()

    dockerfile_text = dockerfile.read_text(encoding="utf-8")
    assert "coordinator.service_api:app" in dockerfile_text
    assert "EXPOSE 8003" in dockerfile_text

    smoke_text = smoke_script.read_text(encoding="utf-8")
    assert "Dockerfile.coordinator" in smoke_text
    assert "/status" in smoke_text


def test_hunter_container_smoke_assets_exist():
    dockerfile = Path("Dockerfile.hunter")
    smoke_script = Path("scripts/smoke_hunter_container.sh")

    assert dockerfile.is_file()
    assert smoke_script.is_file()

    dockerfile_text = dockerfile.read_text(encoding="utf-8")
    assert "hunter.service:app" in dockerfile_text
    assert "playwright install" in dockerfile_text
    assert "EXPOSE 8001" in dockerfile_text

    smoke_text = smoke_script.read_text(encoding="utf-8")
    assert "Dockerfile.hunter" in smoke_text
    assert "/status" in smoke_text


def test_pipeline_compose_smoke_assets_exist():
    compose_file = Path("docker-compose.pipeline.yml")
    smoke_script = Path("scripts/smoke_pipeline_compose.sh")

    assert compose_file.is_file()
    assert smoke_script.is_file()

    compose_text = compose_file.read_text(encoding="utf-8")
    assert "Dockerfile.review" in compose_text
    assert "Dockerfile.hunter" in compose_text
    assert "Dockerfile.fletcher" in compose_text
    assert "Dockerfile.coordinator" in compose_text
    assert "postgres:16" in compose_text

    smoke_text = smoke_script.read_text(encoding="utf-8")
    assert "docker compose" in smoke_text
    assert "/health" in smoke_text
    assert "/status" in smoke_text


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
