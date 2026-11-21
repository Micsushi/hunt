import json
import tempfile
from datetime import UTC, datetime
from pathlib import Path
from unittest import mock

import pytest

from hunter import db, discovery_policy
from hunter.discovery_policy import (
    annotate_job,
    canonical_job_key,
    normalize_job_url,
)
from hunter.discovery_sources import (
    discover_company_career_site,
)


@pytest.fixture(autouse=True)
def fixed_policy_clock(monkeypatch):
    monkeypatch.setattr(db, "utc_now", lambda: datetime(2026, 10, 4, tzinfo=UTC))


def job(url, apply_url, *, title="Junior Software Engineer", date="2026-09-20"):
    return {
        "title": title,
        "company": "Royal Bank of Canada",
        "location": "Toronto, ON, Canada",
        "job_url": url,
        "apply_url": apply_url,
        "description": "Build software.",
        "source": "feed",
        "date_posted": date,
        "is_remote": False,
        "level": "junior",
        "priority": False,
        "category": "engineering",
        "apply_type": "external_apply",
        "auto_apply_eligible": True,
        "enrichment_status": "done",
        "enrichment_attempts": 0,
        "apply_host": "boards.greenhouse.io",
        "ats_type": "greenhouse",
    }


@pytest.mark.parametrize("board", ["ukg", "bmo"])
def test_policy_upgrade_deduplicates_board_aliases_and_preserves_application_history(
    monkeypatch, tmp_path, board
):
    monkeypatch.setenv("HUNT_DB_URL", "")
    monkeypatch.setattr(db, "DB_PATH", str(tmp_path / "upgrade.db"))
    db.init_db(maintenance=False)
    if board == "ukg":
        first = "https://recruiting.ultipro.ca/MAC5000MCDW/JobBoard/664818ff-3594-4bec-9f30-3394e59e19f3/OpportunityDetail?opportunityId=9cc6dbba-8ba9-4ed1-b20f-a228d8a2999c"
        second = first.replace(
            "664818ff-3594-4bec-9f30-3394e59e19f3", "7667adcc-47ae-477a-9183-0d8ef8bc0748"
        )
        company, alias, previous_version = "MDA Space", "MDA Space (students)", 6
        copy_url = "https://example.test/copy"
    else:
        first = "https://jobs.bmo.com/ca/en/job/R260027741"
        second = "https://bmo.wd3.myworkdayjobs.com/External/job/Toronto/IT-Support_R260027741"
        company, alias, previous_version = "BMO", "BMO", 5
        copy_url = second
    _, old_id = db.add_job({**job("https://example.test/old", None), "company": company})
    candidate = {**job(copy_url, second if board == "bmo" else None), "company": alias}
    _, copy_id = db.add_job(candidate)
    with db.get_connection() as conn:
        conn.execute(
            "UPDATE jobs SET job_url=?,apply_url=?,status='applied',enrichment_attempts=7 WHERE id=?",
            (first, first, old_id),
        )
        conn.execute("UPDATE jobs SET job_url=?,apply_url=? WHERE id=?", (second, second, copy_id))
        if board == "bmo":
            conn.execute(
                "UPDATE jobs SET canonical_job_key=? WHERE id=?",
                ("jobs.bmo.com/ca/en/job/r260027741", old_id),
            )
        conn.execute("UPDATE jobs SET discovery_policy_version=?", (previous_version,))
    db.init_db(maintenance=False)
    old, copy = db.get_job_by_id(old_id), db.get_job_by_id(copy_id)
    assert old["status"] == "applied" and old["enrichment_status"] == "done"
    assert old["enrichment_attempts"] == 7 and old["job_url"] == first
    assert copy["job_url"] == second and old["canonical_job_key"] == copy["canonical_job_key"]
    assert copy["discovery_suppressed_reason"] == "duplicate_canonical_job"
    assert len(db.get_all_jobs()) == 2
    if board == "bmo":
        assert db.add_job(candidate)[1] == copy_id
        assert db.get_job_by_id(copy_id)["discovery_suppressed_reason"] == "duplicate_canonical_job"


def test_public_sources_apply_preferences_and_cannot_claim_verified_readiness():
    payload = json.dumps(
        [
            {
                "text": title,
                "hostedUrl": f"https://jobs.lever.co/acme/{index}",
                "categories": {"location": "Toronto"},
            }
            for index, title in enumerate(
                ("Data Analyst Intern", "Retail Clerk", "Junior Software Engineer")
            )
        ]
    )
    with (
        mock.patch.object(discovery_policy, "WATCHLIST", ["acme"]),
        mock.patch.object(discovery_policy, "TITLE_BLACKLIST", ["software"]),
    ):
        jobs, _ = discover_company_career_site(
            "Acme", "https://jobs.lever.co/acme", fetcher=lambda _: payload
        )
    assert all(row["priority"] for row in jobs)
    assert all(
        row["enrichment_status"] == "blocked" and not row["auto_apply_eligible"] for row in jobs
    )
    assert jobs[0]["category"] == "data"
    assert jobs[1]["discovery_suppressed_reason"] == "outside_search_lanes"
    assert jobs[2]["discovery_suppressed_reason"] == "title_blacklist"


def test_later_board_observation_makes_blocked_public_lead_claimable():
    with (
        tempfile.TemporaryDirectory() as directory,
        mock.patch.object(db, "DB_PATH", str(Path(directory) / "hunt.db")),
    ):
        db.init_db(maintenance=False)
        direct = "https://boards.greenhouse.io/acme/jobs/12345678"
        public = {
            **job(direct, direct),
            "source": "employer_greenhouse",
            "enrichment_status": "blocked",
            "apply_type": "unknown",
            "auto_apply_eligible": False,
        }
        _, job_id = db.add_job(public)
        assert db.count_ready_jobs_for_enrichment(sources=["indeed"]) == 0
        board = {
            **job("https://ca.indeed.com/viewjob?jk=abc", direct),
            "source": "indeed",
            "enrichment_status": "pending",
            "apply_type": "unknown",
            "auto_apply_eligible": None,
        }
        assert db.add_job(board)[1] == job_id
        assert db.count_ready_jobs_for_enrichment(sources=["indeed"]) == 1
        assert db.get_job_by_id(job_id)["source_count"] == 2


def test_enrichment_collisions_consume_one_slot_and_never_resurrect_active_duplicates():
    for ats, direct in (
        ("greenhouse", "https://boards.greenhouse.io/acme/jobs/12345678"),
        ("workday", "https://acme.wd5.myworkdayjobs.com/job/Toronto/Developer_REQ12345"),
    ):
        with (
            tempfile.TemporaryDirectory() as directory,
            mock.patch.object(db, "DB_PATH", str(Path(directory) / "hunt.db")),
        ):
            db.init_db(maintenance=False)
            first = {
                **job(
                    "https://linkedin.com/jobs/view/123", None, title="New Grad Software Engineer"
                ),
                "source": "linkedin",
                "apply_type": "unknown",
                "auto_apply_eligible": False,
                "enrichment_status": "pending",
            }
            _, first_id = db.add_job(first)
            public = {
                **job(direct, direct, title="New Grad Software Engineer"),
                "source": "employer_greenhouse",
                "apply_type": "unknown",
                "auto_apply_eligible": False,
                "enrichment_status": "blocked",
                "ats_type": ats,
            }
            _, public_id = db.add_job(public)
            _, third_id = db.add_job(
                job(
                    "https://example.test/distinct",
                    "https://example.test/distinct",
                    title="Data Analyst Intern",
                )
            )
            assert db.get_job_by_id(third_id)["discovery_suppressed_reason"] == "employer_month_cap"
            db.mark_job_enrichment_succeeded(
                first_id,
                description="Full description",
                apply_type="external_apply",
                auto_apply_eligible=True,
                apply_url=direct,
                apply_host="example.test",
                ats_type=ats,
            )
            assert db.get_job_by_id(first_id)["discovery_suppressed_reason"] is None
            assert (
                db.get_job_by_id(public_id)["discovery_suppressed_reason"]
                == "duplicate_canonical_job"
            )
            assert db.get_job_by_id(third_id)["discovery_suppressed_reason"] is None
            # Rediscovery refreshes metadata, but cannot unsuppress the duplicate.
            db.add_job(public)
            assert (
                db.get_job_by_id(public_id)["discovery_suppressed_reason"]
                == "duplicate_canonical_job"
            )
            db.update_selected_resume_for_job(
                first_id, version_id="v1", pdf_path="C:/private/resume.pdf"
            )
            if ats == "workday":
                assert [row["id"] for row in db.list_c3_ready_jobs()] == [first_id]
            # History takes precedence and duplicate historical rows count once.
            db.update_job_status(public_id, "cancelled")
            assert (
                db.get_job_by_id(first_id)["discovery_suppressed_reason"]
                == "duplicate_canonical_job"
            )
            assert db.list_c3_ready_jobs() == []
            db.update_job_status(first_id, "applied")
            assert db.get_job_by_id(third_id)["discovery_suppressed_reason"] is None
            assert len(db.get_all_jobs()) == 3
            assert db.get_job_by_id(first_id)["source_count"] == 1
            assert db.get_job_by_id(public_id)["source_count"] == 1


def test_db_keeps_one_canonical_job_with_multiple_source_observations_and_caps_month():
    with (
        tempfile.TemporaryDirectory() as directory,
        mock.patch.object(db, "DB_PATH", str(Path(directory) / "hunt.db")),
    ):
        db.init_db(maintenance=False)
        direct = "https://boards.greenhouse.io/rbc/jobs/12345678?gh_jid=12345678"
        first = job("https://linkedin.com/jobs/view/1", direct)
        second = {**job("https://indeed.ca/viewjob?jk=2", direct), "source": "indeed"}
        assert db.add_job(first)[0] == "inserted"
        assert db.add_job(second)[0] in {"updated", "skipped"}

        conn = db.get_connection()
        try:
            assert conn.execute("SELECT COUNT(*) FROM jobs").fetchone()[0] == 1
            assert conn.execute("SELECT source_count FROM jobs").fetchone()[0] == 2
        finally:
            conn.close()

        db.add_job(
            job(
                "https://example.test/senior",
                "https://example.test/jobs/99999999",
                title="Staff New Grad Software Engineer",
            )
        )
        db.add_job(job("https://example.test/2", "https://example.test/jobs/22222222"))
        db.add_job(job("https://example.test/3", "https://example.test/jobs/33333333"))
        rows = db.get_all_jobs()
        assert sum(row["discovery_suppressed_reason"] == "employer_month_cap" for row in rows) == 1
        assert (
            next(row for row in rows if row["title"].startswith("Staff"))[
                "discovery_suppressed_reason"
            ]
            == "experienced_title"
        )

        for identity in ("abc123", "def456"):
            candidate = job(f"https://ca.indeed.com/viewjob?jk={identity}", None)
            assert db.add_job(candidate)[0] == "inserted"
        assert len(db.get_all_jobs()) == len(rows) + 2


def test_c3_eligibility_and_factual_outcome_follow_job_history():
    with (
        tempfile.TemporaryDirectory() as directory,
        mock.patch.object(db, "DB_PATH", str(Path(directory) / "hunt.db")),
    ):
        db.init_db(maintenance=False)
        candidate = job(
            "https://example.test/1",
            "https://acme.wd5.myworkdayjobs.com/job/Toronto/Developer_REQ12345",
        )
        candidate.update(ats_type="workday", apply_host="acme.wd5.myworkdayjobs.com")
        _, job_id = db.add_job(candidate)
        assert db.list_c3_ready_jobs() == []
        db.update_selected_resume_for_job(job_id, version_id="v1", pdf_path="C:/private/resume.pdf")
        for priority, status, expected in (
            (0, "pending", False),
            (1, "done", False),
            (0, "done_verified", True),
        ):
            conn = db.get_connection()
            conn.execute(
                "UPDATE jobs SET priority = ?, enrichment_status = ? WHERE id = ?",
                (priority, status, job_id),
            )
            conn.commit()
            conn.close()
            assert bool(db.list_c3_ready_jobs()) is expected
            assert db.get_apply_context_for_job(job_id)["c3_ready"] is expected
        assert [row["id"] for row in db.list_c3_ready_jobs()] == [job_id]
        assert (
            db.record_c3_outcome(job_id, outcome="ready_for_review", reason="review_page_reached")
            == 1
        )
        try:
            db.record_c3_outcome(job_id, outcome="blocked", reason="contains personal prose")
        except ValueError:
            pass
        else:
            raise AssertionError("C3 outcome prose must be rejected")
        assert db.get_apply_context_for_job(job_id)["c3_outcome"] == "ready_for_review"
        for status in ("applied", "canceled", "cancelled"):
            db.update_job_status(job_id, status)
            assert not db.get_apply_context_for_job(job_id)["c3_ready"]
            assert db.list_c3_ready_jobs() == []


def test_configurable_geography_and_non_technical_eligibility(monkeypatch):
    from hunter import config
    from hunter.discovery_policy import geography_suppression

    monkeypatch.setattr(config, "DISCOVERY_COUNTRIES", ["United Kingdom", "United States"])
    monkeypatch.setattr(config, "SEARCH_TERMS", {"healthcare": ["nurse", "pharmacist"]})
    monkeypatch.setattr(config, "CAREER_STAGES", ["experienced"])
    monkeypatch.setattr(config, "EMPLOYMENT_TYPES", ["FULL_TIME"])
    monkeypatch.setattr(config, "REMOTE_ONLY", True)
    assert geography_suppression("London, United Kingdom") is None
    assert geography_suppression("Boston, MA, US") is None
    assert geography_suppression("Toronto, Canada") == "outside_search_geography"
    assert geography_suppression("Remote") == "geography_unverified"
    job = {
        "title": "Senior Nurse",
        "location": "United Kingdom",
        "employment_type": "FULL_TIME;PART_TIME",
        "is_remote": True,
    }
    assert annotate_job(job)["discovery_suppressed_reason"] is None
    assert (
        annotate_job({**job, "employment_type": None})["discovery_suppressed_reason"]
        == "employment_type_unverified"
    )
    assert (
        annotate_job({**job, "employment_type": "CONTRACTOR"})["discovery_suppressed_reason"]
        == "employment_type_excluded"
    )
    assert (
        annotate_job({**job, "is_remote": None})["discovery_suppressed_reason"]
        == "remote_work_unverified"
    )
    monkeypatch.setattr(config, "DISCOVERY_COUNTRIES", [])
    assert geography_suppression("Berlin, Germany") is None


def test_url_identity_preserves_case_and_normalizes_only_default_ports():

    assert canonical_job_key("https://example.com/JobA") != canonical_job_key(
        "https://example.com/joba"
    )
    assert normalize_job_url("https://example.com:443/JobA") == "https://example.com/JobA"
    assert normalize_job_url("http://[::1]:8080/jobs") == "http://[::1]:8080/jobs"
    assert normalize_job_url("https://example.com:invalid/jobs") is None
    assert normalize_job_url("https://secret@example.com/jobs") is None


def test_month_cap_releases_history_on_startup_without_losing_other_exclusions(
    monkeypatch, tmp_path
):
    monkeypatch.setenv("HUNT_DB_URL", "")
    monkeypatch.setattr(db, "DB_PATH", str(tmp_path / "retention.db"))
    db.init_db(maintenance=False)
    ids = []
    for i in range(3):
        _, identity = db.add_job(
            job(f"https://example.test/{i}", f"https://example.test/{i}", date="2026-09-20")
        )
        ids.append(identity)
    assert (
        sum(r["discovery_suppressed_reason"] == "employer_month_cap" for r in db.get_all_jobs())
        == 1
    )
    db.update_job_status(ids[2], "applied")
    monkeypatch.setattr(db, "utc_now", lambda: datetime(2026, 10, 21, tzinfo=UTC))
    db.init_db(maintenance=False)
    assert all(r["discovery_suppressed_reason"] is None for r in db.get_all_jobs())
    assert db.get_job_by_id(ids[2])["status"] == "applied"
    _, duplicate_id = db.add_job(
        job("https://example.test/copy", "https://example.test/2", date="2026-09-20")
    )
    assert db.get_job_by_id(duplicate_id)["status"] == "applied"
