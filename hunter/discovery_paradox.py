"""Read Paradox's published catalog pages and structured posting details."""

import re
from datetime import UTC, datetime
from urllib.parse import parse_qsl, urlencode, urljoin, urlsplit, urlunsplit

from bs4 import BeautifulSoup

from hunter.discovery_policy import normalize_job_url, outside_geography
from hunter.discovery_sources import (
    _job,
    _parse_date,
    _script_object,
    catalog_error,
    discovery_result,
    fetch_text,
)
from hunter.job_posting import html_text, job_postings
from hunter.search_lanes import matching_search_lane


def discover_paradox(company, plan, *, fetcher=fetch_text):
    jobs, seen, visited = [], set(), set()
    url, expected_total, error = plan["url"], None, None
    host = urlsplit(url).hostname
    search_query = dict(parse_qsl(urlsplit(url).query))
    filters = {}
    for key, value in search_query.items():
        if field := re.fullmatch(r"filter\[([^\]]+)\]\[\d+\]", key):
            filters.setdefault(field[1], []).append(value)
    catalog_complete = False
    try:
        while url:
            if url in visited:
                raise ValueError("pagination_repeated")
            visited.add(url)
            soup = BeautifulSoup(fetcher(url), "html.parser")
            data = _script_object(soup, r"window\.__PRELOAD_STATE__\s*=\s*").get("jobSearch", {})
            if filters and data.get("params", {}).get("filter") != filters:
                raise ValueError("search_filter_changed")
            rows, total = data.get("jobs"), data.get("totalJob")
            if not isinstance(rows, list) or type(total) is not int or total < 0:
                raise ValueError("invalid_paradox_catalog")
            if expected_total is not None and total != expected_total:
                raise ValueError("catalog_changed_during_scan")
            expected_total = total
            if not rows and len(seen) < total:
                raise ValueError("catalog_count_mismatch")
            for row in rows:
                identity, title = row.get("uniqueID"), row.get("title")
                if not isinstance(identity, str) or not identity or not isinstance(title, str):
                    raise ValueError("invalid_paradox_listing")
                if identity in seen:
                    raise ValueError("pagination_repeated")
                seen.add(identity)
                if row.get("isInternal") in (True, "true"):
                    continue
                if row.get("isInternal") not in (False, "false"):
                    raise ValueError("posting_visibility_unverified")
                if not matching_search_lane(title):
                    continue
                location = (
                    "; ".join(
                        ", ".join(str(p.get(k) or "") for k in ("city", "state", "country")).strip(
                            ", "
                        )
                        for p in row.get("locations", [])
                        if isinstance(p, dict)
                    )
                    or None
                )
                if outside_geography(location):
                    continue
                target = urljoin(plan["url"], row.get("originalURL") or "")
                if (
                    urlsplit(target).hostname != host
                    or urlsplit(target).scheme != "https"
                    or not urlsplit(target).path.endswith("/job/" + identity)
                ):
                    raise ValueError("invalid_paradox_job_url")
                description, posted = None, None
                try:
                    detail = BeautifulSoup(fetcher(target), "html.parser")
                    posting = next(iter(job_postings(detail)), None)
                    if (
                        not posting
                        or not row.get("requisitionID")
                        or posting.get("title") != title
                        or normalize_job_url(posting.get("url")) != normalize_job_url(target)
                        or posting.get("identifier", {}).get("value") != row.get("requisitionID")
                    ):
                        raise ValueError("detail_identity_mismatch")
                    expires = _parse_date(posting.get("validThrough"))
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
                        source="employer_paradox",
                        description=description,
                        date_posted=posted.date().isoformat() if posted else None,
                    )
                )
            if len(seen) > total:
                raise ValueError("catalog_count_mismatch")
            if len(seen) == total:
                break
            next_link = next(
                (
                    a
                    for a in soup.select("a[href]")
                    if a.get("aria-label") == "Go to next page"
                    or a.get_text(" ", strip=True) == "Go to next page"
                ),
                None,
            )
            if not next_link:
                raise ValueError("pagination_incomplete")
            url = urljoin(url, next_link["href"])
            if (
                urlsplit(url).hostname != host
                or urlsplit(url).scheme != "https"
                or not urlsplit(url).path.startswith("/jobs/page/")
            ):
                raise ValueError("invalid_pagination_url")
            parts = urlsplit(url)
            next_query = dict(parse_qsl(parts.query))
            if any(
                key in next_query and next_query[key] != value
                for key, value in search_query.items()
            ):
                raise ValueError("search_filter_changed")
            # Retain selected filters when static pagination links omit them.
            url = urlunsplit(
                (
                    parts.scheme,
                    parts.netloc,
                    parts.path,
                    urlencode({**search_query, **next_query}),
                    "",
                )
            )
        catalog_complete = True
    except Exception as exc:
        error = catalog_error(exc)
    return discovery_result(plan, jobs, error, seen, catalog_complete=catalog_complete)
