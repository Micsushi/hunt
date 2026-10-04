"""Read Pinpoint's published, unpaginated public posting feed."""

import json
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
from hunter.job_posting import html_text, job_postings
from hunter.search_lanes import matching_search_lane


def discover_pinpoint(company, plan, *, fetcher=fetch_text):
    jobs, seen, error = [], set(), None
    base = plan["url"]
    catalog_complete = False
    try:
        soup = BeautifulSoup(fetcher(base), "html.parser")
        node = soup.find("script", attrs={"data-component-name": "External::Jobs"})
        config = json.loads(node.get_text() if node else "{}")
        if config.get("showPagination") is not False:
            raise ValueError("pagination_not_verified")
        feed = urljoin(base, config["url"])
        if urlsplit(feed).hostname != urlsplit(base).hostname or urlsplit(feed).scheme != "https":
            raise ValueError("invalid_catalog_url")
        catalog = json.loads(fetcher(feed))
        rows = catalog["data"]
        if not isinstance(rows, list) or catalog.get("links", {}).get("next"):
            raise ValueError("pagination_not_verified")
        for row in rows:
            target = row["url"]
            parts = urlsplit(target)
            identity = re.fullmatch(r"/(?:[a-z]{2}/)?postings/([0-9a-f-]{36})", parts.path)
            if not identity or parts.scheme != "https" or parts.hostname != urlsplit(base).hostname:
                raise ValueError("invalid_job_url")
            if identity[1] in seen:
                raise ValueError("catalog_repeated")
            seen.add(identity[1])
            title = row["title"]
            location = "; ".join(
                filter(None, (row["location"].get("city"), row["location"].get("name")))
            )
            if outside_geography(location) or not matching_search_lane(title):
                continue
            description, posted = None, None
            try:
                detail = BeautifulSoup(fetcher(target), "html.parser")
                postings = job_postings(detail)
                if (
                    len(postings) != 1
                    or postings[0].get("title") != title
                    or postings[0].get("identifier", {}).get("value") != identity[1]
                ):
                    raise ValueError("detail_identity_mismatch")
                posting = postings[0]
                expires = _parse_date(posting.get("validThrough") or row.get("deadline_at"))
                if expires and expires < datetime.now(UTC):
                    continue
                description = html_text(posting.get("description") or "")
                if not description:
                    raise ValueError("description_not_found")
                posted = _parse_date(posting.get("datePosted"))
            except Exception as exc:
                error = catalog_error(exc)
            jobs.append(
                _job(
                    title=title,
                    company=company,
                    location=location,
                    url=target,
                    source="employer_pinpoint",
                    description=description,
                    date_posted=posted.date().isoformat() if posted else None,
                )
            )
        catalog_complete = True
    except Exception as exc:
        error = catalog_error(exc)
    return discovery_result(plan, jobs, error, seen, catalog_complete=catalog_complete)
