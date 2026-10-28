import os
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

from scripts import hunterctl


def test_separated_release_refuses_build_and_missing_assets_without_writes(
    tmp_path, monkeypatch, capsys
):
    monkeypatch.setenv("HUNT_STATE_ROOT", str(tmp_path))
    monkeypatch.setenv("HUNT_FRONTEND_DIST", str(tmp_path / "missing-dist"))
    monkeypatch.setattr(hunterctl, "_resolve_npm", lambda: pytest.fail("must not resolve npm"))
    monkeypatch.setattr(hunterctl, "_run", lambda *a, **k: pytest.fail("must not start server"))
    for command in (hunterctl.cmd_ui_build, hunterctl.cmd_build_ui):
        with pytest.raises(SystemExit) as result:
            command(None)
        assert result.value.code == 1
    assert "source checkout" in capsys.readouterr().out
    for command in (hunterctl.cmd_ui_serve, hunterctl.cmd_review):
        with pytest.raises(SystemExit, match="Qualified frontend assets are missing"):
            command(None)
    assert not list(tmp_path.iterdir())


def test_separated_release_serves_prebuilt_assets_without_build(tmp_path, monkeypatch):
    monkeypatch.setenv("HUNT_STATE_ROOT", str(tmp_path))
    assets = tmp_path / "sealed-assets"
    assets.mkdir()
    (assets / "index.html").write_text("prebuilt")
    monkeypatch.setenv("HUNT_FRONTEND_DIST", str(assets))
    monkeypatch.setattr(hunterctl, "_run_npm_build", lambda: pytest.fail("must not build"))
    monkeypatch.setattr(hunterctl, "_select_review_app_port", lambda **k: (8004, False))
    calls = []
    monkeypatch.setattr(hunterctl, "_run", lambda command, **kwargs: calls.append(command))
    hunterctl.cmd_ui_serve(None)
    assert calls == [[hunterctl.PYTHON, "-m", "backend.app"]]
    assert (assets / "index.html").read_text() == "prebuilt"


def test_normal_checkout_frontend_build_keeps_existing_commands(tmp_path, monkeypatch):
    from types import SimpleNamespace

    monkeypatch.delenv("HUNT_STATE_ROOT", raising=False)
    monkeypatch.setattr(hunterctl, "_frontend_dir", lambda: str(tmp_path))
    monkeypatch.setattr(hunterctl, "_resolve_npm", lambda: "fixture-npm")
    calls = []

    def run(command, **kwargs):
        calls.append((command, kwargs))
        return SimpleNamespace(returncode=0)

    monkeypatch.setattr(hunterctl.subprocess, "run", run)
    assert hunterctl._run_npm_build()
    assert calls == [
        (["fixture-npm", "install"], {"cwd": str(tmp_path)}),
        (["fixture-npm", "run", "build"], {"cwd": str(tmp_path)}),
    ]


def test_separate_state_root_keeps_child_code_and_relative_state(tmp_path, monkeypatch, capfd):
    code = tmp_path / "release"
    state = tmp_path / "state"
    (code / "scripts").mkdir(parents=True)
    state.mkdir()
    (state / "saved.txt").write_text("original state")
    (code / "scripts/probe.py").write_text(
        "from pathlib import Path\nprint(Path('saved.txt').read_text())\n"
    )
    monkeypatch.setattr(hunterctl, "REPO_ROOT", code)
    monkeypatch.setenv("HUNT_STATE_ROOT", str(state))
    with pytest.raises(SystemExit) as result:
        hunterctl._run([sys.executable, "scripts/probe.py"])
    assert result.value.code == 0
    assert "original state" in capfd.readouterr().out
    assert hunterctl.build_parser().parse_args(["auth-save"]).storage_state == str(
        state / ".state/linkedin_auth_state.json"
    )
    (code / "probe_module.py").write_text("print('pinned module')\n")
    (state / "probe_module.py").write_text("raise AssertionError('old state-root code')\n")
    with pytest.raises(SystemExit) as result:
        hunterctl._run([sys.executable, "-m", "probe_module"])
    assert result.value.code == 0
    assert "pinned module" in capfd.readouterr().out


@pytest.mark.parametrize("value", ["", "relative", "missing"])
def test_separate_state_root_rejects_invalid_root(tmp_path, monkeypatch, value):
    from shared.paths import get_state_root

    monkeypatch.setenv(
        "HUNT_STATE_ROOT", str(tmp_path / "missing") if value == "missing" else value
    )
    with pytest.raises(ValueError, match="existing absolute directory"):
        get_state_root()


def test_script_child_can_import_repo_package_and_inherited_modules(tmp_path, monkeypatch, capfd):
    (tmp_path / "hunter").mkdir()
    (tmp_path / "hunter/__init__.py").write_text("marker = 'repo package'\n")
    (tmp_path / "scripts").mkdir()
    inherited = tmp_path / "inherited"
    inherited.mkdir()
    (inherited / "fixture_dependency.py").write_text("value = 'inherited module'\n")
    (tmp_path / "scripts/probe.py").write_text(
        "from hunter import marker\nfrom fixture_dependency import value\nprint(marker, value)\n"
    )
    monkeypatch.setattr(hunterctl, "REPO_ROOT", tmp_path)
    monkeypatch.setenv("PYTHONPATH", str(inherited))
    with pytest.raises(SystemExit) as result:
        hunterctl._run([sys.executable, "scripts/probe.py"])
    assert result.value.code == 0
    assert "repo package inherited module" in capfd.readouterr().out
    assert os.environ["PYTHONPATH"] == str(inherited)


@pytest.mark.skipif(sys.platform != "win32", reason="Windows PowerShell launchers")
def test_hunt_alias_preserves_failed_child_exit(tmp_path):
    root = Path(__file__).resolve().parents[1]
    for relative in ("hunt.ps1", "scripts/launchers/hunt.ps1", "scripts/launchers/hunter.ps1"):
        target = tmp_path / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(root / relative, target)
    (tmp_path / "python.cmd").write_text("@echo off\nexit /b 7\n")
    env = {**os.environ, "PATH": str(tmp_path) + os.pathsep + os.environ["PATH"]}
    result = subprocess.run(
        ["powershell.exe", "-NoProfile", "-File", str(tmp_path / "hunt.ps1"), "auth-check"],
        env=env,
        capture_output=True,
        text=True,
        timeout=20,
    )
    assert result.returncode == 7, result.stdout + result.stderr
