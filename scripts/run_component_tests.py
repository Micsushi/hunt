#!/usr/bin/env python3
"""Run grouped Hunt test suites with a short cross-platform command."""

from __future__ import annotations

import argparse
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TEST_TARGETS = {
    "all": [
        "tests",
        "hunter/tests",
    ],
    "c0": [
        "tests/test_c0_control_api.py",
        "tests/test_review_ops.py",
        "tests/test_resume_review_ui.py",
        "tests/test_local_dev_modes.py",
        "tests/test_frontend_jobs_ui.py",
    ],
    "c1": [
        "tests/test_stage1.py",
        "tests/test_stage2.py",
        "tests/test_stage3.py",
        "tests/test_stage32.py",
        "tests/test_stage4.py",
        "tests/test_search_lanes.py",
        "hunter/tests",
    ],
    "c2": [
        "tests/test_component2_stage1.py",
        "tests/test_component2_pipeline.py",
        "tests/test_component2_ollama.py",
    ],
    "c3": [
        "tests/test_component3_stage1.py",
    ],
    "c4": [
        "tests/test_component4_cli.py",
        "tests/test_component4_service_api.py",
        "tests/test_component4_c3_bridge.py",
    ],
    "shared": [
        "tests/test_db_compat.py",
        "tests/test_new_tables.py",
        "tests/test_deploy_readiness.py",
    ],
    "frontend": [
        "tests/test_frontend_jobs_ui.py",
    ],
}
TARGET_ALIASES = {
    "backend": "c0",
    "hunter": "c1",
    "fletcher": "c2",
    "executioner": "c3",
    "coordinator": "c4",
    "infra": "shared",
    "full": "all",
}


def _parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Run grouped Hunt test suites with one short command."
    )
    parser.add_argument(
        "target",
        nargs="?",
        default="all",
        help="Test target: all, c0, c1, c2, c3, c4, shared, frontend",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Print the pytest command without running it.",
    )
    parser.add_argument(
        "-k",
        dest="pytest_k",
        default=None,
        help="Optional pytest -k expression to narrow the target suite.",
    )
    return parser.parse_args(argv)


def _resolve_target(name: str) -> tuple[str, list[str]]:
    canonical = TARGET_ALIASES.get(name, name)
    patterns = TEST_TARGETS.get(canonical)
    if patterns is None:
        valid = ", ".join(sorted(TEST_TARGETS))
        raise RuntimeError(f"Unknown test target `{name}`. Valid targets: {valid}")
    return canonical, patterns


def main() -> int:
    args = _parse_args(sys.argv[1:])

    try:
        target, patterns = _resolve_target(args.target)
    except RuntimeError as exc:
        print(f"[tests] {exc}", file=sys.stderr)
        return 1

    command = [sys.executable, "-m", "pytest", "-q", *patterns]
    if args.pytest_k:
        command.extend(["-k", args.pytest_k])

    print("[tests] repo:", ROOT)
    print("[tests] target:", target)
    print("[tests] command:", " ".join(command))

    if args.dry_run:
        print("[tests] dry-run complete")
        return 0

    result = subprocess.run(command, cwd=ROOT)
    return result.returncode


if __name__ == "__main__":
    raise SystemExit(main())
