"""Deploy readiness checks for Postgres migration/runtime dependencies."""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
import types
from pathlib import Path

import httpx
import pytest
from fastapi import HTTPException

from backend import gateway
from hunter import db as hunter_db
from scripts import migrate_sqlite_to_postgres as migration
from scripts import (
    resource_profiles,
    run_component_checks,
    run_component_ci,
    run_component_tests,
    run_deploy_stack,
    run_local_smoke,
)

REPO_ROOT = Path(__file__).resolve().parent.parent


def test_postgres_schema_does_not_provision_removed_c3_v2_ledger():
    schema = (REPO_ROOT / "schema" / "postgres_schema.sql").read_text(encoding="utf-8")

    for removed_object in (
        "ledger_agents",
        "ledger_lanes",
        "ledger_sessions",
        "ledger_leases",
        "ledger_browser_targets",
        "ledger_events",
        "ledger_probe_files",
        "ledger_artifacts",
    ):
        assert removed_object not in schema


def test_pipeline_compose_persists_active_component_audit_log():
    compose = (REPO_ROOT / "docker-compose.pipeline.yml").read_text(encoding="utf-8")

    assert "HUNT_AUDIT_LOG_ROOT" in compose
    assert "HUNT_AUDIT_LOG_STORAGE" in compose
    assert "pipeline_audit_data" in compose
    assert compose.count("HUNT_AUDIT_LOG_ROOT:") == 3
    assert (
        compose.count(
            "- ${HUNT_AUDIT_LOG_STORAGE:-pipeline_audit_data}:"
            "${HUNT_AUDIT_LOG_CONTAINER_ROOT:-/hunt-audit}"
        )
        == 3
    )
    assert "USERPROFILE" not in compose
    assert "HUNT_LEDGER" not in compose


def test_pipeline_compose_audit_volume_is_portable_without_userprofile():
    if not shutil.which("docker"):
        pytest.skip("Docker CLI not installed")
    env = os.environ.copy()
    env.pop("USERPROFILE", None)
    result = subprocess.run(
        [
            "docker",
            "compose",
            "--profile",
            "c0",
            "-f",
            str(REPO_ROOT / "docker-compose.pipeline.yml"),
            "config",
        ],
        cwd=REPO_ROOT,
        env=env,
        capture_output=True,
        text=True,
    )

    assert result.returncode == 0, result.stderr
    assert "/Documents/hunt-logs" not in result.stdout
    assert "pipeline_audit_data" in result.stdout


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


def test_postgres_delete_cascade_migration_updates_existing_constraints(monkeypatch):
    monkeypatch.setenv("HUNT_DB_URL", "postgresql://example")
    cursor = FakeCursor()

    hunter_db._ensure_postgres_delete_cascade_constraints(cursor)

    statements = "\n".join(cursor.statements).upper()
    assert "ON DELETE CASCADE" in statements
    assert "DROP CONSTRAINT" in statements
    assert "%%I" in statements
    assert "%I" not in statements.replace("%%I", "")
    assert ("orchestration_runs", "orchestration_runs_job_id_fkey") in [
        tuple(params[:2]) for params in cursor.params if params
    ]


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


def test_migration_validate_treats_missing_legacy_sqlite_tables_as_zero(
    monkeypatch, tmp_path, capsys
):
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


def test_repo_root_does_not_keep_dev_probe_files():
    root_probe_files = [
        "test_exit.ps1",
        "test_exit2.ps1",
        "test_path_exit.ps1",
        "test_preference.ps1",
        "test_preference2.ps1",
        "test_startproc.ps1",
        "test_stderr.ps1",
        "linkedin_relogin_windows.log",
        "hunt-local-test.db",
    ]

    for file_name in root_probe_files:
        assert not Path(file_name).exists()

    assert Path("tools/dev-probes/README.md").is_file()
    assert Path("tests/fixtures/databases/README.md").is_file()


def test_fletcher_container_smoke_assets_exist():
    dockerfile = Path("docker/Dockerfile.fletcher")
    smoke_script = Path("scripts/smoke_fletcher_container.sh")

    assert dockerfile.is_file()
    assert smoke_script.is_file()

    dockerfile_text = dockerfile.read_text(encoding="utf-8")
    assert "fletcher.service:app" in dockerfile_text
    assert "EXPOSE 8002" in dockerfile_text

    smoke_text = smoke_script.read_text(encoding="utf-8")
    assert "docker/Dockerfile.fletcher" in smoke_text
    assert "/status" in smoke_text


def test_pipeline_compose_shares_resume_artifacts_between_review_and_fletcher():
    compose_text = Path("docker-compose.pipeline.yml").read_text(encoding="utf-8")

    assert (
        "HUNT_RESUME_ARTIFACTS_DIR: ${HUNT_RESUME_ARTIFACTS_DIR:-/tmp/hunt-resumes}" in compose_text
    )
    assert (
        compose_text.count("- ${HUNT_RESUME_STORAGE:-pipeline_resume_data}:/tmp/hunt-resumes") == 2
    )
    assert "pipeline_resume_data:" in compose_text


def test_pipeline_compose_manages_ollama_for_c2_server_runs():
    compose_text = Path("docker-compose.pipeline.yml").read_text(encoding="utf-8")

    assert "restart: unless-stopped" in compose_text
    assert "ollama pull ${HUNT_OLLAMA_MODEL:-gemma4:e4b}" in compose_text
    assert "ollama pull ${HUNT_OLLAMA_EMBED_MODEL:-mxbai-embed-large}" in compose_text
    assert "driver: nvidia" not in compose_text


def test_server_compose_requests_gpu_for_ollama():
    compose_text = Path("docker-compose.server.yml").read_text(encoding="utf-8")

    assert "ollama:\n    gpus: all" in compose_text


def test_server_compose_review_writes_resume_artifacts_to_writable_mount():
    compose_text = Path("docker-compose.server.yml").read_text(encoding="utf-8")

    assert "HUNT_RESUME_ARTIFACTS_DIR: /tmp/hunt-resumes" in compose_text
    assert "- ${HUNT_RESUME_STORAGE}:/app/resumes:ro" in compose_text
    assert "- ${HUNT_RESUME_STORAGE}:/tmp/hunt-resumes" in compose_text


def test_coordinator_container_assets_are_archived_and_smoke_is_blocked():
    dockerfile = Path("docker/Dockerfile.coordinator")
    smoke_script = Path("scripts/smoke_coordinator_container.sh")

    assert dockerfile.is_file()
    assert smoke_script.is_file()

    dockerfile_text = dockerfile.read_text(encoding="utf-8")
    assert "coordinator.service_api:app" in dockerfile_text
    assert "EXPOSE 8003" in dockerfile_text

    smoke_text = smoke_script.read_text(encoding="utf-8")
    assert "C4 is on hold" in smoke_text
    assert "exit 2" in smoke_text


def test_hunter_container_smoke_assets_exist():
    dockerfile = Path("docker/Dockerfile.hunter")
    smoke_script = Path("scripts/smoke_hunter_container.sh")

    assert dockerfile.is_file()
    assert smoke_script.is_file()

    dockerfile_text = dockerfile.read_text(encoding="utf-8")
    assert "hunter.service:app" in dockerfile_text
    assert "playwright install" in dockerfile_text
    assert "EXPOSE 8001" in dockerfile_text

    smoke_text = smoke_script.read_text(encoding="utf-8")
    assert "docker/Dockerfile.hunter" in smoke_text
    assert "/status" in smoke_text


def test_pipeline_compose_smoke_assets_exist():
    compose_file = Path("docker-compose.pipeline.yml")
    smoke_script = Path("scripts/smoke_pipeline_compose.sh")

    assert compose_file.is_file()
    assert smoke_script.is_file()

    compose_text = compose_file.read_text(encoding="utf-8")
    assert "docker/Dockerfile.review" in compose_text
    assert "docker/Dockerfile.hunter" in compose_text
    assert "docker/Dockerfile.fletcher" in compose_text
    assert "docker/Dockerfile.coordinator" not in compose_text
    assert "postgres:16" in compose_text

    smoke_text = smoke_script.read_text(encoding="utf-8")
    assert "docker compose" in smoke_text
    assert "/health" in smoke_text
    assert "/status" in smoke_text


def test_one_command_local_smoke_runner_exists(monkeypatch):
    runner = Path("scripts/run_local_smoke.py")

    assert runner.is_file()

    runner_text = runner.read_text(encoding="utf-8")
    assert "SMOKE_TARGETS" in runner_text
    assert "smoke_pipeline_compose.sh" in runner_text
    assert "smoke_hunter_container.sh" in runner_text
    assert "smoke_fletcher_container.sh" in runner_text
    assert "smoke_c0_pipeline_container.sh" in runner_text
    assert "smoke_coordinator_e2e.sh" not in runner_text
    assert "smoke_server2_c1.sh" in runner_text
    assert 'shutil.which("wsl")' in runner_text

    calls = []

    def fake_run(command, cwd, check=False):
        calls.append((command, cwd))
        return types.SimpleNamespace(returncode=0)

    monkeypatch.setattr(run_local_smoke, "_resolve_runner", lambda: ["bash"])
    monkeypatch.setattr(run_local_smoke.subprocess, "run", fake_run)
    monkeypatch.setattr(run_local_smoke.sys, "argv", ["run_local_smoke.py"])

    assert run_local_smoke.main() == 0
    assert [command for command, _cwd in calls] == [
        ["bash", "scripts/smoke_pipeline_compose.sh"],
        ["bash", "scripts/smoke_c0_pipeline_container.sh"],
    ]
    assert all(cwd == run_local_smoke.ROOT for _command, cwd in calls)


def test_local_smoke_runner_windows_falls_back_to_wsl(monkeypatch):
    monkeypatch.setattr(run_local_smoke.os, "name", "nt", raising=False)
    monkeypatch.setattr(run_local_smoke, "_find_git_bash", lambda: None)

    def fake_which(name):
        if name == "bash":
            return None
        if name == "wsl":
            return "C:\\Windows\\System32\\wsl.exe"
        return None

    monkeypatch.setattr(run_local_smoke.shutil, "which", fake_which)

    assert run_local_smoke._resolve_runner() == ["C:\\Windows\\System32\\wsl.exe", "bash"]


def test_local_smoke_runner_dry_run_skips_subprocess(monkeypatch, capsys):
    def fail_run(_command, _cwd):
        raise AssertionError("subprocess.run should not be called in dry-run mode")

    monkeypatch.setattr(run_local_smoke, "_resolve_runner", lambda: ["bash"])
    monkeypatch.setattr(run_local_smoke.subprocess, "run", fail_run)
    monkeypatch.setattr(run_local_smoke.sys, "argv", ["run_local_smoke.py", "--dry-run"])

    assert run_local_smoke.main() == 0

    output = capsys.readouterr().out
    assert "dry-run" in output
    assert "smoke_pipeline_compose.sh" in output


def test_local_smoke_runner_prefers_git_bash_on_windows(monkeypatch):
    monkeypatch.setattr(run_local_smoke.os, "name", "nt", raising=False)
    monkeypatch.setattr(
        run_local_smoke,
        "_find_git_bash",
        lambda: r"C:\Program Files\Git\bin\bash.exe",
    )
    monkeypatch.setattr(
        run_local_smoke.shutil, "which", lambda _name: r"C:\Windows\System32\bash.exe"
    )

    assert run_local_smoke._resolve_runner() == [r"C:\Program Files\Git\bin\bash.exe"]


def test_local_smoke_runner_ignores_windows_bash_launcher(monkeypatch):
    monkeypatch.setattr(run_local_smoke.os, "name", "nt", raising=False)
    monkeypatch.setattr(run_local_smoke, "_find_git_bash", lambda: None)

    def fake_which(name):
        if name == "bash":
            return r"C:\Windows\System32\bash.exe"
        if name == "wsl":
            return r"C:\Windows\System32\wsl.exe"
        return None

    monkeypatch.setattr(run_local_smoke.shutil, "which", fake_which)

    assert run_local_smoke._resolve_runner() == [r"C:\Windows\System32\wsl.exe", "bash"]


def test_local_smoke_runner_target_mapping(monkeypatch):
    calls = []

    def fake_run(command, cwd, check=False):
        calls.append((command, cwd))
        return types.SimpleNamespace(returncode=0)

    monkeypatch.setattr(run_local_smoke, "_resolve_runner", lambda: ["bash"])
    monkeypatch.setattr(run_local_smoke.subprocess, "run", fake_run)
    monkeypatch.setattr(run_local_smoke.sys, "argv", ["run_local_smoke.py", "c1"])

    assert run_local_smoke.main() == 0
    assert [command for command, _cwd in calls] == [
        ["bash", "scripts/smoke_hunter_container.sh"],
    ]


def test_local_smoke_runner_server2_target_runs_c0_and_c1(monkeypatch):
    calls = []

    def fake_run(command, cwd, check=False):
        calls.append((command, cwd))
        return types.SimpleNamespace(returncode=0)

    monkeypatch.setattr(run_local_smoke, "_resolve_runner", lambda: ["bash"])
    monkeypatch.setattr(run_local_smoke.subprocess, "run", fake_run)
    monkeypatch.setattr(run_local_smoke.sys, "argv", ["run_local_smoke.py", "server2"])

    assert run_local_smoke.main() == 0
    assert [command for command, _cwd in calls] == [
        ["bash", "scripts/smoke_server2.sh"],
        ["bash", "scripts/smoke_server2_c1.sh"],
    ]


def test_local_smoke_runner_server2_c1_target_mapping(monkeypatch):
    calls = []

    def fake_run(command, cwd, check=False):
        calls.append((command, cwd))
        return types.SimpleNamespace(returncode=0)

    monkeypatch.setattr(run_local_smoke, "_resolve_runner", lambda: ["bash"])
    monkeypatch.setattr(run_local_smoke.subprocess, "run", fake_run)
    monkeypatch.setattr(run_local_smoke.sys, "argv", ["run_local_smoke.py", "server2-c1"])

    assert run_local_smoke.main() == 0
    assert [command for command, _cwd in calls] == [
        ["bash", "scripts/smoke_server2_c1.sh"],
    ]


def test_local_smoke_runner_alias_mapping(monkeypatch):
    calls = []

    def fake_run(command, cwd, check=False):
        calls.append((command, cwd))
        return types.SimpleNamespace(returncode=0)

    monkeypatch.setattr(run_local_smoke, "_resolve_runner", lambda: ["bash"])
    monkeypatch.setattr(run_local_smoke.subprocess, "run", fake_run)
    monkeypatch.setattr(run_local_smoke.sys, "argv", ["run_local_smoke.py", "hunter"])

    assert run_local_smoke.main() == 0
    assert [command for command, _cwd in calls] == [
        ["bash", "scripts/smoke_hunter_container.sh"],
    ]


def test_local_smoke_runner_unknown_target_returns_error(monkeypatch, capsys):
    monkeypatch.setattr(run_local_smoke, "_resolve_runner", lambda: ["bash"])
    monkeypatch.setattr(run_local_smoke.sys, "argv", ["run_local_smoke.py", "c3"])

    assert run_local_smoke.main() == 1
    assert "Unknown smoke target" in capsys.readouterr().err


def test_local_smoke_runner_sends_discord_notification_on_failure(monkeypatch):
    calls = []
    notifications = []

    def fake_run(command, cwd, check=False):
        calls.append((command, cwd, check))
        return types.SimpleNamespace(returncode=7)

    def fake_notify(message, username="Hunt", timeout_seconds=15):
        notifications.append(
            {
                "message": message,
                "username": username,
                "timeout_seconds": timeout_seconds,
            }
        )
        return {"sent": True, "reason": None, "status_code": 204}

    monkeypatch.setattr(run_local_smoke, "_resolve_runner", lambda: ["bash"])
    monkeypatch.setattr(run_local_smoke.subprocess, "run", fake_run)
    monkeypatch.setattr(run_local_smoke, "send_discord_webhook_message", fake_notify)
    monkeypatch.setattr(run_local_smoke.sys, "argv", ["run_local_smoke.py", "c1"])

    assert run_local_smoke.main() == 7
    assert calls == [(["bash", "scripts/smoke_hunter_container.sh"], run_local_smoke.ROOT, False)]
    assert len(notifications) == 1
    assert notifications[0]["username"] == "Hunt Smoke"
    assert "target=c1" in notifications[0]["message"]
    assert "script=scripts/smoke_hunter_container.sh" in notifications[0]["message"]
    assert "exit_code=7" in notifications[0]["message"]


def test_repo_root_smoke_shortcut_exists():
    shortcut = Path("smoke.py")

    assert shortcut.is_file()

    shortcut_text = shortcut.read_text(encoding="utf-8")
    assert "from scripts.run_local_smoke import main" in shortcut_text


def test_server2_deploy_wrapper_allows_only_active_stages():
    script = Path("scripts/deploy_server2.ps1")

    assert script.is_file()

    script_text = script.read_text(encoding="utf-8")
    assert "ansible_homelab" in script_text
    assert 'Target = "job_agent"' in script_text
    assert "$PrintOnly" in script_text
    assert "-Stages" in script_text
    assert "@DeployParams" in script_text
    assert '$AllowedStages = @("6", "7")' in script_text
    assert "Unsupported Hunt stage" in script_text


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


def test_server2_deploy_runbook_exists():
    runbook = Path("docs/SERVER2_DEPLOY.md")

    assert runbook.is_file()

    runbook_text = runbook.read_text(encoding="utf-8")
    assert "scripts/deploy_server2.ps1" in runbook_text
    assert "server2" in runbook_text
    assert "ansible_homelab" in runbook_text
    assert "python smoke.py server2-c1" in runbook_text
    assert "-Stages 8" not in runbook_text
    assert "-Stages 9" not in runbook_text


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


def test_public_hunter_defaults_are_generic():
    config = (REPO_ROOT / "hunter/config.py").read_text(encoding="utf-8")
    example = (REPO_ROOT / "hunt_user_config.example.json").read_text(encoding="utf-8")

    assert "agent-hunt-review.mshi.ca" not in config
    assert '"engineering": ["software engineer"]' in config
    assert '_DEFAULT_LOCATIONS = ["Remote"]' in config
    assert "_DEFAULT_WATCHLIST: list[str] = []" in config
    assert "_DEFAULT_TITLE_BLACKLIST: list[str] = []" in config
    assert "new grad" not in config
    assert "intern" not in config
    assert "Canada" not in config
    assert "new grad" not in example
    assert "intern" not in example
    assert "Canada" not in example


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


def test_c1_local_runbook_exists():
    runbook = Path("docs/C1_LOCAL_RUNBOOK.md")

    assert runbook.is_file()

    runbook_text = runbook.read_text(encoding="utf-8")
    assert ".\\hunter.ps1 auth-save" in runbook_text
    assert ".\\hunter.ps1 enrich --source linkedin --job-id 123 --ui-verify" in runbook_text
    assert "xvfb-run -a ./hunter.sh enrich 10 --source linkedin --headful" in runbook_text
    assert ".\\hunter.ps1 verify-easy-apply 123" in runbook_text


def test_server2_c1_smoke_assets_exist():
    smoke_script = Path("scripts/smoke_server2_c1.sh")

    assert smoke_script.is_file()

    smoke_text = smoke_script.read_text(encoding="utf-8")
    assert "/api/gateway/c1/status" in smoke_text
    assert "/api/gateway/c1/scrape" in smoke_text
    assert "/api/jobs/count?source=linkedin&status=processing" in smoke_text
    assert "Server2 C1 smoke PASSED" in smoke_text


def test_repo_root_deploy_shortcut_exists():
    shortcut = Path("deploy.py")

    assert shortcut.is_file()

    shortcut_text = shortcut.read_text(encoding="utf-8")
    assert "from scripts.run_deploy_stack import main" in shortcut_text


def test_repo_native_deploy_runbook_exists():
    runbook = Path("docs/DEPLOY.md")

    assert runbook.is_file()

    runbook_text = runbook.read_text(encoding="utf-8")
    assert "python deploy.py all" in runbook_text
    assert "docker-compose.pipeline.yml" in runbook_text


def test_server_compose_override_assets_exist():
    override_file = Path("docker-compose.server.yml")
    env_template = Path(".env.server.example")

    assert override_file.is_file()
    assert env_template.is_file()

    override_text = override_file.read_text(encoding="utf-8")
    assert "hunter-scheduler" in override_text
    assert "HUNT_DOCKER_NETWORK_NAME" in override_text
    assert "HUNT_HUNTER_SCHEDULER_CONTAINER_NAME" in override_text

    env_text = env_template.read_text(encoding="utf-8")
    assert "HUNT_REVIEW_CONTAINER_NAME" in env_text
    assert "HUNT_HUNTER_SCHEDULER_CONTAINER_NAME" in env_text


def test_pipeline_compose_scheduler_in_expected_profiles():
    compose_text = Path("docker-compose.pipeline.yml").read_text(encoding="utf-8")

    assert 'profiles: ["pipeline", "db", "c0", "c1", "c2", "c1c2", "all", "server"]' in compose_text
    # scheduler runs in all local profiles + server (not just server-only any more)
    assert 'profiles: ["pipeline", "c1", "c1c2", "all", "server"]' in compose_text


def test_backfill_enrichment_metadata_uses_boolean_safe_sql():
    class RecordingCursor:
        def __init__(self):
            self.statements = []

        def execute(self, statement, params=None):
            self.statements.append(statement)
            return self

    cursor = RecordingCursor()

    hunter_db._backfill_enrichment_metadata(cursor)

    joined = "\n".join(cursor.statements)
    assert "auto_apply_eligible IS TRUE" in joined
    assert "auto_apply_eligible = 1" not in joined


def test_deploy_runner_target_mapping(monkeypatch):
    calls = []

    def fake_run(command, cwd, env=None):
        calls.append((command, cwd))
        return types.SimpleNamespace(returncode=0)

    monkeypatch.setattr(run_deploy_stack.subprocess, "run", fake_run)
    monkeypatch.setattr(run_deploy_stack.sys, "argv", ["run_deploy_stack.py", "c1"])

    assert run_deploy_stack.main() == 0
    assert calls == [
        (
            [
                "docker",
                "compose",
                "-p",
                "hunt",
                "-f",
                str(run_deploy_stack.COMPOSE_FILE),
                "up",
                "-d",
                "--build",
                "review",
                "frontend",
                "hunter",
            ],
            run_deploy_stack.ROOT,
        )
    ]


def test_deploy_runner_server_mode_mapping(monkeypatch):
    calls = []

    def fake_run(command, cwd, env=None):
        calls.append((command, cwd, env))
        return types.SimpleNamespace(returncode=0)

    monkeypatch.setattr(run_deploy_stack.subprocess, "run", fake_run)
    monkeypatch.setattr(
        run_deploy_stack,
        "select_resource_profile",
        lambda _requested: types.SimpleNamespace(
            requested="auto",
            selected="safe",
            gpu_vram_mb=6144,
            reason="gpu_vram_at_least_6gb",
            env={"OLLAMA_NUM_PARALLEL": "1", "HUNT_BULLET_REWRITE_PARALLELISM": "1"},
        ),
    )
    monkeypatch.setattr(
        run_deploy_stack.sys,
        "argv",
        [
            "run_deploy_stack.py",
            "all",
            "--mode",
            "server",
            "--env-file",
            ".env.server2",
        ],
    )

    assert run_deploy_stack.main() == 0
    assert calls == [
        (
            [
                "docker",
                "compose",
                "-p",
                "hunt",
                "--env-file",
                ".env.server2",
                "-f",
                str(run_deploy_stack.COMPOSE_FILE),
                "-f",
                str(run_deploy_stack.SERVER_COMPOSE_FILE),
                "up",
                "-d",
                "--build",
                "postgres",
                "review",
                "frontend",
                "hunter",
                "hunter-scheduler",
                "ollama",
                "ollama-init",
                "fletcher",
            ],
            run_deploy_stack.ROOT,
            {**os.environ, "OLLAMA_NUM_PARALLEL": "1", "HUNT_BULLET_REWRITE_PARALLELISM": "1"},
        )
    ]


def test_deploy_runner_stop_mapping(monkeypatch):
    calls = []

    def fake_run(command, cwd, env=None):
        calls.append((command, cwd, env))
        return types.SimpleNamespace(returncode=0)

    monkeypatch.setattr(run_deploy_stack.subprocess, "run", fake_run)
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
    monkeypatch.setattr(run_deploy_stack.sys, "argv", ["run_deploy_stack.py", "c2", "--stop"])

    assert run_deploy_stack.main() == 0
    assert calls[0][0][-5:] == [
        "review",
        "frontend",
        "ollama",
        "ollama-init",
        "fletcher",
    ]


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


def test_resource_profile_auto_thresholds(monkeypatch):
    assert resource_profiles.select_resource_profile("auto", gpu_vram_mb=16311).selected == "fast"
    assert (
        resource_profiles.select_resource_profile("auto", gpu_vram_mb=12000).selected == "balanced"
    )
    assert resource_profiles.select_resource_profile("auto", gpu_vram_mb=6144).selected == "safe"
    assert resource_profiles.select_resource_profile("auto", gpu_vram_mb=4096).selected == "cpu"

    monkeypatch.setattr(resource_profiles, "detect_gpu_vram_mb", lambda: None)
    assert resource_profiles.select_resource_profile("auto").selected == "safe"


def test_deploy_runner_c2_fast_profile_sets_compose_env(monkeypatch, capsys):
    calls = []

    def fake_run(command, cwd, env=None):
        calls.append((command, cwd, env))
        return types.SimpleNamespace(returncode=0)

    monkeypatch.setattr(run_deploy_stack.subprocess, "run", fake_run)
    monkeypatch.setattr(
        run_deploy_stack.sys,
        "argv",
        [
            "run_deploy_stack.py",
            "c2",
            "--resource-profile",
            "fast",
            "--no-build",
            "--no-prewarm",
        ],
    )

    assert run_deploy_stack.main() == 0

    env = calls[0][2]
    assert env["OLLAMA_NUM_PARALLEL"] == "5"
    assert env["OLLAMA_CONTEXT_LENGTH"] == "8192"
    assert env["HUNT_BULLET_REWRITE_PARALLELISM"] == "5"
    assert env["HUNT_OLLAMA_KEEP_ALIVE"] == "-1"
    output = capsys.readouterr().out
    assert "resource_profile_requested: fast" in output
    assert "resource_profile: fast" in output


def test_deploy_runner_unknown_target_returns_error(monkeypatch, capsys):
    monkeypatch.setattr(run_deploy_stack.sys, "argv", ["run_deploy_stack.py", "bogus"])

    assert run_deploy_stack.main() == 1
    assert "Unknown deploy target" in capsys.readouterr().err


def test_server2_ansible_public_ingress_contract_if_repo_present():
    ansible_root = Path("../ansible_homelab").resolve()
    if not ansible_root.is_dir():
        pytest.skip("ansible_homelab repo not present next to hunt")

    vars_text = (ansible_root / "group_vars" / "job_agent" / "vars.yml").read_text(encoding="utf-8")
    task_text = (ansible_root / "playbooks" / "tasks" / "hunt_repo_native_deploy.yml").read_text(
        encoding="utf-8"
    )

    assert 'service: "http://{{ hunt_review_container_name }}:{{ hunt_review_port }}"' in vars_text
    assert 'service: "http://{{ hunt_frontend_container_name }}:80"' in vars_text
    assert "deploy_cloudflare_tunnel: true" in vars_text
    assert "deploy_traefik: false" in vars_text
    assert "deploy_authelia: false" in vars_text
    assert "HUNT_REVIEW_CONTAINER_NAME={{ hunt_review_container_name }}" in task_text
    assert "HUNT_FRONTEND_CONTAINER_NAME={{ hunt_frontend_container_name }}" in task_text


def test_server2_auth_mode_is_documented_as_cloudflare_access_if_repo_present():
    ansible_root = Path("../ansible_homelab").resolve()
    if not ansible_root.is_dir():
        pytest.skip("ansible_homelab repo not present next to hunt")

    vars_text = (ansible_root / "group_vars" / "job_agent" / "vars.yml").read_text(encoding="utf-8")
    readme_text = (ansible_root / "README.md").read_text(encoding="utf-8")

    assert "auth handled by Cloudflare Access" in vars_text
    assert "deploy.ps1" in readme_text


def test_server2_stage7_targets_fletcher_and_uses_chromium_if_repo_present():
    ansible_root = Path("../ansible_homelab").resolve()
    if not ansible_root.is_dir():
        pytest.skip("ansible_homelab repo not present next to hunt")

    vars_text = (ansible_root / "group_vars" / "job_agent" / "vars.yml").read_text(encoding="utf-8")
    stage6_text = (
        ansible_root / "playbooks" / "job_agent" / "stages" / "stage6_scraper.yml"
    ).read_text(encoding="utf-8")
    stage7_text = (
        ansible_root / "playbooks" / "job_agent" / "stages" / "stage7_fletcher.yml"
    ).read_text(encoding="utf-8")

    assert 'scraper_browser_channel: "chromium"' in vars_text
    assert "hunt_repo_native_deploy_target: c1" in stage6_text
    assert "hunt_repo_native_deploy_target: c2" in stage7_text


def test_component_test_runner_target_mapping(monkeypatch):
    calls = []

    def fake_run(command, cwd):
        calls.append((command, cwd))
        return types.SimpleNamespace(returncode=0)

    monkeypatch.setattr(run_component_tests.subprocess, "run", fake_run)
    monkeypatch.setattr(run_component_tests.sys, "argv", ["run_component_tests.py", "c1"])

    assert run_component_tests.main() == 0
    assert calls == [
        (
            [
                run_component_tests.sys.executable,
                "-m",
                "pytest",
                "-q",
                "tests/test_stage1.py",
                "tests/test_stage2.py",
                "tests/test_stage3.py",
                "tests/test_stage32.py",
                "tests/test_stage4.py",
                "tests/test_search_lanes.py",
                "hunter/tests",
            ],
            run_component_tests.ROOT,
        )
    ]


def test_component_test_runner_alias_mapping(monkeypatch):
    calls = []

    def fake_run(command, cwd):
        calls.append((command, cwd))
        return types.SimpleNamespace(returncode=0)

    monkeypatch.setattr(run_component_tests.subprocess, "run", fake_run)
    monkeypatch.setattr(run_component_tests.sys, "argv", ["run_component_tests.py", "hunter"])

    assert run_component_tests.main() == 0
    assert calls[0][0][3:] == [
        "-q",
        "tests/test_stage1.py",
        "tests/test_stage2.py",
        "tests/test_stage3.py",
        "tests/test_stage32.py",
        "tests/test_stage4.py",
        "tests/test_search_lanes.py",
        "hunter/tests",
    ]


def test_component_test_runner_dry_run_skips_subprocess(monkeypatch, capsys):
    def fail_run(_command, _cwd):
        raise AssertionError("subprocess.run should not be called in dry-run mode")

    monkeypatch.setattr(run_component_tests.subprocess, "run", fail_run)
    monkeypatch.setattr(
        run_component_tests.sys, "argv", ["run_component_tests.py", "c0", "--dry-run"]
    )

    assert run_component_tests.main() == 0

    output = capsys.readouterr().out
    assert "tests/test_c0_control_api.py" in output
    assert "dry-run" in output


def test_component_test_runner_supports_pytest_k(monkeypatch):
    calls = []

    def fake_run(command, cwd):
        calls.append((command, cwd))
        return types.SimpleNamespace(returncode=0)

    monkeypatch.setattr(run_component_tests.subprocess, "run", fake_run)
    monkeypatch.setattr(
        run_component_tests.sys,
        "argv",
        ["run_component_tests.py", "c2", "-k", "status or approve"],
    )

    assert run_component_tests.main() == 0
    assert calls[0][0][-2:] == ["-k", "status or approve"]


def test_component_test_runner_unknown_target_returns_error(monkeypatch, capsys):
    monkeypatch.setattr(run_component_tests.sys, "argv", ["run_component_tests.py", "bogus"])

    assert run_component_tests.main() == 1
    assert "Unknown test target" in capsys.readouterr().err


def test_repo_root_test_shortcut_exists():
    shortcut = Path("test.py")

    assert shortcut.is_file()

    shortcut_text = shortcut.read_text(encoding="utf-8")
    assert "from scripts.run_component_tests import main" in shortcut_text


def test_component_check_runner_target_mapping(monkeypatch):
    calls = []

    def fake_run(command, cwd):
        calls.append((command, cwd))
        return types.SimpleNamespace(returncode=0)

    monkeypatch.setattr(run_component_checks.subprocess, "run", fake_run)
    monkeypatch.setattr(run_component_checks.sys, "argv", ["run_component_checks.py", "c1"])

    assert run_component_checks.main() == 0
    assert calls == [
        ([run_component_checks.PYTHON, "-m", "ruff", "check", "hunter"], run_component_checks.ROOT),
        (
            [run_component_checks.PYTHON, "-m", "ruff", "format", "--check", "hunter"],
            run_component_checks.ROOT,
        ),
    ]


def test_component_check_runner_dry_run_skips_subprocess(monkeypatch, capsys):
    def fail_run(_command, _cwd):
        raise AssertionError("subprocess.run should not be called in dry-run mode")

    monkeypatch.setattr(run_component_checks.subprocess, "run", fail_run)
    monkeypatch.setattr(
        run_component_checks.sys, "argv", ["run_component_checks.py", "c0", "--dry-run"]
    )

    assert run_component_checks.main() == 0

    output = capsys.readouterr().out
    assert "frontend" in output
    assert "dry-run" in output


def test_component_check_runner_unknown_target_returns_error(monkeypatch, capsys):
    monkeypatch.setattr(run_component_checks.sys, "argv", ["run_component_checks.py", "bogus"])

    assert run_component_checks.main() == 1
    assert "Unknown check target" in capsys.readouterr().err


def test_repo_root_check_shortcut_exists():
    shortcut = Path("check.py")

    assert shortcut.is_file()

    shortcut_text = shortcut.read_text(encoding="utf-8")
    assert "from scripts.run_component_checks import main" in shortcut_text


def test_repo_root_quality_shortcut_exists():
    shortcut = Path("quality.py")

    assert shortcut.is_file()

    shortcut_text = shortcut.read_text(encoding="utf-8")
    assert "from scripts.run_component_checks import main" in shortcut_text


def test_component_ci_runner_blocks_c4(monkeypatch, capsys):
    calls = []

    def fake_run(command, cwd):
        calls.append((command, cwd))
        return types.SimpleNamespace(returncode=0)

    monkeypatch.setattr(run_component_ci.subprocess, "run", fake_run)
    monkeypatch.setattr(run_component_ci.sys, "argv", ["run_component_ci.py", "c4"])

    assert run_component_ci.main() == 2
    assert calls == []
    assert "C4 is on hold" in capsys.readouterr().err


def test_component_ci_runner_dry_run_skips_subprocess(monkeypatch, capsys):
    def fail_run(_command, _cwd):
        raise AssertionError("subprocess.run should not be called in dry-run mode")

    monkeypatch.setattr(run_component_ci.subprocess, "run", fail_run)
    monkeypatch.setattr(run_component_ci.sys, "argv", ["run_component_ci.py", "all", "--dry-run"])

    assert run_component_ci.main() == 0

    output = capsys.readouterr().out
    assert "quality.py all --dry-run" in output
    assert "test.py all --dry-run" in output


def test_repo_root_ci_shortcut_exists():
    shortcut = Path("ci.py")

    assert shortcut.is_file()

    shortcut_text = shortcut.read_text(encoding="utf-8")
    assert "from scripts.run_component_ci import main" in shortcut_text


def test_github_actions_ci_workflow_exists():
    workflow = Path(".github/workflows/ci.yml")

    assert workflow.is_file()

    workflow_text = workflow.read_text(encoding="utf-8")
    assert "actions/setup-python@a26af69be951a213d495a4c3e4e4022e16d87065" in workflow_text
    assert "actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020" in workflow_text
    assert "python ci.py" in workflow_text
    assert "hunter-cli-smoke" in workflow_text
    assert "./hunter.sh queue" in workflow_text
    assert "for launcher in hunter.sh ui.sh fletch.sh; do" in workflow_text
    assert '"./$launcher" definitely-not-a-command' in workflow_text
    assert ".\\hunter.ps1 queue" in workflow_text
    assert ".\\hunter.ps1 definitely-not-a-command" in workflow_text
    assert "hunter.cmd queue" in workflow_text
    assert "hunter.cmd definitely-not-a-command" in workflow_text
    assert "ui-cli-smoke" in workflow_text
    assert "./ui.sh --help" in workflow_text
    assert ".\\ui.ps1 --help" in workflow_text
    assert ".\\ui.ps1 definitely-not-a-command" in workflow_text
    assert "ui.cmd --help" in workflow_text
    assert "ui.cmd definitely-not-a-command" in workflow_text
    assert "fletch-cli-smoke" in workflow_text
    assert "./fletch.sh --help" in workflow_text
    assert ".\\fletch.ps1 --help" in workflow_text
    assert ".\\fletch.ps1 definitely-not-a-command" in workflow_text
    assert "fletch.cmd --help" in workflow_text
    assert "fletch.cmd definitely-not-a-command" in workflow_text


@pytest.mark.skipif(sys.platform != "win32", reason="Windows-only launcher smoke")
def test_hunter_powershell_launcher_queue_runs_standalone(tmp_path):
    result = subprocess.run(
        ["powershell", "-ExecutionPolicy", "Bypass", "-File", "hunter.ps1", "queue"],
        cwd=REPO_ROOT,
        env=_standalone_launcher_env(tmp_path),
        capture_output=True,
        text=True,
    )

    assert result.returncode == 0
    assert "Enrichment queue summary" in result.stdout


@pytest.mark.skipif(sys.platform != "win32", reason="Windows-only launcher smoke")
def test_hunter_powershell_launcher_propagates_failure_exit_code():
    result = subprocess.run(
        [
            "powershell",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            "hunter.ps1",
            "definitely-not-a-command",
        ],
        cwd=REPO_ROOT,
        capture_output=True,
        text=True,
    )

    assert result.returncode != 0
    assert "invalid choice" in result.stderr


@pytest.mark.skipif(sys.platform != "win32", reason="Windows-only launcher smoke")
def test_hunter_cmd_launcher_queue_runs_standalone(tmp_path):
    result = subprocess.run(
        ["cmd", "/c", "hunter.cmd", "queue"],
        cwd=REPO_ROOT,
        env=_standalone_launcher_env(tmp_path),
        capture_output=True,
        text=True,
    )

    assert result.returncode == 0
    assert "Enrichment queue summary" in result.stdout


@pytest.mark.skipif(sys.platform != "win32", reason="Windows-only launcher smoke")
def test_hunter_cmd_launcher_propagates_failure_exit_code():
    env = os.environ.copy()
    env["PATH"] = str(REPO_ROOT) + os.pathsep + env.get("PATH", "")
    result = subprocess.run(
        ["cmd", "/c", "hunter.cmd", "definitely-not-a-command"],
        cwd=REPO_ROOT,
        env=env,
        capture_output=True,
        text=True,
    )

    assert result.returncode != 0
    assert "invalid choice" in result.stderr


@pytest.mark.skipif(sys.platform == "win32", reason="POSIX-only launcher smoke")
def test_hunter_sh_launcher_queue_runs_standalone(tmp_path):
    bash = shutil.which("bash")
    if not bash:
        pytest.skip("bash is not installed")

    result = subprocess.run(
        [bash, "hunter.sh", "queue"],
        cwd=REPO_ROOT,
        env=_standalone_launcher_env(tmp_path),
        capture_output=True,
        text=True,
    )

    assert result.returncode == 0
    assert "Enrichment queue summary" in result.stdout


@pytest.mark.skipif(sys.platform == "win32", reason="POSIX-only launcher smoke")
def test_hunter_sh_launcher_propagates_failure_exit_code():
    bash = shutil.which("bash")
    if not bash:
        pytest.skip("bash is not installed")

    result = subprocess.run(
        [bash, "hunter.sh", "definitely-not-a-command"],
        cwd=REPO_ROOT,
        capture_output=True,
        text=True,
    )

    assert result.returncode != 0
    assert "invalid choice" in result.stderr


# ---------------------------------------------------------------------------
# C0 (UI) launcher smoke tests
# ---------------------------------------------------------------------------


@pytest.mark.skipif(sys.platform != "win32", reason="Windows-only launcher smoke")
def test_ui_powershell_launcher_help_runs_standalone():
    result = subprocess.run(
        ["powershell", "-ExecutionPolicy", "Bypass", "-File", "ui.ps1", "--help"],
        cwd=REPO_ROOT,
        capture_output=True,
        text=True,
    )

    assert result.returncode == 0
    assert "{serve,build}" in result.stdout


@pytest.mark.skipif(sys.platform != "win32", reason="Windows-only launcher smoke")
def test_ui_powershell_launcher_propagates_failure_exit_code():
    result = subprocess.run(
        ["powershell", "-ExecutionPolicy", "Bypass", "-File", "ui.ps1", "definitely-not-a-command"],
        cwd=REPO_ROOT,
        capture_output=True,
        text=True,
    )

    assert result.returncode != 0
    assert "invalid choice" in result.stderr


@pytest.mark.skipif(sys.platform != "win32", reason="Windows-only launcher smoke")
def test_ui_cmd_launcher_help_runs_standalone():
    env = os.environ.copy()
    env["PATH"] = str(REPO_ROOT) + os.pathsep + env.get("PATH", "")
    result = subprocess.run(
        ["cmd", "/c", "ui.cmd", "--help"],
        cwd=REPO_ROOT,
        env=env,
        capture_output=True,
        text=True,
    )

    assert result.returncode == 0
    assert "{serve,build}" in result.stdout


@pytest.mark.skipif(sys.platform != "win32", reason="Windows-only launcher smoke")
def test_ui_cmd_launcher_propagates_failure_exit_code():
    env = os.environ.copy()
    env["PATH"] = str(REPO_ROOT) + os.pathsep + env.get("PATH", "")
    result = subprocess.run(
        ["cmd", "/c", "ui.cmd", "definitely-not-a-command"],
        cwd=REPO_ROOT,
        env=env,
        capture_output=True,
        text=True,
    )

    assert result.returncode != 0
    assert "invalid choice" in result.stderr


@pytest.mark.skipif(sys.platform == "win32", reason="POSIX-only launcher smoke")
def test_ui_sh_launcher_help_runs_standalone():
    bash = shutil.which("bash")
    if not bash:
        pytest.skip("bash is not installed")

    result = subprocess.run(
        [bash, "ui.sh", "--help"],
        cwd=REPO_ROOT,
        capture_output=True,
        text=True,
    )

    assert result.returncode == 0
    assert "{serve,build}" in result.stdout


@pytest.mark.skipif(sys.platform == "win32", reason="POSIX-only launcher smoke")
def test_ui_sh_launcher_propagates_failure_exit_code():
    bash = shutil.which("bash")
    if not bash:
        pytest.skip("bash is not installed")

    result = subprocess.run(
        [bash, "ui.sh", "definitely-not-a-command"],
        cwd=REPO_ROOT,
        capture_output=True,
        text=True,
    )

    assert result.returncode != 0
    assert "invalid choice" in result.stderr


def test_ui_cli_docs_exist():
    doc = Path("docs/UI_CLI.md")

    assert doc.is_file()

    doc_text = doc.read_text(encoding="utf-8")
    assert ".\\ui.ps1" in doc_text
    assert "ui.cmd" in doc_text or "./ui.sh" in doc_text
    assert "serve" in doc_text
    assert "build" in doc_text


# ---------------------------------------------------------------------------
# C2 (Fletcher) launcher smoke tests
# ---------------------------------------------------------------------------


@pytest.mark.skipif(sys.platform != "win32", reason="Windows-only launcher smoke")
def test_fletch_powershell_launcher_help_runs_standalone():
    result = subprocess.run(
        ["powershell", "-ExecutionPolicy", "Bypass", "-File", "fletch.ps1", "--help"],
        cwd=REPO_ROOT,
        capture_output=True,
        text=True,
    )

    assert result.returncode == 0
    assert "init-db" in result.stdout


@pytest.mark.skipif(sys.platform != "win32", reason="Windows-only launcher smoke")
def test_fletch_powershell_launcher_propagates_failure_exit_code():
    result = subprocess.run(
        [
            "powershell",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            "fletch.ps1",
            "definitely-not-a-command",
        ],
        cwd=REPO_ROOT,
        capture_output=True,
        text=True,
    )

    assert result.returncode != 0
    assert "invalid choice" in result.stderr


@pytest.mark.skipif(sys.platform != "win32", reason="Windows-only launcher smoke")
def test_fletch_cmd_launcher_help_runs_standalone():
    env = os.environ.copy()
    env["PATH"] = str(REPO_ROOT) + os.pathsep + env.get("PATH", "")
    result = subprocess.run(
        ["cmd", "/c", "fletch.cmd", "--help"],
        cwd=REPO_ROOT,
        env=env,
        capture_output=True,
        text=True,
    )

    assert result.returncode == 0
    assert "init-db" in result.stdout


@pytest.mark.skipif(sys.platform != "win32", reason="Windows-only launcher smoke")
def test_fletch_cmd_launcher_propagates_failure_exit_code():
    env = os.environ.copy()
    env["PATH"] = str(REPO_ROOT) + os.pathsep + env.get("PATH", "")
    result = subprocess.run(
        ["cmd", "/c", "fletch.cmd", "definitely-not-a-command"],
        cwd=REPO_ROOT,
        env=env,
        capture_output=True,
        text=True,
    )

    assert result.returncode != 0
    assert "invalid choice" in result.stderr


@pytest.mark.skipif(sys.platform == "win32", reason="POSIX-only launcher smoke")
def test_fletch_sh_launcher_help_runs_standalone():
    bash = shutil.which("bash")
    if not bash:
        pytest.skip("bash is not installed")

    result = subprocess.run(
        [bash, "fletch.sh", "--help"],
        cwd=REPO_ROOT,
        capture_output=True,
        text=True,
    )

    assert result.returncode == 0
    assert "init-db" in result.stdout


@pytest.mark.skipif(sys.platform == "win32", reason="POSIX-only launcher smoke")
def test_fletch_sh_launcher_propagates_failure_exit_code():
    bash = shutil.which("bash")
    if not bash:
        pytest.skip("bash is not installed")

    result = subprocess.run(
        [bash, "fletch.sh", "definitely-not-a-command"],
        cwd=REPO_ROOT,
        capture_output=True,
        text=True,
    )

    assert result.returncode != 0
    assert "invalid choice" in result.stderr


def test_fletch_cli_docs_exist():
    doc = Path("docs/FLETCH_CLI.md")

    assert doc.is_file()

    doc_text = doc.read_text(encoding="utf-8")
    assert ".\\fletch.ps1" in doc_text
    assert "fletch.cmd" in doc_text or "./fletch.sh" in doc_text
    assert "init-db" in doc_text
    assert "job" in doc_text


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
