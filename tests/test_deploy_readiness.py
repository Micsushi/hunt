"""Deploy readiness checks for Postgres migration/runtime dependencies."""

from __future__ import annotations

import os
import subprocess
import sys
import types
from pathlib import Path

import httpx
import pytest
from fastapi import HTTPException

from backend import gateway
from scripts import migrate_sqlite_to_postgres as migration
from scripts import (
    run_component_ci,
    run_deploy_stack,
)

REPO_ROOT = Path(__file__).resolve().parent.parent


def _standalone_launcher_env(tmp_path: Path) -> dict[str, str]:
    env = os.environ.copy()
    env["HUNT_DB_PATH"] = str(tmp_path / "hunt.db")
    env["HUNT_ARTIFACTS_DIR"] = str(tmp_path / "artifacts")
    env["HUNT_COORDINATOR_ROOT"] = str(tmp_path / "coordinator")
    env["PATH"] = str(REPO_ROOT) + os.pathsep + env.get("PATH", "")
    return env


class FakeCursor:
    def __init__(self):
        self.statements: list[str] = []
        self.params: list[tuple | None] = []

    def execute(self, statement: str, params=None):
        self.statements.append(statement)
        self.params.append(params)


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


@pytest.mark.skipif(sys.platform != "win32", reason="Windows-only deploy wrapper")
def test_server2_deploy_wrapper_rejects_retired_c3_c4_stages(tmp_path):
    ansible_repo = tmp_path / "ansible_homelab"
    ansible_repo.mkdir()
    (ansible_repo / "deploy.ps1").write_text(
        "param([string]$Target, [string]$Stage, [string]$Tags)\n",
        encoding="utf-8",
    )
    command = [
        "powershell.exe",
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        str(REPO_ROOT / "scripts" / "deploy_server2.ps1"),
        "-Stages",
        "9",
        "-AnsibleRepo",
        str(ansible_repo),
        "-PrintOnly",
    ]

    result = subprocess.run(command, capture_output=True, text=True)

    assert result.returncode != 0
    assert "Unsupported Hunt stage" in result.stderr


def test_public_examples_and_candidate_template_are_machine_neutral():
    public_files = (
        ".env.example",
        ".env.server.example",
        "docs/FLETCH_CLI.md",
        "fletcher/config.py",
        "fletcher/README.md",
    )
    combined = "\n".join((REPO_ROOT / path).read_text(encoding="utf-8") for path in public_files)
    candidate = (REPO_ROOT / "fletcher/templates/candidate_profile.template.md").read_text(
        encoding="utf-8"
    )

    assert r"C:\Users\sushi" not in combined
    assert "/home/michael" not in combined
    assert "Michael Shi" not in candidate
    assert "Citizen / Permanent Resident" not in candidate
    assert "all code written by me" not in candidate
    assert "Deployed the full stack" not in candidate
    assert "<replace-with-approved-fact>" in candidate


def test_public_fletcher_master_resume_default_is_generic_and_local_data_is_ignored():
    config = (REPO_ROOT / "fletcher/config.py").read_text(encoding="utf-8")
    template = (REPO_ROOT / "fletcher/templates/master_resume.template.yaml").read_text(
        encoding="utf-8"
    )
    tracked = subprocess.run(
        ["git", "ls-files", "fletcher/master_resume.yaml", "fletcher/master_resume.local.yaml"],
        cwd=REPO_ROOT,
        check=True,
        capture_output=True,
        text=True,
    ).stdout.splitlines()

    assert "fletcher/master_resume.local.yaml" not in tracked
    assert not (REPO_ROOT / "fletcher/master_resume.yaml").exists()
    assert "HUNT_MASTER_RESUME_PATH" in config
    assert "DEFAULT_MASTER_RESUME_LOCAL_PATH.exists()" in config
    assert "DEFAULT_MASTER_RESUME_TEMPLATE_PATH" in config
    assert "Your Name" in template
    assert "Michael Shi" not in template
    assert "wenjian2@ualberta.ca" not in template
    ignored = subprocess.run(
        ["git", "check-ignore", "fletcher/master_resume.local.yaml"],
        cwd=REPO_ROOT,
        capture_output=True,
        text=True,
    )
    assert ignored.returncode == 0


def test_fletcher_private_resume_sources_are_runtime_only():
    dockerignore = (REPO_ROOT / ".dockerignore").read_text(encoding="utf-8")
    config = (REPO_ROOT / "fletcher/config.py").read_text(encoding="utf-8")
    compose = (REPO_ROOT / "docker-compose.pipeline.yml").read_text(encoding="utf-8")

    private_paths = (
        "fletcher/base_resume.local.tex",
        "fletcher/base_resumes/**/main.local.tex",
        "fletcher/master_resume.local.yaml",
        "fletcher/candidate_profile.md",
        "fletcher/bullet_library.md",
    )
    for path in private_paths:
        assert path in dockerignore

    for env_name in (
        "HUNT_OG_RESUME_PATH",
        "HUNT_BASE_RESUMES_ROOT",
        "HUNT_MASTER_RESUME_PATH",
        "HUNT_CANDIDATE_PROFILE_PATH",
        "HUNT_BULLET_LIBRARY_PATH",
    ):
        assert env_name in config
        assert compose.count(f"{env_name}: /run/hunt-private/") == 2

    assert compose.count("${HUNT_OG_RESUME_PATH:-./main.tex}") == 2
    assert compose.count("${HUNT_BASE_RESUMES_ROOT:-./fletcher/base_resumes}") == 2
    assert compose.count("${HUNT_MASTER_RESUME_PATH:-./fletcher/templates/") == 2
    assert compose.count("${HUNT_CANDIDATE_PROFILE_PATH:-./fletcher/templates/") == 2
    assert compose.count("${HUNT_BULLET_LIBRARY_PATH:-./fletcher/templates/") == 2


def test_public_fletcher_tex_defaults_are_neutral():
    config = (REPO_ROOT / "fletcher/config.py").read_text(encoding="utf-8")
    public_resume = (REPO_ROOT / "main.tex").read_text(encoding="utf-8")
    review_dockerfile = (REPO_ROOT / "docker/Dockerfile.review").read_text(encoding="utf-8")
    fletcher_dockerfile = (REPO_ROOT / "docker/Dockerfile.fletcher").read_text(encoding="utf-8")
    public_family_resumes = list((REPO_ROOT / "fletcher/base_resumes").glob("*/main.tex"))

    assert "HUNT_OG_RESUME_PATH" in config
    assert "DEFAULT_OG_RESUME_LOCAL_PATH.exists()" in config
    assert "main.local.tex" in config
    assert "Your Name" in public_resume
    assert "Michael Shi" not in public_resume
    assert "wenjian2@ualberta.ca" not in public_resume
    assert "COPY main.tex /app/main.tex" in review_dockerfile
    assert "COPY main.tex /app/main.tex" in fletcher_dockerfile
    assert public_family_resumes == []


def test_deploy_runner_dry_run_skips_subprocess(monkeypatch, capsys):
    def fail_run(_command, _cwd, env=None):
        raise AssertionError("subprocess.run should not be called in dry-run mode")

    monkeypatch.setattr(run_deploy_stack.subprocess, "run", fail_run)
    monkeypatch.setattr(
        run_deploy_stack,
        "select_resource_profile",
        lambda _requested: types.SimpleNamespace(
            requested="auto",
            selected="fast",
            gpu_vram_mb=16311,
            reason="gpu_vram_at_least_15gb",
            env={"OLLAMA_NUM_PARALLEL": "5"},
        ),
    )
    monkeypatch.setattr(run_deploy_stack.sys, "argv", ["run_deploy_stack.py", "all", "--dry-run"])

    assert run_deploy_stack.main() == 0

    output = capsys.readouterr().out
    assert "docker compose" in output
    assert "coordinator" not in output
    assert "resource_profile: fast" in output


@pytest.mark.parametrize("target", ["c4", "coordinator"])
def test_component_ci_runner_blocks_c4(target, monkeypatch, capsys):
    calls = []

    def fake_run(command, cwd):
        calls.append((command, cwd))
        return types.SimpleNamespace(returncode=0)

    monkeypatch.setattr(run_component_ci.subprocess, "run", fake_run)
    monkeypatch.setattr(
        run_component_ci.sys,
        "argv",
        ["run_component_ci.py", target, "--dry-run"],
    )

    assert run_component_ci.main() == 2
    assert calls == []
    assert "C4 is on hold" in capsys.readouterr().err


# ---------------------------------------------------------------------------
# C0 (UI) launcher smoke tests
# ---------------------------------------------------------------------------


# ---------------------------------------------------------------------------
# C2 (Fletcher) launcher smoke tests
# ---------------------------------------------------------------------------


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
