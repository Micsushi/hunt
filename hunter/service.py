"""C1 Hunter component service API."""

from __future__ import annotations

import threading
from contextlib import asynccontextmanager

from fastapi import BackgroundTasks, Depends, FastAPI, HTTPException, Request
from pydantic import BaseModel, model_validator

from hunter.service_auth import require_service_token
from hunter.service_request_id import ServiceRequestIDMiddleware
from shared.mutation_audit import audit_mutation_request


@asynccontextmanager
async def lifespan(app):
    from hunter.db import init_db

    init_db(maintenance=False)
    yield


app = FastAPI(title="C1 Hunter Service", lifespan=lifespan)
app.add_middleware(ServiceRequestIDMiddleware, service_name="c1-hunter")


@app.middleware("http")
async def audit_successful_mutations(request: Request, call_next):
    return await audit_mutation_request(
        request,
        call_next,
        component="c1",
    )


# ---------------------------------------------------------------------------
# Background job tracking (simple in-process flags)
# ---------------------------------------------------------------------------

_scrape_lock = threading.Lock()
_enrich_lock = threading.Lock()
_scrape_running = False
_enrich_running = False


def _is_scrape_running() -> bool:
    from hunter.discovery_run import scan_is_running

    with _scrape_lock:
        return _scrape_running or scan_is_running()


def _is_enrich_running() -> bool:
    with _enrich_lock:
        return _enrich_running


# ---------------------------------------------------------------------------
# Models
# ---------------------------------------------------------------------------


class ScrapeRequest(BaseModel):
    enrich_after: bool = True
    enrich_limit: int | None = None
    full_backfill: bool = False


class EnrichRequest(BaseModel):
    limit: int | None = None


class CompanyPreviewRequest(BaseModel):
    company: str
    url: str


class ConfigPatchRequest(BaseModel):
    @model_validator(mode="before")
    @classmethod
    def validate_settings(cls, data):
        from hunter.user_config import validate

        validate(data)
        if any(value is None for value in data.values()):
            raise ValueError("Omit unchanged settings instead of sending null")
        return data

    watchlist: list[str] | None = None
    company_blocklist: list[str] | None = None
    target_job_titles: dict[str, list[str]] | None = None
    experience_levels: list[str] | None = None
    title_blacklist: list[str] | None = None
    search_terms: dict[str, list[str]] | None = None
    include_experienced_roles: bool | None = None
    discovery_countries: list[str] | None = None
    career_stages: list[str] | None = None
    employment_types: list[str] | None = None
    remote_only: bool | None = None
    country_indeed: str | None = None
    locations: list[str] | None = None
    sites: list[str] | None = None
    max_workers: int | None = None
    results_wanted: int | None = None
    hours_old: int | None = None
    run_interval_seconds: int | None = None
    backfill_interval_seconds: int | None = None
    backfill_hours_old: int | None = None
    public_feed_discovery: bool | None = None
    company_career_sites: dict[str, str | list[str]] | None = None
    enrich_after_scrape: bool | None = None
    enrichment_batch_limit: int | None = None
    linkedin_fetch_description: bool | None = None
    enrichment_timeout_ms: int | None = None
    enrichment_max_attempts: int | None = None
    enrichment_alert_failure_rate_percent: int | None = None
    enrichment_alert_cooldown_minutes: int | None = None


class C3OutcomeRequest(BaseModel):
    outcome: str
    reason: str | None = None


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------


@app.get("/status", dependencies=[Depends(require_service_token)])
def get_status():
    from hunter.db import (
        count_pending_jobs_for_enrichment,
        count_ready_jobs_for_enrichment,
        count_ready_public_employer_jobs,
        get_linkedin_auth_state,
    )

    return {
        "service": "c1-hunter",
        "scrape_running": _is_scrape_running(),
        "enrich_running": _is_enrich_running(),
        "queue": {
            "pending": count_pending_jobs_for_enrichment(),
            "ready": count_ready_jobs_for_enrichment() + count_ready_public_employer_jobs(),
        },
        "linkedin_auth": get_linkedin_auth_state(),
    }


@app.get("/queue", dependencies=[Depends(require_service_token)])
def get_queue():
    from hunter.db import (
        count_pending_jobs_for_enrichment,
        count_ready_jobs_for_enrichment,
        count_ready_public_employer_jobs,
    )

    return {
        "pending": count_pending_jobs_for_enrichment(),
        "ready": count_ready_jobs_for_enrichment() + count_ready_public_employer_jobs(),
    }


@app.post("/scrape", dependencies=[Depends(require_service_token)])
def post_scrape(req: ScrapeRequest, background_tasks: BackgroundTasks):
    global _scrape_running
    from hunter.discovery_run import scan_is_running

    with _scrape_lock:
        if _scrape_running or scan_is_running():
            raise HTTPException(status_code=409, detail="Scrape already running")
        _scrape_running = True

    def _run():
        global _scrape_running
        try:
            from hunter.scraper import scrape

            options = {}
            if req.full_backfill:
                from hunter.config import BACKFILL_HOURS_OLD

                options = {
                    "hours_old": BACKFILL_HOURS_OLD,
                    "include_public_sources": True,
                    "include_company_queue": True,
                }
            scrape(
                enrich_pending=req.enrich_after,
                enrich_limit=req.enrich_limit,
                **options,
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


@app.get("/config", dependencies=[Depends(require_service_token)])
def get_config():
    from hunter import config
    from hunter import user_config as _uc
    from hunter.config import (
        BACKFILL_HOURS_OLD,
        BACKFILL_INTERVAL_SECONDS,
        COMPANY_CAREER_SITES,
        ENRICH_AFTER_SCRAPE,
        ENRICHMENT_ALERT_COOLDOWN_MINUTES,
        ENRICHMENT_ALERT_FAILURE_RATE_PERCENT,
        ENRICHMENT_BATCH_LIMIT,
        ENRICHMENT_MAX_ATTEMPTS,
        ENRICHMENT_TIMEOUT_MS,
        HOURS_OLD,
        INCLUDE_EXPERIENCED_ROLES,
        LINKEDIN_FETCH_DESCRIPTION,
        LOCATIONS,
        MAX_WORKERS,
        PUBLIC_FEED_DISCOVERY,
        RESULTS_WANTED,
        RUN_INTERVAL_SECONDS,
        SEARCH_TERMS,
        SITES,
        TITLE_BLACKLIST,
        WATCHLIST,
    )

    cfg_path = _uc.get_path()
    effective = {
        **{
            key: getattr(config, key.upper())
            for key in (
                "target_job_titles",
                "experience_levels",
                "company_blocklist",
                "discovery_countries",
                "career_stages",
                "employment_types",
                "remote_only",
                "country_indeed",
            )
        },
        "config_file": str(cfg_path),
        "config_file_exists": cfg_path.exists(),
        "watchlist": WATCHLIST,
        "title_blacklist": TITLE_BLACKLIST,
        "search_terms": SEARCH_TERMS,
        "targeting_configured": config.TARGETING_CONFIGURED,
        "include_experienced_roles": INCLUDE_EXPERIENCED_ROLES,
        "locations": LOCATIONS,
        "sites": SITES,
        "max_workers": MAX_WORKERS,
        "results_wanted": RESULTS_WANTED,
        "hours_old": HOURS_OLD,
        "run_interval_seconds": RUN_INTERVAL_SECONDS,
        "backfill_interval_seconds": BACKFILL_INTERVAL_SECONDS,
        "backfill_hours_old": BACKFILL_HOURS_OLD,
        "public_feed_discovery": PUBLIC_FEED_DISCOVERY,
        "company_career_sites": COMPANY_CAREER_SITES,
        "enrich_after_scrape": ENRICH_AFTER_SCRAPE,
        "linkedin_fetch_description": LINKEDIN_FETCH_DESCRIPTION,
        "enrichment_batch_limit": ENRICHMENT_BATCH_LIMIT,
        "enrichment_timeout_ms": ENRICHMENT_TIMEOUT_MS,
        "enrichment_max_attempts": ENRICHMENT_MAX_ATTEMPTS,
        "enrichment_alert_failure_rate_percent": ENRICHMENT_ALERT_FAILURE_RATE_PERCENT,
        "enrichment_alert_cooldown_minutes": ENRICHMENT_ALERT_COOLDOWN_MINUTES,
    }
    saved = {key: value for key, value in _uc.load().items() if key in effective}
    return {
        **effective,
        **saved,
        "effective": effective,
        "restart_required": any(effective[key] != value for key, value in saved.items()),
    }


@app.patch("/config", dependencies=[Depends(require_service_token)])
def patch_config(req: ConfigPatchRequest):
    from hunter import user_config as _uc

    updates = req.model_dump(exclude_unset=True)
    if not updates:
        raise HTTPException(status_code=400, detail="No fields provided")
    merged = _uc.patch(updates)
    cfg_path = _uc.get_path()
    return {
        "saved": True,
        "config_file": str(cfg_path),
        "updated_keys": list(updates.keys()),
        "config": merged,
    }


@app.get("/discovery/health", dependencies=[Depends(require_service_token)])
def get_discovery_health():
    from hunter.config import discovery_geography_limits
    from hunter.db import (
        list_company_fetch_queue,
        list_discovery_source_health,
        public_verification_health,
    )
    from hunter.discovery_run import read_progress, scan_is_running

    return {
        "sources": list_discovery_source_health(),
        "company_fetch_queue": list_company_fetch_queue(),
        "unimplemented_sources": [],
        "geography_limits": discovery_geography_limits(),
        "public_verification": public_verification_health(),
        "scan": {**read_progress(), "running": scan_is_running()},
    }


@app.post("/discovery/preview", dependencies=[Depends(require_service_token)])
def post_company_preview(req: CompanyPreviewRequest):
    from hunter.company_preview import preview_company

    try:
        return preview_company(req.company, req.url)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.get("/c3/ready", dependencies=[Depends(require_service_token)])
def get_c3_ready(limit: int = 50):
    from hunter.db import get_apply_context_for_job, list_c3_ready_jobs

    return {
        "jobs": [get_apply_context_for_job(row["id"]) for row in list_c3_ready_jobs(limit=limit)]
    }


@app.post("/jobs/{job_id}/c3-outcome", dependencies=[Depends(require_service_token)])
def post_c3_outcome(job_id: int, req: C3OutcomeRequest):
    from hunter.db import record_c3_outcome

    try:
        updated = record_c3_outcome(job_id, outcome=req.outcome, reason=req.reason)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    if not updated:
        raise HTTPException(status_code=404, detail="Job not found")
    return {"job_id": job_id, "outcome": req.outcome, "reason": req.reason}


@app.post("/test-discord", dependencies=[Depends(require_service_token)])
def post_test_discord():
    from shared.notifications import send_discord_webhook_message

    result = send_discord_webhook_message(
        "C1 Hunter: Discord webhook test from operator UI.",
        username="Hunt C1",
        timeout_seconds=10,
    )
    if not result["sent"]:
        raise HTTPException(status_code=502, detail=result.get("reason", "Discord send failed"))
    return {"sent": True, "status_code": result.get("status_code")}


@app.post("/accounts/{account_id}/reauth", dependencies=[Depends(require_service_token)])
def post_reauth(account_id: int, background_tasks: BackgroundTasks):
    from hunter.db import get_connection

    conn = get_connection()
    try:
        cursor = conn.execute(
            "SELECT id, username, active FROM linkedin_accounts WHERE id = ?",
            (account_id,),
        )
        row = cursor.fetchone()
    finally:
        conn.close()

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
