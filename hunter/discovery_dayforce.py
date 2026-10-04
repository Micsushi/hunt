"""Read the public catalog response produced by Dayforce's normal job board."""

import re
from datetime import UTC, datetime
from urllib.parse import urlsplit

from hunter.browser_runtime import open_public_browser
from hunter.discovery_policy import outside_geography
from hunter.discovery_run import check_cancelled
from hunter.discovery_sources import _job, _parse_date, catalog_error, discovery_result
from hunter.job_posting import html_text
from hunter.search_lanes import matching_search_lane


def read_dayforce_catalog(url):

    tenant = urlsplit(url).path.split("/")[2]
    endpoint = f"https://jobs.dayforcehcm.com/api/geo/{tenant}/jobposting/search"
    with open_public_browser() as browser:
        page = browser.new_page()
        with page.expect_response(
            lambda r: r.url == endpoint and r.request.method == "POST", timeout=30_000
        ) as response:
            check_cancelled()
            page.goto(url, wait_until="domcontentloaded", timeout=25_000)
        response = response.value
        if response.status != 200:
            raise ValueError(f"http_{response.status}")
        request = response.request.post_data_json
        path = urlsplit(url).path.strip("/").split("/")
        if (
            request.get("clientNamespace") != tenant
            or request.get("jobBoardCode") != path[2]
            or request.get("paginationStart") != 0
        ):
            raise ValueError("board_identity_mismatch")
        data = response.json()
        page_number = 2
        try:
            while len(data["jobPostings"]) < data["maxCount"]:
                offset = len(data["jobPostings"])
                with page.expect_response(
                    lambda r: r.url == endpoint and r.request.method == "POST", timeout=30_000
                ) as following:
                    page.locator("a").filter(has_text=re.compile(f"^{page_number}$")).click(
                        timeout=10_000
                    )
                response = following.value
                if response.status != 200:
                    raise ValueError(f"http_{response.status}")
                next_request = response.request.post_data_json
                if (
                    any(
                        next_request.get(key) != request.get(key)
                        for key in ("clientNamespace", "jobBoardCode", "cultureCode")
                    )
                    or next_request.get("paginationStart") != offset
                ):
                    raise ValueError("pagination_request_mismatch")
                _append_page(data, response.json())
                page_number += 1
        except Exception as exc:
            data["_pagination_error"] = catalog_error(exc)
        return data


def _append_page(catalog, following):
    rows = following.get("jobPostings")
    if (
        not isinstance(rows, list)
        or not rows
        or catalog.get("count") != len(catalog["jobPostings"])
        or catalog.get("offset") != 0
        or type(catalog.get("maxCount")) is not int
        or following.get("offset") != len(catalog["jobPostings"])
        or following.get("count") != len(rows)
        or following.get("maxCount") != catalog["maxCount"]
        or len(catalog["jobPostings"]) + len(rows) > catalog["maxCount"]
    ):
        raise ValueError("pagination_count_mismatch")
    identities = [row.get("jobPostingId") for row in catalog["jobPostings"] + rows]
    if len(set(identities)) != len(identities):
        raise ValueError("catalog_repeated")
    catalog["jobPostings"].extend(rows)
    catalog["count"] = len(catalog["jobPostings"])


def discover_dayforce(company, plan, *, reader=read_dayforce_catalog):
    jobs, seen, error = [], set(), None
    base = plan["url"].rstrip("/")
    tenant = urlsplit(base).path.split("/")[2]
    catalog_complete = False
    try:
        data = reader(base)
        error = data.get("_pagination_error")
        rows, total = data.get("jobPostings"), data.get("maxCount")
        if (
            not isinstance(rows, list)
            or type(total) is not int
            or total < 0
            or data.get("offset") != 0
            or data.get("count") != len(rows)
        ):
            raise ValueError("invalid_catalog_count")
        if len(rows) > total:
            raise ValueError("invalid_catalog_count")
        if len(rows) != total:
            error = error or "pagination_not_verified"
        for row in rows:
            identity = row.get("jobPostingId")
            if type(identity) is not int or identity <= 0 or row.get("clientNamespace") != tenant:
                raise ValueError("posting_identity_mismatch")
            if identity in seen:
                raise ValueError("catalog_repeated")
            seen.add(identity)
            title = row["jobTitle"].strip()
            if not title:
                raise ValueError("invalid_listing_title")
            location = (
                "; ".join(p["formattedAddress"] for p in (row.get("postingLocations") or []))
                or None
            )
            if outside_geography(location) or not matching_search_lane(title):
                continue
            expires = _parse_date(row.get("postingExpiryTimestampUTC"))
            if expires and expires < datetime.now(UTC):
                continue
            description = html_text(row.get("jobDescription") or "")
            if not description:
                error = "description_not_found"
            posted = _parse_date(row.get("postingStartTimestampUTC"))
            if posted is None:
                error = error or "posting_date_unknown"
            jobs.append(
                _job(
                    title=title,
                    company=company,
                    location=location,
                    url=f"{base}/jobs/{identity}",
                    source="employer_dayforce",
                    description=description or None,
                    date_posted=posted.date().isoformat() if posted else None,
                )
            )
        catalog_complete = len(seen) == total and not data.get("_pagination_error")
    except Exception as exc:
        error = catalog_error(exc)
    return discovery_result(plan, jobs, error, seen, catalog_complete=catalog_complete)
