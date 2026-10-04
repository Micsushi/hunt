"""Public Jobs.ca-family search using normal browser controls, without account writes."""

import re
from datetime import UTC, datetime, timedelta
from html import escape
from itertools import count
from urllib.error import HTTPError
from urllib.parse import parse_qs, urlencode, urljoin, urlsplit

from bs4 import BeautifulSoup

from hunter.browser_runtime import open_public_browser
from hunter.discovery_policy import annotate_job
from hunter.discovery_run import check_cancelled
from hunter.discovery_sources import (
    _job,
    career_fetch_plan,
    catalog_error,
    resolve_career_fetch_plan,
)
from hunter.search_lanes import matching_search_lane, title_matches_search_lane

JOBS_CA_SITES = {
    "jobs_ca": "https://www.jobs.ca",
    "techjobs_ca": "https://www.techjobs.ca",
    "itjobs_ca": "https://www.itjobs.ca",
}


def read_vanhack_catalog():
    """Scroll the public catalog until its explicit end marker, retaining partial HTML."""

    html, error = "", None
    try:
        with open_public_browser() as browser:
            page = browser.new_page()
            page.set_default_timeout(15000)
            check_cancelled()
            response = page.goto("https://app.vanhack.com/jobs", wait_until="networkidle")
            if response and response.status >= 400:
                raise ValueError(f"http_{response.status}")
            if urlsplit(page.url).hostname != "app.vanhack.com":
                raise ValueError("board_identity_mismatch")
            page.locator("a.vh-card-link").first.wait_for()
            while True:
                html = page.content()
                if page.get_by_text("You've seen every open role", exact=True).is_visible():
                    break
                before = page.locator("a.vh-card-link").count()
                page.locator("a.vh-card-link").last.scroll_into_view_if_needed()
                page.mouse.wheel(0, 1800)
                page.wait_for_function(
                    '(n)=>document.querySelectorAll("a.vh-card-link").length>n || document.body.innerText.includes("You\'ve seen every open role")',
                    arg=before,
                )
    except Exception as exc:
        error = str(exc) if isinstance(exc, ValueError) else "pagination_incomplete"
    return html, error


def resolve_rendered_career_fetch_plan(career_url):
    """Use an isolated public browser only to resolve published hiring-board links."""
    from playwright.sync_api import TimeoutError as PlaywrightTimeoutError

    with open_public_browser() as browser:
        page = browser.new_page()
        page.set_default_navigation_timeout(20_000)
        catalogs = set()

        def public_catalog(response):
            parts = urlsplit(response.url)
            if (
                response.status == 200
                and response.request.method == "GET"
                and response.request.resource_type in {"fetch", "xhr"}
                and parts.scheme == "https"
                and parts.hostname in {"api.greenhouse.io", "boards-api.greenhouse.io"}
                and not parts.username
                and not parts.password
            ):
                plan = career_fetch_plan(response.url)
                if plan["method"] == "greenhouse":
                    catalogs.add(plan["url"])

        page.on("response", public_catalog)

        def rendered_html(url):
            catalogs.clear()
            check_cancelled()
            response = page.goto(url, wait_until="domcontentloaded")
            if response and response.status >= 400:
                raise HTTPError(url, response.status, "Browser navigation failed", {}, None)
            if re.search(r"captcha|just a moment|verify you are human", page.title(), re.I):
                raise ValueError("security_checkpoint")
            # Some public job widgets load only when their section enters view.
            positions = page.get_by_role(
                "heading",
                name=re.compile(
                    r"^(?:open positions|current openings|open roles|job openings)$", re.I
                ),
            ).first
            if positions.count():
                positions.scroll_into_view_if_needed()
            try:
                page.wait_for_function(
                    """() => [...document.querySelectorAll('a[href], iframe[src]')].some(
                        n => /greenhouse\\.io|lever\\.co|ashbyhq\\.com|myworkdayjobs\\.com|smartrecruiters\\.com|apply\\.workable\\.com|bamboohr\\.com/.test(n.href || n.src || '')
                    )""",
                    timeout=8_000,
                )
            except PlaywrightTimeoutError:
                pass  # The page may instead expose structured data or another search link.
            # Reuse the ordinary resolver's ambiguity checks for observed public feeds.
            return page.content() + "".join(
                f'<a href="{escape(catalog, quote=True)}"></a>' for catalog in sorted(catalogs)
            )

        return resolve_career_fetch_plan(career_url, fetcher=rendered_html)


def parse_gc_jobs(html):
    soup = BeautifulSoup(html, "html.parser")
    jobs = []
    for card in soup.select("li.searchResult"):
        link = card.select_one("strong a[href]")
        if not link:
            continue
        title = link.get_text(" ", strip=True)
        category = matching_search_lane(title)
        if category is None:
            continue
        cell = card.select_one(".tableCell")
        parts = list(cell.stripped_strings) if cell else []
        closing = next(
            (
                re.search(r"Closing date: (\d{4}-\d{2}-\d{2})", part)
                for part in parts
                if "Closing date:" in part
            ),
            None,
        )
        if closing and closing[1] < datetime.now(UTC).date().isoformat():
            continue
        # Closing dates and page-modified dates are not posting dates.
        closing_index = next((i for i, part in enumerate(parts) if "Closing date:" in part), -1)
        company = (
            parts[closing_index + 1]
            if closing_index >= 0 and len(parts) > closing_index + 1
            else None
        )
        location = (
            parts[closing_index + 2]
            if closing_index >= 0 and len(parts) > closing_index + 2
            else None
        )
        jobs.append(
            _job(
                title=title,
                company=company,
                location=location,
                url=urljoin("https://emploisfp-psjobs.cfp-psc.gc.ca", link["href"]),
                source="gc_jobs",
                category=category,
            )
        )
    return jobs


def discover_gc_jobs(*, max_pages=None, on_result=None, url=None):
    origin = "https://emploisfp-psjobs.cfp-psc.gc.ca"
    url = url or origin + "/psrs-srfp/applicant/page2440?fromMenu=true&toggleLanguage=en"
    jobs, seen = [], set()
    error, total = None, None
    complete = False
    with open_public_browser() as browser:
        try:
            page = browser.new_page()
            page.set_default_timeout(20_000)
            for page_number in count(1):
                check_cancelled()
                page.goto(url, wait_until="domcontentloaded")
                page.locator("a[href*='tab=1']").first.wait_for()
                soup = BeautifulSoup(page.content(), "html.parser")
                counts = {
                    int(match[1].replace(",", ""))
                    for a in soup.select("a[href]")
                    if (
                        match := re.fullmatch(
                            r"Jobs open to the public \(([\d,]+)\)", a.get_text(" ", strip=True)
                        )
                    )
                }
                if len(counts) != 1:
                    raise ValueError("catalog_count_missing")
                current_total = counts.pop()
                if total is not None and total != current_total:
                    raise ValueError("catalog_changed_during_scan")
                total = current_total
                links = soup.select("li.searchResult strong a[href]")
                if len(links) != len(soup.select("li.searchResult")):
                    raise ValueError("invalid_employer_listing")
                for link in links:
                    target = urlsplit(urljoin(url, link["href"]))
                    poster = parse_qs(target.query).get("poster", [""])
                    if (
                        target.scheme != "https"
                        or target.hostname != urlsplit(origin).hostname
                        or target.path
                        not in {"/psrs-srfp/applicant/page1800", "/srs-sre/page01.html"}
                        or len(poster) != 1
                        or not poster[0].isdigit()
                    ):
                        raise ValueError("posting_identity_mismatch")
                    identity = (target.path, poster[0])
                    if identity in seen:
                        raise ValueError("pagination_repeated")
                    seen.add(identity)
                if len(seen) > total or (not links and len(seen) < total):
                    raise ValueError("catalog_count_mismatch")
                found = parse_gc_jobs(str(soup))
                jobs.extend(found)
                if on_result is not None:
                    on_result(
                        found,
                        [
                            {
                                "source": "gc_jobs",
                                "status": "partial",
                                "lead_count": len(jobs),
                                "error": "search_in_progress",
                            }
                        ],
                    )
                next_link = next(
                    (a for a in soup.select("a[href]") if a.get_text(strip=True) == "Next"), None
                )
                if next_link is None:
                    if len(seen) != total:
                        raise ValueError("catalog_count_mismatch")
                    complete = True
                    break
                if page_number == max_pages:
                    error = "page_limit_reached"
                    break
                url = urljoin(page.url, next_link["href"])
                if not url.startswith(origin + "/psrs-srfp/applicant/page2440?"):
                    error = "pagination_target_unverified"
                    break
        except Exception as exc:
            error = catalog_error(exc)
    if complete and jobs:
        error = "posting_dates_and_application_links_unverified"
    health = [
        {
            "source": "gc_jobs",
            "status": "partial" if error and jobs else "failed" if error else "ok",
            "catalog_complete": complete,
            "lead_count": len(jobs),
            "error": error,
        }
    ]
    if on_result is not None:
        on_result([], health)
    return jobs, health


def parse_eluta_results(html, category):
    soup = BeautifulSoup(html, "html.parser")
    jobs = []
    for card in soup.select(".organic-job[data-url]"):
        heading = card.select_one("h2")
        title = heading.get_text(" ", strip=True) if heading else ""
        if not title_matches_search_lane(title, category):
            continue
        path = card["data-url"].split("?", 1)[0].lstrip("/")
        if not path.startswith("spl/"):
            continue
        company = card.select_one(".employer")
        location = card.select_one(".location")
        description = card.select_one(".description")
        jobs.append(
            _job(
                title=title,
                company=company.get_text(" ", strip=True) if company else None,
                location=(location.get_text(" ", strip=True) + ", Canada") if location else None,
                description=description.get_text(" ", strip=True) if description else None,
                url="https://www.eluta.ca/" + path,
                source="eluta",
                category=category,
            )
        )
        # The card's "lastseen" is indexing time, not the employer's posting date.
    return jobs


def discover_eluta(search_terms, *, max_pages=None, on_result=None):

    jobs, health, seen = [], [], set()
    origin = "https://www.eluta.ca"
    with open_public_browser() as browser:
        page = browser.new_page()
        page.set_default_timeout(15_000)
        for category, terms in search_terms.items():
            for term in terms:
                found, visited = [], set()
                error = "posting_dates_and_application_links_unverified"
                url = origin + "/search?" + urlencode({"q": term})
                try:
                    for page_number in count(1):
                        check_cancelled()
                        page.goto(url, wait_until="domcontentloaded")
                        page.locator(".organic-job[data-url]").first.wait_for()
                        soup = BeautifulSoup(page.content(), "html.parser")
                        identity = tuple(
                            card["data-url"] for card in soup.select(".organic-job[data-url]")
                        )
                        if identity in visited:
                            error = "pagination_repeated"
                            break
                        visited.add(identity)
                        for job in parse_eluta_results(str(soup), category):
                            if job["job_url"] not in seen:
                                seen.add(job["job_url"])
                                found.append(job)
                        next_link = next(
                            (a for a in soup.select("a[href]") if a.get_text(strip=True) == "›"),
                            None,
                        )
                        if next_link is None:
                            break
                        if page_number == max_pages:
                            error = "page_limit_reached"
                            break
                        url = urljoin(origin, next_link["href"])
                        if not url.startswith(origin + "/search?"):
                            error = "pagination_target_unverified"
                            break
                except Exception as exc:
                    error = type(exc).__name__
                jobs.extend(found)
                health.append(
                    {
                        "source": f"eluta: {category} / {term}",
                        "status": "partial" if found else "unverified",
                        "lead_count": len(found),
                        "error": error,
                    }
                )
                if on_result is not None:
                    on_result(found, [health[-1]])
    return jobs, health


def parse_jobs_ca_results(html, origin, category, source):
    soup = BeautifulSoup(html, "html.parser")
    jobs = []
    for card in soup.select('[aria-label="Job search results"] article'):
        heading = card.select_one("h2")
        link = heading.select_one("a[href]") if heading else None
        if not link:
            continue
        title = link.get_text(" ", strip=True)
        if not title_matches_search_lane(title, category):
            continue
        company = heading.parent.select_one("p")
        location = card.select_one("li:not([aria-hidden])")
        jobs.append(
            _job(
                title=title,
                company=company.get_text(" ", strip=True) if company else None,
                location=location.get_text(" ", strip=True) if location else None,
                url=urljoin(origin, link["href"]),
                source=source,
                category=category,
            )
        )
    return jobs


def read_jobs_ca_detail(html, job):
    soup = BeautifulSoup(html, "html.parser")
    detail = soup.select_one('[aria-label="Job details"]')
    heading = detail.select_one("h2") if detail else None
    if heading is None or heading.get_text(" ", strip=True) != job["title"]:
        raise ValueError("detail_identity_mismatch")
    result = dict(job)
    link = detail.select_one('a[aria-label="Open full job posting"]')
    if link:
        result["job_url"] = result["apply_url"] = urljoin(job["job_url"], link["href"])
    for item in detail.select("li"):
        text = item.get_text(" ", strip=True)
        if text.startswith("Posted "):
            try:
                result["date_posted"] = (
                    datetime.strptime(text, "Posted %b %d, %Y").date().isoformat()
                )
            except ValueError:
                pass
    description_heading = detail.find("h3", string="Job details")
    if description_heading:
        description = description_heading.find_next_sibling("p")
        if description:
            result["description"] = description.get_text(" ", strip=True)
    return annotate_job(result)


def discover_jobs_ca(search_terms, *, sites=None, max_pages=None, hours_old=336, on_result=None):

    jobs, health, seen = [], [], set()
    cutoff = (datetime.now(UTC) - timedelta(hours=hours_old)).date().isoformat()
    with open_public_browser() as browser:
        for source, origin in (sites or JOBS_CA_SITES).items():
            context = browser.new_context()
            page = context.new_page()
            page.set_default_timeout(15_000)
            try:
                for category, terms in search_terms.items():
                    for term in terms:
                        found = []
                        error = "application_links_not_verified"
                        try:
                            check_cancelled()
                            page.goto(origin, wait_until="domcontentloaded")
                            if re.search(
                                r"just a moment|captcha|verify you are human",
                                page.title(),
                                re.I,
                            ):
                                raise RuntimeError("security_checkpoint")
                            page.get_by_role(
                                "combobox", name="Job title, keywords, or company"
                            ).fill(term)
                            page.get_by_role("button", name="Search jobs", exact=True).click()
                            results = page.get_by_role(
                                "region", name="Job search results", exact=True
                            )
                            results.wait_for()
                            visited = set()
                            for page_index in count():
                                if page.url in visited:
                                    error = "pagination_repeated"
                                    break
                                visited.add(page.url)
                                cards = parse_jobs_ca_results(
                                    page.content(), origin, category, source
                                )
                                for job in cards:
                                    if job["job_url"] not in seen:
                                        seen.add(job["job_url"])
                                        found.append(job)
                                next_page = page.get_by_role("link", name="Next page", exact=True)
                                if next_page.count() != 1:
                                    break
                                if page_index + 1 == max_pages:
                                    error = "page_limit_reached"
                                    break
                                next_url = urljoin(origin, next_page.get_attribute("href") or "")
                                if not next_url.startswith(origin + "/jobs?"):
                                    error = "pagination_target_unverified"
                                    break
                                check_cancelled()
                                page.goto(next_url, wait_until="domcontentloaded")
                                results.wait_for()
                        except Exception as exc:
                            error = (
                                "security_checkpoint"
                                if str(exc) == "security_checkpoint"
                                else type(exc).__name__
                            )
                        detailed = []
                        for job in found:
                            try:
                                check_cancelled()
                                page.goto(job["job_url"], wait_until="domcontentloaded")
                                page.get_by_role(
                                    "region", name="Job details", exact=True
                                ).get_by_role("heading", name=job["title"], exact=True).wait_for()
                                job = read_jobs_ca_detail(page.content(), job)
                            except Exception:
                                error = "some_job_details_unavailable"
                            if not job["date_posted"] or job["date_posted"] >= cutoff:
                                detailed.append(job)
                        jobs.extend(detailed)
                        health.append(
                            {
                                "source": f"{source}: {category} / {term}",
                                "status": "partial" if found else "unverified",
                                "lead_count": len(detailed),
                                "error": error,
                            }
                        )
                        if on_result is not None:
                            on_result(detailed, [health[-1]])
            finally:
                context.close()
    return jobs, health
