"""Bounded fallback for unfamiliar public career pages with standard job metadata."""

from datetime import UTC, datetime, timedelta
from html import unescape
from urllib.error import HTTPError
from urllib.parse import urldefrag, urljoin, urlsplit

from bs4 import BeautifulSoup

from hunter.discovery_policy import canonical_job_key, normalize_text, outside_geography
from hunter.discovery_sources import _error_code, _job, _parse_date, fetch_text
from hunter.job_posting import html_text, job_postings, posting_location
from hunter.search_lanes import matching_search_lane


def discover_structured(company, plan, *, fetcher=fetch_text, hours_old=None, max_pages=25):
    """Follow observed same-origin job links, never guess URLs or claim full coverage."""
    base = urlsplit(plan["url"])
    pending, visited, jobs, seen = [plan["url"]], set(), [], set()
    error = "structured_data_coverage_only"
    cutoff = datetime.now(UTC) - timedelta(hours=hours_old) if hours_old is not None else None

    def local_url(value, page):
        if not isinstance(value, str) or not value.strip():
            return None
        try:
            target = urldefrag(urljoin(page, value))[0]
            parts = urlsplit(target)
        except ValueError:
            return None
        if (parts.scheme, parts.netloc) != (base.scheme, base.netloc) or parts.username:
            return None
        return target if parts.scheme in {"https", "http"} else None

    try:
        while pending and len(visited) < max_pages:
            url = pending.pop(0)
            if url in visited:
                continue
            visited.add(url)
            try:
                soup = BeautifulSoup(fetcher(url), "html.parser")
            except HTTPError as exc:
                # One removed posting must not hide the rest of the catalog.
                # Access restrictions and rate limits still stop this source.
                if url != plan["url"] and exc.code in {404, 410}:
                    continue
                raise
            records = job_postings(soup)
            if (
                url == plan["url"]
                and not records
                and any(
                    normalize_text(node.get_text(" ", strip=True))
                    in {
                        "we don t have any open roles at the moment",
                        "we have no open positions at this time",
                        "there are currently no open positions",
                        "we are not currently hiring",
                    }
                    for node in soup.select("p,h1,h2,h3")
                )
            ):
                return [], {**plan, "status": "ok", "lead_count": 0, "error": None}

            for posting in records:
                title = posting.get("title")
                published_url = posting.get("url")
                if (
                    not published_url
                    and len(records) == 1
                    and isinstance(title, str)
                    and any(
                        normalize_text(heading.get_text(" ", strip=True)) == normalize_text(title)
                        for heading in soup.select("h1")
                    )
                ):
                    canonical = soup.select_one('link[rel="canonical"][href]')
                    published_url = canonical["href"] if canonical else url
                target = local_url(published_url, url)
                # A directory URL is not an individual posting identity.
                if not target or not isinstance(title, str) or not title.strip():
                    continue
                key = canonical_job_key(target)
                if key in seen:
                    continue
                expires, posted = (
                    _parse_date(posting.get("validThrough")),
                    _parse_date(posting.get("datePosted")),
                )
                if expires and expires < datetime.now(UTC) or cutoff and posted and posted < cutoff:
                    continue
                location = posting_location(posting)
                if outside_geography(location) or not matching_search_lane(title):
                    continue
                content = posting.get("description") or ""
                if isinstance(content, dict):
                    content = content.get("text") or ""
                description = html_text(unescape(content) if isinstance(content, str) else "")
                seen.add(key)
                jobs.append(
                    _job(
                        title=title,
                        company=company,
                        location=location,
                        url=target,
                        source="employer_structured",
                        date_posted=posted.date().isoformat() if posted else None,
                        description=description,
                        employment_type=";".join(posting["employmentType"])
                        if isinstance(posting.get("employmentType"), list)
                        else posting.get("employmentType"),
                    )
                )
            for link in soup.select('a[href], link[rel~="next"][href]'):
                title = link.get_text(" ", strip=True)
                listing_link = normalize_text(
                    title or link.get("aria-label") or link.get("title")
                ) in {
                    "all jobs",
                    "view all jobs",
                    "search jobs",
                    "open positions",
                    "current openings",
                }
                if (
                    "next" not in (link.get("rel") or [])
                    and not listing_link
                    and not matching_search_lane(title)
                ):
                    continue
                target = local_url(link["href"], url)
                if target and target not in visited and target not in pending:
                    pending.append(target)
        if pending:
            error = "page_limit_reached"
    except Exception as exc:
        error = _error_code(exc)
    return jobs, {
        **plan,
        "status": "partial"
        if jobs
        else "pending_manual"
        if error == "structured_data_coverage_only"
        else "failed",
        "lead_count": len(jobs),
        "error": error
        if jobs or error != "structured_data_coverage_only"
        else "career_adapter_unavailable",
    }
