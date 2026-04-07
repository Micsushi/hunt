import os
import sqlite3
import sys
import tempfile
import unittest
from datetime import timedelta
from unittest.mock import patch


REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SCRAPER_DIR = os.path.join(REPO_ROOT, "scraper")
sys.path.insert(0, SCRAPER_DIR)

import db
import enrich_linkedin
from enrichment_policy import format_sqlite_timestamp, utc_now


class Stage3Tests(unittest.TestCase):
    def make_temp_db_path(self):
        fd, path = tempfile.mkstemp(suffix=".db")
        os.close(fd)
        return path

    def with_temp_db(self):
        class TempDbContext:
            def __init__(self, outer):
                self.outer = outer
                self.path = outer.make_temp_db_path()
                self.old_db_path = db.DB_PATH

            def __enter__(self):
                db.DB_PATH = self.path
                db.init_db()
                return self.path

            def __exit__(self, exc_type, exc, tb):
                db.DB_PATH = self.old_db_path
                if os.path.exists(self.path):
                    os.remove(self.path)

        return TempDbContext(self)

    def insert_linkedin_job(self, path, **overrides):
        defaults = {
            "title": "Software Engineer",
            "company": "Acme",
            "location": "Canada",
            "job_url": "https://www.linkedin.com/jobs/view/123",
            "apply_url": None,
            "description": None,
            "source": "linkedin",
            "date_posted": "2026-04-04",
            "is_remote": 1,
            "level": "junior",
            "priority": 0,
            "category": "engineering",
            "apply_type": "unknown",
            "auto_apply_eligible": None,
            "enrichment_status": "pending",
            "enrichment_attempts": 0,
            "apply_host": None,
            "ats_type": None,
            "last_enrichment_error": None,
            "last_enrichment_started_at": None,
            "next_enrichment_retry_at": None,
        }
        defaults.update(overrides)

        conn = sqlite3.connect(path)
        try:
            conn.execute(
                """
                INSERT INTO jobs (
                    title, company, location, job_url, apply_url, description,
                    source, date_posted, is_remote, level, priority, category,
                    apply_type, auto_apply_eligible, enrichment_status,
                    enrichment_attempts, apply_host, ats_type, last_enrichment_error,
                    last_enrichment_started_at, next_enrichment_retry_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    defaults["title"],
                    defaults["company"],
                    defaults["location"],
                    defaults["job_url"],
                    defaults["apply_url"],
                    defaults["description"],
                    defaults["source"],
                    defaults["date_posted"],
                    defaults["is_remote"],
                    defaults["level"],
                    defaults["priority"],
                    defaults["category"],
                    defaults["apply_type"],
                    defaults["auto_apply_eligible"],
                    defaults["enrichment_status"],
                    defaults["enrichment_attempts"],
                    defaults["apply_host"],
                    defaults["ats_type"],
                    defaults["last_enrichment_error"],
                    defaults["last_enrichment_started_at"],
                    defaults["next_enrichment_retry_at"],
                ),
            )
            conn.commit()
            return conn.execute("SELECT id FROM jobs WHERE job_url = ?", (defaults["job_url"],)).fetchone()[0]
        finally:
            conn.close()

    def test_init_db_requeues_stale_processing_rows(self):
        with self.with_temp_db() as path:
            job_id = self.insert_linkedin_job(
                path,
                enrichment_status="processing",
                enrichment_attempts=1,
                last_enrichment_started_at=format_sqlite_timestamp(utc_now() - timedelta(hours=2)),
            )

            db.init_db()

            row = db.get_job_by_id(job_id)
            self.assertEqual(row["enrichment_status"], "pending")
            self.assertTrue(row["last_enrichment_error"].startswith("stale_processing:"))
            self.assertIsNone(row["last_enrichment_started_at"])
            self.assertIsNone(row["next_enrichment_retry_at"])

    def test_claim_picks_due_failed_rows(self):
        with self.with_temp_db() as path:
            job_id = self.insert_linkedin_job(
                path,
                enrichment_status="failed",
                enrichment_attempts=1,
                next_enrichment_retry_at=format_sqlite_timestamp(utc_now() - timedelta(minutes=5)),
                last_enrichment_error="description_not_found: first attempt",
            )

            claimed = db.claim_linkedin_job_for_enrichment(job_id=job_id)

            self.assertIsNotNone(claimed)
            self.assertEqual(claimed["id"], job_id)
            self.assertEqual(claimed["enrichment_status"], "processing")
            self.assertEqual(claimed["enrichment_attempts"], 2)
            self.assertIsNotNone(claimed["last_enrichment_started_at"])
            self.assertIsNone(claimed["next_enrichment_retry_at"])

    def test_claim_prefers_newest_pending_rows_before_old_backlog(self):
        with self.with_temp_db() as path:
            old_id = self.insert_linkedin_job(
                path,
                job_url="https://www.linkedin.com/jobs/view/300",
                date_posted="2026-03-01",
            )
            new_id = self.insert_linkedin_job(
                path,
                job_url="https://www.linkedin.com/jobs/view/301",
                date_posted="2026-04-05",
            )

            conn = sqlite3.connect(path)
            try:
                conn.execute(
                    "UPDATE jobs SET date_scraped = '2026-04-04 00:00:00' WHERE id = ?",
                    (old_id,),
                )
                conn.execute(
                    "UPDATE jobs SET date_scraped = '2026-04-05 09:00:00' WHERE id = ?",
                    (new_id,),
                )
                conn.commit()
            finally:
                conn.close()

            claimed = db.claim_linkedin_job_for_enrichment()

            self.assertIsNotNone(claimed)
            self.assertEqual(claimed["id"], new_id)

    def test_claim_skips_failed_rows_before_retry_time(self):
        with self.with_temp_db() as path:
            job_id = self.insert_linkedin_job(
                path,
                enrichment_status="failed",
                enrichment_attempts=1,
                next_enrichment_retry_at=format_sqlite_timestamp(utc_now() + timedelta(minutes=20)),
                last_enrichment_error="description_not_found: first attempt",
            )

            claimed = db.claim_linkedin_job_for_enrichment(job_id=job_id)

            self.assertIsNone(claimed)
            row = db.get_job_by_id(job_id)
            self.assertEqual(row["enrichment_status"], "failed")

    def test_init_db_backfills_retry_schedule_for_retryable_failed_rows(self):
        with self.with_temp_db() as path:
            job_id = self.insert_linkedin_job(
                path,
                enrichment_status="failed",
                enrichment_attempts=1,
                last_enrichment_error="external_description_not_usable: thin application shell",
            )

            db.init_db()

            row = db.get_job_by_id(job_id)
            self.assertEqual(row["enrichment_status"], "failed")
            self.assertIsNotNone(row["next_enrichment_retry_at"])

    def test_init_db_without_maintenance_does_not_requeue_processing_rows(self):
        with self.with_temp_db() as path:
            job_id = self.insert_linkedin_job(
                path,
                enrichment_status="processing",
                enrichment_attempts=1,
                last_enrichment_started_at=format_sqlite_timestamp(utc_now() - timedelta(hours=2)),
            )

            db.init_db(maintenance=False)

            row = db.get_job_by_id(job_id)
            self.assertEqual(row["enrichment_status"], "processing")
            self.assertIsNotNone(row["last_enrichment_started_at"])

    def test_process_claimed_job_schedules_retry_for_retryable_failure(self):
        with self.with_temp_db() as path:
            job_id = self.insert_linkedin_job(path)
            claimed = db.claim_linkedin_job_for_enrichment(job_id=job_id)

            with patch.object(
                enrich_linkedin,
                "enrich_linkedin_job_in_context",
                side_effect=enrich_linkedin.LinkedInEnrichmentError(
                    "description_not_found",
                    "Could not extract the LinkedIn job description from the current page layout.",
                ),
            ):
                result = enrich_linkedin.process_claimed_job(
                    claimed,
                    context=object(),
                    timeout_ms=1000,
                )

            self.assertEqual(result["status"], "failed")
            row = db.get_job_by_id(job_id)
            self.assertEqual(row["enrichment_status"], "failed")
            self.assertTrue(row["last_enrichment_error"].startswith("description_not_found:"))
            self.assertIsNotNone(row["next_enrichment_retry_at"])
            self.assertIsNone(row["last_enrichment_started_at"])

    def test_process_claimed_job_pauses_auth_and_restores_row_on_auth_expired(self):
        with self.with_temp_db() as path:
            job_id = self.insert_linkedin_job(path)
            claimed = db.claim_linkedin_job_for_enrichment(job_id=job_id)

            with patch.object(
                enrich_linkedin,
                "enrich_linkedin_job_in_context",
                side_effect=enrich_linkedin.LinkedInSessionError(
                    "LinkedIn session appears to be logged out or expired."
                ),
            ):
                result = enrich_linkedin.process_claimed_job(
                    claimed,
                    context=object(),
                    timeout_ms=1000,
                )

            self.assertEqual(result["status"], "auth_paused")
            row = db.get_job_by_id(job_id)
            self.assertEqual(row["enrichment_status"], "pending")
            self.assertEqual(row["enrichment_attempts"], 0)
            self.assertIsNone(row["last_enrichment_error"])
            self.assertIsNone(row["last_enrichment_started_at"])
            auth_state = db.get_linkedin_auth_state()
            self.assertFalse(auth_state["available"])
            self.assertTrue(auth_state["last_error"].startswith("auth_expired:"))

    def test_process_claimed_job_retries_once_after_auto_relogin(self):
        with self.with_temp_db() as path:
            job_id = self.insert_linkedin_job(path)
            claimed = db.claim_linkedin_job_for_enrichment(job_id=job_id)

            with patch.object(
                enrich_linkedin,
                "enrich_linkedin_job_in_context",
                side_effect=[
                    enrich_linkedin.LinkedInSessionError(
                        "LinkedIn session appears to be logged out or expired."
                    ),
                    {
                        "description": "Recovered description",
                        "apply_type": "external_apply",
                        "auto_apply_eligible": 1,
                        "apply_url": "https://boards.greenhouse.io/acme/jobs/123",
                        "apply_host": "boards.greenhouse.io",
                        "ats_type": "greenhouse",
                    },
                ],
            ), patch.object(
                enrich_linkedin,
                "attempt_auto_relogin",
                return_value={
                    "attempted": True,
                    "recovered": True,
                    "message": "LinkedIn auto relogin signed in with stored credentials and refreshed the saved auth state.",
                },
            ) as mock_relogin:
                result = enrich_linkedin.process_claimed_job(
                    claimed,
                    context=object(),
                    timeout_ms=1000,
                )

            self.assertEqual(result["status"], "success")
            row = db.get_job_by_id(job_id)
            self.assertEqual(row["enrichment_status"], "done")
            self.assertEqual(row["apply_type"], "external_apply")

    def test_ready_count_excludes_linkedin_when_auth_is_paused(self):
        with self.with_temp_db() as path:
            self.insert_linkedin_job(
                path,
                job_url="https://www.linkedin.com/jobs/view/250",
                enrichment_status="pending",
            )

            self.assertEqual(db.count_ready_linkedin_jobs_for_enrichment(), 1)

            db.mark_linkedin_auth_unavailable("auth_expired: LinkedIn session appears to be logged out or expired.")

            self.assertEqual(db.count_ready_linkedin_jobs_for_enrichment(), 0)
            self.assertIsNone(db.claim_linkedin_job_for_enrichment())
            summary = db.get_linkedin_queue_summary()
            self.assertEqual(summary["ready_count"], 0)
            self.assertFalse(summary["auth"]["linkedin"]["available"])

            db.mark_linkedin_auth_available()

            self.assertEqual(db.count_ready_linkedin_jobs_for_enrichment(), 1)

    def test_process_batch_attempts_auto_relogin_when_auth_is_paused(self):
        with self.with_temp_db() as path:
            db.mark_linkedin_auth_unavailable("auth_expired: LinkedIn session appears to be logged out or expired.")

            def fake_relogin(**_kwargs):
                db.mark_linkedin_auth_available()
                return {
                    "attempted": True,
                    "recovered": True,
                    "message": "LinkedIn auto relogin signed in with stored credentials and refreshed the saved auth state.",
                }

            with patch.object(enrich_linkedin, "attempt_auto_relogin", side_effect=fake_relogin) as mock_relogin, \
                 patch.object(enrich_linkedin, "open_linkedin_context"), \
                 patch.object(enrich_linkedin, "claim_linkedin_job_for_enrichment", return_value=None):
                summary = enrich_linkedin.process_batch(limit=5, return_summary=True)

            self.assertEqual(mock_relogin.call_count, 1)
            self.assertEqual(summary["exit_code"], 0)
            self.assertEqual(summary["attempted"], 0)
            self.assertIsNone(summary["stop_error_code"])

    def test_queue_summary_reports_ready_and_stale_counts(self):
        with self.with_temp_db() as path:
            self.insert_linkedin_job(
                path,
                job_url="https://www.linkedin.com/jobs/view/200",
                enrichment_status="pending",
            )
            self.insert_linkedin_job(
                path,
                job_url="https://www.linkedin.com/jobs/view/201",
                enrichment_status="failed",
                enrichment_attempts=1,
                next_enrichment_retry_at=format_sqlite_timestamp(utc_now() - timedelta(minutes=1)),
            )
            self.insert_linkedin_job(
                path,
                job_url="https://www.linkedin.com/jobs/view/202",
                enrichment_status="processing",
                enrichment_attempts=1,
                last_enrichment_started_at=format_sqlite_timestamp(utc_now() - timedelta(hours=1)),
            )

            summary = db.get_linkedin_queue_summary()

            self.assertEqual(summary["pending_count"], 1)
            self.assertEqual(summary["retry_ready_count"], 1)
            self.assertEqual(summary["ready_count"], 2)
            self.assertEqual(summary["processing_count"], 1)
            self.assertEqual(summary["stale_processing_count"], 1)

    def test_process_batch_can_return_structured_summary(self):
        with patch.object(enrich_linkedin, "open_linkedin_context"), \
             patch.object(enrich_linkedin, "claim_linkedin_job_for_enrichment", return_value=None):
            summary = enrich_linkedin.process_batch(limit=5, return_summary=True)

        self.assertEqual(summary["exit_code"], 0)
        self.assertEqual(summary["attempted"], 0)
        self.assertEqual(summary["ui_verified"], 0)
        self.assertEqual(summary["succeeded"], 0)
        self.assertEqual(summary["failed"], 0)
        self.assertEqual(summary["actionable_failed"], 0)
        self.assertEqual(summary["failure_breakdown"], {})
        self.assertIsNone(summary["stop_error_code"])


if __name__ == "__main__":
    unittest.main()
