import json
import sys
import traceback
from dataclasses import dataclass
from datetime import UTC, datetime

try:
    # Package-style imports (preferred when `hunter` is imported as a module).
    from .db import set_runtime_state  # type: ignore
    from .notifications import send_discord_webhook_message  # type: ignore
except ImportError:
    # Script-style fallback (used when `hunter/` is on sys.path).
    from db import set_runtime_state  # type: ignore
    from notifications import send_discord_webhook_message  # type: ignore


def _utc_iso():
    return datetime.now(UTC).replace(microsecond=0).isoformat()


@dataclass(frozen=True)
class C1LogEvent:
    """
    C1 (Hunter): structured event for operational visibility and cross-component handoff.

    - level: info|warn|error
    - code: stable-ish identifier that other components can key on later
    """

    level: str
    message: str
    code: str | None = None
    details: dict | None = None

    def to_json(self):
        payload = {
            "ts": _utc_iso(),
            "level": self.level,
            "message": self.message,
        }
        if self.code:
            payload["code"] = self.code
        if self.details:
            payload["details"] = self.details
        return payload


class C1Logger:
    """
    C1 (Hunter) logging fan-out.

    This is intentionally component-scoped:
    - It lives under `hunter/` (C1).
    - It writes only to C1-owned runtime state (`runtime_state` table).
    - Other components can define their own equivalent files without importing C1.

    Sinks:
    - terminal: stderr
    - webapp: a single JSON event stored under a `runtime_state` key
    - discord: best-effort Discord message
    """

    def __init__(self, *, terminal=True, webapp=True, discord=False):
        self.terminal = bool(terminal)
        self.webapp = bool(webapp)
        self.discord = bool(discord)

    def _emit_terminal(self, event: C1LogEvent):
        if not self.terminal:
            return
        try:
            line = json.dumps(event.to_json(), ensure_ascii=False)
        except Exception:
            line = f"[{event.level}] {event.message}"
        print(line, file=sys.stderr)

    def _emit_webapp(self, event_key: str, event: C1LogEvent):
        if not self.webapp:
            return
        try:
            set_runtime_state(event_key, json.dumps(event.to_json(), ensure_ascii=False))
        except Exception:
            return

    def _emit_discord(self, event: C1LogEvent):
        if not self.discord:
            return
        try:
            send_discord_webhook_message(event.message)
        except Exception:
            return

    def event(
        self,
        *,
        key: str,
        level: str,
        message: str,
        code: str | None = None,
        details: dict | None = None,
        discord: bool | None = None,
    ):
        event = C1LogEvent(level=level, message=message, code=code, details=details)
        self._emit_terminal(event)
        self._emit_webapp(key, event)
        if discord is None:
            discord = self.discord
        if discord:
            self._emit_discord(event)
        return event

    def exception(
        self,
        *,
        key: str,
        message: str,
        exc: BaseException,
        code: str | None = None,
        discord: bool | None = None,
    ):
        details = {
            "exception_type": type(exc).__name__,
            "exception": str(exc),
            "traceback": traceback.format_exc(limit=15),
        }
        return self.event(
            key=key,
            level="error",
            message=message,
            code=code,
            details=details,
            discord=discord,
        )
