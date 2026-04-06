import argparse
import json
import sys
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parent.parent
SCRAPER_DIR = REPO_ROOT / "scraper"
sys.path.insert(0, str(SCRAPER_DIR))

import db  # noqa: E402


def print_section(title):
    print(title)


def print_job_rows(rows):
    for row in rows:
        message = (
            f"id={row['id']} | company={row['company']} | title={row['title']} | "
            f"apply_type={row['apply_type']} | status={row['enrichment_status']} | "
            f"attempts={row['enrichment_attempts']}"
        )
        if row.get("next_enrichment_retry_at"):
            message += f" | next_retry_at={row['next_enrichment_retry_at']}"
        if row.get("last_enrichment_started_at"):
            message += f" | started_at={row['last_enrichment_started_at']}"
        if row.get("last_enrichment_error"):
            message += f" | error={row['last_enrichment_error']}"
        if row.get("last_artifact_dir"):
            message += f" | artifact_dir={row['last_artifact_dir']}"
        print(message)


def main():
    parser = argparse.ArgumentParser(description="Show enrichment queue health across supported sources.")
    parser.add_argument(
        "--limit",
        type=int,
        default=5,
        help="How many rows to show in each detailed section (default: 5).",
    )
    parser.add_argument(
        "--json",
        action="store_true",
        help="Emit queue health as JSON instead of human-readable text.",
    )
    args = parser.parse_args()

    db.init_db(maintenance=False)
    summary = db.get_review_queue_summary()
    detail_sections = {}
    sections = (
        ("ready", "ready jobs"),
        ("processing", "processing jobs"),
        ("blocked", "blocked jobs"),
        ("failed", "failed jobs"),
    )
    for status, _title in sections:
        rows = db.list_jobs_for_review(status=status, limit=args.limit)
        if rows:
            detail_sections[status] = rows

    if args.json:
        print(
            json.dumps(
                {
                    "summary": summary,
                    "sections": detail_sections,
                },
                indent=2,
            )
        )
        return 0

    print_section("Enrichment queue summary")
    print(f"total: {summary['total']}")
    print(f"ready: {summary['ready_count']}")
    print(f"pending: {summary['pending_count']}")
    print(f"retry_ready: {summary['retry_ready_count']}")
    print(f"processing: {summary['processing_count']}")
    print(f"blocked: {summary['blocked_count']}")
    print(f"stale_processing: {summary['stale_processing_count']}")
    print(f"oldest_processing_started_at: {summary['oldest_processing_started_at']}")

    print_section("\nsource_counts:")
    for source, count in sorted(summary["source_counts"].items()):
        print(f"  {source}: {count}")

    print_section("\ncounts_by_status:")
    for status, count in sorted(summary["counts_by_status"].items()):
        print(f"  {status}: {count}")

    if summary["failure_counts"]:
        print_section("\nfailure_counts:")
        for error_code, count in summary["failure_counts"].items():
            print(f"  {error_code}: {count}")

    for status, title in sections:
        rows = detail_sections.get(status, [])
        if not rows:
            continue
        print_section(f"\n{title}:")
        print_job_rows(rows)

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
