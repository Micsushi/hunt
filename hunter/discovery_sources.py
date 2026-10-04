"""Low-cost public feed and employer-ATS adapters for C1 backfill runs."""

from __future__ import annotations

import csv
import json
import re
import socket
import sqlite3
import ssl
import time
from datetime import UTC, datetime, timedelta
from functools import cache
from html import unescape
from itertools import count
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qsl, quote, urlencode, urljoin, urlsplit
from urllib.request import Request, urlopen

from bs4 import BeautifulSoup

from hunter.discovery_policy import (
    annotate_job,
    canonical_job_key,
    geography_suppression,
    outside_country,
    outside_geography,
)
from hunter.job_posting import html_text, job_postings, posting_location
from hunter.search_lanes import matching_search_lane, title_matches_search_lane
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


def catalog_company_sites(root=None):
    """Reuse public catalog employer URLs, never the catalog's old job-status claims."""
    root = Path(root) if root is not None else Path(__file__).resolve().parent.parent
    sites = {}
    for filename in (
        "wd_test_jobs.csv",
        "greenhouse_test_jobs.csv",
        "lever_test_jobs.csv",
        "ashby_test_jobs.csv",
    ):
        path = root / filename
        if not path.is_file():
            continue
        with path.open(encoding="utf-8-sig", newline="") as stream:
            for row in csv.DictReader(stream):
                company, url = row.get("company name", "").strip(), row.get("link", "").strip()
                if company and career_fetch_plan(url)["method"] != "manual":
                    sites.setdefault(company, url)
    return sites


def _script_object(soup, pattern):
    """Decode a published JSON assignment without executing its surrounding JavaScript."""
    for script in soup.select("script:not([src])"):
        text = script.get_text()
        match = re.search(pattern, text)
        if match:
            try:
                value = json.JSONDecoder().raw_decode(text[match.end() :].lstrip())[0]
                return value if isinstance(value, dict) else {}
            except ValueError:
                continue
    return {}


def fetch_text(url: str, timeout: int = 25) -> str:
    from hunter.discovery_cache import cache_response, cached_response, decode_body

    try:
        cached = cached_response(url)
    except (OSError, sqlite3.Error):
        cached = None
    headers = {"User-Agent": "Hunt-C1/1.0"}
    if cached:
        if cached[0]:
            headers["If-None-Match"] = cached[0]
        elif cached[1]:
            headers["If-Modified-Since"] = cached[1]
    request = Request(url, headers=headers)

    def remember(response, body):
        try:
            cache_response(url, response, body)
        except (OSError, sqlite3.Error):
            pass  # An unavailable optional cache must not turn a live response into a failure.

    try:
        return _read_public_response(request, timeout, text=True, on_response=remember)
    except HTTPError as exc:
        if exc.code == 304 and cached:
            return decode_body(cached[2], cached[3])
        raise


def _read_public_response(request, timeout=25, *, text=False, on_response=None):
    """Retry transient discovery failures, never authentication or access denials."""
    from hunter.discovery_run import check_cancelled

    for attempt in range(3):
        check_cancelled()
        try:
            with urlopen(request, timeout=timeout) as response:
                raw = response.read()
                if on_response:
                    on_response(response, raw)
                if not text:
                    return raw
                encoding = response.headers.get_content_charset() or "utf-8-sig"
                try:
                    return raw.decode(encoding, errors="replace")
                except LookupError:
                    return raw.decode("utf-8-sig", errors="replace")
        except (HTTPError, URLError, TimeoutError) as exc:
            if isinstance(exc, URLError) and isinstance(exc.reason, ssl.SSLCertVerificationError):
                raise
            if (
                isinstance(exc, URLError)
                and isinstance(exc.reason, socket.gaierror)
                and exc.reason.errno != socket.EAI_AGAIN
            ):
                raise
            delay = 2 ** (attempt + 1)
            if isinstance(exc, HTTPError):
                if exc.code not in {429, 500, 502, 503, 504}:
                    raise
                retry_after = exc.headers.get("Retry-After") if exc.headers else None
                if retry_after:
                    # Long or date-form backoffs belong to a later run, not an early retry.
                    if not retry_after.isdigit() or int(retry_after) > 30:
                        raise
                    delay = max(delay, int(retry_after))
            if attempt == 2:
                raise
            time.sleep(delay)


def _error_code(exc):
    if isinstance(exc, ValueError) and str(exc) == "security_checkpoint":
        return "security_checkpoint"
    if isinstance(exc, URLError):
        if isinstance(exc.reason, ssl.SSLCertVerificationError):
            return "tls_certificate_error"
        if isinstance(exc.reason, socket.gaierror):
            return "dns_resolution_failed"
    return f"http_{exc.code}" if isinstance(exc, HTTPError) else type(exc).__name__


def catalog_error(exc):
    return str(exc) if isinstance(exc, ValueError) else _error_code(exc)


def discovery_result(plan, jobs, error, loaded, *, catalog_complete=None):
    """Keep the same partial/failure meaning across public catalog readers."""
    return jobs, {
        **plan,
        "status": "partial" if error and loaded else "failed" if error else "ok",
        "error": error,
        "lead_count": len(jobs),
        **({"catalog_complete": catalog_complete} if catalog_complete is not None else {}),
    }


def discover_jobillico(
    search_terms, *, hours_old=336, max_pages=None, fetcher=fetch_text, on_result=None
):
    """Read public search cards; retain unresolved partner links as unverified leads."""
    origin = "https://www.jobillico.com"
    cutoff = (datetime.now(UTC) - timedelta(hours=hours_old)).date().isoformat()
    jobs, health, seen = [], [], set()
    for category, terms in search_terms.items():
        for term in terms:
            found, visited = [], set()
            emitted = 0
            error = "application_links_not_verified"
            url = origin + "/search-jobs?" + urlencode({"skwd": term, "sort": "date"})
            try:
                for page_number in count(1):
                    soup = BeautifulSoup(fetcher(url), "html.parser")
                    listing = soup.select_one("#jobOffersList") or soup
                    cards = listing.select("article h2 a")
                    identity = tuple(
                        str(a.get("data-partner-no-job") or a.get("href", "").split("?", 1)[0])
                        for a in cards
                    )
                    if not cards or identity in visited:
                        error = (
                            "search_results_not_verified" if not cards else "pagination_repeated"
                        )
                        break
                    visited.add(identity)
                    # Only stop at the date boundary when the site confirms date ordering
                    # and every listing on this page has a known, older posting date.
                    dates = [
                        _parse_date(node["datetime"])
                        if (node := link.find_parent("article").select_one("time[datetime]"))
                        else None
                        for link in cards
                    ]
                    sorted_by_date = soup.select_one(
                        'select[name="sort"] option[value="date"][selected]'
                    )
                    if sorted_by_date and all(
                        date and date.date().isoformat() < cutoff for date in dates
                    ):
                        break
                    for link in cards:
                        title = link.get_text(" ", strip=True)
                        if not title_matches_search_lane(title, category):
                            continue
                        card = link.find_parent("article")
                        href = link.get("data-partner-redirect-link") or link.get("href", "")
                        target = urljoin(origin, href)
                        if (
                            not href
                            or href.startswith("#")
                            or urlsplit(target).scheme not in {"http", "https"}
                        ):
                            continue
                        if urlsplit(target).netloc == "www.jobillico.com":
                            target = target.split("?", 1)[0]
                        if target in seen:
                            continue
                        date = card.select_one("time[datetime]")
                        parsed = _parse_date(date["datetime"]) if date else None
                        posted = parsed.date().isoformat() if parsed else None
                        if posted and posted < cutoff:
                            continue
                        company = card.select_one("h3 a")
                        location = card.select_one("li p")
                        description = card.select_one("p.word-break")
                        found.append(
                            _job(
                                title=title,
                                company=company.get_text(" ", strip=True)
                                if company
                                else link.get("data-partner-company-name"),
                                location=(location.get_text(" ", strip=True) + ", Canada")
                                if location
                                else None,
                                url=target,
                                source="jobillico",
                                category=category,
                                date_posted=posted,
                                description=description.get_text(" ", strip=True)
                                if description
                                else None,
                            )
                        )
                        seen.add(target)
                    if on_result:
                        on_result(
                            found[emitted:],
                            [
                                {
                                    "source": f"jobillico: {category} / {term}",
                                    "status": "running",
                                    "lead_count": len(found),
                                    "error": None,
                                }
                            ],
                        )
                        emitted = len(found)
                    next_link = next(
                        (
                            a
                            for a in soup.select("a.pagination__item__link[href]")
                            if a.get_text(strip=True) == str(page_number + 1)
                        ),
                        None,
                    )
                    if next_link is None:
                        break
                    if page_number == max_pages:
                        error = "page_limit_reached"
                        break
                    url = urljoin(origin, next_link["href"])
                    if not url.startswith(origin + "/search-jobs?"):
                        error = "pagination_target_unverified"
                        break
            except Exception as exc:
                error = _error_code(exc)
            if on_result is None:
                jobs.extend(found)
            health.append(
                {
                    "source": f"jobillico: {category} / {term}",
                    "status": "partial" if found else "unverified",
                    "lead_count": len(found),
                    "error": error,
                }
            )
            if on_result:
                on_result(found[emitted:], [health[-1]])
    return jobs, health


def discover_vanhack(*, hours_old=336, fetcher=fetch_text, catalog_reader=None):
    """Read the complete public scroll catalog; relative dates remain unverified."""
    if catalog_reader is None:
        from hunter.discovery_browser import read_vanhack_catalog

        catalog_reader = read_vanhack_catalog
    origin = "https://app.vanhack.com"
    jobs, seen = [], set()
    error = "posting_date_unknown"
    try:
        html, catalog_error = catalog_reader()
        error = catalog_error or error
        soup = BeautifulSoup(html, "html.parser")
        cards = soup.select('a.vh-card-link[href^="/job/"]')
        if not cards:
            error = catalog_error or "search_results_not_verified"
        for card in cards:
            target = urljoin(origin, card["href"])
            if target in seen:
                continue
            seen.add(target)
            heading = card.select_one("h2")
            title = heading.get_text(" ", strip=True) if heading else ""
            if "Public Showcase Program" in title or "Talent Spotlight" in title:
                continue
            category = matching_search_lane(title)
            if category is None:
                continue
            location = card.select_one(".vh-detail-label")
            location = location.get_text(" ", strip=True) if location else ""
            if outside_geography(location):
                continue
            posted = card.select_one(".vh-posted")
            posted = posted.get_text(strip=True) if posted else ""
            age = re.fullmatch(r"(\d+) (d|mo) ago", posted)
            if age and int(age[1]) * (24 if age[2] == "d" else 24 * 28) > hours_old:
                continue
            description = None
            try:
                detail = BeautifulSoup(fetcher(target), "html.parser")
                detail_title = detail.select_one("h1")
                body = detail.select_one(".vh-jd-description")
                if (
                    not detail_title
                    or detail_title.get_text(" ", strip=True) != title
                    or body is None
                ):
                    raise ValueError("detail_identity_mismatch")
                description = body.get_text(" ", strip=True)
            except Exception as exc:
                error = catalog_error or (catalog_error(exc))
            jobs.append(
                _job(
                    title=title,
                    company=None,
                    location=location,
                    url=target,
                    source="vanhack",
                    category=category,
                    description=description,
                )
            )
            if error in {"http_403", "http_429", "security_checkpoint"}:
                break
    except Exception as exc:
        error = _error_code(exc)
    return jobs, [
        {
            "source": "vanhack",
            "status": "partial" if jobs else "unverified",
            "lead_count": len(jobs),
            "error": error,
        }
    ]


def discover_talentegg(search_terms, *, hours_old=336, max_pages=None, fetcher=fetch_text):
    origin = "https://talentegg.ca"
    jobs, health, seen = [], [], set()
    for category, terms in search_terms.items():
        for term in terms:
            found, visited = [], set()
            url = origin + "/find-a-job/keyword/" + quote(term, safe="")
            error = "application_links_not_verified"
            try:
                for page_number in count(1):
                    soup = BeautifulSoup(fetcher(url), "html.parser")
                    links = soup.select("a.job-title[href]")
                    if not links:
                        # A transient empty search shell is not proof of zero results.
                        soup = BeautifulSoup(fetcher(url), "html.parser")
                        links = soup.select("a.job-title[href]")
                    identity = tuple(link["href"] for link in links)
                    if not links or identity in visited:
                        error = (
                            "search_results_not_verified" if not links else "pagination_repeated"
                        )
                        break
                    visited.add(identity)
                    for link in links:
                        title = link.get_text(" ", strip=True)
                        target = urljoin(origin, link["href"])
                        if (
                            target in seen
                            or urlsplit(target).scheme not in {"http", "https"}
                            or not title_matches_search_lane(title, category)
                        ):
                            continue
                        card = link.find_parent("div", class_="display-cell-fill")
                        if card is None:
                            continue
                        location = card.select_one('[title="Location"]')
                        date = card.select_one('[title="Date Posted"]')
                        relative = (
                            re.fullmatch(r"(\d+)\+? days? ago", date.get_text(" ", strip=True))
                            if date
                            else None
                        )
                        if relative and int(relative[1]) * 24 > hours_old:
                            continue
                        company = link.parent.find_next_sibling("div")
                        if company and "job-metas" in company.get("class", []):
                            company = None
                        # Relative display dates are not precise posting timestamps.
                        found.append(
                            _job(
                                title=title,
                                company=company.get_text(" ", strip=True) if company else None,
                                location=location.get_text(" ", strip=True) + ", Canada"
                                if location
                                else None,
                                url=target,
                                source="talentegg",
                                category=category,
                            )
                        )
                        seen.add(target)
                    next_link = next(
                        (
                            a
                            for a in soup.select("a[href]")
                            if a.get_text(strip=True) == str(page_number + 1)
                            and "/find-a-job/" in a["href"]
                        ),
                        None,
                    )
                    if next_link is None:
                        break
                    if page_number == max_pages:
                        error = "page_limit_reached"
                        break
                    url = urljoin(origin, next_link["href"])
                    if not url.startswith(origin + "/find-a-job/"):
                        error = "pagination_target_unverified"
                        break
            except Exception as exc:
                error = _error_code(exc)
            jobs.extend(found)
            health.append(
                {
                    "source": f"talentegg: {category} / {term}",
                    "status": "partial" if found else "unverified",
                    "lead_count": len(found),
                    "error": error,
                }
            )
    return jobs, health


def discover_wellfound(*, hours_old=336, max_pages=None, fetcher=fetch_text):
    """Public Canada directory highlights, not the authenticated personalized catalog."""
    origin = "https://wellfound.com"
    url = origin + "/location/canada-startups"
    cutoff = datetime.now(UTC) - timedelta(hours=hours_old)
    jobs, seen, visited = [], set(), set()
    error = "public_highlights_only"
    try:
        for page_number in count(1):
            soup = BeautifulSoup(fetcher(url), "html.parser")
            script = soup.select_one("#__NEXT_DATA__")
            if script is None:
                raise ValueError("search_results_not_verified")
            data = json.loads(script.get_text())["props"]["pageProps"]["apolloState"]["data"]
            rows = {
                key: value
                for key, value in data.items()
                if key.startswith("JobListingSearchResult:")
            }
            identity = tuple(sorted(rows))
            if not rows or identity in visited:
                error = "search_results_not_verified" if not rows else "pagination_repeated"
                break
            visited.add(identity)
            companies = {
                ref["__ref"]: company.get("name")
                for company in data.values()
                if company.get("__typename") == "StartupResult"
                for ref in company.get("highlightedJobListings", [])
            }
            for key, row in rows.items():
                if key in seen:
                    continue
                seen.add(key)
                category = matching_search_lane(row.get("title"))
                if category is None:
                    continue
                date = _parse_date(row.get("liveStartAt"))
                if date and date < cutoff:
                    continue
                places = list(row.get("locationNames") or []) + list(
                    row.get("acceptedRemoteLocationNames") or []
                )
                location = "; ".join(places)
                if outside_geography(location):
                    continue
                jobs.append(
                    _job(
                        title=row["title"],
                        company=companies.get(key),
                        location=location,
                        url=origin + "/jobs/" + str(row["id"]) + "-" + row["slug"],
                        source="wellfound",
                        category=category,
                        date_posted=date.date().isoformat() if date else None,
                        description=row.get("description"),
                    )
                )
            next_link = next(
                (a for a in soup.select("a[href]") if a.get_text(strip=True) == "Next"), None
            )
            if next_link is None:
                break
            if page_number == max_pages:
                error = "page_limit_reached"
                break
            url = urljoin(origin, next_link["href"])
            if not url.startswith(origin + "/location/canada-startups?"):
                error = "pagination_target_unverified"
                break
    except Exception as exc:
        error = _error_code(exc)
    return jobs, [
        {
            "source": "wellfound",
            "status": "partial" if jobs else "unverified",
            "lead_count": len(jobs),
            "error": error,
        }
    ]


def discover_builtin(
    search_terms, *, hours_old=336, max_pages=None, fetcher=fetch_text, on_result=None
):
    origin = "https://builtin.com"
    cutoff = datetime.now(UTC) - timedelta(hours=hours_old)
    jobs, health, seen = [], [], set()
    for category, terms in search_terms.items():
        for term in terms:
            found, visited = [], set()
            emitted = 0
            error = "application_links_not_verified"
            url = (
                origin
                + "/jobs?"
                + urlencode({"search": term, "country": "CAN", "allLocations": "true"})
            )
            try:
                for page_number in count(1):
                    soup = BeautifulSoup(fetcher(url), "html.parser")
                    links = soup.select('h2 a[href^="/job/"]')
                    identity = tuple(link["href"] for link in links)
                    if not links or identity in visited:
                        error = (
                            "search_results_not_verified" if not links else "pagination_repeated"
                        )
                        break
                    visited.add(identity)
                    for link in links:
                        target = urljoin(origin, link["href"])
                        title = link.get_text(" ", strip=True)
                        if target in seen or not title_matches_search_lane(title, category):
                            continue
                        seen.add(target)
                        card = link.find_parent(attrs={"data-id": "job-card"})
                        clock = card.select_one("i.fa-clock") if card else None
                        age = (
                            re.search(
                                r"\b(\d+) Days? Ago\b", clock.parent.get_text(" ", strip=True), re.I
                            )
                            if clock
                            else None
                        )
                        # Relative ages are rounded. Allow an extra day at the boundary,
                        # and never stop pagination unless ordering itself is proven.
                        if age and int(age[1]) * 24 > hours_old + 24:
                            continue
                        try:
                            detail = BeautifulSoup(fetcher(target), "html.parser")
                            posting = next(
                                (row for row in job_postings(detail) if row.get("title") == title),
                                None,
                            )
                            if not posting or posting.get("title") != title:
                                raise ValueError("detail_identity_mismatch")
                            date = _parse_date(posting.get("datePosted"))
                            expires = _parse_date(posting.get("validThrough"))
                            if (date and date < cutoff) or (
                                expires and expires < datetime.now(UTC)
                            ):
                                continue
                            location = posting_location(posting)
                            if outside_geography(location):
                                continue
                            job = _job(
                                title=title,
                                company=(posting.get("hiringOrganization") or {}).get("name"),
                                location=location,
                                url=target,
                                source="builtin",
                                category=category,
                                date_posted=date.date().isoformat() if date else None,
                                description=html_text(posting.get("description", ""), " "),
                            )
                        except Exception:
                            error = "some_job_details_unavailable"
                            job = _job(
                                title=title,
                                company=None,
                                location=None,
                                url=target,
                                source="builtin",
                                category=category,
                            )
                        found.append(job)
                    if on_result:
                        on_result(
                            found[emitted:],
                            [
                                {
                                    "source": f"builtin: {category} / {term}",
                                    "status": "running",
                                    "lead_count": len(found),
                                    "error": None,
                                }
                            ],
                        )
                        emitted = len(found)
                    next_link = next(
                        (
                            a
                            for a in soup.select("a[href]")
                            if a.get_text(strip=True) == str(page_number + 1)
                            and a["href"].startswith("/jobs?")
                        ),
                        None,
                    )
                    if next_link is None:
                        break
                    if page_number == max_pages:
                        error = "page_limit_reached"
                        break
                    url = urljoin(origin, next_link["href"])
            except Exception as exc:
                error = _error_code(exc)
            if on_result is None:
                jobs.extend(found)
            health.append(
                {
                    "source": f"builtin: {category} / {term}",
                    "status": "partial" if found else "unverified",
                    "lead_count": len(found),
                    "error": error,
                }
            )
            if on_result:
                on_result(found[emitted:], [health[-1]])
    return jobs, health


def _job(
    *,
    title,
    company,
    location,
    url,
    source,
    date_posted=None,
    description=None,
    employment_type=None,
    is_remote=None,
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
        "employment_type": employment_type,
        "is_remote": is_remote
        if isinstance(is_remote, bool)
        else "remote" in str(location or "").lower(),
        "level": "unknown",
        "priority": False,
        "category": category or matching_search_lane(title) or "other",
        "apply_type": "unknown",
        "auto_apply_eligible": False,
        # Public listings are discovery evidence, not a verified application flow.
        # Supported public providers are verified separately before becoming eligible.
        "enrichment_status": "blocked",
        "last_enrichment_error": "public_apply_flow_unverified",
        "enrichment_attempts": 0,
        "apply_host": get_apply_host(url),
        "ats_type": detect_ats_type(url),
    }
    return annotate_job(data)


def _parse_date(value) -> datetime | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        try:
            return datetime.fromtimestamp(value / 1000 if value > 100_000_000_000 else value, UTC)
        except (ValueError, OverflowError, OSError):
            return None
    text = str(value or "").strip()
    try:
        parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
        return parsed.replace(tzinfo=UTC) if parsed.tzinfo is None else parsed.astimezone(UTC)
    except ValueError:
        pass
    for fmt in ("%Y-%m-%d", "%b %d, %Y", "%b %d %Y", "%d-%b-%Y"):
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
        if posted is None or posted < cutoff or outside_geography("; ".join(locations)):
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
        if posted is None or posted < cutoff or not urls or outside_geography(location):
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
            if kind == "markdown" and not re.search(r"(?im)^\|\s*Company\s*\|.*Date Posted", raw):
                raise ValueError("feed_table_not_verified")
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
                {"source": source, "status": "failed", "lead_count": 0, "error": _error_code(exc)}
            )
    return jobs, health


def _job_bank_description(url, title, fetcher):
    soup = BeautifulSoup(fetcher(url), "html.parser")
    identity = soup.select_one('meta[property="og:url"]')
    heading = soup.select_one("h1#wb-cont")
    if (
        identity is None
        or urljoin(url, identity.get("content", "")) != url
        or heading is None
        or heading.get_text(" ", strip=True).casefold() != title.casefold()
    ):
        raise ValueError("detail_identity_mismatch")
    expiry = soup.select_one("#applynow")
    until = re.search(
        r"Advertised until\s+(\d{4}-\d{2}-\d{2})",
        expiry.get_text(" ", strip=True) if expiry else "",
    )
    if until and until[1] < datetime.now(UTC).date().isoformat():
        return None  # The posting expired after search indexing.
    requirements = soup.select_one(".job-posting-detail-requirements")
    if requirements is None or not requirements.get_text(" ", strip=True):
        raise ValueError("description_not_found")
    brief = soup.select_one(".job-posting-brief")
    return "\n".join(
        node.get_text("\n", strip=True) for node in (brief, requirements) if node is not None
    )


def discover_job_bank(search_terms: dict, *, hours_old: int, fetcher=fetch_text):
    """Read public result pages to the end, retaining partial coverage explicitly."""
    jobs, health = [], []
    cutoff = (datetime.now(UTC) - timedelta(hours=hours_old)).date()
    seen = set()
    for category, terms in search_terms.items():
        for term in terms:
            source = f"job_bank: {category} / {term}"
            found = []
            try:
                url = "https://www.jobbank.gc.ca/jobsearch/jobsearch?" + urlencode(
                    {"searchstring": term, "sort": "D"}
                )
                soup = BeautifulSoup(fetcher(url), "html.parser")
                cards = list(soup.select("a.resultJobItem"))
                identities = {card.get("href", "").split(";")[0] for card in cards}
                coverage_error = None if cards else "search_results_not_verified"
                for page_number in count(2):
                    if soup.select_one("#moreresultbutton") is None:
                        break
                    query = soup.select_one("#locationstring-querystring")
                    if query is None:
                        coverage_error = "pagination_not_verified"
                        break
                    params = [
                        (key, str(page_number) if key == "page" else value)
                        for key, value in parse_qsl(query.get("value", ""))
                    ]
                    if not any(key == "page" for key, _ in params):
                        coverage_error = "pagination_not_verified"
                        break
                    try:
                        soup = BeautifulSoup(
                            fetcher(
                                "https://www.jobbank.gc.ca/jobsearch/jobsearch?" + urlencode(params)
                            ),
                            "html.parser",
                        )
                    except Exception as exc:
                        coverage_error = _error_code(exc)
                        break
                    next_cards = list(soup.select("a.resultJobItem"))
                    next_ids = {card.get("href", "").split(";")[0] for card in next_cards}
                    if not next_ids - identities:
                        coverage_error = "pagination_did_not_advance"
                        break
                    identities.update(next_ids)
                    cards.extend(next_cards)
                for card in cards:
                    title = card.select_one(".noctitle")
                    company = card.select_one(".business")
                    location = card.select_one(".location")
                    date_node = card.select_one(".date")
                    match = re.match(r"/jobsearch/jobposting/(\d+)", card.get("href", ""))
                    if not title or not title.get_text(" ", strip=True) or not match:
                        coverage_error = coverage_error or "invalid_listing_card"
                        continue
                    date_text = date_node.get_text(" ", strip=True) if date_node else ""
                    try:
                        posted = datetime.strptime(date_text, "%B %d, %Y").date()
                    except ValueError:
                        posted = None
                        coverage_error = coverage_error or "posting_date_unknown"
                    if posted and posted < cutoff:
                        continue
                    title_text = title.get_text(" ", strip=True)
                    if not title_matches_search_lane(title_text, category):
                        continue
                    job_url = f"https://www.jobbank.gc.ca/jobsearch/jobposting/{match[1]}"
                    if job_url in seen:
                        continue
                    seen.add(job_url)
                    description = None
                    try:
                        description = _job_bank_description(job_url, title_text, fetcher)
                        if description is None:
                            continue
                    except Exception as exc:
                        coverage_error = coverage_error or (catalog_error(exc))
                    place = location.get_text(" ", strip=True) if location else ""
                    found.append(
                        _job(
                            title=title_text,
                            company=company.get_text(" ", strip=True) if company else None,
                            location=re.sub(r"^Location\s*", "", place)
                            + (", Canada" if place else ""),
                            url=job_url,
                            source="job_bank",
                            category=category,
                            description=description,
                            date_posted=posted.isoformat() if posted else None,
                        )
                    )
                jobs.extend(found)
                health.append(
                    {
                        "source": source,
                        "status": "partial" if coverage_error else "ok",
                        "lead_count": len(found),
                        "error": coverage_error,
                    }
                )
            except Exception as exc:
                health.append(
                    {
                        "source": source,
                        "status": "failed",
                        "lead_count": 0,
                        "error": _error_code(exc),
                    }
                )
    return jobs, health


def career_fetch_plan(url: str) -> dict:
    from hunter.config import DISCOVERY_COUNTRIES

    parts = urlsplit(str(url or ""))
    host = (parts.hostname or "").lower()
    if (
        host == "emploisfp-psjobs.cfp-psc.gc.ca"
        and parts.scheme == "https"
        and parts.path == "/psrs-srfp/applicant/page2440"
    ):
        return {"method": "gc_jobs", "url": url}
    # Public career links confirmed at cmu.edu/jobs/apply.html and jobs.comcast.com.
    host = {
        "cmu.wd5.myworkdayjobs.com": "cmu.wd115.myworkdayjobs.com",
        "comcast.wd5.myworkdayjobs.com": "comcast.wd115.myworkdayjobs.com",
    }.get(host, host)
    path = [part for part in parts.path.split("/") if part]
    if (
        host.endswith(".taleo.net")
        and parts.scheme == "https"
        and re.fullmatch(r"/careersection/[^/]+/jobsearch\.ftl", parts.path)
    ):
        return {"method": "taleo", "url": f"https://{host}{parts.path}"}
    if (
        host == "app.bchydro.com"
        and parts.scheme == "https"
        and parts.path == "/sap/bc/webdynpro/sap/hrrcf_a_unreg_job_search"
    ):
        return {"method": "sap", "url": url}
    if host == "careers.worksafebc.com" and parts.scheme == "https":
        return {"method": "technomedia", "url": "https://careers.worksafebc.com/"}
    if host.endswith(".recruitee.com") and parts.scheme == "https":
        catalog_path = "/" if "/o/" in parts.path else parts.path or "/"
        return {"method": "recruitee", "url": f"https://{host}{catalog_path}"}
    if (
        parts.scheme == "https"
        and parts.path.startswith("/psc/")
        and parts.path.endswith("/HRS_HRAM_FL.HRS_CG_SEARCH_FL.GBL")
    ):
        site = dict(parse_qsl(parts.query)).get("SiteId", "")
        if site.isdigit():
            return {
                "method": "peoplesoft",
                "url": f"https://{host}{parts.path}?"
                + urlencode(
                    {
                        "Page": "HRS_APP_SCHJOB_FL",
                        "Action": "U",
                        "FOCUS": "Applicant",
                        "SiteId": site,
                    }
                ),
            }
    if host.endswith(".hrsmart.com") and parts.path in {
        "/hr/ats/JobSearch/index",
        "/hr/ats/JobSearch/viewAll",
    }:
        return {"method": "hrsmart", "url": f"https://{host}/hr/ats/JobSearch/viewAll"}
    if host == "jobs.apple.com" and parts.path.rstrip("/") == "/en-ca/search":
        return {
            "method": "apple",
            "url": "https://jobs.apple.com/en-ca/search"
            + ("?location=canada-CANC" if DISCOVERY_COUNTRIES == ["Canada"] else ""),
        }
    if host == "recruitingbypaycor.com" and parts.path == "/career/CareerHome.action":
        client = dict(parse_qsl(parts.query)).get("clientId", "")
        if re.fullmatch(r"[a-f0-9]{32}", client):
            return {"method": "paycor", "url": f"https://{host}{parts.path}?clientId={client}"}
    if host == "jobs.dayforcehcm.com":
        board = re.fullmatch(
            r"/([a-z]{2}-[A-Z]{2})/([A-Za-z0-9_-]+)/([A-Za-z0-9_-]+)(?:/jobs/\d+)?/?", parts.path
        )
        if board:
            return {"method": "dayforce", "url": f"https://{host}/{board[1]}/{board[2]}/{board[3]}"}
    if (
        host == "workforcenow.adp.com"
        and parts.path == "/mascsr/default/mdf/recruitment/recruitment.html"
    ):
        query = dict(parse_qsl(parts.query))
        if re.fullmatch(r"[0-9a-f-]{36}", query.get("cid", "")) and re.fullmatch(
            r"[A-Za-z0-9_-]+", query.get("ccId", "")
        ):
            params = {key: query[key] for key in ("cid", "ccId")}
            params["lang"] = query.get("lang", "en_CA")
            return {"method": "adp", "url": f"https://{host}{parts.path}?{urlencode(params)}"}
    if host == "careers.kula.ai" and path and re.fullmatch(r"[A-Za-z0-9_-]+", path[0]):
        return {"method": "kula", "url": f"https://careers.kula.ai/{path[0]}"}
    if host in {"ats.rippling.com", "ats.us1.rippling.com"}:
        board = re.fullmatch(
            r"/(?:embed/|[a-z]{2}-[A-Z]{2}/)?([A-Za-z0-9_-]+)/jobs(?:/[0-9a-f-]{36})?/?", parts.path
        )
        if board:
            return {"method": "rippling", "url": f"https://ats.rippling.com/{board[1]}/jobs"}
    if host.endswith(".applytojob.com") and parts.path.rstrip("/") == "/apply":
        return {"method": "jazzhr", "url": f"https://{host}/apply"}
    if re.fullmatch(r"[a-z0-9-]+\.careers\.hibob\.com", host):
        return {"method": "hibob", "url": f"https://{host}/jobs"}
    if re.fullmatch(r"[a-z0-9-]+\.icims\.com", host) and parts.path.rstrip("/") == "/jobs":
        return {"method": "icims", "url": f"https://{host}/jobs?in_iframe=1"}
    if host in {"recruiting.ultipro.ca", "recruiting.ultipro.com"}:
        board = re.fullmatch(r"/([A-Za-z0-9_-]+)/JobBoard/([0-9a-f-]{36})/?", parts.path)
        if board:
            return {"method": "ukg", "url": f"https://{host}/{board[1]}/JobBoard/{board[2]}"}
    if host == "www.criticalmass.com" and parts.path.rstrip("/") == "/jobs":
        return {"method": "criticalmass", "url": "https://www.criticalmass.com/jobs"}
    if (
        host == "www.google.com"
        and parts.path.rstrip("/") == "/about/careers/applications/jobs/results"
    ):
        return {
            "method": "google",
            "url": "https://www.google.com/about/careers/applications/jobs/results/?"
            + urlencode({"location": DISCOVERY_COUNTRIES}, doseq=True),
        }
    if host == "www.capgemini.com" and parts.path.rstrip("/") in {
        "/ca-en/careers",
        "/ca-en/careers/join-capgemini/job-search",
    }:
        return {
            "method": "capgemini",
            "url": "https://www.capgemini.com/ca-en/careers/join-capgemini/job-search/",
        }
    if host == "www.okta.com" and parts.path.rstrip("/") == "/company/careers/job-listing":
        return {"method": "okta", "url": "https://www.okta.com/company/careers/job-listing/"}
    if host in {"www.amazon.jobs", "amazon.jobs"} and parts.path.rstrip("/") == "/en/search":
        return {"method": "amazon", "url": "https://www.amazon.jobs/en/search?country=CAN"}
    if host == "www.ibm.com" and parts.path.rstrip("/") == "/careers/search":
        return {
            "method": "ibm",
            "url": "https://www.ibm.com/careers/search?field_keyword_05%5B0%5D=Canada",
        }
    if host in {"api.greenhouse.io", "boards-api.greenhouse.io"}:
        catalog = re.fullmatch(r"/v1/boards/([A-Za-z0-9_-]+)/jobs/?", parts.path)
        if catalog:
            return {
                "method": "greenhouse",
                "url": f"https://boards-api.greenhouse.io/v1/boards/{catalog[1]}/jobs?content=true",
            }
    if host.endswith(".bamboohr.com") and (not path or path[0] in {"careers", "jobs"}):
        return {"method": "bamboohr", "url": f"https://{host}/careers"}
    oracle = re.match(
        r"^/hcmUI/CandidateExperience/([a-z]{2}(?:-[A-Z]{2})?)/sites/([A-Za-z0-9_-]+)(?:/|$)",
        parts.path,
    )
    if host.endswith(".oraclecloud.com") and oracle:
        return {
            "method": "oracle_hcm",
            "url": f"https://{host}/hcmUI/CandidateExperience/{oracle[1]}/sites/{oracle[2]}",
        }
    if host == "apply.workable.com" and path and path[0] not in {"j", "api"}:
        if re.fullmatch(r"[a-zA-Z0-9_-]+", path[0]):
            return {"method": "workable", "url": f"https://apply.workable.com/{path[0]}/"}
    if host in {"jobs.smartrecruiters.com", "careers.smartrecruiters.com"} and path:
        if re.fullmatch(r"[A-Za-z0-9_-]+", path[0]):
            return {
                "method": "smartrecruiters",
                "url": f"https://api.smartrecruiters.com/v1/companies/{path[0]}/postings",
            }
    if host == "www.shopify.com" and path and path[0] == "careers":
        return {"method": "shopify", "url": "https://www.shopify.com/careers"}
    if re.fullmatch(r"[a-z0-9-]+\.wd\d+\.myworkdayjobs\.com", host):
        if path and re.fullmatch(r"[a-z]{2}-[A-Z]{2}", path[0]):
            path = path[1:]
        if path:
            return {
                "method": "workday",
                "url": f"https://{host}/wday/cxs/{host.split('.')[0]}/{path[0]}",
            }
    if host in {"boards.greenhouse.io", "job-boards.greenhouse.io", "app.greenhouse.io"} and path:
        if host == "app.greenhouse.io" and path[0] != "embed":
            return {"method": "manual", "url": str(url or "")}
        board = dict(parse_qsl(parts.query)).get("for") if path[0] == "embed" else path[0]
        if not board or not re.fullmatch(r"[a-zA-Z0-9_-]+", board):
            return {"method": "manual", "url": str(url or "")}
        return {
            "method": "greenhouse",
            "url": f"https://boards-api.greenhouse.io/v1/boards/{board}/jobs?content=true",
        }
    if host in {"jobs.lever.co", "jobs.eu.lever.co"} and path:
        api_host = "api.eu.lever.co" if host == "jobs.eu.lever.co" else "api.lever.co"
        return {"method": "lever", "url": f"https://{api_host}/v0/postings/{path[0]}?mode=json"}
    if host == "jobs.ashbyhq.com" and path:
        return {
            "method": "ashby",
            "url": f"https://api.ashbyhq.com/posting-api/job-board/{path[0]}",
        }
    return {"method": "manual", "url": str(url or "")}


def resolve_career_fetch_plan(career_url, *, fetcher=fetch_text, follow_links=True):
    """Follow a published ATS board link, without guessing employer tenant names."""
    plan = career_fetch_plan(career_url)
    if plan["method"] != "manual":
        return plan
    soup = BeautifulSoup(fetcher(career_url), "html.parser")
    if soup.select_one('script[src*="/merged/js/"]') and any(
        "smartdreamers" in str(node.get("href") or node.get("src") or "")
        for node in soup.select("[href], [src]")
    ):
        return {"method": "smartdreamers", "url": career_url}
    if any(
        urlsplit(node["src"]).hostname == "app.jibecdn.com" for node in soup.select("script[src]")
    ):
        return {"method": "jibe", "url": career_url}
    if soup.select_one("#search-results[data-total-results][data-ajax-url]") and any(
        urlsplit(urljoin(career_url, node["src"])).hostname == "tbcdn.talentbrew.com"
        for node in soup.select("script[src]")
    ):
        return {"method": "talentbrew", "url": career_url}
    if any("pcsxPwa." in node["src"] for node in soup.select("script[src]")):
        for script in soup.select("script:not([src])"):
            domain = re.search(r'window\._EF_GROUP_ID\s*=\s*"([a-zA-Z0-9.-]+)"', script.get_text())
            if domain:
                return {"method": "eightfold", "url": career_url, "domain": domain[1]}
    if soup.find("script", attrs={"data-component-name": "External::Jobs"}) and any(
        urlsplit(link["href"]).hostname == "www.pinpointhq.com" for link in soup.select("a[href]")
    ):
        return {"method": "pinpoint", "url": career_url}
    if urlsplit(career_url).path.rstrip("/").lower().endswith("/careers/searchjobs") and any(
        urlsplit(node["src"]).hostname == "templates-static-assets.avacdn.net"
        for node in soup.select("script[src]")
    ):
        return {"method": "avature", "url": career_url}
    oracle_base = soup.select_one("base[data-apibaseurl][data-sitenumber][href]")
    if oracle_base:
        api = urlsplit(oracle_base["data-apibaseurl"])
        site = oracle_base["data-sitenumber"]
        locale = re.match(r"^/([a-z]{2}(?:-[A-Z]{2})?)/sites/", oracle_base["href"])
        if (
            api.scheme == "https"
            and (api.hostname or "").endswith(".oraclecloud.com")
            and re.fullmatch(r"[A-Za-z0-9_-]+", site)
            and locale
        ):
            return {
                "method": "oracle_hcm",
                "url": f"https://{api.hostname}/hcmUI/CandidateExperience/{locale[1]}/sites/{site}",
            }
    if any(
        (urlsplit(node["src"]).hostname or "").endswith(".teamtailor-cdn.com")
        for node in soup.select("script[src]")
    ):
        for link in soup.select("a[href]"):
            target = urljoin(career_url, link["href"])
            if urlsplit(target).hostname == urlsplit(career_url).hostname and re.fullmatch(
                r"(?:/[a-z]{2}(?:-[A-Z]{2})?)?/jobs/?", urlsplit(target).path
            ):
                return {"method": "teamtailor", "url": target}
    if "successfactors" in str(soup).lower():
        if "xweb/rmk-jobs-search" in str(soup) and urlsplit(career_url).path.rstrip("/").endswith(
            "/search"
        ):
            return {"method": "rmk", "url": career_url}
        form = soup.select_one('form[action] input[name="q"]')
        if form is not None:
            search_url = urljoin(career_url, form.find_parent("form")["action"])
            if urlsplit(search_url).hostname == urlsplit(career_url).hostname:
                fields = {node.get("name") for node in form.find_parent("form").select("[name]")}
                query = dict(parse_qsl(urlsplit(search_url).query))
                query.update(
                    (key, value)
                    for key, value in parse_qsl(urlsplit(career_url).query)
                    if key in fields
                )
                search_url = urlsplit(search_url)._replace(query=urlencode(query)).geturl()
                return {"method": "successfactors", "url": search_url}
    candidates = {}
    if any(
        node["src"] == "https://static-assets.ripplingcdn.com/ats/embeds/job-board.v1.js"
        for node in soup.select("script[src]")
    ):
        for node in soup.select("[data-job-board-id]"):
            board = node["data-job-board-id"]
            if re.fullmatch(r"[A-Za-z0-9_-]+", board):
                candidate = career_fetch_plan(f"https://ats.rippling.com/{board}/jobs")
                candidates[candidate["url"]] = candidate
    for node in soup.select("script:not([src])"):
        for _, board in re.findall(
            r"\bwindow\.greenhouseBoardName\s*=\s*([\"'])([A-Za-z0-9_-]+)\1\s*;",
            node.get_text(),
        ):
            candidate = career_fetch_plan(f"https://job-boards.greenhouse.io/{board}")
            candidates[candidate["url"]] = candidate
    if any(
        urlsplit(urljoin(career_url, node["src"])).hostname == "www.workable.com"
        and urlsplit(node["src"]).path == "/assets/embed.js"
        for node in soup.select("script[src]")
    ):
        for node in soup.select("script:not([src])"):
            for account in re.findall(r"\bwhr_embed\(\s*([0-9]+)\s*,", node.get_text()):
                target = (
                    f"https://apply.workable.com/api/v1/widget/accounts/{account}"
                    "?origin=embed&callback=whrcallback&details=true"
                )
                candidates[target] = {"method": "workable_widget", "url": target}
    for node in soup.select("a[href], iframe[src], script[src]"):
        target = urljoin(career_url, node.get("href") or node.get("src") or "")
        parsed = urlsplit(target)
        if (
            node.name == "script"
            and parsed.scheme == "https"
            and (parsed.hostname or "").endswith(".bamboohr.com")
            and parsed.path == "/js/embed.js"
        ):
            target = f"https://{parsed.hostname}/careers"
        candidate = career_fetch_plan(target)
        if candidate["method"] != "manual":
            candidates[candidate["url"]] = candidate
    # Some directories publish their links as serialized data for client-side rendering.
    embedded = [node.get_text() for node in soup.select("script:not([src])")]
    embedded.extend(
        value
        for node in soup.find_all(True)
        for value in node.attrs.values()
        if isinstance(value, str)
    )
    for text in embedded:
        for target in re.findall(
            r"https://(?:job-boards\.greenhouse\.io|boards\.greenhouse\.io|"
            r"(?:api|boards-api)\.greenhouse\.io|"
            r"[a-z0-9-]+\.wd\d+\.myworkdayjobs\.com|"
            r"jobs\.ashbyhq\.com|jobs\.(?:eu\.)?lever\.co|(?:jobs|careers)\.smartrecruiters\.com)/[^\"'\s<>\\]+",
            text.replace(r"\/", "/"),
        ):
            candidate = career_fetch_plan(target)
            if candidate["method"] != "manual":
                candidates[candidate["url"]] = candidate
    if len(candidates) == 1:
        return next(iter(candidates.values()))
    if not candidates:
        if (
            _script_object(soup, r"window\.__PRELOAD_STATE__\s*=\s*").get("jobSearch")
            and any(
                urlsplit(node["src"]).hostname == "cdn.sites.paradox.ai"
                for node in soup.select("script[src]")
            )
            and urlsplit(career_url).path.rstrip("/") == "/jobs"
        ):
            return {"method": "paradox", "url": career_url}
        from hunter.discovery_phenom import phenom_fetch_plan

        phenom = phenom_fetch_plan(soup, career_url)
        if phenom:
            return phenom
    if not candidates and follow_links:
        # Some employers embed the hiring board on a job detail rather than the directory.
        visited = {career_url}
        listing_label = re.compile(
            r"\b(?:job search|open (?:positions|roles|jobs)|(?:view|see|search|all|explore|find) (?:all |a )?(?:jobs?|positions|roles|careers))\b",
            re.I,
        )
        links = sorted(
            soup.select("a[href]"),
            key=lambda a: not bool(listing_label.search(a.get_text(" ", strip=True))),
        )
        for link in links:
            target = urljoin(career_url, link.get("href") or "")
            title = link.get_text(" ", strip=True)
            if (
                target in visited
                or urlsplit(target).hostname != urlsplit(career_url).hostname
                or urlsplit(target).scheme not in {"http", "https"}
                or not (listing_label.search(title) or matching_search_lane(title))
            ):
                continue
            visited.add(target)
            try:
                candidate = resolve_career_fetch_plan(target, fetcher=fetcher, follow_links=False)
                if candidate["method"] not in {"manual", "structured"}:
                    return candidate
            except Exception:
                pass
            if len(visited) >= 4:
                break
    return {
        **plan,
        "error": "ambiguous_career_boards" if candidates else "career_adapter_unavailable",
        **({"boards": list(candidates.values())} if candidates else {}),
    }


def post_public_json(url: str, payload: dict, timeout=25, *, headers=None):
    request = Request(
        url,
        data=json.dumps(payload).encode(),
        headers={
            "User-Agent": "Hunt-C1/1.0",
            "Content-Type": "application/json",
            **(headers or {}),
        },
    )
    return json.loads(_read_public_response(request, timeout))


def discover_bamboohr(company, plan, *, fetcher=fetch_text):
    """Read the public careers feed and its open posting details."""
    jobs, seen = [], set()
    error, fetched = None, False
    catalog_complete = False
    try:
        payload = json.loads(fetcher(plan["url"] + "/list"))
        rows = payload.get("result")
        if not isinstance(rows, list):
            raise ValueError("invalid_bamboohr_catalog")
        total = int(payload["meta"]["totalCount"])
        fetched = True
        if total != len(rows):
            error = "catalog_count_mismatch"
        for row in rows:
            if (
                not isinstance(row, dict)
                or not str(row.get("id", "")).isdigit()
                or not row.get("jobOpeningName")
            ):
                error = "invalid_bamboohr_listing"
                continue
            identity = str(row["id"])
            if identity in seen:
                error = "duplicate_listing"
                continue
            seen.add(identity)
            title = row["jobOpeningName"].strip()
            place = public_posting_location("bamboohr", row)
            country = (row.get("atsLocation") or {}).get("country") or (
                row.get("location") or {}
            ).get("addressCountry")
            if (
                outside_country(country)
                or outside_geography(place)
                or not matching_search_lane(title)
            ):
                continue
            url = plan["url"] + "/" + identity
            description, posted = None, None
            try:
                detail = json.loads(fetcher(url + "/detail"))["result"]["jobOpening"]
                if (
                    canonical_job_key(detail.get("jobOpeningShareUrl")) != canonical_job_key(url)
                    or str(detail.get("jobOpeningName") or "").strip() != title
                ):
                    raise ValueError("detail_identity_mismatch")
                if not detail.get("jobOpeningStatus"):
                    raise ValueError("posting_status_missing")
                if detail["jobOpeningStatus"] != "Open":
                    continue
                place = public_posting_location("bamboohr", detail)
                country = (detail.get("atsLocation") or {}).get("country") or (
                    detail.get("location") or {}
                ).get("addressCountry")
                if outside_country(country) or outside_geography(place):
                    continue
                description = html_text(unescape(detail.get("description") or ""))
                if not description:
                    raise ValueError("description_not_found")
                date = _parse_date(detail.get("datePosted"))
                posted = date.date().isoformat() if date else None
            except Exception as exc:
                error = catalog_error(exc)
            jobs.append(
                _job(
                    title=title,
                    company=company,
                    location=place,
                    url=url,
                    source="employer_bamboohr",
                    description=description,
                    date_posted=posted,
                )
            )
        catalog_complete = len(seen) == total
    except Exception as exc:
        error = catalog_error(exc)
    return discovery_result(plan, jobs, error, fetched, catalog_complete=catalog_complete)


def discover_oracle_hcm(company, plan, *, fetcher=fetch_text):
    """Read the public Candidate Experience search and posting-detail feeds."""
    from hunter.config import DISCOVERY_COUNTRIES

    location_filter = DISCOVERY_COUNTRIES[0] if len(DISCOVERY_COUNTRIES) == 1 else ""
    board = plan["url"].rstrip("/")
    site = board.rsplit("/", 1)[-1]
    api = "https://" + urlsplit(board).netloc + "/hcmRestApi/resources/latest/"
    jobs, seen = [], set()
    offset, pages = 0, 0
    error = None

    def location(row):
        names = []
        places = [(row.get("PrimaryLocation"), row.get("PrimaryLocationCountry"))]
        places.extend(
            (p.get("Name"), p.get("CountryCode")) for p in row.get("secondaryLocations") or []
        )
        for name, country in places:
            name = name or ""
            country = {"CA": "Canada", "US": "United States"}.get(country, country)
            if country and country.lower() not in name.lower():
                name = f"{name}, {country}" if name else country
            if name and name not in names:
                names.append(name)
        explicitly_outside = all(outside_country(country) for _, country in places)
        return "; ".join(names) or None, explicitly_outside

    catalog_complete = False
    try:
        while True:
            query = urlencode(
                {
                    "onlyData": "true",
                    "expand": "requisitionList.secondaryLocations",
                    "finder": f"findReqs;siteNumber={site},facetsList=NONE,limit=12,location={location_filter},sortBy=POSTING_DATES_DESC,offset={offset}",
                }
            )
            payload = json.loads(fetcher(api + "recruitingCEJobRequisitions?" + query))
            items = payload.get("items")
            if not isinstance(items, list) or len(items) != 1:
                raise ValueError("invalid_oracle_search")
            result = items[0]
            rows = result.get("requisitionList")
            total = int(result["TotalJobsCount"])
            if (
                not isinstance(rows, list)
                or total < 0
                or int(result["Offset"]) != offset
                or result.get("SiteNumber") != site
                or (result.get("Location") or "") != location_filter
                or offset + len(rows) > total
            ):
                raise ValueError("invalid_oracle_page")
            if not rows and offset < total:
                raise ValueError("catalog_count_mismatch")
            if any(
                not isinstance(r, dict) or not str(r.get("Id", "")).isdigit() or not r.get("Title")
                for r in rows
            ):
                raise ValueError("invalid_oracle_listing")
            identities = [str(row["Id"]) for row in rows]
            if len(set(identities)) != len(identities) or seen.intersection(identities):
                raise ValueError("pagination_repeated")
            seen.update(identities)
            pages += 1
            for row in rows:
                place, outside = location(row)
                if outside or outside_geography(place) or not matching_search_lane(row["Title"]):
                    continue
                description = None
                posted = row.get("PostedDate")
                try:
                    query = urlencode(
                        {
                            "expand": "all",
                            "onlyData": "true",
                            "finder": f'ById;Id="{row["Id"]}",siteNumber={site}',
                        }
                    )
                    details = json.loads(
                        fetcher(api + "recruitingCEJobRequisitionDetails?" + query)
                    ).get("items")
                    if not isinstance(details, list) or len(details) != 1:
                        raise ValueError("posting_details_missing")
                    detail = details[0]
                    if (
                        str(detail.get("Id")) != str(row["Id"])
                        or detail.get("Title") != row["Title"]
                    ):
                        raise ValueError("detail_identity_mismatch")
                    ends = _parse_date(detail.get("ExternalPostedEndDate"))
                    if ends and ends < datetime.now(UTC):
                        continue
                    place, outside = location(detail)
                    if outside or outside_geography(place):
                        continue
                    content = "\n".join(
                        detail.get(field) or ""
                        for field in (
                            "ExternalDescriptionStr",
                            "ExternalResponsibilitiesStr",
                            "ExternalQualificationsStr",
                        )
                    )
                    description = html_text(unescape(content))
                    if not description:
                        raise ValueError("description_not_found")
                    posted = detail.get("ExternalPostedStartDate") or posted
                except Exception as exc:
                    error = catalog_error(exc)
                parsed_date = _parse_date(posted)
                jobs.append(
                    _job(
                        title=row["Title"],
                        company=company,
                        location=place,
                        url=f"{board}/job/{row['Id']}",
                        source="employer_oracle_hcm",
                        date_posted=parsed_date.date().isoformat() if parsed_date else None,
                        description=description,
                    )
                )
            offset += len(rows)
            if offset >= total:
                break
        catalog_complete = True
    except Exception as exc:
        error = catalog_error(exc)
    return discovery_result(plan, jobs, error, pages, catalog_complete=catalog_complete)


def public_posting_location(provider, row):
    """Use the employer's published locations, not an aggregator's inferred location."""
    if provider == "workable":
        return (
            "; ".join(
                ", ".join(
                    str(place[key]) for key in ("city", "region", "country") if place.get(key)
                )
                for place in row.get("locations") or [row.get("location") or {}]
                if isinstance(place, dict) and not place.get("hidden")
            )
            or None
        )
    if provider == "smartrecruiters":
        place = row.get("location") or {}
        location = place.get("fullLocation") or ", ".join(
            str(place[key]) for key in ("city", "region", "country") if place.get(key)
        )
        if str(place.get("country", "")).lower() == "ca" and "canada" not in location.lower():
            location += ", Canada"
        return location.strip(", ") or None
    if provider == "workday":
        places = [row.get("location", ""), *(row.get("additionalLocations") or [])]
        location = "; ".join(str(place) for place in places if place)
        country = (row.get("country") or {}).get("descriptor", "")
        return (location + (", " + country if country else "")).strip(", ") or None
    if provider == "greenhouse":
        return (row.get("location") or {}).get("name") or None
    if provider == "lever":
        return (row.get("categories") or {}).get("location") or None
    if provider == "bamboohr":
        place = row.get("atsLocation") or {}
        if not any(place.get(k) for k in ("city", "state", "province", "country")):
            place = row.get("location") or {}
        return (
            ", ".join(
                str(p)
                for p in (
                    place.get("city"),
                    place.get("state") or place.get("province"),
                    place.get("country") or place.get("addressCountry"),
                )
                if p
            )
            or None
        )
    names = []
    for item in [row, *(row.get("secondaryLocations") or [])]:
        name = item.get("location") or ""
        country = ((item.get("address") or {}).get("postalAddress") or {}).get("addressCountry")
        if country in {"CA", "CAN", "Canada"}:
            name = f"{name}, Canada" if name else "Canada"
        if name and name not in names:
            names.append(name)
    return "; ".join(names) or None


def discover_workday(company, plan, *, fetcher=fetch_text, poster=post_public_json, hours_old=None):
    jobs, seen = [], set()
    pages_read = 0
    error, expected_total, catalog_complete = None, None, False
    try:
        query = {"limit": 20, "offset": 0, "searchText": "", "appliedFacets": {}}
        payload = poster(plan["url"] + "/jobs", query)
        # Use published filter IDs, including location groups on boards without a country filter.
        facets = list(payload.get("facets", []))
        for facet in facets:
            facets.extend(value for value in facet.get("values", []) if value.get("facetParameter"))
        from hunter.config import DISCOVERY_COUNTRIES

        for facet in sorted(
            facets, key=lambda f: "country" not in str(f.get("facetParameter", "")).lower()
        ):
            field = str(facet.get("facetParameter", ""))
            if not DISCOVERY_COUNTRIES or ("country" not in field.lower() and field != "locations"):
                continue
            selected = [
                value["id"]
                for value in facet.get("values", [])
                if value.get("id")
                and (
                    geography_suppression(value.get("descriptor")) is None
                    or field == "locations"
                    and geography_suppression(value.get("descriptor")) == "geography_unverified"
                )
            ]
            if selected:
                query["appliedFacets"] = {field: selected}
                payload = poster(plan["url"] + "/jobs", query)
                break
        offset = 0
        while True:
            if offset:
                payload = poster(plan["url"] + "/jobs", {**query, "offset": offset})
            rows = payload["jobPostings"]
            total = payload["total"]
            if (
                not isinstance(rows, list)
                or type(total) is not int
                or total < 0
                or offset + len(rows) > total
                or (not rows and offset < total)
            ):
                raise ValueError("invalid_workday_page")
            if expected_total is not None and expected_total != total:
                raise ValueError("catalog_count_changed")
            expected_total = total
            if any(
                not isinstance(row, dict)
                or not isinstance(row.get("externalPath"), str)
                or not re.fullmatch(r"/job/[^?#]+", row["externalPath"])
                or not isinstance(row.get("title"), str)
                or not row["title"].strip()
                for row in rows
            ):
                raise ValueError("invalid_workday_listing")
            identities = {row["externalPath"] for row in rows}
            if len(identities) != len(rows) or identities & seen:
                raise ValueError("pagination_repeated")
            pages_read += 1
            for row in rows:
                path = row.get("externalPath", "")
                seen.add(path)
                age = re.fullmatch(r"Posted (\d+)\+? Days Ago", str(row.get("postedOn", "")))
                if hours_old is not None and age and int(age[1]) * 24 > hours_old:
                    continue
                if not matching_search_lane(row.get("title")):
                    continue
                try:
                    detail = json.loads(fetcher(plan["url"] + path))["jobPostingInfo"]
                    if detail.get("canApply") is False:
                        continue
                    location = public_posting_location("workday", detail)
                    if outside_geography(location):
                        continue
                    jobs.append(
                        _job(
                            title=detail["title"],
                            company=company,
                            location=location,
                            url=detail["externalUrl"],
                            source="employer_workday",
                            employment_type=detail.get("timeType"),
                            date_posted=detail.get("startDate"),
                            description=detail.get("jobDescription"),
                        )
                    )
                except Exception as exc:
                    error = _error_code(exc)
                    # Keep the catalog's observed posting when its detail temporarily fails.
                    # This URL is built from the published board and externalPath, not a guessed ID.
                    board = urlsplit(plan["url"])
                    jobs.append(
                        _job(
                            title=row["title"],
                            company=company,
                            location=row.get("locationsText"),
                            url=f"https://{board.netloc}/{board.path.rsplit('/', 1)[-1]}{path}",
                            source="employer_workday",
                        )
                    )
            if len(seen) == total:
                catalog_complete = True
                break
            offset += len(rows)
    except Exception as exc:
        error = catalog_error(exc)
    return discovery_result(plan, jobs, error, pages_read, catalog_complete=catalog_complete)


def _shopify_rows(soup):
    """Decode scalar fields in Shopify's published React Router payload."""
    marker = "window.__reactRouterContext.streamController.enqueue("
    for script in soup.select("script"):
        text = script.get_text()
        if marker not in text:
            continue
        encoded, _ = json.JSONDecoder().raw_decode(text.split(marker, 1)[1])
        nodes = json.loads(encoded)
        if not isinstance(nodes, list):
            raise ValueError("invalid_employer_catalog")
        for node in nodes:
            if isinstance(node, dict):
                yield {
                    nodes[int(key[1:])]: nodes[value]
                    for key, value in node.items()
                    if key.startswith("_")
                    and key[1:].isdigit()
                    and int(key[1:]) < len(nodes)
                    and isinstance(nodes[int(key[1:])], str)
                    and type(value) is int
                    and 0 <= value < len(nodes)
                }


def discover_shopify(company, plan, *, fetcher=fetch_text):
    """Read published listings in the page's React Router payload, without executing scripts."""
    jobs, seen, errors = [], set(), []
    try:
        soup = BeautifulSoup(fetcher(plan["url"]), "html.parser")
        visible_locations, detail_urls = {}, {}
        for heading in soup.select("a[href] h4"):
            link = heading.find_parent("a")
            identity = re.search(r"_([0-9a-f-]{36})$", link["href"])
            location = link.select_one(".location")
            if identity:
                detail_url = urljoin(plan["url"], link["href"])
                if urlsplit(detail_url).hostname != "www.shopify.com":
                    raise ValueError("posting_identity_mismatch")
                detail_urls[identity[1]] = detail_url
                visible_locations[identity[1]] = (
                    location.get_text(" ", strip=True) if location else ""
                )
        for row in _shopify_rows(soup):
            if row.get("status") != "Published" or row.get("isListed") is not True:
                continue
            title, url = row.get("title"), row.get("externalLink")
            if (
                not isinstance(title, str)
                or not isinstance(url, str)
                or urlsplit(url).hostname != "www.shopify.com"
            ):
                continue
            identity = row.get("id")
            if (
                not isinstance(identity, str)
                or identity in seen
                or identity not in visible_locations
            ):
                continue
            seen.add(identity)
            location = (
                visible_locations[identity]
                or row.get("locationExternalName")
                or row.get("locationName")
                or ""
            )
            if outside_geography(location):
                continue
            description = None
            try:
                details = list(
                    _shopify_rows(BeautifulSoup(fetcher(detail_urls[identity]), "html.parser"))
                )
                detail = next(
                    (
                        item
                        for item in details
                        if item.get("id") == identity and "descriptionPlain" in item
                    ),
                    None,
                )
                if not detail or detail.get("title") != title:
                    raise ValueError("posting_identity_mismatch")
                if detail.get("status") != "Published" or detail.get("isListed") is not True:
                    continue
                description = detail.get("descriptionPlain")
                if not isinstance(description, str) or not description.strip():
                    raise ValueError("description_not_found")
            except Exception as exc:
                description = None
                errors.append(catalog_error(exc))
            jobs.append(
                _job(
                    title=title,
                    company=company,
                    location=location,
                    url=url,
                    source="employer_shopify",
                    description=description,
                    date_posted=row.get("publishedDate"),
                )
            )
        if not seen:
            raise ValueError("employer_search_response_unrecognized")
        if set(visible_locations) != seen:
            errors.append("catalog_listing_missing")
        return jobs, {
            **plan,
            "status": "partial" if errors else "ok",
            "error": errors[0] if errors else None,
            "lead_count": len(jobs),
        }
    except Exception as exc:
        return discovery_result(plan, jobs, catalog_error(exc), jobs, catalog_complete=False)


def discover_successfactors(company, plan, *, fetcher=fetch_text, hours_old=None):
    """Read search tables or the published SearchResults tile paging contract."""
    jobs, seen, pages = [], set(), set()
    url, error = plan["url"], None
    tile_endpoint, tile_total, tile_query = None, None, {}
    cutoff = (
        (datetime.now(UTC) - timedelta(hours=hours_old)).date() if hours_old is not None else None
    )
    try:
        while url:
            if url in pages:
                raise ValueError("repeated_page")
            pages.add(url)
            soup = BeautifulSoup(fetcher(url), "html.parser")
            if soup.select_one("#job-tile-list") is not None and tile_endpoint is None:
                scripts = "\n".join(n.get_text() for n in soup.select("script:not([src])"))
                config = re.search(r"j2w\.SearchResults\.init\(\s*\{(.*?)\}\s*\)", scripts, re.S)
                settings = config[1] if config else ""
                total = re.search(r'\bjobRecordsFound\s*:\s*parseInt\("(\d+)"\)', settings)
                query = re.search(r'\bsearchQuery\s*:\s*("(?:\\.|[^"\\])*")', settings)
                if (
                    not total
                    or not query
                    or not re.search(r'\bapiEndpoint\s*:\s*"tile-search-results"', settings)
                    or not urlsplit(url).path.rstrip("/").endswith("/search")
                ):
                    raise ValueError("tile_pagination_unverified")
                tile_total = int(total[1])
                tile_query = dict(
                    parse_qsl(json.loads(query[1]).lstrip("?"), keep_blank_values=True)
                )
                tile_endpoint = urljoin(
                    url.split("?", 1)[0].rstrip("/") + "/", "../tile-search-results/"
                )
            if soup.select_one("#searchresults") is None and tile_endpoint is None:
                raise ValueError("employer_search_response_unrecognized")
            rows = soup.select("li.job-tile" if tile_endpoint else "tr.data-row")
            page_urls = set()
            fresh_count = 0
            for row in rows:
                link = row.select_one("a.jobTitle-link[href]")
                if link is None:
                    error = "invalid_employer_listing"
                    continue
                job_url = urljoin(url, link["href"])
                if urlsplit(job_url).hostname != urlsplit(plan["url"]).hostname:
                    raise ValueError("posting_target_unverified")
                page_urls.add(job_url)
                if job_url in seen:
                    if tile_endpoint:
                        raise ValueError("repeated_page")
                    continue
                fresh_count += 1
                seen.add(job_url)
                title = link.get_text(" ", strip=True)
                location_node, date_node = (
                    row.select_one('.jobLocation, .section-field.location [id$="-value"]'),
                    row.select_one('.jobDate, .section-field.date [id$="-value"]'),
                )
                location = location_node.get_text(" ", strip=True) if location_node else ""
                if outside_geography(location) or not matching_search_lane(title):
                    continue
                posted = _parse_date(date_node.get_text(" ", strip=True)) if date_node else None
                if cutoff is not None and posted is not None and posted.date() < cutoff:
                    continue
                description = None
                try:
                    detail = BeautifulSoup(fetcher(job_url), "html.parser")
                    content = detail.select('[itemprop="description"]') or detail.select(
                        ".jobdescription"
                    )
                    if not content and any(
                        node.get_text(" ", strip=True) == "Sorry, this job posting has ended."
                        for node in detail.select("strong")
                    ):
                        continue
                    description = (
                        "\n\n".join(node.get_text("\n", strip=True) for node in content) or None
                    )
                    if not description:
                        error = "description_not_found"
                except Exception as exc:
                    error = _error_code(exc)
                jobs.append(
                    _job(
                        title=title,
                        company=company,
                        location=location,
                        url=job_url,
                        source="employer_successfactors",
                        date_posted=posted.date().isoformat() if posted else None,
                        description=description,
                    )
                )
            offset = int(dict(parse_qsl(urlsplit(url).query)).get("startrow", "0"))
            next_pages = {}
            for link in soup.select('a[href*="startrow="]'):
                target = urljoin(url, link["href"])
                candidate = dict(parse_qsl(urlsplit(target).query)).get("startrow", "")
                if (
                    candidate.isdigit()
                    and int(candidate) > offset
                    and urlsplit(target).hostname == urlsplit(url).hostname
                ):
                    next_pages[int(candidate)] = target
            next_url = next_pages[min(next_pages)] if next_pages else None
            if tile_endpoint:
                if len(seen) > tile_total:
                    raise ValueError("catalog_count_mismatch")
                next_url = (
                    tile_endpoint + "?" + urlencode({**tile_query, "startrow": len(seen)})
                    if len(seen) < tile_total
                    else None
                )
            if rows and not page_urls:
                raise ValueError("invalid_employer_listing")
            if rows and fresh_count == 0:
                raise ValueError("repeated_page")
            if next_url and not rows:
                raise ValueError("empty_page_with_next")
            url = next_url
        return discovery_result(plan, jobs, error, True, catalog_complete=True)
    except Exception as exc:
        return discovery_result(plan, jobs, catalog_error(exc), jobs, catalog_complete=False)


def discover_smartrecruiters(company, plan, *, fetcher=fetch_text):
    """Read the public Posting API to its reported end, retaining partial results."""
    jobs, seen, offset, error = [], set(), 0, None
    tenant = plan["url"].split("/")[-2]
    expected = None
    try:
        while True:
            payload = json.loads(fetcher(plan["url"] + f"?limit=100&offset={offset}"))
            rows, total = payload.get("content"), payload.get("totalFound")
            if (
                not isinstance(rows, list)
                or type(total) is not int
                or total < 0
                or payload.get("offset") != offset
            ):
                raise ValueError("invalid_employer_catalog")
            if expected is not None and total != expected:
                raise ValueError("catalog_changed_during_scan")
            expected = total
            for row in rows:
                if not isinstance(row, dict) or not str(row.get("id", "")).isdigit():
                    error = "invalid_employer_listing"
                    continue
                identity = str(row["id"])
                if identity in seen:
                    raise ValueError("repeated_page")
                seen.add(identity)
                title = row.get("name") or ""
                location = public_posting_location("smartrecruiters", row)
                if (
                    row.get("visibility", "PUBLIC") != "PUBLIC"
                    or outside_geography(location)
                    or not matching_search_lane(title)
                ):
                    continue
                url = f"https://jobs.smartrecruiters.com/{tenant}/{identity}"
                description = None
                try:
                    detail = json.loads(fetcher(plan["url"] + "/" + identity))
                    if str(detail.get("id")) != identity or detail.get("name") != title:
                        raise ValueError("detail_identity_mismatch")
                    if detail.get("active") is False or detail.get("visibility") != "PUBLIC":
                        continue
                    posting = detail.get("postingUrl") or ""
                    if urlsplit(posting).hostname != "jobs.smartrecruiters.com" or not re.match(
                        rf"/{re.escape(tenant)}/{identity}(?:-|$)", urlsplit(posting).path
                    ):
                        raise ValueError("detail_identity_mismatch")
                    url = posting
                    sections = (detail.get("jobAd") or {}).get("sections") or {}
                    description = "\n".join(
                        html_text(section.get("text") or "")
                        for section in sections.values()
                        if isinstance(section, dict)
                    ).strip()
                    if not description:
                        error = "description_not_found"
                except Exception as exc:
                    error = catalog_error(exc)
                jobs.append(
                    _job(
                        title=title,
                        company=company,
                        location=location,
                        url=url,
                        source="employer_smartrecruiters",
                        date_posted=row.get("releasedDate"),
                        description=description,
                    )
                )
            offset += len(rows)
            if offset > total:
                raise ValueError("catalog_count_mismatch")
            if offset == total:
                break
            if not rows:
                raise ValueError("empty_page_with_next")
        return discovery_result(plan, jobs, error, True, catalog_complete=len(seen) == expected)
    except Exception as exc:
        return discovery_result(plan, jobs, catalog_error(exc), jobs, catalog_complete=False)


def discover_workable_widget(company, plan, *, fetcher=fetch_text):
    """Decode the public embed payload as data, never as executable JavaScript."""
    jobs, seen, error = [], set(), None
    try:
        raw = fetcher(plan["url"]).strip()
        match = re.fullmatch(r"(?:/\*\*/)?whrcallback\((.*)\);?", raw, re.S)
        if not match:
            raise ValueError("invalid_employer_catalog")
        payload = json.loads(match[1])
        if not isinstance(payload, dict) or not isinstance(payload.get("jobs"), list):
            raise ValueError("invalid_employer_catalog")
        for row in payload["jobs"]:
            if not isinstance(row, dict):
                error = "invalid_employer_listing"
                continue
            title, url = row.get("title"), row.get("url") or ""
            if (
                not title
                or urlsplit(url).hostname != "apply.workable.com"
                or urlsplit(url).scheme != "https"
            ):
                error = "invalid_employer_listing"
                continue
            if url in seen:
                continue
            places = row.get("locations") or [row]
            location = "; ".join(
                ", ".join(
                    str(place[key]) for key in ("city", "region", "country") if place.get(key)
                )
                for place in places
                if isinstance(place, dict) and not place.get("hidden")
            )
            if outside_geography(location) or not matching_search_lane(title):
                continue
            seen.add(url)
            description = html_text(row.get("description") or "")
            if not description:
                error = "description_not_found"
            jobs.append(
                _job(
                    title=title,
                    company=company,
                    location=location,
                    url=url,
                    source="employer_workable",
                    date_posted=row.get("published_on"),
                    description=description,
                )
            )
        return discovery_result(plan, jobs, error, True, catalog_complete=True)
    except Exception as exc:
        return discovery_result(plan, jobs, catalog_error(exc), jobs, catalog_complete=False)


def discover_workable(company, plan, *, fetcher=fetch_text, poster=post_public_json):
    """Follow the public directory's nextPage tokens, not guessed page offsets."""
    tenant = urlsplit(plan["url"]).path.strip("/")
    api = f"https://apply.workable.com/api/v3/accounts/{tenant}/jobs"
    jobs, seen, tokens, token, error = [], set(), set(), None, None
    received = 0
    try:
        while True:
            payload = poster(api, {"token": token} if token else {})
            rows, total = payload.get("results"), payload.get("total")
            if not isinstance(rows, list) or type(total) is not int or total < 0:
                raise ValueError("invalid_employer_catalog")
            fresh = 0
            for row in rows:
                code = row.get("shortcode") if isinstance(row, dict) else None
                if not isinstance(code, str) or not re.fullmatch(r"[A-Za-z0-9]+", code):
                    error = "invalid_employer_listing"
                    continue
                if code in seen:
                    continue
                seen.add(code)
                fresh += 1
                title = row.get("title") or ""
                location = public_posting_location("workable", row)
                if (
                    row.get("state") != "published"
                    or row.get("isInternal") is not False
                    or outside_geography(location)
                    or not matching_search_lane(title)
                ):
                    continue
                description = None
                try:
                    detail = json.loads(
                        fetcher(f"https://apply.workable.com/api/v2/accounts/{tenant}/jobs/{code}")
                    )
                    if detail.get("shortcode") != code or detail.get("title") != title:
                        raise ValueError("detail_identity_mismatch")
                    if detail.get("state") != "published" or detail.get("isInternal") is not False:
                        continue
                    description = "\n".join(
                        html_text(detail.get(key) or "")
                        for key in ("description", "requirements", "benefits")
                    ).strip()
                    if not description:
                        error = "description_not_found"
                except Exception as exc:
                    error = catalog_error(exc)
                jobs.append(
                    _job(
                        title=title,
                        company=company,
                        location=location,
                        url=f"https://apply.workable.com/{tenant}/j/{code}/",
                        source="employer_workable",
                        date_posted=row.get("published"),
                        description=description,
                    )
                )
            received += len(rows)
            next_token = payload.get("nextPage")
            if rows and not fresh:
                raise ValueError("repeated_page")
            if not next_token:
                if received < total:
                    raise ValueError("pagination_incomplete")
                break
            if not rows or not isinstance(next_token, str) or next_token in tokens:
                raise ValueError("pagination_repeated_or_empty")
            tokens.add(next_token)
            token = next_token
        return discovery_result(plan, jobs, error, True, catalog_complete=True)
    except Exception as exc:
        return discovery_result(plan, jobs, catalog_error(exc), jobs, catalog_complete=False)


def discover_teamtailor(company, plan, *, fetcher=fetch_text):
    """Follow published show-more links and read each matching JobPosting record."""
    jobs, seen, pages, error = [], set(), set(), None
    url = plan["url"]
    origin = urlsplit(url).hostname
    try:
        while url:
            if url in pages:
                raise ValueError("repeated_page")
            pages.add(url)
            soup = BeautifulSoup(fetcher(url), "html.parser")
            fresh = 0
            for link in soup.select("a[href]"):
                target = urljoin(url, link["href"])
                identity = re.search(r"/jobs/(\d+)-", urlsplit(target).path)
                if not identity or urlsplit(target).hostname != origin or identity[1] in seen:
                    continue
                fresh += 1
                seen.add(identity[1])
                heading = link.select_one("[title]")
                title = heading["title"] if heading else link.get_text(" ", strip=True)
                if not matching_search_lane(title):
                    continue
                location, description, posted = "", None, None
                try:
                    detail = BeautifulSoup(fetcher(target), "html.parser")
                    records = job_postings(detail)
                    record = records[0] if len(records) == 1 else None
                    if (
                        not record
                        or str((record.get("identifier") or {}).get("value")) != identity[1]
                    ):
                        raise ValueError("detail_identity_mismatch")
                    expired = _parse_date(record.get("validThrough"))
                    if expired and expired < datetime.now(UTC):
                        continue
                    title = record.get("title") or title
                    location = posting_location(record)
                    description = html_text(unescape(record.get("description") or ""))
                    posted = record.get("datePosted")
                    if not description:
                        error = "description_not_found"
                except Exception as exc:
                    error = catalog_error(exc)
                if geography_suppression(location) not in {
                    "outside_canada",
                    "outside_search_geography",
                }:
                    jobs.append(
                        _job(
                            title=title,
                            company=company,
                            location=location,
                            url=target,
                            source="employer_teamtailor",
                            date_posted=posted,
                            description=description,
                        )
                    )
            if not fresh:
                raise ValueError("employer_search_response_unrecognized_or_repeated")
            next_link = soup.select_one('a[href*="/jobs/show_more?"]')
            url = urljoin(url, next_link["href"]) if next_link else None
            if url and urlsplit(url).hostname != origin:
                raise ValueError("pagination_target_unverified")
        return discovery_result(plan, jobs, error, True, catalog_complete=True)
    except Exception as exc:
        return discovery_result(plan, jobs, catalog_error(exc), jobs, catalog_complete=False)


def discover_company_career_site(
    company: str,
    career_url: str,
    *,
    fetcher=fetch_text,
    poster=post_public_json,
    hours_old=None,
    rendered_resolver=None,
    resolved_plan=None,
    refresh_plan=False,
):
    if resolved_plan and resolved_plan.get("method") in {"google", "apple"}:
        # These URLs contain the selected geography. Rebuild their local plan;
        # a cached URL must never silently retain an earlier country filter.
        resolved_plan = career_fetch_plan(career_url)
    if resolved_plan and refresh_plan:
        try:
            current = resolve_career_fetch_plan(career_url, fetcher=fetcher)
            if current["method"] != "manual":
                resolved_plan = current
        except Exception:
            pass  # A failing marketing page cannot invalidate a still-readable employer board.
    # A detail loop must not keep sending requests after the source asks us to back off.
    rate_limit = None

    def guarded(request):
        def call(*args, **kwargs):
            nonlocal rate_limit
            if rate_limit is not None:
                raise rate_limit
            try:
                return request(*args, **kwargs)
            except HTTPError as exc:
                if exc.code == 429:
                    rate_limit = exc
                raise

        return call

    fetcher, poster = cache(guarded(fetcher)), guarded(poster)
    previous_failure = None
    if resolved_plan:
        jobs, health = _discover_company_plan(
            company, resolved_plan, fetcher=fetcher, poster=poster, hours_old=hours_old
        )
        if jobs or health.get("error") not in {
            "http_404",
            "http_410",
            "career_adapter_unavailable",
            "employer_search_response_unrecognized",
            "board_identity_mismatch",
        }:
            return jobs, health
        previous_failure = health
    try:
        plan = resolve_career_fetch_plan(career_url, fetcher=fetcher)
        if plan.get("error") == "career_adapter_unavailable":
            if job_postings(BeautifulSoup(fetcher(career_url), "html.parser")):
                plan = {"method": "structured", "url": career_url}
            elif rendered_resolver is not None:
                plan = rendered_resolver(career_url)
    except Exception as exc:
        return [], {
            "status": "failed",
            "error": _error_code(exc),
            "method": "manual",
            "url": career_url,
            "lead_count": 0,
        }
    if plan["method"] == "manual":
        if plan.get("error") != "career_adapter_unavailable":
            return [], {"status": "pending_manual", "lead_count": 0, **plan}
        plan = {"method": "structured", "url": career_url}
    jobs, health = _discover_company_plan(
        company, plan, fetcher=fetcher, poster=poster, hours_old=hours_old
    )
    if not jobs and health.get("status") == "pending_manual" and previous_failure:
        return [], previous_failure
    return jobs, health


def _discover_company_plan(company, plan, *, fetcher, poster, hours_old):
    if plan["method"] == "gc_jobs":
        from hunter.discovery_browser import discover_gc_jobs

        jobs, health = discover_gc_jobs(url=plan["url"])
        return jobs, {**health[0], **plan}
    # Explicit allowlist: ordinary modules, not a plugin or configurable execution engine.
    readers = {
        "dayforce": (),
        "hibob": (),
        "technomedia": (),
        "sap": (),
        "taleo": (),
        "peoplesoft": ("hours_old",),
        "ibm": ("poster",),
        "phenom": ("fetcher", "poster"),
        "smartdreamers": ("fetcher", "poster"),
        "rmk": ("fetcher", "poster", "hours_old"),
        "structured": ("fetcher", "hours_old"),
        **dict.fromkeys(
            (
                "adp",
                "pinpoint",
                "kula",
                "rippling",
                "avature",
                "paradox",
                "jazzhr",
                "icims",
                "jibe",
                "ukg",
                "criticalmass",
                "paycor",
                "apple",
                "hrsmart",
                "recruitee",
                "talentbrew",
                "google",
                "eightfold",
                "capgemini",
                "okta",
                "amazon",
            ),
            ("fetcher",),
        ),
    }
    method = plan["method"]
    if method in readers:
        from importlib import import_module

        reader = getattr(import_module(f"hunter.discovery_{method}"), f"discover_{method}")
        arguments = {"fetcher": fetcher, "poster": poster, "hours_old": hours_old}
        return reader(company, plan, **{key: arguments[key] for key in readers[method]})
    if plan["method"] == "workday":
        return discover_workday(company, plan, fetcher=fetcher, poster=poster, hours_old=hours_old)
    if plan["method"] == "successfactors":
        return discover_successfactors(company, plan, fetcher=fetcher, hours_old=hours_old)
    if plan["method"] == "shopify":
        return discover_shopify(company, plan, fetcher=fetcher)
    if plan["method"] == "smartrecruiters":
        return discover_smartrecruiters(company, plan, fetcher=fetcher)
    if plan["method"] == "workable_widget":
        return discover_workable_widget(company, plan, fetcher=fetcher)
    if plan["method"] == "workable":
        return discover_workable(company, plan, fetcher=fetcher, poster=poster)
    if plan["method"] == "teamtailor":
        return discover_teamtailor(company, plan, fetcher=fetcher)
    if plan["method"] == "oracle_hcm":
        return discover_oracle_hcm(company, plan, fetcher=fetcher)
    if plan["method"] == "bamboohr":
        return discover_bamboohr(company, plan, fetcher=fetcher)
    try:
        payload = json.loads(fetcher(plan["url"]))
        rows = payload.get("jobs") if isinstance(payload, dict) else payload
        if not isinstance(rows, list):
            raise ValueError("invalid_employer_catalog")
        jobs = []
        error = None
        for row in rows:
            if not isinstance(row, dict):
                error = "invalid_employer_listing"
                continue
            title = row.get("text") if plan["method"] == "lever" else row.get("title")
            location = public_posting_location(plan["method"], row)
            if plan["method"] == "greenhouse":
                url = row.get("absolute_url")
                # Greenhouse's updated_at is an edit timestamp, not first publication.
                posted = None
                description = row.get("content")
            elif plan["method"] == "lever":
                url = row.get("hostedUrl") or row.get("applyUrl")
                posted = None
                description = row.get("descriptionPlain")
            else:
                if row.get("isListed") is False:
                    continue
                url = row.get("jobUrl") or row.get("applyUrl")
                posted = row.get("publishedAt")
                description = row.get("descriptionPlain") or row.get("description")
            if not title or not url or outside_geography(location):
                continue
            date_posted = _parse_date(posted).date().isoformat() if _parse_date(posted) else None
            jobs.append(
                {
                    **_job(
                        title=title,
                        company=company,
                        location=location,
                        url=url,
                        source=f"employer_{plan['method']}",
                        is_remote=row.get("isRemote")
                        if plan["method"] == "ashby"
                        else True
                        if row.get("workplaceType") == "remote"
                        else None,
                        employment_type=(row.get("categories") or {}).get("commitment")
                        if plan["method"] == "lever"
                        else row.get("employmentType"),
                        date_posted=date_posted,
                        description=description,
                    ),
                    "ats_type": plan["method"],
                }
            )
            if plan["method"] == "greenhouse" and career_fetch_plan(url)["method"] == "manual":
                board = re.fullmatch(
                    r"/v1/boards/([A-Za-z0-9_-]+)/jobs", urlsplit(plan["url"]).path
                )
                identity = str(row.get("id", ""))
                if board and identity.isdigit():
                    # Preserve the custom apply URL and a stable, catalog-backed posting identity.
                    jobs[-1]["job_url"] = (
                        f"https://job-boards.greenhouse.io/{board[1]}/jobs/{identity}"
                    )
        return discovery_result(plan, jobs, error, True, catalog_complete=True)
    except Exception as exc:
        return [], {"status": "failed", "error": _error_code(exc), "lead_count": 0, **plan}
