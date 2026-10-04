"""Read anonymous Taleo career-section pages, without entering application flows."""

import re
from datetime import datetime
from urllib.parse import parse_qsl, urljoin, urlsplit

from bs4 import BeautifulSoup

from hunter.browser_runtime import open_public_browser
from hunter.discovery_sources import _job, catalog_error, discovery_result
from hunter.search_lanes import matching_search_lane


def parse_catalog(html, origin):
    soup = BeautifulSoup(html, "html.parser")
    count = re.search(r"(\d+)\s*[–-]\s*(\d+)\s+of\s+(\d+)", soup.get_text(" ", strip=True))
    if not count or soup.select_one("#jobs") is None:
        raise ValueError("catalog_total_unknown")
    rows = []
    for link in soup.select('#jobs a[href*="jobdetail.ftl"]'):
        target = urljoin(origin, link["href"])
        parts = urlsplit(target)
        identity = dict(parse_qsl(parts.query)).get("job", "")
        if (
            parts.scheme != "https"
            or parts.hostname != urlsplit(origin).hostname
            or parts.path != urlsplit(origin).path.replace("jobsearch.ftl", "jobdetail.ftl")
            or not identity.isdigit()
        ):
            raise ValueError("posting_identity_mismatch")
        rows.append({"id": identity, "title": link.get_text(" ", strip=True), "url": target})
    return rows, int(count[1]), int(count[2]), int(count[3])


def read_detail(html, row):
    soup = BeautifulSoup(html, "html.parser")

    def field(suffix):
        node = soup.find(id="requisitionDescriptionInterface." + suffix + ".row1")
        return node.get_text(" ", strip=True) if node else ""

    if field("reqTitleLinkAction") != row["title"] or field("reqContestNumberValue") != row["id"]:
        raise ValueError("detail_identity_mismatch")
    container = soup.find(id="requisitionDescriptionInterface.descRequisitionContainer")
    if container is None:
        raise ValueError("description_not_found")
    description = container.get_text("\n", strip=True)
    try:
        posted = datetime.strptime(field("reqPostingDate"), "%b %d, %Y").date().isoformat()
    except ValueError:
        posted = None
    return description, posted, field("reqSiteCity") or None


def discover_taleo(company, plan):

    jobs, loaded, error = [], False, None
    catalog_complete = False
    try:
        with open_public_browser() as browser:
            page = browser.new_page()
            detail = browser.new_page()
            page.set_default_timeout(15000)
            detail.set_default_timeout(15000)

            def navigate(tab, url):
                response = tab.goto(url, wait_until="domcontentloaded")
                if response and response.status >= 400:
                    raise ValueError(f"http_{response.status}")
                if urlsplit(tab.url).hostname != urlsplit(plan["url"]).hostname:
                    raise ValueError("board_identity_mismatch")

            navigate(page, plan["url"])
            page.locator("#jobs").wait_for()
            page.wait_for_function(
                r"()=>/\d+\s*[–-]\s*\d+\s+of\s+\d+/.test(document.body.innerText)"
            )
            rows, start, end, total = parse_catalog(page.content(), page.url)
            if start != 1 or end < start or end > total:
                raise ValueError("catalog_count_mismatch")
            loaded = True
            seen = set()
            while True:
                for row in rows:
                    if row["id"] in seen:
                        raise ValueError("catalog_repeated")
                    seen.add(row["id"])
                    if not matching_search_lane(row["title"]):
                        continue
                    description, posted, location = None, None, None
                    try:
                        navigate(detail, row["url"])
                        detail.locator(
                            '[id="requisitionDescriptionInterface.descRequisitionContainer"]'
                        ).wait_for()
                        description, posted, location = read_detail(detail.content(), row)
                        if not posted:
                            error = error or "posting_date_unknown"
                    except Exception as exc:
                        error = catalog_error(exc)
                    jobs.append(
                        _job(
                            title=row["title"],
                            company=company,
                            location=location,
                            url=row["url"],
                            source="employer_taleo",
                            description=description,
                            date_posted=posted,
                        )
                    )
                    if error in {"http_403", "http_429", "security_checkpoint"}:
                        raise ValueError(error)
                if end >= total:
                    break
                if not rows:
                    raise ValueError("pagination_incomplete")
                previous = rows[0]["url"]
                page.locator("#next").click()
                page.wait_for_function(
                    '(url)=>{const a=document.querySelector("#jobs a[href*=jobdetail]");return a && a.href !== url}',
                    arg=previous,
                )
                rows, next_start, next_end, next_total = parse_catalog(page.content(), page.url)
                if next_total != total or next_start != end + 1 or next_end <= end:
                    raise ValueError("catalog_changed_during_scan")
                end = next_end
            catalog_complete = len(seen) == total
            if not catalog_complete:
                error = "catalog_count_mismatch"
    except Exception as exc:
        error = catalog_error(exc)
    return discovery_result(plan, jobs, error, loaded, catalog_complete=catalog_complete)
