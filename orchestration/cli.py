from __future__ import annotations

import argparse
import json
from typing import Sequence

from .service import OrchestrationService


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="python -m orchestration.cli",
        description="Component 4 orchestration skeleton CLI.",
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    ready_parser = subparsers.add_parser(
        "ready",
        help="Show the current C4 readiness placeholder for one job.",
    )
    ready_parser.add_argument("--job-id", type=int, required=True)

    apply_prep_parser = subparsers.add_parser(
        "apply-prep",
        help="Emit the documented C4 apply-context placeholder for one job.",
    )
    apply_prep_parser.add_argument("--job-id", type=int, required=True)

    run_parser = subparsers.add_parser(
        "run",
        help="Start a placeholder orchestration run record for one job.",
    )
    run_parser.add_argument("--job-id", type=int, required=True)
    run_parser.add_argument(
        "--source-runtime",
        default="manual",
        help="Label for the caller/runtime starting the run.",
    )

    return parser


def main(argv: Sequence[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    service = OrchestrationService()

    if args.command == "ready":
        payload = service.get_ready_decision(args.job_id).to_dict()
    elif args.command == "apply-prep":
        payload = service.build_apply_context(args.job_id).to_dict()
    elif args.command == "run":
        payload = service.start_run(args.job_id, source_runtime=args.source_runtime).to_dict()
    else:
        parser.error(f"unknown command: {args.command}")
        return 2

    print(json.dumps(payload, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
