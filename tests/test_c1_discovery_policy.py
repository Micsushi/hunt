import json
import tempfile
from datetime import UTC, datetime
from pathlib import Path
from unittest import mock

from hunter import db, discovery_policy
from hunter.discovery_policy import (
    annotate_job,
    canonical_job_key,
    classify_career_stage,
    is_canadian_location,
    normalize_company,
    normalize_job_url,
    priority_tier,
)
from hunter.discovery_sources import (
    career_fetch_plan,
    discover_company_career_site,
    parse_markdown_feed,
    parse_simplify_feed,
)
from hunter.search_lanes import title_matches_search_lane


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


def test_policy_normalizes_identity_stage_and_priority():
    assert normalize_company("Royal Bank of Canada") == "rbc"
    assert (
        normalize_job_url("https://www.example.com/jobs/42?utm_source=x&gh_jid=42")
        == "https://www.example.com/jobs/42?gh_jid=42"
    )
    assert (
        canonical_job_key("https://boards.greenhouse.io/acme/jobs/42?gh_jid=42", "Acme")
        == "greenhouse:acme:42"
    )
    assert classify_career_stage("Staff Software Engineer") == "experienced_excluded"
    assert classify_career_stage("Software Developer") == "unstated_stretch"
    assert priority_tier("New Grad Software Engineer") == "P1"
    assert priority_tier("Data Analyst Intern") == "P2"
    assert (
        annotate_job(job("https://example.test/1", "https://linkedin.com/jobs/1"))[
            "discovery_suppressed_reason"
        ]
        == "linkedin_only_apply_path"
    )


def test_query_identity_and_canadian_geography():
    first = "https://ca.indeed.com/viewjob?jk=abc123"
    second = "https://ca.indeed.com/viewjob?jk=def456"
    assert canonical_job_key(first) != canonical_job_key(second)
    assert canonical_job_key(first + "&utm_source=feed") == canonical_job_key(first)
    for location in ("Remote - United States", "Remote - UK"):
        assert not is_canadian_location(location)
        assert (
            annotate_job({**job(first, first), "location": location})["discovery_suppressed_reason"]
            == "outside_canada"
        )
    for location in ("Remote - Canada", "Toronto, ON", "Vancouver, BC"):
        assert is_canadian_location(location)
    assert (
        annotate_job({**job(first, first), "location": "Remote"})["discovery_suppressed_reason"]
        == "geography_unverified"
    )


def test_new_configured_role_titles_survive_lane_filter():
    for title in (
        "Project Coordinator",
        "Implementation Specialist",
        "Solutions Engineer",
        "Technical Customer Success",
    ):
        assert title_matches_search_lane(title, "product")
    for title in ("Business Analyst", "Operations Analyst"):
        assert title_matches_search_lane(title, "data")


def test_lever_title_and_geographic_filter():
    payload = json.dumps(
        [
            {
                "text": "Software Engineer Intern",
                "hostedUrl": "https://jobs.lever.co/acme/123",
                "categories": {"location": "Toronto, ON"},
            },
            {
                "text": "Software Engineer Intern",
                "hostedUrl": "https://jobs.lever.co/acme/456",
                "categories": {"location": "Remote - United States"},
            },
        ]
    )
    jobs, health = discover_company_career_site(
        "Acme",
        "https://jobs.lever.co/acme",
        fetcher=lambda _: payload,
    )
    assert health["status"] == "ok"
    assert len(jobs) == 1
    assert jobs[0]["title"] == "Software Engineer Intern"


def test_greenhouse_equivalent_hosts_and_query_identity():
    links = [
        "https://boards.greenhouse.io/acme/jobs/12345678",
        "https://job-boards.greenhouse.io/acme/jobs/12345678?gh_jid=12345678",
        "https://boards.greenhouse.io/acme/jobs/12345678?utm_source=linkedin",
        "https://boards.greenhouse.io/acme?gh_jid=12345678",
    ]
    assert len({canonical_job_key(link, "Acme") for link in links}) == 1
    assert canonical_job_key(links[0], "Acme") != canonical_job_key(
        links[0].replace("acme", "other"), "Other"
    )


def test_geography_does_not_treat_ordinary_words_as_provinces():
    for location in (
        "Remote on US East Coast",
        "On site - New York",
        "on-site USA",
        "Berlin, Germany",
        "ON SITE - New York",
        "Vancouver, WA",
        "Ontario, CA",
        "Amsterdam, NL",
        "Lima, PE",
        "Toronto, ON, USA",
    ):
        assert not is_canadian_location(location)
    for location in (
        "Toronto",
        "Vancouver",
        "Montreal",
        "Ottawa",
        "Toronto, ON",
        "Remote - Canada",
        "St. John's, NL",
        "Charlottetown, PE",
        "Newfoundland",
        "Prince Edward Island",
        "Toronto, ON, CA",
        "Montréal, QC, CA",
        "Charlottetown, PE, CA",
        "St. John's, NL, CA",
    ):
        assert is_canadian_location(location)


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


def test_iso_employer_dates_participate_in_month_cap():
    payload = json.dumps(
        {
            "jobs": [
                {
                    "title": "Junior Software Engineer",
                    "absolute_url": f"https://boards.greenhouse.io/acme/jobs/{index}",
                    "location": {"name": "Toronto"},
                    "updated_at": "2026-09-20T12:30:00Z",
                }
                for index in range(3)
            ]
        }
    )
    jobs, _ = discover_company_career_site(
        "Acme", "https://boards.greenhouse.io/acme", fetcher=lambda _: payload
    )
    assert all(row["date_posted"] == "2026-09-20" for row in jobs)
    with (
        tempfile.TemporaryDirectory() as directory,
        mock.patch.object(db, "DB_PATH", str(Path(directory) / "hunt.db")),
    ):
        db.init_db(maintenance=False)
        for row in jobs:
            db.add_job(row)
        assert (
            sum(
                row["discovery_suppressed_reason"] == "employer_month_cap"
                for row in db.get_all_jobs()
            )
            == 1
        )


def test_enrichment_refreshes_identity_before_next_source_observation():
    direct = "https://acme.wd5.myworkdayjobs.com/job/Toronto/Developer_REQ12345"
    with (
        tempfile.TemporaryDirectory() as directory,
        mock.patch.object(db, "DB_PATH", str(Path(directory) / "hunt.db")),
    ):
        db.init_db(maintenance=False)
        original = {
            **job("https://linkedin.com/jobs/view/123", None),
            "source": "linkedin",
            "apply_type": "unknown",
            "auto_apply_eligible": None,
            "enrichment_status": "pending",
        }
        _, job_id = db.add_job(original)
        assert (
            db.mark_job_enrichment_succeeded(
                job_id,
                description="Full description",
                apply_type="external_apply",
                auto_apply_eligible=True,
                apply_url=direct,
                apply_host="acme.wd5.myworkdayjobs.com",
                ats_type="workday",
            )
            == 1
        )
        assert db.add_job(job(direct, direct))[1] == job_id
        assert len(db.get_all_jobs()) == 1
        assert db.get_job_by_id(job_id)["source_count"] == 2


def test_migration_applies_suppression_once_and_indexes_identity():
    with (
        tempfile.TemporaryDirectory() as directory,
        mock.patch.object(db, "DB_PATH", str(Path(directory) / "hunt.db")),
    ):
        db.init_db(maintenance=False)
        _, job_id = db.add_job(
            job(
                "https://example.test/senior",
                "https://example.test/senior",
                title="Senior Engineer",
            )
        )
        conn = db.get_connection()
        conn.execute(
            "UPDATE jobs SET discovery_suppressed_reason = NULL, discovery_policy_version = NULL WHERE id = ?",
            (job_id,),
        )
        conn.commit()
        conn.close()
        db.init_db(maintenance=False)
        assert db.get_job_by_id(job_id)["discovery_suppressed_reason"] == "experienced_title"
        conn = db.get_connection()
        indexes = {row[1] for row in conn.execute("PRAGMA index_list(jobs)").fetchall()}
        conn.close()
        assert {
            "idx_jobs_canonical",
            "idx_jobs_employer_month",
            "idx_jobs_discovery_version",
        } <= indexes
        with mock.patch.object(db, "annotate_job", side_effect=AssertionError("already migrated")):
            db.init_db(maintenance=False)


def test_readiness_excludes_watchlist_and_unverified_jobs():
    with (
        tempfile.TemporaryDirectory() as directory,
        mock.patch.object(db, "DB_PATH", str(Path(directory) / "hunt.db")),
    ):
        db.init_db(maintenance=False)
        candidate = {
            **job("https://example.test/1", "https://acme.wd5.myworkdayjobs.com/job/1"),
            "ats_type": "workday",
        }
        _, job_id = db.add_job(candidate)
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


def test_terminal_operator_status_excludes_c3_readiness():
    with (
        tempfile.TemporaryDirectory() as directory,
        mock.patch.object(db, "DB_PATH", str(Path(directory) / "hunt.db")),
    ):
        db.init_db(maintenance=False)
        candidate = {
            **job("https://example.test/1", "https://acme.wd5.myworkdayjobs.com/job/1"),
            "ats_type": "workday",
        }
        _, job_id = db.add_job(candidate)
        db.update_selected_resume_for_job(job_id, version_id="v1", pdf_path="C:/private/resume.pdf")
        assert db.get_apply_context_for_job(job_id)["c3_ready"]
        for status in ("applied", "canceled", "cancelled"):
            db.update_job_status(job_id, status)
            assert not db.get_apply_context_for_job(job_id)["c3_ready"]
            assert db.list_c3_ready_jobs() == []


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


def test_unknown_remote_leads_are_retained_but_suppressed():
    now = int(datetime.now(UTC).timestamp())
    raw = json.dumps(
        [
            {
                "active": True,
                "date_posted": now,
                "locations": ["Remote"],
                "url": "https://example.test/jobs/1",
                "title": "Developer Intern",
                "company_name": "Acme",
            }
        ]
    )
    simplify = parse_simplify_feed(raw, "feed", hours_old=24)
    month_day = datetime.now(UTC).strftime("%b %d")
    markdown = parse_markdown_feed(
        f"| Acme | Developer Intern | Remote | [Apply](https://example.test/jobs/1) | {month_day} |",
        "feed",
        hours_old=24,
    )
    employer, _ = discover_company_career_site(
        "Acme",
        "https://jobs.lever.co/acme",
        fetcher=lambda _: json.dumps(
            [
                {
                    "text": "Developer Intern",
                    "hostedUrl": "https://example.test/jobs/1",
                    "categories": {"location": "Remote"},
                }
            ]
        ),
    )
    for rows in (simplify, markdown, employer):
        assert len(rows) == 1
        assert rows[0]["discovery_suppressed_reason"] == "geography_unverified"
        assert rows[0]["enrichment_status"] == "blocked"
        assert not rows[0]["auto_apply_eligible"]


def test_distinct_indeed_jobs_remain_distinct_in_database():
    with (
        tempfile.TemporaryDirectory() as directory,
        mock.patch.object(db, "DB_PATH", str(Path(directory) / "hunt.db")),
    ):
        db.init_db(maintenance=False)
        for identity in ("abc123", "def456"):
            candidate = job(f"https://ca.indeed.com/viewjob?jk={identity}", None)
            assert db.add_job(candidate)[0] == "inserted"
        assert len(db.get_all_jobs()) == 2


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


def test_c3_gate_and_factual_outcome_are_explicit():
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


def test_feed_and_company_adapters_keep_only_recent_canadian_rows():
    now = int(datetime.now(UTC).timestamp())
    raw = json.dumps(
        [
            {
                "active": True,
                "date_posted": now,
                "locations": ["Toronto, ON"],
                "url": "https://example.test/jobs/1",
                "title": "Developer Intern",
                "company_name": "Acme",
            },
            {
                "active": True,
                "date_posted": now,
                "locations": ["New York, NY"],
                "url": "https://example.test/jobs/2",
                "title": "Developer Intern",
                "company_name": "Acme",
            },
        ]
    )
    assert len(parse_simplify_feed(raw, "feed", hours_old=24)) == 1
    month_day = datetime.now(UTC).strftime("%b %d")
    markdown = (
        "| Company | Role | Location | Application/Link | Date Posted |\n"
        f'| Acme | Developer Intern | Toronto, ON | <a href="https://example.test/jobs/3">Apply</a> | {month_day} |'
    )
    assert len(parse_markdown_feed(markdown, "feed", hours_old=24)) == 1
    assert career_fetch_plan("https://boards.greenhouse.io/acme")["method"] == "greenhouse"

    greenhouse = json.dumps(
        {
            "jobs": [
                {
                    "title": "QA Intern",
                    "absolute_url": "https://boards.greenhouse.io/acme/jobs/12345678",
                    "location": {"name": "Remote - Canada"},
                    "content": "Test",
                },
                {
                    "title": "QA Intern",
                    "absolute_url": "https://boards.greenhouse.io/acme/jobs/99999999",
                    "location": {"name": "United States"},
                },
            ]
        }
    )
    jobs, health = discover_company_career_site(
        "Acme", "https://boards.greenhouse.io/acme", fetcher=lambda _url: greenhouse
    )
    assert len(jobs) == 1
    assert health["status"] == "ok"
