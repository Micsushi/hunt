"""Read Okta's public directory and full employer-authored posting articles."""

import re
from datetime import UTC, datetime
from html import unescape
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
from hunter.job_posting import job_postings
from hunter.search_lanes import matching_search_lane


def discover_okta(company, plan, *, fetcher=fetch_text):
    jobs, seen, pages, error = [], set(), set(), None
    base, url = plan["url"], plan["url"]
    catalog_complete = False
    try:
        while url:
            if url in pages:
                raise ValueError("repeated_page")
            pages.add(url)
            soup = BeautifulSoup(fetcher(url), "html.parser")
            listing = soup.select_one(".CareersView")
            if listing is None:
                raise ValueError("employer_search_response_unrecognized")
            cards = listing.select(".views-row")
            if not cards:
                raise ValueError("empty_catalog_unverified")
            for card in cards:
                link = card.select_one(".views-field-title a[href]")
                target = urljoin(base, link["href"]) if link else ""
                parts = urlsplit(target)
                identity = re.fullmatch(r"/company/careers/[a-z0-9-]+/([a-z0-9-]+)/", parts.path)
                if parts.scheme != "https" or parts.hostname != "www.okta.com" or not identity:
                    raise ValueError("posting_identity_mismatch")
                if identity[1] in seen:
                    raise ValueError("catalog_repeated")
                seen.add(identity[1])
                title = " ".join(link.get_text(" ", strip=True).split())
                if not title:
                    raise ValueError("invalid_listing_title")
                node = card.select_one(".views-field-field-job-location")
                location = node.get_text(" ", strip=True) if node else None
                if outside_geography(location) or not matching_search_lane(title):
                    continue
                description, posted = None, None
                try:
                    detail = BeautifulSoup(fetcher(target), "html.parser")
                    canonical = detail.select_one('link[rel="canonical"][href]')
                    heading = detail.select_one(".Job h1")
                    article = detail.select_one("article.Job__content[about]")
                    postings = job_postings(detail)
                    if (
                        canonical is None
                        or canonical["href"] != target
                        or heading is None
                        or " ".join(heading.get_text(" ", strip=True).split()) != title
                        or article is None
                        or urljoin(base, article["about"]) != target
                        or len(postings) != 1
                        or " ".join(unescape(postings[0].get("title") or "").split()) != title
                    ):
                        raise ValueError("detail_identity_mismatch")
                    expires = _parse_date(postings[0].get("validThrough"))
                    if expires and expires < datetime.now(UTC):
                        continue
                    description = article.get_text("\n", strip=True)
                    if not description:
                        raise ValueError("description_not_found")
                    posted = _parse_date(postings[0].get("datePosted"))
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
                        source="employer_okta",
                        description=description,
                        date_posted=posted.date().isoformat() if posted else None,
                    )
                )
            next_link = listing.select_one('.pager__item--next a[href], a[rel="next"][href]')
            url = urljoin(base, next_link["href"]) if next_link else None
            if url and (
                urlsplit(url).hostname != "www.okta.com"
                or urlsplit(url).scheme != "https"
                or urlsplit(url).path != urlsplit(base).path
            ):
                raise ValueError("invalid_pagination_url")
        catalog_complete = True
    except Exception as exc:
        error = catalog_error(exc)
    return discovery_result(plan, jobs, error, seen, catalog_complete=catalog_complete)
