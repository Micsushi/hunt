from __future__ import annotations

import sqlite3
from datetime import UTC, datetime, timedelta

import pytest

from backend.ledger.leases import InMemoryLeaseStore, LeaseConflictError, LeasePermissionError
from backend.ledger.models import Actor, LeaseStatus, SessionStatus
from backend.ledger.postgres_leases import PostgresLeaseStore


# TODO(package 01/02 integration): keep these as pure semantic tests until the
# ledger service/API and Postgres lease index exist. API tests should reuse the
# same assertions for payload/error shape once routes are wired.
class FakeClock:
    def __init__(self) -> None:
        self.now = datetime(2026, 6, 10, 12, 0, tzinfo=UTC)

    def __call__(self) -> datetime:
        return self.now

    def advance(self, seconds: int) -> None:
        self.now += timedelta(seconds=seconds)


class Ids:
    def __init__(self) -> None:
        self.counts: dict[str, int] = {}

    def __call__(self, prefix: str) -> str:
        self.counts[prefix] = self.counts.get(prefix, 0) + 1
        return f"{prefix}_{self.counts[prefix]}"


@pytest.fixture()
def clock() -> FakeClock:
    return FakeClock()


@pytest.fixture()
def store(clock: FakeClock) -> InMemoryLeaseStore:
    return InMemoryLeaseStore(clock=clock, id_factory=Ids())


AGENT_A = Actor(type="agent", id="agent-a", surface="mcp")
AGENT_B = Actor(type="agent", id="agent-b", surface="mcp")
HUMAN = Actor(type="human", id="human-operator", surface="c0_ui")


def test_active_session_mutation_lease_blocks_second_agent(store: InMemoryLeaseStore) -> None:
    first = store.claim_session_mutation_lease("lane-1", "session-1", AGENT_A)

    with pytest.raises(LeaseConflictError) as exc:
        store.claim_session_mutation_lease("lane-1", "session-1", AGENT_B)

    assert exc.value.error == {
        "code": "lease_conflict",
        "message": "Active mutation lease blocks this actor.",
        "lease_id": first.lease.lease_id,
        "agent_id": "agent-a",
        "lane_id": "lane-1",
        "session_id": "session-1",
        "status": "active",
    }
    assert store.events[-1]["event_type"] == "lease.blocked"


def test_session_mutation_leases_are_scoped_to_sessions_for_two_agents(
    store: InMemoryLeaseStore,
) -> None:
    session_a = store.claim_session_mutation_lease("lane-shared", "session-a", AGENT_A)
    session_b = store.claim_session_mutation_lease("lane-shared", "session-b", AGENT_B)

    assert session_a.lease.actor.id == "agent-a"
    assert session_b.lease.actor.id == "agent-b"
    assert (
        store.require_mutation_lease("session-a", AGENT_A, session_a.lease.lease_id)
        == session_a.lease
    )
    assert (
        store.require_mutation_lease("session-b", AGENT_B, session_b.lease.lease_id)
        == session_b.lease
    )

    with pytest.raises(LeaseConflictError) as first_conflict:
        store.claim_session_mutation_lease("lane-shared", "session-a", AGENT_B)
    with pytest.raises(LeaseConflictError) as second_conflict:
        store.require_mutation_lease("session-b", AGENT_A, session_b.lease.lease_id)

    assert first_conflict.value.error["lease_id"] == session_a.lease.lease_id
    assert first_conflict.value.error["session_id"] == "session-a"
    assert second_conflict.value.error["lease_id"] == session_b.lease.lease_id
    assert second_conflict.value.error["session_id"] == "session-b"


def test_expired_session_mutation_lease_can_be_claimed(
    store: InMemoryLeaseStore, clock: FakeClock
) -> None:
    old = store.claim_session_mutation_lease("lane-1", "session-1", AGENT_A, ttl_seconds=10)
    clock.advance(10)

    new = store.claim_session_mutation_lease("lane-1", "session-1", AGENT_B)

    assert old.lease.status == LeaseStatus.EXPIRED
    assert new.lease.actor.id == "agent-b"
    assert [event["event_type"] for event in store.events][-3:] == [
        "lease.requested",
        "lease.expired",
        "lease.granted",
    ]


def test_human_interrupt_marks_active_lease_and_logs_event(store: InMemoryLeaseStore) -> None:
    claim = store.claim_session_mutation_lease("lane-1", "session-1", AGENT_A)

    events = store.interrupt_by_human(HUMAN, session_id="session-1", reason="manual takeover")

    assert claim.lease.status == LeaseStatus.INTERRUPTED_BY_HUMAN
    assert claim.lease.interrupt_actor == HUMAN
    assert claim.lease.interrupt_reason == "manual takeover"
    assert events == [store.events[-1]]
    assert events[0]["event_type"] == "lease.interrupted_by_human"
    assert events[0]["actor"] == {"type": "human", "id": "human-operator", "surface": "c0_ui"}
    assert events[0]["payload"]["interrupted_agent_id"] == "agent-a"


def test_require_mutation_lease_allows_owner_and_blocks_other_agent(
    store: InMemoryLeaseStore,
) -> None:
    claim = store.claim_session_mutation_lease("lane-1", "session-1", AGENT_A)

    assert store.require_mutation_lease("session-1", AGENT_A, claim.lease.lease_id) == claim.lease
    with pytest.raises(LeaseConflictError):
        store.require_mutation_lease("session-1", AGENT_B, claim.lease.lease_id)


def test_human_override_bypasses_mutation_lease_and_interrupts_owner(
    store: InMemoryLeaseStore,
) -> None:
    claim = store.claim_session_mutation_lease("lane-1", "session-1", AGENT_A)

    assert store.require_mutation_lease("session-1", HUMAN) is None

    assert claim.lease.status == LeaseStatus.INTERRUPTED_BY_HUMAN
    assert store.events[-1]["event_type"] == "lease.interrupted_by_human"


def test_readonly_event_does_not_require_lease(store: InMemoryLeaseStore) -> None:
    event = store.append_readonly_event(
        "session.inspected",
        AGENT_B,
        lane_id="lane-1",
        session_id="session-1",
        payload={"route": "readonly"},
    )

    assert event["event_type"] == "session.inspected"
    assert event["payload"] == {"route": "readonly"}


def test_release_and_heartbeat_update_active_lease(store: InMemoryLeaseStore) -> None:
    claim = store.claim_session_mutation_lease("lane-1", "session-1", AGENT_A)

    heartbeat = store.heartbeat(claim.lease.lease_id, AGENT_A)
    release = store.release(claim.lease.lease_id, AGENT_A)

    assert heartbeat["event_type"] == "lease.heartbeat"
    assert release["event_type"] == "lease.released"
    assert claim.lease.status == LeaseStatus.RELEASED


def test_transfer_moves_lease_to_replacement_agent(store: InMemoryLeaseStore) -> None:
    claim = store.claim_session_mutation_lease("lane-1", "session-1", AGENT_A)

    lease = store.transfer(claim.lease.lease_id, AGENT_A, AGENT_B)

    assert lease.actor == AGENT_B
    assert lease.transferred_to_agent_id == "agent-b"
    assert store.require_mutation_lease("session-1", AGENT_B, lease.lease_id) == lease
    assert store.events[-1]["event_type"] == "lease.transferred"


def test_session_failure_invalidates_session_mutation_lease(store: InMemoryLeaseStore) -> None:
    claim = store.claim_session_mutation_lease("lane-1", "session-1", AGENT_A)

    session = store.mark_session("session-1", SessionStatus.FAILED, AGENT_A)

    assert session.status == SessionStatus.FAILED
    assert claim.lease.status == LeaseStatus.RELEASED
    assert [event["event_type"] for event in store.events][-2:] == [
        "session.failed",
        "lease.released",
    ]


def test_replacement_session_keeps_lane_and_links_parent(store: InMemoryLeaseStore) -> None:
    store.create_session("lane-1", "session-parent", AGENT_A)

    child = store.create_session(
        "lane-1",
        "session-child",
        AGENT_A,
        parent_session_id="session-parent",
    )

    assert child.lane_id == "lane-1"
    assert child.parent_session_id == "session-parent"
    assert store.sessions["session-parent"].status == SessionStatus.REPLACED
    assert store.lanes["lane-1"].session_ids == ["session-parent", "session-child"]


def test_agent_without_active_lease_cannot_mutate(store: InMemoryLeaseStore) -> None:
    store.create_session("lane-1", "session-1", AGENT_A)

    with pytest.raises(LeasePermissionError):
        store.require_mutation_lease("session-1", AGENT_A)


def _sqlite_lease_connection(path):
    connection = sqlite3.connect(path)
    connection.execute(
        """
        CREATE TABLE IF NOT EXISTS ledger_leases (
            lease_id TEXT PRIMARY KEY,
            component TEXT NOT NULL DEFAULT 'c3',
            lease_type TEXT NOT NULL,
            status TEXT NOT NULL,
            agent_id TEXT,
            lane_id TEXT,
            session_id TEXT,
            command_id TEXT,
            claimed_at TEXT NOT NULL,
            heartbeat_at TEXT,
            expires_at TEXT NOT NULL,
            released_at TEXT,
            metadata_json TEXT NOT NULL DEFAULT '{}'
        )
        """
    )
    connection.execute(
        """
        CREATE UNIQUE INDEX IF NOT EXISTS idx_ledger_leases_one_active_session_mutation
        ON ledger_leases(lease_type, lane_id, session_id)
        WHERE status = 'active' AND lease_type = 'session_mutation'
        """
    )
    connection.commit()
    return connection


def test_postgres_lease_store_blocks_second_agent_across_store_instances(tmp_path) -> None:
    db_path = tmp_path / "leases.db"
    first_connection = _sqlite_lease_connection(db_path)
    first_store = PostgresLeaseStore(first_connection, id_factory=Ids())

    first = first_store.claim_session_mutation_lease("lane-1", "session-1", AGENT_A)
    first_connection.close()

    second_connection = _sqlite_lease_connection(db_path)
    second_store = PostgresLeaseStore(second_connection, id_factory=Ids())
    with pytest.raises(LeaseConflictError) as exc:
        second_store.claim_session_mutation_lease("lane-1", "session-1", AGENT_B)

    assert exc.value.error["lease_id"] == first.lease.lease_id
    assert exc.value.error["agent_id"] == "agent-a"
    assert exc.value.error["session_id"] == "session-1"
    assert second_store.events[-1]["event_type"] == "lease.blocked"
    second_connection.close()


def test_postgres_lease_store_scopes_conflicts_to_lane_session_pair(tmp_path) -> None:
    connection = _sqlite_lease_connection(tmp_path / "leases.db")
    store = PostgresLeaseStore(connection, id_factory=Ids())

    session_a = store.claim_session_mutation_lease("lane-shared", "session-a", AGENT_A)
    session_b = store.claim_session_mutation_lease("lane-shared", "session-b", AGENT_B)

    with pytest.raises(LeaseConflictError) as blocked_same_session:
        store.claim_session_mutation_lease("lane-shared", "session-a", AGENT_B)
    with pytest.raises(LeaseConflictError):
        store.require_mutation_lease("session-b", AGENT_A, session_b.lease.lease_id)

    active_rows = connection.execute(
        """
        SELECT agent_id, session_id
        FROM ledger_leases
        WHERE status = ?
        ORDER BY session_id
        """,
        [LeaseStatus.ACTIVE.value],
    ).fetchall()
    assert blocked_same_session.value.error["lease_id"] == session_a.lease.lease_id
    assert active_rows == [("agent-a", "session-a"), ("agent-b", "session-b")]
    connection.close()


def test_postgres_lease_store_updates_control_state_and_event_shapes(tmp_path) -> None:
    connection = _sqlite_lease_connection(tmp_path / "leases.db")
    store = PostgresLeaseStore(connection, id_factory=Ids())
    claim = store.claim_session_mutation_lease("lane-1", "session-1", AGENT_A)

    heartbeat = store.heartbeat(claim.lease.lease_id, AGENT_A)
    lease = store.transfer(claim.lease.lease_id, AGENT_A, AGENT_B)
    interrupted = store.interrupt_by_human(
        HUMAN, lease_id=claim.lease.lease_id, reason="manual takeover"
    )

    row = connection.execute(
        "SELECT status, agent_id, metadata_json FROM ledger_leases WHERE lease_id = ?",
        [claim.lease.lease_id],
    ).fetchone()
    assert heartbeat["event_type"] == "lease.heartbeat"
    assert lease.actor == AGENT_B
    assert interrupted[0]["event_type"] == "lease.interrupted_by_human"
    assert interrupted[0]["payload"]["interrupted_agent_id"] == "agent-b"
    assert row[0] == LeaseStatus.INTERRUPTED_BY_HUMAN.value
    assert row[1] == "agent-b"
    assert "manual takeover" in row[2]
    connection.close()
