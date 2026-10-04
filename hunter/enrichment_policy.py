from collections import Counter
from datetime import UTC, datetime, timedelta

from hunter.config import ENRICHMENT_MAX_ATTEMPTS

RETRYABLE_ERROR_BASE_MINUTES = {
    "rate_limited": 60,
    "unexpected_error": 30,
    "stale_processing": 15,
    "apply_button_not_found": 180,
    "description_not_found": 180,
    "external_description_not_found": 180,
    "external_description_not_usable": 360,
}


def utc_now():
    return datetime.now(UTC)


def format_sqlite_timestamp(value):
    if value is None:
        return None
    return value.astimezone(UTC).strftime("%Y-%m-%d %H:%M:%S")


def get_error_code(error_message):
    if not error_message:
        return "unknown"
    return str(error_message).split(":", 1)[0].strip()


def is_retryable_error_code(error_code):
    return error_code in RETRYABLE_ERROR_BASE_MINUTES


def can_attempt_again(attempts, *, max_attempts=None):
    if max_attempts is None:
        max_attempts = ENRICHMENT_MAX_ATTEMPTS
    return int(attempts or 0) < int(max_attempts)


def compute_retry_after(error_code, attempts, *, now=None, max_attempts=None):
    if not is_retryable_error_code(error_code):
        return None
    if not can_attempt_again(attempts, max_attempts=max_attempts):
        return None

    if now is None:
        now = utc_now()

    base_minutes = RETRYABLE_ERROR_BASE_MINUTES[error_code]
    multiplier = max(1, int(attempts or 1))
    return now + timedelta(minutes=base_minutes * multiplier)


def summarize_batch(
    results, *, elapsed, non_actionable, should_stop, prefix, ui_results=(), auth_paused=False
):
    """Summarize final outcomes while retaining timing for both verification passes."""
    timed = [*results, *ui_results]
    final = list({r["job_id"]: r for r in timed}.values()) if ui_results else results
    failures = [r for r in final if r["status"] == "failed"]
    actionable = sum(not non_actionable(r.get("error_code")) for r in failures)
    paused_count = sum(r["status"] == "auth_paused" for r in final)
    stop = next(
        (r.get("error_code") for r in failures if should_stop(r.get("error_code"))),
        "auth_expired" if auth_paused or paused_count else None,
    )
    summary = {
        "exit_code": int(bool(actionable or auth_paused or paused_count)),
        "attempted": len(results),
        "ui_verified": len(ui_results),
        "succeeded": sum(r["status"] == "success" for r in final),
        "failed": len(failures),
        "actionable_failed": actionable,
        "failure_breakdown": dict(Counter(r["error_code"] for r in failures)),
        "total_elapsed_seconds": elapsed,
        "average_seconds_per_job": sum(r["duration_seconds"] for r in timed) / len(timed)
        if timed
        else 0.0,
        "stop_error_code": stop,
    }
    print(f"\n[{prefix}] Summary")
    for key, value in summary.items():
        print(f"  {key}: {value:.1f}" if isinstance(value, float) else f"  {key}: {value}")
    if auth_paused or paused_count:
        print(f"  auth_paused: {paused_count or 1}")
    return summary


def log_retry_exhausted(claimed_job, *, source, error_code, error_message, provider=None):
    from hunter.c1_logging import C1Logger

    C1Logger(discord=False).event(
        key="hunt_last_retry_exhausted",
        level="warn",
        message="C1 enrichment retries exhausted.",
        code="retry_exhausted",
        details={
            "job_id": claimed_job.get("id"),
            "source": source,
            "error_code": error_code,
            "error_message": error_message,
            "enrichment_attempts": claimed_job.get("enrichment_attempts"),
            **({"provider": provider} if provider else {}),
        },
    )
