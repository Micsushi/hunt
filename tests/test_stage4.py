import io
import json
import os
import sqlite3
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest.mock import patch


REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SCRAPER_DIR = os.path.join(REPO_ROOT, "scraper")
SCRIPTS_DIR = os.path.join(REPO_ROOT, "scripts")
sys.path.insert(0, SCRAPER_DIR)
sys.path.insert(0, SCRIPTS_DIR)

import db
import failure_artifacts
import huntctl
import linkedin_session
import queue_health


class Stage4Tests(unittest.TestCase):
    class FakeLocator:
        def __init__(self, *, count=0, on_click=None, on_fill=None):
            self._count = count
            self._on_click = on_click
            self._on_fill = on_fill
            self.first = self

        def count(self):
            return self._count

        def click(self, timeout=None):
            if self._on_click:
                self._on_click()

        def fill(self, value, timeout=None):
            if self._on_fill:
                self._on_fill(value)

    class FakePage:
        def __init__(self, states, *, initial_state):
            self.states = states
            self.state = initial_state
            self.url = states[initial_state].get("url", "")
            self.filled = {}

        def locator(self, selector):
            config = self.states[self.state].get("selectors", {}).get(selector)
            if config is None:
                return Stage4Tests.FakeLocator()
            if isinstance(config, Stage4Tests.FakeLocator):
                return config
            if isinstance(config, dict):
                def on_click():
                    next_state = config.get("next_state")
                    if next_state:
                        self.state = next_state
                        self.url = self.states[next_state].get("url", self.url)

                def on_fill(value):
                    fill_key = config.get("fill_key")
                    if fill_key:
                        self.filled[fill_key] = value

                return Stage4Tests.FakeLocator(
                    count=config.get("count", 1),
                    on_click=on_click if config.get("clickable", True) else None,
                    on_fill=on_fill,
                )
            return Stage4Tests.FakeLocator(count=int(config))

        def goto(self, url, wait_until=None, timeout=None):
            self.url = url
            for state_name, payload in self.states.items():
                if payload.get("url") == url:
                    self.state = state_name
                    break

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

    def insert_job(self, path, **overrides):
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

    def test_capture_text_artifacts_writes_relative_paths_under_artifact_root(self):
        with tempfile.TemporaryDirectory() as artifact_root:
            with patch.dict(os.environ, {"HUNT_ARTIFACTS_DIR": artifact_root}, clear=False):
                job = {
                    "id": 42,
                    "source": "linkedin",
                    "company": "Acme",
                    "title": "Data Engineer",
                    "job_url": "https://www.linkedin.com/jobs/view/42",
                }
                paths = failure_artifacts.capture_text_artifacts(
                    job,
                    "security_verification",
                    html_content="<html><body>challenge</body></html>",
                    text_content="challenge text",
                )

                self.assertTrue(paths["artifact_dir"].startswith("linkedin/job_42/"))
                self.assertIsNotNone(failure_artifacts.resolve_artifact_path(paths["artifact_html_path"]))
                self.assertTrue(failure_artifacts.resolve_artifact_path(paths["artifact_html_path"]).exists())
                self.assertTrue(failure_artifacts.resolve_artifact_path(paths["artifact_text_path"]).exists())

    def test_artifact_paths_persist_on_failure_and_clear_on_requeue(self):
        with self.with_temp_db() as path:
            job_id = self.insert_job(path)
            db.claim_linkedin_job_for_enrichment(job_id=job_id)
            updated = db.mark_linkedin_enrichment_failed(
                job_id,
                "security_verification: blocked by challenge",
                enrichment_status="blocked",
                artifact_dir="linkedin/job_1/test_run",
                artifact_screenshot_path="linkedin/job_1/test_run/page.png",
                artifact_html_path="linkedin/job_1/test_run/page.html",
                artifact_text_path="linkedin/job_1/test_run/page.txt",
            )
            self.assertEqual(updated, 1)

            failed_row = db.get_job_by_id(job_id)
            self.assertEqual(failed_row["last_artifact_dir"], "linkedin/job_1/test_run")
            self.assertEqual(failed_row["last_artifact_screenshot_path"], "linkedin/job_1/test_run/page.png")

            requeued = db.requeue_job(job_id, source="linkedin")
            self.assertEqual(requeued, 1)
            requeued_row = db.get_job_by_id(job_id)
            self.assertIsNone(requeued_row["last_artifact_dir"])
            self.assertIsNone(requeued_row["last_artifact_screenshot_path"])
            self.assertIsNone(requeued_row["last_artifact_html_path"])
            self.assertIsNone(requeued_row["last_artifact_text_path"])

    def test_queue_health_json_emits_summary_and_sections(self):
        with self.with_temp_db() as path:
            job_id = self.insert_job(path, enrichment_status="failed")
            db.mark_linkedin_auth_unavailable("auth_expired: LinkedIn session appears to be logged out or expired.")
            db.mark_linkedin_enrichment_failed(
                job_id,
                "external_description_not_found: missing",
                artifact_dir="linkedin/job_1/test_run",
            )
            stdout = io.StringIO()
            with patch.object(sys, "argv", ["queue_health.py", "--json", "--limit", "2"]), redirect_stdout(stdout):
                queue_health.main()

            payload = json.loads(stdout.getvalue())
            self.assertIn("summary", payload)
            self.assertIn("sections", payload)
            self.assertIn("failed", payload["sections"])
            self.assertEqual(payload["sections"]["failed"][0]["last_artifact_dir"], "linkedin/job_1/test_run")
            self.assertFalse(payload["summary"]["auth"]["linkedin"]["available"])

    def test_mark_linkedin_auth_state_recreates_runtime_state_table(self):
        with self.with_temp_db() as path:
            conn = sqlite3.connect(path)
            try:
                conn.execute("DROP TABLE runtime_state")
                conn.commit()
            finally:
                conn.close()

            db.mark_linkedin_auth_unavailable("auth_expired: LinkedIn session appears to be logged out or expired.")
            auth_state = db.get_linkedin_auth_state()
            self.assertFalse(auth_state["available"])
            self.assertEqual(auth_state["status"], "expired")

            db.mark_linkedin_auth_available()
            auth_state = db.get_linkedin_auth_state()
            self.assertTrue(auth_state["available"])
            self.assertEqual(auth_state["status"], "ok")
            self.assertIsNone(auth_state["last_error"])

    def test_huntctl_defaults_to_runtime_db_on_linux_server_layout(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            home_path = Path(temp_dir)
            repo_root = home_path / "hunt"
            runtime_dir = home_path / "data" / "hunt"
            repo_root.mkdir(parents=True)
            runtime_dir.mkdir(parents=True)

            defaults = huntctl._get_default_runtime_env(
                {},
                repo_root=repo_root,
                home_dir=home_path,
                is_windows=False,
            )

            self.assertEqual(defaults["HUNT_DB_PATH"], str(runtime_dir / "hunt.db"))
            self.assertEqual(defaults["HUNT_ARTIFACTS_DIR"], str(runtime_dir / "artifacts"))

    def test_submit_login_form_clicks_account_chooser_before_form_fill(self):
        page = self.FakePage(
            {
                "chooser": {
                    "url": "https://www.linkedin.com/feed/",
                    "selectors": {
                        "button:has-text('Continue as')": {"count": 1, "next_state": "authed"},
                    },
                },
                "authed": {
                    "url": "https://www.linkedin.com/feed/",
                    "selectors": {},
                },
            },
            initial_state="chooser",
        )

        result = linkedin_session._submit_login_form(
            page,
            email="person@example.com",
            password="secret",
            timeout_ms=1000,
        )

        self.assertEqual(result, "chooser_clicked")
        self.assertEqual(page.state, "authed")
        self.assertEqual(page.filled, {})


if __name__ == "__main__":
    unittest.main()
