import os
import sys
import tempfile
import unittest
from unittest.mock import patch

from fastapi.testclient import TestClient

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, REPO_ROOT)


class C0ControlApiTests(unittest.TestCase):
    def setUp(self):
        fd, self.path = tempfile.mkstemp(suffix=".db")
        os.close(fd)
        self._env = patch.dict(
            os.environ,
            {
                "HUNT_DB_PATH": self.path,
                "HUNT_ADMIN_USERNAME": "admin",
                "HUNT_ADMIN_PASSWORD": "secret",
                "HUNT_SERVICE_TOKEN": "service-secret",
            },
            clear=False,
        )
        self._env.start()

        from hunter import db
        from backend import auth_session

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


if __name__ == "__main__":
    unittest.main()
