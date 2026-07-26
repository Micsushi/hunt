from __future__ import annotations

import json
import sys
import threading
from pathlib import Path

import pytest

from coordinator.resume_cooker import (
    AdapterResult,
    QualityOverride,
    ResumeCookerAdapter,
    ResumeCookerConfig,
    ResumeCookerQualityGate,
    expected_exit,
    validate_report,
)


def report(command: str, status: str = "pass", checks: list[dict] | None = None) -> dict:
    return {
        "schema_version": 1,
        "command": command,
        "run_id": f"{command}-run",
        "status": status,
        "content_left_machine": False,
        "checks": checks or [],
    }


def completed(
    command: str, status: str = "pass", checks: list[dict] | None = None
) -> AdapterResult:
    value = report(command, status, checks)
    return AdapterResult("completed", value, f"{command}.json", "completed", expected_exit(value))


class QueueAdapter:
    def __init__(self, results: list[AdapterResult]) -> None:
        self.results = results
        self.calls: list[tuple[str, list[str]]] = []

    def run(self, command: str, args: list[str], *, cancel_event=None) -> AdapterResult:
        self.calls.append((command, args))
        return self.results.pop(0)


def artifacts(tmp_path: Path) -> dict:
    tex = tmp_path / "tailored.tex"
    pdf = tmp_path / "tailored.pdf"
    tex.write_text("tailored", encoding="utf-8")
    pdf.write_bytes(b"%PDF fixture")
    return {
        "status": "done",
        "tex_path": str(tex),
        "pdf_path": str(pdf),
        "selected_for_c3": True,
        "concern_flags": ["low_confidence"],
    }


def test_report_validation_fails_closed_on_schema_status_command_and_exit_mismatch():
    assert validate_report(report("check"), "check", 0) is None
    cases = [
        ({**report("check"), "schema_version": 2}, "check", 0),
        ({**report("check"), "status": "unknown"}, "check", 0),
        ({**report("compare"), "command": "check"}, "compare", 0),
        (report("check", "fail"), "check", 0),
    ]
    for value, expected_command, exit_code in cases:
        assert validate_report(value, expected_command, exit_code)


def test_adapter_runs_real_subprocess_and_requires_stdout_file_equivalence(tmp_path: Path):
    helper = tmp_path / "helper.py"
    helper.write_text(
        """
import json, pathlib, sys
command = sys.argv[1]
out = pathlib.Path(sys.argv[sys.argv.index("--out") + 1])
value = {
    "schema_version": 1,
    "command": command,
    "run_id": "real-run",
    "status": "pass",
    "content_left_machine": False,
    "checks": [],
}
out.parent.mkdir(parents=True, exist_ok=True)
out.write_text(json.dumps(value), encoding="utf-8")
print(json.dumps(value))
""",
        encoding="utf-8",
    )
    config = ResumeCookerConfig(
        enabled=True,
        command=(sys.executable, str(helper)),
        timeout_seconds=2,
        report_root=tmp_path / "reports",
    )
    result = ResumeCookerAdapter(config).run("check", ["--resume", "synthetic.tex"])
    assert result.completed
    assert result.report_id == "real-run"
    assert result.report_path and Path(result.report_path).is_file()


def test_adapter_types_missing_timeout_cancel_and_malformed(tmp_path: Path):
    missing = ResumeCookerAdapter(
        ResumeCookerConfig(
            enabled=True,
            command=(str(tmp_path / "missing.exe"),),
            report_root=tmp_path,
        )
    ).run("check", [])
    assert missing.kind == "unavailable"

    sleeper = tmp_path / "sleeper.py"
    sleeper.write_text("import time; time.sleep(5)", encoding="utf-8")
    timeout = ResumeCookerAdapter(
        ResumeCookerConfig(
            enabled=True,
            command=(sys.executable, str(sleeper)),
            timeout_seconds=0.05,
            report_root=tmp_path,
        )
    ).run("check", [])
    assert timeout.kind == "timeout"

    cancel = threading.Event()
    cancel.set()
    cancelled = ResumeCookerAdapter(
        ResumeCookerConfig(
            enabled=True,
            command=(sys.executable, str(sleeper)),
            timeout_seconds=2,
            report_root=tmp_path,
        )
    ).run("check", [], cancel_event=cancel)
    assert cancelled.kind == "cancelled"

    invalid = tmp_path / "invalid.py"
    invalid.write_text("print('not-json')", encoding="utf-8")
    malformed = ResumeCookerAdapter(
        ResumeCookerConfig(
            enabled=True,
            command=(sys.executable, str(invalid)),
            timeout_seconds=2,
            report_root=tmp_path,
        )
    ).run("check", [])
    assert malformed.kind == "malformed"

    oversized = tmp_path / "oversized.py"
    oversized.write_text("import sys; sys.stdout.write('x' * 1000001)", encoding="utf-8")
    bounded = ResumeCookerAdapter(
        ResumeCookerConfig(
            enabled=True,
            command=(sys.executable, str(oversized)),
            timeout_seconds=2,
            report_root=tmp_path,
        )
    ).run("check", [])
    assert bounded.kind == "malformed"
    assert "capture limit" in bounded.message


def test_preflight_runs_before_fletcher_and_fail_blocks_without_override(tmp_path: Path):
    source = tmp_path / "source.tex"
    source.write_text("source", encoding="utf-8")
    adapter = QueueAdapter([completed("check", "fail")])
    called = False

    def fletcher():
        nonlocal called
        called = True
        return artifacts(tmp_path)

    gate = ResumeCookerQualityGate(
        ResumeCookerConfig(enabled=True, report_root=tmp_path), adapter=adapter
    )
    result = gate.run(source_path=source, fletcher=fletcher)
    assert called is False
    assert result["status"] == "blocked_quality"
    assert result["selected_for_c3"] is False
    assert [item[0] for item in adapter.calls] == ["check"]


def test_warning_proceeds_postflight_and_namespaces_flags(tmp_path: Path):
    source = tmp_path / "source.tex"
    source.write_text("source", encoding="utf-8")
    adapter = QueueAdapter(
        [
            completed(
                "check",
                "pass_with_warnings",
                [{"id": "source_warning", "status": "warning", "metadata": {}}],
            ),
            completed(
                "compare",
                "pass_with_warnings",
                [{"id": "post_warning", "status": "warning", "metadata": {}}],
            ),
        ]
    )
    gate = ResumeCookerQualityGate(
        ResumeCookerConfig(enabled=True, report_root=tmp_path), adapter=adapter
    )
    result = gate.run(source_path=source, fletcher=lambda: artifacts(tmp_path))
    quality = result["resume_cooker_quality"]
    assert result["selected_for_c3"] is True
    assert [item[0] for item in adapter.calls] == ["check", "compare"]
    assert quality["flags"] == [
        "resume_cooker.source_warning",
        "resume_cooker.post_warning",
        "fletcher.low_confidence",
    ]
    assert quality["content_left_machine"] is False


def test_postflight_failure_blocks_c3_and_explicit_override_preserves_original(tmp_path: Path):
    source = tmp_path / "source.tex"
    source.write_text("source", encoding="utf-8")
    override = QualityOverride.create(actor="owner", reason="Synthetic fixture review")
    adapter = QueueAdapter([completed("check"), completed("compare", "fail")])
    gate = ResumeCookerQualityGate(
        ResumeCookerConfig(enabled=True, report_root=tmp_path), adapter=adapter
    )
    result = gate.run(
        source_path=source,
        fletcher=lambda: artifacts(tmp_path),
        postflight_override=override,
    )
    quality = result["resume_cooker_quality"]
    assert result["selected_for_c3"] is True
    assert quality["postflight"]["status"] == "fail"
    assert quality["postflight_override"]["actor"] == "owner"
    assert quality["postflight_override"]["reason"] == "Synthetic fixture review"
    decision_path = Path(quality["decision_path"])
    assert decision_path.is_file()
    decision = json.loads(decision_path.read_text(encoding="utf-8"))
    assert decision["decision_id"] == quality["decision_id"]
    assert decision["resume_cooker_quality"]["postflight"]["report_id"] == "compare-run"
    assert decision["resume_cooker_quality"]["postflight_override"]["actor"] == "owner"


def test_disabled_gate_is_exact_rollback_and_invokes_no_adapter(tmp_path: Path):
    adapter = QueueAdapter([])
    gate = ResumeCookerQualityGate(
        ResumeCookerConfig(enabled=False, report_root=tmp_path), adapter=adapter
    )
    expected = {"legacy": True}
    assert gate.run(source_path="unused.tex", fletcher=lambda: expected) is expected
    assert adapter.calls == []


def test_missing_fletcher_artifacts_never_becomes_ready(tmp_path: Path):
    source = tmp_path / "source.tex"
    source.write_text("source", encoding="utf-8")
    gate = ResumeCookerQualityGate(
        ResumeCookerConfig(enabled=True, report_root=tmp_path),
        adapter=QueueAdapter([completed("check")]),
    )
    result = gate.run(
        source_path=source,
        fletcher=lambda: {"status": "failed", "selected_for_c3": True},
    )
    assert result["selected_for_c3"] is False
    assert "resume_cooker.fletcher_artifacts_missing" in result["resume_cooker_quality"]["flags"]


def test_override_rejects_missing_actor_or_reason():
    with pytest.raises(ValueError):
        QualityOverride.create(actor="", reason="needed")
    with pytest.raises(ValueError):
        QualityOverride.create(actor="owner", reason="")


def test_override_cannot_convert_missing_report_into_a_pass(tmp_path: Path):
    source = tmp_path / "source.tex"
    source.write_text("source", encoding="utf-8")
    unavailable = AdapterResult(
        "unavailable",
        None,
        None,
        "Resume Cooker executable is unavailable.",
        None,
    )
    gate = ResumeCookerQualityGate(
        ResumeCookerConfig(enabled=True, report_root=tmp_path),
        adapter=QueueAdapter([unavailable]),
    )

    result = gate.run(
        source_path=source,
        fletcher=lambda: artifacts(tmp_path),
        preflight_override=QualityOverride.create(actor="owner", reason="cannot override absence"),
    )

    assert result["status"] == "blocked_quality"
    assert result["selected_for_c3"] is False
    assert result["resume_cooker_quality"]["preflight"]["report_id"] is None


def test_fletcher_pipeline_defers_c3_selection_until_quality_gate_accepts(
    tmp_path: Path, monkeypatch
):
    import fletcher.pipeline as pipeline

    source = tmp_path / "source.tex"
    source.write_text("source", encoding="utf-8")
    calls: list[tuple] = []

    class Gate:
        config = ResumeCookerConfig(enabled=True, report_root=tmp_path)

        def run(self, *, source_path, fletcher, **_kwargs):
            calls.append(("preflight", Path(source_path)))
            result = fletcher()
            assert result["quality_candidate_for_c3"] is True
            calls.append(("postflight", result["tex_path"], result["pdf_path"]))
            return {**result, "selected_for_c3": True}

    monkeypatch.setattr(pipeline, "init_resume_db", lambda _path: None)
    monkeypatch.setattr(
        pipeline,
        "get_job_context",
        lambda _job_id, _path: {
            "title": "Synthetic",
            "description": "Synthetic role",
            "company": "Example",
            "enrichment_status": "done",
            "apply_type": "external_apply",
            "apply_url": "https://example.invalid/apply",
            "priority": 0,
            "auto_apply_eligible": 1,
        },
    )

    def fake_pipeline(**kwargs):
        assert kwargs["allow_downstream_selection"] is False
        built = artifacts(tmp_path)
        return {**built, "resume_version_id": 7}

    monkeypatch.setattr(pipeline, "_run_pipeline", fake_pipeline)
    monkeypatch.setattr(
        pipeline,
        "select_resume_version_for_c3",
        lambda job_id, version_id, db_path: calls.append(("selected", job_id, version_id, db_path)),
    )

    result = pipeline.generate_resume_for_job(
        42,
        db_path=tmp_path / "hunt.db",
        resume_path=source,
        resume_cooker_gate=Gate(),
    )

    assert result["selected_for_c3"] is True
    assert "quality_candidate_for_c3" not in result
    assert [call[0] for call in calls] == ["preflight", "postflight", "selected"]
    assert calls[-1][1:3] == (42, 7)
