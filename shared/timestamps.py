from datetime import UTC, datetime


def utc_iso() -> str:
    """Return current UTC time as ISO 8601, second precision: 2025-01-01T12:00:00+00:00."""
    return datetime.now(UTC).replace(microsecond=0).isoformat()


def utc_now_stamp() -> str:
    """Return current UTC time as compact sortable stamp, e.g. 20250101T120000Z."""
    return datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ")
