"""C4 Coordinator component service API — HTTP wrapper around OrchestrationService."""

from __future__ import annotations

from fastapi import Depends, FastAPI, HTTPException
from pydantic import BaseModel

from hunter.service_auth import require_service_token

app = FastAPI(title="C4 Coordinator Service")


def _get_service():
    from coordinator.service import OrchestrationService

    svc = OrchestrationService()
    svc.ensure_initialized()
    return svc


# ---------------------------------------------------------------------------
# Models
# ---------------------------------------------------------------------------


class StartRunRequest(BaseModel):
    job_id: int
    source_runtime: str = "api"
    browser_lane: str | None = None


class ApproveRequest(BaseModel):
    decision: str  # "approve" or "deny"
    approved_by: str
    reason: str = ""


class FillResultRequest(BaseModel):
    result_json_path: str


class InlineFillResultRequest(BaseModel):
    run_id: str
    payload: dict


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------


@app.get("/status", dependencies=[Depends(require_service_token)])
def get_status():
    svc = _get_service()
    summary = svc.get_readiness_summary()
    return {"service": "c4-coordinator", **summary}


@app.post("/run", dependencies=[Depends(require_service_token)])
def post_run(req: StartRunRequest):
    svc = _get_service()
    from coordinator.service import OrchestrationError

    try:
        run = svc.start_run(
            req.job_id,
            source_runtime=req.source_runtime,
            browser_lane=req.browser_lane,
        )
    except OrchestrationError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    return run.to_dict()


@app.get("/runs", dependencies=[Depends(require_service_token)])
def get_runs(status: str | None = None, limit: int = 20):
    svc = _get_service()
    runs = svc.list_runs(status=status, limit=limit)
    return {"runs": [r.to_dict() for r in runs]}


@app.get("/runs/{run_id}", dependencies=[Depends(require_service_token)])
def get_run(run_id: str):
    svc = _get_service()
    run = svc.get_run(run_id)
    if not run:
        raise HTTPException(status_code=404, detail="Run not found")
    events = svc.list_events(run_id)
    return {**run.to_dict(), "events": [e.to_dict() for e in events]}


@app.post("/runs/{run_id}/approve", dependencies=[Depends(require_service_token)])
def post_approve(run_id: str, req: ApproveRequest):
    svc = _get_service()
    from coordinator.service import OrchestrationError

    try:
        result = svc.approve_submit(
            run_id,
            decision=req.decision,
            approved_by=req.approved_by,
            reason=req.reason,
        )
    except OrchestrationError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    return result


@app.post("/runs/{run_id}/fill-result", dependencies=[Depends(require_service_token)])
def post_fill_result(run_id: str, req: FillResultRequest):
    svc = _get_service()
    from coordinator.service import OrchestrationError

    try:
        result = svc.record_fill_result(run_id, req.result_json_path)
    except OrchestrationError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    return result


# ---------------------------------------------------------------------------
# C3 browser-extension bridge endpoints
# ---------------------------------------------------------------------------


@app.get("/c3/pending-fills", dependencies=[Depends(require_service_token)])
def get_pending_fills(limit: int = 5):
    svc = _get_service()
    return {"fills": svc.get_pending_fills(limit=limit)}


@app.post("/c3/fill-result", dependencies=[Depends(require_service_token)])
def post_fill_result_inline(req: InlineFillResultRequest):
    svc = _get_service()
    from coordinator.service import OrchestrationError

    try:
        result = svc.record_fill_result_inline(req.run_id, req.payload)
    except OrchestrationError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    return result
