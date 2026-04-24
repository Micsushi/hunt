"""Compatibility shim for old C0 auth import path.

Canonical module now lives in `backend.auth_session`.
"""

from backend.auth_session import *  # noqa: F401,F403

