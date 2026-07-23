from __future__ import annotations

import json
import sqlite3
import threading
import time
import uuid
from contextlib import closing
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any

ALLOWED_PROBE_ACTIONS = {
    "target_health",
    "page_info",
    "dom_snapshot",
    "screenshot",
    "console_tail",
    "failed_request_tail",
    "active_element",
    "popup_ownership",
    "read_attributes",
    "open_owned_popup",
    "click_owned_option",
}


class ProbeBudgetExceeded(RuntimeError):
    pass


@dataclass(frozen=True)
class ProbeBudgetLimits:
    attempts: int = 10
    mutations: int = 2
    wall_seconds: float = 60
    files: int = 5
    bytes: int = 1_000_000

    def __post_init__(self) -> None:
        if any(
            value < 0
            for value in (self.attempts, self.mutations, self.wall_seconds, self.files, self.bytes)
        ):
            raise ValueError("probe_budget_limit_negative")


@dataclass(frozen=True)
class ProbeReservation:
    reservation_id: str
    budget_id: str
    action: str
    mutation_count: int
    file_count: int
    byte_count: int
    reason: str
    expected_predicate: str


@dataclass
class _Budget:
    budget_id: str
    agent_id: str
    session_id: str
    lease_id: str
    operation_id: str
    limits: ProbeBudgetLimits
    created_at: float
    used: dict[str, int] = field(
        default_factory=lambda: {"attempts": 0, "mutations": 0, "files": 0, "bytes": 0}
    )
    reservations: list[dict[str, Any]] = field(default_factory=list)


class ProbeBudgetManager:
    def __init__(
        self,
        *,
        now: Any | None = None,
        storage_path: str | Path | None = None,
    ) -> None:
        self._storage_path = Path(storage_path).resolve() if storage_path else None
        self._now = now or (time.time if self._storage_path else time.monotonic)
        self._lock = threading.RLock()
        self._budgets: dict[str, _Budget] = {}
        self._reservation_index: dict[str, _Budget] = {}
        if self._storage_path is not None:
            self._storage_path.parent.mkdir(parents=True, exist_ok=True)
            with closing(self._connect()) as connection:
                connection.execute(
                    """
                    CREATE TABLE IF NOT EXISTS c3_probe_budgets (
                        budget_id TEXT PRIMARY KEY,
                        payload_json TEXT NOT NULL
                    )
                    """
                )

    def create(
        self,
        *,
        budget_id: str,
        agent_id: str,
        session_id: str,
        lease_id: str,
        operation_id: str,
        limits: ProbeBudgetLimits,
    ) -> dict[str, Any]:
        if not all((budget_id, agent_id, session_id, lease_id, operation_id)):
            raise ValueError("probe_budget_identity_required")
        with self._lock:
            if self._storage_path is not None:
                budget = _Budget(
                    budget_id=budget_id,
                    agent_id=agent_id,
                    session_id=session_id,
                    lease_id=lease_id,
                    operation_id=operation_id,
                    limits=limits,
                    created_at=float(self._now()),
                )
                with closing(self._connect()) as connection:
                    try:
                        connection.execute(
                            "INSERT INTO c3_probe_budgets (budget_id, payload_json) VALUES (?, ?)",
                            (budget_id, _serialize_budget(budget)),
                        )
                    except sqlite3.IntegrityError as exc:
                        raise ValueError("probe_budget_exists") from exc
                return _snapshot_budget(budget)
            if budget_id in self._budgets:
                raise ValueError("probe_budget_exists")
            self._budgets[budget_id] = _Budget(
                budget_id=budget_id,
                agent_id=agent_id,
                session_id=session_id,
                lease_id=lease_id,
                operation_id=operation_id,
                limits=limits,
                created_at=float(self._now()),
            )
            return _snapshot_budget(self._budgets[budget_id])

    def reserve(
        self,
        budget_id: str,
        *,
        agent_id: str,
        session_id: str,
        lease_id: str,
        operation_id: str,
        action: str,
        reason: str,
        expected_predicate: str,
        mutation_count: int = 0,
        file_count: int = 0,
        byte_count: int = 0,
    ) -> ProbeReservation:
        if action not in ALLOWED_PROBE_ACTIONS:
            raise ValueError("probe_action_not_allowed")
        if not reason.strip() or not expected_predicate.strip():
            raise ValueError("probe_reason_and_predicate_required")
        counts = (int(mutation_count), int(file_count), int(byte_count))
        if any(value < 0 for value in counts):
            raise ValueError("probe_reservation_count_negative")
        with self._lock:
            if self._storage_path is not None:
                with closing(self._connect()) as connection:
                    connection.execute("BEGIN IMMEDIATE")
                    budget = self._load_budget(connection, budget_id)
                    reservation = self._reserve_budget(
                        budget,
                        agent_id=agent_id,
                        session_id=session_id,
                        lease_id=lease_id,
                        operation_id=operation_id,
                        action=action,
                        reason=reason,
                        expected_predicate=expected_predicate,
                        counts=counts,
                    )
                    self._save_budget(connection, budget)
                    connection.commit()
                    return reservation
            budget = self._require_budget(budget_id)
            reservation = self._reserve_budget(
                budget,
                agent_id=agent_id,
                session_id=session_id,
                lease_id=lease_id,
                operation_id=operation_id,
                action=action,
                reason=reason,
                expected_predicate=expected_predicate,
                counts=counts,
            )
            self._reservation_index[reservation.reservation_id] = budget
            return reservation

    def commit(
        self,
        reservation_id: str,
        *,
        proof: dict[str, Any],
        agent_id: str | None = None,
        session_id: str | None = None,
        lease_id: str | None = None,
        operation_id: str | None = None,
    ) -> dict[str, Any]:
        with self._lock:
            if self._storage_path is not None:
                with closing(self._connect()) as connection:
                    connection.execute("BEGIN IMMEDIATE")
                    budget = self._find_reservation_budget(connection, reservation_id)
                    record = self._commit_budget_reservation(
                        budget,
                        reservation_id,
                        proof=proof,
                        agent_id=agent_id,
                        session_id=session_id,
                        lease_id=lease_id,
                        operation_id=operation_id,
                    )
                    self._save_budget(connection, budget)
                    connection.commit()
                    return record
            budget = self._reservation_index.get(reservation_id)
            if budget is None:
                raise KeyError("probe_reservation_not_found")
            return self._commit_budget_reservation(
                budget,
                reservation_id,
                proof=proof,
                agent_id=agent_id,
                session_id=session_id,
                lease_id=lease_id,
                operation_id=operation_id,
            )

    def fail(
        self,
        reservation_id: str,
        *,
        reason: str,
        agent_id: str | None = None,
        session_id: str | None = None,
        lease_id: str | None = None,
        operation_id: str | None = None,
    ) -> dict[str, Any]:
        return self._finalize(
            reservation_id,
            status="failed",
            reason=reason,
            agent_id=agent_id,
            session_id=session_id,
            lease_id=lease_id,
            operation_id=operation_id,
        )

    def abort(
        self,
        reservation_id: str,
        *,
        reason: str,
        agent_id: str | None = None,
        session_id: str | None = None,
        lease_id: str | None = None,
        operation_id: str | None = None,
    ) -> dict[str, Any]:
        return self._finalize(
            reservation_id,
            status="aborted",
            reason=reason,
            agent_id=agent_id,
            session_id=session_id,
            lease_id=lease_id,
            operation_id=operation_id,
        )

    def _finalize(
        self,
        reservation_id: str,
        *,
        status: str,
        reason: str,
        agent_id: str | None,
        session_id: str | None,
        lease_id: str | None,
        operation_id: str | None,
    ) -> dict[str, Any]:
        if status not in {"failed", "aborted"}:
            raise ValueError("probe_reservation_status_invalid")
        if not reason.strip():
            raise ValueError("probe_reservation_reason_required")
        identity = {
            key: value
            for key, value in {
                "agent_id": agent_id,
                "session_id": session_id,
                "lease_id": lease_id,
                "operation_id": operation_id,
            }.items()
            if value is not None
        }
        with self._lock:
            if self._storage_path is not None:
                with closing(self._connect()) as connection:
                    connection.execute("BEGIN IMMEDIATE")
                    budget = self._find_reservation_budget(connection, reservation_id)
                    record = self._finalize_budget_reservation(
                        budget,
                        reservation_id,
                        status=status,
                        reason=reason,
                        identity=identity,
                    )
                    self._save_budget(connection, budget)
                    connection.commit()
                    return record
            budget = self._reservation_index.get(reservation_id)
            if budget is None:
                raise KeyError("probe_reservation_not_found")
            return self._finalize_budget_reservation(
                budget,
                reservation_id,
                status=status,
                reason=reason,
                identity=identity,
            )

    def _finalize_budget_reservation(
        self,
        budget: _Budget,
        reservation_id: str,
        *,
        status: str,
        reason: str,
        identity: dict[str, str],
    ) -> dict[str, Any]:
        if identity:
            self._check_identity(budget, **identity)
        record = next(
            item for item in budget.reservations if item["reservation_id"] == reservation_id
        )
        if record["status"] != "reserved":
            raise ValueError("probe_reservation_already_finalized")
        record["status"] = status
        record["failure"] = {"reason": reason.strip()}
        return dict(record)

    def _commit_budget_reservation(
        self,
        budget: _Budget,
        reservation_id: str,
        *,
        proof: dict[str, Any],
        agent_id: str | None,
        session_id: str | None,
        lease_id: str | None,
        operation_id: str | None,
    ) -> dict[str, Any]:
        identity = {
            "agent_id": agent_id,
            "session_id": session_id,
            "lease_id": lease_id,
            "operation_id": operation_id,
        }
        supplied_identity = {key: value for key, value in identity.items() if value is not None}
        if supplied_identity:
            self._check_identity(budget, **supplied_identity)
        record = next(
            item for item in budget.reservations if item["reservation_id"] == reservation_id
        )
        if record["status"] != "reserved":
            raise ValueError("probe_reservation_already_finalized")
        if str(proof.get("predicate") or "") != record["expected_predicate"]:
            raise ValueError("probe_proof_predicate_mismatch")
        record["proof"] = _structural_probe_proof(proof)
        record["status"] = "committed"
        return dict(record)

    def snapshot(self, budget_id: str) -> dict[str, Any]:
        with self._lock:
            if self._storage_path is not None:
                with closing(self._connect()) as connection:
                    return _snapshot_budget(self._load_budget(connection, budget_id))
            budget = self._require_budget(budget_id)
            return _snapshot_budget(budget)

    def _reserve_budget(
        self,
        budget: _Budget,
        *,
        agent_id: str,
        session_id: str,
        lease_id: str,
        operation_id: str,
        action: str,
        reason: str,
        expected_predicate: str,
        counts: tuple[int, int, int],
    ) -> ProbeReservation:
        self._check_identity(
            budget,
            agent_id=agent_id,
            session_id=session_id,
            lease_id=lease_id,
            operation_id=operation_id,
        )
        if float(self._now()) - budget.created_at > budget.limits.wall_seconds:
            raise ProbeBudgetExceeded("probe_budget_wall_time_exceeded")
        increments = {
            "attempts": 1,
            "mutations": counts[0],
            "files": counts[1],
            "bytes": counts[2],
        }
        for key, increment in increments.items():
            if budget.used[key] + increment > getattr(budget.limits, key):
                raise ProbeBudgetExceeded(f"probe_budget_{key}_exceeded")
        for key, increment in increments.items():
            budget.used[key] += increment
        reservation = ProbeReservation(
            reservation_id=f"probe_res_{uuid.uuid4().hex}",
            budget_id=budget.budget_id,
            action=action,
            mutation_count=counts[0],
            file_count=counts[1],
            byte_count=counts[2],
            reason=reason.strip(),
            expected_predicate=expected_predicate.strip(),
        )
        budget.reservations.append(
            {**asdict(reservation), "status": "reserved", "proof": {}, "trusted": False}
        )
        return reservation

    def _connect(self) -> sqlite3.Connection:
        if self._storage_path is None:
            raise RuntimeError("probe_budget_storage_not_configured")
        return sqlite3.connect(self._storage_path, timeout=30, isolation_level=None)

    def _load_budget(self, connection: sqlite3.Connection, budget_id: str) -> _Budget:
        row = connection.execute(
            "SELECT payload_json FROM c3_probe_budgets WHERE budget_id = ?", (budget_id,)
        ).fetchone()
        if row is None:
            raise KeyError("probe_budget_not_found")
        return _deserialize_budget(str(row[0]))

    def _save_budget(self, connection: sqlite3.Connection, budget: _Budget) -> None:
        connection.execute(
            "UPDATE c3_probe_budgets SET payload_json = ? WHERE budget_id = ?",
            (_serialize_budget(budget), budget.budget_id),
        )

    def _find_reservation_budget(
        self, connection: sqlite3.Connection, reservation_id: str
    ) -> _Budget:
        rows = connection.execute("SELECT payload_json FROM c3_probe_budgets").fetchall()
        for row in rows:
            budget = _deserialize_budget(str(row[0]))
            if any(item.get("reservation_id") == reservation_id for item in budget.reservations):
                return budget
        raise KeyError("probe_reservation_not_found")

    def _require_budget(self, budget_id: str) -> _Budget:
        budget = self._budgets.get(budget_id)
        if budget is None:
            raise KeyError("probe_budget_not_found")
        return budget

    @staticmethod
    def _check_identity(budget: _Budget, **identity: str) -> None:
        if any(getattr(budget, key) != value for key, value in identity.items()):
            raise PermissionError("probe_budget_identity_mismatch")


def _snapshot_budget(budget: _Budget) -> dict[str, Any]:
    return {
        "budget_id": budget.budget_id,
        "agent_id": budget.agent_id,
        "session_id": budget.session_id,
        "lease_id": budget.lease_id,
        "operation_id": budget.operation_id,
        "limits": asdict(budget.limits),
        "used": dict(budget.used),
        "reservations": [
            {**item, "proof": dict(item.get("proof") or {})} for item in budget.reservations
        ],
    }


def _structural_probe_proof(proof: dict[str, Any]) -> dict[str, Any]:
    """Persist predicate outcome, never page-entered before/after/option values."""
    passed = proof.get("passed")
    observed = proof.get("observed")
    if not isinstance(passed, bool) and isinstance(observed, dict):
        passed = observed.get("passed")
    structural: dict[str, Any] = {"predicate": str(proof.get("predicate") or "")}
    if isinstance(passed, bool):
        structural["passed"] = passed
    return structural


def _serialize_budget(budget: _Budget) -> str:
    return json.dumps(_snapshot_budget(budget) | {"created_at": budget.created_at})


def _deserialize_budget(payload: str) -> _Budget:
    value = json.loads(payload)
    return _Budget(
        budget_id=value["budget_id"],
        agent_id=value["agent_id"],
        session_id=value["session_id"],
        lease_id=value["lease_id"],
        operation_id=value["operation_id"],
        limits=ProbeBudgetLimits(**value["limits"]),
        created_at=float(value["created_at"]),
        used={key: int(item) for key, item in value["used"].items()},
        reservations=list(value.get("reservations") or []),
    )
