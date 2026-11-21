"""Tests for the C1 hunter service HTTP API."""

import json
import os
import shutil
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
    def test_service_initializes_a_fresh_database_and_preserves_history_on_restart(self):
        # setUp normally pre-initializes SQLite. Exercise both lifespans on a fresh path.
        os.remove(self.db_path)
        with (
            patch.dict(os.environ, {"HUNT_DB_URL": ""}),
            patch("hunter.config.HUNT_SERVICE_TOKEN", SERVICE_TOKEN),
        ):
            with TestClient(service.app, raise_server_exceptions=False) as client:
                for route in ("/status", "/queue", "/discovery/health"):
                    self.assertEqual(client.get(route, headers=_auth()).status_code, 200)
                self.assertEqual(client.get("/status").status_code, 401)
                job_id = self._insert_job(enrichment_status="processing", enrichment_attempts=7)
                with sqlite3.connect(self.db_path) as conn:
                    conn.execute(
                        "UPDATE jobs SET status='applied', last_enrichment_started_at='2000-01-01 00:00:00' WHERE id=?",
                        (job_id,),
                    )
                conn.close()
            with TestClient(service.app):
                row = db.get_job_by_id(job_id)
        self.assertEqual(row["status"], "applied")
        self.assertEqual(row["enrichment_status"], "processing")
        self.assertEqual(row["enrichment_attempts"], 7)
        self.assertEqual(row["last_enrichment_started_at"], "2000-01-01 00:00:00")

    def setUp(self):
        fd, self.db_path = tempfile.mkstemp(suffix=".db")
        os.close(fd)
        self.audit_dir = tempfile.mkdtemp(prefix="hunt-c1-audit-")
        self.old_db_path = db.DB_PATH
        self.clients = []
        self.env = patch.dict(
            os.environ,
            {
                "HUNT_DB_PATH": self.db_path,
                "HUNT_AUDIT_LOG_ROOT": self.audit_dir,
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
        shutil.rmtree(self.audit_dir, ignore_errors=True)

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
            cursor = conn.execute(
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
            return cursor.lastrowid
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

    def test_discovery_health_and_c3_handoff_endpoints(self):
        job_id = self._insert_job(enrichment_status="done", suffix="c3")
        db.update_selected_resume_for_job(
            job_id,
            version_id="resume-v1",
            pdf_path="C:/private/resume.pdf",
        )
        db.record_discovery_source_health("feed", status="ok", lead_count=3)
        client = self._make_client()

        health = client.get("/discovery/health", headers=_auth())
        ready = client.get("/c3/ready", headers=_auth())
        outcome = client.post(
            f"/jobs/{job_id}/c3-outcome",
            headers=_auth(),
            json={"outcome": "ready_for_review", "reason": "review_page_reached"},
        )
        rejected = client.post(
            f"/jobs/{job_id}/c3-outcome",
            headers=_auth(),
            json={"outcome": "blocked", "reason": "contains personal prose"},
        )

        self.assertEqual(health.status_code, 200)
        self.assertEqual(health.json()["sources"][0]["lead_count"], 3)
        self.assertEqual(ready.status_code, 200)
        self.assertEqual(ready.json()["jobs"][0]["job_id"], str(job_id))
        self.assertEqual(outcome.status_code, 200)
        self.assertEqual(rejected.status_code, 400)

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
        self.assertEqual(response.headers.get("X-Hunt-Audit-Status"), "written")
        scrape_mock.assert_called_once_with(enrich_pending=False, enrich_limit=7)
        self.assertFalse(service._is_scrape_running())
        with open(
            os.path.join(self.audit_dir, "human-commands.jsonl"),
            encoding="utf-8",
        ) as stream:
            event = json.loads(stream.readline())
        self.assertEqual(event["component"], "c1")
        self.assertEqual(event["payload"]["details"]["route"], "/scrape")

    def test_query_health_does_not_overwrite_another_query_failure(self):
        from hunter.scraper import _scrape_jobspy_task

        with patch(
            "hunter.scraper.discover_linkedin_query",
            side_effect=[
                RuntimeError("blocked"),
                ([], {"status": "ok", "error": None, "lead_count": 0}),
            ],
        ):
            _scrape_jobspy_task("linkedin", "developer", "Canada", "engineering", 336)
            _scrape_jobspy_task("linkedin", "analyst", "Canada", "data", 336)
        rows = db.list_discovery_source_health()
        self.assertEqual(len(rows), 2)
        self.assertEqual({row["status"] for row in rows}, {"ok", "failed"})

    def test_active_scrape_and_enrich_reject_duplicate_requests(self):
        client = self._make_client()
        cases = [
            (
                "/scrape",
                {"enrich_after": True, "enrich_limit": 3},
                "hunter.scraper.scrape",
                "Scrape already running",
                service._is_scrape_running,
            ),
            (
                "/enrich",
                {"limit": 9},
                "hunter.enrichment_dispatch.run_enrichment_round",
                "Enrichment already running",
                service._is_enrich_running,
            ),
        ]
        for endpoint, body, worker, message, is_running in cases:
            with self.subTest(endpoint=endpoint):
                started, release = threading.Event(), threading.Event()
                responses = []

                def block(**kwargs):
                    started.set()
                    release.wait(timeout=5)
                    return {"ok": True}

                def post():
                    return client.post(endpoint, headers=_auth(), json=body)

                with patch(worker, side_effect=block):
                    thread = threading.Thread(target=lambda: responses.append(post()))
                    thread.start()
                    try:
                        self.assertTrue(started.wait(timeout=5))
                        second = post()
                    finally:
                        release.set()
                        thread.join(timeout=5)
                self.assertEqual(responses[0].status_code, 200)
                self.assertEqual(second.status_code, 409)
                self.assertEqual(second.json()["detail"], message)
                self.assertFalse(is_running())


if __name__ == "__main__":
    unittest.main()
