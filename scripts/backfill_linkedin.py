#!/usr/bin/env python3
import argparse
import os
import sys


REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SCRAPER_DIR = os.path.join(REPO_ROOT, "scraper")
sys.path.insert(0, SCRAPER_DIR)

from db import get_linkedin_queue_summary  # noqa: E402
from enrich_linkedin import process_batch  # noqa: E402


def _is_interactive():
    return sys.stdin.isatty() and sys.stdout.isatty()


def _prompt_continue():
    while True:
        answer = input("[backfill] Continue with next batch? [Y/n] ").strip().lower()
        if answer in ("", "y", "yes"):
            return True
        if answer in ("n", "no"):
            return False
        print("[backfill] Please answer y or n.")


def main():
    parser = argparse.ArgumentParser(
        description="Run LinkedIn enrichment backfill in batches with an operator checkpoint after each batch."
    )
    parser.add_argument("batch_size", type=int, nargs="?", default=100, help="Rows to process per batch.")
    parser.add_argument("--max-batches", type=int, default=0, help="Optional max number of batches; 0 means no limit.")
    parser.add_argument("--storage-state", help="Override LinkedIn storage state path.")
    parser.add_argument("--channel", default=None, help="Playwright browser channel, e.g. chrome.")
    parser.add_argument("--timeout-ms", type=int, default=45000)
    parser.add_argument("--slow-mo", type=int, default=0)
    parser.add_argument("--headful", action="store_true", help="Use a visible browser for the first pass too.")
    parser.add_argument(
        "--ui-verify-blocked",
        action="store_true",
        help="After each batch, rerun blocked jobs in a visible browser.",
    )
    parser.add_argument(
        "--yes",
        action="store_true",
        help="Do not prompt between batches; continue automatically unless a hard-stop condition occurs.",
    )
    args = parser.parse_args()

    if args.batch_size < 1:
        parser.error("--batch-size must be at least 1")
    if args.max_batches < 0:
        parser.error("--max-batches cannot be negative")

    batch_number = 0

    while True:
        if args.max_batches and batch_number >= args.max_batches:
            print(f"[backfill] Reached max_batches={args.max_batches}; stopping.")
            return 0

        before = get_linkedin_queue_summary()
        ready_before = before["ready_count"]
        if ready_before <= 0:
            print("[backfill] No ready LinkedIn rows remain.")
            return 0

        batch_number += 1
        print(
            f"\n[backfill] Batch {batch_number} starting "
            f"(ready={ready_before}, pending={before['pending_count']}, blocked={before['blocked_count']})."
        )

        summary = process_batch(
            limit=args.batch_size,
            storage_state_path=args.storage_state,
            headless=not args.headful,
            slow_mo=args.slow_mo,
            timeout_ms=args.timeout_ms,
            browser_channel=args.channel,
            ui_verify_blocked=args.ui_verify_blocked,
            return_summary=True,
        )

        after = get_linkedin_queue_summary()
        ready_after = after["ready_count"]
        drained = max(0, ready_before - ready_after)

        print(
            "[backfill] Checkpoint: "
            f"attempted={summary['attempted']}, "
            f"succeeded={summary['succeeded']}, "
            f"failed={summary['failed']}, "
            f"actionable_failed={summary['actionable_failed']}, "
            f"ready_before={ready_before}, "
            f"ready_after={ready_after}, "
            f"drained={drained}, "
            f"stop_error={summary['stop_error_code'] or 'none'}"
        )

        if summary["failure_breakdown"]:
            print("[backfill] Failure breakdown:")
            for error_code, count in sorted(summary["failure_breakdown"].items()):
                print(f"  {error_code}: {count}")

        if summary["stop_error_code"]:
            print(f"[backfill] Stopping because a hard-stop error occurred: {summary['stop_error_code']}")
            return 1

        if summary["attempted"] == 0:
            print("[backfill] Batch made no claims; stopping.")
            return 0

        if ready_after <= 0:
            print("[backfill] Queue is drained.")
            return 0

        if args.yes:
            continue

        if _is_interactive():
            if not _prompt_continue():
                print("[backfill] Stopped by operator.")
                return 0
            continue

        print("[backfill] Non-interactive shell detected; stopping after one batch.")
        return summary["exit_code"]


if __name__ == "__main__":
    raise SystemExit(main())
