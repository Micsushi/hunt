import io
import json
import os
import sqlite3
import sys
import tempfile
import unittest
from contextlib import contextmanager, redirect_stdout
from pathlib import Path
from unittest.mock import patch


REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SCRAPER_DIR = os.path.join(REPO_ROOT, "scraper")
SCRIPTS_DIR = os.path.join(REPO_ROOT, "scripts")
sys.path.insert(0, SCRAPER_DIR)
sys.path.insert(0, SCRIPTS_DIR)

import db
import browser_runtime
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

    def test_submit_login_form_can_fall_back_to_sign_in_using_another_account(self):
        page = self.FakePage(
            {
                "login": {
                    "url": linkedin_session.LOGIN_URL,
                    "selectors": {
                        "a:has-text('Sign in using another account')": {
                            "count": 1,
                            "next_state": "form",
                        },
                    },
                },
                "form": {
                    "url": linkedin_session.LOGIN_URL,
                    "selectors": {
                        "input[name='session_key']": {"count": 1, "fill_key": "email"},
                        "input[name='session_password']": {"count": 1, "fill_key": "password"},
                        "button[type='submit']": {"count": 1, "next_state": "submitted"},
                    },
                },
                "submitted": {
                    "url": "https://www.linkedin.com/feed/",
                    "selectors": {},
                },
            },
            initial_state="login",
        )

        result = linkedin_session._submit_login_form(
            page,
            email="person@example.com",
            password="secret",
            timeout_ms=1000,
        )

        self.assertEqual(result, "form_submitted")
        self.assertEqual(page.state, "submitted")
        self.assertEqual(
            page.filled,
            {"email": "person@example.com", "password": "secret"},
        )

    def test_submit_login_form_prefers_sign_in_using_another_account_over_chooser(self):
        page = self.FakePage(
            {
                "login": {
                    "url": linkedin_session.LOGIN_URL,
                    "selectors": {
                        "a:has-text('Sign in using another account')": {
                            "count": 1,
                            "next_state": "form",
                        },
                        "button:has-text('Continue as')": {
                            "count": 1,
                            "next_state": "authed",
                        },
                    },
                },
                "form": {
                    "url": linkedin_session.LOGIN_URL,
                    "selectors": {
                        "input[name='session_key']": {"count": 1, "fill_key": "email"},
                        "input[name='session_password']": {"count": 1, "fill_key": "password"},
                        "button[type='submit']": {"count": 1, "next_state": "submitted"},
                    },
                },
                "authed": {
                    "url": "https://www.linkedin.com/feed/",
                    "selectors": {},
                },
                "submitted": {
                    "url": "https://www.linkedin.com/feed/",
                    "selectors": {},
                },
            },
            initial_state="login",
        )

        result = linkedin_session._submit_login_form(
            page,
            email="person@example.com",
            password="secret",
            timeout_ms=1000,
        )

        self.assertEqual(result, "form_submitted")
        self.assertEqual(page.state, "submitted")
        self.assertEqual(
            page.filled,
            {"email": "person@example.com", "password": "secret"},
        )

    def test_attempt_auto_relogin_reuses_saved_session_without_credentials(self):
        with self.with_temp_db():
            with tempfile.NamedTemporaryFile(suffix=".json") as storage_state_file:
                opened = {}

                @contextmanager
                def fake_open_browser_context(**kwargs):
                    opened.update(kwargs)
                    yield object()

                with patch.object(linkedin_session, "get_all_accounts", return_value=[]), patch.object(
                    linkedin_session,
                    "open_browser_context",
                    fake_open_browser_context,
                ), patch.object(
                    linkedin_session,
                    "_attempt_session_reuse_in_context",
                    return_value="session_reused",
                ) as mock_reuse:
                    result = linkedin_session.attempt_auto_relogin(
                        storage_state_path=storage_state_file.name,
                        timeout_ms=1000,
                    )

                self.assertTrue(result["attempted"])
                self.assertTrue(result["recovered"])
                self.assertIn("reused the existing saved session", result["message"])
                self.assertEqual(
                    opened["storage_state_path"],
                    str(Path(storage_state_file.name).resolve()),
                )
                auth_state = db.get_linkedin_auth_state()
                self.assertTrue(auth_state["available"])
                self.assertIsNone(auth_state["last_error"])
                mock_reuse.assert_called_once()

    def test_attempt_auto_relogin_marks_auth_unavailable_when_saved_session_check_fails(self):
        with self.with_temp_db():
            with tempfile.NamedTemporaryFile(suffix=".json") as storage_state_file:
                @contextmanager
                def fake_open_browser_context(**_kwargs):
                    yield object()

                with patch.object(linkedin_session, "get_all_accounts", return_value=[]), patch.object(
                    linkedin_session,
                    "open_browser_context",
                    fake_open_browser_context,
                ), patch.object(
                    linkedin_session,
                    "_attempt_session_reuse_in_context",
                    side_effect=linkedin_session.LinkedInSessionError("LinkedIn session appears to be logged out or expired."),
                ):
                    result = linkedin_session.attempt_auto_relogin(
                        storage_state_path=storage_state_file.name,
                        timeout_ms=1000,
                    )

                self.assertTrue(result["attempted"])
                self.assertFalse(result["recovered"])
                self.assertIn("saved session check failed", result["message"])
                auth_state = db.get_linkedin_auth_state()
                self.assertFalse(auth_state["available"])
                self.assertEqual(auth_state["last_error"], result["message"])

    def test_rotate_linkedin_account_marks_auth_unavailable_when_relogin_fails(self):
        with self.with_temp_db():
            with tempfile.TemporaryDirectory() as temp_dir:
                next_state_path = Path(temp_dir) / "linkedin_auth_state_1.json"
                selected_indexes = []

                @contextmanager
                def fake_open_browser_context(**_kwargs):
                    yield object()

                with patch.object(
                    linkedin_session,
                    "get_all_accounts",
                    return_value=[
                        {"email": "person1@example.com", "password": "secret1"},
                        {"email": "person2@example.com", "password": "secret2"},
                    ],
                ), patch.object(
                    linkedin_session,
                    "get_active_account_index",
                    return_value=0,
                ), patch.object(
                    linkedin_session,
                    "is_account_blocked",
                    return_value=False,
                ), patch.object(
                    linkedin_session,
                    "set_active_account_index",
                    side_effect=selected_indexes.append,
                ), patch.object(
                    linkedin_session,
                    "get_storage_state_path_for_account",
                    return_value=next_state_path,
                ), patch.object(
                    linkedin_session,
                    "open_browser_context",
                    fake_open_browser_context,
                ), patch.object(
                    linkedin_session,
                    "_attempt_auto_relogin_in_context",
                    side_effect=linkedin_session.LinkedInSessionError(
                        "LinkedIn session appears to be logged out or expired."
                    ),
                ):
                    result = linkedin_session.rotate_linkedin_account(timeout_ms=1000)

            self.assertTrue(result["rotated"])
            self.assertFalse(result["recovered"])
            self.assertEqual(selected_indexes, [1])
            self.assertIn("Rotated to account 1 but relogin failed", result["message"])
            auth_state = db.get_linkedin_auth_state()
            self.assertFalse(auth_state["available"])
            self.assertEqual(auth_state["last_error"], result["message"])

    def test_open_browser_context_reports_missing_display_cleanly(self):
        class FakeChromium:
            def launch(self, **_kwargs):
                raise RuntimeError("Missing X server or $DISPLAY")

        class FakePlaywright:
            chromium = FakeChromium()

        class FakePlaywrightManager:
            def __enter__(self):
                return FakePlaywright()

            def __exit__(self, exc_type, exc, tb):
                return False

        with patch.object(browser_runtime, "load_sync_playwright", return_value=lambda: FakePlaywrightManager()):
            with self.assertRaises(browser_runtime.BrowserRuntimeError) as ctx:
                with browser_runtime.open_browser_context(headless=False, browser_channel="chrome"):
                    pass

        self.assertIn("no X server / DISPLAY is available", str(ctx.exception))

    def test_huntctl_auth_auto_relogin_can_set_display(self):
        captured = {}

        def fake_run(command, *, env=None):
            captured["command"] = command
            captured["env"] = env
            raise SystemExit(0)

        args = type(
            "Args",
            (),
            {
                "timeout_ms": 12345,
                "headful": True,
                "display": ":98",
                "channel": "chrome",
                "storage_state": None,
            },
        )()

        with patch.object(huntctl, "_run", side_effect=fake_run):
            with self.assertRaises(SystemExit) as ctx:
                huntctl.cmd_auth_auto_relogin(args)

        self.assertEqual(ctx.exception.code, 0)
        self.assertEqual(
            captured["command"],
            [
                huntctl.PYTHON,
                "scraper/linkedin_session.py",
                "--auto-relogin",
                "--timeout-ms",
                "12345",
                "--headful",
                "--channel",
                "chrome",
            ],
        )
        self.assertEqual(captured["env"], {"DISPLAY": ":98"})


if __name__ == "__main__":
    unittest.main()
