"""Read public PeopleSoft Fluid catalogs with ordinary anonymous browser controls."""

import re
from datetime import UTC, datetime, timedelta
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

from bs4 import BeautifulSoup

from hunter.browser_runtime import open_public_browser
from hunter.discovery_sources import _job, catalog_error, discovery_result
from hunter.job_posting import html_text
from hunter.search_lanes import matching_search_lane


def parse_catalog(html):
    soup = BeautifulSoup(html, "html.parser")
    count = soup.select_one('[id^="win0divHRS_SCH_WRK_FLU_HRS_SES_CNTS_MSG"]')
    match = re.fullmatch(
        r"([\d,]+) jobs? found\.", count.get_text(" ", strip=True) if count else ""
    )
    if not match:
        raise ValueError("catalog_total_unknown")
    rows, seen = [], set()
    for heading in soup.select('[id^="SCH_JOB_TITLE$"]'):
        row = heading.find_parent(class_="ps_grid-row")
        identity = row.select_one('[id^="HRS_APP_JBSCH_I_HRS_JOB_OPENING_ID$"]') if row else None
        identity = identity.get_text(strip=True) if identity else ""
        title = heading.get_text(" ", strip=True)
        if not identity.isdigit() or not title:
            raise ValueError("invalid_listing")
        if identity in seen:
            raise ValueError("catalog_repeated")
        seen.add(identity)
        date = row.select_one('[id^="SCH_OPENED$"]')
        try:
            posted = datetime.strptime(date.get_text(strip=True), "%Y/%m/%d").date().isoformat()
        except (AttributeError, ValueError):
            posted = None
        rows.append({"id": identity, "title": title, "date_posted": posted})
    total = int(match[1].replace(",", ""))
    if len(rows) > total:
        raise ValueError("catalog_count_mismatch")
    return rows, total


def posting_url(catalog_url, identity):
    parts = urlsplit(catalog_url)
    query = dict(parse_qsl(parts.query))
    query.update(Page="HRS_APP_JBPST_FL", JobOpeningId=identity, PostingSeq="1")
    return urlunsplit((parts.scheme, parts.netloc, parts.path, urlencode(query), ""))


def read_detail(html, row):
    soup = BeautifulSoup(html, "html.parser")
    identity = soup.select_one("#HRS_SCH_WRK2_HRS_JOB_OPENING_ID")
    title = soup.select_one("#HRS_SCH_WRK2_POSTING_TITLE")
    if (
        identity is None
        or identity.get_text(strip=True) != row["id"]
        or title is None
        or title.get_text(" ", strip=True) != row["title"]
    ):
        raise ValueError("detail_identity_mismatch")
    description = "\n\n".join(
        node.get_text("\n", strip=True)
        for node in soup.select(
            '[id^="HRS_SCH_WRK_DESCR100$"][id$="lbl"], [id^="HRS_SCH_PSTDSC_DESCRLONG$"]'
        )
    ).strip()
    if not soup.select('[id^="HRS_SCH_PSTDSC_DESCRLONG$"]') or not description:
        raise ValueError("description_not_found")
    location = soup.select_one("#HRS_SCH_WRK_HRS_DESCRLONG")
    return description, location.get_text(" ", strip=True) if location else None


def read_share_url(html, catalog_url, identity):
    origin = urlsplit(catalog_url)
    urls = set()
    for candidate in re.findall(r"https://[^\s<>\"']+", html_text(html, " ")):
        parts = urlsplit(candidate)
        query = dict(parse_qsl(parts.query))
        if (
            parts.hostname == origin.hostname
            and parts.path == origin.path
            and not parts.username
            and not parts.password
            and query.get("Page") == "HRS_APP_JBPST_FL"
            and query.get("JobOpeningId") == identity
            and query.get("SiteId", "").isdigit()
            and query.get("PostingSeq", "").isdigit()
        ):
            urls.add(candidate)
    if len(urls) != 1:
        raise ValueError("posting_url_unverified")
    return urls.pop()


def discover_peoplesoft(company, plan, *, hours_old=None):

    jobs, rows, error, loaded = [], [], None, False
    cutoff = (
        (datetime.now(UTC) - timedelta(hours=hours_old)).date().isoformat() if hours_old else None
    )
    catalog_complete = False
    try:
        with open_public_browser() as browser:
            page = browser.new_page()
            page.set_default_timeout(15_000)

            def navigate(url):
                response = page.goto(url, wait_until="domcontentloaded")
                if response and response.status >= 400:
                    raise ValueError(f"http_{response.status}")
                if re.search(r"captcha|just a moment|verify you are human", page.title(), re.I):
                    raise ValueError("security_checkpoint")
                if urlsplit(page.url).hostname != urlsplit(plan["url"]).hostname:
                    raise ValueError("board_identity_mismatch")

            navigate(plan["url"])
            view_all = page.get_by_text("View All Jobs", exact=True)
            if view_all.is_visible():
                view_all.click()
            page.locator('[id^="win0divHRS_SCH_WRK_FLU_HRS_SES_CNTS_MSG"]').wait_for()
            rows, total = parse_catalog(page.content())
            loaded = True
            while len(rows) < total:
                before = len(rows)
                if not before:
                    error = "catalog_count_mismatch"
                    break
                page.locator('[id^="SCH_JOB_TITLE$"]').last.scroll_into_view_if_needed()
                page.mouse.wheel(0, 1500)
                try:
                    page.wait_for_function(
                        "n => document.querySelectorAll('[id^=\"SCH_JOB_TITLE$\"]').length > n",
                        arg=before,
                    )
                except Exception:
                    error = "pagination_incomplete"
                    break
                rows, reported = parse_catalog(page.content())
                if reported != total:
                    error = "catalog_changed_during_scan"
                    break
            catalog_complete = len(rows) == total and error is None
            for row in rows:
                if cutoff and row["date_posted"] and row["date_posted"] < cutoff:
                    continue
                if not matching_search_lane(row["title"]):
                    continue
                target = posting_url(plan["url"], row["id"])
                description, location = None, None
                if not row["date_posted"]:
                    error = error or "posting_date_unknown"
                try:
                    navigate(target)
                    # A combined employer portal can require a different SiteId for a
                    # subsidiary. Read its published share link, never guess site IDs.
                    catalog = page.locator('[id^="win0divHRS_SCH_WRK_FLU_HRS_SES_CNTS_MSG"]')
                    if catalog.is_visible():
                        current, count = parse_catalog(page.content())
                        while (
                            not any(item["id"] == row["id"] for item in current)
                            and len(current) < count
                        ):
                            before = len(current)
                            page.locator('[id^="SCH_JOB_TITLE$"]').last.scroll_into_view_if_needed()
                            page.mouse.wheel(0, 1500)
                            page.wait_for_function(
                                "n => document.querySelectorAll('[id^=\"SCH_JOB_TITLE$\"]').length > n",
                                arg=before,
                            )
                            current, count = parse_catalog(page.content())
                        result = page.locator(".ps_grid-row").filter(
                            has=page.locator('[id^="HRS_APP_JBSCH_I_HRS_JOB_OPENING_ID$"]').filter(
                                has_text=re.compile("^" + row["id"] + "$")
                            )
                        )
                        button = result.get_by_role("button", name="View Job Description")
                        (button if button.count() else result).click()
                        page.locator("#HRS_SCH_WRK2_HRS_JOB_OPENING_ID").wait_for()
                        read_detail(page.content(), row)
                        page.get_by_text("Email this Job", exact=True).click()
                        dialog = page.frame_locator("iframe").get_by_text("Email Job", exact=True)
                        dialog.wait_for()
                        frame = next(
                            f
                            for f in page.frames[1:]
                            if f.get_by_text("Email Job", exact=True).count()
                        )
                        target = read_share_url(frame.content(), plan["url"], row["id"])
                        # No recipient is entered and Send is never clicked.
                        navigate(target)
                    page.locator("#HRS_SCH_WRK2_HRS_JOB_OPENING_ID").wait_for()
                    description, location = read_detail(page.content(), row)
                except Exception as exc:
                    error = catalog_error(exc)
                jobs.append(
                    _job(
                        title=row["title"],
                        company=company,
                        location=location,
                        url=target,
                        source="employer_peoplesoft",
                        description=description,
                        date_posted=row["date_posted"],
                    )
                )
                if error in {"http_429", "http_403", "security_checkpoint"}:
                    break
    except Exception as exc:
        error = catalog_error(exc)
    return discovery_result(plan, jobs, error, loaded, catalog_complete=catalog_complete)
