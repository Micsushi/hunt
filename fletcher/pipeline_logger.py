from __future__ import annotations

import sys
import time
from dataclasses import dataclass
from typing import Any


@dataclass
class _LogEntry:
    event_id: int
    ts: float
    delta: float
    kind: str  # "step" | "llm"
    name: str
    detail: dict


class PipelineLogger:
    def __init__(self) -> None:
        self._entries: list[_LogEntry] = []
        self._start = time.perf_counter()
        self._last_ts = 0.0
        self._event_id = 0

    def _next_event_id(self) -> int:
        self._event_id += 1
        return self._event_id

    def step(self, name: str, **detail: Any) -> None:
        event_id = self._next_event_id()
        ts = time.perf_counter() - self._start
        delta = ts - self._last_ts
        self._last_ts = ts
        detail = {"event_id": event_id, **detail}
        self._entries.append(
            _LogEntry(event_id=event_id, ts=ts, delta=delta, kind="step", name=name, detail=detail)
        )
        parts = " | ".join(f"{k}={v}" for k, v in detail.items() if v is not None)
        print(
            f"------ pipeline event={event_id} +{ts:.3f}s delta={delta:.3f}s step={name} ------",
            flush=True,
        )
        if parts:
            print(parts, flush=True)

    def llm_call(
        self,
        name: str,
        prompt: str,
        response: str,
        duration_ms: int | None,
        success: bool = True,
        error: str | None = None,
    ) -> None:
        event_id = self._next_event_id()
        ts = time.perf_counter() - self._start
        delta = ts - self._last_ts
        self._last_ts = ts
        self._entries.append(
            _LogEntry(
                event_id=event_id,
                ts=ts,
                delta=delta,
                kind="llm",
                name=name,
                detail={
                    "prompt": prompt,
                    "response": response,
                    "duration_ms": duration_ms,
                    "success": success,
                    "error": error,
                },
            )
        )
        status = "ok" if success else f"FAILED error={error}"
        print(
            f"------ llm event={event_id} +{ts:.3f}s delta={delta:.3f}s call={name} status={status} duration_ms={duration_ms} ------",
            flush=True,
        )
        if not success and error:
            print(f"[pipeline] llm error detail: {error}", file=sys.stderr, flush=True)

    def get_log_text(self) -> str:
        lines: list[str] = ["=" * 70, "PIPELINE LOG", "=" * 70, ""]
        for e in self._entries:
            lines.append("------")
            ts = f"+{e.ts:.3f}s"
            delta = f"delta={e.delta:.3f}s"
            if e.kind == "step":
                lines.append(f"[STEP  {ts} | {delta} | event_id={e.event_id}] {e.name}")
                for k, v in e.detail.items():
                    lines.append(f"  {k}: {v}")
                lines.append("")
            else:
                dur = e.detail["duration_ms"]
                ok = e.detail["success"]
                lines.append(
                    f"[LLM   {ts} | {delta} | event_id={e.event_id}] {e.name}  success={ok}  {dur}ms"
                )
                lines.append("  --- PROMPT ---")
                for ln in str(e.detail["prompt"]).splitlines():
                    lines.append(f"  {ln}")
                lines.append("  --- RESPONSE ---")
                for ln in str(e.detail["response"]).splitlines():
                    lines.append(f"  {ln}")
                if e.detail.get("error"):
                    lines.append(f"  ERROR: {e.detail['error']}")
                lines.append("")
        return "\n".join(lines)
