#!/usr/bin/env python3
import argparse
import os
import sys

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, REPO_ROOT)

from hunter.db import (  # noqa: E402
    init_db,
    requeue_enrichment_rows,
    requeue_enrichment_rows_by_error_codes,
)


def parse_args():
    parser = argparse.ArgumentParser(
        description="Requeue enrichment rows back to pending for supported sources."
    )
    parser.add_argument(
        "--source",
        choices=["linkedin", "indeed", "all"],
        default="all",
        help="Limit requeue to one source or use all supported sources.",
    )
    parser.add_argument(
        "--status",
        action="append",
        choices=["failed", "blocked", "blocked_verified", "processing", "pending"],
        dest="statuses",
        help="One or more enrichment statuses to requeue. Defaults to failed + blocked + blocked_verified.",
    )
    parser.add_argument(
        "--error-code",
        action="append",
        dest="error_codes",
        choices=["auth_expired", "rate_limited"],
        help="Optional: requeue only failed rows whose last error code matches one of these values.",
    )
    return parser.parse_args()


def main():
    args = parse_args()
    init_db()
    if args.error_codes:
        updated = requeue_enrichment_rows_by_error_codes(
            source=args.source, error_codes=args.error_codes
        )
        print(
            f"Requeued {updated} row(s) to pending for source={args.source} "
            f"error_codes={','.join(args.error_codes)}"
        )
    else:
        updated = requeue_enrichment_rows(source=args.source, statuses=args.statuses)
        chosen_statuses = args.statuses or ["failed", "blocked", "blocked_verified"]
        print(
            f"Requeued {updated} row(s) to pending for source={args.source} "
            f"statuses={','.join(chosen_statuses)}"
        )


if __name__ == "__main__":
    main()
