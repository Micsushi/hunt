import argparse
import sys
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parent.parent
SCRAPER_DIR = REPO_ROOT / "scraper"
sys.path.insert(0, str(SCRAPER_DIR))

from db import count_jobs_for_review, list_jobs_for_review  # noqa: E402


def main():
    parser = argparse.ArgumentParser(description="List jobs from the review queue with source/status filters.")
    parser.add_argument(
        "--source",
        choices=["all", "linkedin", "indeed"],
        default="all",
        help="Job source filter (default: all).",
    )
    parser.add_argument(
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
        help="Enrichment status filter (default: ready).",
    )
    parser.add_argument("--limit", type=int, default=10, help="Max rows to print (default: 10).")
    parser.add_argument("--offset", type=int, default=0, help="Starting offset (default: 0).")
    parser.add_argument("--query", default="", help="Optional keyword search across company/title/description/URLs.")
    parser.add_argument(
        "--sort",
        default="date_scraped",
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
    )
    parser.add_argument("--direction", choices=["asc", "desc"], default="desc")
    args = parser.parse_args()

    source = None if args.source == "all" else args.source
    total = count_jobs_for_review(status=args.status, query=args.query, source=source)
    rows = list_jobs_for_review(
        status=args.status,
        limit=args.limit,
        offset=max(0, args.offset),
        query=args.query,
        sort=args.sort,
        direction=args.direction,
        source=source,
    )

    print(
        f"jobs total={total} shown={len(rows)} "
        f"source={args.source} status={args.status} offset={max(0, args.offset)}"
    )
    if not rows:
        print("No jobs matched.")
        return 0

    for row in rows:
        message = (
            f"id={row['id']} | source={row['source']} | company={row['company']} | "
            f"title={row['title']} | apply_type={row['apply_type']} | "
            f"status={row['enrichment_status']} | attempts={row['enrichment_attempts']}"
        )
        if row.get("apply_url"):
            message += f" | apply_url={row['apply_url']}"
        if row.get("last_enrichment_error"):
            message += f" | error={row['last_enrichment_error']}"
        if row.get("next_enrichment_retry_at"):
            message += f" | next_retry_at={row['next_enrichment_retry_at']}"
        print(message)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
