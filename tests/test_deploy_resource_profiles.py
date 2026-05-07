from __future__ import annotations

import types

from scripts import resource_profiles, run_deploy_stack


def test_resource_profile_auto_thresholds(monkeypatch):
    assert resource_profiles.select_resource_profile("auto", gpu_vram_mb=16311).selected == "fast"
    assert (
        resource_profiles.select_resource_profile("auto", gpu_vram_mb=12000).selected == "balanced"
    )
    assert resource_profiles.select_resource_profile("auto", gpu_vram_mb=6144).selected == "safe"
    assert resource_profiles.select_resource_profile("auto", gpu_vram_mb=4096).selected == "cpu"

    monkeypatch.setattr(resource_profiles, "detect_gpu_vram_mb", lambda: None)
    assert resource_profiles.select_resource_profile("auto").selected == "safe"


def test_resource_profile_fast_env():
    selection = resource_profiles.select_resource_profile("fast")

    assert selection.env["OLLAMA_NUM_PARALLEL"] == "5"
    assert selection.env["OLLAMA_CONTEXT_LENGTH"] == "8192"
    assert selection.env["HUNT_BULLET_REWRITE_PARALLELISM"] == "5"
    assert selection.env["HUNT_OLLAMA_KEEP_ALIVE"] == "-1"


def test_resource_profile_safe_env():
    selection = resource_profiles.select_resource_profile("safe")

    assert selection.env["OLLAMA_NUM_PARALLEL"] == "1"
    assert selection.env["OLLAMA_CONTEXT_LENGTH"] == "4096"
    assert selection.env["HUNT_BULLET_REWRITE_PARALLELISM"] == "1"
    assert selection.env["HUNT_OLLAMA_KEEP_ALIVE"] == "30m"


def test_deploy_runner_c2_fast_profile_sets_compose_env(monkeypatch, capsys):
    calls = []
    prewarm_calls = []

    def fake_run(command, cwd, env=None):
        calls.append((command, cwd, env))
        return types.SimpleNamespace(returncode=0)

    monkeypatch.setattr(run_deploy_stack.subprocess, "run", fake_run)
    monkeypatch.setattr(
        run_deploy_stack,
        "_prewarm_ollama",
        lambda env: prewarm_calls.append(env) or True,
    )
    monkeypatch.setattr(
        run_deploy_stack.sys,
        "argv",
        ["run_deploy_stack.py", "c2", "--resource-profile", "fast", "--no-build"],
    )

    assert run_deploy_stack.main() == 0

    env = calls[0][2]
    assert env["OLLAMA_NUM_PARALLEL"] == "5"
    assert env["OLLAMA_CONTEXT_LENGTH"] == "8192"
    assert env["HUNT_BULLET_REWRITE_PARALLELISM"] == "5"
    assert env["HUNT_OLLAMA_KEEP_ALIVE"] == "-1"
    assert prewarm_calls == [env]
    output = capsys.readouterr().out
    assert "resource_profile_requested: fast" in output
    assert "resource_profile: fast" in output


def test_deploy_runner_c1_skips_resource_profile(monkeypatch, capsys):
    calls = []

    def fake_run(command, cwd, env=None):
        calls.append((command, cwd, env))
        return types.SimpleNamespace(returncode=0)

    def fail_select(_requested):
        raise AssertionError("C1 deploy should not select an Ollama resource profile")

    monkeypatch.setattr(run_deploy_stack.subprocess, "run", fake_run)
    monkeypatch.setattr(run_deploy_stack, "select_resource_profile", fail_select)
    monkeypatch.setattr(run_deploy_stack.sys, "argv", ["run_deploy_stack.py", "c1"])

    assert run_deploy_stack.main() == 0
    assert calls[0][2] is None
    assert "resource_profile: not_applicable" in capsys.readouterr().out


def test_deploy_runner_no_prewarm_skips_ollama_prewarm(monkeypatch, capsys):
    calls = []

    def fake_run(command, cwd, env=None):
        calls.append((command, cwd, env))
        return types.SimpleNamespace(returncode=0)

    def fail_prewarm(_env):
        raise AssertionError("prewarm should be skipped")

    monkeypatch.setattr(run_deploy_stack.subprocess, "run", fake_run)
    monkeypatch.setattr(run_deploy_stack, "_prewarm_ollama", fail_prewarm)
    monkeypatch.setattr(
        run_deploy_stack.sys,
        "argv",
        ["run_deploy_stack.py", "c2", "--resource-profile", "fast", "--no-prewarm"],
    )

    assert run_deploy_stack.main() == 0
    assert calls[0][2]["HUNT_OLLAMA_KEEP_ALIVE"] == "-1"
    assert "prewarm_ollama: skipped" in capsys.readouterr().out


def test_deploy_runner_safe_profile_skips_prewarm(monkeypatch, capsys):
    calls = []

    def fake_run(command, cwd, env=None):
        calls.append((command, cwd, env))
        return types.SimpleNamespace(returncode=0)

    def fail_prewarm(_env):
        raise AssertionError("safe profile uses 30m keep-alive and should not prewarm")

    monkeypatch.setattr(run_deploy_stack.subprocess, "run", fake_run)
    monkeypatch.setattr(run_deploy_stack, "_prewarm_ollama", fail_prewarm)
    monkeypatch.setattr(
        run_deploy_stack.sys,
        "argv",
        ["run_deploy_stack.py", "c2", "--resource-profile", "safe"],
    )

    assert run_deploy_stack.main() == 0
    assert calls[0][2]["HUNT_OLLAMA_KEEP_ALIVE"] == "30m"
    assert "prewarm_ollama: skipped" in capsys.readouterr().out


def test_ollama_keep_alive_payload_for_prewarm():
    assert run_deploy_stack._ollama_keep_alive_payload("-1") == -1
    assert run_deploy_stack._ollama_keep_alive_payload("30m") == "30m"
