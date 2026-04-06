import io
import json
import os
import sqlite3
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
SCRAPER_DIR = REPO_ROOT / "scraper"
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))
if str(SCRAPER_DIR) not in sys.path:
    sys.path.insert(0, str(SCRAPER_DIR))

import db  # noqa: E402
from orchestration.cli import main


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
                self.old_root = os.environ.get("HUNT_ORCHESTRATION_ROOT")

            def __enter__(self):
                os.environ["HUNT_ORCHESTRATION_ROOT"] = self.root.name
                return self.root.name

            def __exit__(self, exc_type, exc, tb):
                if self.old_root is None:
                    os.environ.pop("HUNT_ORCHESTRATION_ROOT", None)
                else:
                    os.environ["HUNT_ORCHESTRATION_ROOT"] = self.old_root
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
                exit_code = main(["ready", "--job-id", str(job_id)])
        self.assertEqual(exit_code, 0)
        payload = json.loads(stdout.getvalue())
        self.assertEqual(payload["job_id"], job_id)
        self.assertFalse(payload["ready"])
        self.assertEqual(payload["reason"], "not_external_apply")
        self.assertIn("not_external_apply", payload["flags"])

    def test_apply_prep_command_returns_json(self) -> None:
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
                with self.with_temp_orchestration_root():
                    with redirect_stdout(stdout):
                        exit_code = main(["apply-prep", "--job-id", str(job_id)])
                    payload = json.loads(stdout.getvalue())
                    self.assertTrue(Path(payload["apply_context_path"]).exists())
            finally:
                if os.path.exists(resume_path):
                    os.remove(resume_path)

        self.assertEqual(exit_code, 0)
        self.assertEqual(payload["job_id"], job_id)
        self.assertEqual(payload["selected_resume_version_id"], "resume-v4")
        self.assertTrue(payload["selected_resume_ready_for_c3"])
        self.assertIn("manual_review_recommended", payload["concern_flags"])
        self.assertTrue(payload["apply_context_path"])

    def test_run_command_returns_json(self) -> None:
        stdout = io.StringIO()
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
                with self.with_temp_orchestration_root():
                    with redirect_stdout(stdout):
                        exit_code = main(["run", "--job-id", str(job_id), "--source-runtime", "openclaw"])
            finally:
                if os.path.exists(resume_path):
                    os.remove(resume_path)
        self.assertEqual(exit_code, 0)
        payload = json.loads(stdout.getvalue())
        self.assertEqual(payload["run_id"], f"run-{job_id}")
        self.assertEqual(payload["source_runtime"], "openclaw")
        self.assertEqual(payload["status"], "ready_for_fill")
        self.assertEqual(payload["selected_resume_version_id"], "resume-v9")
        self.assertTrue(payload["apply_context_path"])


if __name__ == "__main__":
    unittest.main()
