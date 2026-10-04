"""Read Technomedia/Cegid's public search table and employer posting pages."""

import re
from datetime import datetime
from urllib.parse import parse_qsl, urljoin, urlsplit

from bs4 import BeautifulSoup

from hunter.browser_runtime import open_public_browser
from hunter.discovery_sources import _job, catalog_error, discovery_result
from hunter.search_lanes import matching_search_lane


def parse_catalog(html, origin):
    soup = BeautifulSoup(html, "html.parser")
    table = soup.select_one("#CTG_JOB_LIST")
    if table is None:
        raise ValueError("employer_search_response_unrecognized")
    rows, seen = [], set()
    for link in table.select("a.relink[href]"):
        target = urljoin(origin, link["href"])
        parts = urlsplit(target)
        identity = dict(parse_qsl(parts.query)).get("offerid", "")
        if (
            parts.scheme != "https"
            or parts.hostname != urlsplit(origin).hostname
            or not identity.isdigit()
        ):
            raise ValueError("posting_identity_mismatch")
        if identity in seen:
            raise ValueError("catalog_repeated")
        seen.add(identity)
        row = link.find_parent("tr")
        location = row.select_one(".styleColAdd3") if row else None
        rows.append(
            {
                "id": identity,
                "title": link.get_text(" ", strip=True),
                "url": target,
                "location": location.get_text("; ", strip=True) if location else None,
            }
        )
    return rows


def read_detail(html, row):
    soup = BeautifulSoup(html, "html.parser")
    title = soup.select_one("h1.TM_titlePage")
    if title is None or title.get_text(" ", strip=True) != row["title"]:
        raise ValueError("detail_identity_mismatch")
    nav = soup.select_one("#rejobpostingNavbar")
    count = re.search(r"\bJob\s+\d+\s+of\s+(\d+)\b", nav.get_text(" ", strip=True) if nav else "")
    if not count:
        raise ValueError("catalog_total_unknown")
    content = soup.select_one(".re-job-posting-panel")
    if content is None or not content.get_text(strip=True):
        raise ValueError("description_not_found")
    header = soup.select_one("#divDrawJobPostingHeader")
    date = re.search(
        r"Posting period\s+From (\d{2}/\d{2}/\d{4})",
        header.get_text(" ", strip=True) if header else "",
    )
    posted = datetime.strptime(date[1], "%m/%d/%Y").date().isoformat() if date else None
    return content.get_text("\n", strip=True), posted, int(count[1])


def discover_technomedia(company, plan):

    jobs, loaded, error = [], False, None
    totals = set()
    try:
        with open_public_browser() as browser:
            page = browser.new_page()
            page.set_default_timeout(15_000)

            def navigate(url):
                response = page.goto(url, wait_until="domcontentloaded")
                if response and response.status >= 400:
                    raise ValueError(f"http_{response.status}")
                if urlsplit(page.url).hostname != urlsplit(plan["url"]).hostname:
                    raise ValueError("board_identity_mismatch")
                if re.search(r"captcha|just a moment|verify you are human", page.title(), re.I):
                    raise ValueError("security_checkpoint")

            navigate(plan["url"])
            page.locator("#btnSearchbutton2_1").click()
            page.locator("#CTG_JOB_LIST").wait_for()
            rows = parse_catalog(page.content(), page.url)
            loaded = True
            if not rows:
                error = "catalog_total_unknown"
            for index, row in enumerate(rows):
                matches = matching_search_lane(row["title"])
                if index and not matches:
                    continue
                description, posted = None, None
                try:
                    navigate(row["url"])
                    page.locator("h1.TM_titlePage").wait_for()
                    if dict(parse_qsl(urlsplit(page.url).query)).get("offerid") != row["id"]:
                        raise ValueError("detail_identity_mismatch")
                    description, posted, total = read_detail(page.content(), row)
                    totals.add(total)
                    if total != len(rows):
                        error = "catalog_count_mismatch"
                    if matches and not posted:
                        error = error or "posting_date_unknown"
                except Exception as exc:
                    error = catalog_error(exc)
                if matches:
                    jobs.append(
                        _job(
                            title=row["title"],
                            company=company,
                            location=row["location"],
                            url=row["url"],
                            source="employer_technomedia",
                            description=description,
                            date_posted=posted,
                        )
                    )
                if error in {"http_403", "http_429", "security_checkpoint"}:
                    break
    except Exception as exc:
        error = catalog_error(exc)
    return discovery_result(
        plan,
        jobs,
        error,
        loaded,
        catalog_complete=loaded and bool(totals) and totals == {len(rows)},
    )
