import os
import sqlite3
import sys
import tempfile
import unittest

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, REPO_ROOT)

from hunter import db, enrich_linkedin  # noqa: E402


class Stage2Tests(unittest.TestCase):
    class FakeLocator:
        def __init__(self, texts=None, *, count=None, visible=True, on_click=None):
            self._texts = texts or []
            self._count = count if count is not None else len(self._texts)
            self._visible = visible
            self._on_click = on_click
            self.first = self

        def count(self):
            return self._count

        def nth(self, index):
            return self

        def is_visible(self):
            return self._visible

        def all_inner_texts(self):
            return list(self._texts)

        def inner_text(self, timeout=None):
            return self._texts[0] if self._texts else ""

        def text_content(self):
            return self.inner_text()

        def click(self, timeout=None):
            if self._on_click:
                self._on_click()

    class FakePage:
        def __init__(self, *, url, title="", selectors=None):
            self.url = url
            self._title = title
            self._selectors = selectors or {}

        def title(self):
            return self._title

        def locator(self, selector):
            value = self._selectors.get(selector)
            if isinstance(value, Stage2Tests.FakeLocator):
                return value
            if value is None:
                return Stage2Tests.FakeLocator()
            if isinstance(value, str):
                return Stage2Tests.FakeLocator([value])
            if isinstance(value, (list, tuple)):
                return Stage2Tests.FakeLocator(list(value))
            return Stage2Tests.FakeLocator(count=int(value))

        def wait_for_timeout(self, timeout):
            return None

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
            return conn.execute(
                "SELECT id FROM jobs WHERE job_url = ?", (defaults["job_url"],)
            ).fetchone()[0]
        finally:
            conn.close()

    def test_mark_linkedin_enrichment_failed_can_persist_partial_apply_metadata(self):
        with self.with_temp_db() as path:
            job_id = self.insert_linkedin_job(
                path,
                apply_url="https://old.example.com/apply",
                apply_host="old.example.com",
                ats_type="unknown",
            )
            db.claim_linkedin_job_for_enrichment(job_id=job_id)
            updated = db.mark_linkedin_enrichment_failed(
                job_id,
                "security_verification: blocked by external challenge",
                apply_type="easy_apply",
                auto_apply_eligible=0,
                apply_url=None,
                apply_host=None,
                ats_type=None,
            )
            self.assertEqual(updated, 1)
            row = db.get_job_by_id(job_id)
            self.assertEqual(row["enrichment_status"], "failed")
            self.assertEqual(
                row["last_enrichment_error"], "security_verification: blocked by external challenge"
            )
            self.assertEqual(row["apply_type"], "easy_apply")
            self.assertEqual(row["auto_apply_eligible"], 0)
            self.assertIsNone(row["apply_url"])
            self.assertIsNone(row["apply_host"])
            self.assertIsNone(row["ats_type"])

    def test_extract_description_clicks_linkedin_show_more_button(self):
        truncated = """
        About the job
        Responsibilities include building backend services.
        ... more
        """
        expanded = """
        About the job
        Responsibilities include building backend services, mentoring teammates,
        and collaborating across product and platform groups.
        Minimum Qualifications include Python experience and distributed systems knowledge.
        """
        page = self.FakePage(
            url="https://www.linkedin.com/jobs/view/123",
            selectors={
                ".show-more-less-html__markup": self.FakeLocator([truncated]),
            },
        )

        def expand_description():
            page._selectors[".show-more-less-html__markup"] = self.FakeLocator([expanded])

        page._selectors["button.show-more-less-html__button--more"] = self.FakeLocator(
            ["Show more"],
            on_click=expand_description,
        )

        extracted = enrich_linkedin.extract_description(page)

        self.assertEqual(extracted, enrich_linkedin.normalize_description_text(expanded))


if __name__ == "__main__":
    unittest.main()
