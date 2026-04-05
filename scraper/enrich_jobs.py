import argparse
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from db import ENRICHMENT_SOURCE_PRIORITY, count_ready_jobs_for_enrichment  # noqa: E402
from enrich_indeed import process_batch as process_indeed_batch  # noqa: E402
from enrich_linkedin import process_batch as process_linkedin_batch  # noqa: E402


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
    remaining = limit
    aggregate = {
        "exit_code": 0,
        "attempted": 0,
        "ui_verified": 0,
        "succeeded": 0,
        "failed": 0,
        "actionable_failed": 0,
        "failure_breakdown": {},
        "total_elapsed_seconds": 0.0,
        "average_seconds_per_job": 0.0,
        "stop_error_code": None,
        "by_source": {},
    }

    for source in ENRICHMENT_SOURCE_PRIORITY:
        if remaining <= 0:
            break

        ready_count = count_ready_jobs_for_enrichment(sources=(source,))
        if ready_count <= 0:
            continue

        source_limit = min(remaining, ready_count)
        print(f"[enrich] Dispatching up to {source_limit} {source} row(s).")

        if source == "linkedin":
            summary = process_linkedin_batch(
                limit=source_limit,
                storage_state_path=storage_state_path,
                headless=headless,
                slow_mo=slow_mo,
                timeout_ms=timeout_ms,
                browser_channel=browser_channel,
                ui_verify_blocked=ui_verify_blocked,
                return_summary=True,
            )
        elif source == "indeed":
            summary = process_indeed_batch(
                limit=source_limit,
                timeout_ms=timeout_ms,
                browser_channel=browser_channel,
                ui_verify_blocked=ui_verify_blocked,
                return_summary=True,
            )
        else:
            continue

        aggregate["by_source"][source] = summary
        aggregate["attempted"] += summary["attempted"]
        aggregate["ui_verified"] += summary["ui_verified"]
        aggregate["succeeded"] += summary["succeeded"]
        aggregate["failed"] += summary["failed"]
        aggregate["actionable_failed"] += summary["actionable_failed"]
        aggregate["total_elapsed_seconds"] += summary["total_elapsed_seconds"]
        for error_code, count in summary["failure_breakdown"].items():
            aggregate["failure_breakdown"][error_code] = aggregate["failure_breakdown"].get(error_code, 0) + count

        remaining -= summary["attempted"]
        if summary["stop_error_code"] and not aggregate["stop_error_code"]:
            aggregate["stop_error_code"] = summary["stop_error_code"]
            break

    if aggregate["attempted"]:
        aggregate["average_seconds_per_job"] = aggregate["total_elapsed_seconds"] / aggregate["attempted"]
    aggregate["exit_code"] = 0 if aggregate["actionable_failed"] == 0 else 1

    if return_summary:
        return aggregate
    return aggregate["exit_code"]


def main():
    parser = argparse.ArgumentParser(description="Run multi-source enrichment using the Stage 3.2 dispatcher.")
    parser.add_argument("--limit", type=int, default=25)
    parser.add_argument("--storage-state", help="Optional Playwright storage-state path for LinkedIn enrichment.")
    parser.add_argument("--headful", action="store_true", help="Run the LinkedIn first pass visibly.")
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
