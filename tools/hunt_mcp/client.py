from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Any

import httpx

DEFAULT_BACKEND_URL = "http://127.0.0.1:8000"
DEFAULT_TIMEOUT_SECONDS = 30.0


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

    def get_command_timeline(self, payload: dict[str, Any]) -> Any:
        command_id = _required(payload, "command_id")
        return self._request("GET", f"/api/ledger/commands/{command_id}/timeline")

    def find_recent_failures(self, payload: dict[str, Any] | None = None) -> Any:
        body = payload or {}
        params = {
            key: value
            for key, value in {
                "component": body.get("component") or "c3",
                "limit": body.get("limit") or 20,
            }.items()
            if value is not None
        }
        return self._request("GET", "/api/ledger/failures/recent", params=params)

    def write_probe_file(self, payload: dict[str, Any]) -> Any:
        body = dict(payload)
        body.setdefault("trusted", False)
        return self._request("POST", "/api/ledger/probes", json=body)

    def register_browser_target(self, payload: dict[str, Any]) -> Any:
        return self._request("POST", "/api/c3/browser-targets/register", json=_browser_target_body(payload))

    def get_browser_target(self, payload: dict[str, Any]) -> Any:
        session_id = _required(payload, "session_id")
        return self._request("GET", f"/api/c3/browser-targets/{session_id}")

    def list_browser_targets(self, payload: dict[str, Any] | None = None) -> Any:
        del payload
        return self._request("GET", "/api/c3/browser-targets")

    def unregister_browser_target(self, payload: dict[str, Any]) -> Any:
        session_id = _required(payload, "session_id")
        params = {
            key: value
            for key, value in {
                "agent_id": payload.get("agent_id"),
                "reason": payload.get("reason"),
            }.items()
            if value
        }
        return self._request("DELETE", f"/api/c3/browser-targets/{session_id}", params=params or None)

    def run_c3_command(self, payload: dict[str, Any]) -> Any:
        _required(payload, "command_id")
        _required(payload, "command_name")
        _required(payload, "agent_id")
        _required(payload, "session_id")
        _required(payload, "lease_id")
        _required(payload, "reason")
        command_payload = payload.get("command_payload", {})
        if not isinstance(command_payload, dict):
            raise ValueError("command_payload must be an object")
        target = payload.get("target")
        if target is None:
            target = _target_from_payload(payload, command_payload)
        if not isinstance(target, dict):
            raise ValueError("target must be an object")

        body = dict(payload)
        body["command_payload"] = command_payload
        body["target"] = target
        return self._request("POST", "/api/c3/commands/run", json=body)

    def get_c3_command_catalog(self, payload: dict[str, Any] | None = None) -> Any:
        del payload
        return self._request("GET", "/api/c3/commands/catalog")

    def inspect_fields(self, payload: dict[str, Any]) -> Any:
        return self._run_named_c3_command("c3.inspect_fields", payload, "Inspect visible fields.")

    def inspect_validation(self, payload: dict[str, Any]) -> Any:
        return self._run_named_c3_command("c3.inspect_validation", payload, "Inspect visible validation state.")

    def snapshot_page(self, payload: dict[str, Any]) -> Any:
        return self._run_named_c3_command("c3.snapshot_page", payload, "Capture sanitized page snapshot.")

    def get_progress(self, payload: dict[str, Any]) -> Any:
        return self._run_named_c3_command("c3.get_progress", payload, "Read current C3 progress.")

    def fill_page(self, payload: dict[str, Any]) -> Any:
        return self._run_named_c3_command("c3.fill_page", payload, "Fill current apply page.")

    def click_next_after_fill(self, payload: dict[str, Any]) -> Any:
        return self._run_named_c3_command("c3.click_next_after_fill", payload, "Click safe next action.")

    def _run_named_c3_command(self, command_name: str, payload: dict[str, Any], default_reason: str) -> Any:
        body = dict(payload)
        body["command_name"] = command_name
        body.setdefault("reason", default_reason)
        return self.run_c3_command(body)

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


def _target_from_payload(payload: dict[str, Any], command_payload: dict[str, Any]) -> dict[str, Any]:
    debug_port = payload.get("debug_port") or payload.get("cdp_port") or command_payload.get("cdp_port")
    extension_id = payload.get("extension_id") or command_payload.get("extension_id")
    tab_id = _optional_int(payload.get("tab_id") or command_payload.get("tab_id") or command_payload.get("tabId"))
    url = payload.get("url") or command_payload.get("url")
    return {
        "browser_kind": payload.get("browser_kind") or "p_chrome",
        "debug_port": debug_port,
        "extension_id": extension_id,
        "options_url": payload.get("options_url") or command_payload.get("options_url") or "",
        "tab_id": tab_id,
        "url": url or "",
    }


def _browser_target_body(payload: dict[str, Any]) -> dict[str, Any]:
    session_id = _required(payload, "session_id")
    agent_id = _required(payload, "agent_id")
    lane_id = _required(payload, "lane_id")
    extension_id = _required(payload, "extension_id")
    debug_port = payload.get("debug_port") or payload.get("cdp_port")
    if not debug_port:
        raise ValueError("debug_port or cdp_port is required")
    return {
        "session_id": session_id,
        "agent_id": agent_id,
        "lane_id": lane_id,
        "browser_kind": payload.get("browser_kind") or "p_chrome",
        "debug_port": int(debug_port),
        "extension_id": extension_id,
        "options_url": payload.get("options_url")
        or f"chrome-extension://{extension_id}/src/options/options.html",
        "tab_id": _optional_int(payload.get("tab_id")),
        "url": payload.get("url") or "",
        "metadata": payload.get("metadata") if isinstance(payload.get("metadata"), dict) else {},
        "actor": payload.get("actor")
        if isinstance(payload.get("actor"), dict)
        else {"type": "agent", "id": agent_id, "surface": "mcp"},
    }


def _optional_int(value: Any) -> int | None:
    if value is None or value == "":
        return None
    return int(value)


def _response_reason(response: httpx.Response) -> Any:
    try:
        body = response.json()
    except ValueError:
        return response.text
    if isinstance(body, dict):
        return body.get("detail", body)
    return body
