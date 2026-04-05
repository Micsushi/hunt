import argparse
import sqlite3
import sys
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_DB_PATH = REPO_ROOT / "hunt.db"
SCRAPER_DIR = REPO_ROOT / "scraper"
sys.path.insert(0, str(SCRAPER_DIR))

from config import ENRICHMENT_MAX_ATTEMPTS  # noqa: E402


def main():
    parser = argparse.ArgumentParser(description="List LinkedIn jobs in the enrichment queue.")
    parser.add_argument(
        "--status",
        default="pending",
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
        help="Enrichment status to filter by (default: pending).",
    )
    parser.add_argument("--limit", type=int, default=10, help="Max rows to print (default: 10).")
    parser.add_argument(
        "--db",
        default=str(DEFAULT_DB_PATH),
        help=f"Path to SQLite DB (default: {DEFAULT_DB_PATH})",
    )
    args = parser.parse_args()

    conn = sqlite3.connect(args.db)
    conn.row_factory = sqlite3.Row
    try:
        if args.status == "all":
            rows = conn.execute(
                """
                SELECT id, company, title, apply_type, enrichment_status, enrichment_attempts,
                       date_scraped, last_enrichment_error, last_enrichment_started_at,
                       next_enrichment_retry_at
                FROM jobs
                WHERE source = 'linkedin'
                ORDER BY date_scraped DESC, id DESC
                LIMIT ?
                """,
                (args.limit,),
            ).fetchall()
        elif args.status == "ready":
            rows = conn.execute(
                """
                SELECT id, company, title, apply_type, enrichment_status, enrichment_attempts,
                       date_scraped, last_enrichment_error, last_enrichment_started_at,
                       next_enrichment_retry_at
                FROM jobs
                WHERE source = 'linkedin'
                  AND (
                        enrichment_status = 'pending'
                     OR (
                        enrichment_status = 'failed'
                    AND next_enrichment_retry_at IS NOT NULL
                        AND next_enrichment_retry_at <= CURRENT_TIMESTAMP
                        AND coalesce(enrichment_attempts, 0) < ?
                     )
                  )
                ORDER BY CASE enrichment_status WHEN 'pending' THEN 0 ELSE 1 END,
                         coalesce(next_enrichment_retry_at, date_scraped) ASC,
                         date_scraped DESC,
                         id DESC
                LIMIT ?
                """,
                (ENRICHMENT_MAX_ATTEMPTS, args.limit),
            ).fetchall()
        else:
            rows = conn.execute(
                """
                SELECT id, company, title, apply_type, enrichment_status, enrichment_attempts,
                       date_scraped, last_enrichment_error, last_enrichment_started_at,
                       next_enrichment_retry_at
                FROM jobs
                WHERE source = 'linkedin'
                  AND enrichment_status = ?
                ORDER BY date_scraped DESC, id DESC
                LIMIT ?
                """,
                (args.status, args.limit),
            ).fetchall()
    finally:
        conn.close()

    if not rows:
        print(f"No LinkedIn rows found with enrichment_status={args.status!r}.")
        return 0

    for row in rows:
        message = (
            f"id={row['id']} | company={row['company']} | title={row['title']} | "
            f"apply_type={row['apply_type']} | status={row['enrichment_status']} | "
            f"attempts={row['enrichment_attempts']} | scraped={row['date_scraped']}"
        )
        if row["last_enrichment_error"]:
            message += f" | error={row['last_enrichment_error']}"
        if row["last_enrichment_started_at"]:
            message += f" | started_at={row['last_enrichment_started_at']}"
        if row["next_enrichment_retry_at"]:
            message += f" | next_retry_at={row['next_enrichment_retry_at']}"
        print(message)
    return 0


if __name__ == "__main__":
    sys.exit(main())
