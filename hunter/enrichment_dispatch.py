"""
Central enrichment dispatch: route pending rows to the correct worker by `jobs.source`.

Discovery writes `source` (linkedin, indeed, …). This module is the single place that:
- defines which sources are supported for enrichment and in what **priority** order
- declares **auth / preconditions** per source (e.g. LinkedIn session vs none for Indeed)
- runs one **round** of work up to a shared batch limit

To add a board later: extend `_REQUIRES_LINKEDIN_SESSION`, `_run_batch_for_source`, and the
worker module's `process_batch`, then append the source id to `db.ENRICHMENT_SOURCE_PRIORITY`
(and discovery) so SQL claim/count helpers stay aligned.
"""

from __future__ import annotations

import json
from collections.abc import Callable
from datetime import datetime, timedelta
from typing import Any

from hunter.c1_logging import C1Logger
from hunter.config import (
    ENRICHMENT_ALERT_COOLDOWN_MINUTES,
    ENRICHMENT_ALERT_FAILURE_RATE_PERCENT,
    ENRICHMENT_ALERT_MIN_ATTEMPTS,
)
from hunter.db import (
    ENRICHMENT_SOURCE_PRIORITY,
    count_ready_jobs_for_enrichment,
    count_ready_linkedin_jobs_for_hiring_cafe_fallback,
    get_linkedin_auth_state,
    get_runtime_state,
)
from hunter.linkedin_session import (
    attempt_auto_relogin,
    block_account_for_days,
    get_active_account_index,
    rotate_linkedin_account,
)

RATE_LIMIT_BLOCK_DAYS = 1
HIGH_FAILURE_ALERT_RUNTIME_KEY = "hunt_last_high_failure_alert"


def _get_linkedin_process_batch() -> Callable[..., dict[str, Any]]:
    from hunter.enrich_linkedin import process_batch

    return process_batch


def _get_indeed_process_batch() -> Callable[..., dict[str, Any]]:
    from hunter.enrich_indeed import process_batch

    return process_batch


def _get_hiring_cafe_process_batch() -> Callable[..., dict[str, Any]]:
    from hunter.enrich_hiring_cafe import process_batch

    return process_batch


def _run_linkedin_batch(
    *,
    limit: int,
    storage_state_path: str | None,
    headless: bool,
    slow_mo: int,
    timeout_ms: int,
    browser_channel: str | None,
    ui_verify_blocked: bool,
) -> dict[str, Any]:
    return _get_linkedin_process_batch()(
        limit=limit,
        storage_state_path=storage_state_path,
        headless=headless,
        slow_mo=slow_mo,
        timeout_ms=timeout_ms,
        browser_channel=browser_channel,
        ui_verify_blocked=ui_verify_blocked,
        return_summary=True,
    )


def _run_indeed_batch(
    *,
    limit: int,
    timeout_ms: int,
    browser_channel: str | None,
    ui_verify_blocked: bool,
) -> dict[str, Any]:
    return _get_indeed_process_batch()(
        limit=limit,
        timeout_ms=timeout_ms,
        browser_channel=browser_channel,
        ui_verify_blocked=ui_verify_blocked,
        return_summary=True,
    )


def _run_hiring_cafe_linkedin_fallback(*, limit: int) -> dict[str, Any]:
    return _get_hiring_cafe_process_batch()(limit=limit, return_summary=True)


# source id -> requires LinkedIn session before running this source's batch
_REQUIRES_LINKEDIN_SESSION: dict[str, bool] = {
    "linkedin": True,
    "indeed": False,
}


def registered_enrichment_sources() -> tuple[str, ...]:
    """Sources with dispatch metadata (extend `_REQUIRES_LINKEDIN_SESSION` + run branch when adding one)."""
    return tuple(s for s in ENRICHMENT_SOURCE_PRIORITY if s in _REQUIRES_LINKEDIN_SESSION)


def _validate_registry() -> None:
    missing = [s for s in ENRICHMENT_SOURCE_PRIORITY if s not in _REQUIRES_LINKEDIN_SESSION]
    if missing:
        print(
            f"[enrich] Warning: ENRICHMENT_SOURCE_PRIORITY includes {missing!r} "
            f"but enrichment_dispatch has no entry in _REQUIRES_LINKEDIN_SESSION / run branch; skipping."
        )


def _run_batch_for_source(
    source: str,
    *,
    source_limit: int,
    storage_state_path: str | None,
    headless: bool,
    slow_mo: int,
    timeout_ms: int,
    browser_channel: str | None,
    ui_verify_blocked: bool,
) -> dict[str, Any]:
    if source == "linkedin":
        return _run_linkedin_batch(
            limit=source_limit,
            storage_state_path=storage_state_path,
            headless=headless,
            slow_mo=slow_mo,
            timeout_ms=timeout_ms,
            browser_channel=browser_channel,
            ui_verify_blocked=ui_verify_blocked,
        )
    if source == "indeed":
        return _run_indeed_batch(
            limit=source_limit,
            timeout_ms=timeout_ms,
            browser_channel=browser_channel,
            ui_verify_blocked=ui_verify_blocked,
        )
    raise RuntimeError(
        f"Unhandled enrichment source {source!r}: add a branch in _run_batch_for_source"
    )


def _merge_source_summary(
    aggregate: dict[str, Any],
    *,
    source_key: str,
    summary: dict[str, Any],
) -> None:
    aggregate["by_source"][source_key] = summary
    aggregate["attempted"] += summary["attempted"]
    aggregate["ui_verified"] += summary["ui_verified"]
    aggregate["succeeded"] += summary["succeeded"]
    aggregate["failed"] += summary["failed"]
    aggregate["actionable_failed"] += summary["actionable_failed"]
    aggregate["total_elapsed_seconds"] += summary["total_elapsed_seconds"]
    for error_code, count in summary["failure_breakdown"].items():
        aggregate["failure_breakdown"][error_code] = (
            aggregate["failure_breakdown"].get(error_code, 0) + count
        )


def ensure_linkedin_session(
    *,
    storage_state_path: str | None,
    headless: bool,
    slow_mo: int,
    timeout_ms: int,
    browser_channel: str | None,
) -> bool:
    """Return True if LinkedIn auth is available (possibly after auto-relogin)."""
    linkedin_auth = get_linkedin_auth_state()
    if linkedin_auth.get("available"):
        return True
    relogin_result = attempt_auto_relogin(
        storage_state_path=storage_state_path,
        browser_channel=browser_channel,
        headless=headless,
        slow_mo=slow_mo,
        timeout_ms=timeout_ms,
    )
    if relogin_result.get("attempted"):
        print(f"[enrich] {relogin_result['message']}")
    linkedin_auth = get_linkedin_auth_state()
    if linkedin_auth.get("available"):
        return True
    if linkedin_auth.get("last_error"):
        print(f"[enrich] Last LinkedIn auth error: {linkedin_auth['last_error']}")
    return False


def _round_failure_rate_percent(summary: dict[str, Any]) -> float:
    attempted = int(summary.get("attempted") or 0)
    actionable_failed = int(summary.get("actionable_failed") or 0)
    if attempted <= 0:
        return 0.0
    return round((actionable_failed / attempted) * 100, 1)


def _build_high_failure_alert_details(summary: dict[str, Any], *, limit: int) -> dict[str, Any]:
    return {
        "limit": limit,
        "attempted": int(summary.get("attempted") or 0),
        "actionable_failed": int(summary.get("actionable_failed") or 0),
        "failed": int(summary.get("failed") or 0),
        "failure_rate_percent": _round_failure_rate_percent(summary),
        "threshold_percent": ENRICHMENT_ALERT_FAILURE_RATE_PERCENT,
        "min_attempts": ENRICHMENT_ALERT_MIN_ATTEMPTS,
        "stop_error_code": summary.get("stop_error_code"),
        "failure_breakdown": dict(summary.get("failure_breakdown") or {}),
        "by_source": dict(summary.get("by_source") or {}),
    }


def _should_send_high_failure_alert(summary: dict[str, Any]) -> bool:
    attempted = int(summary.get("attempted") or 0)
    actionable_failed = int(summary.get("actionable_failed") or 0)
    if attempted < ENRICHMENT_ALERT_MIN_ATTEMPTS or attempted <= 0 or actionable_failed <= 0:
        return False
    return (actionable_failed / attempted) * 100 >= ENRICHMENT_ALERT_FAILURE_RATE_PERCENT


def _is_high_failure_alert_in_cooldown(details: dict[str, Any]) -> bool:
    state = get_runtime_state([HIGH_FAILURE_ALERT_RUNTIME_KEY]).get(HIGH_FAILURE_ALERT_RUNTIME_KEY)
    if not state:
        return False

    try:
        payload = json.loads(state["value"])
    except Exception:
        return False

    previous_details = payload.get("details") or {}
    fingerprint = {
        "failure_breakdown": details.get("failure_breakdown"),
        "stop_error_code": details.get("stop_error_code"),
        "failure_rate_percent": details.get("failure_rate_percent"),
    }
    previous_fingerprint = {
        "failure_breakdown": previous_details.get("failure_breakdown"),
        "stop_error_code": previous_details.get("stop_error_code"),
        "failure_rate_percent": previous_details.get("failure_rate_percent"),
    }
    if fingerprint != previous_fingerprint:
        return False

    updated_at = state.get("updated_at")
    if not updated_at:
        return False

    try:
        updated_at_dt = datetime.strptime(updated_at, "%Y-%m-%d %H:%M:%S")
    except ValueError:
        return False

    return datetime.utcnow() - updated_at_dt < timedelta(minutes=ENRICHMENT_ALERT_COOLDOWN_MINUTES)


def _maybe_alert_high_failure_rate(summary: dict[str, Any], *, limit: int) -> None:
    if not _should_send_high_failure_alert(summary):
        return

    details = _build_high_failure_alert_details(summary, limit=limit)
    if _is_high_failure_alert_in_cooldown(details):
        return

    lines = [
        "Hunt alert: enrichment failure rate is high.",
        f"Attempted: {details['attempted']}",
        f"Actionable failed: {details['actionable_failed']}",
        f"Failure rate: {details['failure_rate_percent']}%",
    ]
    if details.get("stop_error_code"):
        lines.append(f"Stop error: {details['stop_error_code']}")
    if details["failure_breakdown"]:
        lines.append(
            "Breakdown: "
            + ", ".join(
                f"{error_code}={count}"
                for error_code, count in sorted(details["failure_breakdown"].items())
            )
        )

    C1Logger(discord=True).event(
        key=HIGH_FAILURE_ALERT_RUNTIME_KEY,
        level="warn",
        message="\n".join(lines),
        code="high_failure_rate",
        details=details,
        discord=True,
    )


def run_enrichment_round(
    *,
    limit: int,
    storage_state_path: str | None = None,
    headless: bool = True,
    slow_mo: int = 0,
    timeout_ms: int = 45000,
    browser_channel: str | None = None,
    ui_verify_blocked: bool = False,
    return_summary: bool = False,
) -> dict[str, Any] | int:
    """
    One dispatcher round: walk sources in `ENRICHMENT_SOURCE_PRIORITY`, spend up to `limit`
    attempted jobs across sources. Each source uses only rows where `jobs.source` matches.
    """
    _validate_registry()
    remaining = limit
    aggregate: dict[str, Any] = {
        "exit_code": 0,
        "attempted": 0,
        "ui_verified": 0,
        "succeeded": 0,
        "failed": 0,
        "actionable_failed": 0,
        "failure_breakdown": {},
        "total_elapsed_seconds": 0.0,
        "average_seconds_per_job": 0.0,
        "stop_error_code": None,
        "by_source": {},
    }

    for source in ENRICHMENT_SOURCE_PRIORITY:
        if remaining <= 0:
            break
        if source not in _REQUIRES_LINKEDIN_SESSION:
            continue

        requires_li = _REQUIRES_LINKEDIN_SESSION[source]
        ready_count = count_ready_jobs_for_enrichment(sources=(source,))
        use_hiring_cafe_fallback = False
        if source == "linkedin" and ready_count <= 0:
            linkedin_auth = get_linkedin_auth_state()
            if not linkedin_auth.get("available"):
                ready_count = count_ready_linkedin_jobs_for_hiring_cafe_fallback()
                use_hiring_cafe_fallback = ready_count > 0
        if ready_count <= 0:
            continue

        source_limit = min(remaining, ready_count)
        if use_hiring_cafe_fallback:
            print(
                f"[enrich] Dispatching up to {source_limit} LinkedIn row(s) through HiringCafe fallback."
            )
        else:
            print(f"[enrich] Dispatching up to {source_limit} {source} row(s).")

        if requires_li:
            if use_hiring_cafe_fallback:
                summary = _run_hiring_cafe_linkedin_fallback(limit=source_limit)
                source_key = "linkedin_hiring_cafe"
            elif not ensure_linkedin_session(
                storage_state_path=storage_state_path,
                headless=headless,
                slow_mo=slow_mo,
                timeout_ms=timeout_ms,
                browser_channel=browser_channel,
            ):
                fallback_count = count_ready_linkedin_jobs_for_hiring_cafe_fallback()
                if fallback_count > 0:
                    fallback_limit = min(remaining, fallback_count)
                    print(
                        "[enrich] LinkedIn auth unavailable; "
                        f"using HiringCafe fallback for up to {fallback_limit} row(s)."
                    )
                    summary = _run_hiring_cafe_linkedin_fallback(limit=fallback_limit)
                    source_key = "linkedin_hiring_cafe"
                else:
                    print(
                        "[enrich] Skipping LinkedIn enrichment this run: auth unavailable or needs refresh. "
                        "Other sources still run."
                    )
                    continue
            else:
                summary = _run_batch_for_source(
                    source,
                    source_limit=source_limit,
                    storage_state_path=storage_state_path,
                    headless=headless,
                    slow_mo=slow_mo,
                    timeout_ms=timeout_ms,
                    browser_channel=browser_channel,
                    ui_verify_blocked=ui_verify_blocked,
                )
                source_key = source
        else:
            summary = _run_batch_for_source(
                source,
                source_limit=source_limit,
                storage_state_path=storage_state_path,
                headless=headless,
                slow_mo=slow_mo,
                timeout_ms=timeout_ms,
                browser_channel=browser_channel,
                ui_verify_blocked=ui_verify_blocked,
            )
            source_key = source

        _merge_source_summary(aggregate, source_key=source_key, summary=summary)

        remaining -= summary["attempted"]
        if summary["stop_error_code"] and not aggregate["stop_error_code"]:
            aggregate["stop_error_code"] = summary["stop_error_code"]
            if source_key == "linkedin" and summary["stop_error_code"] == "rate_limited":
                blocked_index = get_active_account_index()
                block_account_for_days(blocked_index, days=RATE_LIMIT_BLOCK_DAYS)
                C1Logger(discord=True).event(
                    key="linkedin_last_rate_limited",
                    level="warn",
                    message=f"Hunt: LinkedIn rate-limited. Account {blocked_index} blocked for {RATE_LIMIT_BLOCK_DAYS} day(s).",
                    code="rate_limited",
                    details={"account_index": blocked_index, "blocked_days": RATE_LIMIT_BLOCK_DAYS},
                    discord=True,
                )
                print(
                    f"[enrich] Account {blocked_index} rate-limited; "
                    f"blocked for {RATE_LIMIT_BLOCK_DAYS} day(s)."
                )
                rotation = rotate_linkedin_account(
                    browser_channel=browser_channel,
                    headless=headless,
                    slow_mo=slow_mo,
                    timeout_ms=timeout_ms,
                )
                print(f"[enrich] {rotation['message']}")
            break

    if aggregate["attempted"]:
        aggregate["average_seconds_per_job"] = (
            aggregate["total_elapsed_seconds"] / aggregate["attempted"]
        )
    aggregate["exit_code"] = 0 if aggregate["actionable_failed"] == 0 else 1
    C1Logger(discord=False).event(
        key="hunt_last_enrich_summary",
        level="info" if aggregate["exit_code"] == 0 else "warn",
        message="C1 enrichment round finished.",
        code="enrichment_round_summary",
        details={
            "limit": limit,
            "attempted": aggregate["attempted"],
            "ui_verified": aggregate["ui_verified"],
            "succeeded": aggregate["succeeded"],
            "failed": aggregate["failed"],
            "actionable_failed": aggregate["actionable_failed"],
            "failure_breakdown": dict(aggregate["failure_breakdown"]),
            "stop_error_code": aggregate["stop_error_code"],
            "by_source": aggregate["by_source"],
            "total_elapsed_seconds": aggregate["total_elapsed_seconds"],
            "average_seconds_per_job": aggregate["average_seconds_per_job"],
            "exit_code": aggregate["exit_code"],
        },
    )
    _maybe_alert_high_failure_rate(aggregate, limit=limit)

    if return_summary:
        return aggregate
    return aggregate["exit_code"]
