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


def test_generate_once_rejects_a_failed_database_preflight():
    with (
        tempfile.TemporaryDirectory(prefix="hunt-c2-audit-") as audit_dir,
        patch.dict(
            "os.environ",
            {"HUNT_AUDIT_LOG_ROOT": audit_dir},
            clear=False,
        ),
        patch("hunter.config.HUNT_SERVICE_TOKEN", "service-token"),
        patch(
            "fletcher.db.list_jobs_ready_for_resume",
            side_effect=RuntimeError("database query failed"),
        ),
        patch("fletcher.pipeline.generate_resumes_for_ready_jobs") as generate,
    ):
        _reset_generation_state()
        response = _client().post(
            "/generate-once",
            headers={"Authorization": "Bearer service-token"},
            json={"limit": 1, "only_missing": True},
        )

    assert response.status_code == 503
    assert response.json()["detail"] == "Resume queue preflight failed"
    assert service._is_generate_running() is False
    generate.assert_not_called()


def test_generate_once_reports_background_failure_in_status():
    with (
        tempfile.TemporaryDirectory(prefix="hunt-c2-audit-") as audit_dir,
        patch.dict(
            "os.environ",
            {"HUNT_AUDIT_LOG_ROOT": audit_dir},
            clear=False,
        ),
        patch("hunter.config.HUNT_SERVICE_TOKEN", "service-token"),
        patch("fletcher.db.list_jobs_ready_for_resume", return_value=[]),
        patch(
            "fletcher.pipeline.generate_resumes_for_ready_jobs",
            side_effect=RuntimeError("generation failed"),
        ),
    ):
        _reset_generation_state()
        client = _client()
        response = client.post(
            "/generate-once",
            headers={"Authorization": "Bearer service-token"},
            json={"limit": 1, "only_missing": True},
        )
        status = client.get(
            "/status",
            headers={"Authorization": "Bearer service-token"},
        )

    assert response.status_code == 202
    assert response.json()["status"] == "accepted"
    assert status.status_code == 200
    assert status.json()["generate_running"] is False
    assert status.json()["generate_last_error"] == "generation failed"
