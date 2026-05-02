import sys
from pathlib import Path

# Ensure shared/ is importable regardless of invocation style (package or script).
_repo_root = Path(__file__).resolve().parent.parent
if str(_repo_root) not in sys.path:
    sys.path.insert(0, str(_repo_root))

from shared.notifications import (  # noqa: E402
    DEFAULT_TIMEOUT_SECONDS,
    HUNT_DISCORD_WEBHOOK_ENV,
    LEGACY_DISCORD_WEBHOOK_ENV,
    UPTIME_KUMA_DISCORD_WEBHOOK_ENV,
    get_discord_webhook_url,
    send_discord_webhook_message,
)

__all__ = [
    "DEFAULT_TIMEOUT_SECONDS",
    "HUNT_DISCORD_WEBHOOK_ENV",
    "LEGACY_DISCORD_WEBHOOK_ENV",
    "UPTIME_KUMA_DISCORD_WEBHOOK_ENV",
    "get_discord_webhook_url",
    "send_discord_webhook_message",
]
