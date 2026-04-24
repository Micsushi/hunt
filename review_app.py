"""Backward-compatible shim for the old review_app entrypoint.

Canonical C0 backend entrypoint now lives in `backend/app.py`.
"""

from backend.app import app  # noqa: F401


if __name__ == "__main__":
    from backend.app import main

    main()
