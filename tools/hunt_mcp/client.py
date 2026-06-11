from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Any

import httpx

DEFAULT_BACKEND_URL = "http://127.0.0.1:8000"
DEFAULT_TIMEOUT_SECONDS = 30.0
MISSING_C3_COMMAND_BRIDGE = "missing_backend_browser_control_bridge"


class HuntBackendError(RuntimeError):
    def __init__(self, status_code: int, reason: Any):
        super().__init__(f"Hunt backend returned {status_code}: {reason}")
        self.status_code = status_code
        self.reason = reason


@dataclass(frozen=True)
class HuntBackendConfig:
    backend_url: str = DEFAULT_BACKEND_URL
    service_token: str | None = None
    timeout_seconds: float = DEFAULT_TIMEOUT_SECONDS

    @classmethod
    def from_env(cls) -> HuntBackendConfig:
        timeout = os.environ.get("HUNT_MCP_HTTP_TIMEOUT", str(DEFAULT_TIMEOUT_SECONDS))
        return cls(
            backend_url=os.environ.get("HUNT_BACKEND_URL", DEFAULT_BACKEND_URL),
            service_token=os.environ.get("HUNT_SERVICE_TOKEN") or None,
            timeout_seconds=float(timeout),
        )


class HuntLedgerClient:
    def __init__(
        self,
        config: HuntBackendConfig | None = None,
        *,
        transport: httpx.BaseTransport | None = None,
    ) -> None:
        self.config = config or HuntBackendConfig.from_env()
        headers = {}
        if self.config.service_token:
            headers["Authorization"] = f"Bearer {self.config.service_token}"
        self._client = httpx.Client(
            base_url=self.config.backend_url.rstrip("/"),
            headers=headers,
            timeout=self.config.timeout_seconds,
            transport=transport,
        )

    def close(self) -> None:
        self._client.close()

    def create_agent(self, payload: dict[str, Any]) -> Any:
        return self._request("POST", "/api/ledger/agents", json=payload)

    def create_lane(self, payload: dict[str, Any]) -> Any:
        return self._request("POST", "/api/ledger/lanes", json=payload)

    def open_session(self, payload: dict[str, Any]) -> Any:
        return self._request("POST", "/api/ledger/sessions", json=payload)

    def claim_lease(self, payload: dict[str, Any]) -> Any:
        return self._request("POST", "/api/ledger/leases/claim", json=payload)

    def heartbeat_lease(self, payload: dict[str, Any]) -> Any:
        lease_id = _required(payload, "lease_id")
        return self._request("POST", f"/api/ledger/leases/{lease_id}/heartbeat", json=payload)

    def release_lease(self, payload: dict[str, Any]) -> Any:
        lease_id = _required(payload, "lease_id")
        return self._request("POST", f"/api/ledger/leases/{lease_id}/release", json=payload)

    def append_event(self, payload: dict[str, Any]) -> Any:
        return self._request("POST", "/api/ledger/events", json=payload)

    def get_active(self, payload: dict[str, Any] | None = None) -> Any:
        params = payload or None
        return self._request("GET", "/api/ledger/active", params=params)

    def get_agent_log(self, payload: dict[str, Any]) -> Any:
        agent_id = _required(payload, "agent_id")
        params = {key: value for key, value in payload.items() if key != "agent_id"}
        return self._request("GET", f"/api/ledger/agents/{agent_id}", params=params or None)

    def get_session_log(self, payload: dict[str, Any]) -> Any:
        session_id = _required(payload, "session_id")
        params = {key: value for key, value in payload.items() if key != "session_id"}
        return self._request("GET", f"/api/ledger/sessions/{session_id}", params=params or None)

    def write_probe_file(self, payload: dict[str, Any]) -> Any:
        body = dict(payload)
        body.setdefault("trusted", False)
        return self._request("POST", "/api/ledger/probes", json=body)

    def run_c3_command(self, payload: dict[str, Any]) -> Any:
        command_id = _required(payload, "command_id")
        command_name = _required(payload, "command_name")
        agent_id = _required(payload, "agent_id")
        session_id = _required(payload, "session_id")
        lease_id = _required(payload, "lease_id")
        reason = _required(payload, "reason")
        command_payload = payload.get("command_payload", {})
        if not isinstance(command_payload, dict):
            raise ValueError("command_payload must be an object")

        actor = payload.get("actor")
        if not isinstance(actor, dict):
            actor = {"type": "agent", "id": agent_id, "surface": "mcp"}

        event_payload: dict[str, Any] = {
            "command_name": command_name,
            "command_payload": command_payload,
            "reason": reason,
            "requested_via": "hunt_mcp.hunt_c3_run_command",
            "bridge_status": MISSING_C3_COMMAND_BRIDGE,
            "execution_status": "not_executed",
        }
        metadata = payload.get("metadata")
        if isinstance(metadata, dict) and metadata:
            event_payload["metadata"] = metadata
        probe_budget_id = payload.get("probe_budget_id")
        if isinstance(probe_budget_id, str) and probe_budget_id.strip():
            event_payload["probe_budget_id"] = probe_budget_id

        event_body = {
            "component": "c3",
            "event_type": "command.requested",
            "actor": actor,
            "agent_id": agent_id,
            "lane_id": str(payload.get("lane_id") or ""),
            "session_id": session_id,
            "lease_id": lease_id,
            "command_id": command_id,
            "trace_id": str(payload.get("trace_id") or command_id),
            "payload": event_payload,
        }
        ledger_event = self.append_event(event_body)
        return {
            "command_id": command_id,
            "command_name": command_name,
            "status": "recorded_not_executed",
            "bridge_status": MISSING_C3_COMMAND_BRIDGE,
            "message": (
                "No backend/browser-control command endpoint exists yet; "
                "the MCP adapter recorded an immutable ledger request only."
            ),
            "ledger_event": ledger_event,
        }

    def _request(self, method: str, path: str, **kwargs: Any) -> Any:
        response = self._client.request(method, path, **kwargs)
        if response.status_code >= 400:
            raise HuntBackendError(response.status_code, _response_reason(response))
        if not response.content:
            return {"ok": True}
        content_type = response.headers.get("content-type", "")
        if "application/json" in content_type:
            return response.json()
        return {"ok": True, "text": response.text}


def _required(payload: dict[str, Any], key: str) -> str:
    value = payload.get(key)
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{key} is required")
    return value


def _response_reason(response: httpx.Response) -> Any:
    try:
        body = response.json()
    except ValueError:
        return response.text
    if isinstance(body, dict):
        return body.get("detail", body)
    return body
