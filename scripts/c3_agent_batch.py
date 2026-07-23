#!/usr/bin/env python3
from __future__ import annotations

import argparse
import importlib.util
import json
import subprocess
import sys
import threading
import time
from dataclasses import asdict, dataclass, fields, replace
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit
from urllib.request import urlopen

REPO_ROOT = Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from scripts.reload_c3_extension import (  # noqa: E402
    _open_devtools_websocket,
    _recv_ws_text,
    _send_ws_text,
    find_c3_target,
)
from tools.c3_agent_testing.availability import (  # noqa: E402
    check_workday_job,
)
from tools.c3_agent_testing.planner import (  # noqa: E402
    JobCandidate,
    LanePlan,
    discover_live_replacements,
    plan_lanes,
    read_job_csv,
    select_live_jobs,
)
from tools.c3_agent_testing.report import BatchReport, LaneResult, utc_now  # noqa: E402
from tools.c3_agent_testing.runner import (  # noqa: E402
    C3BatchSupervisor,
    _artifact_paths,
    _failure_context_fields,
    _failure_context_projection,
    _operation_projection,
    _string_tuple,
)


@dataclass
class CliDependencies:
    availability_check: Any = check_workday_job
    browser_check: Any = None
    client_factory: Any = None
    setup_lanes: Any = None
    discover_target: Any = None
    prepare_lane: Any = None
    supervisor_factory: Any = None


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Plan and supervise isolated C3 agent tests.")
    subparsers = parser.add_subparsers(dest="command", required=True)

    plan = subparsers.add_parser("plan")
    _add_plan_arguments(plan)
    plan.add_argument("--output", required=True)

    run = subparsers.add_parser("run")
    _add_plan_arguments(run)
    run.add_argument("--report", required=True)
    run.add_argument("--max-concurrency", type=int, default=5)
    run.add_argument("--no-setup", action="store_true")

    run_lane = subparsers.add_parser(
        "run-lane", help="Run exactly one lane from an existing immutable plan."
    )
    run_lane.add_argument("--plan", required=True)
    run_lane.add_argument("--lane-index", type=int, required=True)
    run_lane.add_argument("--report", required=True)
    run_lane.add_argument("--no-setup", action="store_true")

    resume = subparsers.add_parser("resume-report")
    resume.add_argument("--report", required=True)

    cancel = subparsers.add_parser("cancel-batch")
    cancel.add_argument("--report", required=True)
    cancel.add_argument("--reason", required=True)
    return parser


def main(argv: list[str] | None = None, *, dependencies: CliDependencies | None = None) -> int:
    args = build_parser().parse_args(argv)
    deps = dependencies or CliDependencies()
    if args.command == "resume-report":
        payload = _read_json(Path(args.report))
        active = [
            item
            for item in payload.get("lanes", [])
            if isinstance(item, dict) and item.get("stage") != "complete"
        ]
        if payload.get("status") == "running" and not active:
            completed = _completed_checkpoint_report(payload)
            completed = _refresh_completed_report(
                completed, deps.client_factory or _default_client_factory
            )
            completed.write_json(args.report)
            print(json.dumps({"ok": True, "report": str(Path(args.report).resolve())}))
            return 0
        if payload.get("status") != "running":
            print(json.dumps(payload, indent=2, sort_keys=True))
            return 0
        lanes = [_lane_from_dict(item["plan"]) for item in active]
        resume_states = {lane.session_id: item for lane, item in zip(lanes, active, strict=True)}
        args.no_setup = True
        return _run_lanes(
            args,
            deps,
            lanes,
            max_concurrency=min(len(lanes), 6),
            resume_states=resume_states,
            existing_checkpoint=payload,
        )
    if args.command == "cancel-batch":
        return _cancel_batch(args, deps)

    if args.command == "run-lane":
        plan_payload = _read_json(Path(args.plan))
        lanes = [
            _lane_from_dict(item)
            for item in plan_payload.get("lanes", [])
            if isinstance(item, dict) and int(item.get("index") or 0) == args.lane_index
        ]
        if len(lanes) != 1:
            raise ValueError(f"planned_lane_not_found:{args.lane_index}")
        return _run_lanes(args, deps, lanes, max_concurrency=1)

    plan_payload, lanes = _build_plan(args, deps)
    if args.command == "plan":
        _atomic_json(Path(args.output), plan_payload)
        print(json.dumps({"ok": True, "output": str(Path(args.output).resolve())}))
        return 0

    return _run_lanes(args, deps, lanes, max_concurrency=args.max_concurrency)


def _run_lanes(
    args: Any,
    deps: CliDependencies,
    lanes: list[LanePlan],
    *,
    max_concurrency: int,
    resume_states: dict[str, dict[str, Any]] | None = None,
    existing_checkpoint: dict[str, Any] | None = None,
) -> int:
    checkpoint = _BatchCheckpoint(
        Path(args.report),
        lanes,
        existing=existing_checkpoint,
    )
    checkpoint.write()
    if not args.no_setup:
        setup = deps.setup_lanes or _setup_lanes
        setup(
            lanes[0].batch_id,
            [lane.port for lane in lanes],
            str(_lane_artifact_root(lanes)),
        )
    discover = deps.discover_target or _discover_target
    if deps.prepare_lane is not None:
        prepare_lane = deps.prepare_lane
    elif deps.discover_target is not None:

        def prepare_lane(lane: LanePlan) -> dict[str, Any]:
            return discover(lane.port, lane.job.url)

    else:

        def prepare_lane(lane: LanePlan) -> dict[str, Any]:
            return discover(lane.port, lane.job.url)

    client_factory = deps.client_factory or _default_client_factory
    if deps.supervisor_factory:
        supervisor = deps.supervisor_factory(lanes)
    else:
        supervisor = C3BatchSupervisor(
            client_factory=client_factory,
            prepare_lane=prepare_lane,
            checkpoint=checkpoint.update,
        )
    if resume_states is None:
        report = supervisor.run(lanes, max_concurrency=max_concurrency)
    else:
        report = supervisor.run(
            lanes,
            max_concurrency=max_concurrency,
            resume_states=resume_states,
        )
    report = _merge_completed_checkpoint_results(report, existing_checkpoint)
    if isinstance(report, BatchReport) and all(
        result.operation_state in {"completed", "failed", "cancelled", "orphaned"}
        for result in report.lanes
    ):
        # Artifact capture can finish just after the supervisor observes the
        # terminal event. Refresh every completed run, not only resume-report,
        # so the first report includes late artifact and diagnosis evidence.
        report = _refresh_completed_report(report, deps.client_factory or _default_client_factory)
    if not isinstance(report, BatchReport):
        report.write_json(args.report)
        print(json.dumps({"ok": True, "report": str(Path(args.report).resolve())}))
        return 0
    report = _normalize_nonterminal_diagnostics(report)
    current_lanes = {lane.session_id: lane for lane in lanes}
    pending_results = [
        result
        for result in report.lanes
        if result.operation_state not in {"completed", "failed", "cancelled", "orphaned"}
    ]
    if pending_results:
        for result in report.lanes:
            lane = current_lanes.get(result.session_id)
            if lane is not None:
                terminal = result.operation_state in {
                    "completed",
                    "failed",
                    "cancelled",
                    "orphaned",
                }
                checkpoint.update(
                    lane,
                    {
                        "stage": (
                            "complete"
                            if terminal
                            else (
                                "cancel_pending"
                                if result.classification == "cancellation_pending"
                                else "monitoring"
                            )
                        ),
                        "lease_id": result.lease_id,
                        "operation_id": result.operation_id,
                        "command_id": result.command_id,
                        "trace_id": result.trace_id,
                        "event_ids": list(result.event_ids),
                        "artifact_dir": result.artifact_dir,
                        "result": asdict(result),
                    },
                )
        print(json.dumps({"ok": True, "report": str(Path(args.report).resolve())}))
        return 0
    report.write_json(args.report)
    print(json.dumps({"ok": True, "report": str(Path(args.report).resolve())}))
    return 0


def _normalize_nonterminal_diagnostics(report: BatchReport) -> BatchReport:
    """Fail closed when a supervisor yields an unresolved operation projection."""
    terminal_states = {"completed", "failed", "cancelled", "orphaned"}
    normalized: list[LaneResult] = []
    changed = False
    for result in report.lanes:
        if result.operation_state in terminal_states:
            normalized.append(result)
            continue
        status = result.failure_context_status
        error = result.failure_context_error
        if status in {"", "not_requested"}:
            status = "unavailable_nonterminal"
        if not error:
            error = (
                "cancellation_reconciliation_deadline_exceeded"
                if result.cancel_requested or result.classification == "cancellation_pending"
                else "operation_terminal_reconciliation_unavailable"
            )
        replacement = replace(
            result,
            failure_context_status=status,
            failure_context_error=error,
        )
        changed = changed or replacement != result
        normalized.append(replacement)
    return replace(report, lanes=tuple(normalized)) if changed else report


def _add_plan_arguments(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--csv", required=True)
    parser.add_argument("--count", type=int, required=True)
    parser.add_argument("--ports", required=True)
    parser.add_argument("--batch-id", required=True)
    parser.add_argument("--artifact-root", default="")
    parser.add_argument("--deadline-seconds", type=int, default=120)


def _build_plan(args: Any, deps: CliDependencies) -> tuple[dict[str, Any], list[Any]]:
    if not 1 <= args.count <= 6:
        raise ValueError("count_must_be_between_1_and_6")
    ports = _ports(args.ports)
    if len(ports) < args.count:
        raise ValueError("not_enough_ports")
    jobs = read_job_csv(args.csv)
    selected, decisions = select_live_jobs(
        jobs,
        count=args.count,
        check=deps.availability_check,
        browser_check=deps.browser_check,
    )
    if len(selected) < args.count:
        replacements = discover_live_replacements(
            jobs,
            count=args.count - len(selected),
            exclude_urls=[job.canonical_url for job in selected],
            check=deps.availability_check,
            browser_check=deps.browser_check,
            decisions=decisions,
        )
        selected.extend(replacements)
    if len(selected) < args.count:
        raise RuntimeError(f"only_{len(selected)}_live_jobs_found")
    artifact_root = args.artifact_root or str(Path("logs") / args.batch_id)
    lanes = plan_lanes(
        selected,
        batch_id=args.batch_id,
        ports=ports,
        artifact_root=artifact_root,
        deadline_seconds=args.deadline_seconds,
    )
    return (
        {
            "version": 1,
            "batch_id": args.batch_id,
            "source_csv": str(Path(args.csv).resolve()),
            "allow_submit": False,
            "allow_foreground": False,
            "availability": [
                {
                    "row_number": item.job.row_number,
                    "job_id": item.job.job_id,
                    "status": item.status,
                    "reason": item.reason,
                }
                for item in decisions
            ],
            "lanes": [asdict(lane) for lane in lanes],
        },
        lanes,
    )


def _cancel_batch(args: Any, deps: CliDependencies) -> int:
    payload = _read_json(Path(args.report))
    client = (deps.client_factory or _default_client_factory)()
    cancelled = 0
    failed = 0
    skipped = 0
    outcomes = []
    try:
        for lane in payload.get("lanes", []):
            operation_id = _lane_value(lane, "operation_id")
            agent_id = _lane_value(lane, "agent_id")
            lease_id = _lane_value(lane, "lease_id")
            if not operation_id or not agent_id or not lease_id:
                skipped += 1
                outcomes.append(
                    {
                        "operation_id": operation_id,
                        "agent_id": agent_id,
                        "status": "skipped",
                        "reason": "missing_operation_identity",
                    }
                )
                continue
            try:
                client.cancel_c3_operation(
                    {
                        "operation_id": operation_id,
                        "agent_id": agent_id,
                        "lease_id": lease_id,
                        "reason": args.reason,
                    }
                )
                cancelled += 1
                outcomes.append(
                    {
                        "operation_id": operation_id,
                        "agent_id": agent_id,
                        "status": "requested",
                    }
                )
            except Exception as error:
                failed += 1
                outcomes.append(
                    {
                        "operation_id": operation_id,
                        "agent_id": agent_id,
                        "status": "failed",
                        "error": f"{type(error).__name__}:{error}",
                    }
                )
    finally:
        close = getattr(client, "close", None)
        if callable(close):
            try:
                close()
            except Exception:
                pass
    print(
        json.dumps(
            {
                "ok": failed == 0 and skipped == 0,
                "cancel_requested": cancelled,
                "cancel_failed": failed,
                "cancel_skipped": skipped,
                "outcomes": outcomes,
            }
        )
    )
    return 1 if failed or skipped else 0


def _lane_value(lane: Any, key: str) -> str:
    if not isinstance(lane, dict):
        return ""
    direct = lane.get(key)
    if direct not in (None, ""):
        return str(direct)
    plan = lane.get("plan")
    if isinstance(plan, dict) and plan.get(key) not in (None, ""):
        return str(plan[key])
    return ""


def _setup_lanes(batch_id: str, ports: list[int], batch_log_dir: str) -> None:
    subprocess.run(
        [
            "powershell",
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            str(REPO_ROOT / "scripts" / "setup_c3_parallel_lanes.ps1"),
            "-BatchId",
            batch_id,
            "-Ports",
            ",".join(str(port) for port in ports),
            "-BatchLogDir",
            batch_log_dir,
            "-MaxActiveLanes",
            str(len(ports)),
        ],
        cwd=REPO_ROOT,
        check=True,
    )


def _lane_from_dict(value: dict[str, Any]) -> LanePlan:
    job_value = value.get("job")
    if not isinstance(job_value, dict):
        raise ValueError("planned_lane_job_required")
    payload = dict(value)
    payload["job"] = JobCandidate(**job_value)
    return LanePlan(**payload)


def _lane_artifact_root(lanes: list[LanePlan]) -> Path:
    roots = {Path(lane.artifact_dir).resolve().parent for lane in lanes}
    if len(roots) != 1:
        raise ValueError("lane_artifact_roots_must_match")
    return next(iter(roots))


def _discover_target(port: int, job_url: str = "") -> dict[str, Any]:
    targets = _read_devtools_targets(port)
    extension = find_c3_target(targets)
    created_target_id = ""
    created_extension_target_id = ""
    try:
        if not extension and job_url:
            created_target_id = _create_background_target(port, job_url)
            extension = _wait_for_c3_target(port)
        if not extension:
            raise RuntimeError(f"c3_extension_target_missing:{port}")
        extension_url = str(extension.get("url") or "")
        prefix = "chrome-extension://"
        if not extension_url.startswith(prefix):
            raise RuntimeError(f"c3_extension_id_missing:{port}")
        extension_id = extension_url[len(prefix) :].split("/", 1)[0]
        runtime = {"debug_port": port, "extension_id": extension_id, "tab_id": None}
        if not job_url:
            return runtime
        extension_page, created_extension_target_id = _ensure_extension_page_target(
            port,
            extension_id,
            extension,
        )
        websocket_url = str(extension_page.get("webSocketDebuggerUrl") or "")
        if not websocket_url:
            raise RuntimeError(f"c3_extension_websocket_missing:{port}")
        prepared = _prepare_inactive_job_tab(websocket_url, job_url)
        return {**runtime, **prepared, "url": prepared["resolved_url"]}
    finally:
        if created_extension_target_id:
            _close_background_target(port, created_extension_target_id)
        if created_target_id:
            _close_background_target(port, created_target_id)


def _read_devtools_targets(port: int) -> list[dict[str, Any]]:
    with urlopen(f"http://127.0.0.1:{port}/json/list", timeout=5) as response:
        targets = json.loads(response.read().decode("utf-8"))
    return targets if isinstance(targets, list) else []


def _wait_for_c3_target(port: int, *, timeout_seconds: float = 8.0) -> dict[str, Any] | None:
    deadline = time.monotonic() + timeout_seconds
    while time.monotonic() < deadline:
        extension = find_c3_target(_read_devtools_targets(port))
        if extension:
            return extension
        time.sleep(0.1)
    return None


def _ensure_extension_page_target(
    port: int,
    extension_id: str,
    discovered: dict[str, Any],
    *,
    timeout_seconds: float = 8.0,
) -> tuple[dict[str, Any], str]:
    discovered_url = str(discovered.get("url") or "")
    if discovered.get("type") == "page" and discovered_url.startswith(
        f"chrome-extension://{extension_id}/"
    ):
        return discovered, ""
    options_url = f"chrome-extension://{extension_id}/src/options/options.html"
    target_id = _create_background_target(port, options_url)
    try:
        deadline = time.monotonic() + timeout_seconds
        while time.monotonic() < deadline:
            for target in _read_devtools_targets(port):
                if str(target.get("url") or "") != options_url:
                    continue
                websocket_url = str(target.get("webSocketDebuggerUrl") or "")
                if not websocket_url:
                    continue
                try:
                    ready = _evaluate_extension_target(
                        websocket_url,
                        "Boolean(globalThis.chrome && chrome.tabs && chrome.tabs.create)",
                    )
                except Exception:
                    ready = False
                if ready:
                    return target, target_id
            time.sleep(0.1)
    except Exception:
        _close_background_target(port, target_id)
        raise
    _close_background_target(port, target_id)
    raise RuntimeError(f"c3_extension_page_not_ready:{port}")


def _browser_devtools_command(port: int, method: str, params: dict[str, Any]) -> dict[str, Any]:
    with urlopen(f"http://127.0.0.1:{port}/json/version", timeout=5) as response:
        version = json.loads(response.read().decode("utf-8"))
    websocket_url = str(version.get("webSocketDebuggerUrl") or "")
    if not websocket_url:
        raise RuntimeError(f"browser_devtools_websocket_missing:{port}")
    sock = _open_devtools_websocket(websocket_url)
    sock.settimeout(15)
    try:
        _send_ws_text(sock, {"id": 1, "method": method, "params": params})
        while True:
            message = _recv_ws_text(sock)
            if message.get("id") != 1:
                continue
            if message.get("error"):
                raise RuntimeError(f"browser_devtools_command_failed:{method}")
            result = message.get("result")
            return result if isinstance(result, dict) else {}
    finally:
        sock.close()


def _create_background_target(port: int, job_url: str) -> str:
    result = _browser_devtools_command(
        port,
        "Target.createTarget",
        {"url": str(job_url), "background": True},
    )
    target_id = str(result.get("targetId") or "")
    if not target_id:
        raise RuntimeError(f"background_target_creation_failed:{port}")
    return target_id


def _close_background_target(port: int, target_id: str) -> None:
    try:
        _browser_devtools_command(port, "Target.closeTarget", {"targetId": target_id})
    except Exception:
        return


def _prepare_inactive_job_tab(
    websocket_url: str,
    job_url: str,
    *,
    evaluate: Any = None,
) -> dict[str, Any]:
    wanted_json = json.dumps(str(job_url))
    expression = f"""
      (async () => {{
        const wanted = {wanted_json};
        let tab = null;
        try {{
          tab = await chrome.tabs.create({{ url: wanted, active: false }});
          const deadline = Date.now() + 15000;
          let current = tab;
          while (Date.now() < deadline) {{
            await new Promise((resolve) => setTimeout(resolve, 100));
            current = await chrome.tabs.get(tab.id);
            if (current.status === "complete" && current.url && current.url !== "about:blank") {{
              break;
            }}
          }}
          const debuggerTargets = await chrome.debugger.getTargets();
          const target = debuggerTargets.find(
            (candidate) => Number(candidate.tabId) === Number(current.id)
          );
          return {{
            tab_id: current.id,
            target_id: String(target?.id || ""),
            resolved_url: String(current.url || wanted),
            active: Boolean(current.active),
            status: String(current.status || "")
          }};
        }} catch (error) {{
          if (tab?.id != null) {{
            try {{ await chrome.tabs.remove(tab.id); }} catch (_cleanupError) {{}}
          }}
          throw error;
        }}
      }})()
    """
    evaluator = evaluate or _evaluate_extension_target
    result = evaluator(websocket_url, expression)
    try:
        return _validated_prepared_job_tab(result)
    except Exception:
        if isinstance(result, dict) and result.get("tab_id") not in (None, ""):
            _remove_extension_tab(websocket_url, result["tab_id"], evaluate=evaluator)
        raise


def _remove_extension_tab(websocket_url: str, tab_id: Any, *, evaluate: Any = None) -> None:
    try:
        normalized_tab_id = int(tab_id)
    except (TypeError, ValueError):
        return
    expression = f"chrome.tabs.remove({normalized_tab_id}).then(() => true, () => false)"
    try:
        (evaluate or _evaluate_extension_target)(websocket_url, expression)
    except Exception:
        return


def _prepare_existing_inactive_job_tab(
    websocket_url: str,
    job_url: str,
    target_id: str,
    *,
    evaluate: Any = None,
) -> dict[str, Any]:
    wanted_json = json.dumps(str(job_url))
    target_json = json.dumps(str(target_id))
    expression = f"""
      (async () => {{
        const wanted = {wanted_json};
        const targetId = {target_json};
        const debuggerTargets = await chrome.debugger.getTargets();
        const matched = debuggerTargets.find(
          (candidate) => String(candidate.id || "") === targetId && candidate.tabId != null
        );
        if (!matched) return null;
        const deadline = Date.now() + 15000;
        let current = await chrome.tabs.get(matched.tabId);
        while (Date.now() < deadline) {{
          if (current.status === "complete" && current.url && current.url !== "about:blank") {{
            break;
          }}
          await new Promise((resolve) => setTimeout(resolve, 100));
          current = await chrome.tabs.get(matched.tabId);
        }}
        return {{
          tab_id: current.id,
          target_id: String(targetId),
          resolved_url: String(current.url || wanted),
          active: Boolean(current.active),
          status: String(current.status || "")
        }};
      }})()
    """
    result = (evaluate or _evaluate_extension_target)(websocket_url, expression)
    return _validated_prepared_job_tab(result)


def _validated_prepared_job_tab(result: Any) -> dict[str, Any]:
    if not isinstance(result, dict) or result.get("tab_id") in (None, ""):
        raise RuntimeError("prepared_job_tab_missing_identity")
    if result.get("active") is not False:
        raise RuntimeError("prepared_job_tab_became_active")
    if result.get("status") != "complete":
        raise RuntimeError("prepared_job_tab_not_complete")
    resolved_url = str(result.get("resolved_url") or "").strip()
    parsed_url = urlsplit(resolved_url)
    if parsed_url.scheme.casefold() not in {"http", "https"} or not parsed_url.netloc:
        raise RuntimeError("prepared_job_tab_resolved_url_required")
    target_id = str(result.get("target_id") or "").strip()
    if not target_id:
        raise RuntimeError("prepared_job_tab_target_identity_required")
    return {
        "tab_id": int(result["tab_id"]),
        "target_id": target_id,
        "resolved_url": resolved_url,
        "active": False,
        "status": str(result.get("status") or ""),
    }


def _evaluate_extension_target(websocket_url: str, expression: str) -> Any:
    sock = _open_devtools_websocket(websocket_url)
    sock.settimeout(20)
    try:
        _send_ws_text(
            sock,
            {
                "id": 1,
                "method": "Runtime.evaluate",
                "params": {
                    "expression": expression,
                    "awaitPromise": True,
                    "returnByValue": True,
                },
            },
        )
        while True:
            message = _recv_ws_text(sock)
            if message.get("id") != 1:
                continue
            if message.get("exceptionDetails") or message.get("result", {}).get("exceptionDetails"):
                details = message.get("exceptionDetails") or message.get("result", {}).get(
                    "exceptionDetails", {}
                )
                exception = details.get("exception") if isinstance(details, dict) else {}
                reason = str(
                    (exception or {}).get("description")
                    or (details or {}).get("text")
                    or "unknown_extension_exception"
                )
                reason = " ".join(reason.split())[:500]
                raise RuntimeError(f"prepare_job_tab_evaluation_failed:{reason}")
            remote = message.get("result", {}).get("result", {})
            if "value" not in remote:
                raise RuntimeError("prepare_job_tab_result_missing")
            return remote["value"]
    finally:
        sock.close()


def _merge_completed_checkpoint_results(
    report: Any,
    existing_checkpoint: dict[str, Any] | None,
) -> Any:
    if not isinstance(report, BatchReport) or not existing_checkpoint:
        return report
    completed: dict[str, LaneResult] = {}
    ordered_sessions: list[str] = []
    for record in existing_checkpoint.get("lanes", []):
        if not isinstance(record, dict):
            continue
        session_id = str(record.get("plan", {}).get("session_id") or "")
        if session_id:
            ordered_sessions.append(session_id)
        if record.get("stage") != "complete":
            continue
        completed[session_id] = _validated_checkpoint_lane_result(
            record, str(existing_checkpoint.get("batch_id") or report.batch_id)
        )
    merged = {item.session_id: item for item in report.lanes}
    merged.update(completed)
    ordered = [merged.pop(session_id) for session_id in ordered_sessions if session_id in merged]
    ordered.extend(merged.values())
    return BatchReport(
        batch_id=report.batch_id,
        lanes=tuple(ordered),
        started_at=str(existing_checkpoint.get("started_at") or report.started_at),
        completed_at=report.completed_at,
        metadata=report.metadata,
    )


def _completed_checkpoint_report(payload: dict[str, Any]) -> BatchReport:
    batch_id = str(payload.get("batch_id") or "")
    results = [
        _validated_checkpoint_lane_result(record, batch_id) for record in payload.get("lanes", [])
    ]
    return BatchReport(
        batch_id=batch_id,
        lanes=tuple(results),
        started_at=str(payload.get("started_at") or utc_now()),
        completed_at=utc_now(),
        metadata=payload.get("metadata") if isinstance(payload.get("metadata"), dict) else {},
    )


def _refresh_completed_report(report: BatchReport, client_factory: Any) -> BatchReport:
    try:
        client = client_factory()
    except Exception as error:
        return replace(
            report,
            lanes=tuple(
                replace(
                    result,
                    operation_refresh_status="error",
                    operation_refresh_error=type(error).__name__,
                    failure_context_refresh_status="error",
                    failure_context_refresh_error=type(error).__name__,
                )
                for result in report.lanes
            ),
        )
    try:
        refreshed = tuple(_refresh_completed_lane_result(client, result) for result in report.lanes)
    finally:
        close = getattr(client, "close", None)
        if callable(close):
            close()
    return BatchReport(
        batch_id=report.batch_id,
        lanes=refreshed,
        started_at=report.started_at,
        completed_at=report.completed_at,
        metadata=report.metadata,
    )


def _refresh_completed_lane_result(client: Any, result: LaneResult) -> LaneResult:
    if not result.operation_id or not result.lease_id or not result.agent_id:
        return result
    ownership = {
        "operation_id": result.operation_id,
        "agent_id": result.agent_id,
        "lease_id": result.lease_id,
    }
    updates: dict[str, Any] = {}
    try:
        operation = _operation_projection(client.get_c3_operation(ownership))
    except Exception as error:
        operation = {}
        updates.update(
            operation_refresh_status="error",
            operation_refresh_error=type(error).__name__,
        )
    if operation:
        updates.update(
            operation_refresh_status="refreshed",
            operation_refresh_error="",
            operation_state=str(operation.get("state") or result.operation_state),
            terminal_reason=str(operation.get("terminal_reason") or result.terminal_reason),
            artifact_ids=_string_tuple(operation.get("artifact_ids")) or result.artifact_ids,
            artifact_paths=result.artifact_paths,
        )
    elif "operation_refresh_status" not in updates:
        updates.update(
            operation_refresh_status="error",
            operation_refresh_error="operation_projection_missing",
        )
    getter = getattr(client, "get_c3_failure_context", None)
    if callable(getter):
        try:
            context = _failure_context_projection(getter(ownership))
        except Exception as error:
            context = {}
            updates.update(
                failure_context_refresh_status="error",
                failure_context_refresh_error=type(error).__name__,
            )
        if context:
            updates.update(_failure_context_fields(context, "available", ""))
            updates.update(
                failure_context_refresh_status="refreshed",
                failure_context_refresh_error="",
                artifact_paths=_artifact_paths(context, operation_id=result.operation_id)
                or updates.get("artifact_paths")
                or result.artifact_paths,
            )
        elif "failure_context_refresh_status" not in updates:
            updates.update(
                failure_context_refresh_status="error",
                failure_context_refresh_error="failure_context_missing",
            )
    else:
        updates.update(
            failure_context_refresh_status="unavailable",
            failure_context_refresh_error="client_method_unavailable",
        )
    return replace(result, **updates) if updates else result


def _validated_checkpoint_lane_result(record: Any, batch_id: str) -> LaneResult:
    if not isinstance(record, dict) or not isinstance(record.get("plan"), dict):
        raise ValueError("completed_checkpoint_result_required")
    result_value = record.get("result")
    if not isinstance(result_value, dict):
        raise ValueError("completed_checkpoint_result_required")
    plan = record["plan"]
    lane = _lane_from_dict(plan)
    _validate_checkpoint_plan(lane, batch_id)
    lane_result_fields = {item.name for item in fields(LaneResult)}
    result = LaneResult(
        **{key: value for key, value in result_value.items() if key in lane_result_fields}
    )
    expected = {
        "agent_id": lane.agent_id,
        "lane_id": lane.lane_id,
        "session_id": lane.session_id,
        "job_url": lane.job.url,
        "artifact_dir": lane.artifact_dir,
    }
    if any(getattr(result, key) != value for key, value in expected.items()):
        raise ValueError("completed_checkpoint_identity_mismatch")
    return result


def _validate_checkpoint_plan(lane: LanePlan, batch_id: str) -> None:
    if (
        lane.batch_id != batch_id
        or lane.browser_target_id != lane.session_id
        or lane.allow_submit
        or lane.allow_foreground
    ):
        raise ValueError("completed_checkpoint_identity_mismatch")


def _default_client_factory() -> Any:
    client_path = REPO_ROOT / "tools" / "hunt_mcp" / "client.py"
    spec = importlib.util.spec_from_file_location("hunt_mcp_client", client_path)
    if spec is None or spec.loader is None:
        raise RuntimeError("hunt_mcp_client_import_failed")
    module = importlib.util.module_from_spec(spec)
    sys.modules.setdefault(spec.name, module)
    spec.loader.exec_module(module)
    return module.HuntLedgerClient()


def _ports(value: str) -> list[int]:
    ports = [int(item.strip()) for item in value.split(",") if item.strip()]
    if any(port < 1 or port > 65535 for port in ports) or len(set(ports)) != len(ports):
        raise ValueError("invalid_or_duplicate_ports")
    return ports


def _read_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def _atomic_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    temporary.replace(path)


class _BatchCheckpoint:
    def __init__(
        self,
        path: Path,
        lanes: list[LanePlan],
        *,
        existing: dict[str, Any] | None = None,
    ) -> None:
        self.path = path
        self._lock = threading.Lock()
        records = [
            dict(item)
            for item in (existing or {}).get("lanes", [])
            if isinstance(item, dict) and isinstance(item.get("plan"), dict)
        ]
        existing_by_session = {
            str(item.get("plan", {}).get("session_id") or ""): item for item in records
        }
        for lane in lanes:
            if lane.session_id not in existing_by_session:
                records.append({"stage": "planned", "plan": asdict(lane)})
        self.payload = {
            "version": 2,
            "batch_id": lanes[0].batch_id,
            "status": "running",
            "started_at": (existing or {}).get("started_at") or utc_now(),
            "updated_at": utc_now(),
            "lanes": records,
        }

    def write(self) -> None:
        with self._lock:
            self.payload["updated_at"] = utc_now()
            _atomic_json(self.path, self.payload)

    def update(self, lane: LanePlan, state: dict[str, Any]) -> None:
        with self._lock:
            record = next(
                item
                for item in self.payload["lanes"]
                if item["plan"]["session_id"] == lane.session_id
            )
            record.update(state)
            self.payload["updated_at"] = utc_now()
            _atomic_json(self.path, self.payload)


if __name__ == "__main__":
    raise SystemExit(main())
