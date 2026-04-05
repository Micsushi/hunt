import os
import sqlite3
import sys
import tempfile
import unittest


REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SCRAPER_DIR = os.path.join(REPO_ROOT, "scraper")
sys.path.insert(0, SCRAPER_DIR)

import db
import url_utils


class Stage2Tests(unittest.TestCase):
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
                    enrichment_attempts, apply_host, ats_type
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
                ),
            )
            conn.commit()
            return conn.execute("SELECT id FROM jobs WHERE job_url = ?", (defaults["job_url"],)).fetchone()[0]
        finally:
            conn.close()

    def test_normalize_apply_url_unwraps_linkedin_redirect(self):
        redirect_url = (
            "https://www.linkedin.com/redir/redirect"
            "?url=https%3A%2F%2Fboards.greenhouse.io%2Facme%2Fjobs%2F123"
        )
        self.assertEqual(
            url_utils.normalize_apply_url(redirect_url),
            "https://boards.greenhouse.io/acme/jobs/123",
        )
        self.assertEqual(url_utils.get_apply_host(redirect_url), "boards.greenhouse.io")
        self.assertEqual(url_utils.detect_ats_type(redirect_url), "greenhouse")

    def test_claim_linkedin_job_marks_row_processing_and_increments_attempts(self):
        with self.with_temp_db() as path:
            job_id = self.insert_linkedin_job(path)
            claimed = db.claim_linkedin_job_for_enrichment(job_id=job_id)
            self.assertIsNotNone(claimed)
            self.assertEqual(claimed["id"], job_id)
            self.assertEqual(claimed["enrichment_status"], "processing")
            self.assertEqual(claimed["enrichment_attempts"], 1)

    def test_mark_linkedin_enrichment_succeeded_writes_stage2_fields(self):
        with self.with_temp_db() as path:
            job_id = self.insert_linkedin_job(path)
            db.claim_linkedin_job_for_enrichment(job_id=job_id)
            updated = db.mark_linkedin_enrichment_succeeded(
                job_id,
                description="Full LinkedIn description",
                apply_type="external_apply",
                auto_apply_eligible=1,
                apply_url="https://boards.greenhouse.io/acme/jobs/123",
                apply_host="boards.greenhouse.io",
                ats_type="greenhouse",
            )
            self.assertEqual(updated, 1)
            row = db.get_job_by_id(job_id)
            self.assertEqual(row["description"], "Full LinkedIn description")
            self.assertEqual(row["apply_type"], "external_apply")
            self.assertEqual(row["auto_apply_eligible"], 1)
            self.assertEqual(row["apply_url"], "https://boards.greenhouse.io/acme/jobs/123")
            self.assertEqual(row["apply_host"], "boards.greenhouse.io")
            self.assertEqual(row["ats_type"], "greenhouse")
            self.assertEqual(row["enrichment_status"], "done")
            self.assertIsNotNone(row["enriched_at"])

    def test_mark_linkedin_enrichment_failed_records_error(self):
        with self.with_temp_db() as path:
            job_id = self.insert_linkedin_job(path)
            db.claim_linkedin_job_for_enrichment(job_id=job_id)
            updated = db.mark_linkedin_enrichment_failed(job_id, "layout_changed: apply button missing")
            self.assertEqual(updated, 1)
            row = db.get_job_by_id(job_id)
            self.assertEqual(row["enrichment_status"], "failed")
            self.assertEqual(row["last_enrichment_error"], "layout_changed: apply button missing")


if __name__ == "__main__":
    unittest.main()
