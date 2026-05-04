"""Tests for the C1 hunter service HTTP API."""

import os
import sqlite3
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi.testclient import TestClient

REPO_ROOT = Path(__file__).resolve().parent.parent
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from hunter import db, service  # noqa: E402

SERVICE_TOKEN = "test-c1-token"


def _auth():
    return {"Authorization": f"Bearer {SERVICE_TOKEN}"}


class HunterServiceApiTests(unittest.TestCase):
    def setUp(self):
        fd, self.db_path = tempfile.mkstemp(suffix=".db")
        os.close(fd)
        self.old_db_path = db.DB_PATH
        self.clients = []
        self.env = patch.dict(
            os.environ,
            {
                "HUNT_DB_PATH": self.db_path,
            },
            clear=False,
        )
        self.env.start()
        db.DB_PATH = self.db_path
        db.init_db()
        self._reset_service_flags()

    def tearDown(self):
        for client in self.clients:
            client.close()
        self._reset_service_flags()
        db.DB_PATH = self.old_db_path
        self.env.stop()
        if os.path.exists(self.db_path):
            os.remove(self.db_path)

    def _reset_service_flags(self):
        with service._scrape_lock:
            service._scrape_running = False
        with service._enrich_lock:
            service._enrich_running = False

    def _make_client(self):
        token_patch = patch("hunter.config.HUNT_SERVICE_TOKEN", SERVICE_TOKEN)
        token_patch.start()
        self.addCleanup(token_patch.stop)
        client = TestClient(service.app, raise_server_exceptions=False)
        self.clients.append(client)
        return client

    def _insert_job(
        self,
        *,
        source="indeed",
        enrichment_status="pending",
        next_enrichment_retry_at=None,
        enrichment_attempts=0,
        suffix="1",
    ):
        conn = sqlite3.connect(self.db_path)
        try:
            conn.execute(
                """
                INSERT INTO jobs (
                    title, company, location, job_url, apply_url, description,
                    source, date_posted, is_remote, level, priority, category,
                    apply_type, auto_apply_eligible, enrichment_status,
                    enrichment_attempts, apply_host, ats_type, next_enrichment_retry_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    f"Role {suffix}",
                    "Acme",
                    "Canada",
                    f"https://example.com/jobs/{suffix}",
                    f"https://apply.example.com/jobs/{suffix}",
                    "Job description",
                    source,
                    "2026-05-01",
                    1,
                    "junior",
                    0,
                    "engineering",
                    "external_apply",
                    1,
                    enrichment_status,
                    enrichment_attempts,
                    "apply.example.com",
                    "workday",
                    next_enrichment_retry_at,
                ),
            )
            conn.commit()
        finally:
            conn.close()

    def _insert_linkedin_account(self, account_id=1):
        conn = sqlite3.connect(self.db_path)
        try:
            conn.execute(
                """
                INSERT INTO linkedin_accounts (id, username, display_name, active, auth_state)
                VALUES (?, ?, ?, ?, ?)
                """,
                (account_id, "user@example.com", "Primary", 1, "unknown"),
            )
            conn.commit()
        finally:
            conn.close()

    def test_status_returns_401_without_token(self):
        client = TestClient(service.app, raise_server_exceptions=False)
        with patch("hunter.config.HUNT_SERVICE_TOKEN", SERVICE_TOKEN):
            response = client.get("/status")
        self.assertEqual(response.status_code, 401)

    def test_status_reports_service_flags_queue_and_auth_state(self):
        self._insert_job(source="indeed", enrichment_status="pending", suffix="pending")
        self._insert_job(
            source="indeed",
            enrichment_status="failed",
            enrichment_attempts=1,
            next_enrichment_retry_at="2000-01-01 00:00:00",
            suffix="ready",
        )
        db.mark_linkedin_auth_unavailable("cookie expired")
        client = self._make_client()

        response = client.get("/status", headers=_auth())

        self.assertEqual(response.status_code, 200)
        self.assertEqual(
            response.json(),
            {
                "service": "c1-hunter",
                "scrape_running": False,
                "enrich_running": False,
                "queue": {"pending": 1, "ready": 2},
                "linkedin_auth": {
                    "status": "expired",
                    "available": False,
                    "last_error": "cookie expired",
                    "updated_at": response.json()["linkedin_auth"]["updated_at"],
                },
            },
        )
        self.assertIsNotNone(response.json()["linkedin_auth"]["updated_at"])

    def test_queue_returns_pending_and_ready_counts(self):
        self._insert_job(source="indeed", enrichment_status="pending", suffix="a")
        self._insert_job(
            source="indeed",
            enrichment_status="failed",
            enrichment_attempts=1,
            next_enrichment_retry_at="2000-01-01 00:00:00",
            suffix="b",
        )
        client = self._make_client()

        response = client.get("/queue", headers=_auth())

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {"pending": 1, "ready": 2})

    def test_scrape_starts_background_task_with_request_values(self):
        client = self._make_client()

        with patch("hunter.scraper.scrape") as scrape_mock:
            response = client.post(
                "/scrape",
                headers=_auth(),
                json={"enrich_after": False, "enrich_limit": 7},
            )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {"status": "started"})
        scrape_mock.assert_called_once_with(enrich_pending=False, enrich_limit=7)
        self.assertFalse(service._is_scrape_running())

    def test_scrape_rejects_duplicate_run_while_first_is_active(self):
        client = self._make_client()
        started = threading.Event()
        release = threading.Event()
        first_response = {}

        def blocking_scrape(*, enrich_pending, enrich_limit):
            started.set()
            release.wait(timeout=5)

        def run_first_request():
            first_response["response"] = client.post(
                "/scrape",
                headers=_auth(),
                json={"enrich_after": True, "enrich_limit": 3},
            )

        with patch("hunter.scraper.scrape", side_effect=blocking_scrape):
            thread = threading.Thread(target=run_first_request)
            thread.start()
            self.assertTrue(started.wait(timeout=5))

            second = client.post(
                "/scrape",
                headers=_auth(),
                json={"enrich_after": True, "enrich_limit": 3},
            )

            release.set()
            thread.join(timeout=5)

        self.assertEqual(first_response["response"].status_code, 200)
        self.assertEqual(second.status_code, 409)
        self.assertEqual(second.json()["detail"], "Scrape already running")
        self.assertFalse(service._is_scrape_running())

    def test_enrich_starts_background_task_with_default_limit(self):
        client = self._make_client()

        with patch("hunter.config.ENRICHMENT_BATCH_LIMIT", 42):
            with patch("hunter.enrichment_dispatch.run_enrichment_round") as enrich_mock:
                response = client.post("/enrich", headers=_auth(), json={})

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {"status": "started", "limit": 42})
        enrich_mock.assert_called_once_with(limit=42, return_summary=True)
        self.assertFalse(service._is_enrich_running())

    def test_enrich_rejects_duplicate_run_while_first_is_active(self):
        client = self._make_client()
        started = threading.Event()
        release = threading.Event()
        first_response = {}

        def blocking_enrich(*, limit, return_summary):
            started.set()
            release.wait(timeout=5)
            return {"ok": True}

        def run_first_request():
            first_response["response"] = client.post(
                "/enrich",
                headers=_auth(),
                json={"limit": 9},
            )

        with patch("hunter.enrichment_dispatch.run_enrichment_round", side_effect=blocking_enrich):
            thread = threading.Thread(target=run_first_request)
            thread.start()
            self.assertTrue(started.wait(timeout=5))

            second = client.post("/enrich", headers=_auth(), json={"limit": 9})

            release.set()
            thread.join(timeout=5)

        self.assertEqual(first_response["response"].status_code, 200)
        self.assertEqual(second.status_code, 409)
        self.assertEqual(second.json()["detail"], "Enrichment already running")
        self.assertFalse(service._is_enrich_running())

    def test_reauth_starts_session_refresh_for_existing_account(self):
        self._insert_linkedin_account(account_id=7)
        client = self._make_client()

        with patch("hunter.enrichment_dispatch.ensure_linkedin_session") as reauth_mock:
            response = client.post("/accounts/7/reauth", headers=_auth())

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {"status": "started", "account_id": 7})
        reauth_mock.assert_called_once_with(
            storage_state_path=None,
            headless=True,
            slow_mo=0,
            timeout_ms=45000,
            browser_channel=None,
        )

    def test_reauth_returns_404_for_unknown_account(self):
        client = self._make_client()

        response = client.post("/accounts/99/reauth", headers=_auth())

        self.assertEqual(response.status_code, 404)
        self.assertEqual(response.json()["detail"], "Account not found")


if __name__ == "__main__":
    unittest.main()
