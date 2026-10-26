"""Authenticated C0 gateway and C1/C2 handoff to the local C3 product service."""

from __future__ import annotations

import base64
import os
import re
from pathlib import Path
from urllib.parse import urlsplit

import httpx
from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import Response
from starlette.concurrency import run_in_threadpool

from backend.gateway import _require_auth

router = APIRouter(prefix="/api/c3", tags=["c3"], dependencies=[Depends(_require_auth)])


def require_same_origin(request: Request) -> None:
    if request.method != "POST":
        return
    origin = request.headers.get("origin")
    if (origin and urlsplit(origin).netloc != request.headers.get("host")) or request.headers.get(
        "sec-fetch-site"
    ) == "cross-site":
        raise HTTPException(403, "Open Applications from this Hunt session.")
    if request.headers.get("content-type", "").split(";")[0] != "application/json":
        raise HTTPException(415, "Use a JSON request.")


def service_token() -> str:
    path = os.environ.get("HUNT_C3_TOKEN_FILE")
    if not path:
        path = str(
            Path(os.environ.get("LOCALAPPDATA", str(Path.home()))) / "Hunt/c3-product/service-token"
        )
    try:
        token = Path(path).read_text(encoding="utf-8").strip()
    except OSError:
        raise HTTPException(503, "Start the C3 service on this computer first.") from None
    if not re.fullmatch(r"[a-f0-9]{64}", token):
        raise HTTPException(503, "C3 pairing key is invalid.")
    return token


async def forward(method: str, path: str, content: bytes = b"") -> Response:
    async with httpx.AsyncClient(timeout=75) as client:
        try:
            result = await client.request(
                method,
                f"http://127.0.0.1:47831/{path}",
                content=content,
                headers={
                    "Authorization": f"Bearer {service_token()}",
                    "Content-Type": "application/json",
                },
            )
        except httpx.HTTPError:
            raise HTTPException(
                503, "C3 is unavailable. Start its local service and connect the browser extension."
            ) from None
    if result.status_code == 401:
        raise HTTPException(
            503, "C3 pairing key does not match. Check the local service connection."
        )
    headers = {"Cache-Control": "no-store", "X-Content-Type-Options": "nosniff"}
    for name in ("Content-Security-Policy", "Referrer-Policy"):
        if name in result.headers:
            headers[name] = result.headers[name]
    return Response(
        result.content,
        status_code=result.status_code,
        media_type=result.headers.get("content-type", "application/json"),
        headers=headers,
    )


def prepared_jobs(job_ids: list[int]) -> list[dict]:
    from hunter.db import get_connection, get_job_by_id

    result = []
    for job_id in dict.fromkeys(job_ids):
        job = get_job_by_id(job_id)
        if not job:
            raise HTTPException(404, f"Job {job_id} was not found.")
        if str(job.get("status") or "").strip().lower() in (
            "applied",
            "canceled",
            "cancelled",
        ) or job.get("discovery_suppressed_reason"):
            raise HTTPException(
                409, f"Job {job_id} is already applied, cancelled, or excluded from discovery."
            )
        if job.get("apply_type") != "external_apply" or job.get("ats_type") not in (
            "workday",
            "greenhouse",
            "lever",
            "ashby",
            "workable",
        ):
            raise HTTPException(
                409, f"Job {job_id} is not a verified supported external application."
            )
        if job.get("enrichment_status") not in ("done", "done_verified"):
            raise HTTPException(409, f"Finish discovery verification for job {job_id} first.")
        if job.get("selected_resume_ready_for_c3") != 1 or not job.get("selected_resume_pdf_path"):
            raise HTTPException(409, f"Prepare and select a C2 resume for job {job_id} first.")
        version_id = job.get("selected_resume_version_id")
        if not version_id:
            raise HTTPException(409, f"Select a valid C2 resume version for job {job_id} first.")
        connection = get_connection()
        try:
            cursor = connection.cursor()
            cursor.execute(
                """
                SELECT v.pdf_path, a.pdf_path AS attempt_pdf_path
                FROM resume_versions v JOIN resume_attempts a ON a.id = v.resume_attempt_id
                WHERE v.id = ? AND v.job_id = ? AND a.job_id = ?
                  AND v.is_selected_for_c3 = TRUE
                  AND a.status IN ('done', 'done_with_flags')
                  AND a.latest_result_kind = 'latest_useful'
                """,
                (version_id, job_id, job_id),
            )
            selected = cursor.fetchone()
        finally:
            connection.close()
        path = Path(job["selected_resume_pdf_path"]).expanduser()
        if (
            not selected
            or not selected["pdf_path"]
            or not selected["attempt_pdf_path"]
            or path.resolve() != Path(selected["pdf_path"]).expanduser().resolve()
            or path.resolve() != Path(selected["attempt_pdf_path"]).expanduser().resolve()
        ):
            raise HTTPException(
                409,
                f"The selected resume for job {job_id} does not match its successful C2 version. Select it again.",
            )
        target = urlsplit(job.get("apply_url") or "")
        host, route = target.hostname or "", target.path
        family = job.get("ats_type")
        supported = (
            family == "workday"
            and re.fullmatch(
                r"[a-z0-9-]+\.[a-z0-9.-]+\.(myworkdayjobs|myworkdaysite)\.com", host, re.I
            )
            and re.search(r"/job/.+", route, re.I)
            or family == "workable"
            and host == "apply.workable.com"
            and re.fullmatch(r"/[^/]+/j/[A-Za-z0-9]+(?:/apply)?/?", route)
            or family == "greenhouse"
            and host
            in ("job-boards.greenhouse.io", "boards.greenhouse.io", "job-boards.eu.greenhouse.io")
            and re.fullmatch(r"/[^/]+/jobs/\d+/?", route)
            or family in ("lever", "ashby")
            and host
            in (
                ("jobs.lever.co", "jobs.eu.lever.co")
                if family == "lever"
                else ("jobs.ashbyhq.com",)
            )
            and re.fullmatch(r"/[^/]+/[a-fA-F0-9-]{36}(?:/(?:apply|application))?/?", route)
        )
        if (
            target.scheme != "https"
            or target.username
            or target.password
            or target.netloc != host
            or not supported
            or re.search(r"%2f|%5c", route, re.I)
        ):
            raise HTTPException(409, f"Job {job_id} needs a verified supported posting link.")
        try:
            if path.stat().st_size > 5 * 1024 * 1024:
                raise HTTPException(409, f"The resume for job {job_id} is too large.")
            pdf = path.read_bytes()
        except OSError:
            raise HTTPException(
                409, f"The selected resume for job {job_id} is unavailable."
            ) from None
        if not pdf.startswith(b"%PDF-"):
            raise HTTPException(409, f"The selected resume for job {job_id} is not a PDF.")
        result.append(
            {
                "url": job.get("apply_url"),
                "title": f"{job.get('company', '')} · {job.get('title', '')}",
                "sourceJobId": job_id,
                "resumeName": path.name,
                "resumeVersion": str(job.get("selected_resume_version_id") or ""),
                "resumeBase64": base64.b64encode(pdf).decode("ascii"),
            }
        )
    return result


@router.post("/handoff")
async def handoff(request: Request):
    import json

    from fastapi.responses import JSONResponse

    require_same_origin(request)
    body = await request.json()
    ids = body.get("job_ids") if isinstance(body, dict) else None
    if (
        not isinstance(ids, list)
        or not 1 <= len(ids) <= 30
        or any(type(i) is not int or i < 1 for i in ids)
    ):
        raise HTTPException(400, "Select between 1 and 30 jobs.")
    outcomes = [{"sourceJobId": job_id, "status": "not_sent"} for job_id in dict.fromkeys(ids)]
    try:
        jobs = await run_in_threadpool(prepared_jobs, ids)
    except HTTPException as error:
        return JSONResponse(
            {"detail": error.detail, "queued": [], "outcomes": outcomes},
            status_code=error.status_code,
        )
    # Validate the entire selection first; bound each transfer to one PDF.
    queued = []
    for job, outcome in zip(jobs, outcomes):
        # Once forwarding starts, a missing confirmation does not prove rejection.
        outcome["status"] = "unconfirmed"
        try:
            response = await forward("POST", "jobs", json.dumps({"jobs": [job]}).encode())
        except HTTPException as error:
            return JSONResponse(
                {
                    "detail": "C3 did not confirm the complete handoff. Open Applications to check progress before continuing.",
                    "queued": queued,
                    "outcomes": outcomes,
                },
                status_code=error.status_code,
            )
        if response.status_code >= 400:
            try:
                reason = json.loads(response.body).get("error", "C3 rejected this application.")
            except (ValueError, AttributeError):
                reason = "C3 rejected this application."
            return JSONResponse(
                {
                    "detail": f"{len(queued)} confirmed in Applications. {reason}",
                    "queued": queued,
                    "outcomes": outcomes,
                },
                status_code=response.status_code,
            )
        try:
            accepted = json.loads(response.body)
        except ValueError:
            accepted = None
        if (
            not isinstance(accepted, list)
            or len(accepted) != 1
            or not isinstance(accepted[0], dict)
            or accepted[0].get("sourceJobId") != job["sourceJobId"]
        ):
            return JSONResponse(
                {
                    "detail": "C3 returned an unexpected job confirmation. Check Applications before retrying.",
                    "queued": queued,
                    "outcomes": outcomes,
                },
                status_code=502,
            )
        queued.extend(accepted)
        outcome["status"] = "confirmed"
    return JSONResponse(queued)


@router.api_route("/{path:path}", methods=["GET", "POST"])
async def proxy(path: str, request: Request):
    require_same_origin(request)
    allowed = path in (
        "",
        "app.js",
        "style.css",
        "state",
        "settings",
        "profile-fields",
        "account",
        "jobs",
        "concurrency",
        "recover-storage",
    ) or re.fullmatch(r"jobs/[a-f0-9-]+/action", path)
    if not allowed:
        raise HTTPException(404)
    body = await request.body()
    if len(body) > 32 * 1024 * 1024:
        raise HTTPException(413, "Request is too large.")
    return await forward(request.method, path, body)
