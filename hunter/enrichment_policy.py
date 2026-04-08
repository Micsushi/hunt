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

BLOCKED_ERROR_CODES = {
    "security_verification",
    "access_challenged",
}

MANUAL_ACTION_ERROR_CODES = {
    "auth_expired",
}

TERMINAL_ERROR_CODES = {
    "job_removed",
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


def is_terminal_error_code(error_code):
    return error_code in TERMINAL_ERROR_CODES


def requires_manual_action(error_code):
    return error_code in BLOCKED_ERROR_CODES or error_code in MANUAL_ACTION_ERROR_CODES


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
