import json
import os
import tempfile
import unittest
from unittest import mock

from hunter import (  # type: ignore
    config,
    db,
    enrich_indeed,
    enrich_linkedin,
    enrichment_dispatch,
    failure_artifacts,
    scraper,
)
from hunter.c1_logging import C1Logger  # type: ignore
from hunter.db import get_review_queue_summary, get_runtime_state, init_db  # type: ignore


class HunterLoggingIntegrationTests(unittest.TestCase):
    def _read_runtime_event(self, summary, key):
        payload = summary["events"][key]["value"]
        return json.loads(payload)

    def _read_runtime_state_key(self, key):
        payload = get_runtime_state([key])[key]["value"]
        return json.loads(payload)

    def test_c1_logger_writes_runtime_state_event_visible_in_summary(self):
        with tempfile.TemporaryDirectory() as tmp:
            db_path = os.path.join(tmp, "hunt.db")
            artifacts_dir = os.path.join(tmp, "artifacts")
            os.makedirs(artifacts_dir, exist_ok=True)

            with mock.patch.dict(
                os.environ,
                {
                    "HUNT_DB_PATH": db_path,
                    "HUNT_ARTIFACTS_DIR": artifacts_dir,
                },
                clear=False,
            ):
                old_db_path = db.DB_PATH
                db.DB_PATH = db_path
                self.addCleanup(setattr, db, "DB_PATH", old_db_path)
                init_db()
                C1Logger(discord=False).event(
                    key="linkedin_last_rate_limited",
                    level="warn",
                    message="TEST: rate limited",
                    code="rate_limited",
                    details={"account_index": 0, "blocked_days": 1},
                )
                summary = get_review_queue_summary()
                self.assertIn("events", summary)
                parsed = self._read_runtime_event(summary, "linkedin_last_rate_limited")
                self.assertEqual(parsed["code"], "rate_limited")
                self.assertEqual(parsed["message"], "TEST: rate limited")

    def test_scrape_logs_start_and_end_events(self):
        with tempfile.TemporaryDirectory() as tmp:
            db_path = os.path.join(tmp, "hunt.db")
            artifacts_dir = os.path.join(tmp, "artifacts")
            os.makedirs(artifacts_dir, exist_ok=True)

            job_data = {
                "title": "Software Engineer",
                "company": "Acme",
                "location": "Remote",
                "job_url": "https://example.com/jobs/1",
                "apply_url": "https://apply.example.com/jobs/1",
                "description": "desc",
                "source": "indeed",
                "date_posted": "2026-05-01",
                "is_remote": 1,
                "level": "junior",
                "priority": 0,
                "category": "engineering",
                "apply_type": "unknown",
                "auto_apply_eligible": None,
                "enrichment_status": "pending",
                "enrichment_attempts": 0,
                "apply_host": "apply.example.com",
                "ats_type": "workday",
            }

            with mock.patch.dict(
                os.environ,
                {
                    "HUNT_DB_PATH": db_path,
                    "HUNT_ARTIFACTS_DIR": artifacts_dir,
                },
                clear=False,
            ):
                old_db_path = db.DB_PATH
                db.DB_PATH = db_path
                self.addCleanup(setattr, db, "DB_PATH", old_db_path)
                init_db()
                with (
                    mock.patch.object(scraper, "SEARCH_TERMS", {"engineering": ["python"]}),
                    mock.patch.object(scraper, "LOCATIONS", ["Remote"]),
                    mock.patch.object(scraper, "SITES", ["indeed"]),
                    mock.patch.object(scraper, "MAX_WORKERS", 1),
                    mock.patch.object(scraper, "scrape_single", return_value=[job_data]),
                    mock.patch.object(scraper, "add_job", return_value=("inserted", 1)),
                    mock.patch.object(scraper, "_notify_priority_jobs", return_value=None),
                    mock.patch.object(scraper, "run_pending_linkedin_enrichment", return_value=0),
                ):
                    summary = scraper.scrape(enrich_pending=True, enrich_limit=5)

                start_event = self._read_runtime_state_key("hunt_last_scrape_start")
                end_event = self._read_runtime_state_key("hunt_last_scrape_end")

                self.assertEqual(start_event["code"], "scrape_started")
                self.assertEqual(start_event["details"]["task_count"], 1)
                self.assertTrue(start_event["details"]["enrich_pending"])
                self.assertEqual(end_event["code"], "scrape_finished")
                self.assertEqual(end_event["details"], summary)

    def test_enrichment_round_logs_summary_event(self):
        with tempfile.TemporaryDirectory() as tmp:
            db_path = os.path.join(tmp, "hunt.db")
            artifacts_dir = os.path.join(tmp, "artifacts")
            os.makedirs(artifacts_dir, exist_ok=True)

            batch_summary = {
                "exit_code": 1,
                "attempted": 2,
                "ui_verified": 0,
                "succeeded": 1,
                "failed": 1,
                "actionable_failed": 1,
                "failure_breakdown": {"rate_limited": 1},
                "total_elapsed_seconds": 12.5,
                "average_seconds_per_job": 6.25,
                "stop_error_code": "rate_limited",
            }

            with mock.patch.dict(
                os.environ,
                {
                    "HUNT_DB_PATH": db_path,
                    "HUNT_ARTIFACTS_DIR": artifacts_dir,
                },
                clear=False,
            ):
                old_db_path = db.DB_PATH
                db.DB_PATH = db_path
                self.addCleanup(setattr, db, "DB_PATH", old_db_path)
                init_db()

                def fake_ready_count(*, sources=None):
                    if sources == ("linkedin",):
                        return 0
                    if sources == ("indeed",):
                        return 2
                    return 0

                with (
                    mock.patch.object(
                        enrichment_dispatch,
                        "count_ready_jobs_for_enrichment",
                        side_effect=fake_ready_count,
                    ),
                    mock.patch.object(
                        enrichment_dispatch, "_run_batch_for_source", return_value=batch_summary
                    ),
                ):
                    result = enrichment_dispatch.run_enrichment_round(limit=4, return_summary=True)

                event = self._read_runtime_state_key("hunt_last_enrich_summary")
                self.assertEqual(event["code"], "enrichment_round_summary")
                self.assertEqual(event["level"], "warn")
                self.assertEqual(event["details"]["attempted"], 2)
                self.assertEqual(event["details"]["failure_breakdown"], {"rate_limited": 1})
                self.assertEqual(event["details"]["by_source"]["indeed"], batch_summary)
                self.assertEqual(result["attempted"], 2)

    def test_enrichment_round_logs_high_failure_rate_alert(self):
        with tempfile.TemporaryDirectory() as tmp:
            db_path = os.path.join(tmp, "hunt.db")
            artifacts_dir = os.path.join(tmp, "artifacts")
            os.makedirs(artifacts_dir, exist_ok=True)

            batch_summary = {
                "exit_code": 1,
                "attempted": 5,
                "ui_verified": 0,
                "succeeded": 2,
                "failed": 3,
                "actionable_failed": 3,
                "failure_breakdown": {"rate_limited": 2, "description_not_found": 1},
                "total_elapsed_seconds": 20.0,
                "average_seconds_per_job": 4.0,
                "stop_error_code": "rate_limited",
            }

            with mock.patch.dict(
                os.environ,
                {
                    "HUNT_DB_PATH": db_path,
                    "HUNT_ARTIFACTS_DIR": artifacts_dir,
                },
                clear=False,
            ):
                old_db_path = db.DB_PATH
                db.DB_PATH = db_path
                self.addCleanup(setattr, db, "DB_PATH", old_db_path)
                init_db()

                def fake_ready_count(*, sources=None):
                    if sources == ("indeed",):
                        return 5
                    return 0

                with (
                    mock.patch.object(
                        enrichment_dispatch,
                        "ENRICHMENT_ALERT_MIN_ATTEMPTS",
                        3,
                    ),
                    mock.patch.object(
                        enrichment_dispatch,
                        "ENRICHMENT_ALERT_FAILURE_RATE_PERCENT",
                        50,
                    ),
                    mock.patch.object(
                        enrichment_dispatch,
                        "count_ready_jobs_for_enrichment",
                        side_effect=fake_ready_count,
                    ),
                    mock.patch.object(
                        enrichment_dispatch, "_run_batch_for_source", return_value=batch_summary
                    ),
                ):
                    enrichment_dispatch.run_enrichment_round(limit=5, return_summary=True)

                event = self._read_runtime_state_key("hunt_last_high_failure_alert")
                self.assertEqual(event["code"], "high_failure_rate")
                self.assertEqual(event["details"]["attempted"], 5)
                self.assertEqual(event["details"]["actionable_failed"], 3)
                self.assertEqual(event["details"]["failure_rate_percent"], 60.0)

    def test_capture_text_artifacts_logs_artifact_write_event(self):
        with tempfile.TemporaryDirectory() as tmp:
            db_path = os.path.join(tmp, "hunt.db")
            artifacts_dir = os.path.join(tmp, "artifacts")
            os.makedirs(artifacts_dir, exist_ok=True)

            with mock.patch.dict(
                os.environ,
                {
                    "HUNT_DB_PATH": db_path,
                    "HUNT_ARTIFACTS_DIR": artifacts_dir,
                },
                clear=False,
            ):
                old_db_path = db.DB_PATH
                db.DB_PATH = db_path
                self.addCleanup(setattr, db, "DB_PATH", old_db_path)
                init_db()
                paths = failure_artifacts.capture_text_artifacts(
                    {
                        "id": 42,
                        "source": "indeed",
                        "company": "Acme",
                        "title": "Role",
                        "job_url": "https://example.com/jobs/42",
                    },
                    "rate_limited",
                    html_content="<html><body>blocked</body></html>",
                    text_content="blocked",
                )
                event = self._read_runtime_state_key("hunt_last_artifact_write")

                self.assertEqual(event["code"], "artifact_written")
                self.assertEqual(event["details"]["job_id"], 42)
                self.assertEqual(event["details"]["artifact_dir"], paths["artifact_dir"])
                self.assertEqual(
                    event["details"]["artifact_html_path"], paths["artifact_html_path"]
                )

    def test_retry_exhaustion_logs_event_for_indeed(self):
        with tempfile.TemporaryDirectory() as tmp:
            db_path = os.path.join(tmp, "hunt.db")
            artifacts_dir = os.path.join(tmp, "artifacts")
            os.makedirs(artifacts_dir, exist_ok=True)

            claimed_job = {
                "id": 9,
                "company": "Acme",
                "title": "Role",
                "enrichment_attempts": config.ENRICHMENT_MAX_ATTEMPTS,
            }

            with mock.patch.dict(
                os.environ,
                {
                    "HUNT_DB_PATH": db_path,
                    "HUNT_ARTIFACTS_DIR": artifacts_dir,
                },
                clear=False,
            ):
                old_db_path = db.DB_PATH
                db.DB_PATH = db_path
                self.addCleanup(setattr, db, "DB_PATH", old_db_path)
                init_db()
                with (
                    mock.patch.object(
                        enrich_indeed,
                        "enrich_indeed_job",
                        side_effect=enrich_indeed.IndeedEnrichmentError(
                            "rate_limited", "Try again later."
                        ),
                    ),
                    mock.patch.object(enrich_indeed, "mark_job_enrichment_failed", return_value=1),
                ):
                    result = enrich_indeed._process_claimed_job(claimed_job, timeout_ms=1000)

                event = self._read_runtime_state_key("hunt_last_retry_exhausted")
                self.assertEqual(event["code"], "retry_exhausted")
                self.assertEqual(event["details"]["job_id"], 9)
                self.assertEqual(event["details"]["source"], "indeed")
                self.assertEqual(result["status"], "failed")

    def test_retry_exhaustion_logs_event_for_linkedin(self):
        with tempfile.TemporaryDirectory() as tmp:
            db_path = os.path.join(tmp, "hunt.db")
            artifacts_dir = os.path.join(tmp, "artifacts")
            os.makedirs(artifacts_dir, exist_ok=True)

            claimed_job = {
                "id": 10,
                "company": "Acme",
                "title": "Role",
                "enrichment_attempts": config.ENRICHMENT_MAX_ATTEMPTS,
            }

            with mock.patch.dict(
                os.environ,
                {
                    "HUNT_DB_PATH": db_path,
                    "HUNT_ARTIFACTS_DIR": artifacts_dir,
                },
                clear=False,
            ):
                old_db_path = db.DB_PATH
                db.DB_PATH = db_path
                self.addCleanup(setattr, db, "DB_PATH", old_db_path)
                init_db()
                with (
                    mock.patch.object(
                        enrich_linkedin,
                        "enrich_claimed_linkedin_job",
                        side_effect=enrich_linkedin.LinkedInEnrichmentError(
                            "rate_limited", "Try again later."
                        ),
                    ),
                    mock.patch.object(
                        enrich_linkedin, "mark_linkedin_enrichment_failed", return_value=1
                    ),
                ):
                    result = enrich_linkedin.process_claimed_job(claimed_job, timeout_ms=1000)

                event = self._read_runtime_state_key("hunt_last_retry_exhausted")
                self.assertEqual(event["code"], "retry_exhausted")
                self.assertEqual(event["details"]["job_id"], 10)
                self.assertEqual(event["details"]["source"], "linkedin")
                self.assertEqual(result["status"], "failed")
