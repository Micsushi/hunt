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

from collections.abc import Callable
from typing import Any

from hunter.c1_logging import C1Logger
from hunter.db import (
    ENRICHMENT_SOURCE_PRIORITY,
    count_ready_jobs_for_enrichment,
    get_linkedin_auth_state,
)
from hunter.linkedin_session import (
    attempt_auto_relogin,
    block_account_for_days,
    get_active_account_index,
    rotate_linkedin_account,
)

RATE_LIMIT_BLOCK_DAYS = 1


def _get_linkedin_process_batch() -> Callable[..., dict[str, Any]]:
    from hunter.enrich_linkedin import process_batch

    return process_batch


def _get_indeed_process_batch() -> Callable[..., dict[str, Any]]:
    from hunter.enrich_indeed import process_batch

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
    raise RuntimeError(f"Unhandled enrichment source {source!r}: add a branch in _run_batch_for_source")


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
        if ready_count <= 0:
            continue

        source_limit = min(remaining, ready_count)
        print(f"[enrich] Dispatching up to {source_limit} {source} row(s).")

        if requires_li:
            if not ensure_linkedin_session(
                storage_state_path=storage_state_path,
                headless=headless,
                slow_mo=slow_mo,
                timeout_ms=timeout_ms,
                browser_channel=browser_channel,
            ):
                print(
                    "[enrich] Skipping LinkedIn enrichment this run: auth unavailable or needs refresh. "
                    "Other sources still run."
                )
                continue

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

        aggregate["by_source"][source] = summary
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

        remaining -= summary["attempted"]
        if summary["stop_error_code"] and not aggregate["stop_error_code"]:
            aggregate["stop_error_code"] = summary["stop_error_code"]
            if source == "linkedin" and summary["stop_error_code"] == "rate_limited":
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

    if return_summary:
        return aggregate
    return aggregate["exit_code"]
