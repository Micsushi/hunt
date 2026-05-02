"""Discord webhook notifications and runtime_state logging for C4 coordinator events."""

from __future__ import annotations

import json
import sys
from pathlib import Path

_repo_root = Path(__file__).resolve().parent.parent
if str(_repo_root) not in sys.path:
    sys.path.insert(0, str(_repo_root))

from shared.notifications import send_discord_webhook_message  # noqa: E402
from shared.timestamps import utc_iso  # noqa: E402


def notify(
    message: str,
    *,
    db_path: str | Path | None = None,
    key: str | None = None,
    level: str = "info",
    code: str | None = None,
    details: dict | None = None,
) -> None:
    """Send a Discord notification and optionally write to runtime_state.

    Discord is best-effort: silent no-op if webhook not configured.
    runtime_state write requires both db_path and key; skipped otherwise.
    """
    try:
        send_discord_webhook_message(message, username="Hunt C4")
    except Exception:
        pass

    if db_path is not None and key is not None:
        try:
            from .db import set_runtime_state

            event: dict = {"ts": utc_iso(), "level": level, "message": message}
            if code:
                event["code"] = code
            if details:
                event["details"] = details
            set_runtime_state(db_path, key, json.dumps(event, ensure_ascii=False))
        except Exception:
            pass
