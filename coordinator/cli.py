from __future__ import annotations

import argparse
import json
import sys
from collections.abc import Sequence

from .service import OrchestrationError, OrchestrationService


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="python -m coordinator.cli",
        description="C4 (Coordinator) orchestration CLI.",
    )
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument(
        "--db-path", default=None, help="Optional override for the Hunt SQLite database path."
    )
    common.add_argument(
        "--runtime-root", default=None, help="Optional override for the C4 runtime artifact root."
    )

    subparsers = parser.add_subparsers(dest="command", required=True)

    subparsers.add_parser(
        "init-db", parents=[common], help="Create or migrate the C4 (Coordinator) tables."
    )

    ready_parser = subparsers.add_parser(
        "ready", parents=[common], help="Show the C4 readiness decision for one job."
    )
    ready_parser.add_argument("--job-id", type=int, required=True)

    ready_list_parser = subparsers.add_parser(
        "ready-list", parents=[common], help="List readiness decisions across the queue."
    )
    ready_list_parser.add_argument("--limit", type=int, default=20)
    ready_list_parser.add_argument("--reason", default=None)
    ready_list_parser.add_argument("--only-ready", action="store_true")

    summary_parser = subparsers.add_parser(
        "summary", parents=[common], help="Summarize readiness and scheduler blockers."
    )
    summary_parser.add_argument("--sample-limit", type=int, default=10)

    apply_prep_parser = subparsers.add_parser(
        "apply-prep",
        parents=[common],
        help="Create a C4 run and emit the explicit apply context for one job.",
    )
    apply_prep_parser.add_argument("--job-id", type=int, required=True)
    apply_prep_parser.add_argument("--source-runtime", default="manual")
    apply_prep_parser.add_argument("--browser-lane", choices=["isolated", "attached"], default=None)
    apply_prep_parser.add_argument("--embed-resume-data", action="store_true")

    request_fill_parser = subparsers.add_parser(
        "request-fill", parents=[common], help="Move an apply-prepared run into fill_requested."
    )
    request_fill_parser.add_argument("--run-id", required=True)

    claim_worker_parser = subparsers.add_parser(
        "claim-worker",
        parents=[common],
        help="Claim one pending fill for a bounded C3/OpenClaw/Hermes worker.",
    )
    claim_worker_parser.add_argument("--runtime-name", required=True)
    claim_worker_parser.add_argument(
        "--browser-lane", choices=["isolated", "attached"], default=None
    )
    claim_worker_parser.add_argument("--lease-seconds", type=int, default=900)

    heartbeat_worker_parser = subparsers.add_parser(
        "heartbeat-worker",
        parents=[common],
        help="Extend one active worker lease.",
    )
    heartbeat_worker_parser.add_argument("--lease-id", required=True)
    heartbeat_worker_parser.add_argument("--lease-seconds", type=int, default=900)

    complete_worker_parser = subparsers.add_parser(
        "complete-worker",
        parents=[common],
        help="Complete one active worker lease with a fill result JSON object.",
    )
    complete_worker_parser.add_argument("--lease-id", required=True)
    complete_worker_parser.add_argument("--result-json", required=True)

    reconcile_stale_parser = subparsers.add_parser(
        "reconcile-stale",
        parents=[common],
        help="Move stale worker-controlled runs into manual review.",
    )
    reconcile_stale_parser.add_argument("--fill-timeout-minutes", type=int, default=30)
    reconcile_stale_parser.add_argument("--submit-confirm-timeout-minutes", type=int, default=None)

    record_fill_parser = subparsers.add_parser(
        "record-fill", parents=[common], help="Record a fill result for a run."
    )
    record_fill_parser.add_argument("--run-id", required=True)
    record_fill_parser.add_argument("--result-json", required=True)

    resolve_review_parser = subparsers.add_parser(
        "resolve-review",
        parents=[common],
        help="Resolve a manual-review hold by continuing or failing the run.",
    )
    resolve_review_parser.add_argument("--run-id", required=True)
    resolve_review_parser.add_argument("--decision", choices=["continue", "fail"], required=True)
    resolve_review_parser.add_argument("--approved-by", required=True)
    resolve_review_parser.add_argument("--reason", default="")

    approve_submit_parser = subparsers.add_parser(
        "approve-submit", parents=[common], help="Record an explicit submit approval or denial."
    )
    approve_submit_parser.add_argument("--run-id", required=True)
    approve_submit_parser.add_argument("--decision", choices=["approve", "deny"], required=True)
    approve_submit_parser.add_argument("--approved-by", required=True)
    approve_submit_parser.add_argument("--reason", default="")
    approve_submit_parser.add_argument("--approval-mode", default="operator")

    mark_submitted_parser = subparsers.add_parser(
        "mark-submitted", parents=[common], help="Mark a submit-approved run as submitted."
    )
    mark_submitted_parser.add_argument("--run-id", required=True)
    mark_submitted_parser.add_argument("--summary-json", default=None)

    subparsers.add_parser(
        "pick-next",
        parents=[common],
        help="Pick the next ready job while enforcing scheduler guardrails.",
    )

    run_parser = subparsers.add_parser(
        "run",
        parents=[common],
        help="Run apply-prep for one explicit job and optionally request fill.",
    )
    run_parser.add_argument("--job-id", type=int, required=True)
    run_parser.add_argument("--source-runtime", default="manual")
    run_parser.add_argument("--browser-lane", choices=["isolated", "attached"], default=None)
    run_parser.add_argument("--embed-resume-data", action="store_true")
    run_parser.add_argument("--prepare-only", action="store_true")

    run_once_parser = subparsers.add_parser(
        "run-once",
        parents=[common],
        help="Pick the next ready job and start one bounded orchestration run.",
    )
    run_once_parser.add_argument("--source-runtime", default="scheduler")
    run_once_parser.add_argument("--browser-lane", choices=["isolated", "attached"], default=None)
    run_once_parser.add_argument("--embed-resume-data", action="store_true")
    run_once_parser.add_argument("--prepare-only", action="store_true")

    run_status_parser = subparsers.add_parser(
        "run-status", parents=[common], help="Show one run and its event history."
    )
    run_status_parser.add_argument("--run-id", required=True)

    runs_parser = subparsers.add_parser(
        "runs", parents=[common], help="List C4 (Coordinator) orchestration runs."
    )
    runs_parser.add_argument("--status", default=None)
    runs_parser.add_argument("--limit", type=int, default=20)

    events_parser = subparsers.add_parser(
        "events", parents=[common], help="List the event history for one run."
    )
    events_parser.add_argument("--run-id", required=True)

    subparsers.add_parser(
        "scheduler-tick",
        parents=[common],
        help="Run one scheduler pass: pick the next ready job and request fill.",
    )

    investigate_parser = subparsers.add_parser(
        "investigate",
        parents=[common],
        help="Manually queue a run for agent investigation.",
    )
    investigate_parser.add_argument("--run-id", required=True)

    failure_log_parser = subparsers.add_parser(
        "failure-log",
        parents=[common],
        help="Read the last N entries from the failure perma-log.",
    )
    failure_log_parser.add_argument("--limit", type=int, default=50)

    claim_investigation_parser = subparsers.add_parser(
        "claim-investigation",
        parents=[common],
        help="Claim one pending investigation lease for an agent worker.",
    )
    claim_investigation_parser.add_argument("--runtime-name", required=True)
    claim_investigation_parser.add_argument(
        "--browser-lane", choices=["isolated", "attached"], default=None
    )
    claim_investigation_parser.add_argument("--lease-seconds", type=int, default=900)

    sync_skill_parser = subparsers.add_parser(
        "sync-investigator-skill",
        parents=[common],
        help="Update the Hermes c4-ats-investigator skill Known Patterns from completed investigation results.",
    )
    sync_skill_parser.add_argument(
        "--limit", type=int, default=200, help="Max entries to read from failures.jsonl."
    )

    return parser


def main(argv: Sequence[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    service = OrchestrationService(db_path=args.db_path, runtime_root=args.runtime_root)

    try:
        if args.command == "init-db":
            service.ensure_initialized()
            payload = {
                "ok": True,
                "db_path": str(service.db_path),
                "runtime_root": str(service.runtime_root),
            }
        elif args.command == "ready":
            payload = service.get_ready_decision(args.job_id).to_dict()
        elif args.command == "ready-list":
            payload = {
                "items": [
                    item.to_dict()
                    for item in service.list_ready_decisions(
                        limit=args.limit, reason=args.reason, only_ready=args.only_ready
                    )
                ]
            }
        elif args.command == "summary":
            payload = service.get_readiness_summary(sample_limit=args.sample_limit)
        elif args.command == "apply-prep":
            payload = service.build_apply_context(
                args.job_id,
                source_runtime=args.source_runtime,
                browser_lane=args.browser_lane,
                embed_resume_data=args.embed_resume_data,
            ).to_dict()
        elif args.command == "request-fill":
            payload = service.request_fill(args.run_id)
        elif args.command == "claim-worker":
            payload = service.claim_next_fill(
                runtime_name=args.runtime_name,
                browser_lane=args.browser_lane,
                lease_seconds=args.lease_seconds,
            )
        elif args.command == "heartbeat-worker":
            payload = service.heartbeat_lease(args.lease_id, lease_seconds=args.lease_seconds)
        elif args.command == "complete-worker":
            payload = service.complete_lease_with_result(
                args.lease_id,
                service._load_result_json(args.result_json),
            )
        elif args.command == "reconcile-stale":
            payload = service.reconcile_stale_runs(
                fill_timeout_minutes=args.fill_timeout_minutes,
                submit_confirm_timeout_minutes=args.submit_confirm_timeout_minutes,
            )
        elif args.command == "record-fill":
            payload = service.record_fill_result(args.run_id, args.result_json)
        elif args.command == "resolve-review":
            payload = service.resolve_review(
                args.run_id,
                decision=args.decision,
                approved_by=args.approved_by,
                reason=args.reason,
            )
        elif args.command == "approve-submit":
            payload = service.approve_submit(
                args.run_id,
                decision=args.decision,
                approved_by=args.approved_by,
                reason=args.reason,
                approval_mode=args.approval_mode,
            )
        elif args.command == "mark-submitted":
            payload = service.mark_submitted(args.run_id, summary_json_path=args.summary_json)
        elif args.command == "pick-next":
            payload = service.pick_next_job()
        elif args.command == "run":
            payload = service.run_job(
                args.job_id,
                source_runtime=args.source_runtime,
                browser_lane=args.browser_lane,
                embed_resume_data=args.embed_resume_data,
                prepare_only=args.prepare_only,
            )
        elif args.command == "run-once":
            payload = service.run_once(
                source_runtime=args.source_runtime,
                browser_lane=args.browser_lane,
                embed_resume_data=args.embed_resume_data,
                prepare_only=args.prepare_only,
            )
        elif args.command == "run-status":
            payload = service.get_run_status(args.run_id)
        elif args.command == "runs":
            payload = {
                "items": [
                    item.to_dict()
                    for item in service.list_runs(status=args.status, limit=args.limit)
                ]
            }
        elif args.command == "events":
            payload = {"items": [item.to_dict() for item in service.list_events(args.run_id)]}
        elif args.command == "scheduler-tick":
            from .scheduler import get_scheduler

            payload = get_scheduler(service).tick()
        elif args.command == "investigate":
            payload = service.queue_investigation(args.run_id)
        elif args.command == "failure-log":
            payload = {"items": service.get_failure_log(limit=args.limit)}
        elif args.command == "claim-investigation":
            payload = service.claim_next_fill(
                runtime_name=args.runtime_name,
                browser_lane=args.browser_lane,
                lease_seconds=args.lease_seconds,
                task_type="investigation",
            )
        elif args.command == "sync-investigator-skill":
            payload = service.sync_investigator_skill(limit=args.limit)
        else:
            parser.error(f"unknown command: {args.command}")
            return 2
    except OrchestrationError as exc:
        print(json.dumps({"error": str(exc)}, indent=2, sort_keys=True), file=sys.stderr)
        return 1

    print(json.dumps(payload, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
