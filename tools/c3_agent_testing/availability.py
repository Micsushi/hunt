from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import unquote, urlsplit
from urllib.request import Request, urlopen


@dataclass(frozen=True)
class AvailabilityResult:
    status: str
    reason: str
    http_status: int | None = None
    details: dict[str, Any] | None = None


def classify_http_status(status: int) -> str:
    if 200 <= status < 300:
        return "live"
    if status in {404, 410}:
        return "expired"
    if status in {401, 403}:
        return "unknown_browser_check"
    return "unknown"


def workday_cxs_url(job_url: str) -> str:
    parsed = urlsplit(job_url)
    host = parsed.hostname or ""
    if ".myworkdayjobs.com" not in host:
        raise ValueError("not_workday_job_url")
    tenant = host.split(".", 1)[0]
    segments = [unquote(value) for value in parsed.path.split("/") if value]
    if segments and _looks_like_locale(segments[0]):
        segments = segments[1:]
    try:
        job_index = segments.index("job")
    except ValueError as exc:
        raise ValueError("workday_job_path_missing") from exc
    if job_index < 1 or not segments[-1]:
        raise ValueError("workday_job_identity_missing")
    site = segments[job_index - 1]
    job_path = "/".join(segments[job_index + 1 :])
    if not job_path or not segments[-1].rsplit("_", 1)[-1]:
        raise ValueError("workday_job_id_missing")
    return f"{parsed.scheme or 'https'}://{host}/wday/cxs/{tenant}/{site}/job/{job_path}"


def check_workday_job(job: Any, *, timeout_seconds: float = 10) -> AvailabilityResult:
    try:
        endpoint = workday_cxs_url(str(job.url))
    except (AttributeError, ValueError) as exc:
        return AvailabilityResult("unknown", str(exc))
    request = Request(
        endpoint,
        headers={
            "Accept": "application/json",
            "User-Agent": "Hunt-C3-Availability/1.0",
        },
    )
    try:
        with urlopen(request, timeout=timeout_seconds) as response:
            status = int(response.status)
            payload = json.loads(response.read().decode("utf-8"))
    except HTTPError as exc:
        status = int(exc.code)
        return AvailabilityResult(
            classify_http_status(status), f"http_{status}", http_status=status
        )
    except (URLError, TimeoutError, json.JSONDecodeError, OSError) as exc:
        return AvailabilityResult("unknown", f"availability_error:{type(exc).__name__}")

    posting = payload.get("jobPostingInfo") if isinstance(payload, dict) else None
    posting = posting if isinstance(posting, dict) else {}
    can_apply = posting.get("canApply")
    posted = posting.get("posted")
    if can_apply is False or posted is False:
        return AvailabilityResult(
            "expired",
            "cxs_not_applyable",
            http_status=status,
            details={"canApply": can_apply, "posted": posted},
        )
    return AvailabilityResult(
        "live",
        "cxs_can_apply",
        http_status=status,
        details={"canApply": can_apply, "posted": posted},
    )


def fetch_current_workday_postings(
    job: Any,
    *,
    limit: int = 5,
    timeout_seconds: float = 10,
    opener: Any = urlopen,
) -> list[dict[str, Any]]:
    """List current postings from the same Workday tenant/site as an old CSV row."""

    detail_endpoint = workday_cxs_url(str(job.url))
    search_endpoint = detail_endpoint.rsplit("/job/", 1)[0] + "/jobs"
    body = json.dumps(
        {
            "appliedFacets": {},
            "limit": max(1, min(int(limit), 20)),
            "offset": 0,
            "searchText": "",
        }
    ).encode("utf-8")
    request = Request(
        search_endpoint,
        data=body,
        method="POST",
        headers={
            "Accept": "application/json",
            "Content-Type": "application/json",
            "User-Agent": "Hunt-C3-Availability/1.0",
        },
    )
    try:
        with opener(request, timeout=timeout_seconds) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except (HTTPError, URLError, TimeoutError, json.JSONDecodeError, OSError):
        return []
    postings = payload.get("jobPostings") if isinstance(payload, dict) else []
    return [item for item in postings if isinstance(item, dict)]


def _looks_like_locale(value: str) -> bool:
    pieces = value.split("-", 1)
    return len(pieces) == 2 and len(pieces[0]) == 2 and len(pieces[1]) == 2
