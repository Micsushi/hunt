#!/usr/bin/env python3
"""
C1 (Hunter) operator CLI : paths, auth, queue, C4 apply-prep, and related helpers.

The Hunt repo contains multiple components (C1–C4). Repo-root **`hunter`** launchers and this
script are scoped to **C1 (Hunter)** and shared operator glue, not the whole product.

On Linux servers, systemd units **hunt-scraper.service** / **hunt-scraper.timer** keep a legacy
name but run **C1 (Hunter)** : `python hunter/scraper.py` from the Hunt repo root. See **docs/NAMING.md**.
"""
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


def _get_default_runtime_env(
    base_env=None, *, repo_root=REPO_ROOT, home_dir=None, is_windows=IS_WINDOWS
):
    if is_windows:
        return {}

    env = base_env or os.environ
    runtime_dir_raw = env.get("HUNT_RUNTIME_DIR")
    if runtime_dir_raw:
        runtime_dir = Path(runtime_dir_raw).expanduser()
    else:
        home_path = Path(home_dir).expanduser() if home_dir else Path.home()
        if Path(repo_root).resolve() != (home_path / "hunt").resolve():
            return {}
        runtime_dir = home_path / "data" / "hunt"

    if not runtime_dir.exists():
        return {}

    defaults = {}
    if not env.get("HUNT_DB_PATH"):
        defaults["HUNT_DB_PATH"] = str(runtime_dir / "hunt.db")
    if not env.get("HUNT_ARTIFACTS_DIR"):
        defaults["HUNT_ARTIFACTS_DIR"] = str(runtime_dir / "artifacts")
    return defaults


def _run(command, *, env=None):
    final_env = os.environ.copy()
    if env:
        final_env.update(env)
    for key, value in _get_default_runtime_env(final_env).items():
        final_env.setdefault(key, value)

    print("[hunterctl] Running:", " ".join(shlex.quote(str(part)) for part in command))
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
            "hunter/linkedin_session.py",
            "--save-storage-state",
            "--channel",
            args.channel,
            "--storage-state",
            args.storage_state,
        ],
        env=env,
    )


def cmd_auth_check(_args):
    _run([PYTHON, "hunter/linkedin_session.py", "--check"])


def cmd_auth_auto_relogin(args):
    command = [
        PYTHON,
        "hunter/linkedin_session.py",
        "--auto-relogin",
        "--timeout-ms",
        str(args.timeout_ms),
    ]
    env = {}
    if args.display:
        env["DISPLAY"] = args.display
    if args.headful:
        command.append("--headful")
    if args.channel:
        command.extend(["--channel", args.channel])
    if args.storage_state:
        command.extend(["--storage-state", args.storage_state])
    _run(command, env=env)


def cmd_auth_test_discord(args):
    command = [
        PYTHON,
        "hunter/linkedin_session.py",
        "--test-discord-webhook",
        "--discord-message",
        args.message,
    ]
    _run(command)


def cmd_scrape(args):
    command = [PYTHON, "hunter/scraper.py"]
    if args.limit is not None:
        command.extend(
            ["--enrich-pending", "--enrich-limit", str(args.limit), "--channel", args.channel]
        )
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
    batch_limit = args.limit if args.limit is not None else args.batch
    if args.source == "linkedin":
        command = [PYTHON, "hunter/enrich_linkedin.py", "--channel", args.channel]
    elif args.source == "indeed":
        command = [PYTHON, "hunter/enrich_indeed.py", "--channel", args.channel]
    else:
        command = [PYTHON, "hunter/enrich_jobs.py", "--channel", args.channel]
    if args.job_id is not None:
        command.extend(["--job-id", str(args.job_id)])
    if batch_limit is not None:
        command.extend(["--limit", str(batch_limit)])
    if args.force and args.source != "all":
        command.append("--force")
    if args.ui_verify and args.source in {"linkedin", "indeed"}:
        command.append("--ui-verify")
    if args.ui_verify_blocked and args.source in {"linkedin", "indeed", "all"}:
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


def cmd_list_jobs(args):
    command = [
        PYTHON,
        "scripts/list_jobs.py",
        "--source",
        args.source,
        "--status",
        args.status,
        "--limit",
        str(args.limit),
        "--offset",
        str(args.offset),
        "--sort",
        args.sort,
        "--direction",
        args.direction,
    ]
    if args.query:
        command.extend(["--query", args.query])
    _run(command)


def cmd_job(args):
    command = [PYTHON, "scripts/show_job.py", str(args.job_id)]
    if args.full_description:
        command.append("--full-description")
    _run(command)


def cmd_job_linkedin(args):
    _run([PYTHON, "scripts/show_linkedin_job.py", "--job-id", str(args.job_id)])


def cmd_verify(args):
    command = [PYTHON, "scripts/verify_stage2_job.py", "--job-id", str(args.job_id)]
    if args.expect_type:
        command.extend(["--expect-type", args.expect_type])
    _run(command)


def cmd_requeue_refresh(_args):
    _run([PYTHON, "scripts/requeue_linkedin_refresh_candidates.py"])


def cmd_requeue_enrich(args):
    _run(_build_requeue_enrich_command(source=args.source, statuses=args.statuses))


def cmd_requeue_errors(args):
    if not args.error_codes:
        raise SystemExit("At least one --error-code is required.")
    command = [PYTHON, "scripts/requeue_enrichment_rows.py", "--source", args.source]
    for code in args.error_codes:
        command.extend(["--error-code", code])
    _run(command)


def cmd_cleanup_lane_mismatch(args):
    command = [PYTHON, "scripts/cleanup_lane_mismatch_rows.py"]
    if args.apply:
        command.append("--apply")
    if args.include_non_new:
        command.append("--include-non-new")
    if args.limit is not None:
        command.extend(["--limit", str(args.limit)])
    if getattr(args, "source", "all") and args.source != "all":
        command.extend(["--source", args.source])
    _run(command)


def cmd_backfill(args):
    _run(
        _build_backfill_command(
            batch_size=args.batch_size,
            source=args.source,
            max_batches=args.max_batches,
            channel=args.channel,
            storage_state=args.storage_state,
            timeout_ms=args.timeout_ms,
            slow_mo=args.slow_mo,
            headful=args.headful,
            ui_verify_blocked=args.ui_verify_blocked,
            job_ids=args.job_ids,
            yes=args.yes,
        )
    )


def cmd_retry(args):
    _run(_build_requeue_enrich_command(source="all", statuses=args.statuses))


def cmd_drain(args):
    _run(
        _build_backfill_command(
            batch_size=args.batch_size,
            source=args.source,
            max_batches=args.max_batches,
            channel=args.channel,
            storage_state=args.storage_state,
            timeout_ms=args.timeout_ms,
            slow_mo=args.slow_mo,
            headful=args.headful,
            ui_verify_blocked=not args.no_ui_verify_blocked,
            job_ids=args.job_ids,
            yes=not args.ask,
        )
    )


def _build_requeue_enrich_command(*, source, statuses=None):
    command = [PYTHON, "scripts/requeue_enrichment_rows.py", "--source", source]
    if statuses:
        for status in statuses:
            command.extend(["--status", status])
    return command


def _build_backfill_command(
    *,
    batch_size,
    source,
    max_batches=None,
    channel="chrome",
    storage_state=None,
    timeout_ms=45000,
    slow_mo=0,
    headful=False,
    ui_verify_blocked=False,
    job_ids=None,
    yes=False,
):
    command = [PYTHON, "scripts/backfill_enrichment.py", str(batch_size), "--source", source]
    if max_batches is not None:
        command.extend(["--max-batches", str(max_batches)])
    if channel:
        command.extend(["--channel", channel])
    if storage_state:
        command.extend(["--storage-state", storage_state])
    if timeout_ms is not None:
        command.extend(["--timeout-ms", str(timeout_ms)])
    if slow_mo is not None:
        command.extend(["--slow-mo", str(slow_mo)])
    if headful:
        command.append("--headful")
    if ui_verify_blocked:
        command.append("--ui-verify-blocked")
    if job_ids:
        for job_id in job_ids:
            command.extend(["--job-id", str(job_id)])
    if yes:
        command.append("--yes")
    return command


def cmd_review(_args):
    _run([PYTHON, "review_app.py"])


def cmd_apply_prep(args):
    command = [
        PYTHON,
        "-m",
        "coordinator.cli",
        "apply-prep",
        "--job-id",
        str(args.job_id),
        "--source-runtime",
        args.source_runtime,
    ]
    if args.embed_resume_data:
        command.append("--embed-resume-data")
    if args.output:
        raise SystemExit(
            "`hunterctl apply-prep --output` is no longer supported because the shared C4 apply-prep command writes its own runtime artifacts. "
            "Use `scripts/c3_apply_prep.py` directly if you need the legacy C3-only payload helper."
        )
    _run(command)


def cmd_tests(args):
    suites = {
        "1": ["test_stage1.py"],
        "2": ["test_stage2.py"],
        "3": ["test_stage3.py"],
        "32": ["test_stage32.py"],
        "4": ["test_stage4.py", "test_search_lanes.py"],
        "c2": ["test_component2_stage1.py", "test_component2_pipeline.py"],
        "c3": ["test_component3_stage1.py"],
        "c4": ["test_component4_cli.py"],
        "all": [
            "test_stage1.py",
            "test_stage2.py",
            "test_stage3.py",
            "test_stage32.py",
            "test_stage4.py",
            "test_search_lanes.py",
            "test_component2_stage1.py",
            "test_component2_pipeline.py",
            "test_component3_stage1.py",
            "test_component4_cli.py",
        ],
    }
    patterns = suites[args.stage]

    for pattern in patterns:
        result = subprocess.run(
            [PYTHON, "-m", "unittest", "discover", "-s", "tests", "-p", pattern, "-v"],
            cwd=REPO_ROOT,
        )
        if result.returncode != 0:
            raise SystemExit(result.returncode)

    raise SystemExit(0)


def cmd_runner(_args):
    _run([PYTHON, "hunter/runner.py"])


def cmd_start(args):
    """Enable scheduled C1 runs (Linux) or one local scrape cycle (Windows)."""
    if IS_WINDOWS:
        cmd_scrape(
            argparse.Namespace(
                limit=None,
                channel=args.channel,
                ui_verify_blocked=False,
                headful=False,
                skip_enrichment=False,
            )
        )
        return
    steps = [["sudo", "systemctl", "enable", "--now", "hunt-scraper.timer"]]
    _run_systemd_steps(steps)


def cmd_stop(args):
    """Stop the C1 timer (Linux). On Windows, no-op with a hint."""
    if IS_WINDOWS:
        raise SystemExit(
            "On Windows there is no Hunt systemd timer. "
            "Stop the terminal where `hunter runner` or `hunter review` is running."
        )
    _run_systemd_steps([["sudo", "systemctl", "disable", "--now", "hunt-scraper.timer"]])


def cmd_restart(args):
    """Reload units and restart Xvfb + scraper timer (Linux server)."""
    _require_linux("restart")
    steps = [
        ["sudo", "systemctl", "daemon-reload"],
        ["sudo", "systemctl", "restart", "hunt-xvfb.service"],
        ["sudo", "systemctl", "restart", "hunt-scraper.timer"],
    ]
    _run_systemd_steps(steps)


def _run_systemd_steps(steps):
    for step in steps:
        print("[hunterctl] Running:", " ".join(shlex.quote(str(p)) for p in step))
        result = subprocess.run(step, cwd=REPO_ROOT)
        if result.returncode != 0:
            raise SystemExit(result.returncode)
    raise SystemExit(0)


def cmd_service(args):
    _require_linux(args.command_name)
    mapping = {
        "auto-on": ["sudo", "systemctl", "enable", "--now", "hunt-scraper.timer"],
        "auto-off": ["sudo", "systemctl", "disable", "--now", "hunt-scraper.timer"],
        "auto-status": ["systemctl", "status", "hunt-scraper.timer", "--no-pager"],
        "svc-start": ["sudo", "systemctl", "start", "hunt-scraper.service"],
        "svc-stop": ["sudo", "systemctl", "stop", "hunt-scraper.service"],
        "svc-status": ["systemctl", "status", "hunt-scraper.service", "--no-pager"],
        "svc-log": [
            "journalctl",
            "-u",
            "hunt-scraper.service",
            "-n",
            str(args.lines),
            "--no-pager",
        ],
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
    parser = argparse.ArgumentParser(
        description="C1 (Hunter) operator CLI for local and server workflows."
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    auth_save = subparsers.add_parser("auth-save", help="Open Chrome and save LinkedIn auth state.")
    auth_save.add_argument(
        "--display", default=None, help="Optional DISPLAY override, e.g. :0 on Linux."
    )
    auth_save.add_argument("--channel", default="chrome")
    auth_save.add_argument(
        "--storage-state",
        default=str(REPO_ROOT / ".state" / "linkedin_auth_state.json"),
    )
    auth_save.set_defaults(func=cmd_auth_save)

    auth_check = subparsers.add_parser(
        "auth-check", help="Check whether LinkedIn auth state exists."
    )
    auth_check.set_defaults(func=cmd_auth_check)

    auth_auto = subparsers.add_parser(
        "auth-auto-relogin",
        help="Attempt a best-effort LinkedIn relogin using stored environment credentials.",
    )
    auth_auto.add_argument("--headful", action="store_true")
    auth_auto.add_argument(
        "--display", default=None, help="Optional DISPLAY override for headed relogin, e.g. :98."
    )
    auth_auto.add_argument("--channel", default="chrome")
    auth_auto.add_argument("--storage-state", default=None)
    auth_auto.add_argument("--timeout-ms", type=int, default=30000)
    auth_auto.set_defaults(func=cmd_auth_auto_relogin)

    auth_test_discord = subparsers.add_parser(
        "auth-test-discord",
        help="Send a test message through the configured Discord webhook.",
    )
    auth_test_discord.add_argument(
        "--message",
        default="Hunt test: Discord webhook connectivity check.",
    )
    auth_test_discord.set_defaults(func=cmd_auth_test_discord)

    scrape = subparsers.add_parser(
        "scrape", help="Run discovery, optionally with immediate enrichment."
    )
    scrape.add_argument(
        "--limit", type=int, default=None, help="Run post-scrape enrichment for up to N rows."
    )
    scrape.add_argument("--channel", default="chrome")
    scrape.add_argument("--ui-verify-blocked", action="store_true")
    scrape.add_argument("--headful", action="store_true")
    scrape.add_argument("--skip-enrichment", action="store_true")
    scrape.set_defaults(func=cmd_scrape)

    start = subparsers.add_parser(
        "start",
        help="Linux: enable and start hunt-scraper.timer. Windows: one scrape+enrich cycle.",
    )
    start.add_argument(
        "--channel",
        default="chrome",
        help="Windows only: passed to scrape when running a local cycle.",
    )
    start.set_defaults(func=cmd_start)

    stop = subparsers.add_parser(
        "stop",
        help="Linux: disable and stop hunt-scraper.timer (stops scheduled C1 runs).",
    )
    stop.set_defaults(func=cmd_stop)

    restart = subparsers.add_parser(
        "restart",
        help="Linux: daemon-reload, restart hunt-xvfb and hunt-scraper.timer (after unit or code changes).",
    )
    restart.set_defaults(func=cmd_restart)

    enrich = subparsers.add_parser(
        "enrich",
        help="Run enrichment for supported sources. Example: hunter enrich 50 --source all",
    )
    enrich.add_argument(
        "batch",
        type=int,
        nargs="?",
        default=None,
        metavar="N",
        help="Batch size (shortcut for --limit). Example: hunter enrich 50",
    )
    enrich.add_argument("--source", choices=["linkedin", "indeed", "all"], default="linkedin")
    enrich.add_argument("--job-id", type=int)
    enrich.add_argument("--limit", type=int, default=None)
    enrich.add_argument("--channel", default="chrome")
    enrich.add_argument("--force", action="store_true")
    enrich.add_argument("--ui-verify", action="store_true")
    enrich.add_argument("--ui-verify-blocked", action="store_true")
    enrich.add_argument("--headful", action="store_true")
    enrich.set_defaults(func=cmd_enrich)

    queue = subparsers.add_parser("queue", help="Show overall queue health.")
    queue.set_defaults(func=cmd_queue)

    jobs = subparsers.add_parser("jobs", help="List jobs with source/status filters.")
    jobs.add_argument("--source", choices=["all", "linkedin", "indeed"], default="all")
    jobs.add_argument(
        "--status",
        choices=[
            "ready",
            "pending",
            "processing",
            "done",
            "done_verified",
            "failed",
            "blocked",
            "blocked_verified",
            "all",
        ],
        default="ready",
    )
    jobs.add_argument("--limit", type=int, default=10)
    jobs.add_argument("--offset", type=int, default=0)
    jobs.add_argument("--query", default="")
    jobs.add_argument(
        "--sort",
        choices=[
            "id",
            "source",
            "company",
            "title",
            "enrichment_status",
            "apply_type",
            "enrichment_attempts",
            "next_enrichment_retry_at",
            "last_enrichment_error",
            "date_scraped",
            "enriched_at",
        ],
        default="date_scraped",
    )
    jobs.add_argument("--direction", choices=["asc", "desc"], default="desc")
    jobs.set_defaults(func=cmd_list_jobs)

    for status_name in ("ready", "blocked", "failed", "done", "processing", "pending"):
        status_parser = subparsers.add_parser(
            status_name, help=f"List {status_name} LinkedIn rows."
        )
        status_parser.add_argument("--limit", type=int, default=10)
        status_parser.set_defaults(func=cmd_list_status, status=status_name)

    job = subparsers.add_parser("job", help="Show one job by id.")
    job.add_argument("job_id", type=int)
    job.add_argument("--full-description", action="store_true")
    job.set_defaults(func=cmd_job)

    linkedin_job = subparsers.add_parser(
        "job-linkedin", help="Show one LinkedIn job by id using the old inspector."
    )
    linkedin_job.add_argument("job_id", type=int)
    linkedin_job.set_defaults(func=cmd_job_linkedin)

    verify = subparsers.add_parser("verify", help="Verify one enriched LinkedIn row.")
    verify.add_argument("job_id", type=int)
    verify.add_argument("--expect-type", default=None)
    verify.set_defaults(func=cmd_verify)

    requeue = subparsers.add_parser(
        "requeue-refresh", help="Requeue sparse historical LinkedIn rows."
    )
    requeue.set_defaults(func=cmd_requeue_refresh)

    requeue_enrich = subparsers.add_parser(
        "requeue-enrich",
        help="Bulk requeue failed/blocked enrichment rows back to pending.",
    )
    requeue_enrich.add_argument("--source", choices=["linkedin", "indeed", "all"], default="all")
    requeue_enrich.add_argument(
        "--status",
        action="append",
        dest="statuses",
        choices=["failed", "blocked", "blocked_verified", "processing", "pending"],
        help="Optional enrichment statuses to requeue. Defaults to failed + blocked + blocked_verified.",
    )
    requeue_enrich.set_defaults(func=cmd_requeue_enrich)

    requeue_errors = subparsers.add_parser(
        "requeue-errors",
        help="Requeue failed enrichment rows back to pending by last error code.",
    )
    requeue_errors.add_argument("--source", choices=["linkedin", "indeed", "all"], default="all")
    requeue_errors.add_argument(
        "--error-code",
        action="append",
        dest="error_codes",
        choices=["auth_expired", "rate_limited"],
        help="One or more error codes to requeue (matches last_enrichment_error prefix).",
        required=True,
    )
    requeue_errors.set_defaults(func=cmd_requeue_errors)

    retry = subparsers.add_parser(
        "retry",
        help="Short form: requeue failed/blocked enrichment rows across all sources.",
    )
    retry.add_argument(
        "--status",
        action="append",
        dest="statuses",
        choices=["failed", "blocked", "blocked_verified", "processing", "pending"],
        help="Optional enrichment statuses to requeue. Defaults to failed + blocked + blocked_verified.",
    )
    retry.set_defaults(func=cmd_retry)

    cleanup_lane = subparsers.add_parser(
        "cleanup-lane-mismatch",
        help="Preview or delete rows whose title does not match their discovery lane (all boards).",
        aliases=[
            "clean-lane-mismatch",
            "cleanup-indeed",
            "clean-indeed",
        ],
    )
    cleanup_lane.add_argument("--apply", action="store_true")
    cleanup_lane.add_argument("--include-non-new", action="store_true")
    cleanup_lane.add_argument("--limit", type=int, default=None)
    cleanup_lane.add_argument(
        "--source",
        choices=["linkedin", "indeed", "all"],
        default="all",
        help="Limit to one board (default: all sources).",
    )
    cleanup_lane.set_defaults(func=cmd_cleanup_lane_mismatch)

    backfill = subparsers.add_parser(
        "backfill", help="Run enrichment backfill in batches with a checkpoint after each batch."
    )
    backfill.add_argument("--source", choices=["linkedin", "indeed", "all"], default="linkedin")
    backfill.add_argument(
        "batch_size",
        type=int,
        nargs="?",
        default=25,
        help="Rows per batch (default 25; use a larger N for explicit bigger runs).",
    )
    backfill.add_argument("--job-id", type=int, action="append", dest="job_ids")
    backfill.add_argument("--max-batches", type=int, default=None)
    backfill.add_argument("--channel", default="chrome")
    backfill.add_argument("--storage-state", default=None)
    backfill.add_argument("--timeout-ms", type=int, default=45000)
    backfill.add_argument("--slow-mo", type=int, default=0)
    backfill.add_argument("--headful", action="store_true")
    backfill.add_argument("--ui-verify-blocked", action="store_true")
    backfill.add_argument("--yes", action="store_true")
    backfill.set_defaults(func=cmd_backfill)

    drain = subparsers.add_parser(
        "backfill-all",
        aliases=["drain"],
        help="Short form: backfill all sources in batches (default 25 rows) with UI verification and auto-continue.",
    )
    drain.add_argument(
        "batch_size",
        type=int,
        nargs="?",
        default=25,
        help="Rows per batch (default 25; pass e.g. 100 for larger explicit runs).",
    )
    drain.add_argument("--source", choices=["linkedin", "indeed", "all"], default="all")
    drain.add_argument("--job-id", type=int, action="append", dest="job_ids")
    drain.add_argument("--max-batches", type=int, default=None)
    drain.add_argument("--channel", default="chrome")
    drain.add_argument("--storage-state", default=None)
    drain.add_argument("--timeout-ms", type=int, default=45000)
    drain.add_argument("--slow-mo", type=int, default=0)
    drain.add_argument("--headful", action="store_true")
    drain.add_argument("--no-ui-verify-blocked", action="store_true")
    drain.add_argument("--ask", action="store_true")
    drain.set_defaults(func=cmd_drain)

    review = subparsers.add_parser("review", help="Run the local review app.")
    review.set_defaults(func=cmd_review)

    apply_prep = subparsers.add_parser(
        "apply-prep",
        help="Run the shared C4 apply-prep command for one job.",
    )
    apply_prep.add_argument("job_id", type=int)
    apply_prep.add_argument("--source-runtime", default="manual")
    apply_prep.add_argument("--embed-resume-data", action="store_true")
    apply_prep.add_argument("--output", default="")
    apply_prep.set_defaults(func=cmd_apply_prep)

    tests = subparsers.add_parser("tests", help="Run Hunt unit tests by stage or component.")
    tests.add_argument(
        "stage",
        choices=["1", "2", "3", "32", "4", "c2", "c3", "c4", "all"],
        default="all",
        nargs="?",
    )
    tests.set_defaults(func=cmd_tests)

    runner = subparsers.add_parser("runner", help="Run the continuous local runner.")
    runner.set_defaults(func=cmd_runner)

    for service_command in (
        "auto-on",
        "auto-off",
        "auto-status",
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
        service_parser = subparsers.add_parser(
            service_command, help=f"Server helper: {service_command}."
        )
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
