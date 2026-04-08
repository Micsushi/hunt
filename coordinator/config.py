from __future__ import annotations

import os
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_DB_PATH = REPO_ROOT / "hunt.db"
DEFAULT_RUNTIME_ROOT = REPO_ROOT / ".state" / "coordinator"


def _resolve_path(value: str | Path | None, default: Path) -> Path:
    if value is None or not str(value).strip():
        path = default
    else:
        path = Path(str(value).strip()).expanduser()
        if not path.is_absolute():
            path = REPO_ROOT / path
    return path.resolve()


def resolve_db_path(value: str | Path | None = None) -> Path:
    return _resolve_path(value or os.getenv("HUNT_DB_PATH"), DEFAULT_DB_PATH)


def _runtime_root_from_env() -> str | None:
    return os.getenv("HUNT_COORDINATOR_ROOT") or os.getenv("HUNT_ORCHESTRATION_ROOT")


def resolve_runtime_root(value: str | Path | None = None) -> Path:
    return _resolve_path(value or _runtime_root_from_env(), DEFAULT_RUNTIME_ROOT)
