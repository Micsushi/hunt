import json
from pathlib import Path

import pytest

from backend.c3_artifacts import C3ArtifactStore

MAX_ARTIFACT_FILE_BYTES = 1_000_000
MAX_JSON_SECTION_BYTES = 256_000


def test_failure_bundle_is_redacted_hashed_and_linked(tmp_path: Path):
    store = C3ArtifactStore(tmp_path)

    result = store.capture_failure_bundle(
        session_id="session-1",
        operation_id="op-1",
        reason_code="operation_stalled",
        screenshot=b"fake-png",
        diagnostics={
            "dom": '<input value="candidate@example.com"><div>303-555-1212</div>',
            "fields": [
                {
                    "label": "Street address",
                    "street_address": "123 Main Street",
                    "password": "secret",
                }
            ],
            "validation": [{"text": "Email candidate@example.com is invalid"}],
            "page": {
                "snapshot": {
                    "href": "https://example.test/job/123",
                    "title": "Example role",
                    "workflow": {
                        "pageKind": "apply_entry",
                        "phase": "apply_entry",
                        "buttons": [{"label": "Apply Manually"}],
                    },
                }
            },
            "progress": {"phase": "field_action", "token": "secret-token"},
            "console": ["failed for candidate@example.com"],
            "network": [{"url": "https://example.test", "authorization": "Bearer x"}],
            "health": {"reachable": True},
            "events": [{"seq": index, "message": f"event {index}"} for index in range(1_100)],
            "checkpoints": [{"field": "source", "status": "failed"}],
        },
    )

    assert result["artifact_id"].startswith("artifact_")
    manifest_path = Path(result["manifest_path"])
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    assert manifest["operation_id"] == "op-1"
    assert manifest["reason_code"] == "operation_stalled"
    assert manifest["redaction"]["applied"] is True
    assert manifest["files"]
    assert all(len(entry["sha256"]) == 64 for entry in manifest["files"])
    retained_events = json.loads((manifest_path.parent / "events.json").read_text())
    assert len(retained_events) == 16
    assert retained_events[-1]["seq"] == 1_099
    page = json.loads((manifest_path.parent / "page.json").read_text())
    assert page["snapshot"]["workflow"]["pageKind"] == "apply_entry"
    assert page["snapshot"]["workflow"]["buttons"][0]["label"] == "Apply Manually"
    all_text = "\n".join(
        path.read_text(encoding="utf-8", errors="ignore")
        for path in manifest_path.parent.iterdir()
        if path.suffix in {".json", ".html"}
    )
    assert "candidate@example.com" not in all_text
    assert "303-555-1212" not in all_text
    assert "123 Main Street" not in all_text
    assert "secret-token" not in all_text
    assert "Bearer x" not in all_text
    assert not (manifest_path.parent / "screenshot.png").exists()
    validated = store.validate_failure_bundle(
        session_id="session-1",
        operation_id="op-1",
        artifact_id=result["artifact_id"],
        operation_directory=manifest_path.parents[2],
    )
    assert validated["artifact_id"] == result["artifact_id"]


def test_failure_bundle_validation_rejects_tampered_file(tmp_path: Path):
    store = C3ArtifactStore(tmp_path)
    result = store.capture_failure_bundle(
        session_id="session-1",
        operation_id="op-1",
        reason_code="failed",
        diagnostics={},
    )
    manifest_path = Path(result["manifest_path"])
    (manifest_path.parent / "fields.json").write_text("tampered", encoding="utf-8")

    with pytest.raises(ValueError, match="artifact_file_(size|hash)_mismatch"):
        store.validate_failure_bundle(
            session_id="session-1",
            operation_id="op-1",
            artifact_id=result["artifact_id"],
            operation_directory=manifest_path.parents[2],
        )


def test_failure_bundle_validation_rejects_manifest_with_empty_file_set(tmp_path: Path):
    store = C3ArtifactStore(tmp_path)
    result = store.capture_failure_bundle(
        session_id="session-1",
        operation_id="op-1",
        reason_code="failed",
        diagnostics={},
    )
    manifest_path = Path(result["manifest_path"])
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    manifest["files"] = []
    manifest_path.write_text(json.dumps(manifest), encoding="utf-8")

    with pytest.raises(ValueError, match="artifact_manifest_files_invalid"):
        store.validate_failure_bundle(
            session_id="session-1",
            operation_id="op-1",
            artifact_id=result["artifact_id"],
            operation_directory=manifest_path.parents[2],
        )


def test_failure_bundle_redacts_contextual_values_urls_and_dom_text(tmp_path: Path):
    store = C3ArtifactStore(tmp_path)

    result = store.capture_failure_bundle(
        session_id="session-1",
        operation_id="op-1",
        reason_code="failed",
        screenshot=b"raw-private-screen",
        diagnostics={
            "dom": (
                '<main><label>First name</label><div class="selected-value">'
                "UniqueCandidate-7Q9</div><textarea>123 Main Street</textarea>"
                '<input value="hunter2"></main>'
            ),
            "fields": [
                {"label": "Street address", "value": "123 Main Street"},
                {"type": "password", "value": "hunter2"},
                {"label": "First name", "value": "UniqueCandidate-7Q9"},
                {"label": "Current company", "answer": "UniqueEmployer-7Q9"},
            ],
            "events": [{"payload": {"proof": {"before": {"text": "UniqueCandidate-7Q9"}}}}],
            "network": [{"url": "https://example.test/apply?access_token=secret#candidate"}],
        },
    )

    directory = Path(result["manifest_path"]).parent
    all_bytes = b"\n".join(path.read_bytes() for path in directory.iterdir())
    assert b"123 Main Street" not in all_bytes
    assert b"hunter2" not in all_bytes
    assert b"access_token" not in all_bytes
    assert b"raw-private-screen" not in all_bytes
    assert b"UniqueCandidate-7Q9" not in all_bytes
    assert b"UniqueEmployer-7Q9" not in all_bytes
    assert b"First name" in all_bytes
    assert b"Current company" in all_bytes


def test_failure_bundle_uses_authoritative_operation_directory(tmp_path: Path):
    operation_directory = (
        tmp_path / "c3" / "sessions" / "2020-01-01" / "session-1" / "operations" / "op-1"
    )
    operation_directory.mkdir(parents=True)

    result = C3ArtifactStore(tmp_path).capture_failure_bundle(
        session_id="session-1",
        operation_id="op-1",
        reason_code="failed",
        diagnostics={},
        operation_directory=operation_directory,
    )

    assert Path(result["manifest_path"]).is_relative_to(operation_directory / "artifacts")


def test_artifact_lookup_rejects_path_traversal(tmp_path: Path):
    store = C3ArtifactStore(tmp_path)

    with pytest.raises(ValueError, match="unsafe_artifact_identity"):
        store.capture_failure_bundle(
            session_id="../escape",
            operation_id="op-1",
            reason_code="failed",
            diagnostics={},
        )


def test_failure_bundle_dom_uses_shared_structural_sanitizer(tmp_path: Path):
    secret = "UniqueCandidate-7Q9"
    result = C3ArtifactStore(tmp_path).capture_failure_bundle(
        session_id="session-1",
        operation_id="op-1",
        reason_code="failed",
        diagnostics={
            "dom": (
                '<main data-answer="UniqueCandidate-7Q9" aria-description="123 Main Street">'
                '<label aria-label="UniqueCandidate-7Q9">Country</label>'
                '<a href="/apply?answer=UniqueCandidate-7Q9#private">Apply</a>'
                '<div role="combobox">UniqueCandidate-7Q9</div></main>'
            )
        },
    )

    dom = (Path(result["manifest_path"]).parent / "dom.html").read_text(encoding="utf-8")
    assert secret not in dom
    assert "123 Main Street" not in dom
    assert "data-answer" not in dom
    assert "aria-description" not in dom
    assert 'href="/apply"' in dom
    assert "Country" in dom


def test_failure_bundle_capture_bounds_oversized_sections(tmp_path: Path):
    result = C3ArtifactStore(tmp_path).capture_failure_bundle(
        session_id="session-1",
        operation_id="op-1",
        reason_code="failed",
        diagnostics={"fields": [{"label": "L" * (MAX_JSON_SECTION_BYTES * 2)}]},
    )

    directory = Path(result["manifest_path"]).parent
    assert (directory / "fields.json").stat().st_size <= MAX_JSON_SECTION_BYTES
    assert all(path.stat().st_size <= MAX_ARTIFACT_FILE_BYTES for path in directory.iterdir())


def test_failure_bundle_event_tail_preserves_terminal_failure_after_noisy_progress(
    tmp_path: Path,
):
    progress_events = [
        {
            "seq": index,
            "event_type": "operation.progress",
            "payload": {
                "substep": f"attempt-{index}",
                "samples": [{"state": "loading", "attempt": sample} for sample in range(40)],
            },
        }
        for index in range(1, 70)
    ]
    terminal = {
        "seq": 70,
        "event_type": "operation.failed",
        "payload": {
            "terminal_reason": "extension_command_failed",
            "error": {
                "bridge_reason_code": "auth_surface_loading",
                "failure_evidence": {
                    "stopped_reason": "auth_surface_loading",
                    "action_receipt": {"attempted": False, "clicked": False},
                },
            },
        },
    }

    result = C3ArtifactStore(tmp_path).capture_failure_bundle(
        session_id="session-1",
        operation_id="op-1",
        reason_code="operation_failed",
        diagnostics={"events": [*progress_events, terminal]},
    )

    events = json.loads(
        (Path(result["manifest_path"]).parent / "events.json").read_text(encoding="utf-8")
    )
    assert events[-1]["seq"] == 70
    assert events[-1]["event_type"] == "operation.failed"
    assert events[-1]["payload"]["error"]["bridge_reason_code"] == ("auth_surface_loading")
    assert events[-1]["payload"]["error"]["failure_evidence"]["action_receipt"] == {
        "attempted": False,
        "clicked": False,
    }


def test_failure_bundle_preserves_value_free_nested_auth_boundary_samples(
    tmp_path: Path,
):
    terminal = {
        "seq": 80,
        "event_type": "operation.failed",
        "payload": {
            "error": {
                "failure_evidence": {
                    "auth_action_boundary": {
                        "stage": "preflight_blocked",
                        "stabilization": {
                            "reason": "auth_surface_loading",
                            "sample_count": 1,
                            "samples": [
                                {
                                    "sampled_at": "2026-07-26T22:07:04.006Z",
                                    "password_count": 0,
                                    "password_populated": False,
                                    "password": "must-not-survive",
                                }
                            ],
                        },
                        "credential_completeness": {
                            "password_visible": False,
                            "password_populated": False,
                        },
                    }
                }
            }
        },
    }

    result = C3ArtifactStore(tmp_path).capture_failure_bundle(
        session_id="session-1",
        operation_id="op-1",
        reason_code="operation_failed",
        diagnostics={"events": [terminal]},
    )

    events = json.loads(
        (Path(result["manifest_path"]).parent / "events.json").read_text(encoding="utf-8")
    )
    boundary = events[0]["payload"]["error"]["failure_evidence"]["auth_action_boundary"]
    sample = boundary["stabilization"]["samples"][0]
    assert sample["sampled_at"] == "2026-07-26T22:07:04.006Z"
    assert sample["password_count"] == 0
    assert sample["password_populated"] is False
    assert sample["password"] == "[REDACTED]"
    assert boundary["credential_completeness"]["password_visible"] is False


def test_failure_bundle_validation_rejects_manifest_symlink_outside_root(tmp_path: Path):
    store = C3ArtifactStore(tmp_path)
    result = store.capture_failure_bundle(
        session_id="session-1", operation_id="op-1", reason_code="failed", diagnostics={}
    )
    manifest_path = Path(result["manifest_path"])
    outside = tmp_path / "outside-manifest.json"
    outside.write_text(manifest_path.read_text(encoding="utf-8"), encoding="utf-8")
    manifest_path.unlink()
    try:
        manifest_path.symlink_to(outside)
    except OSError:
        pytest.skip("file symlinks are unavailable on this platform")

    with pytest.raises(ValueError, match="unsafe_artifact_path"):
        store.validate_failure_bundle(
            session_id="session-1",
            operation_id="op-1",
            artifact_id=result["artifact_id"],
            operation_directory=manifest_path.parents[2],
        )


def test_failure_bundle_validation_streams_files(monkeypatch, tmp_path: Path):
    store = C3ArtifactStore(tmp_path)
    result = store.capture_failure_bundle(
        session_id="session-1", operation_id="op-1", reason_code="failed", diagnostics={}
    )

    monkeypatch.setattr(
        Path,
        "read_bytes",
        lambda self: (_ for _ in ()).throw(AssertionError(f"unbounded read: {self}")),
    )
    validated = store.validate_failure_bundle(
        session_id="session-1",
        operation_id="op-1",
        artifact_id=result["artifact_id"],
        operation_directory=Path(result["manifest_path"]).parents[2],
    )

    assert validated["artifact_id"] == result["artifact_id"]


def test_failure_bundle_validation_rejects_oversized_file_before_hashing(tmp_path: Path):
    store = C3ArtifactStore(tmp_path)
    result = store.capture_failure_bundle(
        session_id="session-1", operation_id="op-1", reason_code="failed", diagnostics={}
    )
    directory = Path(result["manifest_path"]).parent
    path = directory / "fields.json"
    path.write_bytes(b"x" * (MAX_ARTIFACT_FILE_BYTES + 1))

    with pytest.raises(ValueError, match="artifact_file_too_large"):
        store.validate_failure_bundle(
            session_id="session-1",
            operation_id="op-1",
            artifact_id=result["artifact_id"],
            operation_directory=Path(result["manifest_path"]).parents[2],
        )
