#!/usr/bin/env python3
"""
C2 (Fletcher) operator CLI.

This is intentionally separate from `hunterctl` so `hunter ...` remains C1-only.
"""

from __future__ import annotations

import argparse
import os
import shlex
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
IS_WINDOWS = os.name == "nt"


def _find_repo_python() -> str:
    candidates = []
    if IS_WINDOWS:
        candidates.extend(
            [
                REPO_ROOT / ".venv" / "Scripts" / "python.exe",
                REPO_ROOT / "venv" / "Scripts" / "python.exe",
            ]
        )
    else:
        candidates.extend([REPO_ROOT / ".venv" / "bin" / "python", REPO_ROOT / "venv" / "bin" / "python"])
    for c in candidates:
        if c.exists():
            return str(c)
    return sys.executable


PYTHON = _find_repo_python()


def _run(argv, *, env=None):
    final_env = os.environ.copy()
    if env:
        final_env.update(env)
    print("[fletchctl] Running:", " ".join(shlex.quote(str(part)) for part in argv))
    raise SystemExit(subprocess.run(argv, cwd=REPO_ROOT, env=final_env).returncode)


def cmd_fletcher(args):
    # Thin wrapper around the module CLI.
    argv = [PYTHON, "-m", "fletcher.cli"] + args.fletcher_args
    _run(argv)


def cmd_tests(_args):
    patterns = [
        "test_component2_stage1.py",
        "test_component2_pipeline.py",
        "test_component2_ollama.py",
        "test_resume_review_ui.py",
    ]
    for pattern in patterns:
        result = subprocess.run([PYTHON, "-m", "unittest", "discover", "-s", "tests", "-p", pattern, "-v"], cwd=REPO_ROOT)
        if result.returncode != 0:
            raise SystemExit(result.returncode)
    raise SystemExit(0)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="C2 (Fletcher) operator CLI.")
    sub = parser.add_subparsers(dest="command", required=True)

    tests = sub.add_parser("tests", help="Run C2 unit tests.")
    tests.set_defaults(func=cmd_tests)

    fx = sub.add_parser(
        "run",
        help="Delegate to `python -m fletcher.cli ...` (pass through remaining args).",
    )
    fx.add_argument("fletcher_args", nargs=argparse.REMAINDER)
    fx.set_defaults(func=cmd_fletcher)

    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    args.func(args)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

