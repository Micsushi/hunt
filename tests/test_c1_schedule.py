from datetime import UTC, datetime, timedelta
from unittest.mock import Mock

from hunter import db, runner, scraper


def test_scan_ownership_resume_and_configuration_change(monkeypatch, tmp_path):
    import pytest

    from hunter.discovery_run import ScanBusy, ScanRun, read_progress, stop_requested

    monkeypatch.setenv("HUNT_DB_URL", "")
    monkeypatch.setattr(db, "DB_PATH", str(tmp_path / "resume.db"))
    db.init_db(maintenance=False)
    try:
        with ScanRun({"terms": ["nurse"]}) as scan:
            assert scan.start("query:builtin: healthcare / nurse")
            with pytest.raises(ScanBusy):
                with ScanRun({"terms": ["nurse"]}):
                    pytest.fail("overlapping scan acquired ownership")
            scan.saved("query:builtin: healthcare / nurse", 3)
            stop_requested.set()
            assert not scan.start("unfinished")
        assert read_progress()["state"] == "interrupted"
        stop_requested.clear()
        with ScanRun({"terms": ["nurse"]}) as resumed:
            assert resumed.progress["resumed"]
            assert not resumed.start("query:builtin: healthcare / nurse")
            assert resumed.pending_terms("builtin", {"healthcare": ["nurse", "pharmacist"]}) == {
                "healthcare": ["pharmacist"]
            }
            assert resumed.start("unfinished")
            resumed.saved("unfinished", 2)
            stop_requested.set()
        stop_requested.clear()
        with ScanRun({"terms": ["teacher"]}) as changed:
            assert not changed.progress["resumed"]
            assert changed.progress["saved"] == 0
    finally:
        stop_requested.clear()


def test_scan_failure_does_not_checkpoint_unsaved_work_or_hold_lease(monkeypatch, tmp_path):
    import pytest

    from hunter.discovery_run import ScanRun, read_progress

    monkeypatch.setenv("HUNT_DB_URL", "")
    monkeypatch.setattr(db, "DB_PATH", str(tmp_path / "failed-save.db"))
    db.init_db(maintenance=False)
    with pytest.raises(OSError):
        with ScanRun({}) as scan:
            assert scan.start("unsaved")
            raise OSError("database unavailable")
    assert read_progress()["state"] == "interrupted"
    with ScanRun({}) as resumed:
        assert resumed.start("unsaved")
        resumed.saved("unsaved")
    assert read_progress()["state"] == "completed"


def test_http_cache_revalidates_and_never_hides_access_failure(monkeypatch, tmp_path):
    from email.message import Message
    from unittest.mock import MagicMock
    from urllib.error import HTTPError

    import pytest

    from hunter import discovery_sources

    monkeypatch.setenv("HUNT_DISCOVERY_CACHE_DIR", str(tmp_path))
    response = MagicMock()
    response.__enter__.return_value = response
    response.headers = Message()
    response.headers["Content-Type"] = "text/html; charset=utf-8"
    response.headers["ETag"] = '"revision-1"'
    response.read.return_value = b"verified public posting"
    calls = []

    def fetch(request, **kwargs):
        calls.append(request)
        if len(calls) == 1:
            assert not request.has_header("If-none-match")
            return response
        assert request.get_header("If-none-match") == '"revision-1"'
        raise HTTPError(request.full_url, 304 if len(calls) == 2 else 403, "test", {}, None)

    monkeypatch.setattr(discovery_sources, "urlopen", fetch)
    assert discovery_sources.fetch_text("https://public.example/job/1") == "verified public posting"
    assert discovery_sources.fetch_text("https://public.example/job/1") == "verified public posting"
    with pytest.raises(HTTPError) as error:
        discovery_sources.fetch_text("https://public.example/job/1")
    assert error.value.code == 403 and len(calls) == 3


def test_scheduled_company_scan_persists_jobs_health_and_restart_cooldown(monkeypatch, tmp_path):
    import json

    from hunter.discovery_sources import discover_company_career_site

    path = str(tmp_path / "scheduled.db")
    monkeypatch.setenv("HUNT_DB_URL", "")
    monkeypatch.setenv("HUNT_DB_PATH", path)
    monkeypatch.setenv("HUNT_AUDIT_LOG_ROOT", str(tmp_path / "audit"))
    monkeypatch.setattr(db, "DB_PATH", path)
    monkeypatch.setattr(scraper, "SITES", [])
    monkeypatch.setattr(scraper, "ENRICH_AFTER_SCRAPE", False)
    monkeypatch.setattr(scraper, "_notify_priority_jobs", Mock())
    monkeypatch.setattr(runner, "PUBLIC_FEED_DISCOVERY", False)
    root = "https://unseen.example/careers"
    monkeypatch.setattr(scraper, "COMPANY_CAREER_SITES", {"Unseen": root})
    fetch = Mock(
        return_value='<script type="application/ld+json">'
        + json.dumps(
            {
                "@type": "JobPosting",
                "title": "IT Support",
                "url": "/jobs/42",
                "jobLocation": {"address": {"addressCountry": "CA"}},
                "datePosted": datetime.now(UTC).date().isoformat(),
                "description": "Resolve hardware and software problems for our technical team.",
            }
        )
        + "</script>"
    )
    monkeypatch.setattr(
        scraper,
        "discover_company_career_site",
        lambda company, url, **kwargs: discover_company_career_site(
            company,
            url,
            fetcher=fetch,
            hours_old=kwargs.get("hours_old"),
            resolved_plan=kwargs.get("resolved_plan"),
        ),
    )
    summaries = []

    def one_cycle(**kwargs):
        summary = scraper.scrape(**kwargs)
        summaries.append(summary)
        runner._shutdown = True
        return summary

    monkeypatch.setattr(runner, "scrape", one_cycle)
    for _ in range(2):
        monkeypatch.setattr(runner, "_shutdown", False)
        runner.main()
    assert [s["inserted"] for s in summaries] == [1, 0]
    assert [s["scraped_total"] for s in summaries] == [1, 0]
    fetch.assert_called_once_with(root)
    assert not runner._backfill_due()
    row = db.list_company_fetch_queue()[0]
    assert row["state"] == "partial" and row["lead_count"] == 1
    assert row["fetch_method"] == "structured"
    with db.get_connection() as conn:
        jobs = conn.execute("SELECT job_url, enrichment_status FROM jobs").fetchall()
    assert len(jobs) == 1
    assert jobs[0]["job_url"] == "https://unseen.example/jobs/42"
    assert jobs[0]["enrichment_status"] == "blocked"


def test_discovery_schedule_persists_and_recovers_invalid_or_due_values(monkeypatch, tmp_path):
    monkeypatch.setenv("HUNT_DB_URL", "")
    monkeypatch.setattr(db, "DB_PATH", str(tmp_path / "schedule.db"))
    db.init_db(maintenance=False)
    assert scraper._discovery_due("job_bank")
    scraper._schedule_discovery("job_bank", 3600)
    assert not scraper._discovery_due("job_bank")
    for value in ("invalid", (datetime.now(UTC) - timedelta(seconds=1)).isoformat()):
        db.set_runtime_state("discovery_next_check:job_bank", value)
        assert scraper._discovery_due("job_bank")


def test_company_schedule_skips_recent_success_and_retries_failed_source(monkeypatch):
    sites = {"Good": "https://good.example", "Broken": "https://broken.example"}
    monkeypatch.setattr(scraper, "COMPANY_CAREER_SITES", sites)
    monkeypatch.setattr(scraper, "upsert_company_fetch_queue", Mock())
    monkeypatch.setattr(scraper, "record_company_fetch_result", Mock())
    monkeypatch.setattr(scraper, "record_discovery_source_health", Mock())
    scheduled = Mock()
    monkeypatch.setattr(scraper, "_schedule_discovery", scheduled)
    monkeypatch.setattr(scraper, "_discovery_due", lambda source: "Broken" in source)
    discover = Mock(return_value=([], {"status": "failed", "error": "http_502"}))
    monkeypatch.setattr(scraper, "discover_company_career_site", discover)
    scraper._discover_company_queue(due_only=True)
    discover.assert_called_once_with(
        "Broken",
        sites["Broken"],
        hours_old=336,
        rendered_resolver=scraper.resolve_rendered_career_fetch_plan,
    )
    scheduled.assert_called_once_with("company:Broken:https://broken.example", 3600)


def test_runner_checks_scheduled_sources_between_daily_backfills(monkeypatch):
    monkeypatch.setattr(runner, "_shutdown", False)
    monkeypatch.setattr(runner, "_backfill_due", lambda: False)
    monkeypatch.setattr(runner, "PUBLIC_FEED_DISCOVERY", True)
    monkeypatch.setattr(runner, "count_ready_jobs_for_enrichment", lambda: 0)
    monkeypatch.setattr(runner, "count_pending_jobs_for_enrichment", lambda: 0)
    calls = []

    def scrape(**kwargs):
        calls.append(kwargs)
        runner._shutdown = True
        return {}

    monkeypatch.setattr(runner, "scrape", scrape)
    runner.main()
    assert calls == [
        {
            "hours_old": None,
            "include_public_sources": True,
            "include_company_queue": True,
            "discovery_due_only": True,
        }
    ]


def test_company_queue_retains_resolved_method_until_site_or_evidence_changes(
    monkeypatch, tmp_path
):
    monkeypatch.setenv("HUNT_DB_URL", "")
    monkeypatch.setattr(db, "DB_PATH", str(tmp_path / "company.db"))
    db.init_db(maintenance=False)
    db.upsert_company_fetch_queue("Example", "https://example.com/careers", "manual")
    db.record_company_fetch_result(
        "Example",
        state="ok",
        lead_count=3,
        fetch_method="successfactors",
        resolved_url="https://example.com/search/",
    )
    db.upsert_company_fetch_queue("Example", "https://example.com/careers", "manual")
    row = db.list_company_fetch_queue()[0]
    assert row["fetch_method"] == "successfactors"
    assert row["resolved_url"] == "https://example.com/search/"
    assert row["state"] == "ok" and row["lead_count"] == 3
    db.record_company_fetch_result("Example", state="failed", error="http_502")
    assert db.list_company_fetch_queue()[0]["fetch_method"] == "successfactors"
    assert db.list_company_fetch_queue()[0]["resolved_url"] == "https://example.com/search/"
    db.record_company_fetch_result("Example", state="pending_manual", fetch_method="manual")
    assert db.list_company_fetch_queue()[0]["fetch_method"] == "manual"
    assert db.list_company_fetch_queue()[0]["resolved_url"] is None
    db.record_company_fetch_result("Example", state="ok", fetch_method="greenhouse")
    db.upsert_company_fetch_queue("Example", "https://new.example.com", "manual")
    row = db.list_company_fetch_queue()[0]
    assert row["fetch_method"] == "manual"
    assert row["state"] == "pending" and row["lead_count"] == 0
    assert row["last_checked_at"] is None
    assert row["resolved_url"] is None


def test_company_aliases_keep_separate_boards_and_migrate_legacy_key(monkeypatch, tmp_path):
    monkeypatch.setenv("HUNT_DB_URL", "")
    monkeypatch.setattr(db, "DB_PATH", str(tmp_path / "two-boards.db"))
    db.init_db(maintenance=False)
    first = "https://rbc.wd3.myworkdayjobs.com/RBCGLOBAL1"
    second = "https://rbc.wd3.myworkdayjobs.com/RBCEARLYTALENT1"
    # A database created by the old code used the employer alias as its primary key.
    with db.get_connection() as conn:
        conn.execute(
            "INSERT INTO company_fetch_queue (normalized_company, company, career_site, fetch_method, state, lead_count) VALUES (?, ?, ?, ?, ?, ?)",
            ("rbc", "Royal Bank of Canada", second, "workday", "ok", 7),
        )
    # The other alias can run first without overwriting the legacy board.
    db.upsert_company_fetch_queue("RBC", first, "workday")
    migrated = db.upsert_company_fetch_queue("Royal Bank of Canada", second, "workday")
    assert migrated["state"] == "ok" and migrated["lead_count"] == 7
    db.upsert_company_fetch_queue("RBC", first, "workday")
    db.record_company_fetch_result("RBC", state="failed", error="http_503")
    rows = {row["company"]: row for row in db.list_company_fetch_queue()}
    assert len(rows) == 2
    assert rows["Royal Bank of Canada"]["career_site"] == second
    assert rows["Royal Bank of Canada"]["state"] == "ok"
    assert rows["RBC"]["state"] == "failed"
    assert db.normalize_company("RBC") == db.normalize_company("Royal Bank of Canada")


def test_cached_company_plan_recovers_removed_board_but_respects_rate_limits():
    import json
    from urllib.error import HTTPError

    from hunter.discovery_sources import discover_company_career_site

    root = "https://example.com/careers"
    old = "https://boards-api.greenhouse.io/v1/boards/old/jobs?content=true"
    new = "https://api.ashbyhq.com/posting-api/job-board/new"
    plan = {"method": "greenhouse", "url": old}
    fetch = Mock(return_value=json.dumps({"jobs": []}))
    assert (
        discover_company_career_site("Example", root, fetcher=fetch, resolved_plan=plan)[1][
            "status"
        ]
        == "ok"
    )
    fetch.assert_called_once_with(old)
    for code in (404, 410, 429, 403):

        def fetch_url(url):
            if url == old:
                raise HTTPError(old, code, "test", {}, None)
            if url == root:
                return '<a href="https://jobs.ashbyhq.com/new">Jobs</a>'
            assert url == new
            return '{"jobs": []}'

        fetch = Mock(side_effect=fetch_url)
        _, health = discover_company_career_site("Example", root, fetcher=fetch, resolved_plan=plan)
        if code in (404, 410):
            assert health["status"] == "ok" and health["method"] == "ashby"
            assert fetch.call_count == 3
        else:
            assert health["error"] == f"http_{code}"
            fetch.assert_called_once_with(old)


def test_company_locator_migrates_existing_database_and_is_used(monkeypatch, tmp_path):
    monkeypatch.setenv("HUNT_DB_URL", "")
    monkeypatch.setattr(db, "DB_PATH", str(tmp_path / "old.db"))
    with db.get_connection() as conn:
        conn.execute(db.COMPANY_FETCH_QUEUE_TABLE_SQL.replace("    resolved_url TEXT,", ""))
    db.init_db(maintenance=False)
    root = "https://example.com/careers"
    board = "https://boards-api.greenhouse.io/v1/boards/example/jobs?content=true"
    db.upsert_company_fetch_queue("Example", root, "manual")
    db.record_company_fetch_result(
        "Example", state="ok", fetch_method="greenhouse", resolved_url=board
    )
    monkeypatch.setattr(scraper, "COMPANY_CAREER_SITES", {"Example": root})
    discover = Mock(return_value=([], {"status": "ok", "method": "greenhouse", "url": board}))
    monkeypatch.setattr(scraper, "discover_company_career_site", discover)
    scraper._discover_company_queue()
    assert discover.call_args.kwargs["resolved_plan"] == {"method": "greenhouse", "url": board}
    row = db.upsert_company_fetch_queue("Example", root + "/new", "manual")
    assert row["resolved_url"] is None


def test_company_resolver_preserves_configured_search_form_filters():
    from hunter.discovery_sources import resolve_career_fetch_plan

    plan = resolve_career_fetch_plan(
        "https://example.com/?optionsFacetsDD_country=CA&utm_source=test",
        fetcher=lambda url: (
            '<footer>SuccessFactors</footer><form action="/search/">'
            '<input name="q"><select name="optionsFacetsDD_country"></select></form>'
        ),
    )
    assert plan == {
        "method": "successfactors",
        "url": "https://example.com/search/?optionsFacetsDD_country=CA",
    }


def test_cached_eightfold_plan_recovers_published_domain_after_restart():
    from hunter.discovery_sources import discover_company_career_site

    root = "https://careers.example.com/careers"
    calls = []

    def fetch(url):
        calls.append(url)
        if url == root:
            return '<script>window._EF_GROUP_ID = "employer.example";</script><script src="/pcsxPwa.app.js"></script>'
        assert (
            url
            == "https://careers.example.com/api/pcsx/search?domain=employer.example&query=&location=Canada&start=0"
        )
        return '{"status":200,"data":{"positions":[],"count":0}}'

    _, first = discover_company_career_site("Example", root, fetcher=fetch)
    cached = {key: first[key] for key in ("method", "url")}
    _, second = discover_company_career_site("Example", root, fetcher=fetch, resolved_plan=cached)
    assert first["status"] == second["status"] == "ok"
    assert calls.count(root) == 2
    _, failed = discover_company_career_site(
        "Example", root, fetcher=lambda _: "<html>Removed board</html>", resolved_plan=cached
    )
    assert failed["status"] == "failed" and failed["error"] == "board_identity_mismatch"


def test_company_details_stop_network_requests_after_rate_limit():
    import json
    from urllib.error import HTTPError

    from hunter.discovery_sources import discover_company_career_site

    root = "https://careers.example.com/careers"
    calls = []

    def fetch(url):
        calls.append(url)
        if url == root:
            return '<script>window._EF_GROUP_ID = "employer.example";</script><script src="/pcsxPwa.app.js"></script>'
        if "/search?" in url:
            return json.dumps(
                {
                    "status": 200,
                    "data": {
                        "count": 3,
                        "positions": [
                            {
                                "id": n,
                                "atsJobId": str(n),
                                "name": "Software Engineer",
                                "locations": ["Canada"],
                                "positionUrl": f"/careers/job/{n}",
                            }
                            for n in range(1, 4)
                        ],
                    },
                }
            )
        raise HTTPError(url, 429, "Slow down", {"Retry-After": "3600"}, None)

    jobs, health = discover_company_career_site("Example", root, fetcher=fetch)
    assert len(calls) == 3  # Configuration, catalog, and only the first detail request.
    assert len(jobs) == 3  # Already-discovered cards survive without fabricated descriptions.
    assert all(job["description"] is None for job in jobs)
    assert health["status"] == "partial" and health["error"] == "http_429"


def test_company_resolver_recognizes_published_greenhouse_api_feed():
    from hunter.discovery_sources import career_fetch_plan, resolve_career_fetch_plan

    expected = {
        "method": "greenhouse",
        "url": "https://boards-api.greenhouse.io/v1/boards/example/jobs?content=true",
    }
    for host in ("api.greenhouse.io", "boards-api.greenhouse.io"):
        url = f"https://{host}/v1/boards/example/jobs?content=true"
        assert career_fetch_plan(url) == expected
        assert (
            resolve_career_fetch_plan(
                "https://example.com/careers",
                fetcher=lambda _: '<script type="application/json">{"feed":"' + url + '"}</script>',
            )
            == expected
        )
    assert (
        career_fetch_plan("https://api.greenhouse.io.attacker.test/v1/boards/example/jobs")[
            "method"
        ]
        == "manual"
    )
    assert (
        career_fetch_plan("https://api.greenhouse.io/v1/boards/example/jobs/123")["method"]
        == "manual"
    )


def test_company_resolver_reads_embedded_workday_links_without_choosing_ambiguous_boards():
    import json

    from hunter.discovery_sources import resolve_career_fetch_plan

    def resolve(urls):
        return resolve_career_fetch_plan(
            "https://example.com/search",
            fetcher=lambda _: (
                "<script>var jobs=" + json.dumps([{"applyUrl": url} for url in urls]) + ";</script>"
            ),
        )

    urls = [
        "https://acme.wd5.myworkdayjobs.com/Careers/job/Toronto/Engineer_123/apply",
        "https://acme.wd5.myworkdayjobs.com/en-US/Careers/job/Toronto/Support_124/apply",
    ]
    assert resolve(urls) == {
        "method": "workday",
        "url": "https://acme.wd5.myworkdayjobs.com/wday/cxs/acme/Careers",
    }
    assert (
        resolve(urls + ["https://other.wd1.myworkdayjobs.com/Careers/job/Other_2"])["error"]
        == "ambiguous_career_boards"
    )
    assert (
        resolve(["https://acme.wd5.myworkdayjobs.com.attacker.test/Careers"])["method"] == "manual"
    )


def test_slow_board_does_not_hold_public_or_company_results(monkeypatch):
    from threading import Event

    board_started, public_saved, company_saved = Event(), Event(), Event()
    monkeypatch.setattr(scraper, "init_db", Mock())
    monkeypatch.setattr(scraper, "C1Logger", Mock())
    monkeypatch.setattr(scraper, "_notify_priority_jobs", Mock())
    monkeypatch.setattr(scraper, "SEARCH_TERMS", {"engineering": ["software engineer"]})
    monkeypatch.setattr(scraper, "LOCATIONS", ["Canada"])
    monkeypatch.setattr(scraper, "SITES", ["linkedin"])
    monkeypatch.setattr(scraper, "MAX_WORKERS", 1)
    saved = []
    monkeypatch.setattr(
        scraper, "add_job", lambda job: (saved.append(job) or "inserted", len(saved))
    )

    def slow_board(*args):
        board_started.set()
        assert public_saved.wait(3), "Public sources were queued behind the board"
        assert company_saved.wait(3), "Companies were queued behind the board"
        assert len(saved) == 2
        return [{"title": "Board result"}]

    def public(hours_old, callback, **kwargs):
        assert board_started.wait(3)
        callback([{"title": "Public result"}], [])
        public_saved.set()

    def companies(*, on_result, **kwargs):
        assert board_started.wait(3)
        on_result([{"title": "Company result"}])
        company_saved.set()

    monkeypatch.setattr(scraper, "_scrape_jobspy_task", slow_board)
    monkeypatch.setattr(scraper, "_discover_public_sources", public)
    monkeypatch.setattr(scraper, "_discover_company_queue", companies)
    summary = scraper.scrape(
        include_public_sources=True, include_company_queue=True, enrich_pending=False
    )
    assert summary["inserted"] == summary["scraped_total"] == 3
    assert summary["skipped"] == 0


def test_running_status_is_boolean_and_invalid_progress_can_restart(monkeypatch, tmp_path):
    from hunter.discovery_run import LEASE_KEY, RUN_KEY, ScanRun, scan_is_running

    monkeypatch.setenv("HUNT_DB_URL", "")
    monkeypatch.setattr(db, "DB_PATH", str(tmp_path / "status.db"))
    db.init_db(maintenance=False)
    db.set_runtime_state(RUN_KEY, "[]")
    db.set_runtime_state(LEASE_KEY, "[]")
    assert scan_is_running() is False
    with ScanRun({}) as run:
        assert scan_is_running() is True
        assert run.progress["resumed"] is False
    assert scan_is_running() is False


def test_daily_refresh_follows_employer_platform_migration():
    import json

    from hunter.discovery_sources import discover_company_career_site

    root = "https://example.com/careers"
    old = {
        "method": "greenhouse",
        "url": "https://boards-api.greenhouse.io/v1/boards/old/jobs?content=true",
    }
    calls = []

    def fetch(url):
        calls.append(url)
        if url == root:
            return '<a href="https://jobs.lever.co/example">Current jobs</a>'
        if "api.lever.co" in url:
            return json.dumps([])
        raise AssertionError(url)

    jobs, health = discover_company_career_site(
        "Example", root, fetcher=fetch, resolved_plan=old, refresh_plan=True
    )
    assert jobs == [] and health["status"] == "ok"
    assert health["method"] == "lever"
    assert old["url"] not in calls


def test_http_cache_discards_previously_public_response_when_origin_marks_private(
    monkeypatch, tmp_path
):
    from email.message import Message
    from types import SimpleNamespace

    from hunter.discovery_cache import cache_response, cached_response

    monkeypatch.setenv("HUNT_DISCOVERY_CACHE_DIR", str(tmp_path))
    headers = Message()
    headers["ETag"] = '"first"'
    response = SimpleNamespace(headers=headers)
    cache_response("https://example.com/jobs", response, b"old")
    assert cached_response("https://example.com/jobs") is not None
    headers["Cache-Control"] = "private"
    cache_response("https://example.com/jobs", response, b"new")
    assert cached_response("https://example.com/jobs") is None


def test_multiple_boards_keep_separate_coverage_and_original_employer(monkeypatch, tmp_path):
    monkeypatch.setenv("HUNT_DB_URL", "")
    monkeypatch.setattr(db, "DB_PATH", str(tmp_path / "boards.db"))
    db.init_db(maintenance=False)
    boards = ["https://jobs.lever.co/example", "https://jobs.lever.co/example-europe"]
    monkeypatch.setattr(scraper, "COMPANY_CAREER_SITES", {"Example": boards})
    discovered = []

    def discover(company, url, **kwargs):
        discovered.append((company, url))
        return [], {"status": "ok", "method": "lever", "url": url, "error": None}

    monkeypatch.setattr(scraper, "discover_company_career_site", discover)
    scraper._discover_company_queue()
    assert sorted(discovered) == [("Example", url) for url in boards]
    rows = db.list_company_fetch_queue()
    assert len(rows) == 2 and all(row["state"] == "ok" for row in rows)
    assert all(row["coverage"]["catalog"] == "complete" for row in rows)
