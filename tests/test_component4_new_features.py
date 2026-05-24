"""Tests for C4 new features: failure_log, scheduler, investigation routing, new CLI, new API routes."""

from __future__ import annotations

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

from coordinator.failure_log import (  # noqa: E402
    CAPTCHA_CODES,
    INVESTIGATION_TRIGGER_CODES,
    append_perma_log,
    derive_failure_code,
    merge_investigation_result,
    read_failure_log,
    write_failure_report,
)

SERVICE_TOKEN = "test-token-new"


def _auth():
    return {"Authorization": f"Bearer {SERVICE_TOKEN}"}


# ---------------------------------------------------------------------------
# failure_log unit tests
# ---------------------------------------------------------------------------


class FailureLogTests(unittest.TestCase):
    def test_derive_failure_code_explicit(self):
        result = derive_failure_code({"failure_code": "unknown_widget"}, [])
        self.assertEqual(result, "unknown_widget")

    def test_derive_failure_code_camel(self):
        result = derive_failure_code({"failureCode": "captcha_hcaptcha"}, [])
        self.assertEqual(result, "captcha_hcaptcha")

    def test_derive_failure_code_from_captcha_type(self):
        self.assertEqual(derive_failure_code({"captcha_type": "hcaptcha"}, []), "captcha_hcaptcha")
        self.assertEqual(derive_failure_code({"captchaType": "reCAPTCHA"}, []), "captcha_recaptcha")
        self.assertEqual(
            derive_failure_code({"captcha_type": "cloudflare"}, []), "captcha_cloudflare"
        )
        self.assertEqual(derive_failure_code({"captcha_type": "mystery"}, []), "captcha_unknown")

    def test_derive_failure_code_from_flags(self):
        self.assertEqual(derive_failure_code({}, ["unknown_widget"]), "unknown_widget")
        self.assertEqual(derive_failure_code({}, ["captcha_challenge"]), "captcha_unknown")
        self.assertEqual(derive_failure_code({}, ["login_required"]), "login_required")
        self.assertEqual(derive_failure_code({}, ["otp_required"]), "otp_required")

    def test_derive_failure_code_from_status(self):
        self.assertEqual(derive_failure_code({"status": "failed"}, []), "fill_failed")
        self.assertEqual(derive_failure_code({"status": "error"}, []), "fill_failed")
        self.assertEqual(derive_failure_code({"status": "manual_review"}, []), "manual_review")

    def test_derive_failure_code_unknown(self):
        self.assertEqual(derive_failure_code({}, []), "unknown")

    def test_investigation_trigger_codes_cover_unknown_widget_and_captcha(self):
        self.assertIn("unknown_widget", INVESTIGATION_TRIGGER_CODES)
        for code in CAPTCHA_CODES:
            self.assertIn(code, INVESTIGATION_TRIGGER_CODES)

    def test_write_failure_report_creates_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            run_dir = Path(tmp) / "run-test"
            path, report = write_failure_report(
                run_dir,
                run_id="run-test",
                job_id=99,
                ats_type="workday",
                apply_url="https://example.com/apply",
                failure_code="unknown_widget",
                fill_result={"unknown_widget": {"selector": "#btn", "role": "button"}},
            )
            self.assertTrue(path.exists())
            self.assertEqual(report["failure_code"], "unknown_widget")
            self.assertEqual(report["unknown_widget"]["selector"], "#btn")
            self.assertEqual(report["investigation_status"], "pending")
            loaded = json.loads(path.read_text())
            self.assertEqual(loaded["run_id"], "run-test")

    def test_append_perma_log_creates_and_appends(self):
        with tempfile.TemporaryDirectory() as tmp:
            logs = Path(tmp) / "logs"
            append_perma_log(logs, {"run_id": "r1", "failure_code": "login_required"})
            append_perma_log(logs, {"run_id": "r2", "failure_code": "fill_failed"})
            entries = read_failure_log(logs, limit=100)
            self.assertEqual(len(entries), 2)
            self.assertEqual(entries[0]["run_id"], "r1")
            self.assertEqual(entries[1]["run_id"], "r2")

    def test_read_failure_log_respects_limit(self):
        with tempfile.TemporaryDirectory() as tmp:
            logs = Path(tmp) / "logs"
            for i in range(10):
                append_perma_log(logs, {"run_id": f"r{i}"})
            entries = read_failure_log(logs, limit=3)
            self.assertEqual(len(entries), 3)
            self.assertEqual(entries[-1]["run_id"], "r9")

    def test_read_failure_log_empty(self):
        with tempfile.TemporaryDirectory() as tmp:
            entries = read_failure_log(Path(tmp) / "logs")
            self.assertEqual(entries, [])

    def test_merge_investigation_result(self):
        with tempfile.TemporaryDirectory() as tmp:
            run_dir = Path(tmp) / "run"
            path, _ = write_failure_report(
                run_dir,
                run_id="run-x",
                job_id=1,
                ats_type="workday",
                apply_url="https://example.com",
                failure_code="unknown_widget",
                fill_result={},
            )
            merged = merge_investigation_result(
                path,
                {
                    "status": "complete",
                    "failure_code_confirmed": "unknown_widget",
                    "agent_findings": "found a custom dropdown",
                    "suggested_fix_area": "generic V2 option collection",
                    "widget_details": {
                        "selector": "#custom-select",
                        "role": "listbox",
                        "label": "Country",
                        "html_excerpt": "<div role=listbox>",
                    },
                    "screenshots": ["path/to/shot.png"],
                    "html_snapshot": "path/to/snap.html",
                },
            )
            self.assertEqual(merged["investigation_status"], "complete")
            self.assertEqual(merged["agent_findings"], "found a custom dropdown")
            self.assertEqual(merged["unknown_widget"]["selector"], "#custom-select")
            self.assertEqual(merged["screenshots"], ["path/to/shot.png"])

    def test_merge_captcha_investigation_result_sets_captcha_escalated(self):
        with tempfile.TemporaryDirectory() as tmp:
            run_dir = Path(tmp) / "run"
            path, _ = write_failure_report(
                run_dir,
                run_id="r",
                job_id=1,
                ats_type="workday",
                apply_url="https://example.com",
                failure_code="captcha_hcaptcha",
                fill_result={},
            )
            merged = merge_investigation_result(path, {"status": "captcha_blocked"})
            self.assertEqual(merged["investigation_status"], "captcha_escalated")


# ---------------------------------------------------------------------------
# Scheduler unit tests
# ---------------------------------------------------------------------------


class SchedulerTests(unittest.TestCase):
    def test_scheduler_tick_calls_run_once(self):
        from coordinator.scheduler import SchedulerLoop

        class FakeSvc:
            called = False

            def run_once(self, **_kw):
                self.called = True
                return {"decision": "idle", "reason": "no_ready_jobs"}

        svc = FakeSvc()
        loop = SchedulerLoop(svc, interval_seconds=60)
        result = loop.tick()
        self.assertTrue(svc.called)
        self.assertEqual(result["decision"], "idle")
        self.assertEqual(loop._tick_count, 1)
        self.assertIsNotNone(loop._last_tick)

    def test_scheduler_status_initial(self):
        from coordinator.scheduler import SchedulerLoop

        class FakeSvc:
            def run_once(self, **_kw):
                return {}

        loop = SchedulerLoop(FakeSvc(), interval_seconds=30)
        status = loop.status()
        self.assertFalse(status["running"])
        self.assertEqual(status["interval_seconds"], 30)
        self.assertIsNone(status["last_tick"])
        self.assertEqual(status["tick_count"], 0)

    def test_scheduler_start_stop(self):
        import time

        from coordinator.scheduler import SchedulerLoop

        ticks = []

        class FakeSvc:
            def run_once(self, **_kw):
                ticks.append(1)
                return {"decision": "idle"}

        loop = SchedulerLoop(FakeSvc(), interval_seconds=0)
        loop.start()
        time.sleep(0.1)
        loop.stop()
        self.assertFalse(loop._running)
        self.assertGreater(len(ticks), 0)


# ---------------------------------------------------------------------------
# Investigation routing integration tests
# ---------------------------------------------------------------------------


def _make_temp_context(resume_path: str | None = None):
    """Return (db_path, root_dir) temp context as a context manager."""

    class _Ctx:
        def __enter__(self):
            from hunter import db as hdb

            self._db_fd, self.db_path = tempfile.mkstemp(suffix=".db")
            os.close(self._db_fd)
            self._old_db_path = hdb.DB_PATH
            hdb.DB_PATH = self.db_path
            hdb.init_db()
            os.environ["HUNT_DB_PATH"] = self.db_path
            self._root = tempfile.TemporaryDirectory()
            os.environ["HUNT_COORDINATOR_ROOT"] = self._root.name
            return self.db_path, self._root.name

        def __exit__(self, *_):
            from hunter import db as hdb

            hdb.DB_PATH = self._old_db_path
            os.environ.pop("HUNT_DB_PATH", None)
            os.environ.pop("HUNT_COORDINATOR_ROOT", None)
            os.environ.pop("HUNT_ORCHESTRATION_ROOT", None)
            if os.path.exists(self.db_path):
                os.remove(self.db_path)
            self._root.cleanup()

    return _Ctx()


def _insert_ready_job(db_path: str, resume_path: str) -> int:
    conn = sqlite3.connect(db_path)
    try:
        cur = conn.execute(
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
            ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
            """,
            (
                "SWE",
                "Acme",
                "Remote",
                "https://linkedin.com/jobs/view/1",
                "https://acme.wd5.myworkdayjobs.com/job/1",
                "Desc.",
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
                "resume-v1",
                resume_path,
                str(REPO_ROOT / "main.tex"),
                None,
                1,
            ),
        )
        job_id = cur.lastrowid
        conn.commit()
        return job_id
    finally:
        conn.close()


class InvestigationRoutingTests(unittest.TestCase):
    def _make_resume(self, tmp: str) -> str:
        p = Path(tmp) / "resume.pdf"
        p.write_bytes(b"%PDF-1.4 fake")
        return str(p)

    def test_unknown_widget_fill_result_routes_to_investigation_queued(self):
        with tempfile.TemporaryDirectory() as tmp:
            with _make_temp_context() as (db_path, root):
                resume = self._make_resume(tmp)
                job_id = _insert_ready_job(db_path, resume)
                from coordinator.service import OrchestrationService

                svc = OrchestrationService(db_path=db_path, runtime_root=root)
                ctx = svc.build_apply_context(job_id)
                svc.request_fill(ctx.run_id)
                result = svc.record_fill_result_inline(
                    ctx.run_id,
                    {
                        "status": "failed",
                        "failure_code": "unknown_widget",
                        "unknown_widget": {
                            "selector": "#custom-btn",
                            "role": "button",
                            "label": "Custom",
                        },
                    },
                )
                run = result["run"]
                self.assertEqual(run["status"], "investigation_queued")
                self.assertEqual(result["failure_code"], "unknown_widget")
                self.assertIsNotNone(result["failure_report_path"])
                report_path = Path(result["failure_report_path"])
                self.assertTrue(report_path.exists())
                report = json.loads(report_path.read_text())
                self.assertEqual(report["failure_code"], "unknown_widget")
                self.assertEqual(report["investigation_status"], "pending")

    def test_normal_fill_failure_routes_to_failed(self):
        with tempfile.TemporaryDirectory() as tmp:
            with _make_temp_context() as (db_path, root):
                resume = self._make_resume(tmp)
                job_id = _insert_ready_job(db_path, resume)
                from coordinator.service import OrchestrationService

                svc = OrchestrationService(db_path=db_path, runtime_root=root)
                ctx = svc.build_apply_context(job_id)
                svc.request_fill(ctx.run_id)
                result = svc.record_fill_result_inline(
                    ctx.run_id,
                    {"status": "failed", "message": "page crashed"},
                )
                self.assertEqual(result["run"]["status"], "failed")
                self.assertEqual(result["failure_code"], "fill_failed")

    def test_captcha_fill_result_routes_to_investigation_queued(self):
        with tempfile.TemporaryDirectory() as tmp:
            with _make_temp_context() as (db_path, root):
                resume = self._make_resume(tmp)
                job_id = _insert_ready_job(db_path, resume)
                from coordinator.service import OrchestrationService

                svc = OrchestrationService(db_path=db_path, runtime_root=root)
                ctx = svc.build_apply_context(job_id)
                svc.request_fill(ctx.run_id)
                result = svc.record_fill_result_inline(
                    ctx.run_id,
                    {"status": "failed", "failure_code": "captcha_hcaptcha"},
                )
                self.assertEqual(result["run"]["status"], "investigation_queued")

    def test_allow_submit_included_in_pending_fill(self):
        with tempfile.TemporaryDirectory() as tmp:
            with _make_temp_context() as (db_path, root):
                resume = self._make_resume(tmp)
                job_id = _insert_ready_job(db_path, resume)
                from coordinator.service import OrchestrationService

                svc = OrchestrationService(db_path=db_path, runtime_root=root)
                ctx = svc.build_apply_context(job_id)
                svc.request_fill(ctx.run_id)
                fills = svc.get_pending_fills(limit=5)
                self.assertEqual(len(fills), 1)
                self.assertIn("allow_submit", fills[0])
                self.assertFalse(fills[0]["allow_submit"])

    def test_queue_investigation_manually(self):
        with tempfile.TemporaryDirectory() as tmp:
            with _make_temp_context() as (db_path, root):
                resume = self._make_resume(tmp)
                job_id = _insert_ready_job(db_path, resume)
                from coordinator.service import OrchestrationService

                svc = OrchestrationService(db_path=db_path, runtime_root=root)
                ctx = svc.build_apply_context(job_id)
                svc.request_fill(ctx.run_id)
                svc.record_fill_result_inline(ctx.run_id, {"status": "failed", "message": "x"})
                result = svc.queue_investigation(ctx.run_id)
                self.assertEqual(result["run"]["status"], "investigation_queued")

    def test_claim_investigation_lease(self):
        with tempfile.TemporaryDirectory() as tmp:
            with _make_temp_context() as (db_path, root):
                resume = self._make_resume(tmp)
                job_id = _insert_ready_job(db_path, resume)
                from coordinator.service import OrchestrationService

                svc = OrchestrationService(db_path=db_path, runtime_root=root)
                ctx = svc.build_apply_context(job_id)
                svc.request_fill(ctx.run_id)
                svc.record_fill_result_inline(
                    ctx.run_id,
                    {"status": "failed", "failure_code": "unknown_widget"},
                )
                claim = svc.claim_next_fill(
                    runtime_name="hermes_local",
                    browser_lane="isolated",
                    task_type="investigation",
                )
                self.assertTrue(claim["claimed"])
                self.assertEqual(claim["fill"]["run_id"], ctx.run_id)
                self.assertEqual(claim["fill"]["failure_code"], "unknown_widget")

    def test_get_failure_log_returns_entries(self):
        with tempfile.TemporaryDirectory() as tmp:
            with _make_temp_context() as (db_path, root):
                resume = self._make_resume(tmp)
                job_id = _insert_ready_job(db_path, resume)
                from coordinator.service import OrchestrationService

                svc = OrchestrationService(db_path=db_path, runtime_root=root)
                ctx = svc.build_apply_context(job_id)
                svc.request_fill(ctx.run_id)
                svc.record_fill_result_inline(
                    ctx.run_id,
                    {"status": "failed", "failure_code": "unknown_widget"},
                )
                entries = svc.get_failure_log(limit=10)
                self.assertEqual(len(entries), 1)
                self.assertEqual(entries[0]["failure_code"], "unknown_widget")


# ---------------------------------------------------------------------------
# New CLI command tests
# ---------------------------------------------------------------------------


class NewCliCommandTests(unittest.TestCase):
    def _run_cli(self, argv):
        from coordinator.cli import main

        return main(argv)

    def test_failure_log_command_empty(self):
        with tempfile.TemporaryDirectory():
            with _make_temp_context() as (db_path, root):
                import io
                from contextlib import redirect_stdout

                buf = io.StringIO()
                with redirect_stdout(buf):
                    rc = self._run_cli(
                        [
                            "failure-log",
                            "--db-path",
                            db_path,
                            "--runtime-root",
                            root,
                            "--limit",
                            "10",
                        ]
                    )
                self.assertEqual(rc, 0)
                data = json.loads(buf.getvalue())
                self.assertIn("items", data)
                self.assertEqual(data["items"], [])

    def test_investigate_command_requires_manual_review_or_failed_run(self):
        with tempfile.TemporaryDirectory() as tmp:
            with _make_temp_context() as (db_path, root):
                resume = Path(tmp) / "resume.pdf"
                resume.write_bytes(b"%PDF fake")
                job_id = _insert_ready_job(db_path, str(resume))
                from coordinator.service import OrchestrationService

                svc = OrchestrationService(db_path=db_path, runtime_root=root)
                ctx = svc.build_apply_context(job_id)
                svc.request_fill(ctx.run_id)
                svc.record_fill_result_inline(ctx.run_id, {"status": "failed"})
                import io
                from contextlib import redirect_stdout

                buf = io.StringIO()
                with redirect_stdout(buf):
                    rc = self._run_cli(
                        [
                            "investigate",
                            "--db-path",
                            db_path,
                            "--runtime-root",
                            root,
                            "--run-id",
                            ctx.run_id,
                        ]
                    )
                self.assertEqual(rc, 0)
                data = json.loads(buf.getvalue())
                self.assertEqual(data["run"]["status"], "investigation_queued")


# ---------------------------------------------------------------------------
# New API route tests
# ---------------------------------------------------------------------------


class NewApiRouteTests(unittest.TestCase):
    def setUp(self):
        from fastapi.testclient import TestClient

        from coordinator.service_api import app

        self.client = TestClient(app, raise_server_exceptions=True)

    def tearDown(self):
        import coordinator.scheduler as _sched_mod

        _sched_mod._scheduler = None

    def with_temp_context(self):
        class _Ctx:
            def __enter__(self_):
                from hunter import db as hdb

                self_._db_fd, self_.db_path = tempfile.mkstemp(suffix=".db")
                os.close(self_._db_fd)
                self_._old_db = hdb.DB_PATH
                hdb.DB_PATH = self_.db_path
                hdb.init_db()
                os.environ["HUNT_DB_PATH"] = self_.db_path
                self_._root = tempfile.TemporaryDirectory()
                os.environ["HUNT_COORDINATOR_ROOT"] = self_._root.name
                p = patch("hunter.config.HUNT_SERVICE_TOKEN", SERVICE_TOKEN)
                p.start()
                self_._patch = p
                return self_.db_path, self_._root.name

            def __exit__(self_, *_):
                from hunter import db as hdb

                self_._patch.stop()
                hdb.DB_PATH = self_._old_db
                os.environ.pop("HUNT_DB_PATH", None)
                os.environ.pop("HUNT_COORDINATOR_ROOT", None)
                os.environ.pop("HUNT_ORCHESTRATION_ROOT", None)
                if os.path.exists(self_.db_path):
                    os.remove(self_.db_path)
                self_._root.cleanup()

        return _Ctx()

    def test_scheduler_status_route(self):
        with self.with_temp_context():
            resp = self.client.get("/scheduler/status", headers=_auth())
            self.assertEqual(resp.status_code, 200)
            data = resp.json()
            self.assertIn("running", data)
            self.assertIn("tick_count", data)

    def test_scheduler_tick_idle(self):
        with self.with_temp_context():
            resp = self.client.post("/scheduler/tick", headers=_auth())
            self.assertEqual(resp.status_code, 200)
            data = resp.json()
            self.assertIn("decision", data)

    def test_failures_route_empty(self):
        with self.with_temp_context():
            resp = self.client.get("/failures", headers=_auth())
            self.assertEqual(resp.status_code, 200)
            data = resp.json()
            self.assertIn("failures", data)
            self.assertEqual(data["failures"], [])

    def test_failure_report_route_404_for_missing_run(self):
        with self.with_temp_context():
            resp = self.client.get("/runs/no-such-run/failure-report", headers=_auth())
            self.assertEqual(resp.status_code, 404)

    def test_investigate_route_requires_existing_run(self):
        with self.with_temp_context():
            resp = self.client.post("/runs/ghost-run/investigate", headers=_auth())
            self.assertEqual(resp.status_code, 400)


if __name__ == "__main__":
    unittest.main()
