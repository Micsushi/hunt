import json
import subprocess
import sys
import uuid
from pathlib import Path

from backend.ledger.jsonl_store import JsonlLedger
from backend.ledger.verify import verify_jsonl_hash_chain

REPO = Path(__file__).resolve().parents[1]


def _case_dir(name: str) -> Path:
    path = REPO / ".state" / "test-ledger-verify" / f"{name}-{uuid.uuid4().hex}"
    path.mkdir(parents=True, exist_ok=False)
    return path


def _rows(path: Path) -> list[dict]:
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line]


def test_verify_jsonl_hash_chain_accepts_valid_log():
    log_path = _case_dir("valid") / "agents" / "agent.jsonl"
    store = JsonlLedger()
    first = store.append(log_path, {"event_type": "command.started", "payload": {"step": 1}})
    store.append(log_path, {"event_type": "command.completed", "payload": {"step": 2}})

    result = verify_jsonl_hash_chain(log_path)

    assert result.ok is True
    assert result.checked_lines == 2
    assert result.last_hash != first["hash"]
    assert result.error is None


def test_verify_jsonl_hash_chain_reports_first_tampered_line():
    log_path = _case_dir("tampered") / "sessions" / "session.jsonl"
    store = JsonlLedger()
    store.append(log_path, {"event_type": "command.started", "payload": {"step": 1}})
    store.append(log_path, {"event_type": "command.completed", "payload": {"step": 2}})

    rows = _rows(log_path)
    rows[1]["payload"]["step"] = 99
    log_path.write_text(
        "".join(f"{json.dumps(row, sort_keys=True, separators=(',', ':'))}\n" for row in rows),
        encoding="utf-8",
    )

    result = verify_jsonl_hash_chain(log_path)

    assert result.ok is False
    assert result.checked_lines == 2
    assert result.error is not None
    assert result.error.line_number == 2
    assert result.error.reason == "hash mismatch"
    assert result.error.expected != result.error.actual


def test_verify_ledger_hash_chain_cli_returns_nonzero_for_tampered_log():
    log_path = _case_dir("cli-tampered") / "lanes" / "lane.jsonl"
    store = JsonlLedger()
    store.append(log_path, {"event_type": "command.started", "payload": {"step": 1}})

    rows = _rows(log_path)
    rows[0]["payload"]["step"] = 99
    log_path.write_text(
        "".join(f"{json.dumps(row, sort_keys=True, separators=(',', ':'))}\n" for row in rows),
        encoding="utf-8",
    )

    proc = subprocess.run(
        [sys.executable, str(REPO / "scripts" / "verify_ledger_hash_chain.py"), str(log_path)],
        cwd=REPO,
        text=True,
        capture_output=True,
        check=False,
    )

    assert proc.returncode == 1
    assert "FAILED" in proc.stdout
    assert "line 1" in proc.stdout
    assert "hash mismatch" in proc.stdout
