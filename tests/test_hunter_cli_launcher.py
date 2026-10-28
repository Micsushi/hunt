import os
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

from scripts import hunterctl


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
