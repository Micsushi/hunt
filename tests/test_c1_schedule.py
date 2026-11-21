from unittest.mock import Mock

from hunter import db, scraper


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


def test_scan_restarts_after_invalid_lease_and_retries_unsaved_work(monkeypatch, tmp_path):
    import pytest

    from hunter.discovery_run import LEASE_KEY, RUN_KEY, ScanRun, read_progress, scan_is_running

    monkeypatch.setenv("HUNT_DB_URL", "")
    monkeypatch.setattr(db, "DB_PATH", str(tmp_path / "failed-save.db"))
    db.init_db(maintenance=False)
    db.set_runtime_state(RUN_KEY, "[]")
    db.set_runtime_state(LEASE_KEY, "[]")
    assert scan_is_running() is False
    with pytest.raises(OSError):
        with ScanRun({}) as scan:
            assert scan_is_running() is True
            assert scan.progress["resumed"] is False
            assert scan.start("unsaved")
            raise OSError("database unavailable")
    assert scan_is_running() is False
    assert read_progress()["state"] == "interrupted"
    with ScanRun({}) as resumed:
        assert resumed.start("unsaved")
        resumed.saved("unsaved")
    assert read_progress()["state"] == "completed"


def test_http_cache_revalidates_public_content_and_evicts_it_when_private(monkeypatch, tmp_path):
    from email.message import Message
    from unittest.mock import MagicMock
    from urllib.error import HTTPError

    import pytest

    from hunter import discovery_sources
    from hunter.discovery_cache import cached_response

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
        if len(calls) < 4:
            raise HTTPError(request.full_url, 304 if len(calls) == 2 else 403, "test", {}, None)
        response.headers["Cache-Control"] = "private"
        response.read.return_value = b"new private content"
        return response

    monkeypatch.setattr(discovery_sources, "urlopen", fetch)
    assert discovery_sources.fetch_text("https://public.example/job/1") == "verified public posting"
    assert discovery_sources.fetch_text("https://public.example/job/1") == "verified public posting"
    with pytest.raises(HTTPError) as error:
        discovery_sources.fetch_text("https://public.example/job/1")
    assert error.value.code == 403 and len(calls) == 3
    url = "https://public.example/job/1"
    assert cached_response(url) is not None
    assert discovery_sources.fetch_text(url) == "new private content"
    assert cached_response(url) is None


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
