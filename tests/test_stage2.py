import os
import sqlite3
import sys
import tempfile
import unittest


REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SCRAPER_DIR = os.path.join(REPO_ROOT, "scraper")
sys.path.insert(0, SCRAPER_DIR)

import db
import enrich_linkedin
import url_utils


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

    def test_mark_linkedin_enrichment_succeeded_can_use_done_verified_status(self):
        with self.with_temp_db() as path:
            job_id = self.insert_linkedin_job(path)
            db.claim_linkedin_job_for_enrichment(job_id=job_id)
            updated = db.mark_linkedin_enrichment_succeeded(
                job_id,
                description="Verified in visible browser",
                apply_type="external_apply",
                auto_apply_eligible=1,
                apply_url="https://boards.greenhouse.io/acme/jobs/123",
                apply_host="boards.greenhouse.io",
                ats_type="greenhouse",
                enrichment_status="done_verified",
            )
            self.assertEqual(updated, 1)
            row = db.get_job_by_id(job_id)
            self.assertEqual(row["enrichment_status"], "done_verified")
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

    def test_mark_linkedin_enrichment_failed_can_use_blocked_status(self):
        with self.with_temp_db() as path:
            job_id = self.insert_linkedin_job(path)
            db.claim_linkedin_job_for_enrichment(job_id=job_id)
            updated = db.mark_linkedin_enrichment_failed(
                job_id,
                "security_verification: blocked by external challenge",
                enrichment_status="blocked",
            )
            self.assertEqual(updated, 1)
            row = db.get_job_by_id(job_id)
            self.assertEqual(row["enrichment_status"], "blocked")
            self.assertEqual(row["last_enrichment_error"], "security_verification: blocked by external challenge")

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
            self.assertEqual(row["last_enrichment_error"], "security_verification: blocked by external challenge")
            self.assertEqual(row["apply_type"], "easy_apply")
            self.assertEqual(row["auto_apply_eligible"], 0)
            self.assertIsNone(row["apply_url"])
            self.assertIsNone(row["apply_host"])
            self.assertIsNone(row["ats_type"])

    def test_init_db_backfills_linkedin_derived_fields_from_apply_url(self):
        with self.with_temp_db() as path:
            job_id = self.insert_linkedin_job(
                path,
                apply_url=(
                    "https://www.linkedin.com/redir/redirect"
                    "?url=https%3A%2F%2Fjob-boards.greenhouse.io%2Facme%2Fjobs%2F123"
                ),
                apply_type="unknown",
                auto_apply_eligible=None,
                enrichment_status="done",
                apply_host=None,
                ats_type=None,
                description="Already enriched description",
            )

            db.init_db()
            row = db.get_job_by_id(job_id)
            self.assertEqual(row["apply_url"], "https://job-boards.greenhouse.io/acme/jobs/123")
            self.assertEqual(row["apply_type"], "unknown")
            self.assertIsNone(row["auto_apply_eligible"])
            self.assertEqual(row["enrichment_status"], "pending")
            self.assertEqual(row["apply_host"], "job-boards.greenhouse.io")
            self.assertEqual(row["ats_type"], "greenhouse")

    def test_requeue_linkedin_rows_for_refresh_targets_sparse_historical_failures(self):
        with self.with_temp_db() as path:
            stale_failed_id = self.insert_linkedin_job(
                path,
                job_url="https://www.linkedin.com/jobs/view/456",
                enrichment_status="failed",
                apply_type="unknown",
                description=None,
            )
            preserved_failed_id = self.insert_linkedin_job(
                path,
                job_url="https://www.linkedin.com/jobs/view/789",
                enrichment_status="failed",
                apply_type="external_apply",
                apply_url="https://boards.greenhouse.io/acme/jobs/123",
                description="Has useful metadata already",
            )

            job_ids = db.requeue_linkedin_rows_for_refresh()

            self.assertEqual(job_ids, [stale_failed_id])
            stale_row = db.get_job_by_id(stale_failed_id)
            self.assertEqual(stale_row["enrichment_status"], "pending")
            preserved_row = db.get_job_by_id(preserved_failed_id)
            self.assertEqual(preserved_row["enrichment_status"], "failed")

    def test_analyze_security_challenge_requires_multiple_signal_types(self):
        page = self.FakePage(
            url="https://jobs.careerbeacon.com/security-verification",
            title="Performing security verification",
            selectors={
                "body": (
                    "Performing security verification. "
                    "This website uses a security service to protect against malicious bots. "
                    "Please solve this CAPTCHA to request unblock."
                ),
                "h1": "Performing security verification",
                "#challenge-form": self.FakeLocator(count=1),
            },
        )

        signals = enrich_linkedin.analyze_security_challenge(page)

        self.assertIsNotNone(signals)
        self.assertIn("title", signals)
        self.assertIn("text", signals)
        self.assertIn("dom", signals)

    def test_analyze_security_challenge_does_not_flag_text_only_job_content(self):
        page = self.FakePage(
            url="https://jobs.example.com/security-engineer",
            title="Security Engineer",
            selectors={
                "body": (
                    "Build bot-detection systems and improve security verification "
                    "workflows for internal tooling."
                ),
                "h1": "Security Engineer",
            },
        )

        self.assertIsNone(enrich_linkedin.analyze_security_challenge(page))

    def test_ui_verify_status_helpers(self):
        self.assertEqual(enrich_linkedin.get_success_enrichment_status(ui_verify=False), "done")
        self.assertEqual(enrich_linkedin.get_success_enrichment_status(ui_verify=True), "done_verified")
        self.assertEqual(
            enrich_linkedin.get_failure_enrichment_status("security_verification", ui_verify=False),
            "blocked",
        )
        self.assertEqual(
            enrich_linkedin.get_failure_enrichment_status("security_verification", ui_verify=True),
            "blocked_verified",
        )
        self.assertEqual(
            enrich_linkedin.get_failure_enrichment_status("description_not_found", ui_verify=True),
            "failed",
        )

    def test_ui_verify_wait_helpers_use_faster_profile(self):
        self.assertGreater(
            enrich_linkedin.get_networkidle_timeout_ms(fast_ui=False),
            enrich_linkedin.get_networkidle_timeout_ms(fast_ui=True),
        )
        self.assertGreater(
            enrich_linkedin.get_post_click_wait_ms(fast_ui=False),
            enrich_linkedin.get_post_click_wait_ms(fast_ui=True),
        )

    def test_looks_like_usable_job_description_rejects_thin_application_shell_text(self):
        thin_text = """
        Apply now as a QA Engineer - AI Trainer.
        Continue with Email.
        Continue with Google.
        Do you already have an account? Sign in.
        """
        detailed_text = """
        Senior Software Engineer
        Job Details
        Responsibilities include owning backend systems, mentoring teammates,
        improving reliability, and collaborating across product and platform teams.
        Minimum Qualifications include Python experience, distributed systems knowledge,
        and strong communication skills. Compensation and benefits are included below.
        """
        self.assertFalse(enrich_linkedin.looks_like_usable_job_description(thin_text))
        self.assertTrue(enrich_linkedin.looks_like_usable_job_description(detailed_text))

    def test_extract_description_reads_show_more_less_markup(self):
        description = """
        About the job
        Responsibilities include building backend services, mentoring teammates,
        and collaborating across product and platform groups.
        Minimum Qualifications include Python experience and distributed systems knowledge.
        """
        page = self.FakePage(
            url="https://www.linkedin.com/jobs/view/123",
            selectors={
                ".show-more-less-html__markup": description,
            },
        )

        extracted = enrich_linkedin.extract_description(page, expand_selectors=())

        self.assertEqual(extracted, enrich_linkedin.normalize_description_text(description))

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

    def test_security_verification_is_not_treated_as_batch_hard_stop(self):
        self.assertTrue(enrich_linkedin.is_blocking_error_code("security_verification"))
        self.assertFalse(
            enrich_linkedin.should_stop_batch_after_failure(
                "security_verification",
                ui_verify_blocked=False,
            )
        )
        self.assertFalse(enrich_linkedin.is_hard_stop_error_code("security_verification"))
        self.assertTrue(
            enrich_linkedin.should_stop_batch_after_failure(
                "rate_limited",
                ui_verify_blocked=True,
            )
        )
        self.assertTrue(enrich_linkedin.is_hard_stop_error_code("rate_limited"))

    def test_job_removed_is_non_actionable_failure(self):
        self.assertTrue(enrich_linkedin.is_non_actionable_failure_code("job_removed"))
        self.assertFalse(enrich_linkedin.is_non_actionable_failure_code("rate_limited"))


if __name__ == "__main__":
    unittest.main()
