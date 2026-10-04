"""Search JobRight through its normal interface without changing saved preferences."""

import json
import os
import tempfile
from contextlib import contextmanager, suppress
from datetime import UTC, datetime, timedelta
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

from hunter.discovery_policy import annotate_job, normalize_job_url
from hunter.discovery_run import check_cancelled
from hunter.discovery_sources import _job, _parse_date


def parse_jobright_page(payload, *, hours_old=336):
    if isinstance(payload, dict) and payload.get("success") is False:
        code = payload.get("errorCode")
        if code == 43004:
            raise ValueError("jobright_hourly_refresh_limit")
        if isinstance(code, int):
            raise ValueError(f"jobright_error_{code}")
    if not isinstance(payload, dict) or payload.get("success") is not True:
        raise ValueError("jobright_response_not_successful")
    result = payload.get("result")
    rows = result.get("jobList") if isinstance(result, dict) else None
    if not isinstance(rows, list):
        raise ValueError("jobright_job_list_missing")
    jobs, ids = [], []
    cutoff = datetime.now(UTC) - timedelta(hours=hours_old)
    for row in rows:
        data = row.get("jobResult") if isinstance(row, dict) else None
        if not isinstance(data, dict) or not data.get("jobId") or not data.get("jobTitle"):
            raise ValueError("jobright_listing_invalid")
        ids.append(str(data["jobId"]))
        posted = _parse_date(data.get("publishTime"))
        if data.get("isDeleted") or (posted and posted < cutoff):
            continue
        company = row.get("companyResult") or {}
        url = normalize_job_url(data.get("originalUrl")) or normalize_job_url(data.get("applyLink"))
        listing = "https://jobright.ai/jobs/info/" + str(data["jobId"])
        job = _job(
            title=data["jobTitle"],
            company=company.get("companyName"),
            location=data.get("jobLocation"),
            url=url or listing,
            source="jobright",
            date_posted=posted.date().isoformat() if posted else None,
            description=None,  # Board-generated summaries are not the employer's full description.
        )
        job["is_remote"] = data.get("isRemote") is True
        if data.get("jobtargetEasyapply") is True:
            job["apply_type"] = "easy_apply"
        if not url:
            job["apply_url"] = None
        jobs.append(annotate_job(job))
    return jobs, ids


@contextmanager
def _jobright_context(playwright, endpoint, storage_state):
    if endpoint:
        browser = playwright.chromium.connect_over_cdp(endpoint, timeout=15000)
        if not browser.contexts:
            raise ValueError("jobright_browser_context_missing")
        yield browser.contexts[0]
        # The caller owns the attached browser; never close it here.
    else:
        browser = playwright.chromium.launch(headless=True)
        try:
            yield browser.new_context(storage_state=storage_state)
        finally:
            browser.close()


def discover_jobright(
    *,
    endpoint=None,
    storage_state=None,
    hours_old=336,
    max_pages=4,
    on_result=None,
    search_terms=None,
):
    """Attach to a dedicated signed-in browser; close only our own search tab.

    Pagination uses the observed page control and responses, not a guessed private API.
    Each configured title uses explicit search, most-recent ordering and bounded paging.
    """
    from playwright.sync_api import Error, sync_playwright
    from playwright.sync_api import TimeoutError as BrowserTimeout

    endpoint = endpoint or os.environ.get("HUNT_JOBRIGHT_CDP_URL", "")
    storage_state = storage_state or os.environ.get(
        "JOBRIGHT_STORAGE_STATE_PATH", ".state/jobright_auth_state.json"
    )
    from hunter import config

    terms = (
        search_terms
        if search_terms is not None
        else (config.TARGET_JOB_TITLES if config.TARGETING_CONFIGURED else config.SEARCH_TERMS)
    )
    jobs, seen, saved_keys = [], set(), set()
    query_health = []
    health = {
        "source": "jobright",
        "status": "needs_login",
        "lead_count": 0,
        "error": "jobright_browser_not_configured",
    }
    if not endpoint and not Path(storage_state).is_file():
        if on_result:
            on_result([], [health])
        return jobs, [health]
    page = None
    try:
        with (
            sync_playwright() as playwright,
            _jobright_context(playwright, endpoint, storage_state) as context,
        ):
            page = context.new_page()
            page.set_default_timeout(20000)
            try:
                _load_recommendations(page)
                for lane, queries in terms.items():
                    for term in dict.fromkeys(queries):
                        check_cancelled()
                        current = {
                            "source": f"jobright: {lane} / {term}",
                            "status": "running",
                            "lead_count": 0,
                            "error": None,
                        }
                        query_health.append(current)
                        try:
                            response = _load_search(page, term)
                            country = parse_qs(urlsplit(page.url).query).get("country", [""])[0]
                            requested = {
                                {
                                    "canada": "ca",
                                    "can": "ca",
                                    "united states": "us",
                                    "usa": "us",
                                }.get(c.casefold(), c.casefold())
                                for c in config.DISCOVERY_COUNTRIES
                            }
                            if not requested or requested != {country.casefold()}:
                                current["error"] = (
                                    f"jobright_geography_partial: searched {country or 'unknown'} only; other countries were not searched"
                                )
                            if config.DISCOVERY_COUNTRIES and not any(
                                country.casefold()
                                == {"canada": "ca", "united states": "us", "usa": "us"}.get(
                                    c.casefold(), c.casefold()
                                )
                                for c in config.DISCOVERY_COUNTRIES
                            ):
                                raise ValueError("jobright_search_country_mismatch")
                            query_seen = set()
                            oldest = None
                            unknown_date = False
                            expected_total = None
                            for page_index in range(max_pages):
                                check_cancelled()
                                payload = response.value.json()
                                found, ids = parse_jobright_page(payload, hours_old=hours_old)
                                dates = [
                                    _parse_date(row["jobResult"].get("publishTime"))
                                    for row in payload["result"]["jobList"]
                                ]
                                unknown_date |= any(d is None for d in dates)
                                known = [d for d in dates if d]
                                if known:
                                    oldest = min([oldest, *known] if oldest else known)
                                if ids and not set(ids) - query_seen:
                                    current.update(status="partial", error="pagination_repeated")
                                    break
                                query_seen.update(ids)
                                seen.update(ids)
                                new_jobs = []
                                for job in found:
                                    key = job["canonical_job_key"]
                                    if key not in saved_keys:
                                        saved_keys.add(key)
                                        new_jobs.append(job)
                                jobs.extend(new_jobs)
                                current["lead_count"] += len(found)
                                total = payload["result"].get("jobNum")
                                if expected_total is None and type(total) is int:
                                    expected_total = total
                                if type(total) is int and expected_total != total:
                                    current.update(
                                        status="partial", error="catalog_changed_during_scan"
                                    )
                                count_mismatch = expected_total is not None and (
                                    len(query_seen) > expected_total
                                    or (not ids and len(query_seen) != expected_total)
                                )
                                exhausted = not ids or (
                                    expected_total is not None and len(query_seen) == expected_total
                                )
                                past_window = (
                                    page_index >= 1
                                    and known
                                    and len(known) == len(dates)
                                    and max(known) < datetime.now(UTC) - timedelta(hours=hours_old)
                                )
                                final = exhausted or past_window or page_index + 1 >= max_pages
                                if final:
                                    current.update(
                                        status="partial"
                                        if count_mismatch
                                        or current["error"]
                                        or unknown_date
                                        or not (exhausted or past_window)
                                        else "ok",
                                        error="catalog_count_mismatch"
                                        if count_mismatch
                                        else current["error"]
                                        or (
                                            "posting_date_unknown"
                                            if unknown_date
                                            else "page_limit_reached"
                                            if not (exhausted or past_window)
                                            else None
                                        ),
                                    )
                                if on_result:
                                    on_result(new_jobs, [dict(current)])
                                if final:
                                    break
                                previous_position = int(
                                    parse_qs(urlsplit(response.value.url).query).get(
                                        "position", ["0"]
                                    )[0]
                                )
                                with page.expect_response(
                                    lambda r: (
                                        _search_response(r, term=term)
                                        and int(
                                            parse_qs(urlsplit(r.url).query).get("position", ["0"])[
                                                0
                                            ]
                                        )
                                        > previous_position
                                    )
                                ) as response:
                                    page.locator('div[class*="jobs-page-main-content"]').evaluate(
                                        "element => { element.scrollTop = element.scrollHeight; }"
                                    )
                            # Keep bounded coverage evidence in source health without logging account data.
                            if current["error"]:
                                current["error"] += (
                                    f"; pages={page_index + 1}; reviewed={len(query_seen)}; oldest={oldest.date().isoformat() if oldest else 'unknown'}"
                                )
                            if on_result:
                                on_result([], [dict(current)])
                        except BrowserTimeout:
                            current.update(
                                status="partial" if current["lead_count"] else "failed",
                                error="jobright_search_timeout",
                            )
                            if on_result:
                                on_result([], [dict(current)])
                health.update(
                    status="ok" if all(h["status"] == "ok" for h in query_health) else "partial",
                    lead_count=len(jobs),
                    error=None
                    if all(h["status"] == "ok" for h in query_health)
                    else "search_coverage_partial",
                )
            except Exception as exc:
                try:
                    signed_out = page.get_by_text("SIGN IN", exact=True).count() > 0
                except Exception:
                    signed_out = False  # A crashed page cannot provide sign-in evidence.
                health.update(
                    status="rate_limited"
                    if str(exc) == "jobright_hourly_refresh_limit"
                    else "needs_login"
                    if signed_out
                    else "partial"
                    if seen
                    else "failed",
                    error="jobright_sign_in_required"
                    if signed_out
                    else str(exc)
                    if isinstance(exc, ValueError) and str(exc).startswith("jobright_")
                    else "jobright_browser_crashed"
                    if "crash" in str(exc).lower()
                    else type(exc).__name__,
                )
                if query_health:
                    query_health[-1].update(status=health["status"], error=health["error"])
            finally:
                with suppress(Error):
                    page.close()  # A disconnected page must not overwrite the recorded failure.
                # Do not browser.close(): the user owns the attached browser and profile.
    except Exception as exc:
        health.update(status="failed", error=type(exc).__name__)
    health["lead_count"] = len(jobs)
    if on_result:
        on_result([], [health, *query_health])
    return jobs, [health, *query_health]


def _search_response(response, *, term=None, position=None):
    url = urlsplit(response.url)
    return (
        url.scheme == "https"
        and url.hostname == "jobright.ai"
        and url.path == "/swan/recommend/search"
        and (term is None or (response.request.post_data_json or {}).get("value") == term)
        and (position is None or parse_qs(url.query).get("position") == [str(position)])
    )


def _load_search(page, term):
    query = page.get_by_placeholder("Search by title or company")
    with page.expect_response(
        lambda r: (
            urlsplit(r.url).hostname == "jobright.ai"
            and urlsplit(r.url).path == "/swan/filter/suggestion/search-words"
        )
    ):
        query.fill(term)
    with page.expect_response(lambda r: _search_response(r, term=term, position=0)) as response:
        query.press("Enter")
    # The site may retain sorting between searches; only change it when needed.
    recommended = page.locator('.ant-select-selection-item[title="Recommended"]')
    page.wait_for_function(
        "term => new URL(location.href).searchParams.get('value') === term", arg=term
    )
    page.locator(
        '.ant-select-selection-item[title="Recommended"], .ant-select-selection-item[title="Most Recent"]'
    ).wait_for()
    if parse_qs(urlsplit(response.value.url).query).get("sortCondition") != ["1"]:
        recommended.click()
        with page.expect_response(lambda r: _search_response(r, term=term, position=0)) as response:
            page.get_by_text("Most Recent", exact=True).last.click()
    page.locator('.ant-select-selection-item[title="Most Recent"]').wait_for()
    if parse_qs(urlsplit(response.value.url).query).get("sortCondition") != ["1"]:
        raise ValueError("jobright_recent_sort_unverified")
    return response


def _recommendation_response(response):
    url = urlsplit(response.url)
    return (
        url.scheme == "https"
        and url.hostname == "jobright.ai"
        and url.path == "/swan/recommend/list/jobs"
    )


def _load_recommendations(page):
    """Retry one interrupted network load, never an account or server rejection."""
    from playwright.sync_api import Error

    changed = []

    def failed(request):
        host = urlsplit(request.url).hostname or ""
        if (
            request.failure == "net::ERR_NETWORK_CHANGED"
            and request.resource_type in {"document", "script", "stylesheet"}
            and (host == "jobright.ai" or host.endswith(".jobright.ai"))
        ):
            changed.append(True)

    page.on("requestfailed", failed)
    try:
        for attempt in range(2):
            try:
                with page.expect_response(_recommendation_response) as response:
                    if attempt:
                        page.reload(wait_until="domcontentloaded")
                    else:
                        check_cancelled()
                        page.goto(
                            "https://jobright.ai/jobs/recommend", wait_until="domcontentloaded"
                        )
                return response
            except Error:
                if attempt or not changed:
                    raise
    finally:
        page.remove_listener("requestfailed", failed)


def save_jobright_session(endpoint, destination):
    """Export only JobRight cookies, not Google sign-in or unrelated browser data."""
    from playwright.sync_api import sync_playwright

    path = Path(destination)
    with sync_playwright() as playwright:
        browser = playwright.chromium.connect_over_cdp(endpoint, timeout=15000)
        state = browser.contexts[0].storage_state()
    state["cookies"] = [
        cookie
        for cookie in state["cookies"]
        if cookie["domain"].lstrip(".") == "jobright.ai"
        or cookie["domain"].endswith(".jobright.ai")
    ]
    state["origins"] = [
        origin for origin in state["origins"] if origin["origin"] == "https://jobright.ai"
    ]
    if not state["cookies"] and not state["origins"]:
        raise ValueError("No JobRight session found; existing session file was not changed.")
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(prefix=".jobright-", dir=path.parent)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
            json.dump(state, stream)
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="Save a dedicated JobRight browser session.")
    parser.add_argument("--endpoint", default="http://127.0.0.1:9223")
    parser.add_argument("--save-session", required=True, metavar="PATH")
    args = parser.parse_args()
    save_jobright_session(args.endpoint, args.save_session)
    print("JobRight session saved. Session contents are private; do not commit or share them.")
