"""Telegram bot interface for C4 Coordinator.

Bidirectional: C4 pushes status/approvals/CAPTCHA prompts; operator replies with commands.

Requires:
    HUNT_TELEGRAM_BOT_TOKEN  — bot token from @BotFather
    HUNT_TELEGRAM_CHAT_ID    — chat/user ID to send messages to

Push messages are best-effort (silent no-op if not configured).
Command polling is started by calling start_polling().

Supported operator commands (sent as Telegram messages):
    approve <run_id>        — approve submit for a run
    deny <run_id>           — deny submit for a run
    skip <job_id>           — mark a job as skipped
    investigate <run_id>    — manually queue a run for investigation
    status                  — request scheduler + pending queue summary
"""

from __future__ import annotations

import json
import os
import threading
import time
from typing import Any
from urllib.error import URLError
from urllib.request import Request, urlopen

_API_BASE = "https://api.telegram.org/bot{token}"


def _token() -> str | None:
    return os.environ.get("HUNT_TELEGRAM_BOT_TOKEN", "").strip() or None


def _chat_id() -> str | None:
    return os.environ.get("HUNT_TELEGRAM_CHAT_ID", "").strip() or None


def _is_configured() -> bool:
    return bool(_token() and _chat_id())


def _tg_request(
    method: str,
    payload: dict[str, Any],
    *,
    timeout: int = 10,
) -> dict[str, Any]:
    token = _token()
    if not token:
        return {}
    url = f"{_API_BASE.format(token=token)}/{method}"
    data = json.dumps(payload).encode("utf-8")
    req = Request(url, data=data, headers={"Content-Type": "application/json"}, method="POST")
    try:
        with urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except (URLError, OSError):
        return {}


def send_message(text: str, *, parse_mode: str = "HTML") -> bool:
    """Send a message to the configured chat. Returns True if sent."""
    if not _is_configured():
        return False
    result = _tg_request(
        "sendMessage",
        {"chat_id": _chat_id(), "text": text, "parse_mode": parse_mode},
    )
    return bool(result.get("ok"))


def notify_fill_complete(run_id: str, job_id: int, company: str | None, title: str | None) -> None:
    company_str = company or "Unknown"
    title_str = title or "Unknown"
    send_message(
        f"✅ Fill complete — awaiting submit approval\n"
        f"Run: <code>{run_id}</code>\n"
        f"Job: {job_id} · {company_str} — {title_str}\n\n"
        f"Reply: <code>approve {run_id}</code> or <code>deny {run_id}</code>"
    )


def notify_manual_review(run_id: str, job_id: int, reason: str, company: str | None = None) -> None:
    company_str = company or "Unknown"
    send_message(
        f"⚠️ Manual review required\n"
        f"Run: <code>{run_id}</code>\n"
        f"Job: {job_id} · {company_str}\n"
        f"Reason: {reason}\n\n"
        f"Reply: <code>investigate {run_id}</code> or <code>skip {job_id}</code>"
    )


def notify_investigation_queued(run_id: str, job_id: int, failure_code: str) -> None:
    send_message(
        f"🔍 Investigation queued\n"
        f"Run: <code>{run_id}</code>\n"
        f"Job: {job_id}\n"
        f"Failure: {failure_code}"
    )


def notify_investigation_complete(run_id: str, job_id: int, suggested_fix: str | None) -> None:
    fix_str = suggested_fix or "see failure report"
    send_message(
        f"📋 Investigation complete\n"
        f"Run: <code>{run_id}</code>\n"
        f"Job: {job_id}\n"
        f"Suggested fix area: {fix_str}"
    )


def notify_captcha(run_id: str, job_id: int, captcha_type: str) -> None:
    send_message(
        f"🔒 CAPTCHA challenge\n"
        f"Run: <code>{run_id}</code>\n"
        f"Job: {job_id}\n"
        f"Type: {captcha_type}\n\n"
        f"Reply: <code>skip {job_id}</code> to skip this job"
    )


# ---------------------------------------------------------------------------
# Command polling
# ---------------------------------------------------------------------------

COMMAND_HANDLERS: dict[str, Any] = {}


def register_handler(command: str, fn: Any) -> None:
    """Register a callable for a Telegram command verb."""
    COMMAND_HANDLERS[command.lower().strip()] = fn


def _parse_command(text: str) -> tuple[str, list[str]]:
    parts = text.strip().split()
    if not parts:
        return "", []
    return parts[0].lower(), parts[1:]


def _handle_update(update: dict[str, Any]) -> None:
    message = update.get("message") or {}
    text = str(message.get("text") or "").strip()
    if not text:
        return
    verb, args = _parse_command(text)
    handler = COMMAND_HANDLERS.get(verb)
    if handler:
        try:
            reply = handler(args)
        except Exception as exc:
            reply = f"Error: {exc}"
        if reply:
            send_message(str(reply))


class CommandPoller:
    """Long-poll Telegram for commands in a daemon thread."""

    def __init__(self, *, poll_timeout: int = 30) -> None:
        self.poll_timeout = poll_timeout
        self._offset = 0
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None

    def start(self) -> None:
        if self._thread and self._thread.is_alive():
            return
        self._stop.clear()
        self._thread = threading.Thread(target=self._loop, daemon=True, name="c4-telegram-poller")
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()

    def _loop(self) -> None:
        while not self._stop.is_set():
            if not _is_configured():
                time.sleep(10)
                continue
            try:
                result = _tg_request(
                    "getUpdates",
                    {"offset": self._offset, "timeout": self.poll_timeout},
                    timeout=self.poll_timeout + 5,
                )
                updates = result.get("result") or []
                for update in updates:
                    self._offset = int(update.get("update_id", self._offset)) + 1
                    _handle_update(update)
            except Exception:
                time.sleep(5)


_poller: CommandPoller | None = None


def start_polling() -> None:
    """Start the background command poller (idempotent)."""
    global _poller
    if _poller is None:
        _poller = CommandPoller()
    _poller.start()


def stop_polling() -> None:
    global _poller
    if _poller:
        _poller.stop()
