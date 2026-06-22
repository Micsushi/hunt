from __future__ import annotations

import sqlite3
from pathlib import Path

from fastapi import FastAPI
from fastapi.testclient import TestClient

from backend.browser_targets import (
    BrowserTargetRegister,
    InMemoryBrowserTargetStore,
    PostgresBrowserTargetStore,
    get_browser_target_store,
    router,
)
from backend.ledger.api import get_ledger_service, require_ledger_access
from backend.ledger.service import LedgerService


def _payload(**overrides):
    payload = {
        "session_id": "session-a",
        "agent_id": "agent-a",
        "lane_id": "lane-a",
        "browser_kind": "p_chrome",
        "debug_port": 9222,
        "extension_id": "ext-a",
        "options_url": "chrome-extension://ext-a/options.html",
        "created_at": "2026-06-11T10:00:00Z",
        "heartbeat_at": "2026-06-11T10:01:00Z",
        "tab_id": 17,
        "url": "https://example.com/apply",
        "metadata": {"window_id": 3},
    }
    payload.update(overrides)
    return payload


def _client(tmp_path):
    app = FastAPI()
    service = LedgerService(tmp_path / "ledger")
    store = InMemoryBrowserTargetStore()
    app.include_router(router)
    app.dependency_overrides[get_ledger_service] = lambda: service
    app.dependency_overrides[get_browser_target_store] = lambda: store
    app.dependency_overrides[require_ledger_access] = lambda: None
    return TestClient(app), service, store


def test_register_target_can_be_read_and_writes_jsonl_audit(tmp_path):
    client, service, _store = _client(tmp_path)

    response = client.post("/api/c3/browser-targets/register", json=_payload())

    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "registered"
    assert body["target"]["session_id"] == "session-a"
    assert body["target"]["debug_port"] == 9222
    assert body["event_id"].startswith("evt-")

    read = client.get("/api/c3/browser-targets/session-a")
    assert read.status_code == 200
    assert read.json()["target"]["options_url"] == "chrome-extension://ext-a/options.html"

    session_log = service.get_session_log("session-a")
    assert session_log["events"][0]["event_type"] == "browser_target.registered"
    assert session_log["events"][0]["payload"]["debug_port"] == 9222
    assert Path(session_log["log_path"]).exists()


def test_reregister_same_session_updates_active_target_without_duplicate(tmp_path):
    client, _service, _store = _client(tmp_path)
    first = client.post("/api/c3/browser-targets/register", json=_payload())
    assert first.status_code == 200

    second = client.post(
        "/api/c3/browser-targets/register",
        json=_payload(
            debug_port=9333,
            heartbeat_at="2026-06-11T10:05:00Z",
            extension_id="ext-b",
            options_url="chrome-extension://ext-b/options.html",
            tab_id=44,
            metadata={"window_id": 9, "profile": "lane-a"},
        ),
    )

    assert second.status_code == 200
    target = second.json()["target"]
    assert target["created_at"] == "2026-06-11T10:00:00Z"
    assert target["heartbeat_at"] == "2026-06-11T10:05:00Z"
    assert target["debug_port"] == 9333
    assert target["extension_id"] == "ext-b"
    assert target["tab_id"] == 44
    assert target["metadata"] == {"window_id": 9, "profile": "lane-a"}

    active = client.get("/api/c3/browser-targets").json()["targets"]
    assert len(active) == 1
    assert active[0]["session_id"] == "session-a"


def test_registry_supports_multiple_sessions_and_ports(tmp_path):
    client, _service, _store = _client(tmp_path)

    first = client.post("/api/c3/browser-targets/register", json=_payload(session_id="session-a", debug_port=9222))
    second = client.post(
        "/api/c3/browser-targets/register",
        json=_payload(session_id="session-b", agent_id="agent-b", lane_id="lane-b", debug_port=9333),
    )

    assert first.status_code == 200
    assert second.status_code == 200
    active = {target["session_id"]: target for target in client.get("/api/c3/browser-targets").json()["targets"]}
    assert active["session-a"]["debug_port"] == 9222
    assert active["session-b"]["debug_port"] == 9333
    assert active["session-a"]["lane_id"] == "lane-a"
    assert active["session-b"]["lane_id"] == "lane-b"


def test_unregister_removes_active_target_and_writes_audit(tmp_path):
    client, service, _store = _client(tmp_path)
    assert client.post("/api/c3/browser-targets/register", json=_payload()).status_code == 200

    response = client.delete(
        "/api/c3/browser-targets/session-a",
        params={"agent_id": "agent-a", "reason": "options tab closed"},
    )

    assert response.status_code == 200
    assert response.json()["status"] == "unregistered"
    assert client.get("/api/c3/browser-targets/session-a").status_code == 404
    assert client.get("/api/c3/browser-targets").json()["targets"] == []

    event_types = [event["event_type"] for event in service.get_session_log("session-a")["events"]]
    assert event_types == ["browser_target.registered", "browser_target.unregistered"]
    last_event = service.get_session_log("session-a")["events"][-1]
    assert last_event["payload"]["reason"] == "options tab closed"
    assert last_event["payload"]["status"] == "unregistered"


def _sqlite_registry_connection(path):
    connection = sqlite3.connect(path)
    connection.execute(
        """
        CREATE TABLE IF NOT EXISTS ledger_browser_targets (
            session_id TEXT PRIMARY KEY,
            component TEXT NOT NULL DEFAULT 'c3',
            agent_id TEXT,
            lane_id TEXT,
            browser_kind TEXT NOT NULL,
            debug_port INTEGER NOT NULL,
            extension_id TEXT NOT NULL,
            options_url TEXT NOT NULL,
            tab_id INTEGER,
            url TEXT,
            status TEXT NOT NULL DEFAULT 'active',
            created_at TEXT NOT NULL,
            heartbeat_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            unregistered_at TEXT,
            metadata_json TEXT NOT NULL DEFAULT '{}'
        )
        """
    )
    connection.commit()
    return connection


def test_postgres_store_shape_can_query_active_targets_across_instances(tmp_path):
    path = tmp_path / "registry.db"
    first_connection = _sqlite_registry_connection(path)
    first_store = PostgresBrowserTargetStore(first_connection)
    first_store.register(BrowserTargetRegister(**_payload(session_id="session-a", debug_port=9222)))
    first_store.register(BrowserTargetRegister(**_payload(session_id="session-b", debug_port=9333)))
    first_connection.close()

    second_connection = _sqlite_registry_connection(path)
    second_store = PostgresBrowserTargetStore(second_connection)
    active_rows = second_connection.execute(
        """
        SELECT session_id, debug_port
        FROM ledger_browser_targets
        WHERE status = ?
        ORDER BY session_id
        """,
        ["active"],
    ).fetchall()

    assert active_rows == [("session-a", 9222), ("session-b", 9333)]
    assert second_store.get("session-b").debug_port == 9333

    second_store.unregister("session-a")
    active_sessions = [
        row[0]
        for row in second_connection.execute(
            "SELECT session_id FROM ledger_browser_targets WHERE status = ? ORDER BY session_id",
            ["active"],
        ).fetchall()
    ]
    assert active_sessions == ["session-b"]
    second_connection.close()
