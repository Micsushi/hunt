import os
import sqlite3
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, REPO_ROOT)

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
    def test_collection_environment_values_override_file_config(self):
        with patch.dict(
            os.environ,
            {
                "SEARCH_TERMS": '{"healthcare":["nurse"]}',
                "SITES": '["linkedin"]',
                "COMPANY_CAREER_SITES": '{"New":"https://example.test/jobs"}',
            },
        ):
            self.assertEqual(
                config_module._get_config_dict("SEARCH_TERMS", {}), {"healthcare": ["nurse"]}
            )
            self.assertEqual(config_module._get_config_list("SITES", []), ["linkedin"])
            self.assertEqual(
                config_module._get_company_sites(),
                {"New": "https://example.test/jobs"},
            )
        with patch.dict(os.environ, {"SITES": '"linkedin"'}):
            with self.assertRaises(ValueError):
                config_module._get_config_list("SITES", [])

    def make_temp_db_path(self):
        fd, path = tempfile.mkstemp(suffix=".db")
        os.close(fd)
        return path

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

        scrape_calls = []

        def fake_scrape_jobs(**kwargs):
            scrape_calls.append(kwargs)
            return jobs_df

        jobspy_fake = types.ModuleType("jobspy")
        jobspy_fake.scrape_jobs = fake_scrape_jobs
        with patch.dict(sys.modules, {"jobspy": jobspy_fake}):
            jobs = discovery.scrape_single("linkedin", "software engineer", "Canada", "engineering")

        self.assertEqual(scrape_calls[0]["linkedin_fetch_description"], True)
        self.assertEqual(len(jobs), 1)
        job = jobs[0]
        self.assertEqual(job["job_url"], "https://www.linkedin.com/jobs/view/1")
        self.assertEqual(job["apply_url"], "https://boards.greenhouse.io/acme/jobs/1")
        self.assertEqual(job["apply_type"], "unknown")
        self.assertIsNone(job["auto_apply_eligible"])
        self.assertEqual(job["enrichment_status"], "pending")
        self.assertEqual(job["apply_host"], "boards.greenhouse.io")
        self.assertEqual(job["ats_type"], "greenhouse")

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


if __name__ == "__main__":
    unittest.main()
