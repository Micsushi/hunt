import json
import os
import sys
import tempfile
import unittest
from inspect import signature
from unittest.mock import patch

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, REPO_ROOT)


class ReviewOpsApiTests(unittest.TestCase):
    def setUp(self):
        fd, self.path = tempfile.mkstemp(suffix=".db")
        os.close(fd)
        self._env = patch.dict(os.environ, {"HUNT_DB_PATH": self.path}, clear=False)
        self._env.start()
        from hunter import db

        self.db = db
        self._old_db_path = db.DB_PATH
        db.DB_PATH = self.path
        db.init_db()
        _, job_id = db.add_job(
            {
                "title": "PM",
                "company": "Co",
                "location": "CA",
                "job_url": "https://www.linkedin.com/jobs/view/ops-test-1",
                "apply_url": None,
                "description": None,
                "source": "linkedin",
                "date_posted": "2026-04-08",
                "is_remote": 0,
                "level": "junior",
                "priority": 0,
                "category": "product",
                "apply_type": "unknown",
                "auto_apply_eligible": None,
                "enrichment_status": "pending",
                "enrichment_attempts": 1,
                "apply_host": None,
                "ats_type": None,
            }
        )
        self.job_id = job_id
        conn = db.get_connection()
        conn.execute(
            "UPDATE jobs SET enrichment_status = 'failed', last_enrichment_error = ? WHERE id = ?",
            ("auth_expired: LinkedIn session appears to be logged out or expired.", self.job_id),
        )
        conn.commit()
        conn.close()

    def tearDown(self):
        self.db.DB_PATH = self._old_db_path
        self._env.stop()
        if os.path.exists(self.path):
            os.remove(self.path)

    def test_api_ops_requeue_errors(self):
        from backend import app as control_plane_api

        response = control_plane_api.api_ops_requeue_errors(
            {"source": "linkedin", "error_codes": ["auth_expired"]}
        )
        self.assertEqual(response.status_code, 200)
        data = json.loads(response.body.decode())
        self.assertEqual(data["updated"], 1)
        row = self.db.get_job_by_id(self.job_id)
        self.assertEqual(row["enrichment_status"], "pending")
        self.assertIsNone(row["last_enrichment_error"])

    def test_api_ops_requeue_empty_codes(self):
        from fastapi import HTTPException

        from backend import app as control_plane_api

        with self.assertRaises(HTTPException) as ctx:
            control_plane_api.api_ops_requeue_errors({"source": "linkedin", "error_codes": []})
        self.assertEqual(ctx.exception.status_code, 400)

    def test_api_delete_job_translates_postgres_fk_violation(self):
        from fastapi import HTTPException

        from backend import app as control_plane_api

        class FakeForeignKeyViolation(Exception):
            pgcode = "23503"

        with patch.object(
            control_plane_api,
            "delete_jobs_by_ids",
            side_effect=FakeForeignKeyViolation("job still referenced"),
        ):
            with self.assertRaises(HTTPException) as ctx:
                control_plane_api.api_delete_job(self.job_id)
        self.assertEqual(ctx.exception.status_code, 409)
        self.assertIn("Database rejected the change", ctx.exception.detail)

    def test_bulk_delete_translates_postgres_fk_violation(self):
        from fastapi import HTTPException

        from backend import app as control_plane_api

        class FakeForeignKeyViolation(Exception):
            pgcode = "23503"

        with patch.object(
            control_plane_api,
            "delete_jobs_by_ids",
            side_effect=FakeForeignKeyViolation("job still referenced"),
        ):
            with self.assertRaises(HTTPException) as ctx:
                control_plane_api.api_jobs_bulk_selection(
                    {
                        "action": "delete",
                        "job_ids": [self.job_id],
                        "confirm_delete": True,
                    }
                )
        self.assertEqual(ctx.exception.status_code, 409)
        self.assertIn("Database rejected the change", ctx.exception.detail)

    def test_job_adjacent_uses_review_filters_and_sort(self):
        from backend import app as control_plane_api

        _, second_id = self.db.add_job(
            {
                "title": "Analyst",
                "company": "Co",
                "location": "CA",
                "job_url": "https://www.linkedin.com/jobs/view/ops-test-2",
                "apply_url": None,
                "description": None,
                "source": "linkedin",
                "date_posted": "2026-04-09",
                "is_remote": 0,
                "level": "junior",
                "priority": 0,
                "category": "product",
                "apply_type": "unknown",
                "auto_apply_eligible": None,
                "enrichment_status": "done",
                "enrichment_attempts": 1,
                "apply_host": None,
                "ats_type": "workday",
            }
        )
        _, filtered_out_id = self.db.add_job(
            {
                "title": "Designer",
                "company": "Co",
                "location": "CA",
                "job_url": "https://www.linkedin.com/jobs/view/ops-test-3",
                "apply_url": None,
                "description": None,
                "source": "linkedin",
                "date_posted": "2026-04-10",
                "is_remote": 0,
                "level": "junior",
                "priority": 0,
                "category": "design",
                "apply_type": "unknown",
                "auto_apply_eligible": None,
                "enrichment_status": "done",
                "enrichment_attempts": 1,
                "apply_host": None,
                "ats_type": "workday",
            }
        )

        response = control_plane_api.api_job_adjacent(
            second_id,
            status="all",
            category="product",
            sort="id",
            direction="asc",
        )
        data = json.loads(response.body.decode())
        self.assertEqual(data, {"prev_id": self.job_id, "next_id": self.job_id})
        self.assertNotIn(filtered_out_id, data.values())

    def test_job_adjacent_without_status_infers_current_job_status(self):
        from backend import app as control_plane_api

        conn = self.db.get_connection()
        conn.execute(
            "UPDATE jobs SET enrichment_status = 'done', date_scraped = ? WHERE id = ?",
            ("2026-05-05 10:00:00", self.job_id),
        )
        conn.commit()
        conn.close()
        _, done_id = self.db.add_job(
            {
                "title": "Done peer",
                "company": "Co",
                "location": "CA",
                "job_url": "https://www.linkedin.com/jobs/view/ops-test-done-peer",
                "apply_url": None,
                "description": None,
                "source": "linkedin",
                "date_posted": "2026-04-09",
                "date_scraped": "2026-05-05 09:00:00",
                "is_remote": 0,
                "level": "junior",
                "priority": 0,
                "category": "product",
                "apply_type": "unknown",
                "auto_apply_eligible": None,
                "enrichment_status": "done",
                "enrichment_attempts": 1,
                "apply_host": None,
                "ats_type": "workday",
            }
        )
        _, pending_id = self.db.add_job(
            {
                "title": "Pending newer",
                "company": "Co",
                "location": "CA",
                "job_url": "https://www.linkedin.com/jobs/view/ops-test-pending-newer",
                "apply_url": None,
                "description": None,
                "source": "linkedin",
                "date_posted": "2026-04-10",
                "date_scraped": "2026-05-05 11:00:00",
                "is_remote": 0,
                "level": "junior",
                "priority": 0,
                "category": "product",
                "apply_type": "unknown",
                "auto_apply_eligible": None,
                "enrichment_status": "pending",
                "enrichment_attempts": 1,
                "apply_host": None,
                "ats_type": "workday",
            }
        )

        response = control_plane_api.api_job_adjacent(
            self.job_id,
            sort="date_scraped",
            direction="desc",
        )
        data = json.loads(response.body.decode())
        self.assertEqual(data, {"prev_id": done_id, "next_id": done_id})
        self.assertNotIn(pending_id, data.values())

    def test_auth_login_and_logout_return_session_cookie_headers(self):
        import asyncio
        from unittest.mock import patch

        from fastapi import Response

        from backend import app as control_plane_api
        from backend import auth_session

        auth_session.ADMIN_USERNAME = "admin"
        auth_session.ADMIN_PASSWORD = "secret"
        auth_session.init_sessions_table()

        class LoginRequest:
            cookies = {}
            headers = {"content-type": "application/x-www-form-urlencoded"}

            async def body(self):
                return b"username=admin&password=secret"

        with patch("starlette.requests.parse_options_header", None):
            login_response = asyncio.run(control_plane_api.auth_login(LoginRequest(), Response()))
        self.assertEqual(login_response.status_code, 200)
        self.assertIn(
            f"{auth_session.SESSION_COOKIE_NAME}=", login_response.headers.get("set-cookie", "")
        )

        token = auth_session.create_session("admin")

        class LogoutRequest:
            cookies = {auth_session.SESSION_COOKIE_NAME: token}

        logout_response = control_plane_api.auth_logout(LogoutRequest(), Response())
        self.assertEqual(logout_response.status_code, 200)
        self.assertIn(
            f"{auth_session.SESSION_COOKIE_NAME}=", logout_response.headers.get("set-cookie", "")
        )
        self.assertIn("Max-Age=0", logout_response.headers.get("set-cookie", ""))

    def test_review_ops_requires_session_or_ops_token(self):
        from fastapi import HTTPException

        from backend import app as control_plane_api
        from backend import auth_session

        auth_session.init_sessions_table()
        original_token = control_plane_api.REVIEW_OPS_TOKEN
        self.addCleanup(setattr, control_plane_api, "REVIEW_OPS_TOKEN", original_token)
        control_plane_api.REVIEW_OPS_TOKEN = ""

        class AnonymousRequest:
            headers = {}
            cookies = {}

        with self.assertRaises(HTTPException) as ctx:
            control_plane_api.review_ops_dependency(AnonymousRequest())
        self.assertEqual(ctx.exception.status_code, 401)

        token = auth_session.create_session("admin")

        class SessionRequest:
            headers = {}
            cookies = {auth_session.SESSION_COOKIE_NAME: token}

        control_plane_api.review_ops_dependency(SessionRequest())

        control_plane_api.REVIEW_OPS_TOKEN = "ops-secret"

        class OpsTokenRequest:
            headers = {"x-review-ops-token": "ops-secret"}
            cookies = {}

        control_plane_api.review_ops_dependency(OpsTokenRequest())

    def test_spa_paths_are_not_shadowed_by_legacy_ssr_routes(self):
        from backend import app as control_plane_api

        legacy_shadow_endpoints = {
            "/": "dashboard",
            "/jobs": "jobs_page",
            "/jobs/{job_id}": "job_detail",
            "/jobs/compare": "jobs_compare",
            "/ops": "ops_console",
            "/health-view": "health_view",
            "/summary": "summary_redirect",
        }
        for route in control_plane_api.app.routes:
            endpoint_name = getattr(getattr(route, "endpoint", None), "__name__", "")
            self.assertNotEqual(
                legacy_shadow_endpoints.get(getattr(route, "path", "")),
                endpoint_name,
                f"{route.path} is still handled by legacy SSR endpoint {endpoint_name}",
            )

    def test_favicon_route_is_not_served_by_spa_shell(self):
        from backend import app as control_plane_api

        for route in control_plane_api.app.routes:
            if getattr(route, "path", "") == "/favicon.svg":
                endpoint_name = getattr(getattr(route, "endpoint", None), "__name__", "")
                self.assertEqual(endpoint_name, "frontend_favicon")
                return
        self.fail("Missing explicit /favicon.svg route")

    def test_sensitive_read_endpoints_require_session_auth_parameter(self):
        from backend import app as control_plane_api

        endpoint_names = [
            "api_jobs_export",
            "api_job_artifact",
            "api_job_resume_artifact",
            "api_attempt_pdf",
            "api_attempt_tex",
            "api_attempt_keywords",
            "api_attempt_llm",
        ]
        for name in endpoint_names:
            self.assertIn(
                "_auth",
                signature(getattr(control_plane_api, name)).parameters,
                f"{name} lacks require_auth dependency parameter",
            )


if __name__ == "__main__":
    unittest.main()
