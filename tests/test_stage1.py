import importlib
import math
import os
import sqlite3
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, REPO_ROOT)

jobspy_stub = types.ModuleType("jobspy")
jobspy_stub.scrape_jobs = lambda **kwargs: None
sys.modules.setdefault("jobspy", jobspy_stub)

from hunter import config as config_module  # noqa: E402
from hunter import db  # noqa: E402
from hunter import scraper as discovery  # noqa: E402  # C1 (Hunter) discovery module


class FakeDf:
    def __init__(self, rows):
        self._rows = rows

    def iterrows(self):
        yield from enumerate(self._rows)

    def __len__(self):
        return len(self._rows)


OLD_JOBS_TABLE_SQL = """
CREATE TABLE jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    company TEXT,
    location TEXT,
    job_url TEXT UNIQUE NOT NULL,
    apply_url TEXT,
    description TEXT,
    source TEXT,
    date_posted TEXT,
    is_remote BOOLEAN,
    status TEXT DEFAULT 'new',
    date_scraped TEXT DEFAULT CURRENT_TIMESTAMP,
    level TEXT,
    priority BOOLEAN DEFAULT 0,
    category TEXT
)
"""


class Stage1Tests(unittest.TestCase):
    def make_temp_db_path(self):
        fd, path = tempfile.mkstemp(suffix=".db")
        os.close(fd)
        return path

    def test_normalize_optional_str_handles_missing_values(self):
        self.assertIsNone(discovery.normalize_optional_str(None))
        self.assertIsNone(discovery.normalize_optional_str(""))
        self.assertIsNone(discovery.normalize_optional_str("   "))
        self.assertIsNone(discovery.normalize_optional_str(math.nan))
        self.assertEqual(
            discovery.normalize_optional_str(" https://boards.greenhouse.io/acme/jobs/1 "),
            "https://boards.greenhouse.io/acme/jobs/1",
        )

    def test_config_reads_env_overrides_for_stage3_runtime(self):
        with patch.dict(
            os.environ,
            {
                "HUNT_DB_PATH": os.path.join(REPO_ROOT, "tmp-hunt.db"),
                "ENRICHMENT_BATCH_LIMIT": "7",
                "ENRICHMENT_UI_VERIFY_BLOCKED": "true",
                "REVIEW_APP_PORT": "9001",
            },
            clear=False,
        ):
            reloaded = importlib.reload(config_module)
            self.assertTrue(reloaded.DB_PATH.endswith("tmp-hunt.db"))
            self.assertEqual(reloaded.ENRICHMENT_BATCH_LIMIT, 7)
            self.assertTrue(reloaded.ENRICHMENT_UI_VERIFY_BLOCKED)
            self.assertEqual(reloaded.REVIEW_APP_PORT, 9001)

        importlib.reload(config_module)

    def test_scrape_single_keeps_linkedin_rows_pending_for_browser_enrichment(self):
        jobs_df = FakeDf(
            [
                {
                    "title": "Software Engineer",
                    "company": "Acme",
                    "location": "Canada",
                    "job_url": "https://www.linkedin.com/jobs/view/1",
                    "job_url_direct": "https://boards.greenhouse.io/acme/jobs/1",
                    "description": "Full description from the feed",
                    "site": "linkedin",
                    "date_posted": "2026-04-04",
                    "is_remote": True,
                }
            ]
        )

        jobspy_fake = types.ModuleType("jobspy")
        jobspy_fake.scrape_jobs = lambda **_kwargs: jobs_df
        with patch.dict(sys.modules, {"jobspy": jobspy_fake}):
            jobs = discovery.scrape_single(
                "linkedin", "software engineer", "Canada", "engineering"
            )

        self.assertEqual(len(jobs), 1)
        job = jobs[0]
        self.assertEqual(job["job_url"], "https://www.linkedin.com/jobs/view/1")
        self.assertEqual(job["apply_url"], "https://boards.greenhouse.io/acme/jobs/1")
        self.assertEqual(job["apply_type"], "unknown")
        self.assertIsNone(job["auto_apply_eligible"])
        self.assertEqual(job["enrichment_status"], "pending")
        self.assertEqual(job["apply_host"], "boards.greenhouse.io")
        self.assertEqual(job["ats_type"], "greenhouse")

    def test_scrape_single_treats_nan_feed_values_as_missing(self):
        jobs_df = FakeDf(
            [
                {
                    "title": "Software Engineer",
                    "company": "Acme",
                    "location": "Canada",
                    "job_url": "https://www.linkedin.com/jobs/view/2",
                    "job_url_direct": math.nan,
                    "description": math.nan,
                    "site": "linkedin",
                    "date_posted": math.nan,
                    "is_remote": True,
                }
            ]
        )

        jobspy_fake = types.ModuleType("jobspy")
        jobspy_fake.scrape_jobs = lambda **_kwargs: jobs_df
        with patch.dict(sys.modules, {"jobspy": jobspy_fake}):
            jobs = discovery.scrape_single(
                "linkedin", "software engineer", "Canada", "engineering"
            )

        self.assertEqual(len(jobs), 1)
        job = jobs[0]
        self.assertIsNone(job["apply_url"])
        self.assertIsNone(job["description"])
        self.assertIsNone(job["date_posted"])
        self.assertEqual(job["apply_type"], "unknown")
        self.assertEqual(job["enrichment_status"], "pending")

    def test_scrape_single_filters_unrelated_indeed_product_false_positive(self):
        jobs_df = FakeDf(
            [
                {
                    "title": "Cashier",
                    "company": "Walmart",
                    "location": "Canada",
                    "job_url": "https://ca.indeed.com/viewjob?jk=123",
                    "job_url_direct": "https://walmart.wd5.myworkdayjobs.com/job/123",
                    "description": "Retail cashier role",
                    "site": "indeed",
                    "date_posted": "2026-04-05",
                    "is_remote": False,
                }
            ]
        )

        jobspy_fake = types.ModuleType("jobspy")
        jobspy_fake.scrape_jobs = lambda **_kwargs: jobs_df
        with patch.dict(sys.modules, {"jobspy": jobspy_fake}):
            jobs = discovery.scrape_single(
                "indeed", "associate product manager", "Canada", "product"
            )

        self.assertEqual(jobs, [])

    def test_scrape_single_keeps_relevant_indeed_product_title(self):
        jobs_df = FakeDf(
            [
                {
                    "title": "Associate Product Manager",
                    "company": "Acme",
                    "location": "Canada",
                    "job_url": "https://ca.indeed.com/viewjob?jk=456",
                    "job_url_direct": "https://boards.greenhouse.io/acme/jobs/456",
                    "description": "APM role",
                    "site": "indeed",
                    "date_posted": "2026-04-05",
                    "is_remote": True,
                }
            ]
        )

        jobspy_fake = types.ModuleType("jobspy")
        jobspy_fake.scrape_jobs = lambda **_kwargs: jobs_df
        with patch.dict(sys.modules, {"jobspy": jobspy_fake}):
            jobs = discovery.scrape_single(
                "indeed", "associate product manager", "Canada", "product"
            )

        self.assertEqual(len(jobs), 1)
        self.assertEqual(jobs[0]["title"], "Associate Product Manager")
        self.assertEqual(jobs[0]["source"], "indeed")
        self.assertEqual(jobs[0]["enrichment_status"], "pending")

    def test_init_db_migrates_old_schema_and_backfills_legacy_linkedin_rows(self):
        path = self.make_temp_db_path()
        old_db_path = db.DB_PATH
        try:
            conn = sqlite3.connect(path)
            cur = conn.cursor()
            cur.execute(OLD_JOBS_TABLE_SQL)
            cur.execute(
                """
                INSERT INTO jobs (
                    title, company, location, job_url, apply_url, description, source, category
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    "Software Engineer",
                    "Acme",
                    "Canada",
                    "https://www.linkedin.com/jobs/view/123",
                    "https://www.linkedin.com/jobs/view/123",
                    "",
                    "linkedin",
                    "engineering",
                ),
            )
            conn.commit()
            conn.close()

            db.DB_PATH = path
            db.init_db()

            conn = sqlite3.connect(path)
            conn.row_factory = sqlite3.Row
            cur = conn.cursor()
            columns = {row[1] for row in cur.execute("PRAGMA table_info(jobs)")}
            row = cur.execute(
                """
                SELECT apply_url, apply_type, auto_apply_eligible, enrichment_status,
                       enrichment_attempts, apply_host, ats_type
                FROM jobs
                WHERE source = 'linkedin'
                """
            ).fetchone()
            conn.close()

            self.assertTrue(
                {
                    "apply_type",
                    "auto_apply_eligible",
                    "enrichment_status",
                    "enrichment_attempts",
                    "enriched_at",
                    "last_enrichment_error",
                    "apply_host",
                    "ats_type",
                }.issubset(columns)
            )
            self.assertIsNone(row["apply_url"])
            self.assertEqual(row["apply_type"], "unknown")
            self.assertIsNone(row["auto_apply_eligible"])
            self.assertEqual(row["enrichment_status"], "pending")
            self.assertEqual(row["enrichment_attempts"], 0)
            self.assertIsNone(row["apply_host"])
            self.assertIsNone(row["ats_type"])
        finally:
            db.DB_PATH = old_db_path
            if os.path.exists(path):
                os.remove(path)

    def test_init_db_requeues_unenriched_linkedin_rows_marked_done(self):
        path = self.make_temp_db_path()
        old_db_path = db.DB_PATH
        try:
            db.DB_PATH = path
            db.init_db()

            conn = sqlite3.connect(path)
            cur = conn.cursor()
            cur.execute(
                """
                INSERT INTO jobs (
                    title, company, location, job_url, apply_url, description, source,
                    apply_type, auto_apply_eligible, enrichment_status, apply_host, ats_type
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    "Software Engineer",
                    "Acme",
                    "Canada",
                    "https://www.linkedin.com/jobs/view/999",
                    "https://boards.greenhouse.io/acme/jobs/999",
                    "Feed description",
                    "linkedin",
                    "external_apply",
                    1,
                    "done",
                    "boards.greenhouse.io",
                    "greenhouse",
                ),
            )
            conn.commit()
            conn.close()

            db.init_db()

            conn = sqlite3.connect(path)
            conn.row_factory = sqlite3.Row
            row = conn.execute(
                """
                SELECT apply_url, apply_type, auto_apply_eligible, enrichment_status,
                       apply_host, ats_type, enriched_at
                FROM jobs
                WHERE job_url = 'https://www.linkedin.com/jobs/view/999'
                """
            ).fetchone()
            conn.close()

            self.assertEqual(row["apply_url"], "https://boards.greenhouse.io/acme/jobs/999")
            self.assertEqual(row["apply_type"], "unknown")
            self.assertIsNone(row["auto_apply_eligible"])
            self.assertEqual(row["enrichment_status"], "pending")
            self.assertEqual(row["apply_host"], "boards.greenhouse.io")
            self.assertEqual(row["ats_type"], "greenhouse")
            self.assertIsNone(row["enriched_at"])
        finally:
            db.DB_PATH = old_db_path
            if os.path.exists(path):
                os.remove(path)

    def test_add_job_refreshes_missing_discovery_fields_on_duplicate_job_url(self):
        path = self.make_temp_db_path()
        old_db_path = db.DB_PATH
        try:
            db.DB_PATH = path
            db.init_db()

            inserted = db.add_job(
                {
                    "title": "Software Engineer",
                    "company": "Acme",
                    "location": "Canada",
                    "job_url": "https://www.linkedin.com/jobs/view/42",
                    "apply_url": None,
                    "description": None,
                    "source": "linkedin",
                    "date_posted": "2026-04-04",
                    "is_remote": True,
                    "level": "unknown",
                    "priority": 0,
                    "category": "engineering",
                    "apply_type": "unknown",
                    "auto_apply_eligible": None,
                    "enrichment_status": "pending",
                    "enrichment_attempts": 0,
                    "apply_host": None,
                    "ats_type": None,
                }
            )
            refreshed = db.add_job(
                {
                    "title": "Software Engineer",
                    "company": "Acme",
                    "location": "Canada",
                    "job_url": "https://www.linkedin.com/jobs/view/42",
                    "apply_url": "https://job-boards.greenhouse.io/acme/jobs/42",
                    "description": "Feed description",
                    "source": "linkedin",
                    "date_posted": "2026-04-04",
                    "is_remote": True,
                    "level": "junior",
                    "priority": 1,
                    "category": "engineering",
                    "apply_type": "unknown",
                    "auto_apply_eligible": None,
                    "enrichment_status": "pending",
                    "enrichment_attempts": 0,
                    "apply_host": "job-boards.greenhouse.io",
                    "ats_type": "greenhouse",
                }
            )

            row = db.get_job_by_id(1)
            self.assertEqual(inserted[0], "inserted")
            self.assertEqual(refreshed[0], "updated")
            self.assertEqual(row["apply_url"], "https://job-boards.greenhouse.io/acme/jobs/42")
            self.assertEqual(row["apply_host"], "job-boards.greenhouse.io")
            self.assertEqual(row["ats_type"], "greenhouse")
            self.assertEqual(row["description"], "Feed description")
            self.assertEqual(row["level"], "junior")
            self.assertEqual(row["priority"], 1)
        finally:
            db.DB_PATH = old_db_path
            if os.path.exists(path):
                os.remove(path)

    def test_scrape_can_trigger_post_scrape_enrichment(self):
        path = self.make_temp_db_path()
        old_db_path = db.DB_PATH
        jobs_df = FakeDf(
            [
                {
                    "title": "Software Engineer",
                    "company": "Acme",
                    "location": "Canada",
                    "job_url": "https://www.linkedin.com/jobs/view/77",
                    "job_url_direct": "https://boards.greenhouse.io/acme/jobs/77",
                    "description": "Feed description",
                    "site": "linkedin",
                    "date_posted": "2026-04-04",
                    "is_remote": True,
                }
            ]
        )

        try:
            db.DB_PATH = path

            jobspy_fake = types.ModuleType("jobspy")
            jobspy_fake.scrape_jobs = lambda **_kwargs: jobs_df
            with (
                patch.object(
                    discovery, "SEARCH_TERMS", {"engineering": ["software engineer"]}
                ),
                patch.object(discovery, "LOCATIONS", ["Canada"]),
                patch.object(discovery, "SITES", ["linkedin"]),
                patch.object(discovery, "MAX_WORKERS", 1),
                patch.dict(sys.modules, {"jobspy": jobspy_fake}),
                patch.object(
                    discovery, "run_pending_linkedin_enrichment", return_value=0
                ) as mock_enrich,
            ):
                summary = discovery.scrape(
                    enrich_pending=True,
                    enrich_limit=5,
                    enrichment_headless=True,
                    enrichment_slow_mo=0,
                    enrichment_timeout_ms=12345,
                    enrichment_browser_channel="chrome",
                    ui_verify_blocked=True,
                )

            self.assertEqual(summary["inserted"], 1)
            self.assertEqual(summary["refreshed"], 0)
            self.assertEqual(summary["enrichment_exit_code"], 0)
            mock_enrich.assert_called_once_with(
                limit=5,
                storage_state_path=None,
                headless=True,
                slow_mo=0,
                timeout_ms=12345,
                browser_channel="chrome",
                ui_verify_blocked=True,
            )
        finally:
            db.DB_PATH = old_db_path
            if os.path.exists(path):
                os.remove(path)


if __name__ == "__main__":
    unittest.main()
