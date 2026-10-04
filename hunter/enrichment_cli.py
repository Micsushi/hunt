"""Shared command-line arguments and dispatch for the existing enrichment workers."""

import argparse


def run_enrichment_cli(provider, process_one_job, process_batch):
    parser = argparse.ArgumentParser(description=f"Enrich jobs through {provider}.")
    parser.add_argument("--job-id", type=int, help="Specific saved job to enrich.")
    parser.add_argument("--limit", type=int, default=1, help="Maximum jobs to process.")
    parser.add_argument("--force", action="store_true", help="Reclaim the specified job.")
    browser = provider != "HiringCafe"
    if browser:
        parser.add_argument("--timeout-ms", type=int, default=45000)
        parser.add_argument("--channel", help="Optional browser channel such as chrome.")
        parser.add_argument(
            "--ui-verify", action="store_true", help="Verify one job in a visible browser."
        )
        parser.add_argument(
            "--ui-verify-blocked",
            action="store_true",
            help="Verify blocked batch jobs in a visible browser.",
        )
    if provider == "LinkedIn":
        parser.add_argument("--storage-state", help="Path to saved browser session JSON.")
        parser.add_argument("--headful", action="store_true", help="Use a visible browser.")
        parser.add_argument("--slow-mo", type=int, default=0)
    args = parser.parse_args()
    if args.force and args.job_id is None:
        parser.error("--force requires --job-id")
    if args.job_id is not None and args.limit != 1:
        parser.error("--limit cannot be used with --job-id")
    if args.limit < 1:
        parser.error("--limit must be at least 1")
    if browser:
        if args.ui_verify and args.job_id is None:
            parser.error("--ui-verify requires --job-id")
        if args.ui_verify_blocked and args.limit == 1:
            parser.error("--ui-verify-blocked requires --limit greater than 1")
        if args.ui_verify_blocked and args.job_id is not None:
            parser.error("--ui-verify-blocked cannot be used with --job-id")
    options = {}
    if browser:
        options.update(timeout_ms=args.timeout_ms, browser_channel=args.channel)
    if provider == "LinkedIn":
        options.update(
            storage_state_path=args.storage_state, headless=not args.headful, slow_mo=args.slow_mo
        )
        if args.ui_verify:
            if not args.headful:
                print("[enrich] --ui-verify implies a visible browser window; running headful.")
            options["headless"] = False
            args.force = True
    if args.limit > 1:
        if browser:
            options["ui_verify_blocked"] = args.ui_verify_blocked
        return process_batch(limit=args.limit, **options)
    if browser:
        options["ui_verify"] = args.ui_verify
    return process_one_job(job_id=args.job_id, force=args.force, **options)
