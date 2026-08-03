"""User-editable config file for Hunt C1.

Provides load/save helpers for hunt_user_config.json at the repo root. Discovery
preferences such as titles, experience levels, locations, and boards belong here
rather than in source code.
Priority chain for all tunables: env var > config file > hardcoded default.
"""

from __future__ import annotations

import json
import os
import threading
from pathlib import Path
from typing import Any

_REPO_ROOT = Path(__file__).parent.parent
_DEFAULT_PATH = _REPO_ROOT / "hunt_user_config.json"

_lock = threading.Lock()


def get_path() -> Path:
    env = os.environ.get("HUNT_USER_CONFIG_PATH", "")
    return Path(env) if env else _DEFAULT_PATH


def load() -> dict[str, Any]:
    path = get_path()
    if not path.exists():
        return {}
    with _lock:
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
            if not isinstance(data, dict):
                return {}
            data.pop("search_terms", None)
            return data
        except Exception:
            return {}


def save(data: dict[str, Any]) -> None:
    path = get_path()
    with _lock:
        path.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def patch(updates: dict[str, Any]) -> dict[str, Any]:
    """Merge updates into the existing config file and save. Returns the merged config."""
    current = load()
    clean_updates = dict(updates)
    clean_updates.pop("search_terms", None)
    current.update(clean_updates)
    save(current)
    return current
