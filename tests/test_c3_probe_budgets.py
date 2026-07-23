import json
from concurrent.futures import ThreadPoolExecutor

import pytest

from backend.c3_probe_budgets import (
    ProbeBudgetExceeded,
    ProbeBudgetLimits,
    ProbeBudgetManager,
)


def _manager() -> ProbeBudgetManager:
    manager = ProbeBudgetManager()
    manager.create(
        budget_id="budget-1",
        agent_id="agent-1",
        session_id="session-1",
        lease_id="lease-1",
        operation_id="op-1",
        limits=ProbeBudgetLimits(
            attempts=3,
            mutations=2,
            wall_seconds=60,
            files=1,
            bytes=100,
        ),
    )
    return manager


def test_mutation_is_reserved_before_action_and_consumed_when_followup_denied():
    manager = _manager()
    opener = manager.reserve(
        "budget-1",
        agent_id="agent-1",
        session_id="session-1",
        lease_id="lease-1",
        operation_id="op-1",
        action="open_owned_popup",
        mutation_count=1,
        reason="inspect novel listbox",
        expected_predicate="popup_open",
    )
    manager.commit(opener.reservation_id, proof={"predicate": "popup_open", "passed": True})
    option = manager.reserve(
        "budget-1",
        agent_id="agent-1",
        session_id="session-1",
        lease_id="lease-1",
        operation_id="op-1",
        action="click_owned_option",
        mutation_count=1,
        reason="test commit",
        expected_predicate="value_committed",
    )
    manager.commit(option.reservation_id, proof={"predicate": "value_committed", "passed": False})

    with pytest.raises(ProbeBudgetExceeded):
        manager.reserve(
            "budget-1",
            agent_id="agent-1",
            session_id="session-1",
            lease_id="lease-1",
            operation_id="op-1",
            action="click_owned_option",
            mutation_count=1,
            reason="third mutation",
            expected_predicate="value_committed",
        )

    usage = manager.snapshot("budget-1")
    assert usage["used"]["mutations"] == 2
    assert usage["reservations"][1]["proof"]["passed"] is False


def test_identity_mismatch_is_rejected_before_reservation():
    manager = _manager()

    with pytest.raises(PermissionError, match="probe_budget_identity_mismatch"):
        manager.reserve(
            "budget-1",
            agent_id="agent-other",
            session_id="session-1",
            lease_id="lease-1",
            operation_id="op-1",
            action="read_attributes",
            reason="inspect",
            expected_predicate="attributes_returned",
        )


def test_concurrent_reservations_cannot_exceed_atomic_limit():
    manager = _manager()

    def reserve_one(index: int) -> bool:
        try:
            manager.reserve(
                "budget-1",
                agent_id="agent-1",
                session_id="session-1",
                lease_id="lease-1",
                operation_id="op-1",
                action="open_owned_popup",
                mutation_count=1,
                reason=f"concurrent-{index}",
                expected_predicate="popup_open",
            )
            return True
        except ProbeBudgetExceeded:
            return False

    with ThreadPoolExecutor(max_workers=8) as pool:
        outcomes = list(pool.map(reserve_one, range(8)))

    assert sum(outcomes) == 2
    assert manager.snapshot("budget-1")["used"]["mutations"] == 2


def test_unknown_or_unbounded_probe_action_is_rejected():
    manager = _manager()

    with pytest.raises(ValueError, match="probe_action_not_allowed"):
        manager.reserve(
            "budget-1",
            agent_id="agent-1",
            session_id="session-1",
            lease_id="lease-1",
            operation_id="op-1",
            action="evaluate_arbitrary_javascript",
            mutation_count=1,
            reason="unsafe",
            expected_predicate="anything",
        )


def test_committed_probe_persists_only_structural_proof_not_raw_observed_values(tmp_path):
    database = tmp_path / "structural-proof.sqlite3"
    manager = ProbeBudgetManager(storage_path=database)
    manager.create(
        budget_id="budget-1",
        agent_id="agent-1",
        session_id="session-1",
        lease_id="lease-1",
        operation_id="op-1",
        limits=ProbeBudgetLimits(attempts=3, mutations=2, files=1, bytes=100),
    )
    reservation = manager.reserve(
        "budget-1",
        agent_id="agent-1",
        session_id="session-1",
        lease_id="lease-1",
        operation_id="op-1",
        action="click_owned_option",
        mutation_count=1,
        reason="confirm widget commit",
        expected_predicate="value_committed",
    )

    manager.commit(
        reservation.reservation_id,
        proof={
            "predicate": "value_committed",
            "passed": True,
            "before": {"backingValue": "private-before-value"},
            "after": {"backing_value": "private-after-value"},
            "observed": {"optionText": "private selected option"},
        },
    )

    snapshot = ProbeBudgetManager(storage_path=database).snapshot("budget-1")
    serialized = json.dumps(snapshot)
    assert "private-before-value" not in serialized
    assert "private-after-value" not in serialized
    assert "private selected option" not in serialized
    assert snapshot["reservations"][0]["proof"] == {
        "predicate": "value_committed",
        "passed": True,
    }


def test_file_backed_budget_is_shared_between_manager_instances(tmp_path):
    database = tmp_path / "probe-budgets.sqlite3"
    first = ProbeBudgetManager(storage_path=database)
    second = ProbeBudgetManager(storage_path=database)
    first.create(
        budget_id="shared-budget",
        agent_id="agent-1",
        session_id="session-1",
        lease_id="lease-1",
        operation_id="op-1",
        limits=ProbeBudgetLimits(
            attempts=2,
            mutations=1,
            wall_seconds=60,
            files=1,
            bytes=100,
        ),
    )

    first.reserve(
        "shared-budget",
        agent_id="agent-1",
        session_id="session-1",
        lease_id="lease-1",
        operation_id="op-1",
        action="open_owned_popup",
        mutation_count=1,
        reason="first process",
        expected_predicate="popup_open",
    )

    with pytest.raises(ProbeBudgetExceeded, match="probe_budget_mutations_exceeded"):
        second.reserve(
            "shared-budget",
            agent_id="agent-1",
            session_id="session-1",
            lease_id="lease-1",
            operation_id="op-1",
            action="open_owned_popup",
            mutation_count=1,
            reason="second process",
            expected_predicate="popup_open",
        )
    assert second.snapshot("shared-budget")["used"]["mutations"] == 1


def test_failed_reservation_is_durable_and_cannot_later_commit(tmp_path):
    database = tmp_path / "probe-budgets.sqlite3"
    first = ProbeBudgetManager(storage_path=database)
    first.create(
        budget_id="failed-budget",
        agent_id="agent-1",
        session_id="session-1",
        lease_id="lease-1",
        operation_id="op-1",
        limits=ProbeBudgetLimits(),
    )
    reservation = first.reserve(
        "failed-budget",
        agent_id="agent-1",
        session_id="session-1",
        lease_id="lease-1",
        operation_id="op-1",
        action="page_info",
        reason="inspect",
        expected_predicate="page_info_available",
    )

    failed = first.fail(
        reservation.reservation_id,
        reason="diagnostic_action_timeout",
        agent_id="agent-1",
        session_id="session-1",
        lease_id="lease-1",
        operation_id="op-1",
    )
    restarted = ProbeBudgetManager(storage_path=database)

    assert failed["status"] == "failed"
    assert restarted.snapshot("failed-budget")["reservations"][0]["status"] == "failed"
    with pytest.raises(ValueError, match="probe_reservation_already_finalized"):
        restarted.commit(
            reservation.reservation_id,
            proof={"predicate": "page_info_available", "passed": True},
            agent_id="agent-1",
            session_id="session-1",
            lease_id="lease-1",
            operation_id="op-1",
        )


def test_aborted_reservation_is_durable_and_cannot_later_commit(tmp_path):
    database = tmp_path / "probe-budgets.sqlite3"
    manager = ProbeBudgetManager(storage_path=database)
    manager.create(
        budget_id="aborted-budget",
        agent_id="agent-1",
        session_id="session-1",
        lease_id="lease-1",
        operation_id="op-1",
        limits=ProbeBudgetLimits(),
    )
    reservation = manager.reserve(
        "aborted-budget",
        agent_id="agent-1",
        session_id="session-1",
        lease_id="lease-1",
        operation_id="op-1",
        action="page_info",
        reason="inspect",
        expected_predicate="page_info_available",
    )

    aborted = manager.abort(
        reservation.reservation_id,
        reason="probe_reservation_audit_failed",
        agent_id="agent-1",
        session_id="session-1",
        lease_id="lease-1",
        operation_id="op-1",
    )
    restarted = ProbeBudgetManager(storage_path=database)

    assert aborted["status"] == "aborted"
    assert restarted.snapshot("aborted-budget")["reservations"][0]["status"] == "aborted"
    with pytest.raises(ValueError, match="probe_reservation_already_finalized"):
        restarted.commit(
            reservation.reservation_id,
            proof={"predicate": "page_info_available", "passed": True},
            agent_id="agent-1",
            session_id="session-1",
            lease_id="lease-1",
            operation_id="op-1",
        )
