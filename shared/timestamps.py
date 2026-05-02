from datetime import UTC, datetime


def utc_iso() -> str:
    """Return current UTC time as ISO 8601 string, second precision, e.g. 2025-01-01T12:00:00+00:00."""
    return datetime.now(UTC).replace(microsecond=0).isoformat()
