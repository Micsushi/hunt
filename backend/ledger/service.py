from __future__ import annotations

import json
import os
import re
import uuid
from datetime import UTC, datetime
from hashlib import sha256
from pathlib import Path
from typing import Any

from backend.ledger.config import COMPONENTS, initialize_ledger_root
from backend.ledger.indexer import LedgerIndexer
from backend.ledger.jsonl_store import JsonlLedger
from backend.ledger.models import (
    AgentCreate,
    LaneCreate,
    LedgerEventIn,
    ProbeFileCreate,
    ProbeStatusUpdate,
    SessionCreate,
)


def _now() -> str:
    return datetime.now(UTC).isoformat().replace("+00:00", "Z")


def _date_folder() -> str:
    return datetime.now().date().isoformat()


def _slug(value: str) -> str:
    slug = re.sub(r"[^A-Za-z0-9_.-]+", "-", value.strip()).strip("-")
    return slug or uuid.uuid4().hex[:10]


def _ledger_component(value: str | None) -> str:
    component = str(value or "c3").strip()
    if component not in COMPONENTS:
        allowed = ", ".join(COMPONENTS)
        raise ValueError(f"Unsupported ledger component: {component!r}. Allowed: {allowed}.")
    return component


def _dump_model(model: Any) -> dict[str, Any]:
    if hasattr(model, "model_dump"):
        return model.model_dump(mode="json")
    return model.dict()


def _receipt_from_event(event: dict[str, Any]) -> dict[str, Any]:
    payload = event.get("payload") if isinstance(event.get("payload"), dict) else {}
    receipt = payload.get("receipt")
    if isinstance(receipt, dict):
        return receipt
    if isinstance(payload.get("commandReceipt"), dict):
        return payload["commandReceipt"]
    return {}


def _is_failure_event(event: dict[str, Any]) -> bool:
    payload = event.get("payload") if isinstance(event.get("payload"), dict) else {}
    receipt = _receipt_from_event(event)
    event_type = str(event.get("event_type") or "")
    status = str(payload.get("status") or "").lower()
    reason_code = str(payload.get("reason_code") or payload.get("reason") or "").lower()
    return (
        "fail" in event_type
        or "error" in event_type
        or status in {"failed", "rejected", "error"}
        or bool(receipt) and receipt.get("ok") is False
        or reason_code
        in {
            "bad_actor",
            "missing_lease",
            "missing_target",
            "unknown_command",
            "browser_execution_failed",
        }
    )


def _failure_summary(event: dict[str, Any]) -> dict[str, Any]:
    payload = event.get("payload") if isinstance(event.get("payload"), dict) else {}
    receipt = _receipt_from_event(event)
    return {
        "event_id": event.get("event_id") or "",
        "ts": event.get("ts") or "",
        "event_type": event.get("event_type") or "",
        "agent_id": event.get("agent_id") or "",
        "lane_id": event.get("lane_id") or "",
        "session_id": event.get("session_id") or "",
        "lease_id": event.get("lease_id") or "",
        "command_id": event.get("command_id") or receipt.get("commandId") or "",
        "trace_id": event.get("trace_id") or receipt.get("traceId") or "",
        "command_name": payload.get("command_name") or receipt.get("command") or "",
        "status": payload.get("status") or "",
        "reason_code": payload.get("reason_code") or receipt.get("reason") or "",
        "receipt_ok": receipt.get("ok") if receipt else None,
    }


class LedgerService:
    def __init__(self, root: str | Path | None = None, store: JsonlLedger | None = None):
        self.root = initialize_ledger_root(root)
        self.store = store or JsonlLedger()

    def _manifest_dir(self, component: str, kind: str, item_id: str) -> Path:
        return self.root / component / kind / _date_folder() / item_id

    def _write_json_if_missing(self, path: Path, payload: dict[str, Any]) -> None:
        if path.exists():
            return
        path.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")

    def _load_json(self, path: Path) -> dict[str, Any]:
        if not path.exists():
            return {}
        return json.loads(path.read_text(encoding="utf-8"))

    def _save_json(self, path: Path, payload: dict[str, Any]) -> None:
        path.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")

    def _iter_probe_manifests(self, component: str = "c3") -> list[Path]:
        component = _ledger_component(component)
        sessions_root = self.root / component / "sessions"
        if not sessions_root.exists():
            return []
        return sorted(sessions_root.glob("*/*/probes/*.manifest.json"))

    def _update_active(self, bucket: str, item_id: str, manifest_path: Path, log_path: Path) -> None:
        active_path = self.root / "active.json"
        active = self._load_json(active_path)
        active.setdefault("version", 1)
        active["updated_at"] = _now()
        entries = active.setdefault(bucket, {})
        entries[item_id] = {
            "manifest_path": str(manifest_path),
            "log_path": str(log_path),
            "updated_at": _now(),
        }
        self._save_json(active_path, active)

    def _create_manifest(
        self,
        *,
        component: str,
        kind: str,
        item_id: str,
        log_name: str,
        payload: dict[str, Any],
        active_bucket: str,
    ) -> dict[str, Any]:
        directory = self._manifest_dir(component, kind, item_id)
        directory.mkdir(parents=True, exist_ok=True)
        if kind in {"agents", "sessions"}:
            (directory / "probes").mkdir(exist_ok=True)
            (directory / "artifacts").mkdir(exist_ok=True)
        manifest_path = directory / "manifest.json"
        log_path = directory / log_name
        manifest = {
            **payload,
            "component": component,
            "manifest_path": str(manifest_path),
            "log_path": str(log_path),
            "created_at": payload.get("created_at") or _now(),
            "updated_at": _now(),
        }
        self._write_json_if_missing(manifest_path, manifest)
        log_path.touch(exist_ok=True)
        self._update_active(active_bucket, item_id, manifest_path, log_path)
        return {"id": item_id, "component": component, "manifest_path": str(manifest_path), "log_path": str(log_path)}

    def create_agent(self, request: AgentCreate) -> dict[str, Any]:
        data = _dump_model(request)
        component = data.get("component") or "c3"
        agent_id = _slug(data.get("agent_id") or f"agent-{uuid.uuid4().hex[:10]}")
        return self._create_manifest(
            component=component,
            kind="agents",
            item_id=agent_id,
            log_name="agent.jsonl",
            active_bucket="active_agents",
            payload={"agent_id": agent_id, **data},
        )

    def create_lane(self, request: LaneCreate) -> dict[str, Any]:
        data = _dump_model(request)
        component = data.get("component") or "c3"
        lane_id = _slug(data.get("lane_id") or f"lane-{uuid.uuid4().hex[:10]}")
        return self._create_manifest(
            component=component,
            kind="lanes",
            item_id=lane_id,
            log_name="lane.jsonl",
            active_bucket="active_lanes",
            payload={"lane_id": lane_id, **data},
        )

    def create_session(self, request: SessionCreate) -> dict[str, Any]:
        data = _dump_model(request)
        component = data.get("component") or "c3"
        session_id = _slug(data.get("session_id") or f"session-{uuid.uuid4().hex[:10]}")
        return self._create_manifest(
            component=component,
            kind="sessions",
            item_id=session_id,
            log_name="session.jsonl",
            active_bucket="active_sessions",
            payload={"session_id": session_id, **data},
        )

    def _active_entry(self, bucket: str, item_id: str) -> dict[str, Any] | None:
        active = self._load_json(self.root / "active.json")
        value = active.get(bucket, {}).get(item_id)
        return value if isinstance(value, dict) else None

    def _ensure_log_entry(
        self,
        *,
        component: str,
        bucket: str,
        kind: str,
        item_id: str,
        log_name: str,
        payload: dict[str, Any],
    ) -> dict[str, Any] | None:
        item_id = _slug(item_id)
        entry = self._active_entry(bucket, item_id)
        if entry and entry.get("log_path"):
            return entry
        created = self._create_manifest(
            component=component,
            kind=kind,
            item_id=item_id,
            log_name=log_name,
            active_bucket=bucket,
            payload=payload,
        )
        return {"manifest_path": created["manifest_path"], "log_path": created["log_path"]}

    def _read_log_entry(self, bucket: str, item_id: str) -> dict[str, Any]:
        entry = self._active_entry(bucket, item_id)
        if not entry:
            return {"id": item_id, "found": False, "events": []}
        log_path = Path(entry.get("log_path") or "")
        events = []
        if log_path.exists():
            for line in log_path.read_text(encoding="utf-8").splitlines():
                if not line.strip():
                    continue
                try:
                    events.append(json.loads(line))
                except json.JSONDecodeError:
                    events.append({"malformed": True, "raw": line})
        return {
            "id": item_id,
            "found": True,
            "manifest_path": entry.get("manifest_path", ""),
            "log_path": str(log_path),
            "events": events,
        }

    def _target_logs(self, event: dict[str, Any]) -> list[Path]:
        targets: list[Path] = []
        component = str(event.get("component") or "c3")
        for bucket, kind, key, log_name, payload_key in (
            ("active_agents", "agents", "agent_id", "agent.jsonl", "agent_id"),
            ("active_lanes", "lanes", "lane_id", "lane.jsonl", "lane_id"),
            ("active_sessions", "sessions", "session_id", "session.jsonl", "session_id"),
        ):
            item_id = str(event.get(key) or "")
            if not item_id:
                continue
            entry = self._ensure_log_entry(
                component=component,
                bucket=bucket,
                kind=kind,
                item_id=item_id,
                log_name=log_name,
                payload={
                    payload_key: _slug(item_id),
                    "agent_id": event.get("agent_id") or "",
                    "lane_id": event.get("lane_id") or "",
                    "session_id": event.get("session_id") or "",
                    "actor": event.get("actor") if isinstance(event.get("actor"), dict) else {},
                    "implicit": True,
                },
            )
            if entry and entry.get("log_path"):
                targets.append(Path(entry["log_path"]))
        if targets:
            return targets
        actor = event.get("actor") if isinstance(event.get("actor"), dict) else {}
        actor_type = actor.get("type") or "system"
        global_log = "human.jsonl" if actor_type == "human" else "system.jsonl"
        log_path = self.root / str(event.get("component") or "c3") / "global" / global_log
        log_path.parent.mkdir(parents=True, exist_ok=True)
        return [log_path]

    def append_event(self, request: LedgerEventIn | dict[str, Any]) -> dict[str, Any]:
        event = _dump_model(request) if not isinstance(request, dict) else dict(request)
        if not event.get("event_id"):
            event["event_id"] = f"evt-{uuid.uuid4().hex}"
        if not event.get("ts"):
            event["ts"] = _now()
        if not isinstance(event.get("payload"), dict):
            event["payload"] = {}
        writes: list[dict[str, Any]] = []
        first_row: dict[str, Any] | None = None
        first_path: Path | None = None
        for log_path in self._target_logs(event):
            row = self.store.append(log_path, dict(event))
            if first_row is None:
                first_row = row
                first_path = log_path
            writes.append({"path": str(log_path), "seq": row["seq"], "hash": row["hash"]})
        if first_row is not None and first_path is not None:
            self._index_event_best_effort(first_row, first_path)
        return {"event_id": event["event_id"], "writes": writes, "event": first_row or event}

    def _index_event_best_effort(self, event: dict[str, Any], jsonl_path: Path) -> None:
        db_url = os.environ.get("HUNT_DB_URL", "").strip()
        if not db_url:
            return
        try:
            import psycopg2

            conn = psycopg2.connect(db_url)
            try:
                LedgerIndexer(conn).index_event(
                    event,
                    jsonl_path=jsonl_path,
                    line_number=event.get("seq"),
                    best_effort=True,
                )
            finally:
                conn.close()
        except Exception:
            return

    def get_active(self) -> dict[str, Any]:
        return self._load_json(self.root / "active.json")

    def get_agent_log(self, agent_id: str) -> dict[str, Any]:
        return self._read_log_entry("active_agents", agent_id)

    def get_session_log(self, session_id: str) -> dict[str, Any]:
        return self._read_log_entry("active_sessions", session_id)

    def command_timeline(self, command_id: str) -> dict[str, Any]:
        command_id = str(command_id or "").strip()
        events = [
            event
            for event in self._iter_active_events()
            if event.get("command_id") == command_id
            or (event.get("payload") or {}).get("commandId") == command_id
            or ((event.get("payload") or {}).get("receipt") or {}).get("commandId") == command_id
        ]
        events.sort(key=lambda event: (str(event.get("ts") or ""), int(event.get("seq") or 0)))
        return {
            "command_id": command_id,
            "found": bool(events),
            "event_count": len(events),
            "events": events,
        }

    def recent_failures(self, *, component: str = "c3", limit: int = 20) -> dict[str, Any]:
        limit = max(1, min(int(limit or 20), 200))
        failures = [
            _failure_summary(event)
            for event in self._iter_active_events(component=component)
            if _is_failure_event(event)
        ]
        failures.sort(key=lambda event: str(event.get("ts") or ""), reverse=True)
        return {
            "component": component,
            "limit": limit,
            "failure_count": len(failures[:limit]),
            "failures": failures[:limit],
        }

    def _iter_active_events(self, *, component: str = "") -> list[dict[str, Any]]:
        active = self.get_active()
        paths: dict[str, str] = {}
        for bucket in ("active_agents", "active_lanes", "active_sessions"):
            for entry in (active.get(bucket) or {}).values():
                if isinstance(entry, dict) and entry.get("log_path"):
                    paths[str(entry["log_path"])] = str(entry["log_path"])
        events: list[dict[str, Any]] = []
        seen_event_ids: set[str] = set()
        for raw_path in sorted(paths):
            log_path = Path(raw_path)
            if not log_path.exists():
                continue
            for line in log_path.read_text(encoding="utf-8").splitlines():
                if not line.strip():
                    continue
                try:
                    event = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if not isinstance(event, dict):
                    continue
                if component and event.get("component") != component:
                    continue
                event_id = str(event.get("event_id") or "")
                if event_id and event_id in seen_event_ids:
                    continue
                if event_id:
                    seen_event_ids.add(event_id)
                events.append(event)
        return events

    def create_probe_file(self, request: ProbeFileCreate) -> dict[str, Any]:
        data = _dump_model(request)
        component = _ledger_component(data.get("component"))
        session_id = _slug(data.get("session_id") or "no-session")
        agent_id = _slug(data.get("agent_id") or "no-agent")
        probe_id = f"probe-{uuid.uuid4().hex[:12]}"
        filename = _slug(data.get("filename") or f"{probe_id}.txt")
        directory = self.root / component / "sessions" / _date_folder() / session_id / "probes"
        directory.mkdir(parents=True, exist_ok=True)
        path = directory / filename
        if path.exists():
            path = directory / f"{probe_id}-{filename}"
        content = str(data.get("content") or "")
        path.write_text(content, encoding="utf-8")
        digest = sha256(content.encode("utf-8")).hexdigest()
        status = data.get("status") or "written"
        manifest_path = path.with_suffix(path.suffix + ".manifest.json")
        payload = {
            "probe_id": probe_id,
            "path": str(path),
            "manifest_path": str(manifest_path),
            "sha256": digest,
            "trusted": False,
            "requested_trusted": bool(data.get("trusted")),
            "status": status,
            "agent_id": agent_id,
            "lane_id": data.get("lane_id") or "",
            "session_id": session_id,
            "command_id": data.get("command_id") or "",
            "failure_event_id": data.get("failure_event_id") or "",
            "created_at": _now(),
            "updated_at": _now(),
            "metadata": data.get("metadata") or {},
        }
        self._save_json(manifest_path, payload)
        event = self.append_event(
            {
                "component": component,
                "event_type": "probe.file_written",
                "actor": {"type": "agent", "id": agent_id, "surface": "mcp"},
                "agent_id": agent_id,
                "lane_id": payload["lane_id"],
                "session_id": session_id,
                "command_id": payload["command_id"],
                "payload": payload,
                "redaction": {"applied": True, "rules": ["probe_content_not_in_event"]},
            }
        )
        return {**payload, "event_id": event["event_id"]}

    def list_probe_files(self, *, component: str = "c3", session_id: str = "", status: str = "") -> dict[str, Any]:
        component = _ledger_component(component)
        session_id = _slug(session_id) if session_id else ""
        probes: list[dict[str, Any]] = []
        for manifest_path in self._iter_probe_manifests(component):
            manifest = self._load_json(manifest_path)
            if not manifest:
                continue
            manifest.setdefault("manifest_path", str(manifest_path))
            if session_id and manifest.get("session_id") != session_id:
                continue
            if status and manifest.get("status") != status:
                continue
            probes.append(manifest)
        probes.sort(key=lambda probe: (str(probe.get("created_at") or ""), str(probe.get("probe_id") or "")))
        return {"component": component, "session_id": session_id, "status": status, "probes": probes}

    def update_probe_status(self, probe_id: str, request: ProbeStatusUpdate) -> dict[str, Any]:
        data = _dump_model(request)
        component = _ledger_component(data.get("component"))
        probe_id = str(probe_id or "").strip()
        for manifest_path in self._iter_probe_manifests(component):
            manifest = self._load_json(manifest_path)
            if manifest.get("probe_id") != probe_id:
                continue
            previous_status = manifest.get("status") or "written"
            status = data.get("status") or previous_status
            manifest.update(
                {
                    "status": status,
                    "agent_id": data.get("agent_id") or manifest.get("agent_id") or "",
                    "lane_id": data.get("lane_id") or manifest.get("lane_id") or "",
                    "session_id": _slug(data.get("session_id") or manifest.get("session_id") or "no-session"),
                    "command_id": data.get("command_id") or manifest.get("command_id") or "",
                    "failure_event_id": data.get("failure_event_id") or manifest.get("failure_event_id") or "",
                    "updated_at": _now(),
                    "metadata": {**(manifest.get("metadata") or {}), **(data.get("metadata") or {})},
                }
            )
            self._save_json(manifest_path, manifest)
            event = self.append_event(
                {
                    "component": component,
                    "event_type": "probe.status_updated",
                    "actor": {
                        "type": "agent",
                        "id": manifest.get("agent_id") or "no-agent",
                        "surface": "mcp",
                    },
                    "agent_id": manifest.get("agent_id") or "",
                    "lane_id": manifest.get("lane_id") or "",
                    "session_id": manifest.get("session_id") or "",
                    "command_id": manifest.get("command_id") or "",
                    "payload": {
                        "probe_id": probe_id,
                        "path": manifest.get("path") or "",
                        "manifest_path": str(manifest_path),
                        "previous_status": previous_status,
                        "status": status,
                        "command_id": manifest.get("command_id") or "",
                        "failure_event_id": manifest.get("failure_event_id") or "",
                    },
                    "redaction": {"applied": True, "rules": ["probe_content_not_in_event"]},
                }
            )
            return {**manifest, "event_id": event["event_id"]}
        raise FileNotFoundError(probe_id)
