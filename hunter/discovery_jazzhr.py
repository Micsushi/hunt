"""Read JazzHR's public listing page and structured posting details."""

import re
from datetime import UTC, datetime
from urllib.parse import urljoin, urlsplit

from bs4 import BeautifulSoup

from hunter.discovery_policy import outside_geography
from hunter.discovery_sources import (
    _job,
    _parse_date,
    catalog_error,
    discovery_result,
    fetch_text,
)
from hunter.job_posting import html_text, job_postings, posting_location
from hunter.search_lanes import matching_search_lane


def discover_jazzhr(company, plan, *, fetcher=fetch_text):
    jobs, seen, pages, error = [], set(), set(), None
    base, url = plan["url"], plan["url"]
    catalog_complete = False
    try:
        while url:
            if url in pages:
                raise ValueError("repeated_page")
            pages.add(url)
            soup = BeautifulSoup(fetcher(url), "html.parser")
            listing = soup.select_one(".jobs-list")
            if listing is None:
                raise ValueError("employer_search_response_unrecognized")
            cards = listing.select(".list-group-item-heading a[href]")
            if not cards and not re.search(
                r"no (?:current openings|open positions)", listing.get_text(" ", strip=True), re.I
            ):
                raise ValueError("empty_catalog_unverified")
            for link in cards:
                target = urljoin(base, link["href"])
                parts = urlsplit(target)
                identity = re.fullmatch(r"/apply/([A-Za-z0-9]+)/[^/]+", parts.path)
                if (
                    parts.scheme != "https"
                    or parts.hostname != urlsplit(base).hostname
                    or not identity
                ):
                    raise ValueError("posting_identity_mismatch")
                if identity[1] in seen:
                    raise ValueError("catalog_repeated")
                seen.add(identity[1])
                title = link.get_text(" ", strip=True)
                if not title:
                    raise ValueError("invalid_listing_title")
                if not matching_search_lane(title):
                    continue
                description, location, posted = None, None, None
                try:
                    detail = BeautifulSoup(fetcher(target), "html.parser")
                    postings = job_postings(detail)
                    if (
                        len(postings) != 1
                        or postings[0].get("url") != target
                        or postings[0].get("title") != title
                    ):
                        raise ValueError("detail_identity_mismatch")
                    posting = postings[0]
                    expires = _parse_date(posting.get("validThrough"))
                    if expires and expires < datetime.now(UTC):
                        continue
                    location = posting_location(posting)
                    if outside_geography(location):
                        continue
                    description = html_text(posting.get("description") or "")
                    if not description:
                        raise ValueError("description_not_found")
                    posted = _parse_date(posting.get("datePosted"))
                    if posted is None:
                        error = error or "posting_date_unknown"
                except Exception as exc:
                    error = catalog_error(exc)
                jobs.append(
                    _job(
                        title=title,
                        company=company,
                        location=location,
                        url=target,
                        source="employer_jazzhr",
                        description=description,
                        date_posted=posted.date().isoformat() if posted else None,
                    )
                )
            next_link = soup.select_one('a[rel="next"]')
            url = urljoin(base, next_link["href"]) if next_link and next_link.get("href") else None
            if url and (
                urlsplit(url).hostname != urlsplit(base).hostname
                or urlsplit(url).scheme != "https"
                or urlsplit(url).path.rstrip("/") != "/apply"
            ):
                raise ValueError("invalid_pagination_url")
        catalog_complete = True
    except Exception as exc:
        error = catalog_error(exc)
    return discovery_result(plan, jobs, error, seen, catalog_complete=catalog_complete)
