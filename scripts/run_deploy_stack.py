#!/usr/bin/env python3
"""Run Hunt Docker Compose service bundles with one cross-platform command."""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

from scripts.resource_profiles import select_resource_profile

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
        "hunter-scheduler",
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
    "c2": ("postgres", "review", "frontend", "ollama", "ollama-init", "fletcher"),
    "c4": ("postgres", "review", "frontend", "coordinator"),
    "c1c2": (
        "postgres",
        "review",
        "frontend",
        "hunter",
        "hunter-scheduler",
        "ollama",
        "ollama-init",
        "fletcher",
    ),
    "all": (
        "postgres",
        "review",
        "frontend",
        "hunter",
        "hunter-scheduler",
        "ollama",
        "ollama-init",
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
    parser.add_argument(
        "--resource-profile",
        choices=("auto", "fast", "balanced", "safe", "cpu"),
        default="auto",
        help="C2/Ollama resource profile. auto detects GPU VRAM. Default: auto.",
    )
    parser.add_argument(
        "--no-prewarm",
        action="store_true",
        help="Skip deploy-time Ollama prewarm for keep-alive C2 profiles.",
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


def _needs_c2_resources(services: tuple[str, ...]) -> bool:
    return bool({"ollama", "ollama-init", "fletcher"} & set(services))


def _has_local_ollama(services: tuple[str, ...]) -> bool:
    return "ollama" in services


def _ollama_keep_alive_payload(value: str) -> str | int:
    value = (value or "").strip()
    if value in {"-1", "0"} or value.isdigit():
        return int(value)
    return value


def _post_json(url: str, payload: dict[str, object], *, timeout: float) -> dict[str, object]:
    req = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        body = json.load(resp)
    return body if isinstance(body, dict) else {}


def _prewarm_ollama(deploy_env: dict[str, str]) -> bool:
    host = deploy_env.get("HUNT_OLLAMA_PREWARM_HOST", "http://127.0.0.1:11435").rstrip("/")
    chat_model = deploy_env.get("HUNT_OLLAMA_MODEL", "gemma4:e4b")
    embed_model = deploy_env.get("HUNT_OLLAMA_EMBED_MODEL", "mxbai-embed-large")
    keep_alive = _ollama_keep_alive_payload(deploy_env.get("HUNT_OLLAMA_KEEP_ALIVE", "-1"))
    chat_payload = {
        "model": chat_model,
        "format": "json",
        "stream": False,
        "keep_alive": keep_alive,
        "messages": [
            {"role": "system", "content": "Return JSON only."},
            {"role": "user", "content": 'Return {"ok": true}.'},
        ],
    }
    embed_payload = {
        "model": embed_model,
        "prompt": "warmup",
        "keep_alive": keep_alive,
    }

    last_error = ""
    for attempt in range(1, 13):
        try:
            print(f"[deploy] prewarm_ollama: attempt={attempt} host={host}")
            _post_json(f"{host}/api/chat", chat_payload, timeout=180)
            _post_json(f"{host}/api/embeddings", embed_payload, timeout=60)
            print(f"[deploy] prewarm_ollama: ok chat_model={chat_model} embed_model={embed_model}")
            return True
        except (OSError, TimeoutError, urllib.error.URLError, urllib.error.HTTPError) as exc:
            last_error = str(exc) or exc.__class__.__name__
            print(f"[deploy] prewarm_ollama: waiting error={last_error[:200]}")
            time.sleep(min(5, attempt))
    print(f"[deploy] prewarm_ollama: failed error={last_error[:200]}", file=sys.stderr)
    return False


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

    deploy_env = None
    selection = None
    if _needs_c2_resources(services):
        selection = select_resource_profile(args.resource_profile)
        deploy_env = {**os.environ, **selection.env}
        print("[deploy] resource_profile_requested:", selection.requested)
        print("[deploy] resource_profile:", selection.selected)
        print("[deploy] resource_profile_reason:", selection.reason)
        print(
            "[deploy] gpu_vram_mb:",
            selection.gpu_vram_mb if selection.gpu_vram_mb is not None else "unknown",
        )
        for key in sorted(selection.env):
            print(f"[deploy] {key}={selection.env[key]}")
    else:
        print("[deploy] resource_profile: not_applicable")
    print("[deploy] command:", " ".join(command))

    if args.dry_run:
        print("[deploy] dry-run complete")
        return 0

    result = subprocess.run(command, cwd=ROOT, env=deploy_env)
    if result.returncode != 0:
        return result.returncode

    should_prewarm = (
        selection is not None
        and not args.no_prewarm
        and action in {"up", "restart"}
        and args.mode == "local"
        and _has_local_ollama(services)
        and (deploy_env or {}).get("HUNT_OLLAMA_KEEP_ALIVE") == "-1"
    )
    if should_prewarm:
        if not _prewarm_ollama(deploy_env or os.environ.copy()):
            return 1
    elif selection is not None:
        print("[deploy] prewarm_ollama: skipped")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
