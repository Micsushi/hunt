"""Shared bearer-token auth dependency for Hunt component service APIs."""

from __future__ import annotations

from fastapi import Header, HTTPException


def require_service_token(authorization: str = Header(default="")) -> None:
    """FastAPI dependency — validates HUNT_SERVICE_TOKEN bearer auth.

    When HUNT_SERVICE_TOKEN is blank (dev mode), all requests pass through.
    """
    from hunter.config import HUNT_SERVICE_TOKEN

    if not HUNT_SERVICE_TOKEN:
        return  # auth disabled in dev

    scheme, _, provided = authorization.partition(" ")
    if scheme.lower() != "bearer" or provided != HUNT_SERVICE_TOKEN:
        raise HTTPException(status_code=401, detail="Invalid or missing service token")
