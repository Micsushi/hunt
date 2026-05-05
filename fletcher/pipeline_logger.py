from __future__ import annotations

import sys
import time
from dataclasses import dataclass
from typing import Any


@dataclass
class _LogEntry:
    ts: float
    kind: str  # "step" | "llm"
    name: str
    detail: dict


class PipelineLogger:
    def __init__(self) -> None:
        self._entries: list[_LogEntry] = []
        self._start = time.perf_counter()

    def step(self, name: str, **detail: Any) -> None:
        ts = time.perf_counter() - self._start
        self._entries.append(_LogEntry(ts=ts, kind="step", name=name, detail=detail))
        parts = " | ".join(f"{k}={v}" for k, v in detail.items() if v is not None)
        print(f"[pipeline +{ts:.2f}s] {name}  {parts}", flush=True)

    def llm_call(
        self,
        name: str,
        prompt: str,
        response: str,
        duration_ms: int | None,
        success: bool = True,
        error: str | None = None,
    ) -> None:
        ts = time.perf_counter() - self._start
        self._entries.append(
            _LogEntry(
                ts=ts,
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
        print(f"[pipeline +{ts:.2f}s] llm:{name}  {status}  {duration_ms}ms", flush=True)
        if not success and error:
            print(f"[pipeline] llm error detail: {error}", file=sys.stderr, flush=True)

    def get_log_text(self) -> str:
        lines: list[str] = ["=" * 70, "PIPELINE LOG", "=" * 70, ""]
        for e in self._entries:
            ts = f"+{e.ts:.2f}s"
            if e.kind == "step":
                lines.append(f"[STEP  {ts}] {e.name}")
                for k, v in e.detail.items():
                    lines.append(f"  {k}: {v}")
                lines.append("")
            else:
                dur = e.detail["duration_ms"]
                ok = e.detail["success"]
                lines.append(f"[LLM   {ts}] {e.name}  success={ok}  {dur}ms")
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
