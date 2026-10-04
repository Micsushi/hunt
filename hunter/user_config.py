"""User-editable config file for Hunt C1.

Provides load/save helpers for hunt_user_config.json at the repo root.
Priority chain for all tunables: env var > config file > hardcoded default.
"""

from __future__ import annotations

import json
import os
import tempfile
import threading
from pathlib import Path
from typing import Any

_REPO_ROOT = Path(__file__).parent.parent
_DEFAULT_PATH = _REPO_ROOT / "hunt_user_config.json"

_lock = threading.RLock()

# Shared by file validation and the HTTP settings contract.
INTEGER_LIMITS = {
    name: (1, None)
    for name in (
        "max_workers",
        "results_wanted",
        "hours_old",
        "run_interval_seconds",
        "backfill_interval_seconds",
        "backfill_hours_old",
        "enrichment_batch_limit",
        "enrichment_timeout_ms",
        "enrichment_max_attempts",
    )
}
INTEGER_LIMITS.update(
    enrichment_alert_failure_rate_percent=(0, 100),
    enrichment_alert_cooldown_minutes=(0, None),
    run_interval_seconds=(60, None),
    enrichment_timeout_ms=(5000, None),
)


def validate(data):
    if not isinstance(data, dict):
        raise ValueError("Hunt settings must be a JSON object")
    for name, (minimum, maximum) in INTEGER_LIMITS.items():
        if name not in data:
            continue
        value = data[name]
        if type(value) is not int or value < minimum or (maximum is not None and value > maximum):
            raise ValueError(
                f"Invalid setting {name}: expected an integer >= {minimum}"
                + (f" and <= {maximum}" if maximum is not None else "")
            )
    return data


def get_path() -> Path:
    env = os.environ.get("HUNT_USER_CONFIG_PATH", "")
    return Path(env) if env else _DEFAULT_PATH


def load() -> dict[str, Any]:
    path = get_path()
    if not path.exists():
        return {}
    with _lock:
        return validate(json.loads(path.read_text(encoding="utf-8")))


def save(data: dict[str, Any]) -> None:
    path = get_path()
    with _lock:
        content = json.dumps(validate(data), indent=2, ensure_ascii=False) + "\n"
        fd, temporary = tempfile.mkstemp(dir=path.parent, prefix=f".{path.name}.")
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as stream:
                stream.write(content)
                stream.flush()
                os.fsync(stream.fileno())
            os.chmod(temporary, path.stat().st_mode & 0o777 if path.exists() else 0o600)
            os.replace(temporary, path)
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)


def patch(updates: dict[str, Any]) -> dict[str, Any]:
    """Merge updates into the existing config file and save. Returns the merged config."""
    with _lock:
        current = load()
        current.update(updates)
        save(current)
        return current
