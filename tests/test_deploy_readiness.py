"""Deploy readiness checks for Postgres migration/runtime dependencies."""

from __future__ import annotations

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
    run_component_checks,
    run_component_ci,
    run_component_tests,
    run_deploy_stack,
    run_local_smoke,
)


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


def test_one_command_local_smoke_runner_exists(monkeypatch):
    runner = Path("scripts/run_local_smoke.py")

    assert runner.is_file()

    runner_text = runner.read_text(encoding="utf-8")
    assert "SMOKE_TARGETS" in runner_text
    assert "smoke_pipeline_compose.sh" in runner_text
    assert "smoke_hunter_container.sh" in runner_text
    assert "smoke_fletcher_container.sh" in runner_text
    assert "smoke_c0_pipeline_container.sh" in runner_text
    assert "smoke_coordinator_e2e.sh" in runner_text
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
        ["bash", "scripts/smoke_coordinator_e2e.sh"],
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


def test_server2_deploy_wrapper_exists():
    script = Path("scripts/deploy_server2.ps1")

    assert script.is_file()

    script_text = script.read_text(encoding="utf-8")
    assert "ansible_homelab" in script_text
    assert 'Target = "job_agent"' in script_text
    assert "$PrintOnly" in script_text
    assert "-Stages" in script_text
    assert "@DeployParams" in script_text


def test_server2_deploy_runbook_exists():
    runbook = Path("docs/SERVER2_DEPLOY.md")

    assert runbook.is_file()

    runbook_text = runbook.read_text(encoding="utf-8")
    assert "scripts/deploy_server2.ps1" in runbook_text
    assert "server2" in runbook_text
    assert "ansible_homelab" in runbook_text


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


def test_pipeline_compose_server_profile_includes_scheduler_dependencies():
    compose_text = Path("docker-compose.pipeline.yml").read_text(encoding="utf-8")

    assert 'profiles: ["pipeline", "db", "c0", "c1", "c2", "c1c2", "all", "server"]' in compose_text
    assert 'profiles: ["server"]' in compose_text


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

    def fake_run(command, cwd):
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

    def fake_run(command, cwd):
        calls.append((command, cwd))
        return types.SimpleNamespace(returncode=0)

    monkeypatch.setattr(run_deploy_stack.subprocess, "run", fake_run)
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
                "fletcher",
                "coordinator",
            ],
            run_deploy_stack.ROOT,
        )
    ]


def test_deploy_runner_stop_mapping(monkeypatch):
    calls = []

    def fake_run(command, cwd):
        calls.append((command, cwd))
        return types.SimpleNamespace(returncode=0)

    monkeypatch.setattr(run_deploy_stack.subprocess, "run", fake_run)
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
    def fail_run(_command, _cwd):
        raise AssertionError("subprocess.run should not be called in dry-run mode")

    monkeypatch.setattr(run_deploy_stack.subprocess, "run", fail_run)
    monkeypatch.setattr(run_deploy_stack.sys, "argv", ["run_deploy_stack.py", "all", "--dry-run"])

    assert run_deploy_stack.main() == 0

    output = capsys.readouterr().out
    assert "docker compose" in output
    assert "coordinator" in output


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
        ["run_component_tests.py", "c4", "-k", "status or approve"],
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


def test_component_ci_runner_target_mapping(monkeypatch):
    calls = []

    def fake_run(command, cwd):
        calls.append((command, cwd))
        return types.SimpleNamespace(returncode=0)

    monkeypatch.setattr(run_component_ci.subprocess, "run", fake_run)
    monkeypatch.setattr(run_component_ci.sys, "argv", ["run_component_ci.py", "c4"])

    assert run_component_ci.main() == 0
    assert calls == [
        ([run_component_ci.PYTHON, "quality.py", "c4"], run_component_ci.ROOT),
        ([run_component_ci.PYTHON, "test.py", "c4"], run_component_ci.ROOT),
    ]


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
    assert "actions/setup-python@v5" in workflow_text
    assert "actions/setup-node@v4" in workflow_text
    assert "python ci.py" in workflow_text


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
