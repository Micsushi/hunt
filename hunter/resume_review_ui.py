"""Compatibility shim for old C0 resume-review import path.

Canonical module now lives in `backend.resume_review_ui`.
"""

from backend.resume_review_ui import *  # noqa: F401,F403
