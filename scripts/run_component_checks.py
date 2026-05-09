#!/usr/bin/env python3
"""Run grouped lint, format, and typecheck commands with short targets."""

from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PYTHON = sys.executable


def _frontend_command(*args: str) -> list[str]:
    return [_resolve_exec("npm"), "run", *args]


def _npx_command(*args: str) -> list[str]:
    return [_resolve_exec("npx"), *args]


def _resolve_exec(name: str) -> str:
    if os.name == "nt":
        cmd_name = f"{name}.cmd"
        resolved = shutil.which(cmd_name)
        if resolved:
            return resolved
    resolved = shutil.which(name)
    return resolved or name


CHECK_TARGETS = {
    "all": [
        ([PYTHON, "-m", "ruff", "check", "."], ROOT),
        ([PYTHON, "-m", "ruff", "format", "--check", "."], ROOT),
        (_frontend_command("lint"), ROOT / "frontend"),
        (_frontend_command("typecheck"), ROOT / "frontend"),
        (_npx_command("prettier", "--check", "src"), ROOT / "frontend"),
        ([PYTHON, "scripts/executioner_quality.py", "quality"], ROOT),
    ],
    "c0": [
        ([PYTHON, "-m", "ruff", "check", "backend", "control_plane_api.py"], ROOT),
        ([PYTHON, "-m", "ruff", "format", "--check", "backend", "control_plane_api.py"], ROOT),
        (_frontend_command("lint"), ROOT / "frontend"),
        (_frontend_command("typecheck"), ROOT / "frontend"),
        (_npx_command("prettier", "--check", "src"), ROOT / "frontend"),
    ],
    "c1": [
        ([PYTHON, "-m", "ruff", "check", "hunter"], ROOT),
        ([PYTHON, "-m", "ruff", "format", "--check", "hunter"], ROOT),
    ],
    "c2": [
        ([PYTHON, "-m", "ruff", "check", "fletcher"], ROOT),
        ([PYTHON, "-m", "ruff", "format", "--check", "fletcher"], ROOT),
    ],
    "c3": [
        ([PYTHON, "scripts/executioner_quality.py", "quality"], ROOT),
    ],
    "c4": [
        ([PYTHON, "-m", "ruff", "check", "coordinator"], ROOT),
        ([PYTHON, "-m", "ruff", "format", "--check", "coordinator"], ROOT),
    ],
    "shared": [
        ([PYTHON, "-m", "ruff", "check", "scripts", "tests"], ROOT),
        ([PYTHON, "-m", "ruff", "format", "--check", "scripts", "tests"], ROOT),
    ],
    "frontend": [
        (_frontend_command("lint"), ROOT / "frontend"),
        (_frontend_command("typecheck"), ROOT / "frontend"),
        (_npx_command("prettier", "--check", "src"), ROOT / "frontend"),
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
        description="Run grouped lint, format, and typecheck commands."
    )
    parser.add_argument(
        "target",
        nargs="?",
        default="all",
        help="Check target: all, c0, c1, c2, c3, c4, shared, frontend",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Print the commands without running them.",
    )
    return parser.parse_args(argv)


def _resolve_target(name: str):
    canonical = TARGET_ALIASES.get(name, name)
    commands = CHECK_TARGETS.get(canonical)
    if commands is None:
        valid = ", ".join(sorted(CHECK_TARGETS))
        raise RuntimeError(f"Unknown check target `{name}`. Valid targets: {valid}")
    return canonical, commands


def main() -> int:
    args = _parse_args(sys.argv[1:])

    try:
        target, commands = _resolve_target(args.target)
    except RuntimeError as exc:
        print(f"[checks] {exc}", file=sys.stderr)
        return 1

    print("[checks] repo:", ROOT)
    print("[checks] target:", target)

    for command, cwd in commands:
        print("[checks] command:", " ".join(command))
        print("[checks] cwd:", cwd)
        if args.dry_run:
            continue
        result = subprocess.run(command, cwd=cwd)
        if result.returncode != 0:
            return result.returncode

    if args.dry_run:
        print("[checks] dry-run complete")
    else:
        print(f"[checks] check target `{target}` passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
