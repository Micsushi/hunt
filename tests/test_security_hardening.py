import os
import sys
import unittest
from unittest.mock import patch

from fastapi.testclient import TestClient


REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, REPO_ROOT)


class SecurityHardeningTests(unittest.TestCase):
    def test_origin_check_uses_exact_origin_not_forwarded_host(self):
        from starlette.requests import Request
        from backend.app import _request_origin_is_allowed

        request = Request({
            "type": "http", "scheme": "https", "path": "/", "query_string": b"",
            "headers": [(b"host", b"review.example"),
                        (b"x-forwarded-host", b"attacker.example")],
            "server": ("review.example", 443),
        })
        for origin, allowed in (
            ("https://review.example", True),
            ("https://review.example:443", True),
            ("http://review.example", False),
            ("https://attacker.example", False),
            ("https://review.example:444", False),
            ("https://review.example/path", False),
            ("https://[invalid", False),
            ("https://review.example:invalid", False),
        ):
            with self.subTest(origin=origin):
                self.assertEqual(_request_origin_is_allowed(request, origin), allowed)

    def test_malformed_referer_fails_closed(self):
        from backend.app import app, SESSION_COOKIE_NAME

        with TestClient(app, raise_server_exceptions=False) as client:
            client.cookies.set(SESSION_COOKIE_NAME, "test-session")
            response = client.post("/auth/logout", headers={"Referer": "https://[invalid"})
        self.assertEqual(response.status_code, 403)

    def test_configured_public_origin_allows_http_proxy_hop(self):
        from starlette.requests import Request
        from backend import app as api

        request = Request({
            "type": "http", "scheme": "http", "path": "/", "query_string": b"",
            "headers": [(b"host", b"backend:8000")], "server": ("backend", 8000),
        })
        with patch.object(api, "_DEV_ORIGINS", ["https://review.example"]):
            self.assertTrue(api._request_origin_is_allowed(request, "https://review.example"))
            self.assertFalse(api._request_origin_is_allowed(request, "https://attacker.example"))

    def test_malformed_login_payloads_return_client_errors(self):
        from backend.app import app

        with TestClient(app, raise_server_exceptions=False) as client:
            for payload, content_type in (
                (b'[]', 'application/json'),
                (b'null', 'application/json'),
                (b'123', 'application/json'),
                (b'"text"', 'application/json'),
                (b'\xff', 'application/json'),
                (b'\xff', 'application/x-www-form-urlencoded'),
            ):
                with self.subTest(payload=payload, content_type=content_type):
                    response = client.post(
                        '/auth/login', content=payload,
                        headers={'Content-Type': content_type},
                    )
                    self.assertEqual(response.status_code, 400)

    def test_liveness_is_minimal_and_security_headers_are_present(self):
        from backend.app import app

        with TestClient(app) as client:
            response = client.get("/health")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {"status": "ok"})
        self.assertEqual(response.headers["x-content-type-options"], "nosniff")
        self.assertEqual(response.headers["x-frame-options"], "DENY")
        self.assertIn("frame-ancestors 'none'", response.headers["content-security-policy"])

    def test_legacy_data_pages_and_metrics_require_authentication(self):
        from backend import app as control_plane_api

        with patch.object(control_plane_api, "HUNT_SERVICE_TOKEN", ""):
            with TestClient(control_plane_api.app) as client:
                for path in (
                    "/legacy",
                    "/legacy/health-view",
                    "/legacy/summary",
                    "/legacy/ops",
                    "/legacy/jobs",
                    "/legacy/jobs/compare",
                    "/legacy/jobs/1",
                    "/metrics",
                ):
                    response = client.get(path)
                    self.assertEqual(response.status_code, 401, path)

    def test_chrome_extension_wildcard_is_not_allowed(self):
        from backend.app import app

        with TestClient(app) as client:
            response = client.options(
                "/api/summary",
                headers={
                    "Origin": "chrome-extension://arbitrary-extension",
                    "Access-Control-Request-Method": "GET",
                },
            )

        self.assertNotEqual(
            response.headers.get("access-control-allow-origin"),
            "chrome-extension://arbitrary-extension",
        )


if __name__ == "__main__":
    unittest.main()
