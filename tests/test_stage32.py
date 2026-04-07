import os
import sqlite3
import sys
import tempfile
import unittest
from contextlib import contextmanager
from datetime import timedelta
from unittest.mock import patch


REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SCRAPER_DIR = os.path.join(REPO_ROOT, "scraper")
sys.path.insert(0, SCRAPER_DIR)

import db
import enrich_indeed
import enrich_jobs
import scraper as scraper_module
from enrichment_policy import format_sqlite_timestamp, utc_now


class FakeResponse:
    def __init__(self, *, text="", url="", status_code=200):
        self.text = text
        self.url = url
        self.status_code = status_code


class FakeSession:
    def __init__(self, responses):
        self.responses = responses
        self.headers = {}

    def get(self, url, timeout=None, allow_redirects=True):
        return self.responses[url]


class Stage32Tests(unittest.TestCase):
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

    def insert_job(self, path, **overrides):
        defaults = {
            "title": "Software Engineer",
            "company": "Acme",
            "location": "Canada",
            "job_url": "https://example.com/job/1",
            "apply_url": None,
            "description": None,
            "source": "indeed",
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

    def test_scrape_single_marks_indeed_rows_pending_for_stage32_enrichment(self):
        import pandas as pd

        jobs_df = pd.DataFrame(
            [
                {
                    "title": "Data Scientist",
                    "company": "Acme",
                    "location": "Canada",
                    "job_url": "https://ca.indeed.com/viewjob?jk=123",
                    "job_url_direct": "https://jobs.acme.com/123",
                    "description": "Feed description",
                    "site": "indeed",
                    "date_posted": "2026-04-04",
                    "is_remote": True,
                }
            ]
        )

        with patch.object(scraper_module, "scrape_jobs", return_value=jobs_df):
            jobs = scraper_module.scrape_single("indeed", "data scientist", "Canada", "data")

        self.assertEqual(len(jobs), 1)
        self.assertEqual(jobs[0]["source"], "indeed")
        self.assertEqual(jobs[0]["apply_type"], "unknown")
        self.assertEqual(jobs[0]["enrichment_status"], "pending")

    def test_init_db_backfills_indeed_rows_to_pending(self):
        path = self.make_temp_db_path()
        old_db_path = db.DB_PATH
        try:
            db.DB_PATH = path
            db.init_db()
            conn = sqlite3.connect(path)
            conn.execute(
                """
                INSERT INTO jobs (
                    title, company, location, job_url, source, apply_type, enrichment_status
                ) VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    "Data Scientist",
                    "Acme",
                    "Canada",
                    "https://ca.indeed.com/viewjob?jk=111",
                    "indeed",
                    None,
                    None,
                ),
            )
            conn.commit()
            conn.close()

            db.init_db()
            row = db.get_job_by_id(1)
            self.assertEqual(row["apply_type"], "unknown")
            self.assertEqual(row["enrichment_status"], "pending")
        finally:
            db.DB_PATH = old_db_path
            if os.path.exists(path):
                os.remove(path)

    def test_claim_job_for_enrichment_prefers_linkedin_before_indeed(self):
        with self.with_temp_db() as path:
            linkedin_id = self.insert_job(
                path,
                source="linkedin",
                job_url="https://www.linkedin.com/jobs/view/1",
                date_posted="2026-04-05",
            )
            indeed_id = self.insert_job(
                path,
                source="indeed",
                job_url="https://ca.indeed.com/viewjob?jk=222",
            )

            claimed = db.claim_job_for_enrichment()

            self.assertIsNotNone(claimed)
            self.assertEqual(claimed["id"], linkedin_id)
            self.assertNotEqual(claimed["id"], indeed_id)

    def test_claim_job_for_enrichment_skips_linkedin_when_auth_is_paused(self):
        with self.with_temp_db() as path:
            self.insert_job(
                path,
                source="linkedin",
                job_url="https://www.linkedin.com/jobs/view/2",
                date_posted="2026-04-05",
            )
            indeed_id = self.insert_job(
                path,
                source="indeed",
                job_url="https://ca.indeed.com/viewjob?jk=333",
            )

            db.mark_linkedin_auth_unavailable("auth_expired: LinkedIn session appears to be logged out or expired.")

            claimed = db.claim_job_for_enrichment()

            self.assertIsNotNone(claimed)
            self.assertEqual(claimed["id"], indeed_id)

    def test_indeed_enrichment_extracts_description_and_apply_url(self):
        page_url = "https://ca.indeed.com/viewjob?jk=123"
        redirect_url = "https://ca.indeed.com/applystart?jk=123"
        html = """
        <html><head>
        <script type="application/ld+json">
        {"@type":"JobPosting","description":"<p>Build data pipelines and dashboards.</p>"}
        </script>
        </head>
        <body>
          <a data-testid="apply-button" href="/applystart?jk=123">Apply now</a>
        </body></html>
        """
        session = FakeSession(
            {
                page_url: FakeResponse(text=html, url=page_url, status_code=200),
                redirect_url: FakeResponse(
                    text="redirected",
                    url="https://jobs.acme.com/apply/123",
                    status_code=200,
                ),
            }
        )

        with patch.object(enrich_indeed, "_session", return_value=session):
            result = enrich_indeed.enrich_indeed_job({"job_url": page_url, "apply_url": None}, timeout_ms=1000)

        self.assertEqual(result["apply_type"], "external_apply")
        self.assertEqual(result["apply_url"], "https://jobs.acme.com/apply/123")
        self.assertEqual(result["apply_host"], "jobs.acme.com")
        self.assertEqual(result["description"], "Build data pipelines and dashboards.")

    def test_indeed_process_batch_updates_rows(self):
        page_url = "https://ca.indeed.com/viewjob?jk=333"
        html = """
        <html><body>
          <div id="jobDescriptionText">
            Analyze product usage, build experiments, and partner with engineering.
          </div>
        </body></html>
        """
        session = FakeSession({page_url: FakeResponse(text=html, url=page_url, status_code=200)})

        with self.with_temp_db() as path, patch.object(enrich_indeed, "_session", return_value=session):
            job_id = self.insert_job(path, job_url=page_url, source="indeed")
            summary = enrich_indeed.process_batch(limit=1, timeout_ms=1000, return_summary=True)
            row = db.get_job_by_id(job_id)

        self.assertEqual(summary["attempted"], 1)
        self.assertEqual(summary["succeeded"], 1)
        self.assertEqual(row["enrichment_status"], "done")
        self.assertTrue(row["description"].startswith("Analyze product usage"))

    def test_indeed_ui_verify_marks_row_done_verified(self):
        @contextmanager
        def fake_browser_context(**_kwargs):
            yield object()

        with self.with_temp_db() as path:
            job_id = self.insert_job(
                path,
                source="indeed",
                job_url="https://ca.indeed.com/viewjob?jk=555",
            )
            with patch.object(enrich_indeed, "open_browser_context", fake_browser_context), patch.object(
                enrich_indeed,
                "enrich_indeed_job_in_context",
                return_value={
                    "description": "Browser-rendered description with enough detail to be valid.",
                    "apply_url": "https://jobs.acme.com/apply/555",
                    "apply_type": "external_apply",
                    "auto_apply_eligible": 1,
                    "apply_host": "jobs.acme.com",
                    "ats_type": "unknown",
                },
            ):
                exit_code = enrich_indeed.process_one_job(
                    job_id=job_id,
                    timeout_ms=1000,
                    force=True,
                    ui_verify=True,
                )
                row = db.get_job_by_id(job_id)

        self.assertEqual(exit_code, 0)
        self.assertEqual(row["enrichment_status"], "done_verified")
        self.assertEqual(row["apply_type"], "external_apply")
        self.assertEqual(row["last_enrichment_error"], None)

    def test_indeed_ui_verify_browser_launch_failure_does_not_leave_processing(self):
        with self.with_temp_db() as path:
            job_id = self.insert_job(
                path,
                source="indeed",
                job_url="https://ca.indeed.com/viewjob?jk=556",
            )
            with patch.object(enrich_indeed, "open_browser_context", side_effect=enrich_indeed.BrowserRuntimeError("Missing X server")):
                exit_code = enrich_indeed.process_one_job(
                    job_id=job_id,
                    timeout_ms=1000,
                    force=True,
                    ui_verify=True,
                )
                row = db.get_job_by_id(job_id)

        self.assertEqual(exit_code, 1)
        self.assertNotEqual(row["enrichment_status"], "processing")
        self.assertEqual(row["enrichment_status"], "failed")
        self.assertIn("browser_unavailable", row["last_enrichment_error"])

    def test_indeed_enrichment_reuses_existing_description_when_page_parse_misses(self):
        page_url = "https://ca.indeed.com/viewjob?jk=444"
        html = """
        <html><body>
          <div class="job-card">This page exposes metadata and an external apply link.</div>
          <a data-testid="apply-button" href="https://jobs.acme.com/apply/444">Apply now</a>
        </body></html>
        """
        existing_description = (
            "This role owns pipeline automation, reporting, cross-functional collaboration, "
            "stakeholder updates, forecasting, and customer-facing process improvement."
        )
        session = FakeSession({page_url: FakeResponse(text=html, url=page_url, status_code=200)})

        with patch.object(enrich_indeed, "_session", return_value=session):
            result = enrich_indeed.enrich_indeed_job(
                {
                    "job_url": page_url,
                    "apply_url": "https://jobs.acme.com/apply/444",
                    "description": existing_description,
                },
                timeout_ms=1000,
            )

        self.assertEqual(result["description"], existing_description)
        self.assertEqual(result["apply_type"], "external_apply")
        self.assertEqual(result["apply_url"], "https://jobs.acme.com/apply/444")

    def test_process_multi_source_batch_dispatches_across_sources(self):
        with patch.object(enrich_jobs, "process_linkedin_batch", return_value={
            "exit_code": 0,
            "attempted": 1,
            "ui_verified": 0,
            "succeeded": 1,
            "failed": 0,
            "actionable_failed": 0,
            "failure_breakdown": {},
            "total_elapsed_seconds": 1.0,
            "average_seconds_per_job": 1.0,
            "stop_error_code": None,
        }) as mock_linkedin, patch.object(enrich_jobs, "process_indeed_batch", return_value={
            "exit_code": 0,
            "attempted": 1,
            "ui_verified": 0,
            "succeeded": 1,
            "failed": 0,
            "actionable_failed": 0,
            "failure_breakdown": {},
            "total_elapsed_seconds": 1.0,
            "average_seconds_per_job": 1.0,
            "stop_error_code": None,
        }) as mock_indeed, patch.object(enrich_jobs, "count_ready_jobs_for_enrichment") as mock_count:
            mock_count.side_effect = lambda sources=None: 1
            summary = enrich_jobs.process_multi_source_batch(limit=2, return_summary=True)

        self.assertEqual(summary["attempted"], 2)
        self.assertIn("linkedin", summary["by_source"])
        self.assertIn("indeed", summary["by_source"])
        mock_linkedin.assert_called_once()
        mock_indeed.assert_called_once()

    def test_review_queue_summary_includes_source_counts(self):
        with self.with_temp_db() as path:
            self.insert_job(path, source="linkedin", job_url="https://www.linkedin.com/jobs/view/55")
            self.insert_job(path, source="indeed", job_url="https://ca.indeed.com/viewjob?jk=55")

            summary = db.get_review_queue_summary()

        self.assertEqual(summary["source_counts"]["linkedin"], 1)
        self.assertEqual(summary["source_counts"]["indeed"], 1)

    def test_generic_retry_backfill_applies_to_indeed_failures(self):
        with self.with_temp_db() as path:
            job_id = self.insert_job(
                path,
                source="indeed",
                enrichment_status="failed",
                enrichment_attempts=1,
                last_enrichment_error="description_not_found: missing content",
                next_enrichment_retry_at=None,
            )

            db.init_db()
            row = db.get_job_by_id(job_id)

        self.assertIsNotNone(row["next_enrichment_retry_at"])


if __name__ == "__main__":
    unittest.main()
