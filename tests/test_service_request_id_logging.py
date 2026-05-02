import logging
import sys
import unittest
from pathlib import Path

from fastapi.testclient import TestClient

REPO_ROOT = Path(__file__).resolve().parent.parent
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from coordinator.service_api import app as c4_app  # noqa: E402
from fletcher.service import app as c2_app  # noqa: E402
from hunter.service import app as c1_app  # noqa: E402


class ServiceRequestIdLoggingTests(unittest.TestCase):
    def assert_request_id_logged_and_echoed(self, app, service_name: str):
        request_id = f"{service_name}-req-123"
        client = TestClient(app, raise_server_exceptions=False)
        with self.assertLogs("hunt.request_id", level="INFO") as captured:
            response = client.get("/missing", headers={"X-Request-ID": request_id})
        self.assertEqual(response.status_code, 404)
        self.assertEqual(response.headers.get("X-Request-ID"), request_id)
        self.assertTrue(
            any(
                service_name in line
                and f"request_id={request_id}" in line
                and "path=/missing" in line
                for line in captured.output
            )
        )

    def test_c1_logs_request_id(self):
        self.assert_request_id_logged_and_echoed(c1_app, "c1-hunter")

    def test_c2_logs_request_id(self):
        self.assert_request_id_logged_and_echoed(c2_app, "c2-fletcher")

    def test_c4_logs_request_id(self):
        self.assert_request_id_logged_and_echoed(c4_app, "c4-coordinator")


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    unittest.main()
