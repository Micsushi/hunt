"""IBM's public search index and rendered Avature posting pages. No account writes."""

import re
from urllib.parse import parse_qsl, urlsplit

from bs4 import BeautifulSoup

from hunter.browser_runtime import open_public_browser
from hunter.discovery_policy import outside_geography
from hunter.discovery_run import check_cancelled
from hunter.discovery_sources import (
    _error_code,
    _job,
    catalog_error,
    discovery_result,
    post_public_json,
)
from hunter.search_lanes import matching_search_lane


def _posting_id(url):
    parts = urlsplit(str(url or ""))
    if parts.scheme != "https" or parts.hostname != "careers.ibm.com":
        return None
    match = re.search(r"/careers/JobDetail(?:/[^/]+/([0-9]+))?/?$", parts.path)
    if not match:
        return None
    identity = match[1] or dict(parse_qsl(parts.query)).get("jobId", "")
    return identity if identity.isdigit() else None


def parse_ibm_detail(html, job):
    soup = BeautifulSoup(html, "html.parser")
    title = soup.select_one("h2.banner__text__title")
    canonical = soup.select_one('link[rel="canonical"][href]')
    sidebar = soup.select_one("main article.article--sidebar")
    content = soup.select_one("main article.article--details")
    identity = _posting_id(job["job_url"])
    lines = list(sidebar.stripped_strings) if sidebar else []

    def value(label):
        index = lines.index(label) if label in lines else len(lines)
        return lines[index + 1] if index + 1 < len(lines) else ""

    if (
        not identity
        or not canonical
        or _posting_id(canonical["href"]) != identity
        or not title
        or title.get_text(" ", strip=True) != job["title"]
        or value("Job ID") != identity
    ):
        raise ValueError("detail_identity_mismatch")
    description = content.get_text("\n", strip=True) if content else ""
    if not description:
        raise ValueError("description_not_found")
    location = ", ".join(
        filter(
            None, [value("City / Township / Village"), value("State / Province"), value("Country")]
        )
    )
    return {"description": description, "location": location or None}


def read_ibm_details(jobs):
    from playwright.sync_api import TimeoutError as PlaywrightTimeoutError

    error, closed = None, set()
    with open_public_browser() as browser:
        page = browser.new_page()
        page.set_default_navigation_timeout(20_000)
        for job in jobs:
            for attempt in range(2):
                try:
                    check_cancelled()
                    response = page.goto(job["job_url"], wait_until="domcontentloaded")
                    if response and response.status >= 400:
                        raise ValueError(f"http_{response.status}")
                    page.wait_for_function(
                        r"""() => /\/closedjob\/?$/.test(location.pathname) ||
                        Boolean(document.querySelector('main article.article--sidebar'))""",
                        timeout=15_000,
                    )
                    html = page.content()
                    if is_ibm_closed_page(page.url, html):
                        closed.add(job["job_url"])
                    else:
                        job.update(parse_ibm_detail(html, job))
                    break
                except PlaywrightTimeoutError:
                    if attempt:
                        error = "TimeoutError"
                except Exception as exc:
                    error = catalog_error(exc)
                    break
    jobs[:] = [job for job in jobs if job["job_url"] not in closed]
    return error


def is_ibm_closed_page(url, html):
    parts = urlsplit(url)
    if parts.hostname != "careers.ibm.com" or not re.fullmatch(
        r"/[a-z]{2}_[A-Z]{2}/closedjob/?", parts.path
    ):
        return False
    return any(
        "this job is closed and we are no longer accepting applications"
        in heading.get_text(" ", strip=True).lower()
        for heading in BeautifulSoup(html, "html.parser").select("h2")
    )


def discover_ibm(company, plan, *, poster=post_public_json, detail_reader=read_ibm_details):
    from hunter.config import DISCOVERY_COUNTRIES

    countries = DISCOVERY_COUNTRIES
    jobs, seen = [], set()
    offset, error, expected_total = 0, None, None
    catalog_complete = False
    try:
        while True:
            payload = poster(
                "https://www-api.ibm.com/search/api/v2",
                {
                    "appId": "careers",
                    "scopes": ["careers2"],
                    "query": {"bool": {"must": []}},
                    **(
                        {"post_filter": {"term": {"field_keyword_05": countries[0]}}}
                        if len(countries) == 1
                        else {"post_filter": {"terms": {"field_keyword_05": countries}}}
                        if countries
                        else {}
                    ),
                    "size": 30,
                    "from": offset,
                    "p": offset // 30 + 1,
                    # Both fields are public sort options; relevance ties repeat rows across pages.
                    "sort": [{"title.keyword": "asc"}, {"dcdate": "desc"}],
                    "lang": "zz",
                    "localeSelector": {},
                    "sm": {"query": "", "lang": "zz"},
                    "_source": [
                        "_id",
                        "title",
                        "url",
                        "description",
                        "language",
                        "entitled",
                        "field_keyword_17",
                        "field_keyword_08",
                        "field_keyword_18",
                        "field_keyword_19",
                        "field_keyword_05",
                    ],
                },
            )
            result = payload.get("hits", {})
            total, rows = result.get("total", {}), result.get("hits")
            if (
                payload.get("timed_out")
                or payload.get("_shards", {}).get("failed", 0)
                or total.get("relation") != "eq"
                or type(total.get("value")) is not int
                or total["value"] < 0
                or not isinstance(rows, list)
                or offset + len(rows) > total["value"]
                or (not rows and offset < total["value"])
            ):
                raise ValueError("invalid_ibm_search_page")
            if expected_total is not None and total["value"] != expected_total:
                raise ValueError("catalog_changed_during_scan")
            expected_total = total["value"]
            for row in rows:
                source = row.get("_source", {})
                url, title = source.get("url"), source.get("title")
                identity = _posting_id(url)
                if not identity or not title:
                    raise ValueError("invalid_ibm_listing")
                if identity in seen:
                    raise ValueError("pagination_repeated")
                seen.add(identity)
                if not matching_search_lane(title):
                    continue
                # Country comes from the observed public search filter. Detail geography supersedes it.
                place = str(source.get("field_keyword_19") or "").strip()
                jobs.append(
                    _job(
                        title=title,
                        company=company,
                        location=", ".join(
                            filter(
                                None,
                                (
                                    place,
                                    "; ".join(source.get("field_keyword_05", []))
                                    if isinstance(source.get("field_keyword_05"), list)
                                    else source.get("field_keyword_05")
                                    or (countries[0] if len(countries) == 1 else ""),
                                ),
                            )
                        ),
                        url=url,
                        source="employer_ibm",
                    )
                )
            offset += len(rows)
            if offset == total["value"]:
                break
        catalog_complete = True
    except Exception as exc:
        error = catalog_error(exc)
    if jobs:
        try:
            detail_error = detail_reader(jobs)
            error = error or detail_error
        except Exception as exc:
            error = error or _error_code(exc)
        if any(not job.get("description") for job in jobs):
            error = error or "description_not_found"
    jobs = [job for job in jobs if not outside_geography(job.get("location"))]
    return discovery_result(plan, jobs, error, offset or jobs, catalog_complete=catalog_complete)
