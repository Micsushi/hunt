import json
import logging
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi.testclient import TestClient

REPO_ROOT = Path(__file__).resolve().parent.parent
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

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

    def test_c2_direct_mutation_writes_durable_audit_event(self):
        with (
            tempfile.TemporaryDirectory(prefix="hunt-c2-audit-") as audit_dir,
            patch.dict(os.environ, {"HUNT_AUDIT_LOG_ROOT": audit_dir}, clear=False),
            patch("hunter.config.HUNT_SERVICE_TOKEN", "service-token"),
            patch(
                "fletcher.pipeline.generate_resume_for_job",
                return_value={"status": "done"},
            ),
        ):
            client = TestClient(c2_app, raise_server_exceptions=False)
            response = client.post(
                "/generate",
                headers={"Authorization": "Bearer service-token"},
                json={"job_id": 7},
            )

            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.headers.get("X-Hunt-Audit-Status"), "written")
            with open(
                Path(audit_dir) / "human-commands.jsonl",
                encoding="utf-8",
            ) as stream:
                event = json.loads(stream.readline())
            self.assertEqual(event["component"], "c2")
            self.assertEqual(event["payload"]["details"]["route"], "/generate")

    def test_direct_mutation_is_blocked_when_audit_storage_is_unavailable(self):
        with (
            patch("hunter.config.HUNT_SERVICE_TOKEN", "service-token"),
            patch(
                "shared.mutation_audit.ensure_audit_storage",
                side_effect=OSError("unavailable"),
            ),
            patch("fletcher.pipeline.generate_resume_for_job") as generate,
        ):
            client = TestClient(c2_app, raise_server_exceptions=False)
            response = client.post(
                "/generate",
                headers={"Authorization": "Bearer service-token"},
                json={"job_id": 7},
            )

        self.assertEqual(response.status_code, 503)
        self.assertEqual(response.headers.get("X-Hunt-Audit-Status"), "unavailable")
        generate.assert_not_called()

    def test_completed_mutation_reports_audit_write_failure(self):
        with (
            tempfile.TemporaryDirectory(prefix="hunt-c2-audit-") as audit_dir,
            patch.dict(os.environ, {"HUNT_AUDIT_LOG_ROOT": audit_dir}, clear=False),
            patch("hunter.config.HUNT_SERVICE_TOKEN", "service-token"),
            patch(
                "fletcher.pipeline.generate_resume_for_job",
                return_value={"status": "done"},
            ) as generate,
            patch(
                "shared.mutation_audit.append_server_mutation_event",
                side_effect=OSError("write failed"),
            ),
        ):
            client = TestClient(c2_app, raise_server_exceptions=False)
            response = client.post(
                "/generate",
                headers={"Authorization": "Bearer service-token"},
                json={"job_id": 7},
            )

        self.assertEqual(response.status_code, 500)
        self.assertEqual(response.headers.get("X-Hunt-Audit-Status"), "failed")
        self.assertEqual(
            response.json()["detail"],
            "Mutation completed but durable audit write failed",
        )
        generate.assert_called_once_with(7)


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    unittest.main()
