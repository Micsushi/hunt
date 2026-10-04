"""Read the public iCIMS iframe's cards, numbered pages and structured details."""

import re
from datetime import UTC, datetime
from html import unescape
from urllib.parse import parse_qs, urljoin, urlsplit

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


def discover_icims(company, plan, *, fetcher=fetch_text):
    jobs, seen, pages, error = [], set(), set(), None
    base, url, total_pages = plan["url"], plan["url"], None
    catalog_complete = False
    try:
        while url:
            if url in pages:
                raise ValueError("repeated_page")
            pages.add(url)
            soup = BeautifulSoup(fetcher(url), "html.parser")
            listing = soup.select_one(".iCIMS_ListingsPage")
            if listing is None:
                raise ValueError("employer_search_response_unrecognized")
            current = listing.select_one(".iCIMS_PagingBatch a.selected")
            match = re.search(
                r"Page\s+(\d+)\s+of\s+(\d+)", current.get_text(" ", strip=True) if current else ""
            )
            if not match or int(match[1]) != len(pages) or int(match[2]) < len(pages):
                raise ValueError("pagination_not_verified")
            if total_pages is not None and int(match[2]) != total_pages:
                raise ValueError("pagination_count_changed")
            total_pages = int(match[2])
            cards = listing.select(".iCIMS_JobCardItem")
            if not cards:
                raise ValueError("empty_catalog_unverified")
            for card in cards:
                link = card.select_one(".title a[href]")
                target = urljoin(base, link["href"]) if link else ""
                parts = urlsplit(target)
                identity = re.fullmatch(r"/jobs/(\d+)/[^/]+/job", parts.path)
                if (
                    parts.scheme != "https"
                    or parts.hostname != urlsplit(base).hostname
                    or not identity
                ):
                    raise ValueError("posting_identity_mismatch")
                if identity[1] in seen:
                    raise ValueError("catalog_repeated")
                seen.add(identity[1])
                heading = link.select_one("h3")
                title = " ".join(heading.get_text(" ", strip=True).split()) if heading else ""
                if not title:
                    raise ValueError("invalid_listing_title")
                if not matching_search_lane(title):
                    continue
                description, posted, location = None, None, None
                target = parts._replace(query="", fragment="").geturl()
                try:
                    detail = BeautifulSoup(fetcher(target + "?in_iframe=1"), "html.parser")
                    entries = job_postings(detail)
                    if (
                        len(entries) != 1
                        or entries[0].get("url") != target
                        or " ".join(unescape(entries[0].get("title") or "").split()) != title
                    ):
                        raise ValueError("detail_identity_mismatch")
                    posting = entries[0]
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
                        source="employer_icims",
                        description=description,
                        date_posted=posted.date().isoformat() if posted else None,
                    )
                )
            if len(pages) == total_pages:
                break
            next_link = next(
                (
                    a
                    for a in listing.select(".iCIMS_Paging a[href]:not(.invisible)")
                    if a.get_text(" ", strip=True) == "Next page of results"
                ),
                None,
            )
            url = urljoin(base, next_link["href"]) if next_link else ""
            parts = urlsplit(url)
            if (
                parts.scheme != "https"
                or parts.hostname != urlsplit(base).hostname
                or parts.path != "/jobs/search"
                or parse_qs(parts.query).get("pr") != [str(len(pages))]
            ):
                raise ValueError("invalid_pagination_url")
        catalog_complete = True
    except Exception as exc:
        error = catalog_error(exc)
    return discovery_result(plan, jobs, error, seen, catalog_complete=catalog_complete)
