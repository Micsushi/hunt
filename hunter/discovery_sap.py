"""Read BC Hydro's public SAP catalog and published PDF descriptions."""

import base64
import re
from datetime import date
from io import BytesIO
from urllib.parse import parse_qsl, urljoin, urlsplit

from bs4 import BeautifulSoup
from pdfminer.high_level import extract_text

from hunter.browser_runtime import open_public_browser
from hunter.discovery_sources import _job, catalog_error, discovery_result
from hunter.search_lanes import matching_search_lane


def posting_identity(url):
    parts = urlsplit(url)
    if parts.scheme != "https" or parts.hostname != "app.bchydro.com":
        raise ValueError("posting_identity_mismatch")
    if parts.path != "/sap/bc/webdynpro/sap/hrrcf_a_posting_apply":
        raise ValueError("posting_identity_mismatch")
    try:
        value = dict(parse_qsl(parts.query))["PARAM"]
        params = dict(parse_qsl(base64.b64decode(value, validate=True).decode("ascii")))
        identity = params["post_inst_guid"]
    except (ValueError, KeyError, UnicodeError) as exc:
        raise ValueError("posting_identity_mismatch") from exc
    if not re.fullmatch(r"[A-Fa-f0-9]{32}", identity) or params.get("cand_type") != "EXT":
        raise ValueError("posting_identity_mismatch")
    return identity.lower()


def parse_catalog(html):
    soup = BeautifulSoup(html, "html.parser")
    count = re.search(r"Search Result:\s*([\d,]+)\s+Hits", soup.get_text(" ", strip=True))
    if not count:
        raise ValueError("catalog_total_unknown")
    rows = []
    for row in soup.select('tr[role="row"][rr]'):
        link = row.select_one('[role="link"]')
        position = row.get("rr", "")
        if not position.isdigit() or link is None or not link.get_text(strip=True):
            raise ValueError("invalid_listing")
        rows.append({"position": int(position), "title": link.get_text(" ", strip=True)})
    return rows, int(count[1].replace(",", ""))


def validate_pdf_url(url, identity):
    parts = urlsplit(url)
    if (
        parts.scheme != "https"
        or parts.hostname != "app.bchydro.com"
        or parts.path != "/sap/bc/bsp/sap/hrrcf_wd_dovru/application.do"
    ):
        raise ValueError("detail_identity_mismatch")
    try:
        params = dict(
            parse_qsl(
                base64.b64decode(dict(parse_qsl(parts.query))["PARAM"], validate=True).decode(
                    "ascii"
                )
            )
        )
    except (ValueError, KeyError, UnicodeError) as exc:
        raise ValueError("detail_identity_mismatch") from exc
    if params.get("rcftype") != "pinst" or params.get("pinst", "").lower() != identity:
        raise ValueError("detail_identity_mismatch")


def read_description(text, title):
    normalized = " ".join(text.split())
    # The employer's PDF template can clip a title's final punctuation.
    title_words = " ".join(re.findall(r"\w+", title.casefold()))
    text_words = " ".join(re.findall(r"\w+", text.casefold()))
    if not title_words or title_words not in text_words or "What you'll do" not in normalized:
        raise ValueError("detail_identity_mismatch")
    posted = re.search(r"Date Posted:\s*(\d{4}-\d{2}-\d{2})", text)
    closed = re.search(r"Closing Date:\s*(\d{4}-\d{2}-\d{2})", text)
    location = re.search(r"(?m)^Location:\s*([^\n]+)", text)
    return (
        date.fromisoformat(posted[1]).isoformat() if posted else None,
        date.fromisoformat(closed[1]) if closed else None,
        location[1].strip() if location else None,
    )


def discover_sap(company, plan):

    jobs, loaded, error = [], False, None
    catalog_complete = False
    try:
        with open_public_browser() as browser:
            page = browser.new_page()
            page.set_default_timeout(15_000)
            response = page.goto(plan["url"], wait_until="domcontentloaded")
            if response and response.status >= 400:
                raise ValueError(f"http_{response.status}")
            if urlsplit(page.url).hostname != "app.bchydro.com":
                raise ValueError("board_identity_mismatch")
            page.get_by_text("Start", exact=True).first.click()
            page.get_by_text("Job Search Result", exact=True).first.wait_for()
            rows, total = parse_catalog(page.content())
            loaded = True
            seen, identities = {}, set()
            while rows:
                before = len(seen)
                for row in rows:
                    position, title = row["position"], row["title"]
                    if position in seen:
                        if seen[position] != title:
                            raise ValueError("catalog_changed")
                        continue
                    seen[position] = title
                    if not matching_search_lane(title):
                        continue
                    posting = None
                    try:
                        with page.expect_popup() as opened:
                            page.locator(f'tr[role="row"][rr="{position}"]').get_by_role(
                                "link"
                            ).click()
                        posting = opened.value
                        posting.wait_for_load_state("domcontentloaded")
                        identity = posting_identity(posting.url)
                        if identity in identities:
                            raise ValueError("catalog_repeated")
                        identities.add(identity)
                        frame = posting.locator('iframe[title="Data Overview"]')
                        frame.wait_for()
                        pdf_url = urljoin(posting.url, frame.get_attribute("src") or "")
                        validate_pdf_url(pdf_url, identity)
                        pdf = page.context.request.get(pdf_url)
                        if pdf.status >= 400:
                            raise ValueError(f"http_{pdf.status}")
                        if "application/pdf" not in pdf.headers.get("content-type", ""):
                            raise ValueError("description_not_found")
                        description = extract_text(BytesIO(pdf.body()))
                        posted, closing, location = read_description(description, title)
                        if not posted:
                            error = error or "posting_date_unknown"
                        if not closing or closing >= date.today():
                            jobs.append(
                                _job(
                                    title=title,
                                    company=company,
                                    location=location,
                                    url=posting.url,
                                    source="employer_sap",
                                    description=description,
                                    date_posted=posted,
                                )
                            )
                    except Exception as exc:
                        error = catalog_error(exc)
                    finally:
                        if posting is not None:
                            posting.close()
                    if error in {"http_403", "http_429", "security_checkpoint"}:
                        break
                if len(seen) == total or error in {
                    "http_403",
                    "http_429",
                    "security_checkpoint",
                }:
                    break
                if len(seen) == before or len(seen) > total:
                    raise ValueError("catalog_count_mismatch")
                last = rows[-1]["position"]
                page.get_by_role("grid").press("PageDown")
                page.wait_for_function(
                    '(last) => Number([...document.querySelectorAll("tr[role=row][rr]")].at(-1)?.getAttribute("rr")) > last',
                    arg=last,
                )
                rows, next_total = parse_catalog(page.content())
                if next_total != total:
                    raise ValueError("catalog_changed")
            catalog_complete = set(seen) == set(range(1, total + 1))
            if not catalog_complete:
                error = error or "catalog_count_mismatch"
    except Exception as exc:
        error = catalog_error(exc)
    return discovery_result(plan, jobs, error, loaded, catalog_complete=catalog_complete)
