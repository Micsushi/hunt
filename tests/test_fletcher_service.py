from __future__ import annotations

import tempfile
from unittest.mock import patch

from fastapi.testclient import TestClient

import fletcher.service as service


def _client() -> TestClient:
    return TestClient(service.app, raise_server_exceptions=False)


def _reset_generation_state() -> None:
    with service._generate_lock:
        service._generate_running = False
        service._generate_last_error = None


def test_generate_once_retries_after_failed_preflight_and_reports_background_failure():
    with (
        tempfile.TemporaryDirectory(prefix="hunt-c2-audit-") as audit_dir,
        patch.dict("os.environ", {"HUNT_AUDIT_LOG_ROOT": audit_dir}),
        patch("hunter.config.HUNT_SERVICE_TOKEN", "service-token"),
        patch(
            "fletcher.db.list_jobs_ready_for_resume",
            side_effect=[RuntimeError("database query failed"), []],
        ),
        patch(
            "fletcher.pipeline.generate_resumes_for_ready_jobs",
            side_effect=RuntimeError("generation failed"),
        ) as generate,
    ):
        _reset_generation_state()
        client = _client()
        headers = {"Authorization": "Bearer service-token"}
        request = {"limit": 1, "only_missing": True}
        rejected = client.post("/generate-once", headers=headers, json=request)
        assert rejected.status_code == 503
        assert rejected.json()["detail"] == "Resume queue preflight failed"
        assert service._is_generate_running() is False
        generate.assert_not_called()

        accepted = client.post("/generate-once", headers=headers, json=request)
        assert accepted.status_code == 202
        assert accepted.json()["status"] == "accepted"
        status = client.get("/status", headers=headers)
        assert status.status_code == 200
        assert status.json()["generate_running"] is False
        assert status.json()["generate_last_error"] == "generation failed"
