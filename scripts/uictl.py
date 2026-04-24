#!/usr/bin/env python3
"""
C0 (UI / control plane) operator CLI.

Keeps C0 entrypoints separate from `hunter` so `hunter ...` can stay C1-focused.
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
        candidates.extend(
            [
                REPO_ROOT / ".venv" / "bin" / "python",
                REPO_ROOT / "venv" / "bin" / "python",
            ]
        )
    for candidate in candidates:
        if candidate.exists():
            return str(candidate)
    return sys.executable


PYTHON = _find_repo_python()


def _run(argv: list[str]) -> None:
    print("[uictl] Running:", " ".join(shlex.quote(str(part)) for part in argv))
    raise SystemExit(subprocess.run(argv, cwd=REPO_ROOT).returncode)


def _frontend_dir() -> Path:
    return REPO_ROOT / "frontend"


def _run_npm_build() -> bool:
    frontend_dir = _frontend_dir()
    if not frontend_dir.is_dir():
        print("[uictl] frontend/ directory not found — skipping build.")
        return False
    print("[uictl] Building frontend (npm install && npm run build)…")
    for cmd in (["npm", "install"], ["npm", "run", "build"]):
        result = subprocess.run(cmd, cwd=frontend_dir)
        if result.returncode != 0:
            print(f"[uictl] Build step failed: {' '.join(cmd)}")
            return False
    print("[uictl] Frontend build complete.")
    return True


def cmd_build(_args) -> None:
    if not _run_npm_build():
        raise SystemExit(1)


def cmd_serve(args) -> None:
    dist_index = _frontend_dir() / "dist" / "index.html"
    should_build = args.build or not dist_index.is_file()
    if should_build:
        if not dist_index.is_file():
            print("[uictl] frontend/dist not found — running build first.")
        if not _run_npm_build():
            print("[uictl] Build failed. Start the server anyway (will show 503 for UI).")
    _run([PYTHON, "-m", "backend.app"])


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="C0 (UI / control plane) operator CLI.")
    sub = parser.add_subparsers(dest="command", required=True)

    serve = sub.add_parser("serve", help="Build the frontend if needed and start the C0 control plane.")
    serve.add_argument(
        "--build",
        action="store_true",
        help="Force a frontend build before starting the control plane.",
    )
    serve.set_defaults(func=cmd_serve)

    build = sub.add_parser("build", help="Compile the React frontend (frontend/ -> frontend/dist/).")
    build.set_defaults(func=cmd_build)

    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    args.func(args)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

