import json
import os
import shutil
import sys
import tempfile
import unittest
from unittest.mock import AsyncMock, patch

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
                "HUNT_AUDIT_LOG_ROOT": self.runtime_dir,
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

    def test_public_employer_requeue_uses_worker_eligibility(self):
        conn = self.db.get_connection()
        for index, status, apply_type, ats in (
            (1, "new", "unknown", "workday"),
            (2, "applied", "unknown", "workday"),
            (3, "new", "easy_apply", "workday"),
            (4, "new", "unknown", "unsupported"),
        ):
            conn.execute(
                "INSERT INTO jobs (id,title,job_url,source,status,apply_type,ats_type,enrichment_status,enrichment_attempts) VALUES (?,?,?,?,?,?,?,?,?)",
                (
                    index,
                    "IT Support",
                    f"https://example.com/{index}",
                    "employer_workday",
                    status,
                    apply_type,
                    ats,
                    "blocked",
                    99,
                ),
            )
        conn.commit()
        conn.close()
        self.assertEqual(self.client.post("/api/jobs/1/requeue").status_code, 200)
        self.assertEqual(self.db.get_job_by_id(1)["enrichment_status"], "pending")
        self.assertEqual(self.db.count_ready_public_employer_jobs(), 1)
        for index in (2, 3, 4):
            self.assertEqual(self.client.post(f"/api/jobs/{index}/requeue").status_code, 400)
            self.assertEqual(self.db.get_job_by_id(index)["enrichment_status"], "blocked")

    def test_discovery_gateway_forwards_authenticated_preview_and_health_requests(self):
        from fastapi.responses import JSONResponse

        from hunter.config import HUNT_HUNTER_URL

        body = {"company": "Example", "url": "https://example.com/careers"}
        routes = [
            ("POST", "preview", {"json": body}, {"saved": False, "sample": []}),
            (
                "GET",
                "health",
                {},
                {
                    "sources": [{"source": "job_bank", "status": "partial"}],
                    "company_fetch_queue": [],
                },
            ),
        ]
        for method, route, options, payload in routes:
            with (
                self.subTest(route=route),
                patch(f"backend.gateway._proxy_{method.lower()}", new_callable=AsyncMock) as proxy,
            ):
                proxy.return_value = JSONResponse(payload)
                response = self.client.request(
                    method, f"/api/gateway/c1/discovery/{route}", **options
                )
                self.assertEqual(response.status_code, 200)
                self.assertEqual(response.json(), payload)
                url = f"{HUNT_HUNTER_URL}/discovery/{route}"
                proxy.assert_awaited_once_with(url, *([body] if method == "POST" else []))
        self.client.cookies.clear()
        for method, route, options, _ in routes:
            self.assertEqual(
                self.client.request(
                    method, f"/api/gateway/c1/discovery/{route}", **options
                ).status_code,
                401,
            )

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
        audit_path = os.path.join(self.runtime_dir, "human-commands.jsonl")
        with open(audit_path, encoding="utf-8") as stream:
            audit_event = json.loads(stream.readline())
        audit_json = json.dumps(audit_event)
        self.assertEqual(audit_event["payload"]["action"], "c0.http_mutation")
        self.assertEqual(audit_event["payload"]["details"]["method"], "POST")
        self.assertEqual(audit_event["payload"]["details"]["route"], "/api/settings")
        self.assertEqual(audit_event["payload"]["details"]["status"], 200)
        self.assertNotIn("openrouter_api_key", audit_json)
        self.assertNotIn("sk-test", audit_json)

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

    def test_fletcher_queue_rejects_option_a_job_without_description(self):
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
                    14407,
                    "Machine Learning Platform Engineer",
                    "RBC",
                    "",
                    "linkedin",
                    "pending",
                    "https://example.com/jobs/14407",
                ),
            )
            conn.commit()
        finally:
            conn.close()

        with patch.object(backend_app, "_ensure_fletcher_worker_started"):
            response = self.client.post("/api/fletcher/tailor/jobs", json={"job_id": 14407})

        self.assertEqual(response.status_code, 400)
        self.assertIn("has no job description", response.json()["detail"])

    def test_option_a_queue_worker_publishes_only_verified_success(self):
        from pathlib import Path

        from backend import app as backend_app
        from fletcher.db import get_fletcher_job

        for job_id, mode in enumerate(["ok", "compile_failure", "llm_unavailable"], start=14406):
            with self.subTest(mode=mode):
                conn = self.db.get_connection()
                try:
                    conn.execute(
                        "INSERT INTO jobs (id, title, company, description, source, enrichment_status, job_url) "
                        "VALUES (?, ?, ?, ?, ?, ?, ?)",
                        (
                            job_id,
                            "Engineer",
                            "Acme",
                            "Build systems.",
                            "linkedin",
                            "done",
                            f"https://example.com/jobs/{job_id}",
                        ),
                    )
                    conn.commit()
                finally:
                    conn.close()
                with patch.object(backend_app, "_ensure_fletcher_worker_started"):
                    response = self.client.post(
                        "/api/fletcher/tailor/jobs", json={"job_id": job_id}
                    )
                self.assertEqual(response.status_code, 200)
                folder = Path(self.runtime_dir) / mode
                folder.mkdir()
                selected_resume = folder / "selected_master.tex"
                tex = folder / "output.tex"
                log = folder / "pipeline_log.txt"
                pdf = folder / "output.pdf"
                selected_resume.write_text("selected source")
                tex.write_text("resume tex")
                log.write_text(mode)
                outcome = {
                    "status": "done",
                    "review_id": mode,
                    "tex_path": str(tex),
                    "log_path": str(log),
                    "pdf_path": None,
                }
                if mode == "compile_failure":
                    outcome["compile_status"] = "failed"
                else:
                    pdf.write_bytes(b"%PDF fixture")
                    outcome["pdf_path"] = str(pdf)
                if mode == "llm_unavailable":
                    outcome.update(
                        status="failed",
                        error_type="LLMUnavailableError",
                        error="LLM unavailable: host not found",
                        llm_error="host not found",
                    )

                with (
                    patch(
                        "fletcher.option_a_master.prepare_option_a_master_resume_source",
                        return_value=(
                            str(selected_resume),
                            {"selection": {"experience": [], "projects": []}, "title": "Engineer"},
                        ),
                    ) as prepare,
                    patch(
                        "fletcher.ad_hoc_pipeline.run_ad_hoc_pipeline", return_value=outcome
                    ) as run_pipeline,
                ):
                    self.assertTrue(backend_app._process_next_fletcher_job())
                prepare.assert_called_once()
                self.assertEqual(prepare.call_args.args[0]["id"], job_id)
                run_pipeline.assert_called_once()
                self.assertEqual(run_pipeline.call_args.kwargs["resume_path"], str(selected_resume))
                updated = get_fletcher_job(response.json()["queue_item_id"])
                self.assertEqual(updated["status"], "succeeded" if mode == "ok" else "failed")
                artifact = updated["result"]
                if mode == "llm_unavailable":
                    self.assertEqual(updated["error"], outcome["error"])
                    self.assertEqual(artifact["error_type"], outcome["error_type"])
                    self.assertEqual(artifact["llm_error"], outcome["llm_error"])
                else:
                    base = f"/api/fletcher/reviews/{mode}/versions/no_summary"
                    self.assertEqual(artifact["tex_url"], base + "/tex")
                    if mode == "compile_failure":
                        self.assertIsNone(artifact["pdf_url"])
                        self.assertEqual(artifact["compile_status"], "failed")
                        self.assertEqual(updated["error"], "failed")
                    else:
                        self.assertEqual(artifact["pdf_url"], base + "/pdf")
                        self.assertEqual(updated["progress"]["current_step"], "done")
                        self.assertEqual(updated["progress"]["percent"], 100)
                        self.assertEqual(updated["log_path"], str(log))

    def test_fletcher_worker_marks_job_failed_when_queue_log_setup_fails(self):
        from backend import app as backend_app
        from fletcher.db import get_fletcher_job

        with patch.object(backend_app, "_ensure_fletcher_worker_started"):
            response = self.client.post(
                "/api/fletcher/tailor/jobs",
                json={"description": "Build Python APIs", "title": "Backend Engineer"},
            )
        self.assertEqual(response.status_code, 200)
        item = response.json()

        with patch.object(
            backend_app,
            "_fletcher_queue_log_path",
            side_effect=RuntimeError("queue log unavailable"),
        ):
            processed = backend_app._process_next_fletcher_job()

        self.assertTrue(processed)
        updated = get_fletcher_job(item["queue_item_id"])
        self.assertEqual(updated["status"], "failed")
        self.assertEqual(updated["error"], "queue log unavailable")
        self.assertIsNone(updated["log_path"])

    def test_fletcher_late_finish_does_not_overwrite_cancelled_job(self):
        from fletcher.db import (
            cancel_fletcher_job,
            claim_next_fletcher_job,
            enqueue_fletcher_job,
            finish_fletcher_job,
        )

        item = enqueue_fletcher_job(
            {"title": "Azure Full Stack Developer", "description": "Build APIs."}
        )
        claim_next_fletcher_job()
        cancel_fletcher_job(item["queue_item_id"])

        finished = finish_fletcher_job(
            item["queue_item_id"],
            status="succeeded",
            result={"review_id": "late-review"},
            review_id="late-review",
        )

        self.assertEqual(finished["status"], "cancelled")
        self.assertNotEqual(finished["result"].get("review_id"), "late-review")
        self.assertIsNone(finished["review_id"])

    def test_fletcher_bulk_cancel_endpoint_cancels_active_jobs(self):
        from backend import app as backend_app

        with patch.object(backend_app, "_ensure_fletcher_worker_started"):
            one = self.client.post(
                "/api/fletcher/tailor/jobs",
                json={"description": "Build APIs", "title": "Backend Engineer"},
            ).json()
            two = self.client.post(
                "/api/fletcher/tailor/jobs",
                json={"description": "Build data pipelines", "title": "Data Engineer"},
            ).json()

        response = self.client.post(
            "/api/fletcher/tailor/jobs/bulk-cancel",
            json={"queue_item_ids": [one["queue_item_id"], two["queue_item_id"]]},
        )

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(payload["cancelled"], 2)
        self.assertEqual([job["status"] for job in payload["jobs"]], ["cancelled", "cancelled"])

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

    def test_active_component_human_commands_are_written_and_redacted(self):
        response = self.client.post(
            "/api/audit/events",
            json={
                "event_id": "evt-test",
                "ts": "2026-07-30T12:00:00Z",
                "component": "c0",
                "event_type": "human.command",
                "actor": {
                    "type": "human",
                    "id": "Jane Doe",
                    "surface": "Candidate: Jane Doe",
                },
                "trace_id": "SSN 123-45-6789",
                "payload": {
                    "eventContext": {
                        "component": "c0",
                        "route": "/jobs/7",
                        "page": "Candidate: Jane Doe",
                    },
                    "action": "c0.job.patch",
                    "buttonId": "edit-job-field",
                    "details": {
                        "jobId": 7,
                        "fields": ["title", "full_name=Jane Doe"],
                    },
                },
            },
        )

        self.assertEqual(response.status_code, 200)
        result = response.json()
        self.assertNotEqual(result["event_id"], "evt-test")
        self.assertTrue(result["event_id"].startswith("evt_"))
        audit_path = os.path.join(self.runtime_dir, "human-commands.jsonl")
        with open(audit_path, encoding="utf-8") as stream:
            event = json.loads(stream.readline())
        serialized = json.dumps(event)
        self.assertEqual(event["component"], "c0")
        self.assertEqual(event["actor"], {"type": "human", "id": "human_local", "surface": "c0_ui"})
        self.assertEqual(event["payload"]["details"]["jobId"], 7)
        self.assertEqual(event["payload"]["details"]["fields"], ["title"])
        self.assertEqual(event["payload"]["eventContext"]["page"], "[REDACTED]")
        self.assertEqual(event["trace_id"], "[REDACTED]")
        for forbidden in (
            "Jane Doe",
            "123-45-6789",
        ):
            self.assertNotIn(forbidden, serialized)
        self.assertIn("human_command_no_form_values", event["redaction"]["rules"])

        rejected = self.client.post(
            "/api/audit/events",
            json={
                "component": "c3",
                "event_type": "human.command",
                "actor": {"type": "human", "id": "human_local", "surface": "c0_ui"},
                "payload": {"action": "c3.run"},
            },
        )
        self.assertEqual(rejected.status_code, 422)

        unknown_action = self.client.post(
            "/api/audit/events",
            json={
                "component": "c0",
                "event_type": "human.command",
                "actor": {"type": "human"},
                "payload": {"action": "c0.unknown", "buttonId": "Jane Doe"},
            },
        )
        self.assertEqual(unknown_action.status_code, 422)

        mismatched_component = self.client.post(
            "/api/audit/events",
            json={
                "component": "c2",
                "event_type": "human.command",
                "actor": {"type": "human"},
                "payload": {
                    "action": "c0.job.requeue",
                    "buttonId": "requeue-job",
                    "details": {"jobId": 7},
                },
            },
        )
        self.assertEqual(mismatched_component.status_code, 422)

        adversarial_key = self.client.post(
            "/api/audit/events",
            json={
                "component": "c0",
                "event_type": "human.command",
                "actor": {"type": "human"},
                "payload": {
                    "action": "c0.job.requeue",
                    "buttonId": "requeue-job",
                    "details": {
                        "jobId": 7,
                        "Candidate Jane Doe SSN 123-45-6789": "x",
                    },
                },
            },
        )
        self.assertEqual(adversarial_key.status_code, 422)

        adversarial_payload_key = self.client.post(
            "/api/audit/events",
            json={
                "component": "c0",
                "event_type": "human.command",
                "actor": {"type": "human"},
                "payload": {
                    "action": "c0.job.requeue",
                    "buttonId": "requeue-job",
                    "details": {"jobId": 7},
                    "Home address 123 Main Street": "x",
                },
            },
        )
        self.assertEqual(adversarial_payload_key.status_code, 422)

        client_redaction = self.client.post(
            "/api/audit/events",
            json={
                "component": "c0",
                "event_type": "human.command",
                "actor": {"type": "human"},
                "payload": {
                    "action": "c0.job.requeue",
                    "buttonId": "requeue-job",
                    "details": {"jobId": 7},
                },
                "redaction": {
                    "applied": False,
                    "Candidate Jane Doe SSN 123-45-6789": "x" * 1000,
                },
            },
        )
        self.assertEqual(client_redaction.status_code, 422)

        oversized_fields = self.client.post(
            "/api/audit/events",
            json={
                "component": "c0",
                "event_type": "human.command",
                "actor": {"type": "human"},
                "payload": {
                    "action": "c0.job.patch",
                    "buttonId": "edit-job-field",
                    "details": {"jobId": 7, "fields": ["title"] * 33},
                },
            },
        )
        self.assertEqual(oversized_fields.status_code, 422)

        oversized_request = self.client.post(
            "/api/audit/events",
            json={
                "component": "c0",
                "event_type": "human.command",
                "actor": {
                    "type": "human",
                    "id": "x" * 25_000,
                },
                "payload": {
                    "action": "c0.job.requeue",
                    "buttonId": "requeue-job",
                    "details": {"jobId": 7},
                },
            },
        )
        self.assertEqual(oversized_request.status_code, 413)
        with open(audit_path, encoding="utf-8") as stream:
            durable_audit = stream.read()
        for forbidden in (
            "Candidate Jane Doe",
            "123-45-6789",
            "Home address",
            "123 Main Street",
        ):
            self.assertNotIn(forbidden, durable_audit)

    def test_audit_events_require_session_when_service_token_is_blank(self):
        from backend.app import app

        anonymous = TestClient(app)
        with patch("hunter.config.HUNT_SERVICE_TOKEN", ""):
            response = anonymous.post(
                "/api/audit/events",
                json={
                    "component": "c0",
                    "event_type": "human.command",
                    "actor": {
                        "type": "human",
                        "id": "human_local",
                        "surface": "c0_ui",
                    },
                    "payload": {"action": "c0.job.requeue"},
                },
            )

        self.assertEqual(response.status_code, 401)

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


if __name__ == "__main__":
    unittest.main()
