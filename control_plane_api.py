"""Backward-compatible shim for the old control_plane_api entrypoint.

Canonical C0 backend entrypoint now lives in `backend/app.py`.
"""

from backend.app import *  # noqa: F401,F403


if __name__ == "__main__":
    from backend.app import main

    main()

