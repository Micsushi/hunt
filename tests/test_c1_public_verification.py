import json
from unittest.mock import Mock

import pytest

from hunter.verify_public import (
    process_public_verification_batch,
    verify_public_posting,
    verify_workday_posting,
)


@pytest.mark.parametrize(
    "fault,error",
    [
        (None, None),
        ("id", "public_posting_identity_mismatch"),
        ("title", "public_posting_identity_mismatch"),
        ("foreign", "public_posting_identity_mismatch"),
        ("posting", "public_posting_identity_mismatch"),
        ("inactive", "job_removed"),
        ("private", "job_removed"),
        ("unknown", "public_application_availability_unknown"),
        ("description", "description_not_found"),
    ],
)
def test_smartrecruiters_verification_requires_live_matching_public_posting(fault, error):
    url = "https://jobs.smartrecruiters.com/Example/123-it-support"
    job = {"title": "IT Support", "apply_url": url + "?oga=true"}
    row = {
        "id": "456" if fault == "id" else "123",
        "name": "Other job" if fault == "title" else "IT Support",
        "active": False if fault == "inactive" else None if fault == "unknown" else True,
        "visibility": "PRIVATE" if fault == "private" else "PUBLIC",
        "postingUrl": url.replace("123", "456") if fault == "posting" else url,
        "applyUrl": url.replace("Example", "Other") if fault == "foreign" else url + "?oga=true",
        "location": {"city": "Toronto", "country": "ca"},
        "jobAd": {
            "sections": {}
            if fault == "description"
            else {
                "jobDescription": {
                    "text": "<p>Support colleagues with hardware and software problems.</p>"
                },
                "qualifications": {
                    "text": "<p>Full qualifications include customer service experience.</p>"
                },
            }
        },
    }
    fetch = Mock(return_value=json.dumps(row))
    if error:
        with pytest.raises(ValueError, match=error):
            verify_public_posting(job, fetcher=fetch)
    else:
        result = verify_public_posting(job, fetcher=fetch)
        assert result["location"] == "Toronto, ca, Canada"
        assert "Full qualifications" in result["description"]
        assert result["ats_type"] == "smartrecruiters"
        assert result["auto_apply_eligible"] is True
    fetch.assert_called_once_with(
        "https://api.smartrecruiters.com/v1/companies/Example/postings/123"
    )


def test_smartrecruiters_canonical_identity_ignores_title_slug_and_apply_tracking():
    from hunter.discovery_policy import canonical_job_key

    expected = "smartrecruiters:example:123"
    assert canonical_job_key("https://jobs.smartrecruiters.com/Example/123") == expected
    assert (
        canonical_job_key("https://jobs.smartrecruiters.com/Example/123-it-support?oga=true")
        == expected
    )
    assert canonical_job_key("https://jobs.smartrecruiters.com/Other/123") != expected
    assert canonical_job_key("https://jobs.smartrecruiters.com.evil/Example/123") != expected


@pytest.mark.parametrize("provider", ["smartrecruiters", "bamboohr", "workable"])
def test_supported_saved_board_lead_is_claimed_for_verification(public_db, provider):
    connection = public_db.get_connection()
    connection.execute("UPDATE jobs SET ats_type=?, source='jobright' WHERE id=1", (provider,))
    connection.commit()
    connection.close()
    assert public_db.claim_public_employer_job()["id"] == 1


@pytest.mark.parametrize(
    "fault", [None, "title", "foreign", "id", "closed", "missing_status", "description"]
)
def test_bamboohr_verification_requires_exact_open_posting(fault):
    url = "https://example.bamboohr.com/careers/123"
    row = {
        "jobOpeningName": "Other" if fault == "title" else "IT Support",
        "jobOpeningShareUrl": url.replace("example", "other")
        if fault == "foreign"
        else url.replace("123", "456")
        if fault == "id"
        else url,
        "jobOpeningStatus": "Closed"
        if fault == "closed"
        else None
        if fault == "missing_status"
        else "Open",
        "description": ""
        if fault == "description"
        else "<p>Support colleagues with all their hardware and software problems.</p>",
        "atsLocation": {"city": "Toronto", "country": "Canada"},
    }
    fetch = Mock(return_value=json.dumps({"result": {"jobOpening": row}}))
    job = {"title": "IT Support", "apply_url": "https://example.bamboohr.com/jobs/view.php?id=123"}
    if fault:
        with pytest.raises(ValueError):
            verify_public_posting(job, fetcher=fetch)
    else:
        result = verify_public_posting(job, fetcher=fetch)
        assert result["apply_url"] == url
        assert result["location"] == "Toronto, Canada"
        assert result["auto_apply_eligible"] is True
    fetch.assert_called_once_with(url + "/detail")


@pytest.fixture
def public_db(monkeypatch, tmp_path):
    from hunter import db
    from hunter.discovery_sources import _job

    monkeypatch.setenv("HUNT_DB_URL", "")
    monkeypatch.setattr(db, "DB_PATH", str(tmp_path / "public.db"))
    db.init_db(maintenance=False)
    for index in range(1, 5):
        db.add_job(
            _job(
                title="IT Support",
                company="Example",
                location="Canada",
                url=f"https://example.wd5.myworkdayjobs.com/External/job/Toronto/IT-Support_R{index}000",
                source="employer_workday",
            )
        )
    return db


@pytest.mark.parametrize(
    "fault", [None, "identity", "title", "unpublished", "internal", "description"]
)
def test_workable_verification_requires_published_external_posting(fault):
    url = "https://apply.workable.com/example/j/012345ABCD/"
    job = {"title": "IT Support", "apply_url": url}
    row = {
        "shortcode": "AAAAAAAAAA" if fault == "identity" else "012345ABCD",
        "title": "Other" if fault == "title" else "IT Support",
        "state": "draft" if fault == "unpublished" else "published",
        "isInternal": fault == "internal",
        "description": ""
        if fault == "description"
        else "<p>Help customers resolve their hardware and software issues.</p>",
        "requirements": ""
        if fault == "description"
        else "<p>Full requirements include support experience.</p>",
        "locations": [
            {"country": "Portugal", "city": "Porto"},
            {"country": "Canada", "hidden": True},
        ],
    }
    fetch = Mock(return_value=json.dumps(row))
    if fault:
        with pytest.raises(ValueError):
            verify_public_posting(job, fetcher=fetch)
    else:
        result = verify_public_posting(job, fetcher=fetch)
        assert result["location"] == "Porto, Portugal"
        assert "Full requirements" in result["description"]
        assert result["apply_url"] == url
    fetch.assert_called_once_with(
        "https://apply.workable.com/api/v2/accounts/example/jobs/012345ABCD"
    )


def verification_result(job):
    return {
        "description": "Verified employer description",
        "apply_type": "external_apply",
        "auto_apply_eligible": True,
        "apply_url": job["job_url"],
        "apply_host": "example.wd5.myworkdayjobs.com",
        "ats_type": "workday",
    }


@pytest.mark.parametrize(
    "location,reason",
    [
        ("Austin, Texas, United States", "outside_canada"),
        (None, "geography_unverified"),
        ("Toronto, Canada", None),
    ],
)
def test_public_verification_refreshes_employer_location_and_fit(public_db, location, reason):
    def verify(job):
        return {**verification_result(job), "location": location}

    assert process_public_verification_batch(limit=1, verifier=verify)["verified"] == 1
    row = public_db.get_job_by_id(1)
    assert row["location"] == location
    assert row["discovery_suppressed_reason"] == reason


def test_public_worker_accepts_explicit_requeue_after_attempt_limit(public_db):
    conn = public_db.get_connection()
    conn.execute("UPDATE jobs SET enrichment_status = 'blocked', enrichment_attempts = 99")
    conn.execute("UPDATE jobs SET status = 'applied' WHERE id = 2")
    conn.execute("UPDATE jobs SET apply_type = 'easy_apply' WHERE id = 3")
    conn.execute("UPDATE jobs SET ats_type = 'unsupported' WHERE id = 4")
    conn.commit()
    conn.close()
    assert public_db.count_ready_public_employer_jobs() == 0
    for job_id in range(1, 5):
        assert public_db.requeue_job(job_id) == (1 if job_id == 1 else 0)
    assert public_db.bulk_requeue_jobs_by_ids([1, 2, 3, 4]) == 1
    assert public_db.count_ready_public_employer_jobs() == 1
    claimed = public_db.claim_public_employer_job()
    assert claimed["id"] == 1 and claimed["enrichment_attempts"] == 100
    assert public_db.claim_public_employer_job() is None
    # Manual requeue allows one attempt, not an unlimited automatic retry loop.
    conn = public_db.get_connection()
    conn.execute("UPDATE jobs SET enrichment_status = 'blocked' WHERE id = 1")
    conn.commit()
    conn.close()
    assert public_db.count_ready_public_employer_jobs() == 0


def test_custom_greenhouse_discovery_retains_board_evidence_for_existing_jobs(
    monkeypatch, tmp_path
):
    from hunter import db
    from hunter.discovery_sources import _job, discover_company_career_site

    monkeypatch.setenv("HUNT_DB_URL", "")
    monkeypatch.setattr(db, "DB_PATH", str(tmp_path / "custom-greenhouse.db"))
    db.init_db(maintenance=False)
    external = "https://careers.example.com/job?gh_jid=1234"
    canonical = "https://job-boards.greenhouse.io/example/jobs/1234"
    old = {
        **_job(
            title="IT Support",
            company="Example",
            location="Canada",
            url=external,
            source="employer_greenhouse",
        ),
        "ats_type": "greenhouse",
    }
    _, identity = db.add_job(old)
    row = {
        "id": 1234,
        "title": "IT Support",
        "absolute_url": external,
        "location": {"name": "Toronto, Canada"},
        "content": "Support Canadian office networks and computers with the internal service desk.",
    }
    payload = json.dumps({"jobs": [row]})
    discovered, health = discover_company_career_site(
        "Example", "https://job-boards.greenhouse.io/example", fetcher=lambda _: payload
    )
    assert health["status"] == "ok"
    assert discovered[0]["job_url"] == canonical and discovered[0]["apply_url"] == external
    assert db.add_job(discovered[0])[1] == identity

    def verifier(job):
        assert canonical in job["source_urls"] and external in job["source_urls"]
        return verify_public_posting(
            job,
            fetcher=lambda url: (
                payload
                if url == "https://boards-api.greenhouse.io/v1/boards/example/jobs?content=true"
                else "<p>No static board link</p>"
            ),
        )

    assert process_public_verification_batch(limit=1, verifier=verifier)["verified"] == 1
    assert db.get_job_by_id(identity)["enrichment_status"] == "done"
    assert db.get_job_by_id(identity)["apply_url"] == external
    assert db.add_job(discovered[0])[1] == identity and len(db.get_all_jobs()) == 1
    with pytest.raises(ValueError, match="public_provider_ambiguous"):
        verify_public_posting(
            {**old, "source_urls": [canonical, canonical.replace("/example/", "/other/")]}
        )


def test_verified_custom_domain_keeps_original_posting_identity(public_db):
    from hunter.discovery_sources import _job

    original = "https://job-boards.greenhouse.io/embed/job_app?for=example&token=1234"
    candidate = _job(
        title="IT Support", company="Example", location="Canada", url=original, source="jobright"
    )
    _, job_id = public_db.add_job(candidate)
    public_db.mark_job_enrichment_succeeded(
        job_id,
        **{
            **verification_result(candidate),
            "ats_type": "greenhouse",
            "apply_url": "https://example.com/jobs?gh_jid=1234",
            "apply_host": "example.com",
        },
    )
    public_db.update_job_status(job_id, "applied")
    standard = {
        **candidate,
        "job_url": "https://boards.greenhouse.io/example/jobs/1234",
        "apply_url": "https://boards.greenhouse.io/example/jobs/1234",
        "source": "employer_greenhouse",
    }
    assert public_db.add_job(standard)[1] == job_id
    assert public_db.get_job_by_id(job_id)["status"] == "applied"
    # Retain this match even after the current primary URL has moved to a board observation.
    connection = public_db.get_connection()
    connection.execute(
        "UPDATE jobs SET job_url = ? WHERE id = ?",
        ("https://ca.indeed.com/viewjob?jk=1234", job_id),
    )
    connection.commit()
    connection.close()
    assert public_db.add_job(standard)[1] == job_id
    other = {
        **standard,
        "job_url": standard["job_url"].replace("1234", "5678"),
        "apply_url": standard["apply_url"].replace("1234", "5678"),
    }
    assert public_db.add_job(other)[0] == "inserted"


@pytest.mark.parametrize("path", ["matching", "statuses", "error_codes"])
def test_bulk_public_requeue_preserves_ineligible_rows(public_db, path):
    from backend.db import bulk_requeue_jobs_matching_review_filters

    conn = public_db.get_connection()
    conn.execute(
        "UPDATE jobs SET enrichment_status = 'failed', last_enrichment_error = 'rate_limited: test'"
    )
    conn.execute("UPDATE jobs SET status = 'applied' WHERE id = 2")
    conn.execute("UPDATE jobs SET apply_type = 'easy_apply' WHERE id = 3")
    conn.execute("UPDATE jobs SET ats_type = 'unsupported' WHERE id = 4")
    conn.commit()
    conn.close()
    if path == "matching":
        kwargs = {"status": "all", "target_statuses": ["failed"], "limit_cap": 10}
        assert bulk_requeue_jobs_matching_review_filters(**kwargs, dry_run=True) == 1
        assert public_db.get_job_by_id(1)["enrichment_status"] == "failed"
        count = bulk_requeue_jobs_matching_review_filters(**kwargs)
    elif path == "statuses":
        count = public_db.requeue_enrichment_rows(statuses=["failed"])
    else:
        count = public_db.requeue_enrichment_rows_by_error_codes(error_codes=["rate_limited"])
    assert count == 1
    assert public_db.get_job_by_id(1)["enrichment_status"] == "pending"
    for job_id in (2, 3, 4):
        assert public_db.get_job_by_id(job_id)["enrichment_status"] == "failed"


def test_public_worker_claim_retry_and_history_preservation(public_db):
    conn = public_db.get_connection()
    conn.execute("UPDATE jobs SET status = 'applied' WHERE id = 1")
    conn.execute("UPDATE jobs SET apply_type = 'easy_apply' WHERE id = 2")
    conn.commit()
    conn.close()
    claimed = public_db.claim_public_employer_job()
    assert claimed["id"] == 3
    assert public_db.claim_public_employer_job()["id"] == 4
    assert public_db.claim_public_employer_job() is None
    # Only this claim may finish; an obsolete claim cannot change the row.
    assert (
        public_db.mark_job_enrichment_succeeded(
            3,
            **verification_result(claimed),
            source=claimed["source"],
            expected_started_at="2000-01-01 00:00:00",
        )
        == 0
    )
    assert (
        public_db.mark_job_enrichment_succeeded(
            3,
            **verification_result(claimed),
            source=claimed["source"],
            expected_started_at=claimed["last_enrichment_started_at"],
        )
        == 1
    )
    assert public_db.get_job_by_id(3)["enrichment_status"] == "done"
    assert public_db.get_job_by_id(1)["status"] == "applied"
    assert public_db.get_job_by_id(2)["apply_type"] == "easy_apply"


def test_public_worker_defers_failures_and_does_not_overwrite_new_history(public_db):
    summary = process_public_verification_batch(limit=1, verifier=Mock(side_effect=TimeoutError()))
    assert summary["attempted"] == summary["failed"] == summary["actionable_failed"] == 1
    assert summary["verified"] == summary["superseded"] == 0
    assert summary["failure_breakdown"] == {"TimeoutError": 1}
    assert public_db.get_job_by_id(1)["next_enrichment_retry_at"] is not None

    def concurrent_owner_change(job):
        public_db.update_job_status(job["id"], "applied")
        return verification_result(job)

    summary = process_public_verification_batch(limit=1, verifier=concurrent_owner_change)
    assert summary["superseded"] == 1
    assert public_db.get_job_by_id(2)["status"] == "applied"
    assert public_db.get_job_by_id(2)["auto_apply_eligible"] == 0
    summary = process_public_verification_batch(limit=None, verifier=verification_result)
    assert summary["verified"] == 2


def test_stale_final_attempt_is_recovered_but_active_claim_is_not(public_db):
    conn = public_db.get_connection()
    conn.execute(
        "UPDATE jobs SET enrichment_status='processing', enrichment_attempts=4, last_enrichment_started_at='2000-01-01 00:00:00' WHERE id=1"
    )
    conn.commit()
    conn.close()
    claimed = public_db.claim_public_employer_job()
    assert claimed["id"] == 1 and claimed["enrichment_attempts"] == 5
    assert public_db.claim_public_employer_job()["id"] == 2


def test_dispatch_shares_enrichment_limit_and_reports_public_failures(public_db, monkeypatch):
    from hunter import enrichment_dispatch as dispatch
    from hunter import verify_public

    monkeypatch.setattr(dispatch, "C1Logger", Mock())
    monkeypatch.setattr(dispatch, "_maybe_alert_high_failure_rate", Mock())
    monkeypatch.setattr(dispatch, "ENRICHMENT_SOURCE_PRIORITY", ("indeed",))
    monkeypatch.setattr(dispatch, "count_ready_jobs_for_enrichment", Mock(return_value=10))
    summary = {
        "attempted": 3,
        "verified": 2,
        "failed": 1,
        "superseded": 0,
        "actionable_failed": 1,
        "failure_breakdown": {"http403": 1},
    }
    public = Mock(return_value=summary)
    board = Mock(
        return_value={
            "attempted": 2,
            "ui_verified": 0,
            "succeeded": 2,
            "failed": 0,
            "actionable_failed": 0,
            "failure_breakdown": {},
            "total_elapsed_seconds": 0,
            "stop_error_code": None,
        }
    )
    monkeypatch.setattr(verify_public, "process_public_verification_batch", public)
    monkeypatch.setattr(dispatch, "_run_batch_for_source", board)
    result = dispatch.run_enrichment_round(limit=5, return_summary=True)
    public.assert_called_once_with(limit=5)
    assert board.call_args.kwargs["source_limit"] == 2
    assert result["exit_code"] == 1
    assert result["attempted"] == 5
    assert result["succeeded"] == 4
    assert result["by_source"]["public_employer"]["verified"] == 2


def test_post_scrape_runs_when_only_public_jobs_are_ready(public_db, monkeypatch):
    from hunter import enrich_jobs, scraper

    assert public_db.count_ready_public_employer_jobs() == 4
    monkeypatch.setattr(scraper, "count_ready_jobs_for_enrichment", Mock(return_value=0))
    worker = Mock(return_value=0)
    monkeypatch.setattr(enrich_jobs, "process_multi_source_batch", worker)
    assert scraper.run_pending_job_enrichment(limit=None) == 0
    assert worker.call_args.kwargs["limit"] == 4
    worker.reset_mock()
    assert scraper.run_pending_job_enrichment(limit=0) == 0
    worker.assert_not_called()


def test_service_enrichment_processes_public_queue_without_board_auth(public_db, monkeypatch):
    from functools import partial

    from fastapi.testclient import TestClient

    from hunter import config, service, verify_public

    monkeypatch.setattr(config, "HUNT_SERVICE_TOKEN", "public-test")
    monkeypatch.setattr(
        verify_public,
        "process_public_verification_batch",
        partial(process_public_verification_batch, verifier=verification_result),
    )
    headers = {"Authorization": "Bearer public-test"}
    with TestClient(service.app) as client:
        assert client.get("/queue", headers=headers).json()["ready"] == 4
        assert client.post("/enrich", headers=headers, json={"limit": 2}).status_code == 200
        assert client.get("/queue", headers=headers).json()["ready"] == 2
        status = client.get("/status", headers=headers).json()
        assert status["queue"]["ready"] == 2
        assert status["enrich_running"] is False
    assert public_db.get_job_by_id(1)["enrichment_status"] == "done"
    assert public_db.get_job_by_id(2)["enrichment_status"] == "done"
    assert public_db.get_job_by_id(3)["enrichment_status"] == "blocked"


def test_workday_verification_requires_exact_live_requisition_and_open_application():
    job = {
        "title": "IT Support",
        "company": "Example",
        "job_url": "https://example.wd5.myworkdayjobs.com/External/job/Toronto/IT-Support_R1234",
        "apply_type": "unknown",
    }
    detail = {
        "title": "IT Support",
        "externalUrl": job["job_url"],
        "canApply": True,
        "location": "Toronto",
        "country": {"descriptor": "Canada"},
        "jobDescription": "<p>Support the internal network, computers, and software for Canadian offices.</p>",
    }
    fetch = Mock(side_effect=lambda _: json.dumps({"jobPostingInfo": detail}))
    curated = {**job, "source": "simplify_internships", "title": "Short feed title"}
    assert verify_workday_posting(curated, fetcher=fetch)["title"] == detail["title"]
    with pytest.raises(ValueError, match="identity_mismatch"):
        verify_workday_posting(
            curated,
            fetcher=lambda _: json.dumps(
                {
                    "jobPostingInfo": {
                        **detail,
                        "externalUrl": job["job_url"].replace("R1234", "R4321"),
                    }
                }
            ),
        )
    result = verify_workday_posting(job, fetcher=fetch)
    assert result["auto_apply_eligible"] is True
    assert result["apply_type"] == "external_apply"
    assert "<p>" not in result["description"]
    assert result["location"] == "Toronto, Canada"
    assert (
        fetch.call_args.args[0]
        == "https://example.wd5.myworkdayjobs.com/wday/cxs/example/External/job/Toronto/IT-Support_R1234"
    )
    # Aggregators lowercase the board name; Workday accepts both and publishes its casing.
    assert (
        verify_workday_posting(
            {**job, "job_url": job["job_url"].replace("/External/", "/external/")}, fetcher=fetch
        )["apply_url"]
        == detail["externalUrl"]
    )
    for field, value, error in (
        ("canApply", False, "job_removed"),
        ("canApply", None, "availability_unknown"),
        ("externalUrl", job["job_url"].replace("R1234", "R4321"), "identity_mismatch"),
        ("externalUrl", job["job_url"].replace("/External/", "/Internal/"), "identity_mismatch"),
        ("title", "Different job", "identity_mismatch"),
        ("jobDescription", "", "description_not_found"),
    ):
        altered = {**detail, field: value}
        with pytest.raises(ValueError, match=error):
            verify_workday_posting(job, fetcher=lambda _: json.dumps({"jobPostingInfo": altered}))
    denied = Mock()
    with pytest.raises(ValueError, match="easy_apply_ineligible"):
        verify_workday_posting({**job, "apply_type": "easy_apply"}, fetcher=denied)
    denied.assert_not_called()


@pytest.mark.parametrize("provider", ["greenhouse", "lever", "ashby"])
def test_catalog_verification_requires_live_exact_posting(provider):
    urls = {
        "greenhouse": "https://job-boards.greenhouse.io/example/jobs/1234",
        "lever": "https://jobs.lever.co/example/12345678-abcd",
        "ashby": "https://jobs.ashbyhq.com/example/12345678-abcd",
    }
    url = urls[provider]
    title_field = "text" if provider == "lever" else "title"
    url_field = {"greenhouse": "absolute_url", "lever": "hostedUrl", "ashby": "jobUrl"}[provider]
    row = {
        title_field: "IT Support",
        url_field: url,
        "applyUrl": url + ("/apply" if provider == "lever" else "/application"),
        "content": "&lt;p&gt;Support Canadian office networks and computers with the internal service desk.&lt;/p&gt;",
        "descriptionPlain": "Support Canadian office networks and computers with the internal service desk.",
        "lists": [{"text": "Requirements", "content": "<li>Network troubleshooting</li>"}],
        "additionalPlain": "Accommodation available",
        "categories": {"location": "Toronto, Canada"},
        "location": {"name": "Toronto, Canada"} if provider == "greenhouse" else "Toronto, Canada",
    }
    job = {"job_url": url, "title": "IT Support", "company": "Example"}

    def fetch(rows):
        return lambda _: json.dumps(rows if provider == "lever" else {"jobs": rows})

    curated = {**job, "title": "Shortened feed title", "source": "simplify_internships"}
    authoritative = verify_public_posting(curated, fetcher=fetch([row]))
    assert authoritative["title"] == row[title_field]
    with pytest.raises(ValueError, match="job_removed"):
        verify_public_posting(curated, fetcher=fetch([{**row, url_field: url + "-wrong"}]))
    with pytest.raises(ValueError, match="identity_mismatch"):
        verify_public_posting(curated, fetcher=fetch([{**row, title_field: ""}]))
    result = verify_public_posting(job, fetcher=fetch([row]))
    assert result["ats_type"] == provider
    assert result["location"] == "Toronto, Canada"
    assert result["auto_apply_eligible"] is True
    assert "<p>" not in result["description"]
    if provider == "lever":
        assert "Network troubleshooting" in result["description"]
        assert "Accommodation available" in result["description"]
    for rows, error in (
        ([], "job_removed"),
        ([{**row, "isListed": False}], "job_removed"),
        ([row, row], "identity_mismatch"),
        ([{**row, title_field: "Another role"}], "identity_mismatch"),
        ([None], "invalid_employer_catalog"),
    ):
        with pytest.raises(ValueError, match=error):
            verify_public_posting(job, fetcher=fetch(rows))
    with pytest.raises(ValueError, match="easy_apply"):
        verify_public_posting({**job, "apply_type": "easy_apply"}, fetcher=Mock())


def test_greenhouse_embedded_posting_matches_catalog_id_on_custom_domain():
    job = {
        "job_url": "https://job-boards.greenhouse.io/embed/job_app?for=example&token=1234",
        "title": "IT Support",
        "company": "Example",
    }
    row = {
        "id": 1234,
        "title": "IT Support",
        "absolute_url": "https://example.com/jobs?gh_jid=1234",
        "content": "Support Canadian office networks and computers with the internal service desk.",
    }
    fetcher = Mock(return_value=json.dumps({"jobs": [row]}))
    result = verify_public_posting(job, fetcher=fetcher)
    assert result["apply_url"] == row["absolute_url"]
    fetcher.assert_called_once_with(
        "https://boards-api.greenhouse.io/v1/boards/example/jobs?content=true"
    )
    fetcher.reset_mock()
    assert verify_public_posting({**job, **result}, fetcher=fetcher) == result
    fetcher.assert_called_once_with(
        "https://boards-api.greenhouse.io/v1/boards/example/jobs?content=true"
    )
    for changed, error in (
        ({"id": 5678}, "job_removed"),
        ({"title": "Another role"}, "identity_mismatch"),
        ({"absolute_url": "javascript:alert(1)"}, "identity_mismatch"),
    ):
        with pytest.raises(ValueError, match=error):
            verify_public_posting(job, fetcher=lambda _: json.dumps({"jobs": [{**row, **changed}]}))


def test_lever_eu_catalog_discovery_and_verification():
    from hunter.discovery_sources import discover_company_career_site

    url = "https://jobs.eu.lever.co/example/12345678-abcd"
    row = {
        "text": "IT Support",
        "hostedUrl": url,
        "applyUrl": url + "/apply",
        "categories": {"location": "Toronto, Canada"},
        "descriptionPlain": "Support Canadian office networks and computers with the internal service desk.",
    }
    fetcher = Mock(return_value=json.dumps([row]))
    jobs, health = discover_company_career_site("Example", url, fetcher=fetcher)
    assert health["status"] == "ok" and len(jobs) == 1
    result = verify_public_posting(jobs[0], fetcher=fetcher)
    assert result["apply_url"] == row["applyUrl"] and result["location"] == "Toronto, Canada"
    assert all(
        call.args == ("https://api.eu.lever.co/v0/postings/example?mode=json",)
        for call in fetcher.call_args_list
    )


def test_batch_reuses_only_its_own_live_catalog_snapshot(public_db, monkeypatch):
    from hunter import verify_public
    from hunter.discovery_sources import _job

    conn = public_db.get_connection()
    conn.execute("UPDATE jobs SET status='applied'")
    conn.commit()
    conn.close()
    rows = []
    for index in (1, 2):
        url = f"https://jobs.lever.co/example/12345678-{index}"
        public_db.add_job(
            _job(
                title="IT Support",
                company="Example",
                location="Canada",
                url=url,
                source="employer_lever",
            )
        )
        rows.append(
            {
                "text": "IT Support",
                "hostedUrl": url,
                "applyUrl": url + "/apply",
                "descriptionPlain": "Support Canadian office networks and computers with the internal service desk.",
            }
        )
    fetcher = Mock(return_value=json.dumps(rows))
    monkeypatch.setattr(verify_public, "fetch_text", fetcher)
    assert public_db.count_ready_public_employer_jobs() == 2
    assert process_public_verification_batch(limit=2)["verified"] == 2
    assert fetcher.call_count == 1
    assert public_db.count_ready_public_employer_jobs() == 0


def test_greenhouse_custom_domain_requires_published_board_and_exact_catalog_match():
    job = {
        "job_url": "https://careers.example.com/jobs/support?gh_jid=1234",
        "title": "IT Support",
        "company": "Example",
        "ats_type": "greenhouse",
    }
    row = {
        "title": "IT Support",
        "absolute_url": job["job_url"],
        "content": "Support Canadian office networks and computers with the internal service desk.",
    }
    responses = {
        job[
            "job_url"
        ]: '<iframe src="https://app.greenhouse.io/embed/job_app?for=example&amp;token=1234"></iframe>',
        "https://boards-api.greenhouse.io/v1/boards/example/jobs?content=true": json.dumps(
            {"jobs": [row]}
        ),
    }
    assert verify_public_posting(job, fetcher=responses.__getitem__)["ats_type"] == "greenhouse"
    responses[job["job_url"]] = "<p>No board link</p>"
    with pytest.raises(ValueError, match="provider_not_supported"):
        verify_public_posting(job, fetcher=responses.__getitem__)


def test_closed_job_rechecks_wait_behind_new_leads_and_preserve_application_history(public_db):
    connection = public_db.get_connection()
    connection.execute(
        "UPDATE jobs SET enrichment_status='done', enriched_at='2000-01-01 00:00:00', enrichment_attempts=9 WHERE id IN (1, 2, 3)"
    )
    connection.execute("UPDATE jobs SET status='applied' WHERE id=2")
    connection.execute("UPDATE jobs SET enriched_at=CURRENT_TIMESTAMP WHERE id=3")
    connection.commit()
    connection.close()
    assert public_db.count_ready_public_employer_jobs() == 2
    assert public_db.claim_public_employer_job()["id"] == 4
    recheck = public_db.claim_public_employer_job()
    assert recheck["id"] == 1 and recheck["enrichment_attempts"] == 1
    assert public_db.claim_public_employer_job() is None


@pytest.mark.parametrize("error", ["job_removed", "easy_apply_ineligible"])
def test_public_terminal_outcomes_are_not_actionable_failures(public_db, error):
    summary = process_public_verification_batch(
        limit=1, verifier=Mock(side_effect=ValueError(error))
    )
    assert summary["failed"] == 1
    assert summary["actionable_failed"] == 0
    assert summary["failure_breakdown"] == {error: 1}
    row = public_db.get_job_by_id(1)
    assert row["enrichment_status"] == "failed"
    assert row["next_enrichment_retry_at"] is None
    assert not row["auto_apply_eligible"]


def test_verified_title_replaces_feed_label_and_reassesses_eligibility(public_db):
    claimed = public_db.claim_public_employer_job()
    result = {**verification_result(claimed), "title": "Senior Software Engineer"}
    assert (
        public_db.mark_job_enrichment_succeeded(
            claimed["id"],
            **result,
            source=claimed["source"],
            expected_started_at=claimed["last_enrichment_started_at"],
        )
        == 1
    )
    saved = public_db.get_job_by_id(claimed["id"])
    assert saved["title"] == "Senior Software Engineer"
    assert saved["discovery_suppressed_reason"]


def test_disabled_bulk_limits_preserve_jobs(public_db, monkeypatch):
    from hunter import config

    monkeypatch.setattr(config, "REVIEW_BULK_SELECTED_MAX", 0)
    monkeypatch.setattr(config, "REVIEW_BULK_DELETE_MAX", 0)
    before = public_db.get_job_by_id(1)
    assert public_db.bulk_requeue_jobs_by_ids([1]) == 0
    assert public_db.set_enrichment_status_for_job_ids([1], enrichment_status="done") == 0
    assert public_db.delete_jobs_by_ids([1]) == 0
    assert public_db.get_job_by_id(1) == before


def test_public_queue_prioritizes_matching_leads_and_reports_waiting_groups(public_db):
    with public_db.get_connection() as conn:
        conn.execute(
            "UPDATE jobs SET discovery_suppressed_reason='outside_search_lanes' WHERE id IN (1,2,3)"
        )
        conn.execute("UPDATE jobs SET date_scraped='2000-01-01 00:00:00' WHERE id=1")
    health = public_db.public_verification_health()
    assert sum(r["count"] for r in health["ready_groups"]) == 1
    assert not any(r["oldest_discovered_at"].startswith("2000") for r in health["ready_groups"])
    assert public_db.claim_public_employer_job()["id"] == 4
    assert public_db.claim_public_employer_job() is None
