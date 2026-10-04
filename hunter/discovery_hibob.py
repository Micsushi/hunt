"""Read HiBob's published catalog through its normal public browser requests."""

import re
from urllib.parse import urlsplit
from uuid import UUID

from hunter.browser_runtime import open_public_browser
from hunter.discovery_policy import outside_geography
from hunter.discovery_sources import _job, _parse_date, catalog_error, discovery_result
from hunter.job_posting import html_text
from hunter.search_lanes import matching_search_lane


def read_hibob_catalog(url):
    from playwright.sync_api import expect

    origin = f"https://{urlsplit(url).hostname}"
    with open_public_browser() as browser:
        page = browser.new_page()
        with page.expect_response(
            lambda r: r.url == f"{origin}/api/job-ad", timeout=30_000
        ) as catalog:
            page.goto(url, wait_until="domcontentloaded", timeout=25_000)
        response = catalog.value
        if response.status != 200:
            raise ValueError(f"http_{response.status}")
        data = response.json()
        navigation = page.get_by_role("navigation")
        expect(navigation).to_contain_text(re.compile(r"Total:\s*\d+"), timeout=10_000)
        total = re.search(r"Total:\s*(\d+)", navigation.inner_text())
        data["visible_total"] = int(total[1])
        return data


def discover_hibob(company, plan, *, reader=read_hibob_catalog):
    jobs, seen, error = [], set(), None
    catalog_complete = False
    try:
        data = reader(plan["url"])
        rows, total = data.get("jobAdDetails"), data.get("visible_total")
        if not isinstance(rows, list) or type(total) is not int or total != len(rows):
            raise ValueError("catalog_count_mismatch")
        for row in rows:
            identity = row.get("id")
            if not isinstance(identity, str) or str(UUID(identity)) != identity:
                raise ValueError("posting_identity_mismatch")
            if identity in seen:
                raise ValueError("catalog_repeated")
            seen.add(identity)
            title = (row.get("title") or "").strip()
            if not title:
                raise ValueError("invalid_listing_title")
            location = ", ".join(filter(None, (row.get("site"), row.get("country")))) or None
            if outside_geography(location) or not matching_search_lane(title):
                continue
            description = html_text(
                "\n".join(
                    row.get(key) or ""
                    for key in ("description", "requirements", "responsibilities", "benefits")
                )
            )
            if not description:
                error = "description_not_found"
            posted = _parse_date(row.get("publishedAt"))
            if posted is None:
                error = error or "posting_date_unknown"
            jobs.append(
                _job(
                    title=title,
                    company=company,
                    location=location,
                    url=f"{plan['url'].rstrip('/')}/{identity}",
                    source="employer_hibob",
                    description=description or None,
                    date_posted=posted.date().isoformat() if posted else None,
                )
            )
        catalog_complete = True
    except Exception as exc:
        error = catalog_error(exc)
    return discovery_result(plan, jobs, error, seen, catalog_complete=catalog_complete)
