"""C2 Fletcher component service API."""

from __future__ import annotations

import threading

from fastapi import BackgroundTasks, Depends, FastAPI, HTTPException
from pydantic import BaseModel

from hunter.service_auth import require_service_token

app = FastAPI(title="C2 Fletcher Service")

_generate_lock = threading.Lock()
_generate_running = False


# ---------------------------------------------------------------------------
# Models
# ---------------------------------------------------------------------------


class GenerateRequest(BaseModel):
    job_id: int


class GenerateReadyRequest(BaseModel):
    limit: int = 25
    only_missing: bool = False


class GenerateAdHocRequest(BaseModel):
    title: str
    company: str = ""
    description: str
    label: str | None = None


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------


@app.get("/status", dependencies=[Depends(require_service_token)])
def get_status():
    return {
        "service": "c2-fletcher",
        "generate_running": _is_generate_running(),
    }


def _is_generate_running() -> bool:
    with _generate_lock:
        return _generate_running


@app.post("/generate", dependencies=[Depends(require_service_token)])
def post_generate(req: GenerateRequest):
    """Generate resume for a single queued job (synchronous — returns result)."""
    from fletcher.pipeline import generate_resume_for_job

    try:
        result = generate_resume_for_job(req.job_id)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    return result


@app.post("/generate-once", dependencies=[Depends(require_service_token)])
def post_generate_once(req: GenerateReadyRequest, background_tasks: BackgroundTasks):
    """Process a batch of ready jobs in the background."""
    global _generate_running

    with _generate_lock:
        if _generate_running:
            raise HTTPException(status_code=409, detail="Generation already running")
        _generate_running = True

    def _run():
        global _generate_running
        try:
            from fletcher.pipeline import generate_resumes_for_ready_jobs

            generate_resumes_for_ready_jobs(limit=req.limit, only_missing=req.only_missing)
        finally:
            with _generate_lock:
                _generate_running = False

    background_tasks.add_task(_run)
    return {"status": "started", "limit": req.limit, "only_missing": req.only_missing}


@app.post("/generate-adhoc", dependencies=[Depends(require_service_token)])
def post_generate_adhoc(req: GenerateAdHocRequest):
    """Generate resume for an ad-hoc job description (synchronous)."""
    from fletcher.pipeline import generate_resume_for_ad_hoc

    result = generate_resume_for_ad_hoc(
        title=req.title,
        company=req.company,
        description=req.description,
        label=req.label,
    )
    return result


@app.get("/attempts/{job_id}", dependencies=[Depends(require_service_token)])
def get_attempts(job_id: int, limit: int = 10):
    from fletcher.db import list_resume_attempts

    attempts = list_resume_attempts(job_id, limit=limit)
    if not attempts:
        raise HTTPException(status_code=404, detail="No attempts found for job")
    return {"job_id": job_id, "attempts": attempts}
