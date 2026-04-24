"""C0 gateway routes — proxy calls to C1/C2/C4 component services.

Mounted on the main FastAPI app under /api/gateway.
All routes require the review-app session auth (require_auth).
The gateway adds the HUNT_SERVICE_TOKEN bearer header before forwarding.
"""

from __future__ import annotations

import httpx
from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import JSONResponse

router = APIRouter(prefix="/api/gateway", tags=["gateway"])


def _require_auth(request: Request) -> str:
    """Reuse the same session-cookie auth as the rest of the review app."""
    from backend.auth_session import validate_session, SESSION_COOKIE_NAME

    token = request.cookies.get(SESSION_COOKIE_NAME, "")
    username = validate_session(token)
    if not username:
        raise HTTPException(status_code=401, detail="Not authenticated")
    return username


def _service_headers() -> dict[str, str]:
    from hunter.config import HUNT_SERVICE_TOKEN

    if HUNT_SERVICE_TOKEN:
        return {"Authorization": f"Bearer {HUNT_SERVICE_TOKEN}"}
    return {}


async def _proxy_get(url: str) -> JSONResponse:
    async with httpx.AsyncClient(timeout=10) as client:
        try:
            resp = await client.get(url, headers=_service_headers())
        except httpx.ConnectError:
            raise HTTPException(status_code=503, detail=f"Service unavailable: {url}")
    return JSONResponse(content=resp.json(), status_code=resp.status_code)


async def _proxy_post(url: str, body: dict | None = None) -> JSONResponse:
    async with httpx.AsyncClient(timeout=30) as client:
        try:
            resp = await client.post(url, json=body or {}, headers=_service_headers())
        except httpx.ConnectError:
            raise HTTPException(status_code=503, detail=f"Service unavailable: {url}")
    return JSONResponse(content=resp.json(), status_code=resp.status_code)


# ---------------------------------------------------------------------------
# C1 Hunter routes
# ---------------------------------------------------------------------------


@router.get("/c1/status")
async def c1_status(_auth: str = Depends(_require_auth)):
    from hunter.config import HUNT_HUNTER_URL

    return await _proxy_get(f"{HUNT_HUNTER_URL}/status")


@router.get("/c1/queue")
async def c1_queue(_auth: str = Depends(_require_auth)):
    from hunter.config import HUNT_HUNTER_URL

    return await _proxy_get(f"{HUNT_HUNTER_URL}/queue")


@router.post("/c1/scrape")
async def c1_scrape(request: Request, _auth: str = Depends(_require_auth)):
    from hunter.config import HUNT_HUNTER_URL

    body = await request.json() if request.headers.get("content-type", "").startswith("application/json") else {}
    return await _proxy_post(f"{HUNT_HUNTER_URL}/scrape", body)


@router.post("/c1/enrich")
async def c1_enrich(request: Request, _auth: str = Depends(_require_auth)):
    from hunter.config import HUNT_HUNTER_URL

    body = await request.json() if request.headers.get("content-type", "").startswith("application/json") else {}
    return await _proxy_post(f"{HUNT_HUNTER_URL}/enrich", body)


@router.post("/c1/accounts/{account_id}/reauth")
async def c1_reauth(account_id: int, _auth: str = Depends(_require_auth)):
    from hunter.config import HUNT_HUNTER_URL

    return await _proxy_post(f"{HUNT_HUNTER_URL}/accounts/{account_id}/reauth")


# ---------------------------------------------------------------------------
# C2 Fletcher routes
# ---------------------------------------------------------------------------


@router.get("/c2/status")
async def c2_status(_auth: str = Depends(_require_auth)):
    from hunter.config import HUNT_FLETCHER_URL

    return await _proxy_get(f"{HUNT_FLETCHER_URL}/status")


@router.post("/c2/generate")
async def c2_generate(request: Request, _auth: str = Depends(_require_auth)):
    from hunter.config import HUNT_FLETCHER_URL

    body = await request.json()
    return await _proxy_post(f"{HUNT_FLETCHER_URL}/generate", body)


@router.post("/c2/generate-once")
async def c2_generate_once(request: Request, _auth: str = Depends(_require_auth)):
    from hunter.config import HUNT_FLETCHER_URL

    body = await request.json() if request.headers.get("content-type", "").startswith("application/json") else {}
    return await _proxy_post(f"{HUNT_FLETCHER_URL}/generate-once", body)


@router.get("/c2/attempts/{job_id}")
async def c2_attempts(job_id: int, _auth: str = Depends(_require_auth)):
    from hunter.config import HUNT_FLETCHER_URL

    return await _proxy_get(f"{HUNT_FLETCHER_URL}/attempts/{job_id}")


# ---------------------------------------------------------------------------
# C4 Coordinator routes
# ---------------------------------------------------------------------------


@router.get("/c4/status")
async def c4_status(_auth: str = Depends(_require_auth)):
    from hunter.config import HUNT_COORDINATOR_URL

    return await _proxy_get(f"{HUNT_COORDINATOR_URL}/status")


@router.get("/c4/runs")
async def c4_runs(status: str | None = None, limit: int = 20, _auth: str = Depends(_require_auth)):
    from hunter.config import HUNT_COORDINATOR_URL

    params = {}
    if status:
        params["status"] = status
    params["limit"] = str(limit)
    qs = "&".join(f"{k}={v}" for k, v in params.items())
    url = f"{HUNT_COORDINATOR_URL}/runs"
    if qs:
        url = f"{url}?{qs}"
    return await _proxy_get(url)


@router.post("/c4/run")
async def c4_run(request: Request, _auth: str = Depends(_require_auth)):
    from hunter.config import HUNT_COORDINATOR_URL

    body = await request.json()
    return await _proxy_post(f"{HUNT_COORDINATOR_URL}/run", body)


@router.get("/c4/runs/{run_id}")
async def c4_get_run(run_id: str, _auth: str = Depends(_require_auth)):
    from hunter.config import HUNT_COORDINATOR_URL

    return await _proxy_get(f"{HUNT_COORDINATOR_URL}/runs/{run_id}")


@router.post("/c4/runs/{run_id}/approve")
async def c4_approve(run_id: str, request: Request, _auth: str = Depends(_require_auth)):
    from hunter.config import HUNT_COORDINATOR_URL

    body = await request.json()
    return await _proxy_post(f"{HUNT_COORDINATOR_URL}/runs/{run_id}/approve", body)


@router.post("/c4/runs/{run_id}/fill-result")
async def c4_fill_result(run_id: str, request: Request, _auth: str = Depends(_require_auth)):
    from hunter.config import HUNT_COORDINATOR_URL

    body = await request.json()
    return await _proxy_post(f"{HUNT_COORDINATOR_URL}/runs/{run_id}/fill-result", body)
