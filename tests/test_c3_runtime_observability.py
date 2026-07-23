import json
import subprocess
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]


def _run_module(module_path: str, body: str) -> dict:
    script = f"""
import fs from "node:fs";
const source = fs.readFileSync({json.dumps(str(REPO_ROOT / module_path))}, "utf8");
const url = "data:text/javascript;base64," + Buffer.from(source).toString("base64");
const mod = await import(url);
{body}
"""
    completed = subprocess.run(
        ["node", "--input-type=module", "-e", script],
        cwd=REPO_ROOT,
        check=True,
        capture_output=True,
        text=True,
    )
    return json.loads(completed.stdout)


def test_operation_state_tracks_liveness_separately_from_progress():
    result = _run_module(
        "executioner/src/background/operations/state.js",
        """
let now = 1_000;
const store = mod.createOperationStateStore({ now: () => now });
store.start({
  tabId: 7,
  operationId: "op_1",
  fillRunId: "fill_1",
  command: "c3.fill_page",
  phase: "field_action",
  substep: "wait_for_owned_listbox",
});
now = 2_000;
store.heartbeat(7, "op_1", "fill_1", { pendingAction: "wait_for_options" });
now = 3_000;
store.progress(7, "op_1", "fill_1", {
  fieldKey: "source",
  fieldLabel: "How did you hear about us?",
  fieldKind: "button_listbox",
  attempt: 2,
});
console.log(JSON.stringify(store.snapshot(7)));
""",
    )

    assert result["active"] is True
    assert result["operationId"] == "op_1"
    assert result["fillRunId"] == "fill_1"
    assert result["heartbeatSeq"] == 2
    assert result["progressSeq"] == 2
    assert result["lastHeartbeatAt"] == 3000
    assert result["lastProgressAt"] == 3000
    assert result["pendingAction"] == "wait_for_options"
    assert result["fieldKey"] == "source"
    assert result["attempt"] == 2


def test_operation_state_rejects_stale_run_updates_and_preserves_cancel_reason():
    result = _run_module(
        "executioner/src/background/operations/state.js",
        """
let now = 10;
const store = mod.createOperationStateStore({ now: () => now });
store.start({ tabId: 8, operationId: "op_new", fillRunId: "fill_new", command: "c3.page_walk" });
const stale = store.progress(8, "op_old", "fill_old", { phase: "wrong" });
now = 20;
const requested = store.requestCancel(8, "op_new", "fill_new", "watchdog_timeout");
now = 30;
const acknowledged = store.acknowledgeCancel(8, "op_new", "fill_new");
console.log(JSON.stringify({ stale, requested, acknowledged, snapshot: store.snapshot(8) }));
""",
    )

    assert result["stale"]["ok"] is False
    assert result["stale"]["reason"] == "stale_run"
    assert result["requested"]["ok"] is True
    assert result["acknowledged"]["ok"] is True
    assert result["snapshot"]["cancelReason"] == "watchdog_timeout"
    assert result["snapshot"]["cancelRequested"] is True
    assert result["snapshot"]["cancelAcknowledgedAt"] == 30


def test_operation_state_keeps_superseded_run_until_real_unwind_ack():
    result = _run_module(
        "executioner/src/background/operations/state.js",
        """
let now = 10;
const store = mod.createOperationStateStore({ now: () => now });
store.start({ tabId: 9, operationId: "op_old", fillRunId: "fill_old", command: "c3.fill_page" });
store.requestCancel(9, "op_old", "fill_old", "superseded_by_new_fill");
now = 20;
store.start({ tabId: 9, operationId: "op_new", fillRunId: "fill_new", command: "c3.fill_page" });
const staleProgress = store.progress(9, "op_old", "fill_old", { phase: "wrong" });
now = 30;
const acknowledged = store.acknowledgeCancel(9, "op_old", "fill_old");
store.complete(9, "op_old", "fill_old", { phase: "terminal", substep: "cancelled" });
console.log(JSON.stringify({
  staleProgress,
  acknowledged,
  current: store.snapshot(9),
  old: store.snapshotOperation(9, "op_old", "fill_old"),
}));
""",
    )

    assert result["staleProgress"]["ok"] is False
    assert result["staleProgress"]["reason"] == "stale_run"
    assert result["acknowledged"]["ok"] is True
    assert result["current"]["operationId"] == "op_new"
    assert result["current"]["active"] is True
    assert result["old"]["operationId"] == "op_old"
    assert result["old"]["active"] is False
    assert result["old"]["cancelReason"] == "superseded_by_new_fill"
    assert result["old"]["cancelAcknowledgedAt"] == 30


def test_operation_state_caps_retained_terminal_runs_without_dropping_current_tab():
    result = _run_module(
        "executioner/src/background/operations/state.js",
        """
let now = 0;
const store = mod.createOperationStateStore({ now: () => ++now, maxRetainedOperations: 3 });
for (let index = 0; index < 5; index += 1) {
  const operationId = `op_${index}`;
  const fillRunId = `fill_${index}`;
  store.start({ tabId: 10, operationId, fillRunId, command: "c3.fill_page" });
  store.complete(10, operationId, fillRunId, { phase: "terminal" });
}
console.log(JSON.stringify({
  oldest: store.snapshotOperation(10, "op_0", "fill_0"),
  retained: [2, 3, 4].map((index) => Boolean(store.snapshotOperation(10, `op_${index}`, `fill_${index}`))),
  current: store.snapshot(10),
  retainedCount: store.retainedOperationCount(),
}));
""",
    )

    assert result["oldest"] is None
    assert result["retained"] == [True, True, True]
    assert result["current"]["operationId"] == "op_4"
    assert result["current"]["active"] is False
    assert result["retainedCount"] == 3


def test_terminal_operation_tombstone_is_retained_but_never_mutation_current():
    result = _run_module(
        "executioner/src/background/operations/state.js",
        """
const store = mod.createOperationStateStore();
store.start({ tabId: 11, operationId: "op_terminal", fillRunId: "fill_terminal" });
const activeBefore = store.isCurrent(11, "op_terminal", "fill_terminal");
store.requestCancel(11, "op_terminal", "fill_terminal", "timeout");
store.acknowledgeCancel(11, "op_terminal", "fill_terminal");
store.complete(11, "op_terminal", "fill_terminal", { phase: "terminal" });
console.log(JSON.stringify({
  activeBefore,
  activeAfter: store.isCurrent(11, "op_terminal", "fill_terminal"),
  retained: store.snapshotOperation(11, "op_terminal", "fill_terminal"),
}));
""",
    )

    assert result["activeBefore"] is True
    assert result["activeAfter"] is False
    assert result["retained"]["active"] is False


def test_terminal_operation_tombstone_expires_after_bounded_retention_window():
    result = _run_module(
        "executioner/src/background/operations/state.js",
        """
let now = 0;
const store = mod.createOperationStateStore({ now: () => now, terminalRetentionMs: 10 });
store.start({ tabId: 12, operationId: "op_expire", fillRunId: "fill_expire" });
store.complete(12, "op_expire", "fill_expire", { phase: "terminal" });
now = 20;
console.log(JSON.stringify({
  operation: store.snapshotOperation(12, "op_expire", "fill_expire"),
  tab: store.snapshot(12),
  retainedCount: store.retainedOperationCount(),
}));
""",
    )

    assert result == {"operation": None, "tab": None, "retainedCount": 0}


def test_heartbeat_scheduler_ticks_and_stops():
    result = _run_module(
        "executioner/src/background/operations/heartbeat.js",
        """
const calls = [];
let scheduled = null;
let cleared = null;
const handle = mod.startOperationHeartbeat({
  intervalMs: 2_000,
  heartbeat: () => calls.push("tick"),
  setIntervalFn: (fn, ms) => { scheduled = { fn, ms }; return 99; },
  clearIntervalFn: (id) => { cleared = id; },
});
scheduled.fn();
handle.stop();
handle.stop();
console.log(JSON.stringify({ calls, intervalMs: scheduled.ms, cleared }));
""",
    )

    assert result == {"calls": ["tick"], "intervalMs": 2000, "cleared": 99}


def test_run_guard_blocks_aborted_and_stale_mutations():
    result = _run_module(
        "executioner/src/background/operations/guard.js",
        """
const controller = new AbortController();
let current = true;
const guard = mod.createRunGuard({
  operationId: "op_1",
  fillRunId: "fill_1",
  signal: controller.signal,
  isCurrent: () => current,
});
const reasons = [];
current = false;
try { guard.beforeMutation("click_option"); } catch (error) { reasons.push(error.code); }
current = true;
controller.abort("agent_cancel");
try { guard.beforeMutation("type_value"); } catch (error) { reasons.push(error.code); }
console.log(JSON.stringify({ reasons }));
""",
    )

    assert result["reasons"] == ["stale_run", "agent_cancel"]


def test_background_acknowledges_cancel_only_after_fill_driver_unwinds():
    background = (REPO_ROOT / "executioner/src/background/index.js").read_text(encoding="utf-8")
    progress_case = background[
        background.index('case "hunt.apply.get_active_fill_progress"') : background.index(
            'case "hunt.apply.cancel_fill"'
        )
    ]
    cancel_case = background[
        background.index('case "hunt.apply.cancel_fill"') : background.index(
            'case "hunt.apply.site_action_log"'
        )
    ]

    assert 'from "./operations/state.js"' in background
    assert 'from "./operations/heartbeat.js"' in background
    assert 'from "./operations/guard.js"' in background
    assert "createOperationStateStore" in background
    assert "startOperationHeartbeat" in background
    assert "createRunGuard" in background
    assert "operationStateStore.progress" in background
    assert "operationStateStore.snapshot" in progress_case
    for field in (
        "operationId",
        "phase",
        "substep",
        "fieldKey",
        "fieldLabel",
        "fieldKind",
        "attempt",
        "heartbeatSeq",
        "progressSeq",
        "lastHeartbeatAt",
        "lastProgressAt",
        "elapsedMs",
        "pendingAction",
        "popupOwner",
        "cancelRequested",
    ):
        assert field in progress_case
    assert "operationStateStore.requestCancel" in background
    assert "cancelFillRun(fillRunId, cancelReason)" in cancel_case
    finish_case = background[
        background.index("function finishTrackedFillOperation") : background.index(
            "const INTERNAL_C3_COMMAND_MESSAGE_TYPE"
        )
    ]
    assert "operationStateStore.acknowledgeCancel" not in cancel_case
    assert "operationStateStore.acknowledgeCancel" in finish_case
    assert finish_case.index("operationStateStore.acknowledgeCancel") < finish_case.index(
        "operationStateStore.complete"
    )
    assert "await markPageFillCancelled" in cancel_case
    assert "acknowledged: false" in cancel_case
    assert "acknowledgementPending: cancelled" in cancel_case
    assert 'message.payload?.reason || "agent_cancel"' in cancel_case


def test_background_does_not_ack_supersede_or_reload_before_driver_unwinds():
    background = (REPO_ROOT / "executioner/src/background/index.js").read_text(encoding="utf-8")
    reload_handler = background[
        background.index("async function cancelFillRunForUserReload") : background.index(
            "function compactApplyContextForLog"
        )
    ]
    fill_start_at = background.index("const fillRunId = createFillRunId();")
    fill_supersede = background[
        fill_start_at : background.index(
            "const operationTracker = startTrackedFillOperation", fill_start_at
        )
    ]
    page_walk_start_at = background.index(
        "const fillRunId = message.payload?.fillRunId || createFillRunId();"
    )
    page_walk_supersede = background[
        page_walk_start_at : background.index(
            "const operationTracker = startTrackedFillOperation", page_walk_start_at
        )
    ]
    compact_reload = "".join(reload_handler.split())
    compact_fill = "".join(fill_supersede.split())
    compact_page_walk = "".join(page_walk_supersede.split())

    assert "operationStateStore.acknowledgeCancel" not in reload_handler
    assert "operationStateStore.acknowledgeCancel" not in fill_supersede
    assert "operationStateStore.acknowledgeCancel" not in page_walk_supersede
    assert 'markPageFillCancelled(tabId,fillRunId,true,"page_reloaded")' in compact_reload
    assert (
        'markPageFillCancelled(tabId,supersededFillRunId,true,"superseded_by_new_fill"'
        in compact_fill
    )
    assert (
        'markPageFillCancelled(tabId,supersededFillRunId,true,"superseded_by_new_fill"'
        in compact_page_walk
    )


def test_no_progress_timeout_cancels_run_with_exact_reason_and_ack_evidence():
    background = (REPO_ROOT / "executioner/src/background/index.js").read_text(encoding="utf-8")
    watchdog_start = background.index("async function runFillForTabWithNoProgressWatchdog")
    watchdog = background[
        watchdog_start : background.index(
            "async function runFillWithOneRefreshRetry", watchdog_start
        )
    ]
    finish = background[
        background.index("function finishTrackedFillOperation") : background.index(
            "const INTERNAL_C3_COMMAND_MESSAGE_TYPE"
        )
    ]

    assert 'cancelFillRun(fillRunId, "fill_no_progress_timeout")' in watchdog
    assert 'markPageFillCancelled(tabId,fillRunId,true,"fill_no_progress_timeout"' in "".join(
        watchdog.split()
    )
    assert "fillPromise" in watchdog
    assert "operation.cancel_acknowledged" in finish


def test_all_fill_timeout_paths_return_after_bounded_unwind_window():
    background = (REPO_ROOT / "executioner/src/background/index.js").read_text(encoding="utf-8")
    runner = (REPO_ROOT / "executioner/src/background/fill-runner.js").read_text(encoding="utf-8")
    pipeline = (REPO_ROOT / "executioner/src/shared/v2/field-pipeline.js").read_text(
        encoding="utf-8"
    )
    workday = (REPO_ROOT / "executioner/src/ats/workday/fill-v2.js").read_text(encoding="utf-8")

    cooperative = background[
        background.index("async function withCooperativeFillTimeout") : background.index(
            "async function sendDebugLog"
        )
    ]
    watchdog_start = background.index("async function runFillForTabWithNoProgressWatchdog")
    watchdog = background[
        watchdog_start : background.index(
            "async function runFillWithOneRefreshRetry", watchdog_start
        )
    ]
    runner_timeout = runner[
        runner.index("async function withBoundedTimeoutAndQuarantine") : runner.index(
            "function createAdapterExecuteScriptTimeoutResult"
        )
    ]
    pipeline_timeout = pipeline[
        pipeline.index("async function withTimeout(") : pipeline.index("function inventoryEntry")
    ]
    workday_timeout = workday[
        workday.index('const reason = "workday_fill_return_timeout"') : workday.index(
            "return first.result;", workday.index('const reason = "workday_fill_return_timeout"')
        )
    ]

    assert "await observed;" not in cooperative
    assert "await fillPromise.catch" not in watchdog
    assert "await observed;" not in runner_timeout
    assert "await observed;" not in pipeline_timeout
    assert "await fillPromise.catch" not in workday_timeout
    for source in (cooperative, watchdog, runner_timeout, pipeline_timeout, workday_timeout):
        assert ".catch(" in source or ".then(" in source


def test_trusted_input_releases_pressed_mouse_and_keys_before_debugger_detach():
    background = (REPO_ROOT / "executioner/src/background/index.js").read_text(encoding="utf-8")
    trusted_input = background[
        background.index("async function dispatchTrustedInput") : background.index(
            "async function ensurePasswordSavingDisabled"
        )
    ]

    assert "pressedInput" in trusted_input
    assert "releasePressedInput" in trusted_input
    finally_block = trusted_input[trusted_input.rindex("} finally {") :]
    assert finally_block.index("releasePressedInput") < finally_block.index(
        "chrome.debugger.detach"
    )
    assert "withInputCommandTimeout" in trusted_input


def test_cancellation_marking_and_trusted_input_cleanup_are_themselves_bounded():
    background = (REPO_ROOT / "executioner/src/background/index.js").read_text(encoding="utf-8")
    mark_start = background.index("async function markPageFillCancelled")
    mark_cancelled = background[mark_start : background.index("function fillCancelledResponse")]
    trusted_input = background[
        background.index("async function dispatchTrustedInput") : background.index(
            "async function ensurePasswordSavingDisabled"
        )
    ]

    assert "withTimeout(" in mark_cancelled
    assert "PAGE_CANCEL_MARK_TIMEOUT_MS" in mark_cancelled
    assert "withInputCommandTimeout" in trusted_input
    assert "TRUSTED_INPUT_CLEANUP_TIMEOUT_MS" in trusted_input


def test_cancel_command_bounds_activity_and_progress_cleanup_without_losing_response():
    background = (REPO_ROOT / "executioner/src/background/index.js").read_text(encoding="utf-8")
    cancel_case = background[
        background.index('case "hunt.apply.cancel_fill"') : background.index(
            'case "hunt.apply.site_action_log"'
        )
    ]

    assert "CANCEL_COMMAND_CLEANUP_TIMEOUT_MS" in background
    assert cancel_case.count("withTimeout(") == 2
    assert "Promise.allSettled" in cancel_case
    assert "acknowledgementPending: cancelled" in cancel_case


def test_popup_progress_resets_the_active_fill_no_progress_watchdog():
    background = (REPO_ROOT / "executioner/src/background/index.js").read_text(encoding="utf-8")
    watchdog_start = background.index("async function runFillForTabWithNoProgressWatchdog")
    watchdog = background[
        watchdog_start : background.index(
            "async function runFillWithOneRefreshRetry", watchdog_start
        )
    ]
    site_action = background[
        background.index('case "hunt.apply.site_action_log"') : background.index(
            'case "hunt.apply.trusted_input"'
        )
    ]

    assert "noteFillRunSemanticProgress" in site_action
    assert "semanticProgressSeq" in watchdog
    assert "lastSemanticProgressSeq" in watchdog


def test_workday_uses_explicit_per_operation_guards_without_shared_guard_bleed():
    workday = (REPO_ROOT / "executioner/src/ats/workday/workday-drivers-v2.js").read_text(
        encoding="utf-8"
    )

    assert "activeWorkdayActionGuard" not in workday
    assert "async function typeSearchTextLikeUser(input, text, actionGuard)" in workday
    assert "async function openPopup(field, searchText, actionGuard)" in workday
    assert "workdayFillCancelled(actionGuard)" in workday


def test_adapter_injection_carries_operation_identity_and_workday_popup_progress():
    runner = (REPO_ROOT / "executioner/src/background/fill-runner.js").read_text(encoding="utf-8")
    workday = (REPO_ROOT / "executioner/src/ats/workday/workday-drivers-v2.js").read_text(
        encoding="utf-8"
    )
    adapter_context = runner[
        runner.index("profile: adapterProfile") : runner.index(
            "repairVisibleValidationErrors", runner.index("profile: adapterProfile")
        )
    ]

    assert "operationId: context.options.operationId" in adapter_context
    assert "commandContext: context.options.commandContext" in adapter_context
    assert 'type: "hunt.apply.site_action_log"' in workday
    assert 'operationId: audit?.operationId || actionGuard?.operationId || ""' in workday
    assert "popupOwner: tracePayload.popupOwner" in workday
