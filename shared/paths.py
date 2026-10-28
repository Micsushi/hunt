from __future__ import annotations

import os
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent


def get_state_root(default: Path = REPO_ROOT) -> Path:
    """Keep an explicitly separated local installation's state outside its code."""
    value = os.environ.get("HUNT_STATE_ROOT")
    if value is None:
        return default
    root = Path(value).expanduser()
    if not value.strip() or not root.is_absolute() or not root.is_dir():
        raise ValueError("HUNT_STATE_ROOT must be an existing absolute directory")
    return root.resolve()


def resolve_state_path(value: str | Path) -> Path:
    path = Path(value).expanduser()
    if "HUNT_STATE_ROOT" in os.environ and not path.is_absolute():
        path = get_state_root() / path
    return path.resolve()


def get_frontend_dist(default: Path = REPO_ROOT / "frontend" / "dist") -> Path:
    value = os.environ.get("HUNT_FRONTEND_DIST")
    if value is None:
        return default
    path = Path(value).expanduser()
    if not value.strip() or not path.is_absolute():
        raise ValueError("HUNT_FRONTEND_DIST must be an absolute directory")
    return path
