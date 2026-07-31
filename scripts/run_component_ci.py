#!/usr/bin/env python3
"""Run grouped CI commands: checks first, then tests."""

from __future__ import annotations

import argparse
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PYTHON = sys.executable


def _parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run grouped CI commands for Hunt.")
    parser.add_argument(
        "target",
        nargs="?",
        default="all",
        help="CI target: all, c0, c1, c2, shared, frontend; C3 is planned and C4 is blocked",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Print the commands without running them.",
    )
    return parser.parse_args(argv)


def main() -> int:
    args = _parse_args(sys.argv[1:])
    if args.target in {"c3", "executioner"}:
        print("[ci] C3 v3 is planned but not implemented.", file=sys.stderr)
        return 2
    if args.target in {"c4", "coordinator"}:
        print("[ci] C4 is on hold. No C4 checks or tests were started.", file=sys.stderr)
        return 2

    commands = [
        [PYTHON, "quality.py", args.target],
        [PYTHON, "test.py", args.target],
    ]

    print("[ci] repo:", ROOT)
    print("[ci] target:", args.target)

    for command in commands:
        if args.dry_run:
            command.append("--dry-run")
        print("[ci] command:", " ".join(command))
        if args.dry_run:
            continue
        result = subprocess.run(command, cwd=ROOT)
        if result.returncode != 0:
            return result.returncode

    if args.dry_run:
        print("[ci] dry-run complete")
    else:
        print(f"[ci] ci target `{args.target}` passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
