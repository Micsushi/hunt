import json
import os
from urllib import error, request


DEFAULT_TIMEOUT_SECONDS = 15
HUNT_DISCORD_WEBHOOK_ENV = "HUNT_DISCORD_WEBHOOK_URL"
UPTIME_KUMA_DISCORD_WEBHOOK_ENV = "UPTIME_KUMA_DISCORD_WEBHOOK_URL"
LEGACY_DISCORD_WEBHOOK_ENV = "DISCORD_WEBHOOK_URL"


def _normalize_discord_webhook_url(url):
    normalized = (url or "").strip()
    if normalized.startswith("https://discordapp.com/api/webhooks/"):
        return normalized.replace("https://discordapp.com/", "https://discord.com/", 1)
    return normalized


def get_discord_webhook_url():
    for env_name in (
        HUNT_DISCORD_WEBHOOK_ENV,
        UPTIME_KUMA_DISCORD_WEBHOOK_ENV,
        LEGACY_DISCORD_WEBHOOK_ENV,
    ):
        value = (os.getenv(env_name) or "").strip()
        if value:
            return _normalize_discord_webhook_url(value)
    return None


def send_discord_webhook_message(content, *, username="Hunt", timeout_seconds=DEFAULT_TIMEOUT_SECONDS):
    webhook_url = get_discord_webhook_url()
    if not webhook_url:
        return {
            "sent": False,
            "reason": "not_configured",
            "status_code": None,
        }

    payload = json.dumps(
        {
            "content": content,
            "username": username,
        }
    ).encode("utf-8")
    req = request.Request(
        webhook_url,
        data=payload,
        headers={
            "Content-Type": "application/json",
            "User-Agent": "HuntDiscordNotifier/1.0",
        },
        method="POST",
    )
    try:
        with request.urlopen(req, timeout=timeout_seconds) as response:
            return {
                "sent": True,
                "reason": None,
                "status_code": getattr(response, "status", None),
            }
    except error.HTTPError as exc:
        return {
            "sent": False,
            "reason": f"http_error:{exc.code}",
            "status_code": exc.code,
        }
    except error.URLError as exc:
        return {
            "sent": False,
            "reason": f"url_error:{exc.reason}",
            "status_code": None,
        }
