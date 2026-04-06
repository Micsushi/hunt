import json
import os
import sqlite3
import tempfile
import unittest
from pathlib import Path

from resume_tailor.db import get_apply_context, init_resume_db
from resume_tailor.pipeline import generate_resume_for_ad_hoc, generate_resume_for_job, generate_resumes_for_ready_jobs


REPO_ROOT = Path(__file__).resolve().parent.parent


class Component2PipelineTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.db_path = Path(self.temp_dir.name) / "hunt.db"
        conn = sqlite3.connect(self.db_path)
        conn.execute(
            """
            CREATE TABLE jobs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                title TEXT NOT NULL,
                company TEXT,
                location TEXT,
                job_url TEXT UNIQUE NOT NULL,
                apply_url TEXT,
                description TEXT,
                source TEXT,
                date_posted TEXT,
                is_remote BOOLEAN,
                status TEXT DEFAULT 'new',
                date_scraped TEXT DEFAULT CURRENT_TIMESTAMP,
                level TEXT,
                priority BOOLEAN DEFAULT 0,
                category TEXT,
                apply_type TEXT,
                auto_apply_eligible BOOLEAN,
                enrichment_status TEXT,
                enrichment_attempts INTEGER DEFAULT 0,
                enriched_at TEXT,
                last_enrichment_error TEXT,
                apply_host TEXT,
                ats_type TEXT,
                last_enrichment_started_at TEXT,
                next_enrichment_retry_at TEXT,
                last_artifact_dir TEXT,
                last_artifact_screenshot_path TEXT,
                last_artifact_html_path TEXT,
                last_artifact_text_path TEXT
            )
            """
        )
        conn.execute(
            """
            INSERT INTO jobs (
                title, company, location, job_url, apply_url, description, source,
                date_posted, is_remote, level, priority, category, apply_type,
                auto_apply_eligible, enrichment_status, enrichment_attempts, apply_host, ats_type
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                "Junior Software Engineer",
                "Acme",
                "Remote",
                "https://example.com/jobs/1",
                "https://acme.example/apply/1",
                "We are hiring a junior software engineer with Python, Docker, AWS, and REST API experience.",
                "linkedin",
                "2026-04-06",
                1,
                "junior",
                0,
                "engineering",
                "external_apply",
                1,
                "done",
                0,
                "acme.example",
                "workday",
            ),
        )
        conn.commit()
        conn.close()
        os.environ["HUNT_RESUME_ARTIFACTS_DIR"] = str(Path(self.temp_dir.name) / "artifacts")

    def tearDown(self):
        self.temp_dir.cleanup()
        os.environ.pop("HUNT_RESUME_ARTIFACTS_DIR", None)

    def test_generate_resume_for_job_records_attempt_and_apply_context(self):
        init_resume_db(self.db_path)
        result = generate_resume_for_job(1, db_path=self.db_path)

        self.assertEqual(result["job_id"], 1)
        self.assertTrue(Path(result["tex_path"]).exists())
        self.assertTrue(Path(result["metadata_path"]).exists())

        context = get_apply_context(1, db_path=self.db_path)
        self.assertEqual(context["apply_url"], "https://acme.example/apply/1")
        self.assertEqual(context["job_id"], 1)
        self.assertIn("selected_resume_ready_for_c3", context)

        conn = sqlite3.connect(self.db_path)
        attempts = conn.execute("SELECT COUNT(*) FROM resume_attempts").fetchone()[0]
        versions = conn.execute("SELECT COUNT(*) FROM resume_versions").fetchone()[0]
        self.assertEqual(attempts, 1)
        self.assertEqual(versions, 1)
        conn.close()

    def test_generate_ad_hoc_writes_artifacts_without_db(self):
        result = generate_resume_for_ad_hoc(
            title="Associate Product Manager",
            company="Beta",
            description="Associate product manager role focused on roadmap planning, stakeholder alignment, and agile delivery.",
            label="beta_apm",
        )

        self.assertIsNone(result["job_id"])
        self.assertTrue(Path(result["attempt_dir"]).exists())
        self.assertTrue(Path(result["tex_path"]).exists())
        metadata = json.loads(Path(result["metadata_path"]).read_text(encoding="utf-8"))
        self.assertEqual(metadata["classification"]["role_family"], "pm")

    def test_generate_ready_jobs_only_processes_done_rows(self):
        conn = sqlite3.connect(self.db_path)
        conn.execute(
            """
            INSERT INTO jobs (
                title, company, location, job_url, apply_url, description, source,
                date_posted, is_remote, level, priority, category, apply_type,
                auto_apply_eligible, enrichment_status, enrichment_attempts, apply_host, ats_type
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                "Data Analyst",
                "Gamma",
                "Remote",
                "https://example.com/jobs/2",
                "https://gamma.example/apply/2",
                "Need SQL dashboards and stakeholder reporting experience.",
                "indeed",
                "2026-04-06",
                1,
                "junior",
                0,
                "data",
                "external_apply",
                1,
                "pending",
                0,
                "gamma.example",
                "greenhouse",
            ),
        )
        conn.commit()
        conn.close()

        init_resume_db(self.db_path)
        results = generate_resumes_for_ready_jobs(db_path=self.db_path, limit=10, only_missing=True)

        self.assertEqual(len(results), 1)
        self.assertEqual(results[0]["job_id"], 1)
