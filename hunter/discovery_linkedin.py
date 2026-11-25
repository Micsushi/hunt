"""Deterministic LinkedIn public search pagination; enrichment still owns apply classification."""

import re
import time
from threading import Lock
from urllib.parse import urlencode, urlsplit

from bs4 import BeautifulSoup

from hunter.discovery_sources import _error_code, _job, fetch_text
from hunter.search_lanes import title_matches_search_lane

_search_lock = Lock()


def fetch_public_linkedin_description(url, *, fetcher=fetch_text):
    """Read the original listing's public description without a browser session."""
    parts = urlsplit(url or "")
    match = re.fullmatch(r"/jobs/view/(?:[^/]+-)?(\d+)/?", parts.path)
    host = parts.hostname or ""
    if not match or (host != "linkedin.com" and not host.endswith(".linkedin.com")):
        return None
    listing = f"https://www.linkedin.com/jobs/view/{match[1]}"
    detail = BeautifulSoup(fetcher(listing), "html.parser")
    description = detail.select_one(".show-more-less-html__markup")
    return (description.get_text("\n", strip=True) or None) if description else None


def discover_linkedin_query(
    term, location, category, *, hours_old=24, fetcher=fetch_text, fetch_description=False
):
    jobs, seen = [], set()
    offset = 0
    error = None
    # LinkedIn searches share a host. Serialize requests rather than multiplying rate limits
    # by the number of configured search terms; other sources retain their own concurrency.
    with _search_lock:
        try:
            while True:
                url = (
                    "https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search?"
                    + urlencode(
                        {
                            "keywords": term,
                            "location": location,
                            "f_TPR": f"r{hours_old * 3600}",
                            "start": offset,
                        }
                    )
                )
                html = fetcher(url)
                soup = BeautifulSoup(html, "html.parser")
                cards = soup.select("div.base-search-card")
                if not cards:
                    # The endpoint ends with a doctype/comments-only document. A login/challenge
                    # document is not evidence of an empty search.
                    if soup.find(True) is not None or soup.get_text(" ", strip=True):
                        error = "linkedin_search_response_unrecognized"
                    break
                page_ids = set()
                for card in cards:
                    link = card.select_one("a.base-card__full-link[href]")
                    match = re.search(r"/(?:[^/?]*-)?(\d+)(?:\?|$)", link["href"]) if link else None
                    title = card.select_one(".base-search-card__title")
                    if not match or not title:
                        error = "linkedin_search_card_invalid"
                        continue
                    identity = match[1]
                    if identity in seen or identity in page_ids:
                        page_ids.add(identity)
                        continue
                    page_ids.add(identity)
                    title_text = title.get_text(" ", strip=True)
                    if category and not title_matches_search_lane(title_text, category):
                        continue
                    company = card.select_one(".base-search-card__subtitle")
                    place = card.select_one(".job-search-card__location")
                    date = card.select_one("time[datetime]")
                    job = _job(
                        title=title_text,
                        company=company.get_text(" ", strip=True) if company else None,
                        location=place.get_text(" ", strip=True) if place else None,
                        url=f"https://www.linkedin.com/jobs/view/{identity}",
                        source="linkedin",
                        date_posted=date["datetime"] if date else None,
                        category=category,
                    )
                    job.update(
                        apply_url=None,
                        apply_host=None,
                        ats_type=None,
                        auto_apply_eligible=None,
                        enrichment_status="pending",
                        last_enrichment_error=None,
                    )
                    jobs.append(job)
                    if fetch_description:
                        job["description"] = fetch_public_linkedin_description(
                            job["job_url"], fetcher=fetcher
                        )
                        if not job["description"]:
                            error = "linkedin_description_unavailable"
                        time.sleep(1)
                if not page_ids - seen:
                    error = error or "pagination_repeated"
                    break
                seen.update(page_ids)
                offset += len(cards)
                time.sleep(1)
        except Exception as exc:
            error = _error_code(exc)
    return jobs, {
        "status": "partial" if error and (seen or jobs) else "failed" if error else "ok",
        "error": error,
        "lead_count": len(jobs),
    }
