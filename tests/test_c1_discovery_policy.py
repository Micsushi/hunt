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


def test_policy_normalizes_identity_stage_and_priority():
    assert normalize_company("Royal Bank of Canada") == "rbc"
    assert normalize_company("Canadian Imperial Bank of Commerce") == normalize_company("CIBC")
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


def test_custom_roles_do_not_inherit_technology_only_or_early_career_exclusions(monkeypatch):
    from hunter import config
    from hunter.discovery_sources import _job

    monkeypatch.setattr(config, "SEARCH_TERMS", {"food": ["quality assurance"]})
    monkeypatch.setattr(config, "INCLUDE_EXPERIENCED_ROLES", True)
    result = _job(
        title="Senior Quality Assurance Specialist",
        company="New employer",
        location="Canada",
        url="https://example.test/jobs/1",
        source="employer_structured",
        description="Check food safety at the fresh produce factory.",
    )
    assert result["category"] == "food"
    assert result["career_stage"] == "experienced"
    assert result["discovery_suppressed_reason"] is None
    assert result["auto_apply_eligible"] is False


def test_ukg_board_aliases_share_only_the_same_tenant_and_opportunity():
    first = "https://recruiting.ultipro.ca/MAC5000MCDW/JobBoard/664818ff-3594-4bec-9f30-3394e59e19f3/OpportunityDetail?opportunityId=9cc6dbba-8ba9-4ed1-b20f-a228d8a2999c"
    other_board = first.replace(
        "664818ff-3594-4bec-9f30-3394e59e19f3", "7667adcc-47ae-477a-9183-0d8ef8bc0748"
    )
    assert canonical_job_key(first) == canonical_job_key(other_board)
    assert normalize_company("MDA Space (students)") == normalize_company("MDA Space")
    for different in (
        first.replace("MAC5000MCDW", "OTHER"),
        first.replace("ultipro.ca", "ultipro.ca.evil"),
        first.replace("a228d8a2999c", "a228d8a2999d"),
    ):
        assert canonical_job_key(first) != canonical_job_key(different)


def test_ukg_policy_upgrade_preserves_history_across_boards(monkeypatch, tmp_path):
    monkeypatch.setenv("HUNT_DB_URL", "")
    monkeypatch.setattr(db, "DB_PATH", str(tmp_path / "ukg-upgrade.db"))
    db.init_db(maintenance=False)
    first = "https://recruiting.ultipro.ca/MAC5000MCDW/JobBoard/664818ff-3594-4bec-9f30-3394e59e19f3/OpportunityDetail?opportunityId=9cc6dbba-8ba9-4ed1-b20f-a228d8a2999c"
    second = first.replace(
        "664818ff-3594-4bec-9f30-3394e59e19f3", "7667adcc-47ae-477a-9183-0d8ef8bc0748"
    )
    _, old_id = db.add_job({**job("https://example.test/old", None), "company": "MDA Space"})
    _, copy_id = db.add_job(
        {**job("https://example.test/copy", None), "company": "MDA Space (students)"}
    )
    with db.get_connection() as conn:
        conn.execute(
            "UPDATE jobs SET job_url=?,apply_url=?,status='applied',enrichment_attempts=7 WHERE id=?",
            (first, first, old_id),
        )
        conn.execute("UPDATE jobs SET job_url=?,apply_url=? WHERE id=?", (second, second, copy_id))
        conn.execute("UPDATE jobs SET discovery_policy_version=6")
    db.init_db(maintenance=False)
    old, copy = db.get_job_by_id(old_id), db.get_job_by_id(copy_id)
    assert old["status"] == "applied" and old["enrichment_attempts"] == 7
    assert old["job_url"] == first and copy["job_url"] == second
    assert old["canonical_job_key"] == copy["canonical_job_key"]
    assert copy["discovery_suppressed_reason"] == "duplicate_canonical_job"
    assert len(db.get_all_jobs()) == 2


def test_bmo_careers_and_workday_share_only_the_exact_published_requisition():
    direct = "https://bmo.wd3.myworkdayjobs.com/External/job/Toronto/IT-Support_R260027741/apply"
    for url in (
        "https://jobs.bmo.com/ca/en/job/R260027741",
        "https://jobs.bmo.com/ca/fr/job/R260027741/IT-Support",
        "https://jobs.bmo.com/us/en/job/R260027741?utm_source=test",
    ):
        assert canonical_job_key(url) == canonical_job_key(direct)
    for url in (
        "https://jobs.bmo.com/ca/en/job/R260027742",
        "https://jobs.bmo.com.evil.test/ca/en/job/R260027741",
        direct.replace("bmo.wd3", "other.wd3"),
    ):
        assert canonical_job_key(url) != canonical_job_key(direct)


def test_bmo_policy_upgrade_preserves_history_and_suppresses_existing_copy(monkeypatch, tmp_path):
    monkeypatch.setenv("HUNT_DB_URL", "")
    monkeypatch.setattr(db, "DB_PATH", str(tmp_path / "bmo-upgrade.db"))
    db.init_db(maintenance=False)
    public = "https://jobs.bmo.com/ca/en/job/R260027741"
    direct = "https://bmo.wd3.myworkdayjobs.com/External/job/Toronto/IT-Support_R260027741"
    _, old_id = db.add_job({**job("https://example.test/legacy", None), "company": "BMO"})
    candidate = {**job(direct, direct), "company": "BMO"}
    _, direct_id = db.add_job(candidate)
    # Seed the two identities retained by the previous policy version.
    with db.get_connection() as conn:
        conn.execute(
            "UPDATE jobs SET job_url=?,apply_url=?,canonical_job_key=?,status='applied',"
            "enrichment_attempts=7 WHERE id=?",
            (public, public, "jobs.bmo.com/ca/en/job/r260027741", old_id),
        )
        conn.execute("UPDATE jobs SET discovery_policy_version=5")
    db.init_db(maintenance=False)
    old, duplicate = db.get_job_by_id(old_id), db.get_job_by_id(direct_id)
    assert old["status"] == "applied" and old["enrichment_status"] == "done"
    assert old["enrichment_attempts"] == 7 and old["job_url"] == public
    assert old["canonical_job_key"] == duplicate["canonical_job_key"]
    assert duplicate["discovery_suppressed_reason"] == "duplicate_canonical_job"
    assert len(db.get_all_jobs()) == 2
    assert db.add_job(candidate)[1] == direct_id
    assert db.get_job_by_id(direct_id)["discovery_suppressed_reason"] == "duplicate_canonical_job"


def test_slovak_postcode_does_not_make_sk_a_canadian_province():
    assert not is_canadian_location("Žilina, SK, 010 01 +2 more")
    assert not is_canadian_location("Bratislava, SK, 81101")
    assert is_canadian_location("Regina, SK, S4P 0S3")
    assert is_canadian_location("Regina, SK, CA")
    assert is_canadian_location("Žilina, SK, 010 01; Toronto, ON, Canada")


def test_policy_upgrade_refreshes_old_geography_without_requeueing_history(monkeypatch, tmp_path):
    monkeypatch.setenv("HUNT_DB_URL", "")
    monkeypatch.setattr(db, "DB_PATH", str(tmp_path / "policy-upgrade.db"))
    db.init_db(maintenance=False)
    candidate = job("https://example.test/slovakia", "https://example.test/slovakia")
    candidate.update(location="Žilina, SK, 010 01", source="employer_greenhouse")
    _, job_id = db.add_job(candidate)
    with db.get_connection() as conn:
        conn.execute(
            "UPDATE jobs SET discovery_policy_version=1, discovery_suppressed_reason=NULL, "
            "status='applied', enrichment_status='done' WHERE id=?",
            (job_id,),
        )
    db.init_db(maintenance=False)
    current = db.get_job_by_id(job_id)
    assert current["discovery_suppressed_reason"] == "outside_canada"
    assert current["discovery_policy_version"] == discovery_policy.DISCOVERY_POLICY_VERSION
    assert current["status"] == "applied" and current["enrichment_status"] == "done"


def test_policy_upgrade_unifies_cibc_alias_without_requeueing_history(monkeypatch, tmp_path):
    monkeypatch.setenv("HUNT_DB_URL", "")
    monkeypatch.setattr(db, "DB_PATH", str(tmp_path / "alias-upgrade.db"))
    db.init_db(maintenance=False)
    candidate = job("https://example.test/cibc", "https://example.test/cibc")
    candidate["company"] = "Canadian Imperial Bank of Commerce"
    _, job_id = db.add_job(candidate)
    with db.get_connection() as conn:
        conn.execute(
            "UPDATE jobs SET discovery_policy_version=2, "
            "normalized_company='canadian imperial bank of commerce', "
            "status='applied', enrichment_status='done' WHERE id=?",
            (job_id,),
        )
    db.init_db(maintenance=False)
    current = db.get_job_by_id(job_id)
    assert current["normalized_company"] == "cibc"
    assert current["discovery_policy_version"] == discovery_policy.DISCOVERY_POLICY_VERSION
    assert current["status"] == "applied" and current["enrichment_status"] == "done"


def test_nontechnical_noc_and_food_qa_are_suppressed_without_hiding_software_qa():
    candidate = job("https://example.test/quality", "https://example.test/quality")
    candidate.update(
        title="Quality Assurance Specialist",
        category="quality_security",
        description="Inspect fresh produce and meat for food safety.",
    )
    assert annotate_job(candidate)["discovery_suppressed_reason"] == "outside_search_lanes"
    candidate["title"] = "Software Quality Assurance Specialist"
    assert annotate_job(candidate)["discovery_suppressed_reason"] is None
    candidate["title"] = "Hardware Quality Assurance Specialist"
    assert annotate_job(candidate)["discovery_suppressed_reason"] is None
    candidate.update(
        title="Quality Assurance Specialist",
        description="API testing and test automation for food safety systems.",
    )
    assert annotate_job(candidate)["discovery_suppressed_reason"] is None
    candidate.update(title="Quality Assurance Specialist", description=None)
    assert annotate_job(candidate)["discovery_suppressed_reason"] is None
    candidate.update(title="Cashier Full Time NOC 65100", category="it_support")
    assert annotate_job(candidate)["discovery_suppressed_reason"] == "outside_search_lanes"
    candidate["title"] = "IT Support NOC 22221"
    assert annotate_job(candidate)["discovery_suppressed_reason"] is None


def test_query_identity_and_canadian_geography():
    assert discovery_policy.geography_suppression("Hybrid or Remote") == "geography_unverified"
    assert discovery_policy.geography_suppression("Remote India") == "outside_canada"
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
        "https://job-boards.greenhouse.io/embed/job_app?for=acme&token=12345678",
        "https://app.greenhouse.io/embed/job_app?for=acme&token=12345678",
    ]
    assert len({canonical_job_key(link, "Acme") for link in links}) == 1
    assert canonical_job_key(links[0], "Acme") != canonical_job_key(
        links[0].replace("acme", "other"), "Other"
    )


def test_workable_widget_directory_and_apply_links_share_identity():
    links = [
        "https://apply.workable.com/j/76343BDD45",
        "https://apply.workable.com/nuvei/j/76343BDD45/",
        "https://apply.workable.com/j/76343BDD45/apply",
    ]
    assert {canonical_job_key(url, "Nuvei") for url in links} == {"workable:76343bdd45"}
    assert canonical_job_key(links[0].replace("76343BDD45", "76343BDD46")) != canonical_job_key(
        links[0]
    )


def test_oracle_detail_preview_and_search_tracking_share_identity():
    base = "https://example.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1"
    links = [
        base + "/job/12345",
        base + "/job/12345/?mode=location",
        base + "/jobs/preview/12345/?keyword=software",
    ]
    assert {canonical_job_key(url) for url in links} == {
        "oracle:example.fa.us2.oraclecloud.com:12345"
    }
    assert canonical_job_key(links[0].replace("12345", "12346")) != canonical_job_key(links[0])
    assert canonical_job_key(links[0].replace("example.fa", "another.fa")) != canonical_job_key(
        links[0]
    )


def test_bamboohr_careers_and_legacy_posting_share_identity():
    links = [
        "https://example.bamboohr.com/careers/123",
        "https://example.bamboohr.com/jobs/view.php?id=123",
        "https://example.bamboohr.com/careers/123?source=linkedin",
    ]
    assert {canonical_job_key(url) for url in links} == {"bamboohr:example.bamboohr.com:123"}
    assert canonical_job_key(links[0].replace("123", "124")) != canonical_job_key(links[0])


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
                    "jobUrl": f"https://jobs.ashbyhq.com/acme/{index}",
                    "location": "Toronto",
                    "publishedAt": "2026-09-20T12:30:00Z",
                }
                for index in range(3)
            ]
        }
    )
    jobs, _ = discover_company_career_site(
        "Acme", "https://jobs.ashbyhq.com/acme", fetcher=lambda _: payload
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


def test_configurable_geography_and_non_technical_eligibility(monkeypatch):
    from hunter import config
    from hunter.discovery_policy import annotate_job, geography_suppression

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
    from hunter.discovery_policy import canonical_job_key, normalize_job_url

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


def test_custom_occupation_priority_is_equal_for_selected_roles(monkeypatch):
    from hunter import config

    monkeypatch.setattr(
        config,
        "SEARCH_TERMS",
        {"healthcare": ["registered nurse"], "engineering": ["software engineer"]},
    )
    assert (
        priority_tier("Junior Registered Nurse")
        == priority_tier("Junior Software Engineer")
        == "P1"
    )
    assert priority_tier("Registered Nurse") == "P1"
    assert priority_tier("Unrelated Assistant") == "P3"
