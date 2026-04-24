"""C1 Hunter component service API."""

from __future__ import annotations

import threading

from fastapi import BackgroundTasks, Depends, FastAPI, HTTPException
from pydantic import BaseModel

from hunter.service_auth import require_service_token

app = FastAPI(title="C1 Hunter Service")


# ---------------------------------------------------------------------------
# Background job tracking (simple in-process flags)
# ---------------------------------------------------------------------------

_scrape_lock = threading.Lock()
_enrich_lock = threading.Lock()
_scrape_running = False
_enrich_running = False


def _is_scrape_running() -> bool:
    with _scrape_lock:
        return _scrape_running


def _is_enrich_running() -> bool:
    with _enrich_lock:
        return _enrich_running


# ---------------------------------------------------------------------------
# Models
# ---------------------------------------------------------------------------


class ScrapeRequest(BaseModel):
    enrich_after: bool = True
    enrich_limit: int | None = None


class EnrichRequest(BaseModel):
    limit: int | None = None


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------


@app.get("/status", dependencies=[Depends(require_service_token)])
def get_status():
    from hunter.db import count_pending_jobs_for_enrichment, count_ready_jobs_for_enrichment, get_linkedin_auth_state

    return {
        "service": "c1-hunter",
        "scrape_running": _is_scrape_running(),
        "enrich_running": _is_enrich_running(),
        "queue": {
            "pending": count_pending_jobs_for_enrichment(),
            "ready": count_ready_jobs_for_enrichment(),
        },
        "linkedin_auth": get_linkedin_auth_state(),
    }


@app.get("/queue", dependencies=[Depends(require_service_token)])
def get_queue():
    from hunter.db import count_pending_jobs_for_enrichment, count_ready_jobs_for_enrichment

    return {
        "pending": count_pending_jobs_for_enrichment(),
        "ready": count_ready_jobs_for_enrichment(),
    }


@app.post("/scrape", dependencies=[Depends(require_service_token)])
def post_scrape(req: ScrapeRequest, background_tasks: BackgroundTasks):
    global _scrape_running

    with _scrape_lock:
        if _scrape_running:
            raise HTTPException(status_code=409, detail="Scrape already running")
        _scrape_running = True

    def _run():
        global _scrape_running
        try:
            from hunter.scraper import scrape

            scrape(
                enrich_pending=req.enrich_after,
                enrich_limit=req.enrich_limit,
            )
        finally:
            with _scrape_lock:
                _scrape_running = False

    background_tasks.add_task(_run)
    return {"status": "started"}


@app.post("/enrich", dependencies=[Depends(require_service_token)])
def post_enrich(req: EnrichRequest, background_tasks: BackgroundTasks):
    global _enrich_running

    from hunter.config import ENRICHMENT_BATCH_LIMIT

    with _enrich_lock:
        if _enrich_running:
            raise HTTPException(status_code=409, detail="Enrichment already running")
        _enrich_running = True

    limit = req.limit if req.limit is not None else ENRICHMENT_BATCH_LIMIT

    def _run():
        global _enrich_running
        try:
            from hunter.enrichment_dispatch import run_enrichment_round

            run_enrichment_round(limit=limit, return_summary=True)
        finally:
            with _enrich_lock:
                _enrich_running = False

    background_tasks.add_task(_run)
    return {"status": "started", "limit": limit}


@app.post("/accounts/{account_id}/reauth", dependencies=[Depends(require_service_token)])
def post_reauth(account_id: int, background_tasks: BackgroundTasks):
    from hunter.db import get_connection

    with get_connection() as conn:
        cursor = conn.execute(
            "SELECT id, username, active FROM linkedin_accounts WHERE id = ?",
            (account_id,),
        )
        row = cursor.fetchone()

    if not row:
        raise HTTPException(status_code=404, detail="Account not found")

    def _run():
        from hunter.enrichment_dispatch import ensure_linkedin_session

        ensure_linkedin_session(
            storage_state_path=None,
            headless=True,
            slow_mo=0,
            timeout_ms=45000,
            browser_channel=None,
        )

    background_tasks.add_task(_run)
    return {"status": "started", "account_id": account_id}
