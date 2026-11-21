import os
import sqlite3
import sys
import tempfile
import unittest
from datetime import timedelta
from unittest.mock import patch

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, REPO_ROOT)

from hunter import db  # noqa: E402

try:
    from hunter import enrich_indeed
except ModuleNotFoundError:
    enrich_indeed = None
from hunter import enrich_jobs, enrichment_dispatch  # noqa: E402


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


@unittest.skipIf(enrich_indeed is None, "optional dependency missing: requests")
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
            return conn.execute(
                "SELECT id FROM jobs WHERE job_url = ?", (defaults["job_url"],)
            ).fetchone()[0]
        finally:
            conn.close()

    def test_indeed_batch_saves_new_description_and_preserves_existing_fallback(self):
        page_url = "https://ca.indeed.com/viewjob?jk=333"
        html = """
        <html><body>
          <div id="jobDescriptionText">
            Analyze product usage, build experiments, and partner with engineering.
          </div>
        </body></html>
        """
        fallback_url = "https://ca.indeed.com/viewjob?jk=444"
        fallback_html = """
        <html><body>
          <div class="job-card">This page exposes metadata and an external apply link.</div>
          <a data-testid="apply-button" href="https://jobs.acme.com/apply/444">Apply now</a>
        </body></html>
        """
        existing_description = (
            "This role owns pipeline automation, reporting, cross-functional collaboration, "
            "stakeholder updates, forecasting, and customer-facing process improvement."
        )
        session = FakeSession(
            {
                page_url: FakeResponse(text=html, url=page_url, status_code=200),
                fallback_url: FakeResponse(text=fallback_html, url=fallback_url, status_code=200),
            }
        )

        with (
            self.with_temp_db() as path,
            patch.object(enrich_indeed, "_session", return_value=session),
        ):
            job_id = self.insert_job(path, job_url=page_url, source="indeed")
            fallback_id = self.insert_job(
                path,
                source="indeed",
                job_url=fallback_url,
                apply_url="https://jobs.acme.com/apply/444",
                description=existing_description,
            )
            summary = enrich_indeed.process_batch(limit=2, timeout_ms=1000, return_summary=True)
            row = db.get_job_by_id(job_id)
            fallback = db.get_job_by_id(fallback_id)

        self.assertEqual(summary["attempted"], 2)
        self.assertEqual(summary["succeeded"], 2)
        self.assertEqual(row["enrichment_status"], "done")
        self.assertTrue(row["description"].startswith("Analyze product usage"))

        self.assertEqual(fallback["description"], existing_description)
        self.assertEqual(fallback["apply_type"], "external_apply")
        self.assertEqual(fallback["apply_url"], "https://jobs.acme.com/apply/444")

    def test_indeed_ui_verify_browser_launch_failure_does_not_leave_processing(self):
        with self.with_temp_db() as path:
            job_id = self.insert_job(
                path,
                source="indeed",
                job_url="https://ca.indeed.com/viewjob?jk=556",
            )
            with patch.object(
                enrich_indeed,
                "open_browser_context",
                side_effect=enrich_indeed.BrowserRuntimeError("Missing X server"),
            ):
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

    def test_process_multi_source_batch_skips_linkedin_without_auth_but_runs_indeed(self):
        """Indeed must not be blocked when LinkedIn auth is missing."""
        fake_hiring_cafe_summary = {
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
        }
        fake_indeed_summary = {
            "exit_code": 0,
            "attempted": 2,
            "ui_verified": 0,
            "succeeded": 2,
            "failed": 0,
            "actionable_failed": 0,
            "failure_breakdown": {},
            "total_elapsed_seconds": 2.0,
            "average_seconds_per_job": 1.0,
            "stop_error_code": None,
        }

        with (
            patch.object(
                enrichment_dispatch,
                "get_linkedin_auth_state",
                return_value={"available": False, "last_error": "auth_expired: session dead"},
            ),
            patch.object(
                enrichment_dispatch,
                "attempt_auto_relogin",
                return_value={"attempted": True, "recovered": False, "message": "relogin failed"},
            ),
            patch.object(enrichment_dispatch, "_run_linkedin_batch") as mock_linkedin_run,
            patch.object(
                enrichment_dispatch,
                "_run_hiring_cafe_linkedin_fallback",
                return_value=fake_hiring_cafe_summary,
            ) as mock_hiring_cafe_run,
            patch.object(
                enrichment_dispatch, "_run_indeed_batch", return_value=fake_indeed_summary
            ) as mock_indeed_run,
            patch.object(enrichment_dispatch, "count_ready_jobs_for_enrichment") as mock_count,
            patch.object(enrichment_dispatch, "count_ready_public_employer_jobs", return_value=0),
            patch.object(
                enrichment_dispatch,
                "count_ready_linkedin_jobs_for_hiring_cafe_fallback",
                return_value=1,
            ),
        ):
            mock_count.side_effect = lambda sources=None: 0 if sources == ("linkedin",) else 2
            summary = enrich_jobs.process_multi_source_batch(limit=3, return_summary=True)

        mock_linkedin_run.assert_not_called()
        mock_hiring_cafe_run.assert_called()
        mock_indeed_run.assert_called()
        self.assertEqual(summary["attempted"], 3)
        self.assertNotIn("linkedin", summary["by_source"])
        self.assertIn("linkedin_hiring_cafe", summary["by_source"])
        self.assertIn("indeed", summary["by_source"])
        self.assertEqual(summary["exit_code"], 0)

    def test_hiring_cafe_global_cooldown_suppresses_fallback_claims(self):
        with self.with_temp_db() as path:
            self.insert_job(
                path,
                source="linkedin",
                job_url="https://www.linkedin.com/jobs/view/888",
            )
            cooldown_until = db.format_sqlite_timestamp(db.utc_now() + timedelta(hours=1))

            db.set_hiring_cafe_cooldown_until(cooldown_until)
            self.assertEqual(db.count_ready_linkedin_jobs_for_hiring_cafe_fallback(), 0)
            self.assertIsNone(db.claim_linkedin_job_for_hiring_cafe_fallback())

            db.clear_hiring_cafe_cooldown()
            self.assertEqual(db.count_ready_linkedin_jobs_for_hiring_cafe_fallback(), 1)


class EnrichmentCliTests(unittest.TestCase):
    def test_invalid_cli_combinations_never_claim_jobs(self):
        from unittest.mock import Mock

        from hunter import enrich_hiring_cafe, enrich_indeed, enrich_linkedin

        for worker in (enrich_linkedin, enrich_indeed, enrich_hiring_cafe):
            invalid = [["--force"], ["--limit", "0"], ["--job-id", "42", "--limit", "2"]]
            if worker != enrich_hiring_cafe:
                invalid += [
                    ["--ui-verify"],
                    ["--ui-verify-blocked"],
                    ["--job-id", "42", "--ui-verify-blocked"],
                ]
            for arguments in invalid:
                with self.subTest(worker=worker.__name__, arguments=arguments):
                    one, many = Mock(), Mock()
                    with (
                        patch.object(sys, "argv", ["enrich", *arguments]),
                        patch.object(worker, "process_one_job", one),
                        patch.object(worker, "process_batch", many),
                    ):
                        with self.assertRaises(SystemExit) as result:
                            worker.main()
                    self.assertEqual(result.exception.code, 2)
                    one.assert_not_called()
                    many.assert_not_called()


if __name__ == "__main__":
    unittest.main()
