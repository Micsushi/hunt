"""Phase 9 tests: coordinator service API (HTTP layer) via FastAPI TestClient."""

import json
import os
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

REPO_ROOT = Path(__file__).resolve().parent.parent
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from fastapi.testclient import TestClient  # noqa: E402

from coordinator.service_api import app  # noqa: E402
from hunter import db  # noqa: E402

SERVICE_TOKEN = "test-api-token"


def _auth():
    return {"Authorization": f"Bearer {SERVICE_TOKEN}"}


class CoordinatorServiceApiTests(unittest.TestCase):
    def make_temp_db_path(self):
        fd, path = tempfile.mkstemp(suffix=".db")
        os.close(fd)
        return path

    def with_temp_context(self):
        """Combined context: temp DB + temp runtime root + patched service token."""

        class TempContext:
            def __init__(self, outer):
                self.outer = outer
                self.db_fd, self.db_path = tempfile.mkstemp(suffix=".db")
                os.close(self.db_fd)
                self.root = tempfile.TemporaryDirectory()
                self.old_db_path = db.DB_PATH
                self._patches = []

            def __enter__(self):
                db.DB_PATH = self.db_path
                db.init_db()

                os.environ["HUNT_DB_PATH"] = self.db_path
                os.environ.pop("HUNT_COORDINATOR_ROOT", None)
                os.environ.pop("HUNT_ORCHESTRATION_ROOT", None)
                os.environ["HUNT_COORDINATOR_ROOT"] = self.root.name

                # Patch the module-level constant so require_service_token enforces auth
                p = patch("hunter.config.HUNT_SERVICE_TOKEN", SERVICE_TOKEN)
                p.start()
                self._patches.append(p)

                return self.db_path, self.root.name

            def __exit__(self, exc_type, exc, tb):
                for p in self._patches:
                    p.stop()
                db.DB_PATH = self.old_db_path
                os.environ.pop("HUNT_DB_PATH", None)
                for key in ("HUNT_COORDINATOR_ROOT", "HUNT_ORCHESTRATION_ROOT"):
                    os.environ.pop(key, None)
                if os.path.exists(self.db_path):
                    os.remove(self.db_path)
                self.root.cleanup()

        return TempContext(self)

    def insert_ready_job(self, path, *, resume_path, job_url_suffix="8001"):
        conn = sqlite3.connect(path)
        try:
            conn.execute(
                """
                INSERT INTO jobs (
                    title, company, location, job_url, apply_url, description,
                    source, date_posted, is_remote, level, priority, category,
                    apply_type, auto_apply_eligible, enrichment_status,
                    enrichment_attempts, apply_host, ats_type, last_enrichment_error,
                    last_enrichment_started_at, next_enrichment_retry_at,
                    latest_resume_job_description_path, latest_resume_flags,
                    selected_resume_version_id, selected_resume_pdf_path,
                    selected_resume_tex_path, selected_resume_selected_at,
                    selected_resume_ready_for_c3
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    "Backend Engineer", "Acme", "Canada",
                    f"https://www.linkedin.com/jobs/view/{job_url_suffix}",
                    f"https://acme.wd5.myworkdayjobs.com/job/{job_url_suffix}",
                    "A good role.", "linkedin", "2026-04-10", 1, "junior",
                    0, "engineering", "external_apply", 1, "done", 1,
                    "acme.wd5.myworkdayjobs.com", "workday", None, None, None,
                    "", "", "resume-v9", resume_path, str(REPO_ROOT / "main.tex"),
                    None, 1,
                ),
            )
            conn.commit()
            return conn.execute(
                "SELECT id FROM jobs WHERE job_url = ?",
                (f"https://www.linkedin.com/jobs/view/{job_url_suffix}",),
            ).fetchone()[0]
        finally:
            conn.close()

    def test_status_returns_401_without_token(self):
        with self.with_temp_context():
            client = TestClient(app, raise_server_exceptions=False)
            resp = client.get("/status")
        self.assertEqual(resp.status_code, 401)

    def test_status_returns_coordinator_service(self):
        with self.with_temp_context():
            client = TestClient(app, raise_server_exceptions=False)
            resp = client.get("/status", headers=_auth())
        self.assertEqual(resp.status_code, 200)
        data = resp.json()
        self.assertEqual(data["service"], "c4-coordinator")
        self.assertIn("ready_count", data)
        self.assertIn("global_hold", data)

    def test_runs_returns_empty_list_on_fresh_db(self):
        with self.with_temp_context():
            client = TestClient(app, raise_server_exceptions=False)
            resp = client.get("/runs", headers=_auth())
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.json()["runs"], [])

    def test_post_run_starts_run_and_records_in_db(self):
        with self.with_temp_context() as (path, _runtime):
            with tempfile.NamedTemporaryFile(suffix=".pdf", delete=False) as f:
                f.write(b"%PDF-1.4 api-test")
                f.flush()
                resume_path = f.name
            try:
                job_id = self.insert_ready_job(path, resume_path=resume_path)
                client = TestClient(app, raise_server_exceptions=False)
                resp = client.post("/run", headers=_auth(), json={"job_id": job_id})
                runs_resp = client.get("/runs", headers=_auth())
            finally:
                if os.path.exists(resume_path):
                    os.remove(resume_path)

        self.assertEqual(resp.status_code, 200)
        run = resp.json()
        self.assertEqual(run["job_id"], job_id)
        self.assertEqual(run["status"], "apply_prepared")
        self.assertEqual(len(runs_resp.json()["runs"]), 1)

    def test_post_run_returns_400_for_unknown_job(self):
        with self.with_temp_context():
            client = TestClient(app, raise_server_exceptions=False)
            resp = client.post("/run", headers=_auth(), json={"job_id": 9999})
        self.assertEqual(resp.status_code, 400)

    def test_c3_pending_fills_returns_empty_when_no_fills(self):
        with self.with_temp_context():
            client = TestClient(app, raise_server_exceptions=False)
            resp = client.get("/c3/pending-fills", headers=_auth())
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.json()["fills"], [])

    def test_c3_fill_result_round_trip_via_http(self):
        """Full C3 HTTP round-trip: start run → request fill → poll → post inline result."""
        with self.with_temp_context() as (path, runtime_root):
            with tempfile.NamedTemporaryFile(suffix=".pdf", delete=False) as f:
                f.write(b"%PDF-1.4 http-round-trip")
                f.flush()
                resume_path = f.name
            try:
                job_id = self.insert_ready_job(path, resume_path=resume_path)
                from coordinator.service import OrchestrationService
                svc = OrchestrationService(db_path=path, runtime_root=runtime_root)
                context = svc.build_apply_context(job_id)
                svc.request_fill(context.run_id)

                client = TestClient(app, raise_server_exceptions=False)

                fills_resp = client.get("/c3/pending-fills", headers=_auth())
                fills = fills_resp.json()["fills"]

                fill_result_resp = client.post(
                    "/c3/fill-result",
                    headers=_auth(),
                    json={
                        "run_id": context.run_id,
                        "payload": {
                            "status": "ok",
                            "resumeUploadOk": True,
                            "generatedAnswersUsed": True,
                            "finalUrl": "https://acme.wd5.myworkdayjobs.com/job/8001/thanks",
                        },
                    },
                )
                fills_after_resp = client.get("/c3/pending-fills", headers=_auth())
                run_resp = client.get(f"/runs/{context.run_id}", headers=_auth())
            finally:
                if os.path.exists(resume_path):
                    os.remove(resume_path)

        self.assertEqual(fills_resp.status_code, 200)
        self.assertEqual(len(fills), 1)
        self.assertEqual(fills[0]["run_id"], context.run_id)
        self.assertIn("c3_payload", fills[0])

        self.assertEqual(fill_result_resp.status_code, 200)
        self.assertEqual(fill_result_resp.json()["run"]["status"], "awaiting_submit_approval")

        self.assertEqual(fills_after_resp.json()["fills"], [])
        self.assertEqual(run_resp.json()["status"], "awaiting_submit_approval")

    def test_c3_fill_result_returns_400_for_unknown_run(self):
        with self.with_temp_context():
            client = TestClient(app, raise_server_exceptions=False)
            resp = client.post(
                "/c3/fill-result",
                headers=_auth(),
                json={
                    "run_id": "run-does-not-exist",
                    "payload": {"status": "ok"},
                },
            )
        self.assertEqual(resp.status_code, 400)

    def test_one_active_run_blocks_new_run_for_same_job(self):
        """A second /run request for a job already in progress returns 400."""
        with self.with_temp_context() as (path, _runtime):
            with tempfile.NamedTemporaryFile(suffix=".pdf", delete=False) as f:
                f.write(b"%PDF-1.4 blocking-test")
                f.flush()
                resume_path = f.name
            try:
                job_id = self.insert_ready_job(path, resume_path=resume_path)
                client = TestClient(app, raise_server_exceptions=False)
                first = client.post("/run", headers=_auth(), json={"job_id": job_id})
                second = client.post("/run", headers=_auth(), json={"job_id": job_id})
            finally:
                if os.path.exists(resume_path):
                    os.remove(resume_path)

        self.assertEqual(first.status_code, 200)
        self.assertEqual(second.status_code, 400)

    def test_approve_submit_transitions_to_submit_approved(self):
        with self.with_temp_context() as (path, runtime_root):
            with tempfile.NamedTemporaryFile(suffix=".pdf", delete=False) as f:
                f.write(b"%PDF-1.4 approve-test")
                f.flush()
                resume_path = f.name
            try:
                job_id = self.insert_ready_job(path, resume_path=resume_path)
                from coordinator.service import OrchestrationService
                svc = OrchestrationService(db_path=path, runtime_root=runtime_root)
                context = svc.build_apply_context(job_id)
                svc.request_fill(context.run_id)
                svc.record_fill_result_inline(
                    context.run_id, {"status": "ok", "resumeUploadOk": True}
                )

                client = TestClient(app, raise_server_exceptions=False)
                approve_resp = client.post(
                    f"/runs/{context.run_id}/approve",
                    headers=_auth(),
                    json={
                        "decision": "approve",
                        "approved_by": "operator",
                        "reason": "looks good",
                    },
                )
            finally:
                if os.path.exists(resume_path):
                    os.remove(resume_path)

        self.assertEqual(approve_resp.status_code, 200)
        self.assertEqual(approve_resp.json()["run"]["status"], "submit_approved")

    def test_approve_submit_deny_marks_submit_denied(self):
        with self.with_temp_context() as (path, runtime_root):
            with tempfile.NamedTemporaryFile(suffix=".pdf", delete=False) as f:
                f.write(b"%PDF-1.4 deny-test")
                f.flush()
                resume_path = f.name
            try:
                job_id = self.insert_ready_job(path, resume_path=resume_path)
                from coordinator.service import OrchestrationService
                svc = OrchestrationService(db_path=path, runtime_root=runtime_root)
                context = svc.build_apply_context(job_id)
                svc.request_fill(context.run_id)
                svc.record_fill_result_inline(
                    context.run_id, {"status": "ok", "resumeUploadOk": True}
                )

                client = TestClient(app, raise_server_exceptions=False)
                deny_resp = client.post(
                    f"/runs/{context.run_id}/approve",
                    headers=_auth(),
                    json={
                        "decision": "deny",
                        "approved_by": "operator",
                        "reason": "wrong company",
                    },
                )
                run_resp = client.get(f"/runs/{context.run_id}", headers=_auth())
            finally:
                if os.path.exists(resume_path):
                    os.remove(resume_path)

        self.assertEqual(deny_resp.status_code, 200)
        self.assertEqual(deny_resp.json()["run"]["status"], "submit_denied")
        self.assertEqual(run_resp.json()["status"], "submit_denied")
        self.assertIsNotNone(run_resp.json()["final_status_path"])


if __name__ == "__main__":
    unittest.main()
