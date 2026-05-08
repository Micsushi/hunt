import io
import json
import os
import shutil
import sys
import tempfile
import unittest
import zipfile
from unittest.mock import patch

from fastapi.testclient import TestClient

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, REPO_ROOT)


class C0ControlApiTests(unittest.TestCase):
    def setUp(self):
        fd, self.path = tempfile.mkstemp(suffix=".db")
        os.close(fd)
        self.runtime_dir = tempfile.mkdtemp(prefix="hunt-runtime-")
        self._env = patch.dict(
            os.environ,
            {
                "HUNT_DB_PATH": self.path,
                "HUNT_RESUME_ARTIFACTS_DIR": self.runtime_dir,
                "HUNT_ADMIN_USERNAME": "admin",
                "HUNT_ADMIN_PASSWORD": "secret",
                "HUNT_SERVICE_TOKEN": "service-secret",
            },
            clear=False,
        )
        self._env.start()

        from backend import auth_session
        from hunter import db

        self.db = db
        db.DB_PATH = self.path
        db.init_db()
        auth_session.ADMIN_USERNAME = "admin"
        auth_session.ADMIN_PASSWORD = "secret"
        auth_session.init_sessions_table()

        from backend.app import app

        self.client = TestClient(app)
        token = auth_session.create_session("admin")
        self.client.cookies.set(auth_session.SESSION_COOKIE_NAME, token)

    def tearDown(self):
        self._env.stop()
        if os.path.exists(self.path):
            os.remove(self.path)
        shutil.rmtree(self.runtime_dir, ignore_errors=True)

    def test_fletcher_progress_mapping_uses_milestone_order(self):
        from backend.app import (
            _fletcher_step_percent,
            _FletcherProgressTracker,
        )

        self.assertLess(_fletcher_step_percent("starting", is_option_a=True), 5)
        self.assertLessEqual(
            _fletcher_step_percent("selecting_master_resume", is_option_a=True), 10
        )
        self.assertLess(_fletcher_step_percent("generating_resume", is_option_a=True), 15)
        self.assertEqual(_fletcher_step_percent("unknown_future_step"), 0)
        self.assertLess(_fletcher_step_percent("rag_complete"), 70)
        self.assertEqual(_fletcher_step_percent("bullet_rewrite_start"), 0)
        self.assertLess(_fletcher_step_percent("bullet_rewrites_summary"), 80)
        self.assertLess(_fletcher_step_percent("bullet_scores"), 80)
        self.assertLess(_fletcher_step_percent("summary_keyword_filter"), 80)
        self.assertGreater(_fletcher_step_percent("summary_start"), 70)
        self.assertGreater(_fletcher_step_percent("skills_keywords_added"), 80)
        self.assertGreater(_fletcher_step_percent("summary_line_check"), 90)
        self.assertEqual(_fletcher_step_percent("done"), 100)
        self.assertEqual(
            _fletcher_step_percent("ollama_runtime", {"stage": "before_skill_bucket"}), 0
        )

        tracker = _FletcherProgressTracker(is_option_a=True)
        starting = tracker.record("starting")
        unknown = tracker.record("retry_or_optional_step")
        self.assertEqual(unknown["percent"], starting["percent"])
        done = tracker.record("done")
        self.assertEqual(done["percent"], 100)
        self.assertEqual(done["milestone_current"], done["milestone_total"])

    def test_component_settings_round_trip_redacts_secret_values(self):
        response = self.client.post(
            "/api/settings",
            json={
                "component": "c2",
                "key": "openrouter_api_key",
                "value": "sk-test",
                "value_type": "secret",
                "secret": True,
            },
        )
        self.assertEqual(response.status_code, 200)

        response = self.client.get("/api/settings?component=c2")
        self.assertEqual(response.status_code, 200)
        settings = response.json()["settings"]
        self.assertEqual(len(settings), 1)
        self.assertEqual(settings[0]["component"], "c2")
        self.assertEqual(settings[0]["key"], "openrouter_api_key")
        self.assertEqual(settings[0]["value"], None)
        self.assertTrue(settings[0]["secret"])
        self.assertTrue(settings[0]["has_value"])

    def test_fletcher_queue_multipart_persists_uploaded_resume(self):
        from backend import app as backend_app

        with patch.object(backend_app, "_ensure_fletcher_worker_started"):
            response = self.client.post(
                "/api/fletcher/tailor/jobs",
                data={"description": "Build Python APIs", "title": "Backend Engineer"},
                files={"resume": ("main.tex", b"resume tex", "application/x-tex")},
            )
        self.assertEqual(response.status_code, 200)
        item = response.json()
        resume_path = item["input"]["resume_path"]
        self.assertTrue(resume_path.endswith(".tex"))
        self.assertTrue(os.path.exists(resume_path))
        with open(resume_path, "rb") as fh:
            self.assertEqual(fh.read(), b"resume tex")

    def test_fletcher_queue_log_can_be_viewed_and_downloaded(self):
        from pathlib import Path

        from backend import app as backend_app
        from fletcher.db import get_connection, set_fletcher_job_log_path

        with patch.object(backend_app, "_ensure_fletcher_worker_started"):
            response = self.client.post(
                "/api/fletcher/tailor/jobs",
                json={"description": "Build Python APIs", "title": "Backend Engineer"},
            )
        self.assertEqual(response.status_code, 200)
        item = response.json()
        log_path = Path(self.runtime_dir) / "queue-log.txt"
        log_path.write_text("queue log body", encoding="utf-8")
        set_fletcher_job_log_path(item["queue_item_id"], str(log_path))
        conn = get_connection()
        try:
            conn.execute(
                "UPDATE fletcher_jobs SET finished_at = ? WHERE queue_item_id = ?",
                ("2026-05-07 19:53:41", item["queue_item_id"]),
            )
            conn.commit()
        finally:
            conn.close()

        view_response = self.client.get(f"/api/fletcher/tailor/jobs/{item['queue_item_id']}/log")
        self.assertEqual(view_response.status_code, 200)
        self.assertEqual(view_response.text, "queue log body")

        download_response = self.client.get(
            f"/api/fletcher/tailor/jobs/{item['queue_item_id']}/log?download=1"
        )
        self.assertEqual(download_response.status_code, 200)
        self.assertEqual(download_response.content, b"queue log body")
        self.assertIn(
            "log_resume_generation_2026-05-07_19-53-41.log",
            download_response.headers["content-disposition"],
        )

    def test_fletcher_history_batch_download_returns_selected_artifacts(self):
        from pathlib import Path

        from backend import app as backend_app
        from fletcher.db import finish_fletcher_job

        with patch.object(backend_app, "_ensure_fletcher_worker_started"):
            response = self.client.post(
                "/api/fletcher/tailor/jobs",
                json={"description": "Build Python APIs", "title": "Backend Engineer"},
            )
        self.assertEqual(response.status_code, 200)
        item = response.json()

        review_id = "review_batch_test"
        attempt_dir = Path(self.runtime_dir) / "attempts" / "batch-test"
        attempt_dir.mkdir(parents=True)
        (attempt_dir / "output.pdf").write_bytes(b"%PDF no summary")
        (attempt_dir / "output.tex").write_text("resume tex", encoding="utf-8")
        log_path = attempt_dir / "pipeline_log.txt"
        log_path.write_text("queue log body", encoding="utf-8")

        doc = {
            "source_path": "<test>",
            "preamble": "",
            "header": {"name": "Michael Shi", "contact_line": "email"},
            "summary": "",
            "education": {
                "entry": {
                    "entry_id": "edu_primary",
                    "institution_and_degree": "University",
                    "date_text": "2026",
                },
                "bullets": [],
            },
            "experience": [],
            "projects": [],
            "skills": {"languages": ["Python"], "frameworks": [], "developer_tools": []},
        }
        package = {
            "review_id": review_id,
            "source": {"input_kind": "tex", "input_filename": "main.tex", "import_status": "ok"},
            "job": {"title": "Backend Engineer", "company": "", "description_hash": "abc"},
            "llm": {"provider": "heuristic", "model": "deterministic", "cloud": False},
            "keywords": {},
            "versions": {
                "no_summary": {
                    "original": doc,
                    "generated": doc,
                    "current": doc,
                    "pdf_url": f"/api/fletcher/reviews/{review_id}/versions/no_summary/pdf",
                    "tex_url": f"/api/fletcher/reviews/{review_id}/versions/no_summary/tex",
                    "dirty": False,
                    "compiled_revision": 0,
                    "compile_status": "ok",
                }
            },
            "log_url": f"/api/fletcher/reviews/{review_id}/log",
        }
        (Path(self.runtime_dir) / "review_index.json").write_text(
            json.dumps({review_id: str(attempt_dir)}), encoding="utf-8"
        )
        (attempt_dir / "review_package.json").write_text(json.dumps(package), encoding="utf-8")
        finish_fletcher_job(
            item["queue_item_id"],
            status="succeeded",
            result={"review_id": review_id},
            log_path=str(log_path),
            review_id=review_id,
        )

        response = self.client.post(
            "/api/fletcher/tailor/jobs/batch-download",
            json={
                "queue_item_ids": [item["queue_item_id"]],
                "artifacts": ["log", "no_summary_pdf"],
            },
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.headers["content-type"], "application/zip")
        with zipfile.ZipFile(io.BytesIO(response.content)) as archive:
            names = archive.namelist()
            self.assertTrue(any(name.endswith("/pipeline.log") for name in names))
            self.assertTrue(any(name.endswith("/resume_no_summary.pdf") for name in names))
            manifest = archive.read("manifest.txt").decode("utf-8")
        self.assertIn("resume_no_summary.pdf", manifest)

    def test_clear_generated_resumes_removes_job_resume_state_and_artifacts(self):
        from pathlib import Path

        from backend import app as backend_app
        from fletcher.db import (
            enqueue_fletcher_job,
            finish_fletcher_job,
            get_connection,
            init_resume_db,
        )

        init_resume_db()
        conn = get_connection()
        try:
            conn.execute(
                """
                INSERT INTO jobs (
                    id, title, company, description, source, enrichment_status, job_url,
                    latest_resume_attempt_id,
                    latest_resume_pdf_path, selected_resume_pdf_path,
                    selected_resume_ready_for_c3
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    14410,
                    "Firmware Engineer",
                    "Acme",
                    "Build firmware.",
                    "linkedin",
                    "done",
                    "https://example.com/jobs/14410",
                    1,
                    "old.pdf",
                    "old.pdf",
                    1,
                ),
            )
            artifact_dir = Path(self.runtime_dir) / "attempts" / "clear-test"
            artifact_dir.mkdir(parents=True)
            pdf_path = artifact_dir / "output.pdf"
            tex_path = artifact_dir / "output.tex"
            log_path = artifact_dir / "pipeline_log.txt"
            pdf_path.write_bytes(b"%PDF clear")
            tex_path.write_text("tex", encoding="utf-8")
            log_path.write_text("log", encoding="utf-8")
            conn.execute(
                """
                INSERT INTO resume_attempts (
                    id, job_id, attempt_type, status, latest_result_kind,
                    role_family, job_level, base_resume_name, source_resume_type,
                    source_resume_path, fallback_used, model_backend, model_name,
                    prompt_version, concern_flags, job_description_path, keywords_path,
                    structured_output_path, tex_path, pdf_path, compile_log_path,
                    metadata_path
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    1,
                    14410,
                    "job",
                    "done",
                    "tailored",
                    "software",
                    "mid",
                    "master",
                    "tex",
                    str(tex_path),
                    0,
                    "heuristic",
                    "deterministic",
                    "test",
                    "[]",
                    str(artifact_dir / "jd.txt"),
                    str(artifact_dir / "keywords.json"),
                    str(artifact_dir / "structured.json"),
                    str(tex_path),
                    str(pdf_path),
                    str(log_path),
                    str(artifact_dir / "metadata.json"),
                ),
            )
            conn.execute(
                """
                INSERT INTO resume_versions (
                    job_id, resume_attempt_id, source_type, label, pdf_path,
                    tex_path, content_hash, is_latest_generated,
                    is_latest_useful, is_selected_for_c3
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (14410, 1, "tex", "master", str(pdf_path), str(tex_path), "abc", 1, 1, 1),
            )
            conn.commit()
        finally:
            conn.close()

        with patch.object(backend_app, "_ensure_fletcher_worker_started"):
            queued = enqueue_fletcher_job({"job_id": 14410})
        review_id = "review_clear_test"
        (Path(self.runtime_dir) / "review_index.json").write_text(
            json.dumps({review_id: str(artifact_dir)}), encoding="utf-8"
        )
        finish_fletcher_job(
            queued["queue_item_id"],
            status="succeeded",
            result={"review_id": review_id},
            log_path=str(log_path),
            review_id=review_id,
        )

        response = self.client.post("/api/fletcher/resumes/clear", json={})

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(payload["resume_attempts_deleted"], 1)
        self.assertEqual(payload["fletcher_jobs_deleted"], 1)
        self.assertEqual(payload["artifact_dirs_removed"], 1)
        self.assertFalse(artifact_dir.exists())

        conn = get_connection()
        try:
            self.assertEqual(conn.execute("SELECT COUNT(*) FROM resume_attempts").fetchone()[0], 0)
            self.assertEqual(conn.execute("SELECT COUNT(*) FROM resume_versions").fetchone()[0], 0)
            self.assertEqual(conn.execute("SELECT COUNT(*) FROM fletcher_jobs").fetchone()[0], 0)
            job = conn.execute("SELECT * FROM jobs WHERE id = ?", (14410,)).fetchone()
            self.assertIsNone(job["latest_resume_attempt_id"])
            self.assertIsNone(job["selected_resume_pdf_path"])
            self.assertFalse(bool(job["selected_resume_ready_for_c3"]))
        finally:
            conn.close()

    def test_fletcher_queue_infers_history_title(self):
        from backend import app as backend_app

        with (
            patch.object(backend_app, "_ensure_fletcher_worker_started"),
            patch(
                "fletcher.jobs.title_inference.infer_title_from_description",
                return_value="Backend Engineer",
            ),
        ):
            response = self.client.post(
                "/api/fletcher/tailor/jobs",
                json={"description": "Backend Engineer\nBuild Python APIs"},
            )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["input"]["title"], "Backend Engineer")

    def test_fletcher_queue_accepts_option_a_job_id(self):
        from backend import app as backend_app

        conn = self.db.get_connection()
        try:
            conn.execute(
                """
                INSERT INTO jobs (
                    id, title, company, description, source, enrichment_status, job_url
                )
                VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    14406,
                    "Firmware Systems Design Engineer",
                    "Acme",
                    "Build embedded systems.",
                    "linkedin",
                    "done",
                    "https://example.com/jobs/14406",
                ),
            )
            conn.commit()
        finally:
            conn.close()

        with patch.object(backend_app, "_ensure_fletcher_worker_started"):
            response = self.client.post("/api/fletcher/tailor/jobs", json={"job_id": 14406})

        self.assertEqual(response.status_code, 200)
        item = response.json()
        self.assertEqual(item["input"]["job_id"], 14406)
        self.assertEqual(item["input"]["title"], "Firmware Systems Design Engineer")
        self.assertEqual(item["input"]["company"], "Acme")
        self.assertEqual(item["input"]["description"], "Build embedded systems.")

    def test_fletcher_worker_processes_option_a_job_id_queue_item(self):
        from pathlib import Path

        from backend import app as backend_app
        from fletcher.db import get_fletcher_job

        conn = self.db.get_connection()
        try:
            conn.execute(
                """
                INSERT INTO jobs (
                    id, title, company, description, source, enrichment_status, job_url
                )
                VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    14406,
                    "Firmware Systems Design Engineer",
                    "Acme",
                    "Build embedded systems.",
                    "linkedin",
                    "done",
                    "https://example.com/jobs/14406",
                ),
            )
            conn.commit()
        finally:
            conn.close()

        with patch.object(backend_app, "_ensure_fletcher_worker_started"):
            response = self.client.post("/api/fletcher/tailor/jobs", json={"job_id": 14406})
        self.assertEqual(response.status_code, 200)
        item = response.json()
        attempt_dir = Path(self.runtime_dir) / "option-a-worker"
        attempt_dir.mkdir(parents=True)
        pdf_path = attempt_dir / "output.pdf"
        tex_path = attempt_dir / "output.tex"
        log_path = attempt_dir / "pipeline_log.txt"
        pdf_path.write_bytes(b"%PDF option a")
        tex_path.write_text("resume tex", encoding="utf-8")
        log_path.write_text("pipeline ok", encoding="utf-8")
        selected_resume = attempt_dir / "selected_master.tex"
        selected_resume.write_text("selected resume tex", encoding="utf-8")

        with (
            patch(
                "fletcher.option_a_master.prepare_option_a_master_resume_source",
                return_value=(
                    str(selected_resume),
                    {
                        "selection": {"experience": [], "projects": []},
                        "title": "Firmware Systems Design Engineer",
                    },
                ),
            ) as prepare,
            patch(
                "fletcher.ad_hoc_pipeline.run_ad_hoc_pipeline",
                return_value={
                    "status": "done",
                    "review_id": "review-123",
                    "pdf_path": str(pdf_path),
                    "tex_path": str(tex_path),
                    "log_path": str(log_path),
                },
            ) as run_pipeline,
        ):
            processed = backend_app._process_next_fletcher_job()

        self.assertTrue(processed)
        prepare.assert_called_once()
        self.assertEqual(prepare.call_args.args[0]["id"], 14406)
        run_pipeline.assert_called_once()
        self.assertEqual(run_pipeline.call_args.kwargs["resume_path"], str(selected_resume))
        updated = get_fletcher_job(item["queue_item_id"])
        self.assertEqual(updated["status"], "succeeded")
        self.assertEqual(updated["progress"]["current_step"], "done")
        self.assertEqual(updated["progress"]["percent"], 100)
        self.assertEqual(
            updated["result"]["pdf_url"], "/api/fletcher/reviews/review-123/versions/no_summary/pdf"
        )
        self.assertEqual(
            updated["result"]["tex_url"], "/api/fletcher/reviews/review-123/versions/no_summary/tex"
        )
        self.assertEqual(updated["log_path"], str(log_path))

    def test_fletcher_worker_marks_option_a_pdf_compile_failure_failed(self):
        from pathlib import Path

        from backend import app as backend_app
        from fletcher.db import get_fletcher_job

        conn = self.db.get_connection()
        try:
            conn.execute(
                """
                INSERT INTO jobs (
                    id, title, company, description, source, enrichment_status, job_url
                )
                VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    14407,
                    "Firmware Systems Design Engineer",
                    "Acme",
                    "Build embedded systems.",
                    "linkedin",
                    "done",
                    "https://example.com/jobs/14407",
                ),
            )
            conn.commit()
        finally:
            conn.close()

        with patch.object(backend_app, "_ensure_fletcher_worker_started"):
            response = self.client.post("/api/fletcher/tailor/jobs", json={"job_id": 14407})
        self.assertEqual(response.status_code, 200)
        item = response.json()
        attempt_dir = Path(self.runtime_dir) / "option-a-worker-failed"
        attempt_dir.mkdir(parents=True)
        tex_path = attempt_dir / "output.tex"
        log_path = attempt_dir / "pipeline_log.txt"
        tex_path.write_text("resume tex", encoding="utf-8")
        log_path.write_text("compile failed", encoding="utf-8")
        selected_resume = attempt_dir / "selected_master.tex"
        selected_resume.write_text("selected resume tex", encoding="utf-8")

        with (
            patch(
                "fletcher.option_a_master.prepare_option_a_master_resume_source",
                return_value=(
                    str(selected_resume),
                    {
                        "selection": {"experience": [], "projects": []},
                        "title": "Firmware Systems Design Engineer",
                    },
                ),
            ),
            patch(
                "fletcher.ad_hoc_pipeline.run_ad_hoc_pipeline",
                return_value={
                    "status": "done",
                    "review_id": "review-failed",
                    "pdf_path": None,
                    "tex_path": str(tex_path),
                    "log_path": str(log_path),
                    "compile_status": "failed",
                },
            ),
        ):
            processed = backend_app._process_next_fletcher_job()

        self.assertTrue(processed)
        updated = get_fletcher_job(item["queue_item_id"])
        self.assertEqual(updated["status"], "failed")
        self.assertIsNone(updated["result"]["pdf_url"])
        self.assertEqual(
            updated["result"]["tex_url"],
            "/api/fletcher/reviews/review-failed/versions/no_summary/tex",
        )
        self.assertEqual(updated["result"]["compile_status"], "failed")
        self.assertEqual(updated["error"], "failed")

    def test_fletcher_recovery_requeues_interrupted_running_job(self):
        from fletcher.db import (
            claim_next_fletcher_job,
            enqueue_fletcher_job,
            recover_interrupted_fletcher_jobs,
        )

        item = enqueue_fletcher_job(
            {"title": "Azure Full Stack Developer", "description": "Build APIs."}
        )
        claimed = claim_next_fletcher_job()
        self.assertEqual(claimed["queue_item_id"], item["queue_item_id"])
        self.assertEqual(claimed["status"], "running")

        recovered = recover_interrupted_fletcher_jobs()

        self.assertEqual([row["queue_item_id"] for row in recovered], [item["queue_item_id"]])
        self.assertEqual(recovered[0]["status"], "queued")
        self.assertIsNone(recovered[0]["started_at"])
        self.assertEqual(recovered[0]["progress"]["current_step"], "requeued_after_worker_restart")
        self.assertEqual(recovered[0]["progress"]["previous_step"], "running")

        reclaimed = claim_next_fletcher_job()
        self.assertEqual(reclaimed["queue_item_id"], item["queue_item_id"])
        self.assertEqual(reclaimed["status"], "running")

    def test_fletcher_worker_start_recovers_interrupted_jobs_before_claiming(self):
        from backend import app as backend_app
        from fletcher.db import claim_next_fletcher_job, enqueue_fletcher_job, get_fletcher_job

        item = enqueue_fletcher_job(
            {"title": "Azure Full Stack Developer", "description": "Build APIs."}
        )
        claimed = claim_next_fletcher_job()
        self.assertEqual(claimed["status"], "running")

        backend_app._fletcher_worker_started = False
        with patch.object(backend_app.threading.Thread, "start"):
            backend_app._ensure_fletcher_worker_started()

        recovered = get_fletcher_job(item["queue_item_id"])
        self.assertEqual(recovered["status"], "queued")
        self.assertEqual(recovered["progress"]["current_step"], "requeued_after_worker_restart")

    def test_option_a_setting_syncs_master_resume_yaml_selection(self):
        from pathlib import Path

        master_path = Path(self.runtime_dir) / "master_resume.yaml"
        master_path.write_text(
            "selection:\n  min_experience: 2\n  max_experience: 4\nheader:\n  name: Test\n",
            encoding="utf-8",
        )

        with patch("fletcher.config.DEFAULT_MASTER_RESUME_PATH", master_path):
            response = self.client.post(
                "/api/settings",
                json={
                    "component": "c2",
                    "key": "option_a_min_experience",
                    "value": "3",
                    "value_type": "text",
                    "secret": False,
                },
            )

        self.assertEqual(response.status_code, 200)
        text = master_path.read_text(encoding="utf-8")
        self.assertIn("  min_experience: 3", text)
        self.assertIn("  max_experience: 4", text)

    def test_fletcher_jobs_history_limit_parameter(self):
        from backend import app as backend_app

        with patch.object(backend_app, "_ensure_fletcher_worker_started"):
            self.client.post("/api/fletcher/tailor/jobs", json={"description": "First run"})
            self.client.post("/api/fletcher/tailor/jobs", json={"description": "Second run"})

            response = self.client.get("/api/fletcher/tailor/jobs?limit=1")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(len(response.json()["jobs"]), 1)

    def test_fletcher_history_job_can_be_deleted(self):
        from backend import app as backend_app
        from fletcher.db import finish_fletcher_job

        with patch.object(backend_app, "_ensure_fletcher_worker_started"):
            created = self.client.post(
                "/api/fletcher/tailor/jobs", json={"description": "Delete me"}
            ).json()
        finish_fletcher_job(created["queue_item_id"], status="failed", error="test")

        response = self.client.delete(f"/api/fletcher/tailor/jobs/{created['queue_item_id']}")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["deleted"], 1)

        response = self.client.get(f"/api/fletcher/tailor/jobs/{created['queue_item_id']}")
        self.assertEqual(response.status_code, 404)

    def test_linkedin_accounts_can_be_created_listed_and_reauth_requested(self):
        response = self.client.post(
            "/api/linkedin/accounts",
            json={
                "username": "user@example.com",
                "display_name": "Primary",
                "active": True,
            },
        )
        self.assertEqual(response.status_code, 200)
        account = response.json()["account"]
        self.assertEqual(account["username"], "user@example.com")
        self.assertEqual(account["display_name"], "Primary")
        self.assertTrue(account["active"])

        response = self.client.get("/api/linkedin/accounts")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["accounts"][0]["username"], "user@example.com")

    def test_system_status_reports_db_and_component_state(self):
        class FakeResponse:
            status_code = 200

            def __init__(self, payload):
                self._payload = payload

            def json(self):
                return self._payload

        class FakeClient:
            def __init__(self, timeout):
                self.timeout = timeout

            def __enter__(self):
                return self

            def __exit__(self, exc_type, exc, tb):
                return False

            def get(self, url, headers=None):
                return FakeResponse({"status": "ok", "url": url, "authorized": bool(headers)})

        with patch("backend.app.httpx.Client", FakeClient):
            response = self.client.get("/api/system/status")

        self.assertEqual(response.status_code, 200)
        data = response.json()
        self.assertEqual(data["db"]["status"], "ok")
        self.assertEqual(data["components"]["c1"]["status"], "ok")
        self.assertEqual(data["components"]["c2"]["status"], "ok")
        self.assertEqual(data["components"]["c4"]["status"], "ok")
        self.assertIn("pending_fills", data["components"]["c3"])

    def test_c3_bridge_uses_service_token_not_web_session(self):
        class FakeResponse:
            status_code = 200

            def json(self):
                return {"fills": []}

        class FakeAsyncClient:
            def __init__(self, timeout):
                self.timeout = timeout

            async def __aenter__(self):
                return self

            async def __aexit__(self, exc_type, exc, tb):
                return False

            async def get(self, url, headers=None):
                return FakeResponse()

        with patch("backend.gateway.httpx.AsyncClient", FakeAsyncClient):
            response = self.client.get(
                "/api/c3/pending-fills",
                headers={"Authorization": "Bearer service-secret"},
            )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {"fills": []})

    def test_option_a_fletcher_generate_proxies_with_long_timeout(self):
        calls = {}

        class FakeResponse:
            status_code = 200

            def json(self):
                return {"job_id": 123, "status": "done", "pdf_path": "out.pdf"}

        class FakeAsyncClient:
            def __init__(self, timeout):
                calls["timeout"] = timeout

            async def __aenter__(self):
                return self

            async def __aexit__(self, exc_type, exc, tb):
                return False

            async def post(self, url, json=None, headers=None):
                calls["url"] = url
                calls["json"] = json
                calls["headers"] = headers or {}
                return FakeResponse()

        with (
            patch("backend.gateway.httpx.AsyncClient", FakeAsyncClient),
            patch("hunter.config.HUNT_SERVICE_TOKEN", "service-secret"),
        ):
            response = self.client.post("/api/gateway/c2/generate", json={"job_id": 123})

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["job_id"], 123)
        self.assertTrue(calls["url"].endswith("/generate"))
        self.assertEqual(calls["json"], {"job_id": 123})
        self.assertEqual(calls["timeout"], 900)
        self.assertEqual(calls["headers"].get("Authorization"), "Bearer service-secret")

    def test_fletcher_tailor_returns_log_payload_when_pdf_generation_fails(self):
        from pathlib import Path

        log_path = Path(tempfile.mkdtemp()) / "pipeline_log.txt"
        log_path.write_text("compile failed because of latex", encoding="utf-8")

        with (
            patch("fletcher.jobs.title_inference.infer_title_from_description", return_value="SWE"),
            patch(
                "fletcher.ad_hoc_pipeline.run_ad_hoc_pipeline",
                return_value={
                    "pdf_path": None,
                    "pdf_path_summary": None,
                    "log_path": str(log_path),
                    "compile_status": "failed",
                    "fits_one_page": False,
                    "llm_error": "summary_line_check_missing_pdf",
                },
            ),
        ):
            response = self.client.post(
                "/api/fletcher/tailor",
                data={"job_details": "Software role", "personal_details": ""},
            )

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertIsNone(payload["no_summary"])
        self.assertIsNone(payload["with_summary"])
        self.assertEqual(payload["error_type"], "PDFGenerationError")
        self.assertEqual(payload["compile_status"], "failed")
        self.assertIsNotNone(payload["log"])


if __name__ == "__main__":
    unittest.main()
