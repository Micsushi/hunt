#!/usr/bin/env python3
import argparse
import os
import platform
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


def _run(command, *, env=None):
    final_env = os.environ.copy()
    if env:
        final_env.update(env)

    print("[huntctl] Running:", " ".join(shlex.quote(str(part)) for part in command))
    raise SystemExit(subprocess.run(command, cwd=REPO_ROOT, env=final_env).returncode)


def _require_linux(command_name: str):
    if IS_WINDOWS:
        raise SystemExit(f"`{command_name}` is Linux/server-only.")


def cmd_auth_save(args):
    env = {}
    if args.display:
        env["DISPLAY"] = args.display
    _run(
        [
            PYTHON,
            "scraper/linkedin_session.py",
            "--save-storage-state",
            "--channel",
            args.channel,
            "--storage-state",
            args.storage_state,
        ],
        env=env,
    )


def cmd_auth_check(_args):
    _run([PYTHON, "scraper/linkedin_session.py", "--check"])


def cmd_scrape(args):
    command = [PYTHON, "scraper/scraper.py"]
    if args.limit is not None:
        command.extend(["--enrich-pending", "--enrich-limit", str(args.limit), "--channel", args.channel])
    if args.ui_verify_blocked:
        if "--enrich-pending" not in command:
            command.extend(["--enrich-pending", "--channel", args.channel])
        command.append("--ui-verify-blocked")
    if args.headful:
        command.append("--headful")
    if args.skip_enrichment:
        command.append("--skip-enrichment")
    _run(command)


def cmd_enrich(args):
    command = [PYTHON, "scraper/enrich_linkedin.py", "--channel", args.channel]
    if args.job_id is not None:
        command.extend(["--job-id", str(args.job_id)])
    if args.limit is not None:
        command.extend(["--limit", str(args.limit)])
    if args.force:
        command.append("--force")
    if args.ui_verify:
        command.append("--ui-verify")
    if args.ui_verify_blocked:
        command.append("--ui-verify-blocked")
    if args.headful:
        command.append("--headful")
    _run(command)


def cmd_queue(_args):
    _run([PYTHON, "scripts/queue_health.py"])


def cmd_list_status(args):
    command = [
        PYTHON,
        "scripts/list_linkedin_enrichment_queue.py",
        "--status",
        args.status,
        "--limit",
        str(args.limit),
    ]
    _run(command)


def cmd_job(args):
    _run([PYTHON, "scripts/show_linkedin_job.py", "--job-id", str(args.job_id)])


def cmd_verify(args):
    command = [PYTHON, "scripts/verify_stage2_job.py", "--job-id", str(args.job_id)]
    if args.expect_type:
        command.extend(["--expect-type", args.expect_type])
    _run(command)


def cmd_requeue_refresh(_args):
    _run([PYTHON, "scripts/requeue_linkedin_refresh_candidates.py"])


def cmd_backfill(args):
    command = [PYTHON, "scripts/backfill_linkedin.py", "--batch-size", str(args.batch_size)]
    if args.max_batches is not None:
        command.extend(["--max-batches", str(args.max_batches)])
    if args.channel:
        command.extend(["--channel", args.channel])
    if args.storage_state:
        command.extend(["--storage-state", args.storage_state])
    if args.timeout_ms is not None:
        command.extend(["--timeout-ms", str(args.timeout_ms)])
    if args.slow_mo is not None:
        command.extend(["--slow-mo", str(args.slow_mo)])
    if args.headful:
        command.append("--headful")
    if args.ui_verify_blocked:
        command.append("--ui-verify-blocked")
    if args.yes:
        command.append("--yes")
    _run(command)


def cmd_review(_args):
    _run([PYTHON, "review_app.py"])


def cmd_tests(args):
    if args.stage == "all":
        patterns = ["test_stage1.py", "test_stage2.py", "test_stage3.py"]
    else:
        patterns = [f"test_stage{args.stage}.py"]

    for pattern in patterns:
        result = subprocess.run(
            [PYTHON, "-m", "unittest", "discover", "-s", "tests", "-p", pattern, "-v"],
            cwd=REPO_ROOT,
        )
        if result.returncode != 0:
            raise SystemExit(result.returncode)

    raise SystemExit(0)


def cmd_runner(_args):
    _run([PYTHON, "scraper/runner.py"])


def cmd_service(args):
    _require_linux(args.command_name)
    mapping = {
        "svc-start": ["sudo", "systemctl", "start", "hunt-scraper.service"],
        "svc-stop": ["sudo", "systemctl", "stop", "hunt-scraper.service"],
        "svc-status": ["systemctl", "status", "hunt-scraper.service", "--no-pager"],
        "svc-log": ["journalctl", "-u", "hunt-scraper.service", "-n", str(args.lines), "--no-pager"],
        "svc-follow": ["journalctl", "-u", "hunt-scraper.service", "-f"],
        "timer-enable": ["sudo", "systemctl", "enable", "hunt-scraper.timer"],
        "timer-disable": ["sudo", "systemctl", "disable", "hunt-scraper.timer"],
        "timer-start": ["sudo", "systemctl", "start", "hunt-scraper.timer"],
        "timer-stop": ["sudo", "systemctl", "stop", "hunt-scraper.timer"],
        "timer-status": ["systemctl", "status", "hunt-scraper.timer", "--no-pager"],
        "xvfb-status": ["systemctl", "status", "hunt-xvfb.service", "--no-pager"],
        "review-health": [
            "docker",
            "exec",
            "hunt_review",
            "python",
            "-c",
            "import urllib.request; print(urllib.request.urlopen('http://127.0.0.1:8000/health').read().decode())",
        ],
    }
    _run(mapping[args.command_name])


def build_parser():
    parser = argparse.ArgumentParser(description="Short Hunt commands for local and server workflows.")
    subparsers = parser.add_subparsers(dest="command", required=True)

    auth_save = subparsers.add_parser("auth-save", help="Open Chrome and save LinkedIn auth state.")
    auth_save.add_argument("--display", default=None, help="Optional DISPLAY override, e.g. :0 on Linux.")
    auth_save.add_argument("--channel", default="chrome")
    auth_save.add_argument(
        "--storage-state",
        default=str(REPO_ROOT / ".state" / "linkedin_auth_state.json"),
    )
    auth_save.set_defaults(func=cmd_auth_save)

    auth_check = subparsers.add_parser("auth-check", help="Check whether LinkedIn auth state exists.")
    auth_check.set_defaults(func=cmd_auth_check)

    scrape = subparsers.add_parser("scrape", help="Run discovery, optionally with immediate enrichment.")
    scrape.add_argument("--limit", type=int, default=None, help="Run post-scrape enrichment for up to N rows.")
    scrape.add_argument("--channel", default="chrome")
    scrape.add_argument("--ui-verify-blocked", action="store_true")
    scrape.add_argument("--headful", action="store_true")
    scrape.add_argument("--skip-enrichment", action="store_true")
    scrape.set_defaults(func=cmd_scrape)

    enrich = subparsers.add_parser("enrich", help="Run direct LinkedIn enrichment commands.")
    enrich.add_argument("--job-id", type=int)
    enrich.add_argument("--limit", type=int)
    enrich.add_argument("--channel", default="chrome")
    enrich.add_argument("--force", action="store_true")
    enrich.add_argument("--ui-verify", action="store_true")
    enrich.add_argument("--ui-verify-blocked", action="store_true")
    enrich.add_argument("--headful", action="store_true")
    enrich.set_defaults(func=cmd_enrich)

    queue = subparsers.add_parser("queue", help="Show overall queue health.")
    queue.set_defaults(func=cmd_queue)

    for status_name in ("ready", "blocked", "failed", "done", "processing", "pending"):
        status_parser = subparsers.add_parser(status_name, help=f"List {status_name} LinkedIn rows.")
        status_parser.add_argument("--limit", type=int, default=10)
        status_parser.set_defaults(func=cmd_list_status, status=status_name)

    job = subparsers.add_parser("job", help="Show one LinkedIn job by id.")
    job.add_argument("job_id", type=int)
    job.set_defaults(func=cmd_job)

    verify = subparsers.add_parser("verify", help="Verify one enriched LinkedIn row.")
    verify.add_argument("job_id", type=int)
    verify.add_argument("--expect-type", default=None)
    verify.set_defaults(func=cmd_verify)

    requeue = subparsers.add_parser("requeue-refresh", help="Requeue sparse historical LinkedIn rows.")
    requeue.set_defaults(func=cmd_requeue_refresh)

    backfill = subparsers.add_parser("backfill", help="Run LinkedIn backfill in batches with a checkpoint after each batch.")
    backfill.add_argument("batch_size", type=int, nargs="?", default=100)
    backfill.add_argument("--max-batches", type=int, default=None)
    backfill.add_argument("--channel", default="chrome")
    backfill.add_argument("--storage-state", default=None)
    backfill.add_argument("--timeout-ms", type=int, default=45000)
    backfill.add_argument("--slow-mo", type=int, default=0)
    backfill.add_argument("--headful", action="store_true")
    backfill.add_argument("--ui-verify-blocked", action="store_true")
    backfill.add_argument("--yes", action="store_true")
    backfill.set_defaults(func=cmd_backfill)

    review = subparsers.add_parser("review", help="Run the local review app.")
    review.set_defaults(func=cmd_review)

    tests = subparsers.add_parser("tests", help="Run Hunt unit tests.")
    tests.add_argument("stage", choices=["1", "2", "3", "all"], default="all", nargs="?")
    tests.set_defaults(func=cmd_tests)

    runner = subparsers.add_parser("runner", help="Run the continuous local runner.")
    runner.set_defaults(func=cmd_runner)

    for service_command in (
        "svc-start",
        "svc-stop",
        "svc-status",
        "svc-log",
        "svc-follow",
        "timer-enable",
        "timer-disable",
        "timer-start",
        "timer-stop",
        "timer-status",
        "xvfb-status",
        "review-health",
    ):
        service_parser = subparsers.add_parser(service_command, help=f"Server helper: {service_command}.")
        service_parser.set_defaults(func=cmd_service, command_name=service_command, lines=200)
        if service_command == "svc-log":
            service_parser.add_argument("--lines", type=int, default=200)

    return parser


def main():
    parser = build_parser()
    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
