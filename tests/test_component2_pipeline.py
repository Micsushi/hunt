import json
import os
import sqlite3
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from trapper.db import get_apply_context, init_resume_db
from trapper.parser import parse_resume_file
from trapper.pipeline import (
    generate_resume_for_ad_hoc,
    generate_resume_for_job,
    generate_resumes_for_ready_jobs,
)

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

    def test_failed_retry_does_not_clear_selected_resume_context(self):
        init_resume_db(self.db_path)
        with patch("trapper.pipeline.compile_tex") as mock_compile:
            mock_compile.return_value = {
                "compile_status": "ok",
                "page_count": 1,
                "fits_one_page": True,
                "pdf_path": str(Path(self.temp_dir.name) / "selected_resume.pdf"),
                "log_text": "mock one-page result",
            }
            first_result = generate_resume_for_job(1, db_path=self.db_path)
        first_context = get_apply_context(1, db_path=self.db_path)

        self.assertTrue(first_result["selected_for_c3"])
        self.assertTrue(first_context["selected_resume_ready_for_c3"])
        self.assertEqual(
            str(first_context["selected_resume_version_id"]),
            str(first_result["resume_version_id"]),
        )

        with patch("trapper.pipeline.compile_tex") as mock_compile:
            mock_compile.return_value = {
                "compile_status": "page_limit_failed",
                "page_count": 2,
                "fits_one_page": False,
                "pdf_path": "",
                "log_text": "mock over-one-page result",
            }
            failed_result = generate_resume_for_job(1, db_path=self.db_path)

        failed_context = get_apply_context(1, db_path=self.db_path)
        self.assertEqual(failed_result["status"], "failed")
        self.assertFalse(failed_result["selected_for_c3"])
        self.assertEqual(
            failed_context["selected_resume_version_id"],
            first_context["selected_resume_version_id"],
        )
        self.assertEqual(
            failed_context["selected_resume_pdf_path"],
            first_context["selected_resume_pdf_path"],
        )
        self.assertTrue(failed_context["selected_resume_ready_for_c3"])

    def test_manual_only_job_does_not_select_resume_for_c3(self):
        conn = sqlite3.connect(self.db_path)
        conn.execute("UPDATE jobs SET priority = 1 WHERE id = 1")
        conn.commit()
        conn.close()

        init_resume_db(self.db_path)
        with patch("trapper.pipeline.compile_tex") as mock_compile:
            mock_compile.return_value = {
                "compile_status": "ok",
                "page_count": 1,
                "fits_one_page": True,
                "pdf_path": str(Path(self.temp_dir.name) / "manual_only_resume.pdf"),
                "log_text": "mock one-page result",
            }
            result = generate_resume_for_job(1, db_path=self.db_path)

        context = get_apply_context(1, db_path=self.db_path)
        self.assertFalse(result["selected_for_c3"])
        self.assertFalse(context["selected_resume_ready_for_c3"])
        self.assertIsNone(context["selected_resume_version_id"])
        self.assertIsNone(context["selected_resume_pdf_path"])

    def test_easy_apply_job_clears_stale_selected_resume_context(self):
        init_resume_db(self.db_path)
        with patch("trapper.pipeline.compile_tex") as mock_compile:
            mock_compile.return_value = {
                "compile_status": "ok",
                "page_count": 1,
                "fits_one_page": True,
                "pdf_path": str(Path(self.temp_dir.name) / "selected_resume.pdf"),
                "log_text": "mock one-page result",
            }
            first_result = generate_resume_for_job(1, db_path=self.db_path)

        self.assertTrue(first_result["selected_for_c3"])

        conn = sqlite3.connect(self.db_path)
        conn.execute(
            """
            UPDATE jobs
            SET apply_type = 'easy_apply',
                auto_apply_eligible = 0,
                apply_url = ''
            WHERE id = 1
            """
        )
        conn.commit()
        conn.close()

        with patch("trapper.pipeline.compile_tex") as mock_compile:
            mock_compile.return_value = {
                "compile_status": "ok",
                "page_count": 1,
                "fits_one_page": True,
                "pdf_path": str(Path(self.temp_dir.name) / "easy_apply_resume.pdf"),
                "log_text": "mock one-page result",
            }
            second_result = generate_resume_for_job(1, db_path=self.db_path)

        context = get_apply_context(1, db_path=self.db_path)
        self.assertFalse(second_result["selected_for_c3"])
        self.assertFalse(context["selected_resume_ready_for_c3"])
        self.assertIsNone(context["selected_resume_version_id"])
        self.assertIsNone(context["selected_resume_pdf_path"])

    def test_generate_resume_uses_source_material_bullets(self):
        profile_path = Path(self.temp_dir.name) / "candidate_profile.md"
        bullet_library_path = Path(self.temp_dir.name) / "bullet_library.md"
        first_entry_id = parse_resume_file(REPO_ROOT / "main.tex").experience[0].entry_id

        profile_path.write_text(
            f"""# Candidate Profile Template

## Experience Inventory

### Experience Entry

- Entry ID: {first_entry_id}
- Company: INVIDI Technologies
- Title: Junior Software Developer (Part-time)
- Location: Edmonton, AB
- Start date: May 2025
- End date: Feb 2026
- Keep header facts immutable: yes
- Role-family tags: software
- Job-level tags: junior
- Technology tags: python, aws, backend
- Leadership tags:
- PM tags:
- Data tags:

#### Immutable facts

- Fact ID: fact_python_delivery
  - Text: Built Python and AWS services that supported production systems.

#### Bullet candidates

- Bullet ID: bullet_python_delivery
  - Text: Built Python and AWS services that improved backend delivery for production systems
  - Supported by fact IDs: fact_python_delivery
  - Relevance tags: python, aws, backend
""",
            encoding="utf-8",
        )
        bullet_library_path.write_text("# Bullet Library Template\n", encoding="utf-8")

        with patch("trapper.pipeline.compile_tex") as mock_compile:
            mock_compile.return_value = {
                "compile_status": "ok",
                "page_count": 1,
                "fits_one_page": True,
                "pdf_path": str(Path(self.temp_dir.name) / "source_resume.pdf"),
                "log_text": "mock one-page result",
            }
            result = generate_resume_for_job(
                1,
                db_path=self.db_path,
                candidate_profile_path=profile_path,
                bullet_library_path=bullet_library_path,
            )

        structured_output = json.loads(
            (Path(result["attempt_dir"]) / "tailored_resume.json").read_text(encoding="utf-8")
        )
        tex_output = Path(result["tex_path"]).read_text(encoding="utf-8")

        self.assertIn("Built Python and AWS services", tex_output)
        self.assertIn(
            "fact_python_delivery",
            [
                bullet["source_fact_id"]
                for entry in structured_output["experience_entries"]
                for bullet in entry["bullet_plan"]
            ],
        )

    def test_generate_resume_selects_family_base_resume_when_available(self):
        base_root = Path(self.temp_dir.name) / "base_resumes"
        pm_dir = base_root / "pm"
        pm_dir.mkdir(parents=True)
        family_resume_path = pm_dir / "main.tex"
        family_resume_path.write_text(
            (REPO_ROOT / "main.tex").read_text(encoding="utf-8"), encoding="utf-8"
        )

        with patch("trapper.pipeline.compile_tex") as mock_compile:
            mock_compile.return_value = {
                "compile_status": "ok",
                "page_count": 1,
                "fits_one_page": True,
                "pdf_path": str(Path(self.temp_dir.name) / "pm_resume.pdf"),
                "log_text": "mock one-page result",
            }
            with patch("trapper.config.BASE_RESUMES_ROOT", base_root):
                result = generate_resume_for_ad_hoc(
                    title="Associate Product Manager",
                    company="Beta",
                    description="Associate product manager role focused on roadmap planning, stakeholder alignment, and agile delivery.",
                )

        metadata = json.loads(Path(result["metadata_path"]).read_text(encoding="utf-8"))
        structured_output = json.loads(
            (Path(result["attempt_dir"]) / "tailored_resume.json").read_text(encoding="utf-8")
        )
        self.assertEqual(structured_output["selected_base_resume"], "pm")
        self.assertEqual(metadata["source_resume_path"], str(family_resume_path))

    def test_page_fit_retry_recompiles_after_controlled_reduction(self):
        init_resume_db(self.db_path)
        compile_results = [
            {
                "compile_status": "ok",
                "page_count": 2,
                "fits_one_page": False,
                "pdf_path": str(Path(self.temp_dir.name) / "first_try.pdf"),
                "log_text": "mock two-page result",
            },
            {
                "compile_status": "ok",
                "page_count": 1,
                "fits_one_page": True,
                "pdf_path": str(Path(self.temp_dir.name) / "second_try.pdf"),
                "log_text": "mock one-page result",
            },
        ]

        with patch(
            "trapper.pipeline.compile_tex", side_effect=compile_results
        ) as mock_compile:
            result = generate_resume_for_job(1, db_path=self.db_path)

        metadata = json.loads(Path(result["metadata_path"]).read_text(encoding="utf-8"))
        self.assertEqual(mock_compile.call_count, 2)
        self.assertIn(result["status"], {"done", "done_with_flags"})
        self.assertEqual(metadata["page_fit_retry_count"], 1)
        self.assertEqual(len(metadata["compile_history"]), 2)
