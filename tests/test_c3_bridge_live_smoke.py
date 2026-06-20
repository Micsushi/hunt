from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))

import smoke_c3_bridge_live as smoke  # noqa: E402


def test_find_command_receipt_accepts_nested_backend_response() -> None:
    receipt = smoke.find_command_receipt(
        {
            "status": "ok",
            "response": {
                "commandReceipt": {
                    "commandId": "cmd-1",
                    "traceId": "trace-1",
                    "command": "c3.inspect_fields",
                }
            },
        }
    )

    assert receipt == {
        "commandId": "cmd-1",
        "traceId": "trace-1",
        "command": "c3.inspect_fields",
    }


def test_verify_accessible_jsonl_paths_requires_all_three_logs(tmp_path: Path) -> None:
    paths = {}
    for name in ("agent_log_path", "lane_log_path", "session_log_path"):
        path = tmp_path / f"{name}.jsonl"
        path.write_text(json.dumps({"command_id": "cmd-1"}) + "\n", encoding="utf-8")
        paths[name] = str(path)

    smoke.verify_accessible_jsonl_paths(paths, "cmd-1")


def test_verify_accessible_jsonl_paths_reports_container_mount_gap(tmp_path: Path) -> None:
    existing = tmp_path / "agent.jsonl"
    existing.write_text(json.dumps({"command_id": "cmd-1"}) + "\n", encoding="utf-8")

    with pytest.raises(smoke.SmokeFailure, match="not accessible"):
        smoke.verify_accessible_jsonl_paths(
            {
                "agent_log_path": str(existing),
                "lane_log_path": "/hunt-ledger/c3/lanes/lane/lane.jsonl",
                "session_log_path": str(existing),
            },
            "cmd-1",
        )


def test_verify_accessible_jsonl_paths_maps_container_root(tmp_path: Path) -> None:
    host_root = tmp_path / "hunt-logs"
    log_dir = host_root / "c3" / "sessions" / "session"
    log_dir.mkdir(parents=True)
    log_path = log_dir / "session.jsonl"
    log_path.write_text(json.dumps({"command_id": "cmd-1"}) + "\n", encoding="utf-8")

    smoke.verify_accessible_jsonl_paths(
        {
            "agent_log_path": str(log_path),
            "lane_log_path": str(log_path),
            "session_log_path": "/hunt-ledger/c3/sessions/session/session.jsonl",
        },
        "cmd-1",
        str(host_root),
    )


def test_verify_log_events_requires_command_lifecycle() -> None:
    with pytest.raises(smoke.SmokeFailure, match="missing command lifecycle"):
        smoke.verify_log_events(
            {
                "found": True,
                "events": [
                    {"event_type": "command.requested", "command_id": "cmd-1"},
                    {"event_type": "command.started", "command_id": "cmd-1"},
                ],
            },
            "cmd-1",
        )
