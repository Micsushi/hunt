"""Verify public Workday postings and admit them through C1's normal policy.

Run ``python -m hunter.workday_intake --urls-file jobs.json --db private.db``.
The input is a JSON list of URLs or {"url": ..., "company": ...} objects,
or one URL per line. Company labels are optional; posting facts come from CXS.
"""

from __future__ import annotations

import argparse
import json
import os
import re
from pathlib import Path
from urllib.parse import quote, unquote, urlsplit

import requests


def posting_target(value: str) -> tuple[str, str, str, str]:
    """Return canonical URL, host, site and posting path for public CXS sites."""
    url = urlsplit(value)
    host = url.hostname or ""
    if (
        url.scheme != "https"
        or url.username
        or url.password
        or url.port
        or not re.fullmatch(r"[a-z0-9-]+\.wd[0-9]+\.myworkdayjobs\.com", host)
    ):
        raise ValueError("Use a public HTTPS Workday posting URL.")
    segments = [unquote(part) for part in url.path.split("/") if part]
    if segments and re.fullmatch(r"[a-z]{2}-[A-Z]{2}", segments[0]):
        segments.pop(0)
    if segments and segments[-1] in {"apply", "applyManually"}:
        segments.pop()
    if (
        len(segments) < 3
        or segments[1] != "job"
        or any(part in {".", ".."} or re.search(r"[/\\\x00-\x1f]", part) for part in segments)
    ):
        raise ValueError("Workday URL must identify one public job posting.")
    site = segments[0]
    path = "/" + "/".join(quote(part, safe="-_~") for part in segments[1:])
    return f"https://{host}/{quote(site, safe='-_~')}{path}", host, site, path


def fetch_detail(url: str) -> dict:
    _, host, site, path = posting_target(url)
    endpoint = f"https://{host}/wday/cxs/{host.split('.')[0]}/{quote(site, safe='-_~')}{path}"
    # A redirect must not turn an admitted employer URL into an arbitrary fetch.
    with requests.get(
        endpoint,
        timeout=30,
        allow_redirects=False,
        stream=True,
        headers={"Accept": "application/json", "User-Agent": "Hunt-C1/1.0"},
    ) as response:
        if response.status_code != 200:
            raise ValueError(f"Workday posting is unavailable (HTTP {response.status_code}).")
        content = bytearray()
        for chunk in response.iter_content(65536):
            content.extend(chunk)
            if len(content) > 2 * 1024 * 1024:
                raise ValueError("Workday posting response is too large.")
        return json.loads(content)


def verified_job(url: str, detail: dict, company: str = "") -> dict:
    from hunter.providers.hiring_cafe import html_to_text
    from hunter.search_lanes import LANE_TITLE_KEYWORDS, title_matches_search_lane

    canonical, host, site, path = posting_target(url)
    info = detail.get("jobPostingInfo") if isinstance(detail, dict) else None
    if (
        not isinstance(info, dict)
        or info.get("canApply") is not True
        or info.get("posted") is not True
    ):
        raise ValueError("Workday does not confirm an open application for this posting.")
    external, external_host, external_site, external_path = posting_target(
        info.get("externalUrl") or ""
    )
    if (
        external_host != host
        or external_site != site
        or external_path != path
        or info.get("jobPostingSiteId") != site
        or info.get("jobPostingId") != unquote(path.rsplit("/", 1)[-1])
        or not info.get("id")
        or not info.get("jobReqId")
    ):
        raise ValueError(
            "Workday returned a different posting or an unverified external destination."
        )
    title = str(info.get("title") or "").strip()
    description = html_to_text(info.get("jobDescription"))
    if not title or not description or len(description) < 50:
        raise ValueError("Workday posting lacks a usable title or description.")
    organization = detail.get("hiringOrganization") or {}
    location = str(info.get("location") or "").strip()
    if not location:
        location = "; ".join(
            str(item) for item in info.get("additionalLocations", []) if isinstance(item, str)
        )
    return {
        "title": title,
        "company": organization.get("name") or company or host.split(".")[0],
        "location": location,
        "job_url": canonical,
        "apply_url": external,
        "description": description,
        "source": "employer_workday",
        "date_posted": info.get("startDate"),
        "is_remote": "remote" in location.lower(),
        "level": "unknown",
        "priority": False,
        "category": next(
            (lane for lane in LANE_TITLE_KEYWORDS if title_matches_search_lane(title, lane)),
            "other",
        ),
        "apply_type": "external_apply",
        "auto_apply_eligible": True,
        "enrichment_status": "pending",
        "enrichment_attempts": 0,
        "apply_host": host,
        "ats_type": "workday",
    }


def intake_job(url: str, *, company: str = "") -> dict:
    from hunter import db
    from hunter.discovery_policy import canonical_job_key

    job = verified_job(url, fetch_detail(url), company)
    # Respect prior owner dispositions before add_job recomputes discovery policy.
    connection = db.get_connection()
    try:
        row = connection.execute(
            "SELECT * FROM jobs WHERE job_url = ? OR canonical_job_key = ? LIMIT 1",
            (job["job_url"], canonical_job_key(job["apply_url"], job["company"])),
        ).fetchone()
    finally:
        connection.close()
    if row:
        previous = dict(row)
        if previous.get("discovery_suppressed_reason") or str(
            previous.get("status") or ""
        ).lower() in {"applied", "canceled", "cancelled"}:
            return {
                "job_id": previous["id"],
                "result": "preserved",
                "reason": previous.get("discovery_suppressed_reason") or previous.get("status"),
            }
    result = db.add_job(job)
    job_id = result[1]
    db.mark_job_enrichment_succeeded(
        job_id,
        **{
            key: job[key]
            for key in (
                "description",
                "apply_type",
                "auto_apply_eligible",
                "apply_url",
                "apply_host",
                "ats_type",
            )
        },
    )
    saved = db.get_job_by_id(job_id)
    return {
        "job_id": job_id,
        "result": "verified",
        "url": saved["apply_url"],
        "suppression": saved.get("discovery_suppressed_reason"),
        "c3_ready": db._job_is_c3_ready(saved),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--urls-file", required=True)
    parser.add_argument("--db", required=True, help="Isolated SQLite database path")
    args = parser.parse_args()
    os.environ["HUNT_DB_URL"] = ""
    os.environ["HUNT_DB_PATH"] = str(Path(args.db).expanduser().resolve())
    from hunter import db

    db.init_db(maintenance=False)
    text = Path(args.urls_file).read_text(encoding="utf-8-sig").strip()
    entries = json.loads(text) if text.startswith("[") else text.splitlines()
    failed = False
    for entry in entries:
        url = entry if isinstance(entry, str) else entry["url"]
        try:
            result = intake_job(
                url, company=entry.get("company", "") if isinstance(entry, dict) else ""
            )
        except (ValueError, requests.RequestException) as error:
            result = {"url": url, "result": "rejected", "reason": str(error)}
            failed = True
        print(json.dumps(result), flush=True)
    return int(failed)


if __name__ == "__main__":
    raise SystemExit(main())
