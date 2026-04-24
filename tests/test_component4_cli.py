import io
import json
import os
import sqlite3
import sys
import tempfile
import unittest
from argparse import Namespace
from contextlib import redirect_stdout
from pathlib import Path
from unittest.mock import patch

REPO_ROOT = Path(__file__).resolve().parent.parent
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from coordinator.cli import main  # noqa: E402
from coordinator.service import OrchestrationService  # noqa: E402
from hunter import db  # noqa: E402
from scripts import hunterctl  # noqa: E402


class Component4CliTests(unittest.TestCase):
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

    def insert_job(self, path, **overrides):
        defaults = {
            "title": "Software Engineer",
            "company": "Acme",
            "location": "Canada",
            "job_url": "https://www.linkedin.com/jobs/view/123",
            "apply_url": "https://acme.wd5.myworkdayjobs.com/en-US/Careers/job/123",
            "description": "Interesting entry-level role.",
            "source": "linkedin",
            "date_posted": "2026-04-06",
            "is_remote": 1,
            "level": "junior",
            "priority": 0,
            "category": "engineering",
            "apply_type": "external_apply",
            "auto_apply_eligible": 1,
            "enrichment_status": "done",
            "enrichment_attempts": 1,
            "apply_host": "acme.wd5.myworkdayjobs.com",
            "ats_type": "workday",
            "last_enrichment_error": None,
            "last_enrichment_started_at": None,
            "next_enrichment_retry_at": None,
            "latest_resume_job_description_path": "",
            "latest_resume_flags": "",
            "selected_resume_version_id": "",
            "selected_resume_pdf_path": "",
            "selected_resume_tex_path": "",
            "selected_resume_selected_at": None,
            "selected_resume_ready_for_c3": 0,
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
                    enrichment_attempts, apply_host, ats_type, last_enrichment_error,
                    last_enrichment_started_at, next_enrichment_retry_at,
                    latest_resume_job_description_path, latest_resume_flags,
                    selected_resume_version_id, selected_resume_pdf_path,
                    selected_resume_tex_path, selected_resume_selected_at,
                    selected_resume_ready_for_c3
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
                    defaults["last_enrichment_error"],
                    defaults["last_enrichment_started_at"],
                    defaults["next_enrichment_retry_at"],
                    defaults["latest_resume_job_description_path"],
                    defaults["latest_resume_flags"],
                    defaults["selected_resume_version_id"],
                    defaults["selected_resume_pdf_path"],
                    defaults["selected_resume_tex_path"],
                    defaults["selected_resume_selected_at"],
                    defaults["selected_resume_ready_for_c3"],
                ),
            )
            conn.commit()
            return conn.execute(
                "SELECT id FROM jobs WHERE job_url = ?",
                (defaults["job_url"],),
            ).fetchone()[0]
        finally:
            conn.close()

    def write_json_file(self, payload):
        handle = tempfile.NamedTemporaryFile("w", suffix=".json", delete=False, encoding="utf-8")
        try:
            json.dump(payload, handle)
            handle.write("\n")
            handle.close()
            return handle.name
        except Exception:
            handle.close()
            if os.path.exists(handle.name):
                os.remove(handle.name)
            raise

    def read_json(self, path):
        return json.loads(Path(path).read_text(encoding="utf-8"))

    def get_job_row(self, path, job_id):
        conn = sqlite3.connect(path)
        conn.row_factory = sqlite3.Row
        try:
            row = conn.execute("SELECT * FROM jobs WHERE id = ?", (job_id,)).fetchone()
            return dict(row) if row else None
        finally:
            conn.close()

    def make_service(self, path, runtime_root):
        return OrchestrationService(db_path=path, runtime_root=runtime_root)

    def test_ready_command_returns_json(self) -> None:
        stdout = io.StringIO()
        with self.with_temp_db() as path:
            job_id = self.insert_job(
                path,
                apply_type="easy_apply",
                auto_apply_eligible=0,
                selected_resume_ready_for_c3=0,
            )
            with redirect_stdout(stdout):
                exit_code = main(["ready", "--db-path", path, "--job-id", str(job_id)])
        self.assertEqual(exit_code, 0)
        payload = json.loads(stdout.getvalue())
        self.assertEqual(payload["job_id"], job_id)
        self.assertFalse(payload["ready"])
        self.assertEqual(payload["reason"], "easy_apply_excluded")

    def test_apply_prep_writes_context_artifacts_and_records_browser_lane(self) -> None:
        stdout = io.StringIO()
        with self.with_temp_db() as path:
            with tempfile.NamedTemporaryFile(suffix=".pdf", delete=False) as resume_file:
                resume_file.write(b"%PDF-1.4 ready resume")
                resume_file.flush()
                resume_path = resume_file.name

            try:
                job_id = self.insert_job(
                    path,
                    latest_resume_flags='["manual_review_recommended"]',
                    latest_resume_job_description_path=str(REPO_ROOT / "tmp_jd.txt"),
                    selected_resume_version_id="resume-v4",
                    selected_resume_pdf_path=resume_path,
                    selected_resume_tex_path=str(REPO_ROOT / "main.tex"),
                    selected_resume_ready_for_c3=1,
                )
                with self.with_temp_orchestration_root() as runtime_root:
                    with redirect_stdout(stdout):
                        exit_code = main(
                            [
                                "apply-prep",
                                "--db-path",
                                path,
                                "--runtime-root",
                                runtime_root,
                                "--job-id",
                                str(job_id),
                                "--browser-lane",
                                "isolated",
                                "--embed-resume-data",
                            ]
                        )
                    payload = json.loads(stdout.getvalue())
                    run_dir = Path(runtime_root) / "runs" / payload["run_id"]
                    apply_context_exists = Path(payload["apply_context_path"]).exists()
                    apply_context = self.read_json(run_dir / "apply_context.json")
                    c3_context = self.read_json(run_dir / "c3_apply_context.json")
                    job = self.get_job_row(path, job_id)
            finally:
                if os.path.exists(resume_path):
                    os.remove(resume_path)

        self.assertEqual(exit_code, 0)
        self.assertEqual(payload["job_id"], job_id)
        self.assertEqual(payload["browser_lane"], "isolated")
        self.assertEqual(payload["selected_resume_version_id"], "resume-v4")
        self.assertTrue(payload["selected_resume_ready_for_c3"])
        self.assertIn("manual_review_recommended", payload["concern_flags"])
        self.assertTrue(apply_context_exists)
        self.assertEqual(apply_context["browser_lane"], "isolated")
        self.assertEqual(c3_context["browserLane"], "isolated")
        self.assertTrue(c3_context["selectedResumeDataUrl"].startswith("data:application/pdf;base64,"))
        self.assertEqual(job["status"], "claimed")

    def test_end_to_end_review_then_submit_flow_records_events(self) -> None:
        with self.with_temp_db() as path:
            with tempfile.NamedTemporaryFile(suffix=".pdf", delete=False) as resume_file:
                resume_file.write(b"%PDF-1.4 ready resume")
                resume_file.flush()
                resume_path = resume_file.name

            try:
                job_id = self.insert_job(
                    path,
                    selected_resume_version_id="resume-v9",
                    selected_resume_pdf_path=resume_path,
                    selected_resume_tex_path=str(REPO_ROOT / "main.tex"),
                    selected_resume_ready_for_c3=1,
                )
                with self.with_temp_orchestration_root() as runtime_root:
                    service = self.make_service(path, runtime_root)
                    context = service.build_apply_context(
                        job_id,
                        source_runtime="openclaw",
                        browser_lane="attached",
                    )
                    fill_request = service.request_fill(context.run_id)
                    review_result_path = self.write_json_file(
                        {
                            "status": "ok",
                            "missingRequiredFields": ["phone"],
                            "generatedAnswersUsed": True,
                            "evidence": {"screenshot": "fill.png"},
                        }
                    )
                    try:
                        recorded = service.record_fill_result(context.run_id, review_result_path)
                    finally:
                        os.remove(review_result_path)

                    self.assertEqual(fill_request["run"]["status"], "fill_requested")
                    self.assertEqual(recorded["run"]["status"], "manual_review")
                    self.assertIn("missing_required_fields", recorded["manual_review_flags"])

                    resolved = service.resolve_review(
                        context.run_id,
                        decision="continue",
                        approved_by="operator",
                        reason="Looks good after inspection.",
                    )
                    approved = service.approve_submit(
                        context.run_id,
                        decision="approve",
                        approved_by="operator",
                        reason="First scaffold approval.",
                    )
                    summary_json_path = self.write_json_file({"submittedVia": "operator"})
                    try:
                        submitted = service.mark_submitted(
                            context.run_id,
                            summary_json_path=summary_json_path,
                        )
                    finally:
                        os.remove(summary_json_path)

                    status = service.get_run_status(context.run_id)
                    approval_dir = Path(runtime_root) / "approvals" / str(job_id)
                    approval_dir_exists = approval_dir.exists()
                    final_status_exists = Path(status["run"]["final_status_path"]).exists()
                    job = self.get_job_row(path, job_id)
            finally:
                if os.path.exists(resume_path):
                    os.remove(resume_path)

        self.assertEqual(resolved["run"]["status"], "awaiting_submit_approval")
        self.assertEqual(approved["run"]["status"], "submit_approved")
        self.assertEqual(submitted["run"]["status"], "submitted")
        self.assertEqual(status["run"]["browser_lane"], "attached")
        self.assertTrue(status["run"]["submit_allowed"])
        self.assertEqual(job["status"], "applied")
        self.assertTrue(approval_dir_exists)
        self.assertTrue(final_status_exists)
        event_types = [event["event_type"] for event in status["events"]]
        self.assertEqual(
            event_types,
            [
                "run_started",
                "fill_requested",
                "fill_recorded",
                "manual_review_resolved",
                "submit_approval_recorded",
                "submitted",
            ],
        )

    def test_fill_failure_marks_job_failed_and_writes_final_status(self) -> None:
        with self.with_temp_db() as path:
            with tempfile.NamedTemporaryFile(suffix=".pdf", delete=False) as resume_file:
                resume_file.write(b"%PDF-1.4 ready resume")
                resume_file.flush()
                resume_path = resume_file.name

            try:
                job_id = self.insert_job(
                    path,
                    selected_resume_version_id="resume-v2",
                    selected_resume_pdf_path=resume_path,
                    selected_resume_tex_path=str(REPO_ROOT / "main.tex"),
                    selected_resume_ready_for_c3=1,
                )
                with self.with_temp_orchestration_root() as runtime_root:
                    service = self.make_service(path, runtime_root)
                    context = service.build_apply_context(job_id)
                    failure_path = self.write_json_file(
                        {
                            "status": "failed",
                            "reason": "resume upload failed",
                        }
                    )
                    try:
                        recorded = service.record_fill_result(context.run_id, failure_path)
                    finally:
                        os.remove(failure_path)
                    status = service.get_run_status(context.run_id)
                    final_status_exists = Path(status["run"]["final_status_path"]).exists()
                    final_status_payload = self.read_json(status["run"]["final_status_path"])
                    job = self.get_job_row(path, job_id)
            finally:
                if os.path.exists(resume_path):
                    os.remove(resume_path)

        self.assertEqual(recorded["run"]["status"], "failed")
        self.assertEqual(job["status"], "failed")
        self.assertTrue(final_status_exists)
        self.assertEqual(final_status_payload["status"], "failed")

    def test_pick_next_blocks_on_active_run_then_global_hold(self) -> None:
        with self.with_temp_db() as path:
            with tempfile.NamedTemporaryFile(suffix=".pdf", delete=False) as resume_file:
                resume_file.write(b"%PDF-1.4 ready resume")
                resume_file.flush()
                resume_path = resume_file.name

            try:
                job_id_1 = self.insert_job(
                    path,
                    selected_resume_version_id="resume-v1",
                    selected_resume_pdf_path=resume_path,
                    selected_resume_tex_path=str(REPO_ROOT / "main.tex"),
                    selected_resume_ready_for_c3=1,
                )
                self.insert_job(
                    path,
                    job_url="https://www.indeed.com/viewjob?jk=456",
                    apply_url="https://jobs.example.com/apply/456",
                    source="indeed",
                    selected_resume_version_id="resume-v2",
                    selected_resume_pdf_path=resume_path,
                    selected_resume_tex_path=str(REPO_ROOT / "main.tex"),
                    selected_resume_ready_for_c3=1,
                )
                with self.with_temp_orchestration_root() as runtime_root:
                    service = self.make_service(path, runtime_root)
                    first_pick = service.pick_next_job()
                    context = service.build_apply_context(job_id_1)
                    blocked_active = service.pick_next_job()
                    hold_result_path = self.write_json_file(
                        {
                            "status": "ok",
                            "message": "login required before continuing",
                        }
                    )
                    try:
                        service.record_fill_result(context.run_id, hold_result_path)
                    finally:
                        os.remove(hold_result_path)
                    blocked_hold = service.pick_next_job()
            finally:
                if os.path.exists(resume_path):
                    os.remove(resume_path)

        self.assertEqual(first_pick["decision"], "picked")
        self.assertEqual(first_pick["job_id"], job_id_1)
        self.assertEqual(first_pick["source"], "linkedin")
        self.assertEqual(blocked_active["reason"], "active_run_in_progress")
        self.assertEqual(blocked_hold["reason"], "global_manual_review_hold")
        self.assertIn("login_required", blocked_hold["reasons"])

    def test_run_once_prepare_only_returns_prepared_run_with_browser_lane(self) -> None:
        stdout = io.StringIO()
        with self.with_temp_db() as path:
            with tempfile.NamedTemporaryFile(suffix=".pdf", delete=False) as resume_file:
                resume_file.write(b"%PDF-1.4 ready resume")
                resume_file.flush()
                resume_path = resume_file.name

            try:
                job_id = self.insert_job(
                    path,
                    selected_resume_version_id="resume-v3",
                    selected_resume_pdf_path=resume_path,
                    selected_resume_tex_path=str(REPO_ROOT / "main.tex"),
                    selected_resume_ready_for_c3=1,
                )
                with self.with_temp_orchestration_root() as runtime_root:
                    with redirect_stdout(stdout):
                        exit_code = main(
                            [
                                "run-once",
                                "--db-path",
                                path,
                                "--runtime-root",
                                runtime_root,
                                "--source-runtime",
                                "scheduler",
                                "--browser-lane",
                                "isolated",
                                "--prepare-only",
                            ]
                        )
            finally:
                if os.path.exists(resume_path):
                    os.remove(resume_path)
        self.assertEqual(exit_code, 0)
        payload = json.loads(stdout.getvalue())
        self.assertEqual(payload["decision"], "prepared")
        self.assertEqual(payload["picked"]["job_id"], job_id)
        self.assertEqual(payload["run"]["status"], "apply_prepared")
        self.assertEqual(payload["run"]["browser_lane"], "isolated")
        self.assertEqual(payload["apply_context"]["browser_lane"], "isolated")

    def test_hunterctl_apply_prep_passes_browser_lane_to_coordinator_cli(self) -> None:
        args = Namespace(
            job_id=42,
            source_runtime="openclaw",
            browser_lane="attached",
            embed_resume_data=False,
            output="",
        )
        with patch("scripts.hunterctl.subprocess.run") as run_mock:
            run_mock.return_value.returncode = 0
            with self.assertRaises(SystemExit) as exc:
                hunterctl.cmd_apply_prep(args)
        self.assertEqual(exc.exception.code, 0)
        command = run_mock.call_args[0][0]
        self.assertEqual(
            command,
            [
                hunterctl.PYTHON,
                "-m",
                "coordinator.cli",
                "apply-prep",
                "--job-id",
                "42",
                "--source-runtime",
                "openclaw",
                "--browser-lane",
                "attached",
            ],
        )

    def test_hunterctl_summary_passthrough_runs_coordinator_cli(self) -> None:
        args = Namespace(sample_limit=7)
        with patch("scripts.hunterctl.subprocess.run") as run_mock:
            run_mock.return_value.returncode = 0
            with self.assertRaises(SystemExit) as exc:
                hunterctl.cmd_c4_summary(args)
        self.assertEqual(exc.exception.code, 0)
        command = run_mock.call_args[0][0]
        self.assertEqual(
            command,
            [
                hunterctl.PYTHON,
                "-m",
                "coordinator.cli",
                "summary",
                "--sample-limit",
                "7",
            ],
        )


if __name__ == "__main__":
    unittest.main()
