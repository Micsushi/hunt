import argparse
import os
import sys

if __package__ is None or __package__ == "":
    sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from hunter.enrichment_dispatch import run_enrichment_round  # noqa: E402


def process_multi_source_batch(
    *,
    limit,
    storage_state_path=None,
    headless=True,
    slow_mo=0,
    timeout_ms=45000,
    browser_channel=None,
    ui_verify_blocked=False,
    return_summary=False,
):
    """
    Run one enrichment round across sources (see `hunter.enrichment_dispatch`).
    Rows are claimed by `jobs.source`; order and auth gates are centralized there.
    """
    return run_enrichment_round(
        limit=limit,
        storage_state_path=storage_state_path,
        headless=headless,
        slow_mo=slow_mo,
        timeout_ms=timeout_ms,
        browser_channel=browser_channel,
        ui_verify_blocked=ui_verify_blocked,
        return_summary=return_summary,
    )


def main():
    parser = argparse.ArgumentParser(
        description="Run multi-source enrichment using the Stage 3.2 dispatcher."
    )
    parser.add_argument("--limit", type=int, default=25)
    parser.add_argument(
        "--storage-state", help="Optional Playwright storage-state path for LinkedIn enrichment."
    )
    parser.add_argument(
        "--headful", action="store_true", help="Run the LinkedIn first pass visibly."
    )
    parser.add_argument("--slow-mo", type=int, default=0)
    parser.add_argument("--timeout-ms", type=int, default=45000)
    parser.add_argument("--channel", help="Optional Playwright browser channel such as chrome.")
    parser.add_argument("--ui-verify-blocked", action="store_true")
    args = parser.parse_args()

    if args.limit < 1:
        parser.error("--limit must be at least 1")

    return process_multi_source_batch(
        limit=args.limit,
        storage_state_path=args.storage_state,
        headless=not args.headful,
        slow_mo=args.slow_mo,
        timeout_ms=args.timeout_ms,
        browser_channel=args.channel,
        ui_verify_blocked=args.ui_verify_blocked,
    )


if __name__ == "__main__":
    raise SystemExit(main())
