"""Low-cost public feed and employer-ATS adapters for C1 backfill runs."""

from __future__ import annotations

import json
import re
from datetime import UTC, datetime, timedelta
from urllib.parse import urlsplit
from urllib.request import Request, urlopen

from hunter.discovery_policy import annotate_job, geography_suppression
from hunter.search_lanes import LANE_TITLE_KEYWORDS, title_matches_search_lane
from hunter.url_utils import detect_ats_type, get_apply_host

DEFAULT_PUBLIC_FEEDS = {
    "simplify_internships": (
        "json",
        "https://raw.githubusercontent.com/SimplifyJobs/Summer2027-Internships/dev/.github/scripts/listings.json",
    ),
    "simplify_new_grad": (
        "json",
        "https://raw.githubusercontent.com/SimplifyJobs/New-Grad-Positions/dev/.github/scripts/listings.json",
    ),
    "canadian_tech_internships": (
        "markdown",
        "https://raw.githubusercontent.com/negarprh/Canadian-Tech-Internships-2027/main/README.md",
    ),
    "canada_summer_internships": (
        "markdown",
        "https://raw.githubusercontent.com/michelleokolie/canada-tech-internships-summer-2027/main/README.md",
    ),
    "canada_offseason_internships": (
        "markdown",
        "https://raw.githubusercontent.com/michelleokolie/canada-tech-internships-summer-2027/main/OFFSEASON_README.md",
    ),
}


def fetch_text(url: str, timeout: int = 25) -> str:
    request = Request(url, headers={"User-Agent": "Hunt-C1/1.0"})
    with urlopen(request, timeout=timeout) as response:
        return response.read().decode("utf-8-sig")


def _job(
    *,
    title,
    company,
    location,
    url,
    source,
    date_posted=None,
    description=None,
    category=None,
):
    data = {
        "title": str(title or "").strip(),
        "company": str(company or "").strip() or None,
        "location": str(location or "").strip() or None,
        "job_url": url,
        "apply_url": url,
        "description": str(description or "").strip() or None,
        "source": source,
        "date_posted": date_posted,
        "is_remote": "remote" in str(location or "").lower(),
        "level": "unknown",
        "priority": False,
        "category": category
        or next(
            (lane for lane in LANE_TITLE_KEYWORDS if title_matches_search_lane(title, lane)),
            "other",
        ),
        "apply_type": "unknown",
        "auto_apply_eligible": False,
        # Public listings are discovery evidence, not a verified application flow.
        # No enrichment worker claims these source IDs; keep them explicitly blocked.
        "enrichment_status": "blocked",
        "last_enrichment_error": "public_apply_flow_unverified",
        "enrichment_attempts": 0,
        "apply_host": get_apply_host(url),
        "ats_type": detect_ats_type(url),
    }
    return annotate_job(data)


def _parse_date(value) -> datetime | None:
    if isinstance(value, (int, float)):
        return datetime.fromtimestamp(value / 1000 if value > 100_000_000_000 else value, UTC)
    text = str(value or "").strip()
    try:
        parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
        return parsed.replace(tzinfo=UTC) if parsed.tzinfo is None else parsed.astimezone(UTC)
    except ValueError:
        pass
    for fmt in ("%Y-%m-%d", "%b %d, %Y", "%b %d %Y"):
        try:
            return datetime.strptime(text, fmt).replace(tzinfo=UTC)
        except ValueError:
            pass
    try:
        now = datetime.now(UTC)
        candidate = datetime.strptime(f"{text} {now.year}", "%b %d %Y").replace(tzinfo=UTC)
        return (
            candidate.replace(year=now.year - 1)
            if candidate > now + timedelta(days=1)
            else candidate
        )
    except ValueError:
        pass
    return None


def parse_simplify_feed(raw: str, source: str, *, hours_old: int) -> list[dict]:
    cutoff = datetime.now(UTC) - timedelta(hours=hours_old)
    jobs = []
    for item in json.loads(raw):
        posted = _parse_date(item.get("date_posted"))
        locations = item.get("locations") or []
        if item.get("active") is False or item.get("is_visible") is False:
            continue
        if (
            posted is None
            or posted < cutoff
            or geography_suppression("; ".join(locations)) == "outside_canada"
        ):
            continue
        url = item.get("url")
        if not url or not item.get("title") or not item.get("company_name"):
            continue
        jobs.append(
            _job(
                title=item["title"],
                company=item["company_name"],
                location="; ".join(locations),
                url=url,
                source=source,
                date_posted=posted.date().isoformat(),
            )
        )
    return jobs


def parse_markdown_feed(raw: str, source: str, *, hours_old: int) -> list[dict]:
    cutoff = datetime.now(UTC) - timedelta(hours=hours_old)
    jobs = []
    current_company = ""
    for line in raw.splitlines():
        if not line.startswith("|") or "Closed" in line:
            continue
        cells = [cell.strip() for cell in re.split(r"(?<!\\)\|", line.strip("|"))]
        if len(cells) < 5:
            continue
        company, title, location, link, date_text = cells[:5]
        if company == "↳":
            company = current_company
        elif company and company.lower() not in {"company", "---"}:
            current_company = company
        posted = _parse_date(date_text)
        urls = [
            a or b
            for a, b in re.findall(
                r"\]\((https?://[^)]+)\)|href=[\"'](https?://[^\"']+)[\"']", link
            )
        ]
        if (
            posted is None
            or posted < cutoff
            or not urls
            or geography_suppression(location) == "outside_canada"
        ):
            continue
        jobs.append(
            _job(
                title=title,
                company=company.replace("\\|", "|"),
                location=location,
                url=urls[-1],
                source=source,
                date_posted=posted.date().isoformat(),
            )
        )
    return jobs


def discover_public_feeds(*, hours_old: int, feeds=None, fetcher=fetch_text):
    jobs = []
    health = []
    for source, (kind, url) in (feeds or DEFAULT_PUBLIC_FEEDS).items():
        try:
            raw = fetcher(url)
            found = (
                parse_simplify_feed(raw, source, hours_old=hours_old)
                if kind == "json"
                else parse_markdown_feed(raw, source, hours_old=hours_old)
            )
            jobs.extend(found)
            health.append(
                {"source": source, "status": "ok", "lead_count": len(found), "error": None}
            )
        except Exception as exc:  # one lane must never erase results from another
            health.append(
                {"source": source, "status": "failed", "lead_count": 0, "error": str(exc)[:500]}
            )
    return jobs, health


def career_fetch_plan(url: str) -> dict:
    parts = urlsplit(str(url or ""))
    host = (parts.hostname or "").lower()
    path = [part for part in parts.path.split("/") if part]
    if host in {"boards.greenhouse.io", "job-boards.greenhouse.io"} and path:
        return {
            "method": "greenhouse",
            "url": f"https://boards-api.greenhouse.io/v1/boards/{path[0]}/jobs?content=true",
        }
    if host == "jobs.lever.co" and path:
        return {"method": "lever", "url": f"https://api.lever.co/v0/postings/{path[0]}?mode=json"}
    if host == "jobs.ashbyhq.com" and path:
        return {
            "method": "ashby",
            "url": f"https://api.ashbyhq.com/posting-api/job-board/{path[0]}",
        }
    return {"method": "manual", "url": str(url or "")}


def discover_company_career_site(company: str, career_url: str, *, fetcher=fetch_text):
    plan = career_fetch_plan(career_url)
    if plan["method"] == "manual":
        return [], {"status": "pending_manual", "error": None, **plan}
    try:
        payload = json.loads(fetcher(plan["url"]))
        rows = payload.get("jobs", []) if isinstance(payload, dict) else payload
        jobs = []
        for row in rows:
            title = row.get("text") if plan["method"] == "lever" else row.get("title")
            if plan["method"] == "greenhouse":
                location = (row.get("location") or {}).get("name", "")
                url = row.get("absolute_url")
                posted = row.get("updated_at")
                description = row.get("content")
            elif plan["method"] == "lever":
                location = (row.get("categories") or {}).get("location") or ""
                url = row.get("hostedUrl") or row.get("applyUrl")
                posted = None
                description = row.get("descriptionPlain")
            else:
                location = row.get("location") or ""
                url = row.get("jobUrl") or row.get("applyUrl")
                posted = row.get("publishedAt")
                description = row.get("descriptionPlain") or row.get("description")
            if not title or not url or geography_suppression(location) == "outside_canada":
                continue
            date_posted = _parse_date(posted).date().isoformat() if _parse_date(posted) else None
            jobs.append(
                _job(
                    title=title,
                    company=company,
                    location=location,
                    url=url,
                    source=f"employer_{plan['method']}",
                    date_posted=date_posted,
                    description=description,
                )
            )
        return jobs, {"status": "ok", "error": None, "lead_count": len(jobs), **plan}
    except Exception as exc:
        return [], {"status": "failed", "error": str(exc)[:500], "lead_count": 0, **plan}
