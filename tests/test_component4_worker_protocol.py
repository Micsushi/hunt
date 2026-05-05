"""C4 worker lease protocol tests for C3/OpenClaw/Hermes runtimes."""

from __future__ import annotations

import os
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from coordinator.service import OrchestrationService  # noqa: E402
from hunter import db  # noqa: E402


class Component4WorkerProtocolTests(unittest.TestCase):
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

    def with_temp_orchestration_root(self):
        class TempRootContext:
            def __init__(self):
                self.root = tempfile.TemporaryDirectory()
                self.old_coord = os.environ.get("HUNT_COORDINATOR_ROOT")
                self.old_orch = os.environ.get("HUNT_ORCHESTRATION_ROOT")

            def __enter__(self):
                os.environ.pop("HUNT_COORDINATOR_ROOT", None)
                os.environ.pop("HUNT_ORCHESTRATION_ROOT", None)
                os.environ["HUNT_COORDINATOR_ROOT"] = self.root.name
                return self.root.name

            def __exit__(self, exc_type, exc, tb):
                for key in ("HUNT_COORDINATOR_ROOT", "HUNT_ORCHESTRATION_ROOT"):
                    os.environ.pop(key, None)
                if self.old_coord is not None:
                    os.environ["HUNT_COORDINATOR_ROOT"] = self.old_coord
                if self.old_orch is not None:
                    os.environ["HUNT_ORCHESTRATION_ROOT"] = self.old_orch
                self.root.cleanup()

        return TempRootContext()

    def insert_job(self, path, *, resume_path, suffix="worker"):
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
                    "Backend Engineer",
                    "Acme",
                    "Canada",
                    f"https://www.linkedin.com/jobs/view/{suffix}",
                    f"https://acme.wd5.myworkdayjobs.com/job/{suffix}",
                    "A good role.",
                    "linkedin",
                    "2026-04-10",
                    1,
                    "junior",
                    0,
                    "engineering",
                    "external_apply",
                    1,
                    "done",
                    1,
                    "acme.wd5.myworkdayjobs.com",
                    "workday",
                    None,
                    None,
                    None,
                    "",
                    "",
                    f"resume-{suffix}",
                    resume_path,
                    str(REPO_ROOT / "main.tex"),
                    None,
                    1,
                ),
            )
            conn.commit()
            return conn.execute(
                "SELECT id FROM jobs WHERE job_url = ?",
                (f"https://www.linkedin.com/jobs/view/{suffix}",),
            ).fetchone()[0]
        finally:
            conn.close()

    def prepare_fill_requested_run(self, path, runtime_root, *, suffix="worker"):
        resume_file = tempfile.NamedTemporaryFile(suffix=".pdf", delete=False)
        resume_file.write(b"%PDF-1.4 worker-protocol")
        resume_file.flush()
        resume_file.close()
        resume_path = resume_file.name

        job_id = self.insert_job(path, resume_path=resume_path, suffix=suffix)
        service = OrchestrationService(db_path=path, runtime_root=runtime_root)
        context = service.build_apply_context(job_id)
        service.request_fill(context.run_id)
        return service, context.run_id, resume_path

    def get_lease_row(self, path, lease_id):
        conn = sqlite3.connect(path)
        conn.row_factory = sqlite3.Row
        try:
            row = conn.execute(
                "SELECT * FROM orchestration_worker_leases WHERE id = ?",
                (lease_id,),
            ).fetchone()
            return dict(row) if row else None
        finally:
            conn.close()

    def test_claim_pending_fill_creates_lease_and_hides_from_second_worker(self):
        with self.with_temp_db() as path:
            with self.with_temp_orchestration_root() as runtime_root:
                service, run_id, resume_path = self.prepare_fill_requested_run(path, runtime_root)
                try:
                    first = service.claim_next_fill(
                        runtime_name="openclaw_isolated",
                        browser_lane="isolated",
                        lease_seconds=120,
                        worker_metadata={"test": True},
                    )
                    second = service.claim_next_fill(
                        runtime_name="hermes_local",
                        browser_lane="isolated",
                        lease_seconds=120,
                    )
                finally:
                    if os.path.exists(resume_path):
                        os.remove(resume_path)

        self.assertTrue(first["claimed"])
        self.assertEqual(first["fill"]["run_id"], run_id)
        self.assertEqual(first["lease"]["status"], "active")
        self.assertEqual(first["lease"]["runtime_name"], "openclaw_isolated")
        self.assertFalse(second["claimed"])
        self.assertEqual(second["reason"], "no_pending_fills")

    def test_heartbeat_extends_active_lease(self):
        with self.with_temp_db() as path:
            with self.with_temp_orchestration_root() as runtime_root:
                service, _run_id, resume_path = self.prepare_fill_requested_run(path, runtime_root)
                try:
                    claimed = service.claim_next_fill(
                        runtime_name="openclaw_isolated",
                        browser_lane="isolated",
                        lease_seconds=60,
                    )
                    lease_id = claimed["lease"]["lease_id"]
                    old_expires_at = "2099-01-01T00:00:00+00:00"
                    conn = sqlite3.connect(path)
                    try:
                        conn.execute(
                            "UPDATE orchestration_worker_leases SET expires_at = ? WHERE id = ?",
                            (old_expires_at, lease_id),
                        )
                        conn.commit()
                    finally:
                        conn.close()
                    heartbeat = service.heartbeat_lease(lease_id, lease_seconds=120)
                finally:
                    if os.path.exists(resume_path):
                        os.remove(resume_path)

        self.assertEqual(heartbeat["lease"]["status"], "active")
        self.assertNotEqual(heartbeat["lease"]["expires_at"], old_expires_at)
        self.assertIsNotNone(heartbeat["lease"]["heartbeat_at"])

    def test_expired_lease_makes_fill_claimable_again(self):
        with self.with_temp_db() as path:
            with self.with_temp_orchestration_root() as runtime_root:
                service, run_id, resume_path = self.prepare_fill_requested_run(path, runtime_root)
                try:
                    first = service.claim_next_fill(
                        runtime_name="openclaw_isolated",
                        browser_lane="isolated",
                        lease_seconds=60,
                    )
                    first_lease_id = first["lease"]["lease_id"]
                    conn = sqlite3.connect(path)
                    try:
                        conn.execute(
                            "UPDATE orchestration_worker_leases SET expires_at = ? WHERE id = ?",
                            ("2000-01-01T00:00:00+00:00", first_lease_id),
                        )
                        conn.commit()
                    finally:
                        conn.close()
                    second = service.claim_next_fill(
                        runtime_name="hermes_local",
                        browser_lane="isolated",
                        lease_seconds=60,
                    )
                    first_row = self.get_lease_row(path, first_lease_id)
                finally:
                    if os.path.exists(resume_path):
                        os.remove(resume_path)

        self.assertTrue(second["claimed"])
        self.assertEqual(second["fill"]["run_id"], run_id)
        self.assertEqual(second["lease"]["runtime_name"], "hermes_local")
        self.assertEqual(first_row["status"], "timed_out")

    def test_worker_result_completes_lease_and_records_fill_result(self):
        with self.with_temp_db() as path:
            with self.with_temp_orchestration_root() as runtime_root:
                service, _run_id, resume_path = self.prepare_fill_requested_run(path, runtime_root)
                try:
                    claimed = service.claim_next_fill(
                        runtime_name="openclaw_isolated",
                        browser_lane="isolated",
                        lease_seconds=60,
                    )
                    result = service.complete_lease_with_result(
                        claimed["lease"]["lease_id"],
                        {
                            "status": "ok",
                            "resumeUploadOk": True,
                            "generatedAnswersUsed": False,
                            "finalUrl": claimed["fill"]["apply_url"],
                        },
                    )
                    pending = service.get_pending_fills()
                finally:
                    if os.path.exists(resume_path):
                        os.remove(resume_path)

        self.assertEqual(result["lease"]["status"], "completed")
        self.assertEqual(result["run"]["status"], "awaiting_submit_approval")
        self.assertEqual(pending, [])

    def test_reconcile_marks_expired_fill_requested_run_manual_review(self):
        with self.with_temp_db() as path:
            with self.with_temp_orchestration_root() as runtime_root:
                service, run_id, resume_path = self.prepare_fill_requested_run(path, runtime_root)
                try:
                    conn = sqlite3.connect(path)
                    try:
                        conn.execute(
                            "UPDATE orchestration_runs SET updated_at = ? WHERE id = ?",
                            ("2000-01-01T00:00:00+00:00", run_id),
                        )
                        conn.commit()
                    finally:
                        conn.close()
                    result = service.reconcile_stale_runs(fill_timeout_minutes=30)
                    run = service.get_run(run_id)
                finally:
                    if os.path.exists(resume_path):
                        os.remove(resume_path)

        self.assertEqual(result["runs_marked_manual_review"], [run_id])
        self.assertEqual(run.status, "manual_review")
        self.assertEqual(run.manual_review_reason, "worker_timeout")

    def test_reconcile_leaves_awaiting_submit_approval_unchanged(self):
        with self.with_temp_db() as path:
            with self.with_temp_orchestration_root() as runtime_root:
                service, run_id, resume_path = self.prepare_fill_requested_run(path, runtime_root)
                try:
                    service.record_fill_result_inline(
                        run_id,
                        {
                            "status": "ok",
                            "resumeUploadOk": True,
                            "finalUrl": "https://acme.wd5.myworkdayjobs.com/job/review",
                        },
                    )
                    conn = sqlite3.connect(path)
                    try:
                        conn.execute(
                            "UPDATE orchestration_runs SET updated_at = ? WHERE id = ?",
                            ("2000-01-01T00:00:00+00:00", run_id),
                        )
                        conn.commit()
                    finally:
                        conn.close()
                    result = service.reconcile_stale_runs(fill_timeout_minutes=30)
                    run = service.get_run(run_id)
                finally:
                    if os.path.exists(resume_path):
                        os.remove(resume_path)

        self.assertEqual(result["runs_marked_manual_review"], [])
        self.assertEqual(run.status, "awaiting_submit_approval")


if __name__ == "__main__":
    unittest.main()
