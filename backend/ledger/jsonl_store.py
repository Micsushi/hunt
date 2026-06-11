from __future__ import annotations

import json
import threading
import uuid
from datetime import UTC, datetime
from hashlib import sha256
from pathlib import Path
from typing import Any

from backend.ledger.redaction import redact_event

_LOCKS: dict[Path, threading.Lock] = {}
_LOCKS_GUARD = threading.Lock()


def _lock_for(path: Path) -> threading.Lock:
    resolved = path.resolve()
    with _LOCKS_GUARD:
        if resolved not in _LOCKS:
            _LOCKS[resolved] = threading.Lock()
        return _LOCKS[resolved]


def _canonical_json(payload: dict[str, Any]) -> str:
    return json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def _read_last_state(path: Path) -> tuple[int, str]:
    if not path.exists():
        return 0, ""
    last_seq = 0
    last_hash = ""
    with path.open("r", encoding="utf-8") as fh:
        for line in fh:
            if not line.strip():
                continue
            row = json.loads(line)
            last_seq = int(row.get("seq") or 0)
            last_hash = str(row.get("hash") or "")
    return last_seq, last_hash


class JsonlLedger:
    """Append-only JSONL writer with per-file hash chaining."""

    def append(self, path: str | Path, event: dict[str, Any]) -> dict[str, Any]:
        log_path = Path(path)
        log_path.parent.mkdir(parents=True, exist_ok=True)
        with _lock_for(log_path):
            last_seq, prev_hash = _read_last_state(log_path)
            next_seq = last_seq + 1
            requested_seq = event.get("seq")
            if requested_seq is not None and int(requested_seq) != next_seq:
                raise ValueError(f"Event seq {requested_seq} does not match next seq {next_seq}")

            row = redact_event(event)
            row.setdefault("event_id", f"evt-{uuid.uuid4().hex}")
            row.setdefault("ts", datetime.now(UTC).isoformat().replace("+00:00", "Z"))
            row.setdefault("component", "c3")
            row.setdefault("event_type", "event.recorded")
            row.setdefault("actor", {})
            row.setdefault("payload", {})
            row["seq"] = next_seq
            row["prev_hash"] = prev_hash
            row.pop("hash", None)
            digest = sha256(_canonical_json(row).encode("utf-8")).hexdigest()
            row["hash"] = digest

            with log_path.open("a", encoding="utf-8", newline="\n") as fh:
                fh.write(json.dumps(row, sort_keys=True, separators=(",", ":"), ensure_ascii=False) + "\n")
            return row
