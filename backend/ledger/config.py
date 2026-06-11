from __future__ import annotations

import json
import os
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

COMPONENTS = ("c3", "c4", "c2", "c1")
WINDOWS_DEFAULT_LEDGER_ROOT = Path.home() / "Documents" / "hunt-logs"
POSIX_DEFAULT_LEDGER_ROOT = Path.home() / ".hunt" / "logs"
REPO_ROOT = Path(__file__).resolve().parents[2]


def _is_relative_to(path: Path, parent: Path) -> bool:
    try:
        path.resolve().relative_to(parent.resolve())
        return True
    except ValueError:
        return False


def get_ledger_root() -> Path:
    """Return the configured ledger root without creating it."""
    raw = os.getenv("HUNT_LEDGER_ROOT", "").strip()
    default_root = WINDOWS_DEFAULT_LEDGER_ROOT if os.name == "nt" else POSIX_DEFAULT_LEDGER_ROOT
    root = Path(raw).expanduser() if raw else default_root
    resolved = root.resolve()
    if _is_relative_to(resolved, REPO_ROOT):
        source = "HUNT_LEDGER_ROOT" if raw else "default ledger root"
        raise RuntimeError(f"{source} must not be inside repo: {resolved}")
    return resolved


def _write_json_if_missing(path: Path, payload: dict[str, Any]) -> None:
    if path.exists():
        return
    path.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def initialize_ledger_root(root: str | Path | None = None) -> Path:
    ledger_root = Path(root).expanduser().resolve() if root is not None else get_ledger_root()
    ledger_root.mkdir(parents=True, exist_ok=True)

    for component in COMPONENTS:
        component_root = ledger_root / component
        component_root.mkdir(parents=True, exist_ok=True)
        if component == "c3":
            for folder in ("agents", "lanes", "sessions", "global"):
                (component_root / folder).mkdir(parents=True, exist_ok=True)

    structure = ledger_root / "LEDGER_STRUCTURE.md"
    if not structure.exists():
        structure.write_text(
            "\n".join(
                [
                    "# Hunt Ledger Structure",
                    "",
                    "Traversal order:",
                    "1. Read `active.json` for current agent, lane, and session manifests.",
                    "2. Open referenced `manifest.json` files for IDs and log paths.",
                    "3. Read append-only JSONL files for source-of-truth event history.",
                    "4. Query Postgres only as a rebuildable search/index layer.",
                    "5. Trust JSONL over database rows when they disagree.",
                    "",
                ]
            ),
            encoding="utf-8",
        )

    now = datetime.now(UTC).isoformat()
    _write_json_if_missing(
        ledger_root / "schema.json",
        {
            "version": 1,
            "source_of_truth": "jsonl",
            "components": list(COMPONENTS),
            "event_fields": [
                "event_id",
                "seq",
                "ts",
                "component",
                "event_type",
                "actor",
                "agent_id",
                "lane_id",
                "session_id",
                "lease_id",
                "command_id",
                "trace_id",
                "payload",
                "redaction",
                "prev_hash",
                "hash",
            ],
        },
    )
    _write_json_if_missing(
        ledger_root / "index.json",
        {
            "version": 1,
            "updated_at": now,
            "source": "jsonl",
            "agents": {},
            "lanes": {},
            "sessions": {},
        },
    )
    _write_json_if_missing(
        ledger_root / "active.json",
        {
            "version": 1,
            "updated_at": now,
            "active_agents": {},
            "active_lanes": {},
            "active_sessions": {},
        },
    )
    return ledger_root
