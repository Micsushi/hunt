#!/usr/bin/env python3
import argparse
import os
import sys


REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SCRAPER_DIR = os.path.join(REPO_ROOT, "scraper")
sys.path.insert(0, SCRAPER_DIR)

from db import init_db, requeue_enrichment_rows  # noqa: E402


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
    return parser.parse_args()


def main():
    args = parse_args()
    init_db()
    updated = requeue_enrichment_rows(source=args.source, statuses=args.statuses)
    chosen_statuses = args.statuses or ["failed", "blocked", "blocked_verified"]
    print(
        f"Requeued {updated} row(s) to pending for source={args.source} "
        f"statuses={','.join(chosen_statuses)}"
    )


if __name__ == "__main__":
    main()
