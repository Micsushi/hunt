from __future__ import annotations

import csv
import re
from collections.abc import Callable, Iterable
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

from .availability import AvailabilityResult, fetch_current_workday_postings


@dataclass(frozen=True)
class JobCandidate:
    company: str
    title: str
    country: str
    url: str
    canonical_url: str
    job_id: str
    row_number: int


@dataclass(frozen=True)
class AvailabilityDecision:
    job: JobCandidate
    status: str
    reason: str


@dataclass(frozen=True)
class LanePlan:
    index: int
    batch_id: str
    port: int
    profile: str
    agent_id: str
    lane_id: str
    session_id: str
    browser_target_id: str
    artifact_dir: str
    deadline_seconds: int
    allow_submit: bool
    allow_foreground: bool
    job: JobCandidate


AvailabilityCheck = Callable[[JobCandidate], AvailabilityResult]


def read_job_csv(path: str | Path) -> list[JobCandidate]:
    csv_path = Path(path)
    candidates: list[JobCandidate] = []
    seen: set[str] = set()
    with csv_path.open("r", encoding="utf-8-sig", newline="") as handle:
        reader = csv.DictReader(handle)
        for row_number, row in enumerate(reader, start=2):
            url = _first(row, "link", "url", "apply_url", "job_url")
            if not url:
                continue
            canonical = canonical_job_url(url)
            if not canonical or canonical in seen:
                continue
            seen.add(canonical)
            candidates.append(
                JobCandidate(
                    company=_first(row, "company name", "company", "company_name"),
                    title=_first(row, "job name", "title", "job_title"),
                    country=_first(row, "country", "location"),
                    url=url,
                    canonical_url=canonical,
                    job_id=_job_id(url),
                    row_number=row_number,
                )
            )
    return candidates


def select_live_jobs(
    jobs: Iterable[JobCandidate],
    *,
    count: int,
    check: AvailabilityCheck,
    browser_check: AvailabilityCheck | None = None,
) -> tuple[list[JobCandidate], list[AvailabilityDecision]]:
    selected: list[JobCandidate] = []
    decisions: list[AvailabilityDecision] = []
    for job in jobs:
        if len(selected) >= count:
            break
        result = check(job)
        if result.status == "unknown_browser_check" and browser_check is not None:
            result = browser_check(job)
        decisions.append(AvailabilityDecision(job, result.status, result.reason))
        if result.status == "live":
            selected.append(job)
    return selected, decisions


def plan_lanes(
    jobs: Iterable[JobCandidate],
    *,
    batch_id: str,
    ports: Iterable[int],
    artifact_root: str | Path,
    deadline_seconds: int = 120,
) -> list[LanePlan]:
    job_list = list(jobs)
    port_list = [int(port) for port in ports]
    if len(port_list) < len(job_list):
        raise ValueError("not_enough_ports")
    if len(set(port_list[: len(job_list)])) != len(job_list):
        raise ValueError("duplicate_ports")
    if not 1 <= int(deadline_seconds) <= 86400:
        raise ValueError("deadline_seconds_out_of_range")
    raw_batch = str(batch_id).strip()
    safe_batch = re.sub(r"[^A-Za-z0-9_-]+", "-", raw_batch).strip("-")
    if not safe_batch:
        raise ValueError("batch_id_required")
    if safe_batch != raw_batch:
        raise ValueError("batch_id_must_be_safe")
    root = Path(artifact_root).resolve()
    lanes = []
    for offset, job in enumerate(job_list, start=1):
        port = port_list[offset - 1]
        suffix = f"{safe_batch}_{port}"
        session_id = f"session_{suffix}"
        lanes.append(
            LanePlan(
                index=offset,
                batch_id=safe_batch,
                port=port,
                profile=f"ChromeC3PlaywrightParallel_{suffix}",
                agent_id=f"agent_{suffix}",
                lane_id=f"lane_{suffix}",
                session_id=session_id,
                browser_target_id=session_id,
                artifact_dir=str(root / f"lane_{port}"),
                deadline_seconds=int(deadline_seconds),
                allow_submit=False,
                allow_foreground=False,
                job=job,
            )
        )
    return lanes


def discover_live_replacements(
    jobs: Iterable[JobCandidate],
    *,
    count: int,
    fetch: Callable[[JobCandidate], list[dict]] = fetch_current_workday_postings,
    exclude_urls: Iterable[str] = (),
    check: AvailabilityCheck | None = None,
    browser_check: AvailabilityCheck | None = None,
    decisions: list[AvailabilityDecision] | None = None,
) -> list[JobCandidate]:
    replacements: list[JobCandidate] = []
    seen_tenants: set[tuple[str, str]] = set()
    seen_urls: set[str] = {
        canonical for value in exclude_urls if (canonical := canonical_job_url(str(value)))
    }
    for job in jobs:
        parsed = urlsplit(job.url)
        public_prefix = parsed.path.split("/job/", 1)[0].rstrip("/")
        tenant_key = (parsed.netloc.lower(), public_prefix.lower())
        if tenant_key in seen_tenants:
            continue
        seen_tenants.add(tenant_key)
        postings = fetch(job)
        for posting in postings:
            external_path = str(posting.get("externalPath") or "")
            if not external_path.startswith("/job/"):
                continue
            url = f"{parsed.scheme}://{parsed.netloc}{public_prefix}{external_path}"
            canonical = canonical_job_url(url)
            if not canonical or canonical in seen_urls:
                continue
            seen_urls.add(canonical)
            candidate = JobCandidate(
                company=job.company,
                title=str(posting.get("title") or "Current Workday posting"),
                country=str(posting.get("locationsText") or job.country),
                url=url,
                canonical_url=canonical,
                job_id=_job_id(url),
                row_number=job.row_number,
            )
            if check is not None:
                result = check(candidate)
                if result.status == "unknown_browser_check" and browser_check is not None:
                    result = browser_check(candidate)
                if decisions is not None:
                    decisions.append(AvailabilityDecision(candidate, result.status, result.reason))
                if result.status != "live":
                    continue
            replacements.append(candidate)
            if len(replacements) >= count:
                break
        if len(replacements) >= count:
            break
    return replacements


def canonical_job_url(value: str) -> str:
    try:
        parsed = urlsplit(value.strip())
    except ValueError:
        return ""
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        return ""
    query = [
        (key, item)
        for key, item in parse_qsl(parsed.query, keep_blank_values=True)
        if key.lower() not in {"source", "src", "sourceid"}
    ]
    return urlunsplit(
        (
            parsed.scheme.lower(),
            parsed.netloc.lower(),
            parsed.path.rstrip("/"),
            urlencode(query),
            "",
        )
    )


def _first(row: dict[str, str], *keys: str) -> str:
    lowered = {str(key).strip().lower(): str(value or "").strip() for key, value in row.items()}
    for key in keys:
        value = lowered.get(key.lower(), "")
        if value:
            return value
    return ""


def _job_id(url: str) -> str:
    segment = urlsplit(url).path.rstrip("/").rsplit("/", 1)[-1]
    return segment.rsplit("_", 1)[-1]
