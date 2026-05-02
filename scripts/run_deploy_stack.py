#!/usr/bin/env python3
"""Run Hunt Docker Compose service bundles with one cross-platform command."""

from __future__ import annotations

import argparse
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
COMPOSE_FILE = ROOT / "docker-compose.pipeline.yml"
SERVER_COMPOSE_FILE = ROOT / "docker-compose.server.yml"
LOCAL_DEPLOY_TARGETS = {
    "db": ("postgres",),
    "c0": ("review", "frontend"),
    "c1": ("review", "frontend", "hunter"),
    "c2": ("review", "frontend", "ollama", "ollama-init", "fletcher"),
    "c4": ("review", "frontend", "coordinator"),
    "c1c2": ("review", "frontend", "hunter", "ollama", "ollama-init", "fletcher"),
    "all": (
        "review",
        "frontend",
        "hunter",
        "ollama",
        "ollama-init",
        "fletcher",
        "coordinator",
    ),
}
TARGET_ALIASES = {
    "full": "all",
    "backend": "c0",
    "hunter": "c1",
    "fletcher": "c2",
    "coordinator": "c4",
    "pipeline": "all",
}
SERVER_DEPLOY_TARGETS = {
    "db": ("postgres",),
    "c0": ("postgres", "review", "frontend"),
    "c1": ("postgres", "review", "frontend", "hunter", "hunter-scheduler"),
    "c2": ("postgres", "review", "frontend", "fletcher"),
    "c4": ("postgres", "review", "frontend", "coordinator"),
    "c1c2": (
        "postgres",
        "review",
        "frontend",
        "hunter",
        "hunter-scheduler",
        "fletcher",
    ),
    "all": (
        "postgres",
        "review",
        "frontend",
        "hunter",
        "hunter-scheduler",
        "fletcher",
        "coordinator",
    ),
}


def _parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Deploy Hunt Docker Compose service bundles.")
    parser.add_argument(
        "target",
        nargs="?",
        default="all",
        help="Deploy target: db, c0, c1, c2, c4, c1c2, all",
    )
    parser.add_argument(
        "--project-name",
        default="hunt",
        help="Compose project name. Default: hunt",
    )
    parser.add_argument(
        "--mode",
        choices=("local", "server"),
        default="local",
        help="Deploy shape. local uses only docker-compose.pipeline.yml. server adds docker-compose.server.yml overrides.",
    )
    parser.add_argument(
        "--env-file",
        default=None,
        help="Optional docker compose --env-file path. Useful for server deploys.",
    )
    parser.add_argument(
        "--no-build",
        action="store_true",
        help="Skip docker compose --build during deploy.",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Print the docker compose command without running it.",
    )
    parser.add_argument(
        "--stop",
        action="store_true",
        help="Stop the target services instead of starting them.",
    )
    parser.add_argument(
        "--restart",
        action="store_true",
        help="Restart the target services instead of starting them.",
    )
    parser.add_argument(
        "--logs",
        action="store_true",
        help="Show logs for the target services instead of starting them.",
    )
    parser.add_argument(
        "--ps",
        action="store_true",
        help="Show container status for the project instead of starting it.",
    )
    return parser.parse_args(argv)


def _resolve_target(name: str, *, mode: str) -> tuple[str, tuple[str, ...]]:
    canonical = TARGET_ALIASES.get(name, name)
    targets = SERVER_DEPLOY_TARGETS if mode == "server" else LOCAL_DEPLOY_TARGETS
    services = targets.get(canonical)
    if services is None:
        valid = ", ".join(sorted(targets))
        raise RuntimeError(f"Unknown deploy target `{name}`. Valid targets: {valid}")
    return canonical, services


def _resolve_action(args: argparse.Namespace) -> str:
    chosen = [args.stop, args.restart, args.logs, args.ps]
    if sum(bool(item) for item in chosen) > 1:
        raise RuntimeError("Choose only one of: --stop, --restart, --logs, --ps")
    if args.stop:
        return "stop"
    if args.restart:
        return "restart"
    if args.logs:
        return "logs"
    if args.ps:
        return "ps"
    return "up"


def _build_command(
    *,
    action: str,
    project_name: str,
    mode: str,
    env_file: str | None,
    services: tuple[str, ...],
    build: bool,
) -> list[str]:
    command = [
        "docker",
        "compose",
        "-p",
        project_name,
    ]
    if env_file:
        command.extend(["--env-file", env_file])
    command.extend(["-f", str(COMPOSE_FILE)])
    if mode == "server":
        command.extend(["-f", str(SERVER_COMPOSE_FILE)])

    if action == "up":
        command.extend(["up", "-d"])
        if build:
            command.append("--build")
        command.extend(services)
        return command

    command.append(action)
    if action != "ps":
        command.extend(services)
    return command


def main() -> int:
    args = _parse_args(sys.argv[1:])

    try:
        target, services = _resolve_target(args.target, mode=args.mode)
        action = _resolve_action(args)
    except RuntimeError as exc:
        print(f"[deploy] {exc}", file=sys.stderr)
        return 1

    command = _build_command(
        action=action,
        project_name=args.project_name,
        mode=args.mode,
        env_file=args.env_file,
        services=services,
        build=not args.no_build,
    )

    print("[deploy] repo:", ROOT)
    print("[deploy] mode:", args.mode)
    print("[deploy] target:", target)
    print("[deploy] action:", action)
    print("[deploy] services:", ", ".join(services))
    print("[deploy] command:", " ".join(command))

    if args.dry_run:
        print("[deploy] dry-run complete")
        return 0

    result = subprocess.run(command, cwd=ROOT)
    return result.returncode


if __name__ == "__main__":
    raise SystemExit(main())
