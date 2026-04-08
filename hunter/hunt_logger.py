"""
Deprecated: use `hunter/c1_logging.py`.

Kept temporarily so older imports don't break during refactors.
"""

try:
    from c1_logging import C1LogEvent as HuntLogEvent  # type: ignore # noqa: F401
    from c1_logging import C1Logger as HuntLogger  # type: ignore # noqa: F401
except ImportError:
    from .c1_logging import C1LogEvent as HuntLogEvent  # type: ignore # noqa: F401
    from .c1_logging import C1Logger as HuntLogger  # type: ignore # noqa: F401
