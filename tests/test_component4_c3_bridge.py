"""Phase 8 tests: C3 browser-extension bridge (pending-fills polling + inline fill-result)."""

import json
import os
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from coordinator.service import OrchestrationError, OrchestrationService  # noqa: E402
from hunter import db  # noqa: E402


class C3BridgeTests(unittest.TestCase):
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
            "job_url": "https://www.linkedin.com/jobs/view/7001",
            "apply_url": "https://acme.wd5.myworkdayjobs.com/en-US/Careers/job/7001",
            "description": "Good role.",
            "source": "linkedin",
            "date_posted": "2026-04-10",
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
                    defaults["title"], defaults["company"], defaults["location"],
                    defaults["job_url"], defaults["apply_url"], defaults["description"],
                    defaults["source"], defaults["date_posted"], defaults["is_remote"],
                    defaults["level"], defaults["priority"], defaults["category"],
                    defaults["apply_type"], defaults["auto_apply_eligible"],
                    defaults["enrichment_status"], defaults["enrichment_attempts"],
                    defaults["apply_host"], defaults["ats_type"],
                    defaults["last_enrichment_error"], defaults["last_enrichment_started_at"],
                    defaults["next_enrichment_retry_at"],
                    defaults["latest_resume_job_description_path"], defaults["latest_resume_flags"],
                    defaults["selected_resume_version_id"], defaults["selected_resume_pdf_path"],
                    defaults["selected_resume_tex_path"], defaults["selected_resume_selected_at"],
                    defaults["selected_resume_ready_for_c3"],
                ),
            )
            conn.commit()
            return conn.execute(
                "SELECT id FROM jobs WHERE job_url = ?", (defaults["job_url"],)
            ).fetchone()[0]
        finally:
            conn.close()

    def make_service(self, path, runtime_root):
        return OrchestrationService(db_path=path, runtime_root=runtime_root)

    # ------------------------------------------------------------------
    # helpers
    # ------------------------------------------------------------------

    def _prepare_ready_job(self, path, runtime_root, *, job_url_suffix="7001"):
        """Insert a ready job with a real temp PDF, return (job_id, resume_path, service)."""
        resume_file = tempfile.NamedTemporaryFile(suffix=".pdf", delete=False)
        resume_file.write(b"%PDF-1.4 c3-bridge-test")
        resume_file.flush()
        resume_file.close()
        resume_path = resume_file.name

        job_id = self.insert_job(
            path,
            job_url=f"https://www.linkedin.com/jobs/view/{job_url_suffix}",
            apply_url=f"https://acme.wd5.myworkdayjobs.com/en-US/job/{job_url_suffix}",
            selected_resume_version_id="resume-v5",
            selected_resume_pdf_path=resume_path,
            selected_resume_tex_path=str(REPO_ROOT / "main.tex"),
            selected_resume_ready_for_c3=1,
        )
        svc = self.make_service(path, runtime_root)
        return job_id, resume_path, svc

    # ------------------------------------------------------------------
    # Tests
    # ------------------------------------------------------------------

    def test_c3_payload_always_embeds_resume_data_url(self):
        """c3_apply_context.json must contain selectedResumeDataUrl even when embed_resume_data=False."""
        with self.with_temp_db() as path:
            with self.with_temp_orchestration_root() as runtime_root:
                job_id, resume_path, svc = self._prepare_ready_job(path, runtime_root)
                try:
                    # start_run does NOT pass embed_resume_data
                    context = svc.build_apply_context(job_id)
                    c3_path = Path(context.c3_apply_context_path)
                    c3_payload = json.loads(c3_path.read_text(encoding="utf-8"))
                finally:
                    if os.path.exists(resume_path):
                        os.remove(resume_path)

        self.assertIn("selectedResumeDataUrl", c3_payload)
        self.assertTrue(c3_payload["selectedResumeDataUrl"].startswith("data:application/pdf;base64,"))

    def test_get_pending_fills_empty_when_no_fill_requested_runs(self):
        with self.with_temp_db() as path:
            with self.with_temp_orchestration_root() as runtime_root:
                job_id, resume_path, svc = self._prepare_ready_job(path, runtime_root)
                try:
                    # Build context but don't request fill yet
                    svc.build_apply_context(job_id)
                    fills = svc.get_pending_fills()
                finally:
                    if os.path.exists(resume_path):
                        os.remove(resume_path)

        self.assertEqual(fills, [])

    def test_get_pending_fills_returns_fill_requested_runs_with_c3_payload(self):
        with self.with_temp_db() as path:
            with self.with_temp_orchestration_root() as runtime_root:
                job_id, resume_path, svc = self._prepare_ready_job(path, runtime_root)
                try:
                    context = svc.build_apply_context(job_id)
                    svc.request_fill(context.run_id)
                    fills = svc.get_pending_fills()
                finally:
                    if os.path.exists(resume_path):
                        os.remove(resume_path)

        self.assertEqual(len(fills), 1)
        fill = fills[0]
        self.assertEqual(fill["run_id"], context.run_id)
        self.assertEqual(fill["job_id"], job_id)
        self.assertEqual(fill["ats_type"], "workday")
        self.assertIn("c3_payload", fill)
        self.assertIn("applyUrl", fill["c3_payload"])

    def test_get_pending_fills_excludes_non_fill_requested_runs(self):
        with self.with_temp_db() as path:
            with self.with_temp_orchestration_root() as runtime_root:
                job_id, resume_path, svc = self._prepare_ready_job(path, runtime_root)
                try:
                    # apply_prepared, not fill_requested
                    svc.build_apply_context(job_id)
                    fills_before = svc.get_pending_fills()

                    # second job — advance to fill_requested
                    job_id2 = self.insert_job(
                        path,
                        job_url="https://www.indeed.com/viewjob?jk=9002",
                        apply_url="https://acme.wd5.myworkdayjobs.com/en-US/job/9002",
                        selected_resume_version_id="resume-v6",
                        selected_resume_pdf_path=resume_path,
                        selected_resume_tex_path=str(REPO_ROOT / "main.tex"),
                        selected_resume_ready_for_c3=1,
                    )
                    context2 = svc.build_apply_context(job_id2)
                    svc.request_fill(context2.run_id)
                    fills_after = svc.get_pending_fills()
                finally:
                    if os.path.exists(resume_path):
                        os.remove(resume_path)

        self.assertEqual(fills_before, [])
        self.assertEqual(len(fills_after), 1)
        self.assertEqual(fills_after[0]["run_id"], context2.run_id)

    def test_record_fill_result_inline_transitions_to_awaiting_submit_approval(self):
        with self.with_temp_db() as path:
            with self.with_temp_orchestration_root() as runtime_root:
                job_id, resume_path, svc = self._prepare_ready_job(path, runtime_root)
                try:
                    context = svc.build_apply_context(job_id)
                    svc.request_fill(context.run_id)
                    result = svc.record_fill_result_inline(
                        context.run_id,
                        {
                            "status": "ok",
                            "generatedAnswersUsed": True,
                            "resumeUploadOk": True,
                            "finalUrl": "https://acme.wd5.myworkdayjobs.com/en-US/job/7001/thanks",
                            "evidence": {"screenshot": "done.png"},
                        },
                    )
                    run = svc.get_run(context.run_id)
                finally:
                    if os.path.exists(resume_path):
                        os.remove(resume_path)

        self.assertEqual(result["run"]["status"], "awaiting_submit_approval")
        self.assertEqual(run.status, "awaiting_submit_approval")
        self.assertEqual(result["manual_review_flags"], [])

    def test_record_fill_result_inline_raises_flags_when_fields_missing(self):
        with self.with_temp_db() as path:
            with self.with_temp_orchestration_root() as runtime_root:
                job_id, resume_path, svc = self._prepare_ready_job(path, runtime_root)
                try:
                    context = svc.build_apply_context(job_id)
                    svc.request_fill(context.run_id)
                    result = svc.record_fill_result_inline(
                        context.run_id,
                        {
                            "status": "ok",
                            "missingRequiredFields": ["phone", "linkedin"],
                        },
                    )
                finally:
                    if os.path.exists(resume_path):
                        os.remove(resume_path)

        self.assertEqual(result["run"]["status"], "manual_review")
        self.assertIn("missing_required_fields", result["manual_review_flags"])

    def test_record_fill_result_inline_rejects_invalid_payload_type(self):
        with self.with_temp_db() as path:
            with self.with_temp_orchestration_root() as runtime_root:
                job_id, resume_path, svc = self._prepare_ready_job(path, runtime_root)
                try:
                    context = svc.build_apply_context(job_id)
                    svc.request_fill(context.run_id)
                    with self.assertRaises(OrchestrationError):
                        svc.record_fill_result_inline(context.run_id, ["not", "a", "dict"])
                finally:
                    if os.path.exists(resume_path):
                        os.remove(resume_path)

    def test_full_c3_round_trip_via_pending_fills_and_inline_result(self):
        """Full C3 flow: C4 starts run → requests fill → C3 polls → C3 posts result → done."""
        with self.with_temp_db() as path:
            with self.with_temp_orchestration_root() as runtime_root:
                job_id, resume_path, svc = self._prepare_ready_job(path, runtime_root)
                try:
                    # C4: start run and request fill
                    context = svc.build_apply_context(job_id, source_runtime="scheduler")
                    svc.request_fill(context.run_id)

                    # C3: poll for pending fills
                    fills = svc.get_pending_fills()
                    self.assertEqual(len(fills), 1)
                    fill = fills[0]
                    self.assertEqual(fill["run_id"], context.run_id)
                    self.assertIn("selectedResumeDataUrl", fill["c3_payload"])

                    # C3: post fill result inline
                    result = svc.record_fill_result_inline(
                        fill["run_id"],
                        {
                            "status": "ok",
                            "resumeUploadOk": True,
                            "generatedAnswersUsed": True,
                            "finalUrl": fill["apply_url"],
                            "steps": ["uploaded_resume", "answered_questions"],
                            "evidence": {"screenshot": "final.png"},
                        },
                    )

                    # After inline result, no more pending fills
                    fills_after = svc.get_pending_fills()
                    events = svc.list_events(context.run_id)
                    event_types = [e.event_type for e in events]
                finally:
                    if os.path.exists(resume_path):
                        os.remove(resume_path)

        self.assertEqual(result["run"]["status"], "awaiting_submit_approval")
        self.assertEqual(result["manual_review_flags"], [])
        self.assertEqual(fills_after, [])
        self.assertIn("fill_requested", event_types)
        self.assertIn("fill_recorded", event_types)


if __name__ == "__main__":
    unittest.main()
