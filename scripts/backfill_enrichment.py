#!/usr/bin/env python3
import argparse
import os
import sys

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, REPO_ROOT)

from hunter.db import (  # noqa: E402
    get_job_by_id,
    get_linkedin_auth_state,
    get_review_queue_summary,
)
from hunter.enrich_indeed import process_batch as process_indeed_batch  # noqa: E402
from hunter.enrich_indeed import process_one_job as process_indeed_one  # noqa: E402
from hunter.enrich_jobs import process_multi_source_batch  # noqa: E402
from hunter.enrich_linkedin import process_batch as process_linkedin_batch  # noqa: E402
from hunter.enrich_linkedin import process_one_job as process_linkedin_one  # noqa: E402

BROWSER_FALLBACK_ERROR_CODES = {"description_not_found", "rate_limited", "unexpected_error"}


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


def _split_error_code(message):
    if not message:
        return None
    return message.split(":", 1)[0].strip()


def _is_done_status(status):
    return status in {"done", "done_verified"}


def _selected_job_needs_browser_retry(row):
    if not row:
        return False
    status = row.get("enrichment_status")
    error_code = _split_error_code(row.get("last_enrichment_error"))
    if row.get("source") == "linkedin":
        return status == "blocked"
    if row.get("source") == "indeed":
        return error_code in BROWSER_FALLBACK_ERROR_CODES
    return False


def _process_single_selected_job(job_id, args):
    row = get_job_by_id(job_id)
    if not row:
        print(f"[backfill] Skipping unknown job id={job_id}.")
        return {
            "status": "failed",
            "job_id": job_id,
            "error_code": "job_not_found",
            "error": "job_not_found: No matching row exists.",
        }

    source = row.get("source")
    if args.source != "all" and source != args.source:
        print(
            f"[backfill] Skipping job id={job_id} because source={source} does not match source={args.source}."
        )
        return {
            "status": "failed",
            "job_id": job_id,
            "error_code": "source_mismatch",
            "error": "source_mismatch: Row source does not match requested backfill source.",
        }

    if source == "linkedin":
        exit_code = process_linkedin_one(
            job_id=job_id,
            storage_state_path=args.storage_state,
            headless=not args.headful,
            slow_mo=args.slow_mo,
            timeout_ms=args.timeout_ms,
            browser_channel=args.channel,
            force=True,
            ui_verify=False,
        )
    elif source == "indeed":
        exit_code = process_indeed_one(
            job_id=job_id,
            timeout_ms=args.timeout_ms,
            force=True,
            browser_channel=args.channel,
            ui_verify=False,
        )
    else:
        print(f"[backfill] Skipping unsupported source={source} for job id={job_id}.")
        return {
            "status": "failed",
            "job_id": job_id,
            "error_code": "unsupported_source",
            "error": "unsupported_source: No enrichment worker exists for this source.",
        }

    updated = get_job_by_id(job_id)
    if args.ui_verify_blocked and _selected_job_needs_browser_retry(updated):
        if source == "linkedin":
            exit_code = process_linkedin_one(
                job_id=job_id,
                storage_state_path=args.storage_state,
                headless=False,
                slow_mo=args.slow_mo,
                timeout_ms=args.timeout_ms,
                browser_channel=args.channel,
                force=True,
                ui_verify=True,
            )
        elif source == "indeed":
            exit_code = process_indeed_one(
                job_id=job_id,
                timeout_ms=args.timeout_ms,
                force=True,
                browser_channel=args.channel,
                ui_verify=True,
            )
        updated = get_job_by_id(job_id)

    if updated and _is_done_status(updated.get("enrichment_status")) and exit_code == 0:
        return {"status": "success", "job_id": job_id}

    if source == "linkedin":
        auth_state = get_linkedin_auth_state()
        if not auth_state.get("available"):
            error_message = (
                auth_state.get("last_error") or "auth_expired: LinkedIn auth needs to be refreshed."
            )
            return {
                "status": "failed",
                "job_id": job_id,
                "error": error_message,
                "error_code": "auth_expired",
            }

    error_message = (
        updated.get("last_enrichment_error")
        if updated
        else "unexpected_error: No row returned after processing."
    )
    return {
        "status": "failed",
        "job_id": job_id,
        "error": error_message,
        "error_code": _split_error_code(error_message) or "unexpected_error",
    }


def _summarize_selected_results(results):
    successes = [result for result in results if result["status"] == "success"]
    failures = [result for result in results if result["status"] == "failed"]
    failure_breakdown = {}
    for failure in failures:
        error_code = failure.get("error_code") or "unknown"
        failure_breakdown[error_code] = failure_breakdown.get(error_code, 0) + 1

    stop_error_code = None
    for candidate in ("auth_expired", "rate_limited", "browser_unavailable"):
        if candidate in failure_breakdown:
            stop_error_code = candidate
            break

    return {
        "exit_code": 0 if not failures else 1,
        "attempted": len(results),
        "ui_verified": 0,
        "succeeded": len(successes),
        "failed": len(failures),
        "actionable_failed": len(failures),
        "failure_breakdown": failure_breakdown,
        "total_elapsed_seconds": 0.0,
        "average_seconds_per_job": 0.0,
        "stop_error_code": stop_error_code,
    }


def _process_selected_batch(job_ids, args):
    results = []
    for job_id in job_ids:
        results.append(_process_single_selected_job(job_id, args))
    return _summarize_selected_results(results)


def _run_queue_batch(args):
    if args.source == "linkedin":
        return process_linkedin_batch(
            limit=args.batch_size,
            storage_state_path=args.storage_state,
            headless=not args.headful,
            slow_mo=args.slow_mo,
            timeout_ms=args.timeout_ms,
            browser_channel=args.channel,
            ui_verify_blocked=args.ui_verify_blocked,
            return_summary=True,
        )
    if args.source == "indeed":
        return process_indeed_batch(
            limit=args.batch_size,
            timeout_ms=args.timeout_ms,
            browser_channel=args.channel,
            ui_verify_blocked=args.ui_verify_blocked,
            return_summary=True,
        )
    return process_multi_source_batch(
        limit=args.batch_size,
        storage_state_path=args.storage_state,
        headless=not args.headful,
        slow_mo=args.slow_mo,
        timeout_ms=args.timeout_ms,
        browser_channel=args.channel,
        ui_verify_blocked=args.ui_verify_blocked,
        return_summary=True,
    )


def main():
    parser = argparse.ArgumentParser(
        description="Run enrichment backfill in batches with an operator checkpoint after each batch."
    )
    parser.add_argument(
        "batch_size",
        type=int,
        nargs="?",
        default=25,
        help="Rows to process per batch (default 25; increase for explicit larger batches).",
    )
    parser.add_argument("--source", choices=["linkedin", "indeed", "all"], default="linkedin")
    parser.add_argument(
        "--job-id",
        type=int,
        action="append",
        dest="job_ids",
        help="Specific job id to include. Repeat for multiple rows.",
    )
    parser.add_argument(
        "--max-batches",
        type=int,
        default=0,
        help="Optional max number of batches; 0 means no limit.",
    )
    parser.add_argument("--storage-state", help="Override LinkedIn storage state path.")
    parser.add_argument("--channel", default=None, help="Playwright browser channel, e.g. chrome.")
    parser.add_argument("--timeout-ms", type=int, default=45000)
    parser.add_argument("--slow-mo", type=int, default=0)
    parser.add_argument(
        "--headful", action="store_true", help="Use a visible browser for the first pass too."
    )
    parser.add_argument(
        "--ui-verify-blocked",
        action="store_true",
        help="After each batch, rerun browser-fixable jobs in a visible browser.",
    )
    parser.add_argument(
        "--yes",
        action="store_true",
        help="Do not prompt between batches; continue automatically unless a hard-stop condition occurs.",
    )
    args = parser.parse_args()

    if args.batch_size < 1:
        parser.error("batch_size must be at least 1")
    if args.max_batches < 0:
        parser.error("--max-batches cannot be negative")

    selected_job_ids = list(dict.fromkeys(args.job_ids or []))
    batch_number = 0
    selected_index = 0

    while True:
        if args.max_batches and batch_number >= args.max_batches:
            print(f"[backfill] Reached max_batches={args.max_batches}; stopping.")
            return 0

        before = get_review_queue_summary(source=None if args.source == "all" else args.source)
        ready_before = before["ready_count"]
        batch_number += 1

        if selected_job_ids:
            if selected_index >= len(selected_job_ids):
                print("[backfill] Selected job list is drained.")
                return 0
            current_ids = selected_job_ids[selected_index : selected_index + args.batch_size]
            print(
                f"\n[backfill] Batch {batch_number} starting "
                f"(selected_ids={','.join(str(job_id) for job_id in current_ids)})."
            )
            summary = _process_selected_batch(current_ids, args)
            selected_index += len(current_ids)
            ready_after = get_review_queue_summary(
                source=None if args.source == "all" else args.source
            )["ready_count"]
            drained = max(0, ready_before - ready_after)
        else:
            if ready_before <= 0:
                print(f"[backfill] No ready {args.source} rows remain.")
                return 0
            print(
                f"\n[backfill] Batch {batch_number} starting "
                f"(source={args.source}, ready={ready_before}, pending={before['pending_count']}, blocked={before['blocked_count']})."
            )
            summary = _run_queue_batch(args)
            after = get_review_queue_summary(source=None if args.source == "all" else args.source)
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
            print(
                f"[backfill] Stopping because a hard-stop error occurred: {summary['stop_error_code']}"
            )
            return 1

        if summary["attempted"] == 0:
            print("[backfill] Batch made no claims; stopping.")
            return 0

        if selected_job_ids:
            if selected_index >= len(selected_job_ids):
                print("[backfill] Selected job list is drained.")
                return 0
        elif ready_after <= 0:
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
