from __future__ import annotations

import json
from dataclasses import dataclass
from hashlib import sha256
from pathlib import Path
from typing import Any

from backend.ledger.jsonl_store import _canonical_json


@dataclass(frozen=True)
class HashChainError:
    line_number: int
    reason: str
    expected: str | int | None = None
    actual: str | int | None = None


@dataclass(frozen=True)
class HashChainVerification:
    path: Path
    ok: bool
    checked_lines: int
    last_hash: str
    error: HashChainError | None = None


def _expected_hash(row: dict[str, Any]) -> str:
    hashed = dict(row)
    hashed.pop("hash", None)
    return sha256(_canonical_json(hashed).encode("utf-8")).hexdigest()


def verify_jsonl_hash_chain(path: str | Path) -> HashChainVerification:
    """Verify one ledger JSONL file without modifying it."""

    log_path = Path(path)
    expected_prev_hash = ""
    expected_seq = 1
    checked_lines = 0

    try:
        with log_path.open("r", encoding="utf-8") as fh:
            for line_number, line in enumerate(fh, start=1):
                if not line.strip():
                    continue
                checked_lines += 1
                try:
                    row = json.loads(line)
                except json.JSONDecodeError as exc:
                    return HashChainVerification(
                        path=log_path,
                        ok=False,
                        checked_lines=checked_lines,
                        last_hash=expected_prev_hash,
                        error=HashChainError(line_number, f"invalid json: {exc.msg}"),
                    )

                actual_seq = row.get("seq")
                if actual_seq != expected_seq:
                    return HashChainVerification(
                        path=log_path,
                        ok=False,
                        checked_lines=checked_lines,
                        last_hash=expected_prev_hash,
                        error=HashChainError(
                            line_number,
                            "seq mismatch",
                            expected=expected_seq,
                            actual=actual_seq,
                        ),
                    )

                actual_prev_hash = row.get("prev_hash")
                if actual_prev_hash != expected_prev_hash:
                    return HashChainVerification(
                        path=log_path,
                        ok=False,
                        checked_lines=checked_lines,
                        last_hash=expected_prev_hash,
                        error=HashChainError(
                            line_number,
                            "prev_hash mismatch",
                            expected=expected_prev_hash,
                            actual=actual_prev_hash,
                        ),
                    )

                actual_hash = row.get("hash")
                expected_hash = _expected_hash(row)
                if actual_hash != expected_hash:
                    return HashChainVerification(
                        path=log_path,
                        ok=False,
                        checked_lines=checked_lines,
                        last_hash=expected_prev_hash,
                        error=HashChainError(
                            line_number,
                            "hash mismatch",
                            expected=expected_hash,
                            actual=actual_hash,
                        ),
                    )

                expected_prev_hash = str(actual_hash)
                expected_seq += 1
    except FileNotFoundError:
        return HashChainVerification(
            path=log_path,
            ok=False,
            checked_lines=0,
            last_hash="",
            error=HashChainError(0, "file not found"),
        )

    return HashChainVerification(
        path=log_path,
        ok=True,
        checked_lines=checked_lines,
        last_hash=expected_prev_hash,
    )
