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
                if e.name == "pipeline_debug_summary":
                    lines.extend(_format_pipeline_debug_summary(e.detail))
                else:
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


def _append_list(lines: list[str], title: str, values: Any) -> None:
    lines.append(f"  {title}:")
    items = values if isinstance(values, list) else []
    if not items:
        lines.append("    - none")
        return
    for item in items:
        lines.append(f"    - {item}")


def _format_pipeline_debug_summary(detail: dict[str, Any]) -> list[str]:
    lines: list[str] = [f"  event_id: {detail.get('event_id')}", "  == Pipeline Debug Summary =="]
    lines.append("")
    _append_list(lines, "Keywords Found", detail.get("keywords_found"))
    partition = (
        detail.get("keyword_partition") if isinstance(detail.get("keyword_partition"), dict) else {}
    )
    lines.append("  Keyword Partition:")
    _append_list(lines, "Present", partition.get("present"))
    _append_list(lines, "Missing", partition.get("missing"))
    routes = detail.get("policy_routes") if isinstance(detail.get("policy_routes"), dict) else {}
    lines.append("  Policy Routes:")
    for route_name in ("rewrite", "summary_only", "skills_only", "ignored"):
        _append_list(lines, route_name, routes.get(route_name))
    rag = detail.get("rag_levels") if isinstance(detail.get("rag_levels"), dict) else {}
    lines.append("  RAG Levels:")
    _append_list(lines, "High", rag.get("high"))
    _append_list(lines, "Medium", rag.get("medium"))
    lines.append(f"    - low_count: {rag.get('low_count')}")
    lines.append(f"    - rag_used: {rag.get('rag_used')}")
    lines.append("  Bullet Rewrites:")
    rewrites = (
        detail.get("bullet_rewrites") if isinstance(detail.get("bullet_rewrites"), list) else []
    )
    if not rewrites:
        lines.append("    - none")
    for rewrite in rewrites:
        if not isinstance(rewrite, dict):
            continue
        lines.append(f"    - bullet_id: {rewrite.get('bullet_id')}")
        lines.append(f"      keywords: {rewrite.get('keywords') or []}")
        lines.append(f"      before: {rewrite.get('before')}")
        lines.append(f"      after: {rewrite.get('after')}")
    lines.append("  Summary Keywords:")
    _append_list(lines, "Used", detail.get("summary_keywords_used"))
    _append_list(lines, "Excluded", detail.get("summary_keywords_excluded"))
    lines.append("  Dropped Bullets:")
    dropped = (
        detail.get("dropped_bullets") if isinstance(detail.get("dropped_bullets"), list) else []
    )
    if not dropped:
        lines.append("    - none")
    for drop in dropped:
        if not isinstance(drop, dict):
            continue
        lines.append(
            "    - "
            f"{drop.get('bullet_id')} "
            f"({drop.get('kind')}:{drop.get('entry_id')}, "
            f"score={drop.get('score')}, stem={drop.get('stem')})"
        )
    attempts = detail.get("rewrite_attempts")
    lines.append(f"  Rewrite Attempts: {attempts if attempts else 'none'}")
    checks = detail.get("summary_line_checks")
    lines.append(f"  Summary Line Checks: {checks if checks else 'none'}")
    return lines
