import math
import os
import sqlite3
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

import pandas as pd


REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SCRAPER_DIR = os.path.join(REPO_ROOT, "scraper")
sys.path.insert(0, SCRAPER_DIR)

jobspy_stub = types.ModuleType("jobspy")
jobspy_stub.scrape_jobs = lambda **kwargs: None
sys.modules.setdefault("jobspy", jobspy_stub)

import db
import scraper as scraper_module


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
        self.assertIsNone(scraper_module.normalize_optional_str(None))
        self.assertIsNone(scraper_module.normalize_optional_str(""))
        self.assertIsNone(scraper_module.normalize_optional_str("   "))
        self.assertIsNone(scraper_module.normalize_optional_str(math.nan))
        self.assertEqual(
            scraper_module.normalize_optional_str(" https://boards.greenhouse.io/acme/jobs/1 "),
            "https://boards.greenhouse.io/acme/jobs/1",
        )

    def test_scrape_single_keeps_linkedin_rows_pending_for_browser_enrichment(self):
        jobs_df = pd.DataFrame(
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

        with patch.object(scraper_module, "scrape_jobs", return_value=jobs_df):
            jobs = scraper_module.scrape_single("linkedin", "software engineer", "Canada", "engineering")

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
        jobs_df = pd.DataFrame(
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

        with patch.object(scraper_module, "scrape_jobs", return_value=jobs_df):
            jobs = scraper_module.scrape_single("linkedin", "software engineer", "Canada", "engineering")

        self.assertEqual(len(jobs), 1)
        job = jobs[0]
        self.assertIsNone(job["apply_url"])
        self.assertIsNone(job["description"])
        self.assertIsNone(job["date_posted"])
        self.assertEqual(job["apply_type"], "unknown")
        self.assertEqual(job["enrichment_status"], "pending")

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
            self.assertEqual(inserted, "inserted")
            self.assertEqual(refreshed, "updated")
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
        jobs_df = pd.DataFrame(
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

            with patch.object(scraper_module, "SEARCH_TERMS", {"engineering": ["software engineer"]}), \
                 patch.object(scraper_module, "LOCATIONS", ["Canada"]), \
                 patch.object(scraper_module, "SITES", ["linkedin"]), \
                 patch.object(scraper_module, "MAX_WORKERS", 1), \
                 patch.object(scraper_module, "scrape_jobs", return_value=jobs_df), \
                 patch.object(scraper_module, "run_pending_linkedin_enrichment", return_value=0) as mock_enrich:
                summary = scraper_module.scrape(
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
