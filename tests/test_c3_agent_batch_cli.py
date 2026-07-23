import json
import subprocess
import sys
from dataclasses import asdict, dataclass
from pathlib import Path

import pytest

import scripts.c3_agent_batch as c3_batch
from scripts.c3_agent_batch import CliDependencies, _prepare_inactive_job_tab, main
from tools.c3_agent_testing.availability import AvailabilityResult
from tools.c3_agent_testing.report import BatchReport, LaneResult, utc_now


class FakeCancelClient:
    def __init__(self):
        self.calls = []

    def cancel_c3_operation(self, payload):
        self.calls.append(payload)
        return {"status": "cancelling"}


@dataclass
class FakeReport:
    lanes: list

    def write_json(self, path):
        Path(path).write_text(json.dumps({"lanes": self.lanes}), encoding="utf-8")


class FakeSupervisor:
    def __init__(self):
        self.calls = []

    def run(self, lanes, *, max_concurrency):
        lane_list = list(lanes)
        self.calls.append((lane_list, max_concurrency))
        return FakeReport(lanes=[{"lane_id": lane_list[0].lane_id}])


def test_cli_is_directly_executable_from_repo_root():
    completed = subprocess.run(
        [sys.executable, "scripts/c3_agent_batch.py", "--help"],
        check=False,
        capture_output=True,
        text=True,
    )

    assert completed.returncode == 0
    assert "Plan and supervise isolated C3 agent tests" in completed.stdout


def test_pchrome_launcher_loads_extension_from_its_own_checkout():
    launcher = Path("scripts/launch_c3_chrome.ps1").read_text(encoding="utf-8")

    assert '$extension = Join-Path $repoRoot "executioner"' in launcher
    assert "C:\\Users\\sushi\\Documents\\Github\\hunt\\executioner" not in launcher


def test_pchrome_launcher_keeps_a_minimized_window_for_stable_extension_target():
    launcher = Path("scripts/launch_c3_chrome.ps1").read_text(encoding="utf-8")

    assert "--start-minimized" in launcher
    assert "--no-startup-window" not in launcher


def test_fresh_batch_setup_does_not_immediately_reload_extension():
    batch_cli = Path("scripts/c3_agent_batch.py").read_text(encoding="utf-8")

    assert '            "-ReloadExtension",' not in batch_cli


def test_lane_config_defaults_to_control_plane_backend():
    configure = Path("scripts/configure_c3_debug_sink.js").read_text(encoding="utf-8")

    assert 'process.env.HUNT_BACKEND_URL || "http://127.0.0.1:8000"' in configure
    assert "Default: http://127.0.0.1:8000" in configure
    assert "for (let pageAttempt = 0; pageAttempt < 3; pageAttempt += 1)" in configure
    assert "await closeTarget(port, opened)" in configure


def test_discovery_wakes_suspended_extension_with_exact_background_target(monkeypatch):
    extension = {
        "id": "worker-1",
        "type": "service_worker",
        "title": "Hunt Apply",
        "url": "chrome-extension://abcdefghijklmnopabcdefghijklmnop/src/background/index.js",
        "webSocketDebuggerUrl": "ws://extension-worker",
    }
    target_reads = iter([[], [extension]])
    monkeypatch.setattr(c3_batch, "_read_devtools_targets", lambda _port: next(target_reads))
    monkeypatch.setattr(
        c3_batch,
        "_create_background_target",
        lambda port, url: (
            "devtools-job-target" if port == 9411 and url == "https://job.test" else ""
        ),
    )
    monkeypatch.setattr(
        c3_batch,
        "_ensure_extension_page_target",
        lambda port, extension_id, extension: (
            (
                {**extension, "type": "page", "webSocketDebuggerUrl": "ws://extension-options"},
                "devtools-options-target",
            )
            if port == 9411 and extension_id == "abcdefghijklmnopabcdefghijklmnop"
            else ({}, "")
        ),
    )
    monkeypatch.setattr(
        c3_batch,
        "_prepare_inactive_job_tab",
        lambda websocket, url: (
            {
                "tab_id": 77,
                "resolved_url": url,
                "active": False,
                "status": "complete",
            }
            if websocket == "ws://extension-options"
            else {}
        ),
    )
    closed = []
    monkeypatch.setattr(
        c3_batch,
        "_close_background_target",
        lambda port, target_id: closed.append((port, target_id)),
    )

    result = c3_batch._discover_target(9411, "https://job.test")

    assert result["extension_id"] == "abcdefghijklmnopabcdefghijklmnop"
    assert result["tab_id"] == 77
    assert result["url"] == "https://job.test"
    assert closed == [
        (9411, "devtools-options-target"),
        (9411, "devtools-job-target"),
    ]


def test_plan_command_writes_reproducible_submit_safe_lanes(tmp_path: Path):
    output = tmp_path / "plan.json"
    dependencies = CliDependencies(
        availability_check=lambda _job: AvailabilityResult("live", "fixture")
    )

    code = main(
        [
            "plan",
            "--csv",
            "wd_test_jobs.csv",
            "--count",
            "2",
            "--ports",
            "9901,9902",
            "--batch-id",
            "cli-test",
            "--output",
            str(output),
        ],
        dependencies=dependencies,
    )

    assert code == 0
    payload = json.loads(output.read_text(encoding="utf-8"))
    assert len(payload["lanes"]) == 2
    assert all(lane["allow_submit"] is False for lane in payload["lanes"])
    assert all(lane["allow_foreground"] is False for lane in payload["lanes"])
    assert payload["availability"][0]["status"] == "live"


def test_resume_report_reads_completed_batch_without_mutation(tmp_path: Path):
    report = tmp_path / "report.json"
    report.write_text(json.dumps({"batch_id": "b1", "lanes": []}), encoding="utf-8")

    assert main(["resume-report", "--report", str(report)]) == 0


def test_cancel_batch_uses_operation_identity_and_lease(tmp_path: Path):
    report = tmp_path / "report.json"
    report.write_text(
        json.dumps(
            {
                "batch_id": "b1",
                "lanes": [
                    {
                        "operation_id": "op-1",
                        "lease_id": "lease-1",
                        "session_id": "session-1",
                        "lane_id": "lane-1",
                        "agent_id": "agent-1",
                    }
                ],
            }
        ),
        encoding="utf-8",
    )
    client = FakeCancelClient()
    dependencies = CliDependencies(client_factory=lambda: client)

    assert (
        main(
            ["cancel-batch", "--report", str(report), "--reason", "operator_stop"],
            dependencies=dependencies,
        )
        == 0
    )
    assert client.calls == [
        {
            "operation_id": "op-1",
            "agent_id": "agent-1",
            "lease_id": "lease-1",
            "reason": "operator_stop",
        }
    ]


def test_cancel_batch_isolates_per_lane_failures_and_reports_status(tmp_path: Path, capsys):
    report = tmp_path / "report.json"
    report.write_text(
        json.dumps(
            {
                "batch_id": "b1",
                "lanes": [
                    {"operation_id": "op-1", "agent_id": "agent-1", "lease_id": "lease-1"},
                    {"operation_id": "op-2", "agent_id": "agent-2", "lease_id": "lease-2"},
                    {"operation_id": "", "agent_id": "agent-3", "lease_id": "lease-3"},
                ],
            }
        ),
        encoding="utf-8",
    )

    class PartialCancelClient(FakeCancelClient):
        def cancel_c3_operation(self, payload):
            self.calls.append(payload)
            if payload["operation_id"] == "op-1":
                raise RuntimeError("cancel_transport_failed")
            return {"status": "cancelling"}

    client = PartialCancelClient()
    code = main(
        ["cancel-batch", "--report", str(report), "--reason", "operator_stop"],
        dependencies=CliDependencies(client_factory=lambda: client),
    )
    output = json.loads(capsys.readouterr().out)

    assert code == 1
    assert [item["operation_id"] for item in client.calls] == ["op-1", "op-2"]
    assert output["ok"] is False
    assert output["cancel_requested"] == 1
    assert output["cancel_failed"] == 1
    assert output["cancel_skipped"] == 1
    assert [item["status"] for item in output["outcomes"]] == ["failed", "requested", "skipped"]


def test_run_lane_loads_exact_planned_lane_and_uses_external_artifact_root(tmp_path: Path):
    plan_path = tmp_path / "plan.json"
    report_path = tmp_path / "lane-2-report.json"
    artifact_root = tmp_path / "artifacts" / "batch-one"
    plan_dependencies = CliDependencies(
        availability_check=lambda _job: AvailabilityResult("live", "fixture")
    )
    assert (
        main(
            [
                "plan",
                "--csv",
                "wd_test_jobs.csv",
                "--count",
                "2",
                "--ports",
                "9901,9902",
                "--batch-id",
                "batch-one",
                "--artifact-root",
                str(artifact_root),
                "--output",
                str(plan_path),
            ],
            dependencies=plan_dependencies,
        )
        == 0
    )
    setup_calls = []
    supervisor = FakeSupervisor()
    dependencies = CliDependencies(
        setup_lanes=lambda batch_id, ports, logs_root: setup_calls.append(
            (batch_id, ports, logs_root)
        ),
        supervisor_factory=lambda lanes: supervisor,
    )

    assert (
        main(
            [
                "run-lane",
                "--plan",
                str(plan_path),
                "--lane-index",
                "2",
                "--report",
                str(report_path),
            ],
            dependencies=dependencies,
        )
        == 0
    )

    assert setup_calls == [("batch-one", [9902], str(artifact_root.resolve()))]
    assert len(supervisor.calls) == 1
    lanes, concurrency = supervisor.calls[0]
    assert concurrency == 1
    assert [lane.index for lane in lanes] == [2]
    assert lanes[0].job.job_id
    assert report_path.exists()


def test_injected_discovery_receives_selected_job_url_for_exact_targeting(tmp_path: Path):
    plan_path = tmp_path / "plan.json"
    report_path = tmp_path / "lane-report.json"
    assert (
        main(
            [
                "plan",
                "--csv",
                "wd_test_jobs.csv",
                "--count",
                "1",
                "--ports",
                "9906",
                "--batch-id",
                "discover-exact",
                "--output",
                str(plan_path),
            ],
            dependencies=CliDependencies(
                availability_check=lambda _job: AvailabilityResult("live", "fixture")
            ),
        )
        == 0
    )
    plan = json.loads(plan_path.read_text(encoding="utf-8"))["lanes"][0]
    discovered = []

    def discover(port, job_url):
        discovered.append((port, job_url))
        return {
            "debug_port": port,
            "extension_id": "abcdefghijklmnopabcdefghijklmnop",
            "tab_id": 417,
            "resolved_url": job_url,
        }

    class CompleteClient:
        def bootstrap_lane(self, payload):
            return {"lease_id": "lease-discover"}

        def page_walk(self, payload):
            return {"operation_id": "op-discover"}

        def wait_for_operation_event(self, payload):
            return {
                "operation": {
                    "operation_id": "op-discover",
                    "state": "completed",
                    "result": {"review_ready": True},
                },
                "events": [],
            }

        def finish_lane(self, payload):
            return {"ok": True}

        def fail_lane(self, payload):
            return {"ok": True}

        def close(self):
            return None

    assert (
        main(
            [
                "run-lane",
                "--plan",
                str(plan_path),
                "--lane-index",
                "1",
                "--report",
                str(report_path),
                "--no-setup",
            ],
            dependencies=CliDependencies(
                discover_target=discover,
                client_factory=CompleteClient,
            ),
        )
        == 0
    )

    assert discovered == [(9906, plan["job"]["url"])]


def test_run_lane_rejects_missing_lane_without_setup(tmp_path: Path):
    plan_path = tmp_path / "plan.json"
    plan_path.write_text(json.dumps({"batch_id": "batch-one", "lanes": []}), encoding="utf-8")
    setup_calls = []

    try:
        main(
            [
                "run-lane",
                "--plan",
                str(plan_path),
                "--lane-index",
                "7",
                "--report",
                str(tmp_path / "report.json"),
            ],
            dependencies=CliDependencies(setup_lanes=lambda *args: setup_calls.append(args)),
        )
    except ValueError as error:
        assert str(error) == "planned_lane_not_found:7"
    else:
        raise AssertionError("missing lane was accepted")

    assert setup_calls == []


def test_run_lane_writes_atomic_planned_checkpoint_before_supervisor_failure(tmp_path: Path):
    plan_path = tmp_path / "plan.json"
    report_path = tmp_path / "running.json"
    dependencies = CliDependencies(
        availability_check=lambda _job: AvailabilityResult("live", "fixture")
    )
    assert (
        main(
            [
                "plan",
                "--csv",
                "wd_test_jobs.csv",
                "--count",
                "1",
                "--ports",
                "9903",
                "--batch-id",
                "checkpoint-cli",
                "--artifact-root",
                str(tmp_path / "artifacts"),
                "--output",
                str(plan_path),
            ],
            dependencies=dependencies,
        )
        == 0
    )

    class CrashingSupervisor:
        def run(self, lanes, *, max_concurrency):
            raise RuntimeError("injected_supervisor_crash")

    try:
        main(
            [
                "run-lane",
                "--plan",
                str(plan_path),
                "--lane-index",
                "1",
                "--report",
                str(report_path),
                "--no-setup",
            ],
            dependencies=CliDependencies(supervisor_factory=lambda _lanes: CrashingSupervisor()),
        )
    except RuntimeError as error:
        assert str(error) == "injected_supervisor_crash"
    else:
        raise AssertionError("supervisor failure was swallowed")

    checkpoint = json.loads(report_path.read_text(encoding="utf-8"))
    assert checkpoint["status"] == "running"
    assert checkpoint["lanes"][0]["stage"] == "planned"
    assert checkpoint["lanes"][0]["plan"]["session_id"]


def test_run_lane_keeps_nonterminal_result_as_resumable_checkpoint(tmp_path: Path):
    plan_path = tmp_path / "plan.json"
    report_path = tmp_path / "pending.json"
    assert (
        main(
            [
                "plan",
                "--csv",
                "wd_test_jobs.csv",
                "--count",
                "1",
                "--ports",
                "9905",
                "--batch-id",
                "pending-cli",
                "--output",
                str(plan_path),
            ],
            dependencies=CliDependencies(
                availability_check=lambda _job: AvailabilityResult("live", "fixture")
            ),
        )
        == 0
    )

    class PendingSupervisor:
        def run(self, lanes, *, max_concurrency):
            lane = list(lanes)[0]
            return BatchReport(
                batch_id=lane.batch_id,
                lanes=(
                    LaneResult(
                        agent_id=lane.agent_id,
                        lane_id=lane.lane_id,
                        session_id=lane.session_id,
                        operation_id="op-pending",
                        job_url=lane.job.url,
                        classification="cancellation_pending",
                        operation_state="cancelling",
                        terminal_reason="cancel_pending",
                        lease_id="lease-pending",
                        command_id="cmd-pending",
                        trace_id="trace-pending",
                        cancel_requested=True,
                    ),
                ),
                started_at=utc_now(),
                completed_at=utc_now(),
            )

    assert (
        main(
            [
                "run-lane",
                "--plan",
                str(plan_path),
                "--lane-index",
                "1",
                "--report",
                str(report_path),
                "--no-setup",
            ],
            dependencies=CliDependencies(supervisor_factory=lambda _lanes: PendingSupervisor()),
        )
        == 0
    )

    checkpoint = json.loads(report_path.read_text(encoding="utf-8"))
    assert checkpoint["status"] == "running"
    assert checkpoint["lanes"][0]["stage"] == "cancel_pending"
    assert checkpoint["lanes"][0]["operation_id"] == "op-pending"
    assert checkpoint["lanes"][0]["lease_id"] == "lease-pending"
    assert checkpoint["lanes"][0]["result"]["failure_context_status"] == "unavailable_nonterminal"
    assert (
        checkpoint["lanes"][0]["result"]["failure_context_error"]
        == "cancellation_reconciliation_deadline_exceeded"
    )
    assert checkpoint["lanes"][0]["plan"]["session_id"].startswith("session_")


def test_resume_report_keeps_checkpoint_operation_diagnostics_while_cancel_is_pending(
    tmp_path: Path,
):
    plan_path = tmp_path / "plan.json"
    report_path = tmp_path / "pending-resume.json"
    assert (
        main(
            [
                "plan",
                "--csv",
                "wd_test_jobs.csv",
                "--count",
                "1",
                "--ports",
                "9907",
                "--batch-id",
                "pending-resume-cli",
                "--output",
                str(plan_path),
            ],
            dependencies=CliDependencies(
                availability_check=lambda _job: AvailabilityResult("live", "fixture")
            ),
        )
        == 0
    )
    plan = json.loads(plan_path.read_text(encoding="utf-8"))["lanes"][0]
    target = {
        "debug_port": plan["port"],
        "extension_id": "abcdefghijklmnopabcdefghijklmnop",
        "tab_id": 417,
        "url": plan["job"]["url"],
    }
    report_path.write_text(
        json.dumps(
            {
                "version": 2,
                "batch_id": plan["batch_id"],
                "status": "running",
                "lanes": [
                    {
                        "stage": "cancel_pending",
                        "plan": plan,
                        "lease_id": "lease-pending",
                        "operation_id": "op-pending",
                        "browser_target_id": plan["browser_target_id"],
                        "target": target,
                        "after_seq": 9,
                        "event_ids": ["evt-diagnostic"],
                        "operation": {
                            "state": "cancelling",
                            "terminal_reason": "cancel_pending",
                            "error": {"reason_code": "field_driver_timeout"},
                        },
                    }
                ],
            }
        ),
        encoding="utf-8",
    )

    class PendingResumeSupervisor:
        def run(self, lanes, *, max_concurrency, resume_states=None):
            lane = list(lanes)[0]
            return BatchReport(
                batch_id=lane.batch_id,
                lanes=(
                    LaneResult(
                        agent_id=lane.agent_id,
                        lane_id=lane.lane_id,
                        session_id=lane.session_id,
                        operation_id="op-pending",
                        job_url=lane.job.url,
                        classification="cancellation_pending",
                        operation_state="cancelling",
                        terminal_reason="cancel_pending",
                        lease_id="lease-pending",
                        artifact_dir=lane.artifact_dir,
                        event_ids=("evt-diagnostic",),
                        cancel_requested=True,
                    ),
                ),
                started_at=utc_now(),
                completed_at=utc_now(),
            )

    assert (
        main(
            ["resume-report", "--report", str(report_path)],
            dependencies=CliDependencies(
                supervisor_factory=lambda _lanes: PendingResumeSupervisor()
            ),
        )
        == 0
    )

    checkpoint = json.loads(report_path.read_text(encoding="utf-8"))
    record = checkpoint["lanes"][0]
    assert record["after_seq"] == 9
    assert record["operation"]["error"]["reason_code"] == "field_driver_timeout"


def test_resume_report_supervises_existing_operation_without_bootstrap(tmp_path: Path):
    plan_dependencies = CliDependencies(
        availability_check=lambda _job: AvailabilityResult("live", "fixture")
    )
    plan_path = tmp_path / "plan.json"
    assert (
        main(
            [
                "plan",
                "--csv",
                "wd_test_jobs.csv",
                "--count",
                "1",
                "--ports",
                "9904",
                "--batch-id",
                "resume-cli",
                "--output",
                str(plan_path),
            ],
            dependencies=plan_dependencies,
        )
        == 0
    )
    lane = json.loads(plan_path.read_text(encoding="utf-8"))["lanes"][0]
    report_path = tmp_path / "resume.json"
    report_path.write_text(
        json.dumps(
            {
                "version": 2,
                "batch_id": "resume-cli",
                "status": "running",
                "lanes": [
                    {
                        "stage": "operation_started",
                        "plan": lane,
                        "lease_id": "lease-resume",
                        "operation_id": "op-resume",
                        "command_id": "cmd-resume",
                        "trace_id": "trace-resume",
                    }
                ],
            }
        ),
        encoding="utf-8",
    )

    class ResumeSupervisor:
        def __init__(self):
            self.resume_states = None

        def run(self, lanes, *, max_concurrency, resume_states=None):
            self.resume_states = resume_states
            lane_list = list(lanes)
            return FakeReport(lanes=[{"lane_id": lane_list[0].lane_id}])

    supervisor = ResumeSupervisor()
    code = main(
        ["resume-report", "--report", str(report_path)],
        dependencies=CliDependencies(supervisor_factory=lambda _lanes: supervisor),
    )

    assert code == 0
    assert supervisor.resume_states["session_resume-cli_9904"]["operation_id"] == "op-resume"


def test_resume_report_runs_only_incomplete_lanes_and_preserves_completed_results(
    tmp_path: Path,
):
    plan_path = tmp_path / "plan.json"
    assert (
        main(
            [
                "plan",
                "--csv",
                "wd_test_jobs.csv",
                "--count",
                "2",
                "--ports",
                "9911,9912",
                "--batch-id",
                "resume-mixed",
                "--output",
                str(plan_path),
            ],
            dependencies=CliDependencies(
                availability_check=lambda _job: AvailabilityResult("live", "fixture")
            ),
        )
        == 0
    )
    plans = json.loads(plan_path.read_text(encoding="utf-8"))["lanes"]
    completed_result = LaneResult(
        agent_id=plans[0]["agent_id"],
        lane_id=plans[0]["lane_id"],
        session_id=plans[0]["session_id"],
        operation_id="op-complete",
        job_url=plans[0]["job"]["url"],
        classification="review_ready",
        operation_state="completed",
        terminal_reason="bridge_completed",
        lease_id="lease-complete",
        artifact_dir=plans[0]["artifact_dir"],
    )
    report_path = tmp_path / "mixed-running.json"
    report_path.write_text(
        json.dumps(
            {
                "version": 2,
                "batch_id": "resume-mixed",
                "status": "running",
                "started_at": utc_now(),
                "lanes": [
                    {
                        "stage": "complete",
                        "plan": plans[0],
                        "result": asdict(completed_result),
                    },
                    {
                        "stage": "operation_started",
                        "plan": plans[1],
                        "lease_id": "lease-resume",
                        "operation_id": "op-resume",
                    },
                ],
            }
        ),
        encoding="utf-8",
    )

    class MixedResumeSupervisor:
        def __init__(self):
            self.lanes = []
            self.resume_states = {}

        def run(self, lanes, *, max_concurrency, resume_states=None):
            self.lanes = list(lanes)
            self.resume_states = dict(resume_states or {})
            resumed = self.lanes[0]
            return BatchReport(
                batch_id=resumed.batch_id,
                lanes=(
                    LaneResult(
                        agent_id=resumed.agent_id,
                        lane_id=resumed.lane_id,
                        session_id=resumed.session_id,
                        operation_id="op-resume",
                        job_url=resumed.job.url,
                        classification="review_ready",
                        operation_state="completed",
                        terminal_reason="bridge_completed",
                        lease_id="lease-resume",
                    ),
                ),
                started_at=utc_now(),
                completed_at=utc_now(),
            )

    supervisor = MixedResumeSupervisor()
    assert (
        main(
            ["resume-report", "--report", str(report_path)],
            dependencies=CliDependencies(supervisor_factory=lambda _lanes: supervisor),
        )
        == 0
    )

    assert [lane.session_id for lane in supervisor.lanes] == [plans[1]["session_id"]]
    assert set(supervisor.resume_states) == {plans[1]["session_id"]}
    final = json.loads(report_path.read_text(encoding="utf-8"))
    assert [lane["operation_id"] for lane in final["lanes"]] == [
        "op-complete",
        "op-resume",
    ]


def test_resume_report_finalizes_running_checkpoint_when_all_lanes_are_complete(
    tmp_path: Path,
):
    plan_path = tmp_path / "plan.json"
    assert (
        main(
            [
                "plan",
                "--csv",
                "wd_test_jobs.csv",
                "--count",
                "1",
                "--ports",
                "9913",
                "--batch-id",
                "resume-finalize",
                "--output",
                str(plan_path),
            ],
            dependencies=CliDependencies(
                availability_check=lambda _job: AvailabilityResult("live", "fixture")
            ),
        )
        == 0
    )
    plan = json.loads(plan_path.read_text(encoding="utf-8"))["lanes"][0]
    result = LaneResult(
        agent_id=plan["agent_id"],
        lane_id=plan["lane_id"],
        session_id=plan["session_id"],
        operation_id="op-complete",
        job_url=plan["job"]["url"],
        classification="review_ready",
        operation_state="completed",
        terminal_reason="bridge_completed",
        lease_id="lease-complete",
        artifact_dir=plan["artifact_dir"],
    )
    report_path = tmp_path / "all-complete-running.json"
    started_at = utc_now()
    report_path.write_text(
        json.dumps(
            {
                "version": 2,
                "batch_id": "resume-finalize",
                "status": "running",
                "started_at": started_at,
                "lanes": [{"stage": "complete", "plan": plan, "result": asdict(result)}],
            }
        ),
        encoding="utf-8",
    )

    assert main(["resume-report", "--report", str(report_path)]) == 0

    final = json.loads(report_path.read_text(encoding="utf-8"))
    assert "status" not in final
    assert final["batch_id"] == "resume-finalize"
    assert final["started_at"] == started_at
    assert final["lanes"][0]["operation_id"] == "op-complete"


def test_resume_report_refreshes_completed_failure_evidence_without_resending_terminal_lane(
    tmp_path: Path,
):
    plan_path = tmp_path / "plan.json"
    main(
        [
            "plan",
            "--csv",
            "wd_test_jobs.csv",
            "--count",
            "1",
            "--ports",
            "9914",
            "--batch-id",
            "resume-refresh-complete",
            "--output",
            str(plan_path),
        ],
        dependencies=CliDependencies(
            availability_check=lambda _job: AvailabilityResult("live", "fixture")
        ),
    )
    plan = json.loads(plan_path.read_text(encoding="utf-8"))["lanes"][0]
    stale = LaneResult(
        agent_id=plan["agent_id"],
        lane_id=plan["lane_id"],
        session_id=plan["session_id"],
        operation_id="op-refresh",
        job_url=plan["job"]["url"],
        classification="fill_failed",
        operation_state="failed",
        terminal_reason="extension_command_failed",
        lease_id="lease-refresh",
        artifact_dir=plan["artifact_dir"],
        failure_artifact_status="capturing",
    )
    report_path = tmp_path / "refresh-complete.json"
    report_path.write_text(
        json.dumps(
            {
                "version": 2,
                "batch_id": "resume-refresh-complete",
                "status": "running",
                "lanes": [{"stage": "complete", "plan": plan, "result": asdict(stale)}],
            }
        ),
        encoding="utf-8",
    )
    calls = []

    class RefreshClient:
        def get_c3_operation(self, payload):
            calls.append(("get", dict(payload)))
            return {
                "operation": {
                    "operation_id": "op-refresh",
                    "state": "failed",
                    "artifact_ids": ["artifact-late"],
                    "terminal_reason": "extension_command_failed",
                }
            }

        def get_c3_failure_context(self, payload):
            calls.append(("context", dict(payload)))
            return {
                "failure_context": {
                    "operation_id": "op-refresh",
                    "diagnosis_id": "diagnosis-refresh",
                    "root_cause_code": "ui_commit_failed",
                    "artifact_status": "completed",
                    "artifact_ids": ["artifact-late"],
                    "root_cause_unknown": False,
                }
            }

        def close(self):
            calls.append(("close", {}))

    assert (
        main(
            ["resume-report", "--report", str(report_path)],
            dependencies=CliDependencies(client_factory=RefreshClient),
        )
        == 0
    )

    refreshed = json.loads(report_path.read_text(encoding="utf-8"))["lanes"][0]
    assert refreshed["failure_artifact_status"] == "completed"
    assert refreshed["failure_artifact_ids"] == ["artifact-late"]
    assert refreshed["artifact_ids"] == ["artifact-late"]
    assert [name for name, _payload in calls] == ["get", "context", "close"]


def test_resume_report_records_refresh_error_without_erasing_original_failure_context(
    tmp_path: Path,
):
    plan_path = tmp_path / "plan.json"
    main(
        [
            "plan",
            "--csv",
            "wd_test_jobs.csv",
            "--count",
            "1",
            "--ports",
            "9915",
            "--batch-id",
            "resume-refresh-error",
            "--output",
            str(plan_path),
        ],
        dependencies=CliDependencies(
            availability_check=lambda _job: AvailabilityResult("live", "fixture")
        ),
    )
    plan = json.loads(plan_path.read_text(encoding="utf-8"))["lanes"][0]
    original = LaneResult(
        agent_id=plan["agent_id"],
        lane_id=plan["lane_id"],
        session_id=plan["session_id"],
        operation_id="op-refresh-error",
        job_url=plan["job"]["url"],
        classification="fill_failed",
        operation_state="failed",
        terminal_reason="extension_command_failed",
        lease_id="lease-refresh-error",
        artifact_dir=plan["artifact_dir"],
        failure_context_status="available",
        diagnosis_id="diagnosis-original",
        root_cause_code="ui_commit_failed",
        failure_summary="Original retained diagnosis",
    )
    report_path = tmp_path / "refresh-error.json"
    report_path.write_text(
        json.dumps(
            {
                "version": 2,
                "batch_id": "resume-refresh-error",
                "status": "running",
                "lanes": [{"stage": "complete", "plan": plan, "result": asdict(original)}],
            }
        ),
        encoding="utf-8",
    )

    class RefreshErrorClient:
        def get_c3_operation(self, _payload):
            return {"operation": {"state": "failed"}}

        def get_c3_failure_context(self, _payload):
            raise RuntimeError("refresh transport failed")

        def close(self):
            return None

    assert (
        main(
            ["resume-report", "--report", str(report_path)],
            dependencies=CliDependencies(client_factory=RefreshErrorClient),
        )
        == 0
    )

    refreshed = json.loads(report_path.read_text(encoding="utf-8"))["lanes"][0]
    assert refreshed["diagnosis_id"] == "diagnosis-original"
    assert refreshed["root_cause_code"] == "ui_commit_failed"
    assert refreshed["failure_summary"] == "Original retained diagnosis"
    assert refreshed["failure_context_status"] == "available"
    assert refreshed["failure_context_refresh_status"] == "error"
    assert refreshed["failure_context_refresh_error"] == "RuntimeError"


def test_resume_report_records_operation_refresh_error_without_erasing_projection(
    tmp_path: Path,
):
    plan_path = tmp_path / "plan.json"
    main(
        [
            "plan",
            "--csv",
            "wd_test_jobs.csv",
            "--count",
            "1",
            "--ports",
            "9916",
            "--batch-id",
            "resume-operation-refresh-error",
            "--output",
            str(plan_path),
        ],
        dependencies=CliDependencies(
            availability_check=lambda _job: AvailabilityResult("live", "fixture")
        ),
    )
    plan = json.loads(plan_path.read_text(encoding="utf-8"))["lanes"][0]
    original = LaneResult(
        agent_id=plan["agent_id"],
        lane_id=plan["lane_id"],
        session_id=plan["session_id"],
        operation_id="op-stale",
        job_url=plan["job"]["url"],
        classification="fill_failed",
        operation_state="failed",
        terminal_reason="original-terminal",
        lease_id="lease-stale",
        artifact_dir=plan["artifact_dir"],
    )
    report_path = tmp_path / "operation-refresh-error.json"
    report_path.write_text(
        json.dumps(
            {
                "version": 2,
                "batch_id": "resume-operation-refresh-error",
                "status": "running",
                "lanes": [{"stage": "complete", "plan": plan, "result": asdict(original)}],
            }
        ),
        encoding="utf-8",
    )

    class OperationRefreshErrorClient:
        def get_c3_operation(self, _payload):
            raise TimeoutError("operation refresh timed out")

        def get_c3_failure_context(self, _payload):
            return {"failure_context": {"operation_id": "op-stale", "root_cause_code": "known"}}

        def close(self):
            return None

    assert (
        main(
            ["resume-report", "--report", str(report_path)],
            dependencies=CliDependencies(client_factory=OperationRefreshErrorClient),
        )
        == 0
    )

    refreshed = json.loads(report_path.read_text(encoding="utf-8"))["lanes"][0]
    assert refreshed["operation_state"] == "failed"
    assert refreshed["terminal_reason"] == "original-terminal"
    assert refreshed["operation_refresh_status"] == "error"
    assert refreshed["operation_refresh_error"] == "TimeoutError"


def test_resume_report_rejects_completed_result_with_foreign_plan_identity(tmp_path: Path):
    plan_path = tmp_path / "plan.json"
    assert (
        main(
            [
                "plan",
                "--csv",
                "wd_test_jobs.csv",
                "--count",
                "1",
                "--ports",
                "9914",
                "--batch-id",
                "resume-foreign-result",
                "--output",
                str(plan_path),
            ],
            dependencies=CliDependencies(
                availability_check=lambda _job: AvailabilityResult("live", "fixture")
            ),
        )
        == 0
    )
    plan = json.loads(plan_path.read_text(encoding="utf-8"))["lanes"][0]
    foreign = LaneResult(
        agent_id="agent-foreign",
        lane_id=plan["lane_id"],
        session_id=plan["session_id"],
        operation_id="op-foreign",
        job_url=plan["job"]["url"],
        classification="review_ready",
        operation_state="completed",
        terminal_reason="bridge_completed",
        lease_id="lease-foreign",
        artifact_dir=plan["artifact_dir"],
    )
    report_path = tmp_path / "foreign-result.json"
    report_path.write_text(
        json.dumps(
            {
                "version": 2,
                "batch_id": "resume-foreign-result",
                "status": "running",
                "lanes": [{"stage": "complete", "plan": plan, "result": asdict(foreign)}],
            }
        ),
        encoding="utf-8",
    )

    with pytest.raises(ValueError, match="completed_checkpoint_identity_mismatch"):
        main(["resume-report", "--report", str(report_path)])


def test_prepare_inactive_job_tab_returns_exact_resolved_target_without_ui_activation():
    evaluated = []

    def evaluate(websocket_url: str, expression: str):
        evaluated.append((websocket_url, expression))
        return {
            "tab_id": 417,
            "target_id": "target-job-417",
            "resolved_url": "https://example.wd5.myworkdayjobs.com/en-US/job/redirected/apply",
            "active": False,
            "status": "complete",
        }

    result = _prepare_inactive_job_tab(
        "ws://127.0.0.1:9911/devtools/page/extension",
        "https://example.wd5.myworkdayjobs.com/job/original",
        evaluate=evaluate,
    )

    assert result["tab_id"] == 417
    assert result["target_id"] == "target-job-417"
    assert result["resolved_url"].endswith("/redirected/apply")
    expression = evaluated[0][1]
    assert "chrome.tabs.create({ url: wanted, active: false })" in expression
    assert "chrome.debugger.getTargets()" in expression
    assert "chrome.tabs.remove(tab.id)" in expression
    assert "chrome.tabs.update" not in expression
    assert "chrome.windows.update" not in expression
    assert "Page.bringToFront" not in expression


def test_discovery_closes_wake_target_when_extension_never_appears(monkeypatch):
    monkeypatch.setattr(c3_batch, "_read_devtools_targets", lambda _port: [])
    monkeypatch.setattr(c3_batch, "_create_background_target", lambda _port, _url: "wake-1")
    monkeypatch.setattr(c3_batch, "_wait_for_c3_target", lambda _port: None)
    closed: list[tuple[int, str]] = []
    monkeypatch.setattr(
        c3_batch,
        "_close_background_target",
        lambda port, target_id: closed.append((port, target_id)),
    )

    with pytest.raises(RuntimeError, match="c3_extension_target_missing"):
        c3_batch._discover_target(9412, "https://job.test")

    assert closed == [(9412, "wake-1")]


def test_discovery_closes_wake_target_when_extension_poll_raises(monkeypatch):
    monkeypatch.setattr(c3_batch, "_read_devtools_targets", lambda _port: [])
    monkeypatch.setattr(c3_batch, "_create_background_target", lambda _port, _url: "wake-2")
    monkeypatch.setattr(
        c3_batch,
        "_wait_for_c3_target",
        lambda _port: (_ for _ in ()).throw(RuntimeError("cdp poll failed")),
    )
    closed: list[tuple[int, str]] = []
    monkeypatch.setattr(
        c3_batch,
        "_close_background_target",
        lambda port, target_id: closed.append((port, target_id)),
    )

    with pytest.raises(RuntimeError, match="cdp poll failed"):
        c3_batch._discover_target(9413, "https://job.test")

    assert closed == [(9413, "wake-2")]


def test_extension_page_discovery_closes_created_target_when_target_list_raises(monkeypatch):
    monkeypatch.setattr(c3_batch, "_create_background_target", lambda _port, _url: "options-1")
    monkeypatch.setattr(
        c3_batch,
        "_read_devtools_targets",
        lambda _port: (_ for _ in ()).throw(RuntimeError("target list failed")),
    )
    closed: list[tuple[int, str]] = []
    monkeypatch.setattr(
        c3_batch,
        "_close_background_target",
        lambda port, target_id: closed.append((port, target_id)),
    )

    with pytest.raises(RuntimeError, match="target list failed"):
        c3_batch._ensure_extension_page_target(
            9414,
            "abcdefghijklmnopabcdefghijklmnop",
            {
                "type": "service_worker",
                "url": "chrome-extension://abcdefghijklmnopabcdefghijklmnop/background.js",
            },
        )

    assert closed == [(9414, "options-1")]


def test_prepare_inactive_job_tab_rejects_unexpected_active_target():
    expressions = []

    def evaluate(_url, expression):
        expressions.append(expression)
        if len(expressions) == 1:
            return {
                "tab_id": 417,
                "resolved_url": "https://example.wd5.myworkdayjobs.com/job/original",
                "active": True,
                "status": "complete",
            }
        return True

    with pytest.raises(RuntimeError, match="prepared_job_tab_became_active"):
        _prepare_inactive_job_tab(
            "ws://127.0.0.1:9911/devtools/page/extension",
            "https://example.wd5.myworkdayjobs.com/job/original",
            evaluate=evaluate,
        )

    assert len(expressions) == 2
    assert "chrome.tabs.remove(417)" in expressions[1]


def test_prepare_inactive_job_tab_rejects_target_that_never_finishes_loading():
    with pytest.raises(RuntimeError, match="prepared_job_tab_not_complete"):
        _prepare_inactive_job_tab(
            "ws://127.0.0.1:9911/devtools/page/extension",
            "https://example.wd5.myworkdayjobs.com/job/original",
            evaluate=lambda _url, _expression: {
                "tab_id": 417,
                "resolved_url": "https://example.wd5.myworkdayjobs.com/job/original",
                "active": False,
                "status": "loading",
            },
        )


def test_prepare_inactive_job_tab_requires_observed_resolved_url():
    with pytest.raises(RuntimeError, match="prepared_job_tab_resolved_url_required"):
        _prepare_inactive_job_tab(
            "ws://127.0.0.1:9911/devtools/page/extension",
            "https://example.wd5.myworkdayjobs.com/job/original",
            evaluate=lambda _url, _expression: {
                "tab_id": 417,
                "resolved_url": "",
                "active": False,
                "status": "complete",
            },
        )


def test_prepare_inactive_job_tab_rejects_about_blank_as_resolved_target():
    with pytest.raises(RuntimeError, match="prepared_job_tab_resolved_url_required"):
        _prepare_inactive_job_tab(
            "ws://127.0.0.1:9911/devtools/page/extension",
            "https://example.wd5.myworkdayjobs.com/job/original",
            evaluate=lambda _url, _expression: {
                "tab_id": 417,
                "resolved_url": "about:blank",
                "active": False,
                "status": "complete",
            },
        )


def test_prepare_inactive_job_tab_rejects_browser_error_page():
    with pytest.raises(RuntimeError, match="prepared_job_tab_resolved_url_required"):
        _prepare_inactive_job_tab(
            "ws://127.0.0.1:9911/devtools/page/extension",
            "https://example.wd5.myworkdayjobs.com/job/original",
            evaluate=lambda _url, _expression: {
                "tab_id": 417,
                "resolved_url": "chrome-error://chromewebdata/",
                "active": False,
                "status": "complete",
            },
        )
