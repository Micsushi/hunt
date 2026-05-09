#!/usr/bin/env python3
"""C3 (Executioner) extension quality, format, and test helpers."""

from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
EXECUTIONER_ROOT = ROOT / "executioner"
FRONTEND_ROOT = ROOT / "frontend"


def _resolve_exec(name: str) -> str:
    if os.name == "nt":
        resolved = shutil.which(f"{name}.cmd")
        if resolved:
            return resolved
    return shutil.which(name) or name


def _js_files() -> list[Path]:
    return sorted((EXECUTIONER_ROOT / "src").rglob("*.js"))


def _run(command: list[str], *, cwd: Path = ROOT, dry_run: bool = False) -> int:
    print("[executioner] command:", " ".join(command))
    print("[executioner] cwd:", cwd)
    if dry_run:
        return 0
    return subprocess.run(command, cwd=cwd).returncode


def lint(*, dry_run: bool = False) -> int:
    node = _resolve_exec("node")
    for path in _js_files():
        result = _run([node, "--check", str(path)], dry_run=dry_run)
        if result != 0:
            return result
    return 0


def format_check(*, dry_run: bool = False) -> int:
    npx = _resolve_exec("npx")
    return _run(
        [npx, "prettier", "--check", "../executioner/src"],
        cwd=FRONTEND_ROOT,
        dry_run=dry_run,
    )


def format_write(*, dry_run: bool = False) -> int:
    npx = _resolve_exec("npx")
    return _run(
        [npx, "prettier", "--write", "../executioner/src"],
        cwd=FRONTEND_ROOT,
        dry_run=dry_run,
    )


def quality(*, dry_run: bool = False) -> int:
    for step in (lint, format_check):
        result = step(dry_run=dry_run)
        if result != 0:
            return result
    return 0


def test(*, dry_run: bool = False) -> int:
    return _run([sys.executable, "test.py", "c3"], dry_run=dry_run)


def ci(*, dry_run: bool = False) -> int:
    for step in (quality, test):
        result = step(dry_run=dry_run)
        if result != 0:
            return result
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "command",
        choices=[
            "quality",
            "lint",
            "format-check",
            "format",
            "test",
            "ci",
            "style",
            "style-fix",
        ],
        help="C3 extension quality command.",
    )
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args(argv)

    print("[executioner] repo:", ROOT)
    if args.command == "quality":
        return quality(dry_run=args.dry_run)
    if args.command == "lint":
        return lint(dry_run=args.dry_run)
    if args.command in {"format-check", "style"}:
        return format_check(dry_run=args.dry_run)
    if args.command in {"format", "style-fix"}:
        return format_write(dry_run=args.dry_run)
    if args.command == "test":
        return test(dry_run=args.dry_run)
    return ci(dry_run=args.dry_run)


if __name__ == "__main__":
    raise SystemExit(main())
