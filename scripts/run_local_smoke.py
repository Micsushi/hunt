#!/usr/bin/env python3
"""Run local smoke tests with one command on Linux and Windows."""

from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import sys
from pathlib import Path

from hunter.notifications import send_discord_webhook_message

ROOT = Path(__file__).resolve().parent.parent
SMOKE_TARGETS = {
    "all": (
        "scripts/smoke_pipeline_compose.sh",
        "scripts/smoke_c0_pipeline_container.sh",
        "scripts/smoke_coordinator_e2e.sh",
    ),
    "c0": ("scripts/smoke_c0_pipeline_container.sh",),
    "c1": ("scripts/smoke_hunter_container.sh",),
    "c2": ("scripts/smoke_fletcher_container.sh",),
    "c4": ("scripts/smoke_coordinator_e2e.sh",),
    "c4-container": ("scripts/smoke_coordinator_container.sh",),
    "review": ("scripts/smoke_review_container.sh",),
    "server2": ("scripts/smoke_server2.sh",),
}
TARGET_ALIASES = {
    "full": "all",
    "coordinator": "c4",
    "hunter": "c1",
    "fletcher": "c2",
}


def _is_windows_bash_launcher(path: str) -> bool:
    normalized = path.replace("/", "\\").lower()
    return normalized.endswith("\\windows\\system32\\bash.exe")


def _find_git_bash() -> str | None:
    candidates = (
        r"C:\Program Files\Git\bin\bash.exe",
        r"C:\Program Files\Git\usr\bin\bash.exe",
        r"C:\Program Files (x86)\Git\bin\bash.exe",
        r"C:\Program Files (x86)\Git\usr\bin\bash.exe",
    )
    for candidate in candidates:
        if Path(candidate).is_file():
            return candidate
    return None


def _parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Run Hunt smoke tests with one cross-platform command."
    )
    parser.add_argument(
        "target",
        nargs="?",
        default="all",
        help="Smoke target: all, c0, c1, c2, c4, c4-container, review, server2",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Print the commands that would run without starting containers.",
    )
    parser.add_argument(
        "--existing",
        action="store_true",
        help="Skip container startup; run checks against the already-running stack.",
    )
    return parser.parse_args(argv)


def _resolve_runner() -> list[str]:
    if os.name != "nt":
        return ["bash"]

    git_bash = _find_git_bash()
    if git_bash:
        return [git_bash]

    bash_path = shutil.which("bash")
    if bash_path and not _is_windows_bash_launcher(bash_path):
        return [bash_path]

    wsl_path = shutil.which("wsl")
    if wsl_path:
        return [wsl_path, "bash"]

    raise RuntimeError(
        "Windows smoke runner needs Git Bash or a working WSL distro. "
        "The Microsoft launcher at C:\\Windows\\System32\\bash.exe is not usable here. "
        "Install Git Bash or finish WSL setup, then retry `python smoke.py`."
    )


def _resolve_target(name: str) -> tuple[str, tuple[str, ...]]:
    canonical = TARGET_ALIASES.get(name, name)
    scripts = SMOKE_TARGETS.get(canonical)
    if scripts is None:
        valid = ", ".join(sorted(SMOKE_TARGETS))
        raise RuntimeError(f"Unknown smoke target `{name}`. Valid targets: {valid}")
    return canonical, scripts


def _notify_smoke_failure(*, target: str, script: str, exit_code: int) -> None:
    message = (
        f"Hunt smoke failed: target={target} script={script} exit_code={exit_code} repo={ROOT}"
    )
    send_discord_webhook_message(message, username="Hunt Smoke")


def main() -> int:
    """Entry point: resolve runner + target, then execute smoke scripts."""
    args = _parse_args(sys.argv[1:])

    try:
        runner = _resolve_runner()
        target, scripts = _resolve_target(args.target)
    except RuntimeError as exc:
        print(f"[local-smoke] {exc}", file=sys.stderr)
        return 1

    print("[local-smoke] repo:", ROOT)
    print("[local-smoke] runner:", " ".join(runner))
    print("[local-smoke] target:", target)

    for script in scripts:
        print()
        print(f"[local-smoke] running {script}")
        if args.dry_run:
            extra = " --existing" if args.existing else ""
            print(f"[local-smoke] dry-run: {' '.join([*runner, script])}{extra}")
            continue
        extra_args = ["--existing"] if args.existing else []
        completed = subprocess.run([*runner, script, *extra_args], cwd=ROOT, check=False)
        if completed.returncode != 0:
            _notify_smoke_failure(
                target=target,
                script=script,
                exit_code=completed.returncode,
            )
            print(
                f"[local-smoke] FAILED at {script} with exit code {completed.returncode}",
                file=sys.stderr,
            )
            return completed.returncode
        print(f"[local-smoke] passed {script}")

    print()
    if args.dry_run:
        print("[local-smoke] dry-run complete")
    else:
        print(f"[local-smoke] smoke target `{target}` passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
