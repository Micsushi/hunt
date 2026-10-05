"""Upload boundary shared by C0 and the standalone C2 service."""

from pathlib import Path
from tempfile import TemporaryDirectory

from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from starlette.concurrency import run_in_threadpool

from fletcher.resume_checker import check_resume_upload

router = APIRouter()


@router.post("/check")
async def check_uploaded_resume(
    resume: UploadFile = File(...), job_details: str = Form("", max_length=100_000)
):
    suffix = Path(resume.filename or "").suffix.lower()
    if suffix not in {".pdf", ".tex"}:
        raise HTTPException(422, "Choose a PDF or TeX resume.")
    data = await resume.read(10 * 1024 * 1024 + 1)
    if not data or len(data) > 10 * 1024 * 1024:
        raise HTTPException(422, "Resume must contain data and be 10 MB or smaller.")
    with TemporaryDirectory(prefix="hunt-resume-upload-") as directory:
        path = Path(directory) / ("resume" + suffix)
        path.write_bytes(data)
        try:
            return await run_in_threadpool(check_resume_upload, path, job_description=job_details)
        except ValueError as exc:
            raise HTTPException(422, str(exc)) from exc
        except RuntimeError as exc:
            raise HTTPException(503, str(exc)) from exc
