from __future__ import annotations

from typing import Any


def classify_operation(operation: dict[str, Any] | None) -> str:
    operation = operation or {}
    state = str(operation.get("state") or "").casefold()
    reason = str(
        operation.get("terminal_reason")
        or operation.get("reason_code")
        or operation.get("error")
        or ""
    ).casefold()
    result = operation.get("result") if isinstance(operation.get("result"), dict) else {}
    page_walk = result.get("pageWalk") if isinstance(result.get("pageWalk"), dict) else {}

    if state == "completed" and (
        result.get("review_ready") is True
        or result.get("pageKind") == "review"
        or result.get("hasSubmit") is True
        or page_walk.get("stoppedReason") == "final_submit_visible"
        or page_walk.get("pageKind") == "review"
        or page_walk.get("hasSubmit") is True
    ):
        return "review_ready"
    if state in {"stalled", "suspected_stall", "slow"}:
        return "operation_stalled"
    if "cancel_not_acknowledged" in reason:
        return "cancel_not_acknowledged"
    if "artifact_capture" in reason:
        return "artifact_capture_failed"
    if any(token in reason for token in ("auth_no_captcha", "auth_gate", "login_gate")):
        return "site_auth_gate"
    if any(token in reason for token in ("http_404", "http_410", "job_expired")):
        return "job_expired"
    if any(token in reason for token in ("cdp_connect", "bridge_unreachable", "target_missing")):
        return "bridge_unreachable"
    if any(token in reason for token in ("submit_blocked", "foreground", "safety_blocked")):
        return "safety_blocked"
    if state in {"failed", "cancelled", "orphaned"}:
        return "fill_failed"
    return "fill_failed"
