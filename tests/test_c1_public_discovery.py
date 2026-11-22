import json
from datetime import UTC, datetime, timedelta
from threading import Event
from unittest.mock import MagicMock, Mock
from urllib.error import HTTPError

import pytest

from hunter.discovery_jobright import parse_jobright_page, save_jobright_session
from hunter.discovery_sources import (
    career_fetch_plan,
    discover_builtin,
    discover_company_career_site,
    discover_jobillico,
    discover_public_feeds,
)


@pytest.mark.parametrize("case", ["ok", "navigation_error", "forbidden", "checkpoint"])
def test_rendered_career_browser_keeps_access_outcomes_and_closes(monkeypatch, case):
    from hunter.discovery_browser import resolve_rendered_career_fetch_plan

    manager = MagicMock()
    browser = manager.return_value.__enter__.return_value.chromium.launch.return_value
    page = browser.new_page.return_value
    page.goto.return_value.status = 403 if case == "forbidden" else 200
    page.title.return_value = "Just a moment" if case == "checkpoint" else "Careers"
    page.content.return_value = '<a href="https://jobs.lever.co/example">Open jobs</a>'
    page.get_by_role.return_value.first.count.return_value = 1
    monkeypatch.setattr("playwright.sync_api.sync_playwright", manager)
    url = "https://example.com/careers"
    if case == "navigation_error":
        page.goto.side_effect = RuntimeError("navigation failed")
        with pytest.raises(RuntimeError, match="navigation failed"):
            resolve_rendered_career_fetch_plan(url)
    elif case == "ok":
        assert resolve_rendered_career_fetch_plan(url)["method"] == "lever"
        page.get_by_role.return_value.first.scroll_into_view_if_needed.assert_called_once()
    else:
        jobs, health = discover_company_career_site(
            "Example",
            url,
            fetcher=lambda _: "<html></html>",
            rendered_resolver=resolve_rendered_career_fetch_plan,
        )
        assert jobs == [] and health["status"] == "failed"
        assert health["error"] == ("http_403" if case == "forbidden" else "security_checkpoint")
    manager.return_value.__enter__.return_value.chromium.launch.assert_called_once_with(
        headless=True
    )
    browser.close.assert_called_once()


@pytest.mark.parametrize("case", ["valid", "denied", "lookalike", "detail", "ambiguous"])
def test_rendered_career_resolves_only_public_catalog_responses(monkeypatch, case):
    from hunter.discovery_browser import resolve_rendered_career_fetch_plan

    manager = MagicMock()
    browser = manager.return_value.__enter__.return_value.chromium.launch.return_value
    page = browser.new_page.return_value
    page.title.return_value = "Careers"
    page.content.return_value = "<main>Open jobs</main>"
    url = "https://boards-api.greenhouse.io/v1/boards/example/jobs"
    if case == "lookalike":
        url = url.replace("greenhouse.io", "greenhouse.io.attacker.test")
    if case == "detail":
        url += "/42"

    def navigate(*args, **kwargs):
        listener = page.on.call_args.args[1]
        listener(
            Mock(
                url=url,
                status=403 if case == "denied" else 200,
                request=Mock(method="GET", resource_type="fetch"),
            )
        )
        if case == "ambiguous":
            listener(
                Mock(
                    url=url.replace("example", "other"),
                    status=200,
                    request=Mock(method="GET", resource_type="xhr"),
                )
            )
        return Mock(status=200)

    page.goto.side_effect = navigate
    monkeypatch.setattr("playwright.sync_api.sync_playwright", manager)
    plan = resolve_rendered_career_fetch_plan("https://example.com/careers")
    assert plan["method"] == ("greenhouse" if case == "valid" else "manual")
    if case == "valid":
        assert plan["url"] == url + "?content=true"
    if case == "ambiguous":
        assert plan["error"] == "ambiguous_career_boards"
    browser.close.assert_called_once()


def test_feed_error_page_is_not_reported_as_empty_success():
    feeds = {"feed": ("markdown", "https://example.com/feed")}
    jobs, health = discover_public_feeds(
        hours_old=336, feeds=feeds, fetcher=lambda _: "<html>Temporarily unavailable</html>"
    )
    assert jobs == [] and health[0]["status"] == "failed"
    jobs, health = discover_public_feeds(
        hours_old=336,
        feeds=feeds,
        fetcher=lambda _: "| Company | Role | Location | Apply | Date Posted |",
    )
    assert jobs == [] and health[0]["status"] == "ok"


def test_greenhouse_update_time_is_not_posting_time_and_bad_catalog_is_not_empty():
    payload = {
        "jobs": [
            {
                "title": "IT Support",
                "absolute_url": "https://boards.greenhouse.io/example/jobs/42",
                "location": {"name": "Toronto"},
                "updated_at": "2026-10-01T12:00:00Z",
            }
        ]
    }
    jobs, _ = discover_company_career_site(
        "Example", "https://boards.greenhouse.io/example", fetcher=lambda _: json.dumps(payload)
    )
    assert jobs[0]["date_posted"] is None
    jobs, health = discover_company_career_site(
        "Example", "https://boards.greenhouse.io/example", fetcher=lambda _: "{}"
    )
    assert jobs == [] and health["status"] == "failed"


def test_scrape_saves_completed_batch_before_later_source_fails(monkeypatch):
    from hunter import discovery_browser, discovery_jobright, scraper

    saved = []
    batch_saved = Event()

    def add_job(job):
        saved.append(job)
        batch_saved.set()
        return "inserted", 1

    monkeypatch.setattr(scraper, "set_runtime_state", Mock())
    monkeypatch.setattr(scraper, "get_runtime_state", lambda keys: {})
    monkeypatch.setattr(scraper, "init_db", lambda: None)
    monkeypatch.setattr(scraper, "C1Logger", Mock())
    monkeypatch.setattr(scraper, "SEARCH_TERMS", {})
    monkeypatch.setattr(scraper, "add_job", add_job)
    monkeypatch.setattr(scraper, "record_discovery_source_health", Mock())
    for name in (
        "discover_jobillico",
        "discover_builtin",
        "discover_wellfound",
        "discover_talentegg",
        "discover_vanhack",
    ):
        monkeypatch.setattr(scraper, name, lambda *args, **kwargs: ([], []))
    for name in ("discover_gc_jobs", "discover_eluta", "discover_jobs_ca"):
        monkeypatch.setattr(discovery_browser, name, lambda *args, **kwargs: ([], []))
    monkeypatch.setattr(discovery_jobright, "discover_jobright", lambda **kwargs: ([], []))
    monkeypatch.setattr(
        scraper, "discover_public_feeds", lambda **_: ([{"title": "IT support"}], [])
    )

    def fail(**kwargs):
        assert batch_saved.wait(timeout=5), "completed feed batch was not persisted"
        assert len(saved) == 1
        raise RuntimeError("later source failed")

    monkeypatch.setattr(scraper, "discover_job_bank", lambda *args, **kwargs: fail(**kwargs))
    scraper.scrape(include_public_sources=True, enrich_pending=False)
    assert saved == [{"title": "IT support"}]
    scraper.record_discovery_source_health.assert_called_once_with(
        "job_bank", status="failed", lead_count=0, error="RuntimeError"
    )


def test_workday_pages_and_retains_results_when_one_detail_fails():
    offsets = []

    def poster(url, payload):
        offsets.append(payload["offset"])
        return {
            "total": 21,
            "jobPostings": [
                {"title": "IT Support Technician", "externalPath": f"/job/Canada/IT_R{n}"}
                for n in range(payload["offset"], min(payload["offset"] + 20, 21))
            ],
        }

    def fetcher(url):
        if url.endswith("R1"):
            raise TimeoutError()
        return json.dumps(
            {
                "jobPostingInfo": {
                    "title": "IT Support Technician",
                    "location": "Toronto",
                    "country": {"descriptor": "Canada"},
                    "canApply": True,
                    "externalUrl": "https://example.wd3.myworkdayjobs.com/External"
                    + url.split("/External", 1)[1],
                    "startDate": "2026-10-01",
                    "jobDescription": "Support computers",
                }
            }
        )

    jobs, health = discover_company_career_site(
        "Example",
        "https://example.wd3.myworkdayjobs.com/en-US/External",
        fetcher=fetcher,
        poster=poster,
    )
    assert offsets == [0, 20]
    assert len(jobs) == 21
    missing = next(job for job in jobs if job["job_url"].endswith("R1"))
    assert missing["description"] is None and missing["enrichment_status"] == "blocked"
    assert health["status"] == "partial"
    assert health["error"] == "TimeoutError"
    assert all(not job["auto_apply_eligible"] for job in jobs)


@pytest.mark.parametrize(
    "fault", [None, "changed", "overlap", "excess", "malformed", "negative", "string_total"]
)
def test_workday_catalog_completion_requires_stable_unique_valid_rows(fault):
    from hunter.discovery_sources import discover_workday

    def row(identity):
        return {"title": "IT Support", "externalPath": f"/job/IT_R{identity}"}

    def poster(url, query):
        if query["offset"] == 0:
            return {"total": 3, "jobPostings": [row(1), row(2)]}
        rows = [row(3)]
        total = 3
        if fault == "changed":
            total = 4
        elif fault == "overlap":
            rows = [row(2)]
        elif fault == "excess":
            rows.append(row(4))
        elif fault == "malformed":
            rows[0]["externalPath"] = "/careers"
        elif fault == "negative":
            total = -1
        elif fault == "string_total":
            total = "3"
        return {"total": total, "jobPostings": rows}

    def fetcher(url):
        raise TimeoutError()

    jobs, health = discover_workday(
        "Example",
        {"url": "https://example.wd3.myworkdayjobs.com/wday/cxs/example/External"},
        poster=poster,
        fetcher=fetcher,
    )
    assert len(jobs) == (3 if fault is None else 2)
    assert health["catalog_complete"] == (fault is None)
    assert health["status"] == "partial"
    assert health["error"] == (
        "TimeoutError"
        if fault is None
        else {
            "changed": "catalog_count_changed",
            "overlap": "pagination_repeated",
            "excess": "invalid_workday_page",
            "malformed": "invalid_workday_listing",
            "negative": "invalid_workday_page",
            "string_total": "invalid_workday_page",
        }[fault]
    )


def test_employer_landing_page_resolves_unambiguous_published_board_links():
    from hunter.discovery_sources import resolve_career_fetch_plan

    root = "https://example.com/careers"
    page = '<iframe src="https://boards.greenhouse.io/embed/job_board?for=example"></iframe>'
    expected = career_fetch_plan("https://job-boards.greenhouse.io/example")
    assert resolve_career_fetch_plan(root, fetcher=lambda _: page) == expected
    ambiguous = page + '<a href="https://jobs.lever.co/another">Other company</a>'
    plan = resolve_career_fetch_plan(root, fetcher=lambda _: ambiguous)
    assert plan["method"] == "manual"
    assert plan["error"] == "ambiguous_career_boards"
    assert (
        career_fetch_plan("https://boards.greenhouse.io/embed/job_board?for=../other")["method"]
        == "manual"
    )

    pages = [
        r'<div x-data="[{&quot;url&quot;:&quot;https:\/\/jobs.ashbyhq.com\/example\/123&quot;}]"></div>',
        '<script>window.jobs = [{"url":"https://jobs.ashbyhq.com/example/123"}]</script>',
        "<a :href=\"job.url || 'https://jobs.ashbyhq.com/example'\">Apply</a>",
    ]
    for page in pages:
        plan = resolve_career_fetch_plan(root, fetcher=lambda _: page)
        assert plan == career_fetch_plan("https://jobs.ashbyhq.com/example")
    ambiguous = pages[1] + '<a href="https://jobs.lever.co/other">Jobs</a>'
    plan = resolve_career_fetch_plan(root, fetcher=lambda _: ambiguous)
    assert plan["error"] == "ambiguous_career_boards"
    spoof = '<script>"https://jobs.ashbyhq.com.evil.test/example"</script>'
    assert resolve_career_fetch_plan(root, fetcher=lambda _: spoof)["method"] == "manual"


def test_company_resolver_follows_published_detail_not_unrelated_hosts():
    from hunter.discovery_sources import resolve_career_fetch_plan

    urls = []

    def fetch(url):
        urls.append(url)
        if url.endswith("/careers"):
            return (
                '<a href="https://unrelated.example/job">Software Engineer</a>'
                '<a href="/careers/job123">Software Developer</a>'
            )
        return '<script src="https://app.greenhouse.io/embed/job_board/js?for=example"></script>'

    plan = resolve_career_fetch_plan("https://example.com/careers", fetcher=fetch)
    assert plan == career_fetch_plan("https://boards.greenhouse.io/example")
    assert urls == ["https://example.com/careers", "https://example.com/careers/job123"]


def test_jobright_preserves_easy_apply_exclusion_and_does_not_invent_description():
    jobs, ids = parse_jobright_page(
        {
            "success": True,
            "result": {
                "jobList": [
                    {
                        "companyResult": {"companyName": "Example"},
                        "jobResult": {
                            "jobId": "abc",
                            "jobTitle": "IT Support Technician",
                            "jobLocation": "Toronto, Canada",
                            "jobtargetEasyapply": True,
                            "publishTime": datetime.now(UTC).isoformat(),
                            "jobSummary": "AI summary, not the original description",
                        },
                    }
                ]
            },
        }
    )
    assert ids == ["abc"]
    assert jobs[0]["apply_type"] == "easy_apply"
    assert jobs[0]["description"] is None
    assert jobs[0]["apply_url"] is None
    assert not jobs[0]["auto_apply_eligible"]
    assert jobs[0]["discovery_suppressed_reason"] == "easy_apply_ineligible"


def test_public_fetch_retries_only_transient_transport_errors(monkeypatch):
    import socket
    import ssl
    from urllib.error import URLError

    from hunter import discovery_sources as sources

    response = Mock()
    response.__enter__ = Mock(return_value=response)
    response.__exit__ = Mock(return_value=False)
    response.read.return_value = b"ok"
    response.headers.get_content_charset.return_value = None
    opener = Mock(
        side_effect=[HTTPError("https://example.com", 502, "bad gateway", {}, None), response]
    )
    sleep = Mock()
    monkeypatch.setattr(sources, "urlopen", opener)
    monkeypatch.setattr(sources.time, "sleep", sleep)
    assert sources.fetch_text("https://example.com") == "ok"
    assert opener.call_count == 2
    sleep.assert_called_once_with(2)
    sleep.reset_mock()
    for code, headers in ((403, {}), (429, {"Retry-After": "120"})):
        opener.reset_mock(side_effect=True)
        opener.side_effect = HTTPError("https://example.com", code, "blocked", headers, None)
        with pytest.raises(HTTPError):
            sources.fetch_text("https://example.com")
        assert opener.call_count == 1

    for reason, expected in [
        (ssl.SSLCertVerificationError("untrusted issuer"), "tls_certificate_error"),
        (socket.gaierror(socket.EAI_NONAME, "unknown host"), "dns_resolution_failed"),
    ]:
        failure = URLError(reason)
        opener.reset_mock(side_effect=True)
        opener.side_effect = failure
        with pytest.raises(URLError):
            sources.fetch_text("https://example.com")
        assert opener.call_count == 1
        assert sources._error_code(failure) == expected
    sleep.assert_not_called()


def test_jobright_session_export_is_scoped_and_preserves_prior_file_on_failure(
    monkeypatch, tmp_path
):
    import playwright.sync_api

    from hunter import discovery_jobright as module

    runtime = MagicMock()
    browser = runtime.__enter__.return_value.chromium.connect_over_cdp.return_value
    browser.contexts = [Mock()]
    browser.contexts[0].storage_state.return_value = {
        "cookies": [
            {"domain": ".jobright.ai", "value": "jobright-only"},
            {"domain": ".google.com", "value": "do-not-export"},
        ],
        "origins": [
            {"origin": "https://jobright.ai", "localStorage": []},
            {"origin": "https://accounts.google.com", "localStorage": []},
        ],
    }
    monkeypatch.setattr(playwright.sync_api, "sync_playwright", lambda: runtime)
    path = tmp_path / "session.json"
    save_jobright_session("http://127.0.0.1:9223", path)
    original = path.read_bytes()
    assert b"do-not-export" not in original
    assert b"google.com" not in original
    browser.close.assert_not_called()
    monkeypatch.setattr(module.json, "dump", Mock(side_effect=OSError("disk full")))
    with pytest.raises(OSError):
        save_jobright_session("http://127.0.0.1:9223", path)
    assert path.read_bytes() == original
    assert list(tmp_path.iterdir()) == [path]


def test_public_source_failure_does_not_skip_other_sources_but_db_failure_stops(monkeypatch):
    from hunter import discovery_browser, discovery_jobright, scraper

    monkeypatch.setattr(scraper, "get_runtime_state", lambda keys: {})
    monkeypatch.setattr(scraper, "set_runtime_state", Mock())

    for name in (
        "discover_public_feeds",
        "discover_job_bank",
        "discover_jobillico",
        "discover_builtin",
        "discover_wellfound",
        "discover_talentegg",
        "discover_vanhack",
    ):
        monkeypatch.setattr(scraper, name, lambda *args, **kwargs: ([], []))
    for name in ("discover_gc_jobs", "discover_eluta", "discover_jobs_ca"):
        monkeypatch.setattr(discovery_browser, name, lambda *args, **kwargs: ([], []))
    monkeypatch.setattr(discovery_jobright, "discover_jobright", lambda **kwargs: ([], []))
    broken = Mock(side_effect=TimeoutError("private transport details"))
    later = Mock(
        side_effect=lambda *args, **kwargs: kwargs["on_result"]([{"title": "IT Support"}], [])
    )
    monkeypatch.setattr(scraper, "discover_job_bank", broken)
    monkeypatch.setattr(scraper, "discover_jobillico", later)
    saved = []
    scraper._discover_public_sources(336, lambda jobs, health: saved.append((jobs, health)))
    later.assert_called_once()
    assert any(health and health[0]["error"] == "TimeoutError" for _, health in saved)
    assert any(jobs == [{"title": "IT Support"}] for jobs, _ in saved)

    def swallowed_callback_failure(**kwargs):
        try:
            kwargs["on_result"]([{"title": "IT Support"}], [])
        except OSError:
            pass
        return [], []

    monkeypatch.setattr(discovery_jobright, "discover_jobright", swallowed_callback_failure)
    with pytest.raises(OSError, match="database unavailable"):
        scraper._discover_public_sources(336, Mock(side_effect=OSError("database unavailable")))
    deferred = Mock()
    monkeypatch.setattr(discovery_jobright, "discover_jobright", deferred)
    monkeypatch.setattr(
        scraper,
        "get_runtime_state",
        lambda keys: {
            "jobright_retry_after": {"value": (datetime.now(UTC) + timedelta(hours=1)).isoformat()}
        },
    )
    health_updates = []
    scraper._discover_public_sources(336, lambda jobs, health: health_updates.extend(health))
    deferred.assert_not_called()
    assert health_updates[0]["status"] == "rate_limited"
    assert health_updates[0]["error"].startswith("jobright_cooldown_until_")


@pytest.mark.parametrize("jobs", [[], [{"title": "IT Support"}]])
def test_jobspy_batch_never_implies_exhaustive_search(monkeypatch, jobs):
    from hunter import scraper

    record = Mock()
    monkeypatch.setattr(scraper, "record_discovery_source_health", record)
    monkeypatch.setattr(scraper, "scrape_single", Mock(return_value=jobs))
    assert scraper._scrape_jobspy_task("fallback", "IT support", "Canada", "it_support", 24) == jobs
    record.assert_called_once_with(
        "jobspy_fallback: it_support / IT support / Canada",
        status="partial",
        lead_count=len(jobs),
        error="upstream_search_completion_unverified",
    )


@pytest.mark.parametrize("reader", [discover_jobillico, discover_builtin])
def test_public_search_streams_completed_query_before_next_query(reader):
    saved = []
    calls = []

    def fetch(url):
        calls.append(url)
        if len(calls) > (2 if reader is discover_builtin else 1):
            assert saved and saved[0][0][0]["title"] == "IT support"
            raise TimeoutError()
        if "/job/1" in url:
            return (
                '<script type="application/ld+json">'
                + json.dumps(
                    {
                        "@type": "JobPosting",
                        "title": "IT support",
                        "description": "Support",
                        "jobLocation": {"address": {"addressCountry": "CA"}},
                    }
                )
                + "</script>"
            )
        return '<article><h2><a href="/job/1">IT support</a></h2></article>'

    jobs, _ = reader(
        {"it_support": ["IT support", "service desk"]},
        fetcher=fetch,
        on_result=lambda jobs, health: saved.append((jobs, health)),
    )
    assert jobs == []  # Streamed batches are not retained a second time in memory.
    assert sum(len(batch) for batch, _ in saved) == 1
    assert (
        len([entry for _, health in saved for entry in health if entry["status"] != "running"]) == 2
    )


@pytest.mark.parametrize("total,expected", [(1, "ok"), (2, "partial")])
@pytest.mark.parametrize("countries", [["Canada"], ["Canada", "United States"], []])
def test_jobright_search_does_not_call_a_short_catalog_complete(
    monkeypatch, tmp_path, total, expected, countries
):
    from unittest.mock import MagicMock, Mock

    import playwright.sync_api

    from hunter import config
    from hunter import discovery_jobright as module

    monkeypatch.setattr(config, "DISCOVERY_COUNTRIES", countries)
    if countries != ["Canada"]:
        expected = "partial"
    payload = {
        "success": True,
        "result": {
            "jobNum": total,
            "jobList": [
                {
                    "jobResult": {
                        "jobId": "1",
                        "jobTitle": "Junior Software Engineer",
                        "publishTime": "2026-10-04",
                        "jobLocation": "Canada",
                        "originalUrl": "https://example.test/jobs/1",
                    },
                    "companyResult": {"companyName": "Example"},
                }
            ],
        },
    }
    response = Mock()
    response.value.json.return_value = payload
    response.value.url = "https://jobright.ai/swan/recommend/search?position=0&sortCondition=1"
    context = MagicMock()
    page = context.__enter__.return_value.new_page.return_value
    page.url = "https://jobright.ai/jobs/search?country=CA&value=software+engineer"
    empty = Mock()
    empty.value.json.return_value = {"success": True, "result": {"jobNum": total, "jobList": []}}
    page.expect_response.return_value.__enter__.return_value = empty
    monkeypatch.setattr(playwright.sync_api, "sync_playwright", MagicMock())
    monkeypatch.setattr(module, "_jobright_context", lambda *a: context)
    monkeypatch.setattr(module, "_load_recommendations", Mock())
    monkeypatch.setattr(module, "_load_search", Mock(return_value=response))
    session = tmp_path / "session.json"
    session.write_text("{}")
    jobs, health = module.discover_jobright(
        storage_state=session, search_terms={"engineering": ["software engineer"]}, hours_old=100000
    )
    assert len(jobs) == 1
    assert health[1]["status"] == expected
    if total == 2:
        assert health[1]["error"].startswith("catalog_count_mismatch")
    page.close.assert_called_once()
