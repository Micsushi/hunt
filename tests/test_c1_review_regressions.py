"""Regressions for the three-reviewer C1 findings."""

from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime, timedelta
from unittest.mock import Mock

import pytest
from fastapi.testclient import TestClient

from hunter import config, db, user_config
from hunter.discovery_sources import _job


@pytest.fixture
def settings(monkeypatch, tmp_path):
    path = tmp_path / "settings.json"
    monkeypatch.setenv("HUNT_USER_CONFIG_PATH", str(path))
    return path


def test_settings_patches_preserve_prior_data_across_concurrency_and_failures(
    settings, monkeypatch
):
    user_config.save({"company_career_sites": {"Example": "https://example.test"}})
    before = settings.read_bytes()
    with monkeypatch.context() as patch:
        patch.setattr(user_config.os, "replace", Mock(side_effect=OSError("disk failure")))
        with pytest.raises(OSError):
            user_config.patch({"max_workers": 3})
    assert settings.read_bytes() == before
    with ThreadPoolExecutor(max_workers=8) as workers:
        list(workers.map(lambda i: user_config.patch({f"key{i}": i}), range(20)))
    saved = user_config.load()
    assert len(saved) == 21
    assert saved["company_career_sites"]["Example"] == "https://example.test"

    for content in ('{"company_career_sites":', "[]"):
        settings.write_text(content)
        with pytest.raises(ValueError):
            user_config.patch({"max_workers": 3})
        assert settings.read_text() == content


@pytest.mark.parametrize(
    "updates",
    [
        {"max_workers": None},
        {"max_workers": 0},
        {"max_workers": -1},
        {"max_workers": 1.5},
        {"max_workers": "3"},
        {"max_workers": True},
        {"run_interval_seconds": 1},
        {"enrichment_timeout_ms": 1},
        {"enrichment_alert_failure_rate_percent": 101},
        {"enrichment_alert_cooldown_minutes": -1},
    ],
)
def test_invalid_numeric_settings_rejected_before_writing(settings, monkeypatch, updates, database):
    from hunter.service import app

    monkeypatch.setattr(config, "HUNT_SERVICE_TOKEN", "")
    with TestClient(app) as client:
        assert client.patch("/config", json=updates).status_code == 422
    assert not settings.exists()


@pytest.fixture
def database(monkeypatch, tmp_path):
    monkeypatch.setenv("HUNT_DB_URL", "")
    monkeypatch.setattr(db, "DB_PATH", str(tmp_path / "jobs.db"))
    db.init_db(maintenance=False)
    for index in range(1, 4):
        db.add_job(
            _job(
                title="Junior Software Engineer",
                company="Review Example",
                location="Toronto, Canada",
                source="employer_workday",
                date_posted=datetime.now(UTC).date().isoformat(),
                url=f"https://example.wd5.myworkdayjobs.com/External/job/Toronto/Engineer_R{index}000",
            )
        )
    return db


def test_policy_change_reclassifies_history_once_without_losing_state(database, monkeypatch):
    with db.get_connection() as conn:
        conn.execute(
            "UPDATE jobs SET status='applied', enriched_at='2026-01-01', enrichment_attempts=3 WHERE id=1"
        )
    monkeypatch.setattr(config, "COMPANY_BLOCKLIST", ["Review Example"])
    db.init_db(maintenance=False, refresh_discovery=False)
    assert db.get_job_by_id(1)["discovery_suppressed_reason"] != "company_blocklist"
    db.init_db(maintenance=False)
    row = db.get_job_by_id(1)
    assert row["discovery_suppressed_reason"] == "company_blocklist"
    assert row["status"] == "applied" and row["enrichment_attempts"] == 3
    assert str(row["enriched_at"]).startswith("2026-01-01")
    with monkeypatch.context() as patch:
        refresh = Mock(wraps=db._refresh_discovery_metadata)
        patch.setattr(db, "_refresh_discovery_metadata", refresh)
        db.init_db(maintenance=False)
        refresh.assert_not_called()
    monkeypatch.setattr(config, "COMPANY_BLOCKLIST", [])
    db.init_db(maintenance=False)
    assert db.get_job_by_id(1)["discovery_suppressed_reason"] is None


def test_removed_jobs_release_slots_immediately_but_transient_failures_do_not(database):
    rows = [db.get_job_by_id(i) for i in range(1, 4)]
    capped = next(r for r in rows if r["discovery_suppressed_reason"] == "employer_month_cap")
    active = next(r for r in rows if r["discovery_suppressed_reason"] is None)
    db.mark_job_enrichment_failed(active["id"], "http_503", enrichment_status="blocked")
    assert db.get_job_by_id(capped["id"])["discovery_suppressed_reason"] == "employer_month_cap"
    db.mark_job_enrichment_failed(active["id"], "job_removed", auto_apply_eligible=False)
    assert db.get_job_by_id(capped["id"])["discovery_suppressed_reason"] is None


def test_excluded_rechecks_stop_and_transient_exhaustion_recovers(database):
    from hunter.verify_public import process_public_verification_batch

    with db.get_connection() as conn:
        conn.execute(
            "UPDATE jobs SET enrichment_status='done', enriched_at='2000-01-01', discovery_suppressed_reason='title_blacklist'"
        )
    assert db.count_ready_public_employer_jobs() == 0
    with db.get_connection() as conn:
        conn.execute(
            "UPDATE jobs SET enrichment_status='blocked', discovery_suppressed_reason=NULL, enrichment_attempts=4, last_enrichment_error='http_503', next_enrichment_retry_at='2000-01-01' WHERE id=1"
        )
    assert db.count_ready_public_employer_jobs() == 1
    result = process_public_verification_batch(
        limit=1, verifier=Mock(side_effect=ValueError("http_503"))
    )
    assert result["failed"] == 1
    row = db.get_job_by_id(1)
    retry = datetime.fromisoformat(row["next_enrichment_retry_at"]).replace(tzinfo=UTC)
    assert retry > datetime.now(UTC) + timedelta(hours=23)
    assert db.count_ready_public_employer_jobs() == 0
    with db.get_connection() as conn:
        conn.execute("UPDATE jobs SET next_enrichment_retry_at='2000-01-01' WHERE id=1")

    def verified(job):
        return dict(
            description="Current employer description",
            apply_type="external_apply",
            auto_apply_eligible=True,
            apply_url=job["job_url"],
            apply_host="example.wd5.myworkdayjobs.com",
            ats_type="workday",
        )

    assert process_public_verification_batch(limit=1, verifier=verified)["verified"] == 1
    assert db.get_job_by_id(1)["auto_apply_eligible"] == 1
    with db.get_connection() as conn:
        conn.execute(
            "UPDATE jobs SET enrichment_status='blocked', enrichment_attempts=10, last_enrichment_error='public_posting_identity_mismatch', next_enrichment_retry_at='2000-01-01' WHERE id=1"
        )
    assert db.count_ready_public_employer_jobs() == 0


def test_jobright_cycle_continues_after_outer_scan_finishes(database, monkeypatch):
    from hunter import discovery_jobright, scraper

    monkeypatch.setattr(config, "TARGETING_CONFIGURED", False)
    monkeypatch.setattr(scraper, "SEARCH_TERMS", {"engineering": ["first", "second", "third"]})
    monkeypatch.setattr(scraper, "_discovery_due", lambda source: source == "jobright")
    calls = []

    def discover(**kwargs):
        terms = kwargs["search_terms"]["engineering"]
        calls.append(terms)
        health = [{"source": "jobright: engineering / " + terms[0], "status": "ok", "error": None}]
        if len(terms) > 1:
            health.append(
                {
                    "source": "jobright: engineering / " + terms[1],
                    "status": "rate_limited",
                    "error": "jobright_hourly_refresh_limit",
                }
            )
        kwargs["on_result"]([], health)
        return [], health

    monkeypatch.setattr(discovery_jobright, "discover_jobright", discover)
    for _ in range(4):
        db.set_runtime_state("jobright_retry_after", "")
        scraper._discover_public_sources(336, lambda *args: None, due_only=True)
    assert calls == [
        ["first", "second", "third"],
        ["second", "third"],
        ["third"],
        ["first", "second", "third"],
    ]
    monkeypatch.setattr(config, "DISCOVERY_COUNTRIES", ["United States"])
    db.set_runtime_state("jobright_retry_after", "")
    scraper._discover_public_sources(336, lambda *args: None, due_only=True)
    assert calls[-1] == ["first", "second", "third"]
