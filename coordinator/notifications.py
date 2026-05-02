"""Discord webhook notifications for C4 coordinator events."""

from __future__ import annotations

import json
import os
from urllib import error, request

_WEBHOOK_ENVS = ("HUNT_DISCORD_WEBHOOK_URL", "DISCORD_WEBHOOK_URL")
_TIMEOUT = 10


def _get_webhook_url() -> str | None:
    for env in _WEBHOOK_ENVS:
        value = (os.getenv(env) or "").strip()
        if value:
            if value.startswith("https://discordapp.com/api/webhooks/"):
                value = value.replace("https://discordapp.com/", "https://discord.com/", 1)
            return value
    return None


def notify(message: str) -> None:
    """Send a Discord notification. Silent no-op if webhook not configured."""
    url = _get_webhook_url()
    if not url:
        return
    payload = json.dumps({"content": message, "username": "Hunt C4"}).encode()
    req = request.Request(
        url,
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with request.urlopen(req, timeout=_TIMEOUT):
            pass
    except (error.URLError, OSError):
        pass
