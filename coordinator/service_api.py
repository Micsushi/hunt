"""C4 Coordinator component service API - HTTP wrapper around OrchestrationService."""

from __future__ import annotations

from fastapi import Depends, FastAPI, HTTPException
from pydantic import BaseModel

from hunter.service_auth import require_service_token
from hunter.service_request_id import ServiceRequestIDMiddleware

app = FastAPI(title="C4 Coordinator Service")
app.add_middleware(ServiceRequestIDMiddleware, service_name="c4-coordinator")


def _get_service():
    from coordinator.service import OrchestrationService

    svc = OrchestrationService()
    svc.ensure_initialized()
    return svc


@app.on_event("startup")
def _startup() -> None:
    from coordinator import telegram as tg

    svc = _get_service()

    def _approve(args: list[str]) -> str:
        if not args:
            return "Usage: approve <run_id>"
        try:
            svc.approve_submit(args[0], decision="approve", approved_by="telegram")
            return f"Approved submit for {args[0]}"
        except Exception as exc:
            return f"Error: {exc}"

    def _deny(args: list[str]) -> str:
        if not args:
            return "Usage: deny <run_id>"
        try:
            svc.approve_submit(args[0], decision="deny", approved_by="telegram")
            return f"Denied submit for {args[0]}"
        except Exception as exc:
            return f"Error: {exc}"

    def _skip(args: list[str]) -> str:
        if not args:
            return "Usage: skip <job_id>"
        try:
            conn = svc._connect().__enter__()  # type: ignore[attr-defined]
            conn.execute("UPDATE jobs SET status = 'skipped' WHERE id = ?", (int(args[0]),))
            conn.commit()
            conn.close()
            return f"Job {args[0]} marked skipped"
        except Exception as exc:
            return f"Error: {exc}"

    def _investigate(args: list[str]) -> str:
        if not args:
            return "Usage: investigate <run_id>"
        try:
            svc.queue_investigation(args[0])
            return f"Investigation queued for {args[0]}"
        except Exception as exc:
            return f"Error: {exc}"

    def _allow_submit(args: list[str]) -> str:
        if not args:
            return "Usage: allow-submit <run_id>"
        try:
            svc.approve_submit(args[0], decision="approve", approved_by="telegram")
            return f"Submit enabled for {args[0]}"
        except Exception as exc:
            return f"Error: {exc}"

    def _status(_args: list[str]) -> str:
        try:
            from coordinator.scheduler import get_scheduler

            summary = svc.get_readiness_summary(sample_limit=3)
            sched = get_scheduler(svc).status()
            return (
                f"Ready: {summary['ready_count']} / {summary['total_jobs']} jobs\n"
                f"Scheduler: {'running' if sched['running'] else 'stopped'} "
                f"(ticks: {sched['tick_count']})\n"
                f"Global hold: {summary['global_hold']['blocked']}"
            )
        except Exception as exc:
            return f"Error: {exc}"

    tg.register_handler("approve", _approve)
    tg.register_handler("deny", _deny)
    tg.register_handler("skip", _skip)
    tg.register_handler("investigate", _investigate)
    tg.register_handler("allow-submit", _allow_submit)
    tg.register_handler("status", _status)
    tg.start_polling()


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


class WorkerClaimRequest(BaseModel):
    runtime_name: str
    browser_lane: str | None = None
    lease_seconds: int = 900
    worker_metadata: dict | None = None


class WorkerHeartbeatRequest(BaseModel):
    lease_seconds: int = 900


class WorkerResultRequest(BaseModel):
    payload: dict


class ReconcileStaleRequest(BaseModel):
    fill_timeout_minutes: int = 30
    submit_confirm_timeout_minutes: int | None = None


class SchedulerStartRequest(BaseModel):
    interval_seconds: int = 60
    browser_lane: str | None = None


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


@app.post("/runs/{run_id}/request-fill", dependencies=[Depends(require_service_token)])
def post_request_fill(run_id: str):
    svc = _get_service()
    from coordinator.service import OrchestrationError

    try:
        return svc.request_fill(run_id)
    except OrchestrationError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


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
# Generic worker endpoints for C3/OpenClaw/Hermes
# ---------------------------------------------------------------------------


@app.post("/workers/claim", dependencies=[Depends(require_service_token)])
def post_worker_claim(req: WorkerClaimRequest):
    svc = _get_service()
    from coordinator.service import OrchestrationError

    try:
        return svc.claim_next_fill(
            runtime_name=req.runtime_name,
            browser_lane=req.browser_lane,
            lease_seconds=req.lease_seconds,
            worker_metadata=req.worker_metadata,
        )
    except OrchestrationError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@app.post("/workers/claim-investigation", dependencies=[Depends(require_service_token)])
def post_investigation_claim(req: WorkerClaimRequest):
    svc = _get_service()
    from coordinator.service import OrchestrationError

    try:
        return svc.claim_next_fill(
            runtime_name=req.runtime_name,
            browser_lane=req.browser_lane,
            lease_seconds=req.lease_seconds,
            worker_metadata=req.worker_metadata,
            task_type="investigation",
        )
    except OrchestrationError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@app.post("/workers/{lease_id}/heartbeat", dependencies=[Depends(require_service_token)])
def post_worker_heartbeat(lease_id: str, req: WorkerHeartbeatRequest | None = None):
    svc = _get_service()
    from coordinator.service import OrchestrationError

    lease_seconds = req.lease_seconds if req else 900
    try:
        return svc.heartbeat_lease(lease_id, lease_seconds=lease_seconds)
    except OrchestrationError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@app.post("/workers/{lease_id}/result", dependencies=[Depends(require_service_token)])
def post_worker_result(lease_id: str, req: WorkerResultRequest):
    svc = _get_service()
    from coordinator.service import OrchestrationError

    try:
        return svc.complete_lease_with_result(lease_id, req.payload)
    except OrchestrationError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@app.post("/maintenance/reconcile-stale", dependencies=[Depends(require_service_token)])
def post_reconcile_stale(req: ReconcileStaleRequest):
    svc = _get_service()
    return svc.reconcile_stale_runs(
        fill_timeout_minutes=req.fill_timeout_minutes,
        submit_confirm_timeout_minutes=req.submit_confirm_timeout_minutes,
    )


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


# ---------------------------------------------------------------------------
# Investigation routes
# ---------------------------------------------------------------------------


@app.post("/runs/{run_id}/investigate", dependencies=[Depends(require_service_token)])
def post_queue_investigation(run_id: str):
    svc = _get_service()
    from coordinator.service import OrchestrationError

    try:
        return svc.queue_investigation(run_id)
    except OrchestrationError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


# ---------------------------------------------------------------------------
# Failure log
# ---------------------------------------------------------------------------


@app.get("/failures", dependencies=[Depends(require_service_token)])
def get_failures(limit: int = 100):
    svc = _get_service()
    return {"failures": svc.get_failure_log(limit=limit)}


@app.get("/runs/{run_id}/failure-report", dependencies=[Depends(require_service_token)])
def get_failure_report(run_id: str):
    import json
    from pathlib import Path

    svc = _get_service()
    run = svc.get_run(run_id)
    if not run:
        raise HTTPException(status_code=404, detail="Run not found")
    if not run.failure_report_path:
        raise HTTPException(status_code=404, detail="No failure report for this run")
    path = Path(run.failure_report_path)
    if not path.exists():
        raise HTTPException(status_code=404, detail="Failure report file missing")
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))


# ---------------------------------------------------------------------------
# Scheduler
# ---------------------------------------------------------------------------


def _get_scheduler():
    from coordinator.scheduler import get_scheduler

    svc = _get_service()
    return get_scheduler(svc)


@app.get("/scheduler/status", dependencies=[Depends(require_service_token)])
def get_scheduler_status():
    return _get_scheduler().status()


@app.post("/scheduler/tick", dependencies=[Depends(require_service_token)])
def post_scheduler_tick():
    from coordinator.service import OrchestrationError

    try:
        return _get_scheduler().tick()
    except OrchestrationError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@app.post("/scheduler/start", dependencies=[Depends(require_service_token)])
def post_scheduler_start(req: SchedulerStartRequest):
    sched = _get_scheduler()
    sched.interval = req.interval_seconds
    if req.browser_lane is not None:
        sched.browser_lane = req.browser_lane
    sched.start()
    return sched.status()


@app.post("/scheduler/stop", dependencies=[Depends(require_service_token)])
def post_scheduler_stop():
    _get_scheduler().stop()
    return _get_scheduler().status()
